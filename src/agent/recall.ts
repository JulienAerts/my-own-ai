// Long conversations: once messages are folded into the rolling summary, the
// model no longer sees them, and a summary keeps the gist, not every number or
// name. Recall brings back the earlier exchanges that relate to the new message,
// word for word, into the system prompt ("Earlier in this conversation…").
// Ranking: shared words, weighted by how rare they are in the conversation (an
// exact code or name counts a lot), plus meaning when the search model is
// installed. Recall is automatic: small models don't reliably ask for it.
import { embedIfInstalled } from '../docs/store';
import { terms } from '../memory/memory';
import type { ChatEntry } from './dialects';

export interface Passage {
  /** The user's message and the answer, with tool results in short. */
  text: string;
  /** The user message's timestamp: identifies the exchange. */
  ts: number;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** The exchanges before the latest summary (the ones the model no longer sees). */
export function earlierExchanges(entries: ChatEntry[]): Passage[] {
  let floor = -1;
  for (let i = entries.length - 1; i >= 0; i--) if (entries[i].role === 'summary') { floor = i; break; }
  if (floor < 0) return [];
  const out: Passage[] = [];
  let cur: { lines: string[]; ts: number } | null = null;
  for (const e of entries.slice(0, floor)) {
    if (e.role === 'user') {
      if (cur) out.push({ text: cur.lines.join('\n'), ts: cur.ts });
      cur = { lines: [`User: ${clip(e.text, 600)}`], ts: e.ts };
    } else if (cur && e.role === 'assistant' && !e.notice) cur.lines.push(`Assistant: ${clip(e.text, 600)}`);
    else if (cur && e.role === 'tool') cur.lines.push(`(${e.name} → ${clip(e.result.replace(/\s+/g, ' '), 240)})`);
  }
  if (cur) out.push({ text: cur.lines.join('\n'), ts: cur.ts });
  return out;
}

/** Characters recall may add to the prompt: little on phones, more with a big context. */
export function recallBudget(contextWindow: number): number {
  return contextWindow <= 2048 ? 600 : Math.min(2400, Math.round(contextWindow * 0.08 * 3.5));
}

/**
 * Keyword score of each passage for the query, 0..1: the query's words found in it, weighted
 * by rarity (IDF). Only words that occur somewhere earlier count in the total: a word nowhere
 * in the conversation ("station") says nothing about which exchange is meant.
 */
export function keywordScores(query: string, passages: Passage[]): number[] {
  const docs = passages.map((p) => new Set(terms(p.text)));
  const q = [...new Set(terms(query))].filter((t) => docs.some((d) => d.has(t)));
  if (!q.length || !passages.length) return passages.map(() => 0);
  const idf = (t: string) => Math.log(1 + passages.length / (1 + docs.filter((d) => d.has(t)).length));
  const total = q.reduce((n, t) => n + idf(t), 0);
  return docs.map((d) => q.reduce((n, t) => n + (d.has(t) ? idf(t) : 0), 0) / total);
}

// Vectors of earlier exchanges, by timestamp: computed once per exchange.
const vectors = new Map<number, Float32Array>();

/**
 * The earlier exchanges that relate to `query` (the user's new message), best first,
 * within the budget. Empty when nothing has been summarized yet or nothing matches.
 */
export async function recallEarlier(entries: ChatEntry[], query: string, contextWindow: number): Promise<string[]> {
  const passages = earlierExchanges(entries);
  if (!passages.length || !query.trim()) return [];
  const kw = keywordScores(query, passages);

  let sem: number[] = passages.map(() => 0);
  const missing = passages.filter((p) => !vectors.has(p.ts));
  const fresh = await embedIfInstalled([query, ...missing.map((p) => p.text)]);
  if (fresh) {
    missing.forEach((p, i) => vectors.set(p.ts, fresh[i + 1]));
    const qv = fresh[0];
    sem = passages.map((p) => {
      const v = vectors.get(p.ts);
      if (!v) return 0;
      let dot = 0;
      for (let i = 0; i < v.length; i++) dot += v[i] * qv[i];
      return dot;
    });
  }

  // A passage qualifies by its words (a third of the query's weight) or its meaning.
  const ranked = passages
    .map((p, i) => ({ p, score: Math.max(kw[i], (sem[i] - 0.3) / 0.5) }))
    .filter((_, i) => kw[i] >= 0.34 || sem[i] >= 0.5)
    .sort((a, b) => b.score - a.score);

  const budget = recallBudget(contextWindow);
  const out: string[] = [];
  let used = 0;
  for (const r of ranked.slice(0, contextWindow <= 2048 ? 2 : 4)) {
    const text = used + r.p.text.length > budget ? clip(r.p.text, Math.max(0, budget - used)) : r.p.text;
    if (text.length < 40) break;
    out.push(text);
    used += text.length;
  }
  return out;
}
