import type { ChatCompletionMessageParam } from '@mlc-ai/web-llm';
import type { Remote } from 'comlink';
import type { EngineApi } from '../worker/engine.worker';
import { Comlink } from '../worker/client';
import { DOC_TOOL, runTool, type ToolContext } from './tools';
import { memoriesFor } from '../memory/memory';
import { enabledTools } from './toolPrefs';
import { isSamplerGlitch } from '../worker/errors';
import { activeImageIndex, splitThinking, type ChatEntry, type Dialect, type PromptContext, type Thought, withoutSpeakerLabel } from './dialects';
import { getSetting } from '../db';
import { recallEarlier } from './recall';

export interface AgentCallbacks {
  /**
   * Streaming reply text; null while a tool call is being written, undefined while undecided.
   * `thought`: what a reasoning model has thought so far in this step.
   */
  onPartial(text: string | null | undefined, step: number, thought?: { text: string; done: boolean; secs?: number }): void;
  /** A tool is running (web tools can take a few seconds). */
  onToolStart?(name: string, step: number): void;
  /** A finished entry (tool call+result, or final reply) to append to the transcript. */
  onEntry(entry: ChatEntry): void;
  /** Tokens the last model call used (prompt + answer): how full the context window is. */
  onUsage?(tokens: number): void;
}

export interface AgentOptions {
  dialect: Dialect;
  /** Passed to tools (attached documents, result budget). */
  toolContext?: ToolContext;
  maxSteps: number;
  contextWindow: number;
  maxTokens?: number;
  /** Sampling temperature (default 0.3; Qwen3 recommends 0.6 when thinking). */
  temperature?: number;
  /** Nucleus sampling; unset = the model's default. */
  topP?: number;
  /** Reasoning models only: think before answering (see GenerateOptions.thinking). */
  thinking?: boolean;
  /** The assistant answering (see PromptContext.role). */
  role?: PromptContext['role'];
  /** Skills listed in the prompt this turn. */
  skills?: PromptContext['skills'];
  /** Names of the tools offered this turn (an assistant's own, MCP connectors); default: the enabled ones. */
  allowedTools?: string[];
  /** Set by the UI's Stop button; checked between steps. */
  signal: { stopped: boolean };
}

// Attempts per step when WebLLM's sampler glitches (see isSamplerGlitch).
const SAMPLE_ATTEMPTS = 3;

const IMAGE_TOKENS = 2000; // see MAX_IMAGE_TOKENS in ui/image.ts

// ~3.5 chars/token for English; deliberately conservative.
const CHARS_PER_TOKEN = 3.5;

/**
 * Memories for the prompt: pinned ones plus those related to the latest two
 * user messages; fewer on phones (2048-token context).
 */
export function promptMemories(entries: ChatEntry[], contextWindow: number, assistantId?: string): Promise<string[]> {
  const asked = entries.flatMap((e) => (e.role === 'user' ? [e.text] : [])).slice(-2).join('\n');
  return memoriesFor(asked, { assistantId, limit: contextWindow <= 2048 ? 6 : 12 }).catch(() => []);
}

/** The latest rolling summary and where it sits, or index -1. */
export function latestSummary(entries: ChatEntry[]): { index: number; text?: string } {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.role === 'summary') return { index: i, text: e.text };
  }
  return { index: -1 };
}

/**
 * Index of the first entry that fits in the prompt after `system`, newest
 * first, never splitting a turn. Entries before the latest summary are never
 * included (the summary stands for them). `scale` < 1 plans a smaller window,
 * used to summarize in batches.
 */
export function windowStart(entries: ChatEntry[], systemChars: number, contextWindow: number, maxTokens: number, scale = 1): number {
  const budget = ((contextWindow - maxTokens) * CHARS_PER_TOKEN - systemChars) * scale;
  const floor = latestSummary(entries).index + 1;
  // Never split a turn: start the window at a user message.
  let start = entries.length;
  let used = 0;
  const image = activeImageIndex(entries);
  for (let i = entries.length - 1; i >= floor; i--) {
    const e = entries[i];
    if (e.role === 'summary' || e.role === 'memory') continue;
    used += e.role === 'tool' ? e.result.length + JSON.stringify(e.args).length + 80 : e.role === 'doc' ? e.name.length + 80 : e.text.length + 20;
    // A vision image costs ~1,400-2,000 tokens.
    if (i === image) used += ((e.role === 'user' && e.imageTokens) || IMAGE_TOKENS) * CHARS_PER_TOKEN;
    if (used > budget && start < entries.length) break;
    if (e.role === 'user') start = i;
  }
  // Keep attachment cards that sit right before the first question in the window.
  while (start > floor && entries[start - 1].role === 'doc') start--;
  return start;
}

/** System prompt (with the rolling summary) + as many recent turns as fit, oldest dropped first. */
export function buildPrompt(dialect: Dialect, entries: ChatEntry[], contextWindow: number, maxTokens: number, ctx?: PromptContext): ChatCompletionMessageParam[] {
  const system = dialect.systemPrompt({ ...ctx, summary: latestSummary(entries).text });
  const start = windowStart(entries, system.length, contextWindow, maxTokens);
  return [{ role: 'system', content: system }, ...dialect.encode(entries.slice(start))];
}

