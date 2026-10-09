// Sentence embeddings for document search: all-MiniLM-L6-v2 (8-bit ONNX,
// 23 MB, 384 dimensions) on onnxruntime-web's WASM backend, so it runs on the
// CPU and leaves the GPU to the chat model. Includes a BERT WordPiece
// tokenizer, which is all this model needs.
import '../net/install'; // first: records this worker's network activity
import * as Comlink from 'comlink';
import * as ort from 'onnxruntime-web/wasm';

const REPO = 'https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/751bff37182d3f1213fa05d7196b954e230abad9/';
const FILES = { model: 'onnx/model_quantized.onnx', vocab: 'vocab.txt' } as const;
const CACHE = 'embed-minilm-v1';
export const EMBED_DIM = 384;
const MAX_TOKENS = 256;
const BATCH = 8;

ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;

let session: ort.InferenceSession | null = null;
let vocab: Map<string, number> | null = null;
let loading: Promise<void> | null = null;

async function cached(name: string, onBytes?: (n: number) => void): Promise<Response> {
  const cache = await caches.open(CACHE);
  const url = REPO + name;
  const hit = await cache.match(url);
  if (hit) return hit;
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} for ${name}`);
  let got = 0;
  const counted = res.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, ctl) { got += chunk.byteLength; onBytes?.(got); ctl.enqueue(chunk); },
  }));
  await cache.put(url, new Response(counted));
  return (await cache.match(url))!;
}

function load(onProgress?: (got: number, total: number) => void): Promise<void> {
  loading ??= (async () => {
    const total = 22_972_370;
    const [model, words] = await Promise.all([
      cached(FILES.model, (n) => onProgress?.(n, total)).then((r) => r.arrayBuffer()),
      cached(FILES.vocab).then((r) => r.text()),
    ]);
    vocab = new Map(words.split('\n').map((w, i) => [w.trim(), i] as [string, number]).filter(([w]) => w));
    session = await ort.InferenceSession.create(new Uint8Array(model), { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
  })().catch((e) => {
    loading = null;
    throw e;
  });
  return loading;
}

// --- BERT uncased tokenizer: clean, lowercase, strip accents, split on
// whitespace and punctuation, then greedy longest-match WordPiece.
const PUNCT = /[\p{P}\p{S}]/u;

function basicTokens(text: string): string[] {
  const clean = text
    .normalize('NFD')
    .replace(/\p{Mn}/gu, '') // accents
    .toLowerCase()
    .replace(/[\u0000�\p{Cc}]/gu, ' ');
  const out: string[] = [];
  for (const word of clean.split(/\s+/)) {
    let cur = '';
    for (const ch of word) {
      // CJK characters are split one by one, as BERT does.
      if (PUNCT.test(ch) || /[一-鿿㐀-䶿]/.test(ch)) {
        if (cur) out.push(cur);
        out.push(ch);
        cur = '';
      } else cur += ch;
    }
    if (cur) out.push(cur);
  }
  return out;
}

function wordPiece(word: string, v: Map<string, number>): number[] {
  if (word.length > 100) return [v.get('[UNK]')!];
  const ids: number[] = [];
  let start = 0;
  while (start < word.length) {
    let end = word.length;
    let id: number | undefined;
    while (start < end) {
      const piece = (start > 0 ? '##' : '') + word.slice(start, end);
      id = v.get(piece);
      if (id !== undefined) break;
      end--;
    }
    if (id === undefined) return [v.get('[UNK]')!];
    ids.push(id);
    start = end;
  }
  return ids;
}

function encode(text: string): number[] {
  const v = vocab!;
  const ids = basicTokens(text).flatMap((w) => wordPiece(w, v)).slice(0, MAX_TOKENS - 2);
  return [v.get('[CLS]')!, ...ids, v.get('[SEP]')!];
}

/** Mean-pooled, L2-normalized embeddings, row-major (texts.length × 384). */
async function embedBatch(texts: string[]): Promise<Float32Array> {
  const seqs = texts.map(encode);
  const len = Math.max(...seqs.map((s) => s.length));
  const n = seqs.length;
  const ids = new BigInt64Array(n * len);
  const mask = new BigInt64Array(n * len);
  seqs.forEach((s, i) => s.forEach((t, j) => { ids[i * len + j] = BigInt(t); mask[i * len + j] = 1n; }));
  const out = await session!.run({
    input_ids: new ort.Tensor('int64', ids, [n, len]),
    attention_mask: new ort.Tensor('int64', mask, [n, len]),
    token_type_ids: new ort.Tensor('int64', new BigInt64Array(n * len), [n, len]),
  });
  const hidden = (out.last_hidden_state ?? Object.values(out)[0]).data as Float32Array;
  const result = new Float32Array(n * EMBED_DIM);
  for (let i = 0; i < n; i++) {
    const count = seqs[i].length;
    const row = result.subarray(i * EMBED_DIM, (i + 1) * EMBED_DIM);
    for (let j = 0; j < count; j++) {
      const off = (i * len + j) * EMBED_DIM;
      for (let d = 0; d < EMBED_DIM; d++) row[d] += hidden[off + d];
    }
    let norm = 0;
    for (let d = 0; d < EMBED_DIM; d++) { row[d] /= count; norm += row[d] * row[d]; }
    norm = Math.sqrt(norm) || 1;
    for (let d = 0; d < EMBED_DIM; d++) row[d] /= norm;
  }
  return result;
}

const api = {
  async installed(): Promise<boolean> {
    const cache = await caches.open(CACHE);
    return !!(await cache.match(REPO + FILES.model)) && !!(await cache.match(REPO + FILES.vocab));
  },

  /** Download (once) and load the model. */
  load: (onProgress?: (got: number, total: number) => void) => load(onProgress),

  /** Embed texts; `onProgress(done, total)` after each batch. */
  async embed(texts: string[], onProgress?: (done: number, total: number) => void): Promise<Float32Array> {
    await load();
    const all = new Float32Array(texts.length * EMBED_DIM);
    for (let i = 0; i < texts.length; i += BATCH) {
      all.set(await embedBatch(texts.slice(i, i + BATCH)), i * EMBED_DIM);
      onProgress?.(Math.min(i + BATCH, texts.length), texts.length);
    }
    return Comlink.transfer(all, [all.buffer]);
  },

  async remove(): Promise<void> {
    await session?.release();
    session = null;
    vocab = null;
    loading = null;
    await caches.delete(CACHE);
  },
};

export type EmbedApi = typeof api;
Comlink.expose(api);
