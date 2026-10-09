// Rolling summary: when older messages no longer fit in the model's context
// window, the model folds them into a short summary that stays in its system
// prompt, so long conversations keep their thread. Summaries are made in
// batches (down to ~60% of the room) so they aren't rewritten every message.
import type { Remote } from 'comlink';
import type { EngineApi } from '../worker/engine.worker';
import { Comlink } from '../worker/client';
import { splitThinking, type ChatEntry, type Dialect, type PromptContext } from './dialects';
import { latestSummary, windowStart } from './loop';
import { recallBudget } from './recall';

const CHARS_PER_TOKEN = 3.5;
/** Keep this share of the history room after summarizing. */
const KEEP = 0.6;

// The summary is rewritten from itself each time: without care, details fade a little at
// every round. So it carries every exact detail forward, in a line of its own.
const SUMMARIZER =
  'You keep a running summary of a conversation between a user and an AI assistant. ' +
  'Merge the current summary and the newer messages into one updated summary. ' +
  'Keep the user\'s goals and preferences, decisions, what was done, and open questions. ' +
  'Keep every exact detail from both (names, numbers, dates, prices, addresses, codes, file names), unless the messages corrected it. ' +
  'Write plain, compact sentences in the third person ("The user…"), no preamble, no headings, ' +
  'then a last line starting with "Details:" that lists the exact details, separated by semicolons.';

function line(e: ChatEntry): string | null {
  const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
  switch (e.role) {
    case 'user': return `User: ${e.image ? '[shared an image] ' : ''}${clip(e.text, 500)}`;
    case 'assistant': return e.notice ? null : `Assistant: ${clip(e.text, 500)}`;
    case 'tool': return `(${e.name} → ${clip(e.result.replace(/\s+/g, ' '), 200)})`;
    case 'doc': return `(User attached the document "${e.name}")`;
    default: return null;
  }
}

/** Longest summary we keep, in characters: smaller on 2048-token phones. */
export function summaryLimit(contextWindow: number): number {
  if (contextWindow <= 2048) return 600;
  if (contextWindow <= 4096) return 1200;
  return contextWindow <= 8192 ? 1800 : 2400;
}

/**
 * If messages have fallen out of the context window since the last summary,
 * fold them into a new one. Returns the updated conversation (old summaries
 * replaced by the new one, placed where it takes over), or null if nothing
 * needed summarizing.
 */
export async function updateSummary(
  engine: Remote<EngineApi>,
  entries: ChatEntry[],
  /** `reasoning`: a model that thinks (Qwen3); thinking is turned off for summaries. */
  opts: { dialect: Dialect; contextWindow: number; maxTokens: number; ctx?: PromptContext; reasoning?: boolean },
): Promise<ChatEntry[] | null> {
  const limit = summaryLimit(opts.contextWindow);
  // Plan with a full-size summary in the system prompt, so the window doesn't shrink after.
  // …and with room for what recall may bring back (agent/recall.ts).
  const system = opts.dialect.systemPrompt({ ...opts.ctx, summary: 'x'.repeat(limit), recalled: ['x'.repeat(recallBudget(opts.contextWindow))] }).length;
  const prev = latestSummary(entries);
  const floor = prev.index + 1;
  if (windowStart(entries, system, opts.contextWindow, opts.maxTokens) <= floor) return null;

  // Summarize down to a smaller window, so the next few messages fit without another summary.
  const cut = windowStart(entries, system, opts.contextWindow, opts.maxTokens, KEEP);
  const lines = entries.slice(floor, cut).map(line).filter((l): l is string => !!l);
  if (!lines.length) return null;

  // The summarizer's own prompt must fit too: keep the newest lines if needed.
  const answerTokens = Math.ceil(limit / CHARS_PER_TOKEN) + 40;
  const room = (opts.contextWindow - answerTokens - 64) * CHARS_PER_TOKEN - SUMMARIZER.length - (prev.text?.length ?? 0) - 200;
  let body = lines.join('\n');
  if (body.length > room) body = `…\n${body.slice(body.length - Math.max(0, room))}`;

  const words = Math.round(limit / 6);
  const res = await engine.generate(
    [
      { role: 'system', content: SUMMARIZER },
      {
        role: 'user',
        content: `Current summary:\n${prev.text ?? '(none yet)'}\n\nNewer messages to fold in:\n${body}\n\n` +
          `Write the updated summary, at most ${words} words.`,
      },
    ],
    { maxTokens: answerTokens, temperature: 0.2, ...(opts.reasoning && { thinking: false }) },
    Comlink.proxy(() => {}),
  );
  let text = splitThinking(res.text).rest.trim();
  if (!text) return null; // keep the old window rather than lose context silently
  if (text.length > limit) text = `${text.slice(0, text.lastIndexOf(' ', limit) > 0 ? text.lastIndexOf(' ', limit) : limit)}…`;

  // Replace older summaries; place the new one where the kept window starts.
  const before = entries.slice(0, cut).filter((e) => e.role !== 'summary');
  return [...before, { role: 'summary', text, ts: Date.now() }, ...entries.slice(cut)];
}
