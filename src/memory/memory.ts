// What the assistant remembers about the user. Memories are records (text,
// dates, source conversation, pinned, assistant) in IndexedDB. Pinned ones are
// always in the prompt; the others only when they relate to the message, so
// the list can grow without filling a phone's 2048-token context.
import { useEffect, useState } from 'preact/hooks';
import {
  allMemoryRecords, clearMemoryRecords, deleteMemoryRecord, deleteSetting, getSetting, newChatId, putMemoryRecord,
  type MemoryRecord,
} from '../db';
import { embedIfInstalled, embedderInstalled, installEmbedder } from '../docs/store';
import { locale } from '../i18n/i18n';

export type Memory = MemoryRecord;

const MAX_TEXT = 300;

// ---------------------------------------------------------------------------
// Store (with change notifications for the settings list and the chat chips)

let cache: Promise<Memory[]> | null = null;
const subs = new Set<() => void>();

function changed() {
  cache = null;
  subs.forEach((fn) => fn());
}

/** All memories, newest first. Migrates the pre-v5 `notes` setting once. */
export function listMemories(): Promise<Memory[]> {
  cache ??= (async () => {
    const legacy = await getSetting('notes').catch(() => undefined);
    if (legacy?.length) {
      const now = Date.now();
      for (const [i, text] of legacy.entries()) {
        await putMemoryRecord({ id: newChatId(), text, createdAt: now - (legacy.length - i), updatedAt: now - (legacy.length - i) });
      }
      await deleteSetting('notes');
    }
    // Temporary facts (a trip, an exam) are forgotten once their time is over.
    const now = Date.now();
    const all = await allMemoryRecords();
    for (const m of all) if (m.until && m.until < now) await deleteMemoryRecord(m.id);
    return all.filter((m) => !m.until || m.until >= now).sort((a, b) => b.updatedAt - a.updatedAt);
  })();
  return cache;
}

// ---------------------------------------------------------------------------
// Matching by meaning: the search model (MiniLM) is fetched once there are memories
// to match, and memories saved before get their vectors then.

let ensuring: Promise<void> | null = null;
export function ensureMemorySearch(): Promise<void> {
  ensuring ??= (async () => {
    if (!(await embedderInstalled()) && !(navigator.onLine && (await installEmbedder()))) return;
    const missing = (await listMemories()).filter((m) => !m.vector);
    if (!missing.length) return;
    const vectors = await embedIfInstalled(missing.map((m) => m.text));
    if (!vectors) return;
    for (const [i, m] of missing.entries()) await putMemoryRecord({ ...m, vector: vectors[i] });
    changed();
  })().finally(() => { ensuring = null; });
  return ensuring;
}

export function useMemories(): Memory[] | null {
  const [list, setList] = useState<Memory[] | null>(null);
  useEffect(() => {
    const load = () => listMemories().then(setList, () => setList([]));
    subs.add(load);
    load();
    return () => void subs.delete(load);
  }, []);
  return list;
}

// ---------------------------------------------------------------------------
// Matching

const STOP = new Set(('a an and are as at be but by for from has have i in is it its of on or that the this to was were will with you your user ' +
  'he she they them their his her my me we our not no do does did can could should would about into than then there these those ' +
  'le la les un une des du de et est en que qui dans pour par sur au aux ce il elle je tu nous vous ne pas plus ou se sa son ses ' +
  // Question words carry no topic ("when does Clara arrive?" is about Clara).
  'what when where which who whom whose why how again quand quel quelle quels quelles comment pourquoi combien ' +
  // Nor do thanks and greetings.
  'thanks thank please ok okay yes hello hi hey great merci oui non bonjour salut super').split(' '));

