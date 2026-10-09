// Text-to-speech with Piper voices (VITS, ONNX) on the CPU: onnxruntime-web's
// WASM build, so the GPU stays free for the chat model. espeak-ng turns text into
// IPA phonemes, which the voice's phoneme_id_map turns into model input: the
// `phonemizer` package for English, and for French the English+French build in
// public/espeak (scripts/build-espeak.mjs), loaded on first use. Everything runs
// in this worker.
import '../net/install'; // first: records this worker's network activity
import * as Comlink from 'comlink';
import * as ort from 'onnxruntime-web/wasm';
import { phonemize } from 'phonemizer';
import { PIPER_VOICES, type VoiceInfo } from '../ttsVoices';

// Pinned so a cached voice and its config always match.
const REPO = 'https://huggingface.co/rhasspy/piper-voices/resolve/c10ece1aade47bb51c153c893d14e5bf8e5b7117/';
const CACHE = 'piper-voices-v1';

interface PiperConfig {
  audio: { sample_rate: number };
  espeak: { voice: string };
  inference: { noise_scale: number; length_scale: number; noise_w: number };
  phoneme_id_map: Record<string, number[]>;
}

const voice = (id: string) => {
  const v = PIPER_VOICES.find((x) => x.id === id);
  if (!v) throw new Error(`Unknown voice ${id}`);
  return v;
};
const modelUrl = (v: VoiceInfo) => `${REPO}${v.path}.onnx`;
const configUrl = (v: VoiceInfo) => `${REPO}${v.path}.onnx.json`;

ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;

let loaded: { id: string; session: ort.InferenceSession; config: PiperConfig } | null = null;
let loading: Promise<void> | null = null;

async function installed(id: string): Promise<boolean> {
  const cache = await caches.open(CACHE);
  const v = voice(id);
  return !!(await cache.match(modelUrl(v))) && !!(await cache.match(configUrl(v)));
}

/** Stream the voice into the Cache API, reporting bytes. */
async function install(id: string, onProgress: (got: number, total: number) => void): Promise<void> {
  const v = voice(id);
  const cache = await caches.open(CACHE);
  const cfg = await fetch(configUrl(v));
  if (!cfg.ok) throw new Error(`HTTP ${cfg.status} for the voice config`);
  const res = await fetch(modelUrl(v));
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} for the voice`);
  const total = Number(res.headers.get('content-length')) || v.bytes;
  let got = 0;
  const counted = res.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, ctl) {
      got += chunk.byteLength;
      onProgress(got, total);
      ctl.enqueue(chunk);
    },
  }));
  await cache.put(modelUrl(v), new Response(counted));
  // The config goes in last, so a voice only counts as installed once its model is complete.
  await cache.put(configUrl(v), cfg);
}

async function load(id: string): Promise<void> {
  if (loaded?.id === id) return;
  loading = (async () => {
    const v = voice(id);
    const cache = await caches.open(CACHE);
    const [m, c] = await Promise.all([cache.match(modelUrl(v)), cache.match(configUrl(v))]);
    if (!m || !c) throw new Error('Voice is not downloaded');
    const config = (await c.json()) as PiperConfig;
    const session = await ort.InferenceSession.create(new Uint8Array(await m.arrayBuffer()), {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    });
    await loaded?.session.release();
    loaded = { id, session, config };
  })().finally(() => { loading = null; });
  return loading;
}

const PUNCT = /([.,;:!?]+)/;

interface EspeakWorker {
  set_voice(voice: string): void;
  synthesize_ipa(text: string): { code: number; ipa: string };
}
let espeak: Promise<EspeakWorker> | null = null;

/** Text → IPA, one string per clause, as `phonemizer` returns it. */
async function phonemes(text: string, voice: string): Promise<string[]> {
  if (/^en\b/i.test(voice)) return phonemize(text, voice);
  espeak ??= (async () => {
    const url = new URL('/espeak/espeak-ng.js', self.location.origin).href;
    const { default: create } = (await import(/* @vite-ignore */ url)) as { default: () => Promise<{ eSpeakNGWorker: new () => EspeakWorker }> };
    return new (await create()).eSpeakNGWorker();
  })();
  espeak.catch(() => { espeak = null; });
  const w = await espeak;
  w.set_voice(voice);
  const r = w.synthesize_ipa(text);
  if (r.code !== 0) throw new Error(`espeak-ng failed (${r.code})`);
  // This build separates phonemes with "_"; Piper reads them as one string per clause.
  return r.ipa.split('\n').map((l) => l.replace(/_/g, '')).filter((l) => l.trim());
}

/** Text → Piper phoneme ids: ^ _ (phoneme _)* $, with punctuation kept for prosody. */
async function phonemeIds(text: string, config: PiperConfig): Promise<number[]> {
  const map = config.phoneme_id_map;
  const ids = [...map['^'], ...map['_']];
  const push = (ch: string) => {
    const id = map[ch];
    if (id) ids.push(...id, ...map['_']);
  };
  for (const part of text.split(PUNCT)) {
    if (!part.trim()) continue;
    if (PUNCT.test(part)) {
      for (const ch of part) push(ch);
      push(' ');
      continue;
    }
    const phones = (await phonemes(part, config.espeak.voice)).join(' ').normalize('NFD');
    for (const ch of phones) push(ch);
  }
  ids.push(...map['$']);
  return ids;
}

// Synthesis is serialized: the session isn't reentrant.
let queue: Promise<unknown> = Promise.resolve();

const api = {
  installed,
  install,

  async remove(id: string): Promise<void> {
    const v = voice(id);
    if (loaded?.id === id) {
      await loaded.session.release();
      loaded = null;
    }
    const cache = await caches.open(CACHE);
    await Promise.all([cache.delete(modelUrl(v)), cache.delete(configUrl(v))]);
  },

  /** One sentence or clause → mono float samples. `rate` 1 = normal speed. */
  synth(id: string, text: string, rate = 1): Promise<{ audio: Float32Array; sampleRate: number }> {
    const run = queue.then(async () => {
      await loading;
      await load(id);
      const { session, config } = loaded!;
      const ids = await phonemeIds(text, config);
      const inf = config.inference;
      const out = await session.run({
        input: new ort.Tensor('int64', BigInt64Array.from(ids.map(BigInt)), [1, ids.length]),
        input_lengths: new ort.Tensor('int64', BigInt64Array.of(BigInt(ids.length)), [1]),
        scales: new ort.Tensor('float32', Float32Array.of(inf.noise_scale, inf.length_scale / rate, inf.noise_w), [3]),
      });
      const audio = (out.output.data as Float32Array).slice();
      return Comlink.transfer({ audio, sampleRate: config.audio.sample_rate }, [audio.buffer]);
    });
    queue = run.catch(() => {});
    return run;
  },
};

export type TtsApi = typeof api;
Comlink.expose(api);
