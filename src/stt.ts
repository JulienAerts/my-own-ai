// Speech-to-text state lives outside components so a download survives route
// changes. The worker is separate from the LLM engine (see stt.worker.ts).
import { useEffect, useState } from 'preact/hooks';
import * as Comlink from 'comlink';
import type { SttApi, SttModel, SttStatus, Transcript } from './worker/stt.worker';
import { getSetting, setSetting } from './db';
import { probeConnection } from './probe/device';
import { onConnectionChange } from './net';
import { cancelWhisperDownload, installWhisper, loadWhisper, removeWhisper, transcribeWhisper, whisperAvailable, whisperStatus } from './native/whisper';
import { lang, t } from './i18n/i18n';

export type { SttModel };

/**
 * The browser's dictation model (Settings → Voice): Phonon-2 for English, or the
 * multilingual Parakeet v3, the default when the interface isn't in English.
 */
let model: SttModel | null = null;
export async function sttModel(): Promise<SttModel> {
  model ??= (await getSetting('sttModel').catch(() => undefined)) ?? (lang === 'en' ? 'phonon2' : 'parakeet3');
  return model;
}

/**
 * The speech engine: Whisper on the desktop with an NVIDIA GPU (multilingual),
 * else the chosen model in a worker. Both answer the same calls.
 */
const engine = {
  status: async (): Promise<SttStatus> => ((await whisperAvailable()) ? whisperStatus() : stt().status(await sttModel())),
  install: async (onProgress: (got: number, total: number) => void) =>
    ((await whisperAvailable()) ? installWhisper(onProgress) : stt().install(await sttModel(), Comlink.proxy(onProgress))),
  load: async () => ((await whisperAvailable()) ? void (await loadWhisper()) : stt().load(await sttModel())),
  transcribe: async (audio: Float32Array): Promise<Transcript> => {
    if (await whisperAvailable()) return { ...(await transcribeWhisper(audio)), backend: 'cuda' };
    return stt().transcribe(await sttModel(), Comlink.transfer(audio, [audio.buffer]));
  },
  remove: async () => ((await whisperAvailable()) ? removeWhisper() : stt().remove(await sttModel())),
};

/** Which engine dictation uses here (for the settings card). */
export const sttEngine = (): Promise<'whisper' | SttModel> => whisperAvailable().then(async (w) => (w ? 'whisper' : sttModel()));

/** Switch the browser's dictation model; the other one's download stays until deleted. */
export async function setSttModel(m: SttModel): Promise<void> {
  if (state.kind === 'downloading') await pauseStt();
  model = m;
  await setSetting('sttModel', m);
  set({ kind: 'checking' });
  await refresh();
}

export type SttState =
  | { kind: 'checking' }
  | { kind: 'absent'; status: SttStatus }
  | { kind: 'downloading'; got: number; total: number }
  | { kind: 'paused'; status: SttStatus; reason: string }
  | { kind: 'error'; status: SttStatus; message: string }
  | { kind: 'installed'; status: SttStatus };

let worker: Worker | null = null;
let remote: Comlink.Remote<SttApi> | null = null;

function stt(): Comlink.Remote<SttApi> {
  if (!remote) {
    worker = new Worker(new URL('./worker/stt.worker.ts', import.meta.url), { type: 'module', name: 'Speech recognition' });
    remote = Comlink.wrap<SttApi>(worker);
  }
  return remote;
}

let state: SttState = { kind: 'checking' };
const subs = new Set<(s: SttState) => void>();
// Bumped on pause so callbacks from a terminated worker are ignored.
let run = 0;
let unwatch: (() => void) | null = null;

function set(s: SttState) {
  state = s;
  subs.forEach((fn) => fn(s));
}

async function refresh(): Promise<void> {
  if (state.kind === 'downloading') return;
  const status = await engine.status();
  // A download may have started while status() was in flight.
  if ((state as SttState).kind === 'downloading') return;
  set(status.complete ? { kind: 'installed', status } : { kind: 'absent', status });
}

export function useStt(): SttState {
  const [s, setS] = useState(state);
  useEffect(() => {
    subs.add(setS);
    setS(state);
    if (state.kind === 'checking') refresh();
    return () => void subs.delete(setS);
  }, []);
  return s;
}

export async function installStt(): Promise<void> {
  if (state.kind === 'downloading') return;
  const wifiOnly = (await getSetting('wifiOnly')) ?? false;
  const status = await engine.status();
  if (wifiOnly && probeConnection()?.type === 'cellular') {
    return set({ kind: 'paused', status, reason: t('Waiting for Wi-Fi (Wi-Fi only is on).') });
  }
  const token = ++run;
  unwatch?.();
  unwatch = onConnectionChange(() => {
    if (wifiOnly && probeConnection()?.type === 'cellular') {
      pauseStt('Paused because you switched to a cellular connection (Wi-Fi only is on).');
    }
  });
  await navigator.storage?.persist?.().catch(() => false);
  set({ kind: 'downloading', got: status.cachedBytes, total: status.totalBytes });
  try {
    await engine.install((got, total) => {
      if (token === run && state.kind === 'downloading') set({ kind: 'downloading', got, total });
    });
    if (token !== run) return;
    set({ kind: 'installed', status: await engine.status() });
  } catch (e) {
    if (token !== run) return;
    set({ kind: 'error', status: await engine.status(), message: e instanceof Error ? e.message : String(e) });
  } finally {
    if (token === run) {
      unwatch?.();
      unwatch = null;
    }
  }
}

export async function pauseStt(reason = 'Paused. Finished files are saved on this device.'): Promise<void> {
  if (state.kind !== 'downloading') return;
  run++;
  unwatch?.();
  unwatch = null;
  if (await whisperAvailable()) await cancelWhisperDownload();
  else {
    // fetch() inside the worker has no abort hook here; killing the worker stops it.
    worker?.terminate();
    worker = null;
    remote = null;
  }
  set({ kind: 'paused', status: await engine.status(), reason });
}

export async function removeStt(): Promise<void> {
  await engine.remove();
  set({ kind: 'checking' });
  await refresh();
}

/** Load the model ahead of the first transcription (sessions stay warm). */
export function preloadStt(): Promise<void> {
  return engine.load();
}

export function transcribe(audio: Float32Array): Promise<Transcript> {
  return engine.transcribe(audio);
}

/** Decode a recording to 16 kHz mono, the rate Phonon-2 expects. */
export async function toMono16k(blob: Blob): Promise<Float32Array> {
  const ctx = new AudioContext({ sampleRate: 16000 });
  try {
    const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
    if (buf.numberOfChannels === 1) return buf.getChannelData(0).slice();
    const out = new Float32Array(buf.length);
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const ch = buf.getChannelData(c);
      for (let i = 0; i < out.length; i++) out[i] += ch[i] / buf.numberOfChannels;
    }
    return out;
  } finally {
    ctx.close();
  }
}
