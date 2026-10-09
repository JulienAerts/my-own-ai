// Chat with llama.cpp's llama-server (desktop app, see src-tauri/src/llama.rs).
// It speaks the OpenAI chat API, like WebLLM, so the agent loop is unchanged:
// this module turns a generate() call into a streamed /v1/chat/completions
// request and maps WebLLM's response_format to llama.cpp's.
import type { ChatCompletionMessageParam, ResponseFormat } from '@mlc-ai/web-llm';
import type { GenerateOptions, GenerateResult } from '../worker/engine.worker';

export interface LlamaServer {
  port: number;
  key: string;
}

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

interface Schema {
  type?: string;
  properties?: Record<string, Schema>;
  items?: Schema;
  enum?: unknown[];
  anyOf?: Schema[];
}

const lit = (s: string) => JSON.stringify(s); // a GBNF literal: same escapes as JSON

/**
 * A JSON schema as a GBNF grammar, for the shapes the app uses: objects (every listed property,
 * in order), arrays, strings, booleans, integers, enums and anyOf. llama.cpp can convert schemas
 * itself, but b11480 puts the chat template's opening (with special tokens) into the grammar
 * for some models (Qwen3.5), which then fails to load; a plain grammar works with every model.
 */
export function schemaGrammar(schema: Schema): string {
  const rules = new Map<string, string>([
    ['space', '| " " | "\\n" [ \\t]{0,20}'],
    ['string', '"\\"" char* "\\""'],
    ['char', '[^"\\\\\\x7F\\x00-\\x1F] | "\\\\" (["\\\\/bfnrt] | "u" [0-9a-fA-F]{4})'],
    ['boolean', '"true" | "false"'],
    ['integer', '"-"? ([0-9] | [1-9] [0-9]{1,15})'],
  ]);
  let n = 0;
  const rule = (s: Schema): string => {
    if (s.enum) return `(${s.enum.map((v) => lit(JSON.stringify(v))).join(' | ')})`;
    if (s.anyOf) return `(${s.anyOf.map(rule).join(' | ')})`;
    if (s.type === 'string' || s.type === 'boolean' || s.type === 'integer') return s.type;
    const name = `v${n++}`;
    if (s.type === 'array') {
      const item = rule(s.items ?? { type: 'string' });
      rules.set(name, `"[" space (${item} (space "," space ${item})*)? space "]"`);
    } else {
      const props = Object.entries(s.properties ?? {}).map(([k, v]) => `${lit(JSON.stringify(k))} space ":" space ${rule(v)}`);
      rules.set(name, `"{" space ${props.join(' space "," space ')} space "}"`);
    }
    return name;
  };
  const root = rule(schema);
  return [`root ::= space ${root} space`, ...[...rules].map(([k, v]) => `${k} ::= ${v}`)].join('\n');
}

/** WebLLM's constraint → llama.cpp's: a grammar (same EBNF dialect, GBNF), or plain JSON. */
export function constraint(rf: ResponseFormat | undefined): Record<string, unknown> {
  if (!rf) return {};
  if (rf.type === 'grammar' && rf.grammar) return { grammar: rf.grammar };
  if (rf.type === 'json_object') {
    return rf.schema ? { grammar: schemaGrammar(JSON.parse(rf.schema) as Schema) } : { response_format: { type: 'json_object' } };
  }
  return {};
}

/** Image parts are kept only for vision models (llama-server rejects them otherwise). */
export function llamaBody(messages: ChatCompletionMessageParam[], opts: GenerateOptions): Record<string, unknown> {
  return {
    messages,
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: opts.maxTokens,
    temperature: opts.temperature,
    ...(opts.topP !== undefined && { top_p: opts.topP }),
    // Qwen3's template: thinking off adds an empty <think></think> to the prompt.
    ...(opts.thinking !== undefined && { chat_template_kwargs: { enable_thinking: opts.thinking } }),
    ...constraint(opts.responseFormat),
  };
}

/** Stream one completion. `signal` stops it (the Stop button). */
export async function llamaGenerate(
  fetchFn: Fetch,
  server: LlamaServer,
  messages: ChatCompletionMessageParam[],
  opts: GenerateOptions,
  onDelta: (text: string) => void,
  signal?: AbortSignal,
): Promise<GenerateResult> {
  let res: Response;
  try {
    res = await fetchFn(`http://127.0.0.1:${server.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${server.key}` },
      body: JSON.stringify(llamaBody(messages, opts)),
      signal,
    });
  } catch (e) {
    if (signal?.aborted) return { text: '', finishReason: 'abort' };
    throw new Error(`Couldn't reach llama-server (${e instanceof Error ? e.message : String(e)}).`);
  }
  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => '');
    let message = detail;
    try { message = JSON.parse(detail).error?.message ?? detail; } catch { /* plain text */ }
    throw new Error(`llama-server: ${message || `HTTP ${res.status}`}`);
  }

  let text = '';
  let finishReason = 'stop';
  let decodeTps: number | undefined;
  let promptTokens: number | undefined;
  let completionTokens: number | undefined;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // Server-sent events: "data: {json}" lines, then "data: [DONE]".
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        const chunk = JSON.parse(data) as {
          choices?: { delta?: { content?: string | null }; finish_reason?: string | null }[];
          usage?: { prompt_tokens?: number; completion_tokens?: number };
          timings?: { predicted_per_second?: number };
          error?: { message?: string };
        };
        if (chunk.error) throw new Error(`llama-server: ${chunk.error.message ?? 'error'}`);
        const choice = chunk.choices?.[0];
        const delta = choice?.delta?.content;
        if (delta) {
          text += delta;
          onDelta(delta);
        }
        if (choice?.finish_reason) finishReason = choice.finish_reason;
        if (chunk.usage) {
          promptTokens = chunk.usage.prompt_tokens;
          completionTokens = chunk.usage.completion_tokens;
        }
        if (chunk.timings?.predicted_per_second) decodeTps = chunk.timings.predicted_per_second;
      }
    }
  } catch (e) {
    if (signal?.aborted) return { text, finishReason: 'abort', decodeTps, promptTokens, completionTokens };
    throw e;
  }
  return { text, finishReason, decodeTps, promptTokens, completionTokens };
}
