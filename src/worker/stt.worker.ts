// Speech recognition with NVIDIA Parakeet TDT 0.6B v3 models as ONNX, run with
// onnxruntime-web: Phonon-2 (Fermion Research's English-tuned version, the most
// accurate for English) or the original multilingual model (25 European
// languages, French included). Both share the same inputs, outputs and vocabulary. It lives in its own worker so a
// transcription never waits behind an LLM generation, and the ~27 MB runtime is
// only fetched when someone actually uses speech.
// Audio arrives here as 16 kHz mono samples and never leaves the device.
import '../net/install'; // first: records this worker's network activity
import * as Comlink from 'comlink';
import * as ort from 'onnxruntime-web/webgpu';

type FileKey = 'pre' | 'enc' | 'dec' | 'vocab';
export type SttModel = 'phonon2' | 'parakeet3';

interface ModelFiles {
  /** Pinned to a commit so the weights can't change under a cached install. */
  repo: string;
  cache: string;
  /** `repo` overrides the model's repository for that file. */
  files: Record<FileKey, { name: string; bytes: number; repo?: string }>;
}

const PHONON2_REPO = 'https://huggingface.co/tiyuvta/Phonon-2-ONNX/resolve/12c9688bbc4fc52d23c1a66ca873fd3ac6ed4408/';

const MODELS: Record<SttModel, ModelFiles> = {
  // exact4x2: the same weights as Fermion's fp32 runtime, bit for bit, at 662 MB
  // instead of 2.4 GB. Its MatMulNBits op runs on WebGPU.
  phonon2: {
    repo: PHONON2_REPO,
    cache: 'phonon2-onnx-v1',
    files: {
      pre: { name: 'preprocessor-model.onnx', bytes: 1_193_996 },
      enc: { name: 'encoder-model.exact4x2.onnx', bytes: 662_190_977 },
      dec: { name: 'decoder_joint-model.onnx', bytes: 72_518_934 },
      vocab: { name: 'vocab.txt', bytes: 93_939 },
    },
  },
  // NVIDIA's model as exported by onnx-asr (istupakov), 8-bit: dictation in French,
  // Spanish, German, Italian… with the language detected from the audio. Its own
  // preprocessor (nemo128) computes in float64, which onnxruntime-web leaves out;
  // Phonon-2's computes the same 128 mel features in float32.
  parakeet3: {
    repo: 'https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx/resolve/8f23f0c03c8761650bdb5b40aaf3e40d2c15f1ce/',
    cache: 'parakeet3-onnx-v1',
    files: {
      pre: { name: 'preprocessor-model.onnx', bytes: 1_193_996, repo: PHONON2_REPO },
      enc: { name: 'encoder-model.int8.onnx', bytes: 652_183_999 },
      dec: { name: 'decoder_joint-model.int8.onnx', bytes: 18_202_004 },
      vocab: { name: 'vocab.txt', bytes: 93_939 },
    },
  },
};
const KEYS: FileKey[] = ['pre', 'enc', 'dec', 'vocab'];
const totalBytes = (m: SttModel) => KEYS.reduce((n, k) => n + MODELS[m].files[k].bytes, 0);
const fileName = (m: SttModel, k: FileKey) => MODELS[m].files[k].name;
const fileBytes = (m: SttModel, k: FileKey) => MODELS[m].files[k].bytes;
const ORT_WASM_CDN = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ort.env.versions.web}/dist/ort-wasm-simd-threaded.asyncify.wasm`;
const SR = 16000;
const BLANK = 8192;
const N_DUR = 5; // TDT durations 0..4
const MAX_SYMBOLS = 10; // tokens allowed on one frame
const CHUNK_SEC = 30; // cut long audio at pauses

export interface SttStatus {
  totalBytes: number;
  cachedBytes: number;
  complete: boolean;
}

export interface Transcript {
  text: string;
  secs: number;
  /** cuda: Whisper through whisper.cpp in the desktop app. */
  backend: 'webgpu' | 'wasm' | 'cuda';
}

const url = (m: SttModel, k: FileKey) => (MODELS[m].files[k].repo ?? MODELS[m].repo) + fileName(m, k);

let sessions: { model: SttModel; pre: ort.InferenceSession; enc: ort.InferenceSession; dec: ort.InferenceSession } | null = null;
let vocab: string[] = [];
let backend: Transcript['backend'] = 'wasm';
let loading: Promise<void> | null = null;

async function status(m: SttModel): Promise<SttStatus> {
  const cache = await caches.open(MODELS[m].cache);
  let cachedBytes = 0;
  for (const k of KEYS) if (await cache.match(url(m, k))) cachedBytes += fileBytes(m, k);
  return { totalBytes: totalBytes(m), cachedBytes, complete: cachedBytes === totalBytes(m) };
}

/**
 * Stream each missing file straight into the Cache API, so a 662 MB file is
 * never held in memory during the download. Finished files survive a pause.
 */
async function install(m: SttModel, onProgress: (got: number, total: number) => void): Promise<void> {
  const cache = await caches.open(MODELS[m].cache);
  const STT_TOTAL_BYTES = totalBytes(m);
  let done = 0;
  for (const k of KEYS) {
    if (await cache.match(url(m, k))) {
      done += fileBytes(m, k);
      onProgress(done, STT_TOTAL_BYTES);
      continue;
    }
    const res = await fetch(url(m, k));
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} for ${fileName(m, k)}`);
    let got = 0;
    const counted = res.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, ctl) {
        got += chunk.byteLength;
        onProgress(done + got, STT_TOTAL_BYTES);
        ctl.enqueue(chunk);
      },
    }));
    try {
      await cache.put(url(m, k), new Response(counted, { headers: { 'content-type': 'application/octet-stream' } }));
    } catch (e) {
      // Chrome reports a full quota (common in private windows) as an "internal error".
      const est = await navigator.storage?.estimate?.().catch(() => undefined);
      if (est?.quota != null && est.quota - (est.usage ?? 0) < fileBytes(m, k)) {
        const mb = (n: number) => `${Math.round(n / 1024 ** 2)} MB`;
        throw new Error(`Not enough storage: ${fileName(m, k)} needs ${mb(fileBytes(m, k))}, the browser allows ${mb(est.quota - (est.usage ?? 0))} more. Private windows have a small limit.`);
      }
      throw e;
    }
    if (got !== fileBytes(m, k)) {
      await cache.delete(url(m, k));
      throw new Error(`${fileName(m, k)} was truncated (${got} of ${fileBytes(m, k)} bytes)`);
    }
    done += fileBytes(m, k);
  }
}

