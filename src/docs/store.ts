// Document library: ingest (extract → split → embed → store) and hybrid
// search over the documents attached to a conversation. Keyword ranking (BM25)
// works in any language and needs no model; semantic ranking uses MiniLM
// embeddings when available. The two are merged with reciprocal rank fusion.
import * as Comlink from 'comlink';
import type { EmbedApi } from '../worker/embed.worker';
import { allDocs, deleteDoc, getDoc, newChatId, putDoc, type DocRecord } from '../db';
import { extract } from './extract';
import type { RunFile } from '../sandbox/sandbox';

/** Files up to this size are also kept as is, for code to analyse. */
const MAX_RAW = 10 * 2 ** 20;

const DIM = 384;

let worker: Comlink.Remote<EmbedApi> | null = null;
function embedder(): Comlink.Remote<EmbedApi> {
  worker ??= Comlink.wrap<EmbedApi>(new Worker(new URL('../worker/embed.worker.ts', import.meta.url), { type: 'module', name: 'Document search' }));
  return worker;
}

export type IngestStage = 'reading' | 'model' | 'indexing';
export type IngestProgress = (stage: IngestStage, fraction: number) => void;

export interface DocInfo {
  id: string;
  name: string;
  size: number;
  pages?: number;
  passages: number;
  semantic: boolean;
  addedAt: number;
}

const info = (d: DocRecord): DocInfo => ({
  id: d.id, name: d.name, size: d.size, pages: d.pages, passages: d.passages.length, semantic: !!d.vectors, addedAt: d.addedAt,
});

/** Read, index and store a file. Semantic indexing is best effort (needs a one-time 23 MB download). */
/** `folderId`: indexed from a workspace folder (kept out of the library list, no raw copy: the file is on disk). */
export async function ingest(file: File, onProgress?: IngestProgress, folderId?: string): Promise<DocInfo> {
  const { passages, pages } = await extract(file, (f) => onProgress?.('reading', f));
  const doc: DocRecord = { id: newChatId(), name: file.name, size: file.size, pages, addedAt: Date.now(), passages, ...(folderId && { folderId }) };
  if (file.size <= MAX_RAW && !folderId) doc.raw = await file.arrayBuffer();
  try {
    const e = embedder();
    if (!(await e.installed())) {
      await e.load(Comlink.proxy((got: number, total: number) => onProgress?.('model', got / total)));
    }
    doc.vectors = await e.embed(
      passages.map((p) => p.text),
      Comlink.proxy((done: number, total: number) => onProgress?.('indexing', done / total)),
    );
  } catch (err) {
    // Offline before the model was ever downloaded, for example: keyword search still works.
    console.warn('Semantic indexing unavailable; keyword search only', err);
  }
  await putDoc(doc);
  cache.set(doc.id, doc);
  return info(doc);
}

/** The original files of these documents, for code to read (documents added before this was kept are skipped). */
export async function docFiles(ids: string[]): Promise<RunFile[]> {
  return (await load(ids)).flatMap((d) => (d.raw ? [{ name: d.name.replace(/[\\/]/g, '_'), bytes: d.raw }] : []));
}

/**
 * Embeddings of `texts` when the search model is already installed (memories
 * use it opportunistically: they never trigger its 23 MB download), else null.
 */
/** Whether the search model (MiniLM, 23 MB) is on this device. */
export async function embedderInstalled(): Promise<boolean> {
  return embedder().installed().catch(() => false);
}

/** Download the search model once (memory uses it to match facts by meaning). */
export async function installEmbedder(): Promise<boolean> {
  try {
    const e = embedder();
    if (!(await e.installed())) await e.load(Comlink.proxy(() => {}));
    return true;
  } catch {
    return false; // offline: keyword matching still works
  }
}

export async function embedIfInstalled(texts: string[]): Promise<Float32Array[] | null> {
  try {
    const e = embedder();
    if (!(await e.installed())) return null;
    const flat = await e.embed(texts);
    return texts.map((_, i) => flat.slice(i * DIM, (i + 1) * DIM));
  } catch {
    return null;
  }
}

export async function listDocs(): Promise<DocInfo[]> {
  return (await allDocs()).filter((d) => !d.folderId).map(info).sort((a, b) => b.addedAt - a.addedAt);
}

export async function removeDoc(id: string): Promise<void> {
  cache.delete(id);
  await deleteDoc(id);
}

// ---------------------------------------------------------------------------
// Search

const cache = new Map<string, DocRecord>();
async function load(ids: string[]): Promise<DocRecord[]> {
  const out: DocRecord[] = [];
  for (const id of ids) {
    let d = cache.get(id);
    if (!d) {
      d = await getDoc(id);
      if (d) cache.set(id, d);
    }
    if (d) out.push(d);
  }
  return out;
}

