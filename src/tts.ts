// Read answers aloud. Two engines:
//  - "device": the browser's speechSynthesis, restricted to voices that run on
//    the device (Chrome's "Google …" voices are online and send the text away).
//  - a Piper voice id: neural TTS in tts.worker.ts on the CPU, played through
//    Web Audio. The next sentence is synthesized while the current one plays.
import { useEffect, useState } from 'preact/hooks';
import * as Comlink from 'comlink';
import type { TtsApi } from './worker/tts.worker';
import { PIPER_VOICES } from './ttsVoices';
import { getSetting, setSetting } from './db';
import { lang } from './i18n/i18n';

export interface TtsState {
  /** "device" or a Piper voice id. */
  voice: string;
  /** Device voice to use (voiceURI); empty = the best local English voice. */
  deviceVoice: string;
  auto: boolean;
  rate: number;
  installed: string[];
  download: { id: string; got: number; total: number } | null;
  downloadError: string | null;
  /** Key of the message being read, or null. */
  speaking: string | null;
}

let state: TtsState = { voice: 'device', deviceVoice: '', auto: false, rate: 1, installed: [], download: null, downloadError: null, speaking: null };
const subs = new Set<(s: TtsState) => void>();
let init: Promise<void> | null = null;

function set(patch: Partial<TtsState>) {
  state = { ...state, ...patch };
  subs.forEach((fn) => fn(state));
}

let worker: Worker | null = null;
let remote: Comlink.Remote<TtsApi> | null = null;
function tts(): Comlink.Remote<TtsApi> {
  if (!remote) {
    worker = new Worker(new URL('./worker/tts.worker.ts', import.meta.url), { type: 'module', name: 'Voices' });
    remote = Comlink.wrap<TtsApi>(worker);
  }
  return remote;
}

async function refreshInstalled(): Promise<void> {
  // Check the cache directly so listing voices doesn't spin up the worker.
  const cache = await caches.open('piper-voices-v1').catch(() => null);
  if (!cache) return;
  const keys = new Set((await cache.keys()).map((r) => r.url));
  set({ installed: PIPER_VOICES.filter((v) => [...keys].some((k) => k.endsWith(`${v.path}.onnx.json`))).map((v) => v.id) });
}

function ensureInit(): Promise<void> {
  init ??= (async () => {
    const [voice, deviceVoice, auto, rate] = await Promise.all([
      getSetting('ttsVoice'), getSetting('ttsDeviceVoice'), getSetting('ttsAuto'), getSetting('ttsRate'),
    ]);
    set({ voice: voice ?? 'device', deviceVoice: deviceVoice ?? '', auto: !!auto, rate: rate ?? 1 });
    await refreshInstalled();
    // A selected Piper voice that's gone (deleted, storage cleared) falls back to the device voice.
    if (state.voice !== 'device' && !state.installed.includes(state.voice)) set({ voice: 'device' });
  })();
  return init;
}

export function useTts(): TtsState {
  const [s, setS] = useState(state);
  useEffect(() => {
    subs.add(setS);
    setS(state);
    ensureInit();
    return () => void subs.delete(setS);
  }, []);
  return s;
}

export async function setTtsPrefs(p: Partial<Pick<TtsState, 'voice' | 'deviceVoice' | 'auto' | 'rate'>>): Promise<void> {
  set(p);
  await Promise.all([
    p.voice !== undefined && setSetting('ttsVoice', p.voice),
    p.deviceVoice !== undefined && setSetting('ttsDeviceVoice', p.deviceVoice),
    p.auto !== undefined && setSetting('ttsAuto', p.auto),
    p.rate !== undefined && setSetting('ttsRate', p.rate),
  ]);
}

export async function downloadVoice(id: string): Promise<void> {
  if (state.download) return;
  set({ download: { id, got: 0, total: PIPER_VOICES.find((v) => v.id === id)?.bytes ?? 1 }, downloadError: null });
  await navigator.storage?.persist?.().catch(() => false);
  try {
    await tts().install(id, Comlink.proxy((got: number, total: number) => {
      if (state.download?.id === id) set({ download: { id, got, total } });
    }));
    await refreshInstalled();
    await setTtsPrefs({ voice: id });
  } catch (e) {
    set({ downloadError: e instanceof Error ? e.message : String(e) });
  } finally {
    set({ download: null });
  }
}

export async function deleteVoice(id: string): Promise<void> {
  if (state.speaking) stopSpeaking();
  await tts().remove(id);
  await refreshInstalled();
  if (state.voice === id) await setTtsPrefs({ voice: 'device' });
}

// ---------------------------------------------------------------------------
// Device voices

export function deviceVoices(): SpeechSynthesisVoice[] {
  if (typeof speechSynthesis === 'undefined') return [];
  // English, plus the interface language's own voices (French answers read by a French voice).
  const langs = new Set(['en', lang]);
  return speechSynthesis.getVoices().filter((v) => v.localService && langs.has(v.lang.toLowerCase().split(/[-_]/)[0]));
}

/** Voices load asynchronously in Chrome; re-render when they arrive. */
export function useDeviceVoices(): SpeechSynthesisVoice[] {
  const [voices, setVoices] = useState(deviceVoices);
  useEffect(() => {
    if (typeof speechSynthesis === 'undefined') return;
    const fn = () => setVoices(deviceVoices());
    speechSynthesis.addEventListener('voiceschanged', fn);
    fn();
    return () => speechSynthesis.removeEventListener('voiceschanged', fn);
  }, []);
  return voices;
}