async function read(cache: Cache, m: SttModel, k: FileKey): Promise<Uint8Array> {
  const res = await cache.match(url(m, k));
  if (!res) throw new Error('Speech model is not installed');
  return new Uint8Array(await res.arrayBuffer());
}

let loadingModel: SttModel | null = null;

function load(m: SttModel): Promise<void> {
  // Another model was loaded: free it first (each takes about 1 GB).
  if (loadingModel !== m) {
    loading = null;
    loadingModel = m;
  }
  loading ??= (async () => {
    if (sessions && sessions.model !== m) {
      await Promise.all([sessions.pre, sessions.enc, sessions.dec].map((x) => x.release()));
      sessions = null;
    }
    if (sessions) return;
    const cache = await caches.open(MODELS[m].cache);
    ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
    // The 27 MB runtime is over Cloudflare's 25 MiB per-file limit, so builds
    // load it from jsDelivr (same file, same version); see vite.config.ts.
    if (import.meta.env.PROD) ort.env.wasm.wasmPaths = { wasm: ORT_WASM_CDN };
    const wasm: ort.InferenceSession.SessionOptions = { executionProviders: ['wasm'], graphOptimizationLevel: 'all' };
    vocab = [];
    for (const line of new TextDecoder().decode(await read(cache, m, 'vocab')).split('\n')) {
      const i = line.lastIndexOf(' ');
      if (i > 0) vocab[Number(line.slice(i + 1))] = line.slice(0, i);
    }
    // The encoder is the heavy part; the decoder runs once per frame on tiny
    // tensors, where WASM beats the GPU round-trip.
    let enc: ort.InferenceSession | null = null;
    if (navigator.gpu) {
      try {
        enc = await ort.InferenceSession.create(await read(cache, m, 'enc'), { executionProviders: ['webgpu'], graphOptimizationLevel: 'all' });
        backend = 'webgpu';
      } catch (e) {
        console.warn(`${m}: WebGPU session failed, using WASM`, e);
      }
    }
    if (!enc) {
      enc = await ort.InferenceSession.create(await read(cache, m, 'enc'), wasm);
      backend = 'wasm';
    }
    const pre = await ort.InferenceSession.create(await read(cache, m, 'pre'), wasm);
    const dec = await ort.InferenceSession.create(await read(cache, m, 'dec'), wasm);
    sessions = { model: m, pre, enc, dec };
  })().catch((e) => {
    loading = null;
    throw e;
  });
  return loading;
}