// Common English and French function words; they carry no meaning for ranking.
const STOP = new Set(('a an and are as at be but by for from has have i in is it its of on or that the this to was were what when where which who why will with you your ' +
  'how do does can could should would about into than then there these those they them their our we he she his her not no yes ' +
  'le la les un une des du de et est en que qui dans pour par sur au aux ce ces il elle ils elles je tu nous vous ne pas plus ou où se sa son ses leur leurs').split(' '));

// Light suffix stripping so "rentals"/"rent" or "cats"/"cat" match. Crude, but
// applied to both query and passages, so it only has to be consistent.
const SUFFIXES = ['ations', 'ation', 'ments', 'ment', 'ings', 'ing', 'edly', 'ed', 'als', 'al', 'ies', 'es', 's'];
function stem(t: string): string {
  if (t.length <= 4 || /^\d/.test(t)) return t;
  for (const suf of SUFFIXES) {
    if (t.endsWith(suf) && t.length - suf.length >= 3) return t.slice(0, -suf.length);
  }
  return t;
}

function terms(text: string): string[] {
  return (text.toLowerCase().normalize('NFD').replace(/\p{Mn}/gu, '').match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((t) => t.length > 1 && !STOP.has(t))
    .map(stem);
}

interface Hit { doc: DocRecord; index: number }

function bm25(query: string[], hits: Hit[]): number[] {
  const k1 = 1.4, b = 0.75;
  const docs = hits.map((h) => terms(h.doc.passages[h.index].text));
  const avg = docs.reduce((n, d) => n + d.length, 0) / Math.max(1, docs.length);
  const df = new Map<string, number>();
  for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) ?? 0) + 1);
  return docs.map((d) => {
    const tf = new Map<string, number>();
    for (const t of d) tf.set(t, (tf.get(t) ?? 0) + 1);
    let score = 0;
    for (const q of new Set(query)) {
      const f = tf.get(q);
      if (!f) continue;
      const n = df.get(q) ?? 0;
      const idf = Math.log(1 + (docs.length - n + 0.5) / (n + 0.5));
      score += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.length) / avg));
    }
    return score;
  });
}

/**
 * The passages most relevant to `query` in the given documents, formatted
 * for the model, within `maxChars`.
 */
export async function searchDocs(ids: string[], query: string, opts: { k?: number; maxChars?: number } = {}): Promise<string> {
  const { k = 4, maxChars = 2000 } = opts;
  const docs = await load(ids);
  if (!docs.length) return 'The attached documents are no longer on this device.';
  const hits: Hit[] = docs.flatMap((doc) => doc.passages.map((_, index) => ({ doc, index })));

  const ranks: number[][] = [];
  const kw = bm25(terms(query), hits);
  if (kw.some((s) => s > 0)) ranks.push(order(kw));

  if (docs.some((d) => d.vectors)) {
    try {
      const q = await embedder().embed([query]);
      const sem = hits.map(({ doc, index }) => {
        if (!doc.vectors) return -1;
        let dot = 0;
        const off = index * DIM;
        for (let i = 0; i < DIM; i++) dot += doc.vectors[off + i] * q[i];
        return dot;
      });
      ranks.push(order(sem));
    } catch (e) {
      console.warn('Semantic search failed; keyword only', e);
    }
  }
  if (!ranks.length) return `Nothing in ${names(docs)} matches "${query}". Try other words.`;

  // Reciprocal rank fusion.
  const fused = new Map<number, number>();
  for (const r of ranks) r.forEach((hit, rank) => fused.set(hit, (fused.get(hit) ?? 0) + 1 / (60 + rank)));
  const best = [...fused.entries()].sort((a, b) => b[1] - a[1]).map(([i]) => hits[i]);

  const out: string[] = [];
  let used = 0;
  for (const h of best) {
    if (out.length >= k) break;
    const p = h.doc.passages[h.index];
    const where = docs.length > 1 || p.page ? ` (${[docs.length > 1 && `"${h.doc.name}"`, p.page && `page ${p.page}`].filter(Boolean).join(', ')})` : '';
    const block = `[${out.length + 1}]${where}: ${p.text}`;
    if (used + block.length > maxChars) {
      if (out.length) break;
      out.push(block.slice(0, maxChars - 1) + '…');
      break;
    }
    out.push(block);
    used += block.length + 1;
  }
  return `Excerpts from ${names(docs)}:\n${out.join('\n')}`;
}

function order(scores: number[]): number[] {
  return scores.map((s, i) => [s, i] as const).filter(([s]) => s > 0).sort((a, b) => b[0] - a[0]).map(([, i]) => i);
}

function names(docs: DocRecord[]): string {
  return docs.length === 1 ? `"${docs[0].name}"` : `${docs.length} documents`;
}