function pickDeviceVoice(uri = state.deviceVoice): SpeechSynthesisVoice | undefined {
  const vs = deviceVoices();
  const own = (v: SpeechSynthesisVoice) => v.lang.toLowerCase().startsWith(lang);
  return vs.find((v) => v.voiceURI === uri) ?? vs.find((v) => v.default && own(v)) ?? vs.find(own) ?? vs.find((v) => v.default) ?? vs.find((v) => /en-US/i.test(v.lang)) ?? vs[0];
}

// ---------------------------------------------------------------------------
// Speaking

/** Markdown and other things not worth reading aloud. */
export function speakable(md: string): string {
  return md
    .replace(/```[\s\S]*?(```|$)/g, ' (code omitted) ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*([-*+]|\d+[.)])\s+/gm, '')
    .replace(/(\*\*|__|\*|_)(\S[^*_]*?)\1/g, '$2')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/** Complete sentences of `text`; the last piece is complete only when `final`. */
function sentences(text: string, final: boolean): string[] {
  const parts = speakable(text).split(/(?<=[.!?…])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
  return final ? parts : parts.slice(0, -1);
}

let ctx: AudioContext | null = null;
/** Call from a click/tap: browsers only start audio after a user gesture. */
export function unlockAudio(): void {
  ctx ??= new AudioContext();
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  // Safari also needs speechSynthesis touched inside a gesture.
  if (typeof speechSynthesis !== 'undefined') speechSynthesis.resume();
}

let run = 0;
let sources: AudioBufferSourceNode[] = [];

export function stopSpeaking(): void {
  run++;
  if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
  for (const s of sources) {
    try { s.stop(); } catch { /* already ended */ }
  }
  sources = [];
  if (state.speaking) set({ speaking: null });
}

export interface SpeechStream {
  /** The reply so far; complete sentences are queued as they appear. */
  push(text: string): void;
  /** The final reply; the remainder is queued and playback ends after it. `key` names the saved message. */
  end(text: string, key?: string): void;
}

/** Start reading a reply that may still be streaming. `with` overrides the voice (previews). */
export function startSpeaking(key: string, using?: { voice: string; deviceVoice?: string }): SpeechStream {
  stopSpeaking();
  const token = ++run;
  const voice = using?.voice ?? state.voice;
  const deviceUri = using?.deviceVoice ?? state.deviceVoice;
  const rate = state.rate;
  set({ speaking: key });
  let queued = 0;
  let ended = false;
  let pending = 0; // sentences queued but not finished playing
  const finish = () => {
    if (token === run && ended && pending === 0) set({ speaking: null });
  };

  // Piper: synthesize in order, schedule back to back on the audio clock.
  let chain: Promise<void> = Promise.resolve();
  let at = 0;
  const playPiper = (sentence: string) => {
    pending++;
    chain = chain.then(async () => {
      if (token !== run) return;
      try {
        const { audio, sampleRate } = await tts().synth(voice, sentence, rate);
        if (token !== run || !ctx) return;
        const buf = ctx.createBuffer(1, audio.length, sampleRate);
        buf.copyToChannel(audio as Float32Array<ArrayBuffer>, 0);
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(ctx.destination);
        at = Math.max(at, ctx.currentTime + 0.05);
        src.start(at);
        at += buf.duration;
        sources.push(src);
        src.onended = () => {
          sources = sources.filter((s) => s !== src);
          pending--;
          finish();
        };
      } catch (e) {
        console.warn('Piper synthesis failed', e);
        pending--;
        finish();
      }
    });
  };

  const playDevice = (sentence: string) => {
    const u = new SpeechSynthesisUtterance(sentence);
    const v = pickDeviceVoice(deviceUri);
    if (v) { u.voice = v; u.lang = v.lang; } else u.lang = 'en-US';
    u.rate = rate;
    pending++;
    u.onend = u.onerror = () => { pending--; finish(); };
    speechSynthesis.speak(u);
  };

  const enqueue = (all: string[]) => {
    if (token !== run) return;
    for (const s of all.slice(queued)) {
      if (voice === 'device') {
        if (typeof speechSynthesis !== 'undefined') playDevice(s);
      } else playPiper(s);
    }
    queued = Math.max(queued, all.length);
  };

  if (voice !== 'device') {
    ctx ??= new AudioContext();
    ctx.resume().catch(() => {});
  }
  return {
    push: (text) => enqueue(sentences(text, false)),
    end: (text, newKey) => {
      if (newKey && token === run && state.speaking) set({ speaking: newKey });
      enqueue(sentences(text, true));
      ended = true;
      finish();
    },
  };
}

/** Read a finished text; calling it again for the same key stops. */
export function speakText(key: string, text: string, using?: { voice: string; deviceVoice?: string }): void {
  if (state.speaking === key) return stopSpeaking();
  unlockAudio();
  startSpeaking(key, using).end(text);
}

/** Resolves once nothing is being read aloud. */
export function whenSilent(): Promise<void> {
  if (!state.speaking) return Promise.resolve();
  return new Promise((resolve) => {
    const fn = (s: TtsState) => {
      if (s.speaking) return;
      subs.delete(fn);
      resolve();
    };
    subs.add(fn);
  });
}

/** Whether any offline voice can read answers (a downloaded Piper voice, or a local device voice). */
export async function canSpeak(): Promise<boolean> {
  await ensureInit();
  return state.installed.length > 0 || deviceVoices().length > 0;
}
