// Search across every conversation: titles and the words of each message, not
// only titles. Case and accents don't matter ("resume" finds "Résumé"); every
// word of the query must appear somewhere in the conversation. Results carry a
// snippet around the best match, with the matched words marked, and the
// message's timestamp so the chat can open on it.
import type { ChatEntry } from './agent/dialects';
import type { ConversationMeta } from './db';

export interface SnippetPart {
  text: string;
  hit: boolean;
}

export interface SearchHit {
  meta: ConversationMeta;
  /** Around the best matching message (empty when only the title matched). */
  snippet: SnippetPart[];
  /** That message's timestamp, to scroll to it. */
  ts?: number;
}

/** Text folded for comparison, with each folded character's index in the original. */
function fold(text: string): { s: string; at: number[] } {
  let s = '';
  const at: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const f = text[i].normalize('NFD').replace(/\p{Mn}/gu, '').toLowerCase();
    for (let k = 0; k < f.length; k++) at.push(i);
    s += f;
  }
  return { s, at };
}

/** The query's words, folded; duplicates dropped. */
export function queryWords(query: string): string[] {
  return [...new Set(fold(query).s.split(/\s+/).filter(Boolean))];
}

/** What's searched in a conversation: what the user and the assistant wrote. */
function searchable(e: ChatEntry): string | null {
  return (e.role === 'user' || e.role === 'assistant') && e.text ? e.text : null;
}

const SNIPPET = 150;

/** About `SNIPPET` characters of `text` around the first match, cut at spaces, matches marked. */
export function snippet(text: string, words: string[]): SnippetPart[] {
  const clean = text.replace(/\s+/g, ' ').trim();
  const { s, at } = fold(clean);
  const spans: [number, number][] = [];
  for (const w of words) {
    for (let i = s.indexOf(w); i >= 0; i = s.indexOf(w, i + w.length)) spans.push([at[i], at[i + w.length - 1] + 1]);
  }
  spans.sort((a, b) => a[0] - b[0]);
  const first = spans[0]?.[0] ?? 0;
  let start = Math.max(0, first - 50);
  if (start > 0) start = clean.indexOf(' ', start) + 1 || start;
  let end = Math.min(clean.length, start + SNIPPET);
  if (end < clean.length) end = clean.lastIndexOf(' ', end) > first ? clean.lastIndexOf(' ', end) : end;
  const parts: SnippetPart[] = [];
  const push = (t: string, hit: boolean) => t && parts.push({ text: t, hit });
  if (start > 0) push('…', false);
  let pos = start;
  for (const [a, b] of spans) {
    if (b <= pos || a >= end) continue;
    push(clean.slice(pos, Math.max(pos, a)), false);
    push(clean.slice(Math.max(pos, a), Math.min(b, end)), true);
    pos = Math.min(b, end);
  }
  push(clean.slice(pos, end), false);
  if (end < clean.length) push('…', false);
  return parts;
}

/**
 * The conversations matching `query`, best first: those with one message holding every word,
 * then the others; recent first within each. `chats` gives each conversation's messages.
 */
export function searchConversations(query: string, metas: ConversationMeta[], chats: Map<string, ChatEntry[]>, limit = 50): SearchHit[] {
  const words = queryWords(query);
  if (!words.length) return [];
  const scored: { hit: SearchHit; whole: boolean }[] = [];
  for (const meta of metas) {
    const entries = chats.get(meta.id) ?? [];
    const title = fold(meta.title).s;
    const texts = entries.map((e) => {
      const text = searchable(e);
      return text ? { e, text, s: fold(text).s } : null;
    }).filter((x) => !!x);
    if (!words.every((w) => title.includes(w) || texts.some((x) => x.s.includes(w)))) continue;
    // The message holding the most words (all of them, ideally), the earliest on a tie.
    let best: (typeof texts)[number] | undefined;
    let bestCount = 0;
    for (const x of texts) {
      const n = words.filter((w) => x.s.includes(w)).length;
      if (n > bestCount) [best, bestCount] = [x, n];
    }
    scored.push({
      hit: { meta, snippet: best ? snippet(best.text, words) : [], ts: best?.e.ts },
      whole: bestCount === words.length || words.every((w) => title.includes(w)),
    });
  }
  scored.sort((a, b) => Number(b.whole) - Number(a.whole) || b.hit.meta.updatedAt - a.hit.meta.updatedAt);
  return scored.slice(0, limit).map((x) => x.hit);
}