/** Cut audio over CHUNK_SEC at the quietest 100 ms window in its last 5 s. */
function splitChunks(wav: Float32Array): [number, number][] {
  const max = CHUNK_SEC * SR;
  const win = SR / 10;
  const out: [number, number][] = [];
  let start = 0;
  while (wav.length - start > max) {
    let best = start + max - 5 * SR, bestE = Infinity;
    for (let s = best; s + win <= start + max; s += win / 2) {
      let e = 0;
      for (let i = s; i < s + win; i++) e += wav[i] * wav[i];
      if (e < bestE) {
        bestE = e;
        best = s + win / 2;
      }
    }
    out.push([start, best]);
    start = best;
  }
  out.push([start, wav.length]);
  return out;
}

function argmax(a: Float32Array, from: number, to: number): number {
  let bi = from;
  for (let i = from + 1; i < to; i++) if (a[i] > a[bi]) bi = i;
  return bi - from;
}

/** Greedy TDT decoding, per the Phonon-2-ONNX model card (the same for both models). */
async function transcribeChunk(wav: Float32Array): Promise<string> {
  const { pre, enc, dec } = sessions!;
  const T = ort.Tensor;
  const p = await pre.run({
    waveforms: new T('float32', wav, [1, wav.length]),
    waveforms_lens: new T('int64', BigInt64Array.of(BigInt(wav.length)), [1]),
  });
  const e = await enc.run({ audio_signal: p.features, length: p.features_lens });
  const out = e.outputs; // [1, 1024, T']
  const [, D, stride] = out.dims;
  const frames = Number(e.encoded_lengths.data[0]);
  const data = (await out.getData()) as Float32Array;
  out.dispose();

  const frame = new Float32Array(D);
  let s1: ort.Tensor = new T('float32', new Float32Array(2 * 640), [2, 1, 640]);
  let s2: ort.Tensor = new T('float32', new Float32Array(2 * 640), [2, 1, 640]);
  const targetLength = new T('int32', Int32Array.of(1), [1]);
  let prev = BLANK, onFrame = 0, t = 0;
  let text = '';
  while (t < frames) {
    for (let d = 0; d < D; d++) frame[d] = data[d * stride + t];
    const r = await dec.run({
      encoder_outputs: new T('float32', frame, [1, D, 1]),
      targets: new T('int32', Int32Array.of(prev), [1, 1]),
      target_length: targetLength,
      input_states_1: s1,
      input_states_2: s2,
    });
    const logits = r.outputs.data as Float32Array;
    const tok = argmax(logits, 0, BLANK + 1);
    let dur = argmax(logits, BLANK + 1, BLANK + 1 + N_DUR);
    if (tok !== BLANK) {
      const piece = vocab[tok] ?? '';
      if (piece !== '<unk>' && piece !== '<pad>' && !/^<\|.*\|>$/.test(piece)) text += piece.replace(/▁/g, ' ');
      prev = tok;
      s1 = r.output_states_1;
      s2 = r.output_states_2;
      onFrame++;
    }
    if (dur === 0 && (tok === BLANK || onFrame >= MAX_SYMBOLS)) dur = 1;
    if (dur > 0) onFrame = 0;
    t += dur;
  }
  return text.trim();
}

// One transcription at a time; the decoder states are per-call but the
// sessions are not safe to run concurrently.
let queue: Promise<unknown> = Promise.resolve();

const api = {
  status,
  install,
  load,

  async transcribe(m: SttModel, wav: Float32Array): Promise<Transcript> {
    const run = queue.then(async () => {
      await load(m);
      const t0 = performance.now();
      const parts: string[] = [];
      for (const [a, b] of splitChunks(wav)) parts.push(await transcribeChunk(wav.subarray(a, b)));
      return { text: parts.filter(Boolean).join(' '), secs: (performance.now() - t0) / 1000, backend };
    });
    queue = run.catch(() => {});
    return run;
  },

  async remove(m: SttModel): Promise<void> {
    await queue;
    if (sessions?.model === m) {
      await Promise.all([sessions.pre, sessions.enc, sessions.dec].map((x) => x.release()));
      sessions = null;
      loading = null;
    }
    await caches.delete(MODELS[m].cache);
  },
};

export type SttApi = typeof api;
Comlink.expose(api);