/**
 * One user turn: loop model → (tool → model)* → reply, at most `maxSteps`
 * model calls. The last allowed step is constrained to reply-only, so the
 * loop always ends with an answer.
 */
export async function runAgent(
  engine: Remote<EngineApi>,
  history: ChatEntry[],
  opts: AgentOptions,
  cb: AgentCallbacks,
): Promise<void> {
  const { dialect, maxSteps, contextWindow, signal } = opts;
  const maxTokens = opts.maxTokens ?? 512;
  const transcript = [...history];

  // Small models sometimes re-issue the call they just made instead of answering.
  let forceReply = false;
  // Earlier exchanges (folded into the summary) that relate to the new message.
  const asked = [...transcript].reverse().find((e) => e.role === 'user');
  const recalled = asked?.role === 'user' ? await recallEarlier(transcript, asked.text, contextWindow).catch(() => []) : [];

  for (let step = 1; step <= maxSteps; step++) {
    const replyOnly = step === maxSteps || forceReply;
    const [notes, instructions] = await Promise.all([
      promptMemories(transcript, contextWindow, opts.toolContext?.assistantId),
      getSetting('instructions').catch(() => undefined),
    ]);
    const messages = buildPrompt(dialect, transcript, contextWindow, maxTokens, { notes, instructions, role: opts.role, skills: opts.skills, recalled });
    let output = '';
    let res: Awaited<ReturnType<typeof engine.generate>> | undefined;
    // How long the model thought (from the request to "</think>").
    let thinkSecs: number | undefined;
    for (let attempt = 1; !res; attempt++) {
      output = '';
      thinkSecs = undefined;
      const t0 = performance.now();
      // Deltas arrive on their own Comlink port and can trail the result.
      let settled = false;
      cb.onPartial(dialect.partialReply(''), step);
      try {
        res = await engine.generate(
          messages,
          { responseFormat: dialect.responseFormat(replyOnly), maxTokens, temperature: opts.temperature ?? 0.3, topP: opts.topP, thinking: opts.thinking },
          Comlink.proxy((delta: string) => {
            if (settled) return;
            output += delta;
            const t = splitThinking(output, opts.thinking === true);
            if (t.done && t.thinking && thinkSecs === undefined) thinkSecs = (performance.now() - t0) / 1000;
            const thought = t.thinking !== undefined && (t.thinking || !t.done) ? { text: t.thinking, done: t.done, secs: thinkSecs } : undefined;
            cb.onPartial(t.done ? dialect.partialReply(t.rest) : undefined, step, thought);
          }),
        ).finally(() => { settled = true; });
      } catch (e) {
        // Draw again with the same prompt; the glitch isn't the model's fault.
        if (!isSamplerGlitch(e) || attempt >= SAMPLE_ATTEMPTS || signal.stopped) throw e;
      }
    }
    if (res.promptTokens !== undefined) cb.onUsage?.(res.promptTokens + (res.completionTokens ?? 0));
    const split = splitThinking(res.text, opts.thinking === true);
    output = split.rest;
    const thought: Thought = split.thinking ? { thinking: split.thinking, ...(thinkSecs !== undefined && { thinkSecs: Math.round(thinkSecs) }) } : {};

    // Stopped or truncated output may not be valid under the grammar.
    if (res.finishReason !== 'stop') {
      const partial = (split.done && dialect.partialReply(output)) || '';
      const entry: ChatEntry = {
        role: 'assistant',
        text: partial || (res.finishReason === 'abort' ? '(stopped)' : split.done ? '(ran out of tokens)' : '(ran out of tokens while thinking: turn thinking off for a quicker answer)'),
        ts: Date.now(),
        tps: res.decodeTps,
        interrupted: true,
        ...thought,
      };
      cb.onEntry(entry);
      return;
    }

    const action = dialect.parse(output);
    if (action.kind === 'reply') {
      cb.onEntry({ role: 'assistant', text: withoutSpeakerLabel(action.text, opts.role?.name), ts: Date.now(), tps: res.decodeTps, ...thought });
      return;
    }

    const key = JSON.stringify([action.name, action.args]);
    const repeat = transcript.slice(history.length).some(
      (e) => e.role === 'tool' && JSON.stringify([e.name, e.args]) === key,
    );
    if (repeat) {
      // Don't re-run or re-log it; the result is already in context. Make the next step answer.
      forceReply = true;
      continue;
    }

    cb.onToolStart?.(action.name, step);
    // The grammar only allows enabled tools; this guards a switch flipped mid-answer.
    // The grammar only allows the turn's tools; this guards a switch flipped mid-answer.
    const allowed = action.name === DOC_TOOL.name
      ? !!opts.toolContext?.docIds.length
      : opts.allowedTools
        ? opts.allowedTools.includes(action.name)
        : (await enabledTools()).some((t) => t.name === action.name);
    const { result, error, images } = allowed
      ? await runTool(action.name, action.args, opts.toolContext)
      : { result: `The ${action.name} tool is turned off by the user.`, error: true };
    const entry: ChatEntry = { role: 'tool', name: action.name, args: action.args, result, error, ...(images && { images }), ts: Date.now(), ...thought };
    transcript.push(entry);
    cb.onEntry(entry);

    if (signal.stopped) return;
  }
}