export function terms(text: string): string[] {
  return (text.toLowerCase().normalize('NFD').replace(/\p{Mn}/gu, '').match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((t) => t.length > 1 && !STOP.has(t))
    .map((t) => (t.length > 4 ? t.replace(/(ing|ed|es|s)$/, '') : t));
}

/** Share of `a`'s words found in `b` (0..1). */
function overlap(a: string[], b: string[]): number {
  if (!a.length) return 0;
  const set = new Set(b);
  return a.filter((t) => set.has(t)).length / a.length;
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot; // MiniLM vectors are normalized
}

/** Memories visible to an assistant: its own and the shared ones. */
function visible(list: Memory[], assistantId?: string): Memory[] {
  return list.filter((m) => !m.assistantId || m.assistantId === assistantId);
}

/** The most similar existing memory, if it says nearly the same thing. */
async function duplicateOf(text: string, list: Memory[], vector?: Float32Array): Promise<Memory | undefined> {
  const t = terms(text);
  let best: { m: Memory; score: number } | undefined;
  for (const m of list) {
    const other = terms(m.text);
    const both = Math.min(overlap(t, other), overlap(other, t));
    // One says all the other does, and more: "lives in Brussels" → "lives in Brussels, Belgium".
    const [short, long] = t.length <= other.length ? [t, other] : [other, t];
    const contained = short.length >= 2 && overlap(short, long) === 1 ? 1 : 0;
    const sem = vector && m.vector ? cosine(vector, m.vector) : 0;
    const score = Math.max(both, contained, sem);
    if (!best || score > best.score) best = { m, score };
  }
  // The same words, one inside the other, or the same meaning ("lives in Brussels" / "is based in Brussels").
  return best && best.score >= 0.85 ? best.m : undefined;
}

// ---------------------------------------------------------------------------
// Changes

export interface AddResult {
  memory: Memory;
  /** It replaced a near-duplicate (its text is updated) rather than adding one. */
  updated: boolean;
}

/** Save a memory, or refresh the near-duplicate it restates. */
export async function addMemory(
  raw: string,
  opts: { auto?: boolean; assistantId?: string; source?: Memory['source']; pinned?: boolean; until?: number } = {},
): Promise<AddResult> {
  void ensureMemorySearch(); // in the background: the first time, a 23 MB download
  const text = raw.trim().replace(/\s+/g, ' ').slice(0, MAX_TEXT);
  if (!text) throw new Error('Empty memory');
  const [vector] = (await embedIfInstalled([text])) ?? [];
  const list = visible(await listMemories(), opts.assistantId);
  const dup = await duplicateOf(text, list, vector);
  const now = Date.now();
  if (dup) {
    // Restating a fact makes it lasting again, unless this one is temporary too.
    const memory: Memory = { ...dup, text, updatedAt: now, vector: vector ?? dup.vector };
    if (opts.until) memory.until = opts.until;
    else delete memory.until;
    await putMemoryRecord(memory);
    changed();
    return { memory, updated: true };
  }
  const memory: Memory = {
    id: newChatId(), text, createdAt: now, updatedAt: now,
    ...(opts.auto && { auto: true }), ...(opts.pinned && { pinned: true }),
    ...(opts.assistantId && { assistantId: opts.assistantId }), ...(opts.source && { source: opts.source }),
    ...(opts.until && { until: opts.until }), ...(vector && { vector }),
  };
  await putMemoryRecord(memory);
  changed();
  return { memory, updated: false };
}

export async function updateMemory(id: string, patch: Partial<Pick<Memory, 'text' | 'pinned' | 'assistantId'>>): Promise<void> {
  const m = (await listMemories()).find((x) => x.id === id);
  if (!m) return;
  const next: Memory = { ...m, ...patch, updatedAt: Date.now() };
  if (patch.text !== undefined) {
    next.text = patch.text.trim().slice(0, MAX_TEXT);
    const [vector] = (await embedIfInstalled([next.text])) ?? [];
    if (vector) next.vector = vector;
    else delete next.vector;
  }
  if (!patch.pinned) delete next.pinned;
  await putMemoryRecord(next);
  changed();
}

export async function deleteMemory(...ids: string[]): Promise<void> {
  for (const id of ids) await deleteMemoryRecord(id);
  changed();
}

/** Put memories back exactly as they were (undoing a replacement). */
export async function restoreMemories(records: Memory[]): Promise<void> {
  for (const m of records) await putMemoryRecord(m);
  changed();
}

/**
 * Whether a new fact is about the same thing as a memory: shared words (either way) or
 * close meaning. Guards automatic replacement, so a model can't drop unrelated memories.
 */
// Words that link a fact to a name but say nothing of its topic ("a dog named Rex", "a cat named Mimi").
const NAMING = new Set('named called nam call nomme nommee appele appelee llamado llamada genannt chiamato chiamata heet'.split(' '));

// Words for the same thing, so "started a new job at Spotify" replaces "works at Google".
const SAME = [
  'work job employ company career travail emploi boulot trabajo empleo arbeit beruf lavoro werk baan',
  'live lives home house flat apartment moved habite maison appartement demenage vive casa wohne wohnung abita woont',
].map((g) => g.split(' '));
const topicOf = (t: string) => SAME.findIndex((g) => g.some((w) => t === w || (Math.min(t.length, w.length) >= 4 && (t.startsWith(w) || w.startsWith(t)))));

export function sameTopic(m: Memory, text: string, vector?: Float32Array): boolean {
  const a = terms(text).filter((t) => !NAMING.has(t));
  const b = terms(m.text).filter((t) => !NAMING.has(t));
  const topics = new Set(b.map(topicOf).filter((i) => i >= 0));
  if (a.some((t) => topics.has(topicOf(t)))) return true;
  const sharedWord = a.some((t) => b.some((u) => t === u || (Math.min(t.length, u.length) >= 4 && (t.startsWith(u) || u.startsWith(t)))));
  const sem = vector && m.vector ? cosine(vector, m.vector) : 0;
  // Meaning alone must be close: "has a dog" and "has a cat" score 0.52, "lives in Brussels" and "in Paris" 0.65.
  return sharedWord || sem >= 0.6;
}

export async function clearMemories(): Promise<void> {
  await clearMemoryRecords();
  changed();
}

/** The memory that best matches `query` (to forget it), if any matches well. */
export async function findMemory(query: string, assistantId?: string): Promise<Memory | undefined> {
  const list = visible(await listMemories(), assistantId);
  const q = terms(query);
  const [vector] = (await embedIfInstalled([query])) ?? [];
  let best: { m: Memory; score: number } | undefined;
  for (const m of list) {
    const score = Math.max(overlap(q, terms(m.text)), vector && m.vector ? cosine(vector, m.vector) : 0);
    if (!best || score > best.score) best = { m, score };
  }
  return best && best.score >= 0.5 ? best.m : undefined;
}

// ---------------------------------------------------------------------------
// For the prompt

/**
 * Memories for this turn: pinned ones, then those related to `query` (the
 * user's latest messages). A short list goes in whole; a long one is ranked by
 * meaning (when the search model is installed) and shared words.
 */
export async function memoriesFor(query: string, opts: { assistantId?: string; limit: number }): Promise<string[]> {
  // A temporary fact carries the day it was said, so "next week" still means something later.
  const say = (m: Memory) => (m.until ? `${m.text} (said on ${new Date(m.createdAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric' })})` : m.text);
  return (await memoryRecordsFor(query, opts)).map(say);
}

/** The memory records for a turn (see memoriesFor). */
export async function memoryRecordsFor(query: string, opts: { assistantId?: string; limit: number }): Promise<Memory[]> {
  const list = visible(await listMemories(), opts.assistantId);
  if (list.length <= opts.limit) return [...list].reverse(); // oldest first reads naturally
  const pinned = list.filter((m) => m.pinned);
  const rest = list.filter((m) => !m.pinned);
  const q = terms(query);
  const [vector] = (await embedIfInstalled([query])) ?? [];
  const scored = rest
    .map((m) => ({ m, score: Math.max(overlap(q, terms(m.text)), vector && m.vector ? cosine(vector, m.vector) - 0.2 : 0) }))
    .filter((s) => s.score > 0.15)
    .sort((a, b) => b.score - a.score || b.m.updatedAt - a.m.updatedAt)
    .slice(0, Math.max(0, opts.limit - pinned.length))
    .map((s) => s.m);
  return [...pinned, ...scored];
}

/** "until 23 Oct", for the memory list. */
export const untilLabel = (m: Memory) => (m.until ? new Date(m.until).toLocaleDateString(locale, { day: 'numeric', month: 'short' }) : '');

export async function autoMemoryOn(): Promise<boolean> {
  return (await getSetting('autoMemory').catch(() => undefined)) ?? true;
}
