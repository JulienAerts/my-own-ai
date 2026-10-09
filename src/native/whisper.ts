// Dictation on the desktop with an NVIDIA GPU (CUDA): Whisper large-v3-turbo through
// whisper.cpp (src-tauri/src/whisper.rs). Multilingual (the language is
// detected), and fast on CUDA. Elsewhere the app keeps Phonon-2 (English).
import { desktopOS } from '../native';
import { trackDownload } from '../net/netlog';
import { bestGpu, llamaStatus } from './backend';
import { t } from '../i18n/i18n';

const ENGINE_BYTES = 684_913_404;
const MODEL = {
  url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin',
  file: 'ggml-large-v3-turbo-q5_0.bin',
  bytes: 574_041_195,
};
export const WHISPER_BYTES = ENGINE_BYTES + MODEL.bytes;

async function invoke<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(cmd, args);
}

let available: Promise<boolean> | null = null;

/**
 * Whisper on this machine: the desktop app with a CUDA-capable NVIDIA GPU (4 GB or
 * more). whisper.cpp has no Vulkan build for Windows, so AMD and Intel keep Phonon-2.
 */
export function whisperAvailable(): Promise<boolean> {
  available ??= desktopOS === 'windows' ? bestGpu().then((g) => !!g && g.cuda && g.vramMB >= 4000) : Promise.resolve(false);
  return available;
}

export async function whisperStatus(): Promise<{ totalBytes: number; cachedBytes: number; complete: boolean }> {
  const [engine, status] = await Promise.all([invoke<boolean>('whisper_installed').catch(() => false), llamaStatus().catch(() => null)]);
  const model = status?.models.find((f) => f.file === MODEL.file)?.bytes ?? 0;
  const cachedBytes = (engine ? ENGINE_BYTES : 0) + Math.min(model, MODEL.bytes);
  return { totalBytes: WHISPER_BYTES, cachedBytes, complete: engine && model >= MODEL.bytes };
}

/** Download the engine (CUDA build) and the model, with progress over both. */
export async function installWhisper(onProgress: (got: number, total: number) => void): Promise<void> {
  const { Channel } = await import('@tauri-apps/api/core');
  let got = 0;
  const progress = (base: number) => {
    got = 0;
    const ch = new Channel<{ received: number }>();
    ch.onmessage = (p) => {
      got = p.received;
      onProgress(base + p.received, WHISPER_BYTES);
    };
    return ch;
  };
  const size = () => got || undefined;
  if (!(await invoke<boolean>('whisper_installed'))) {
    await trackDownload('https://github.com/ggml-org/whisper.cpp/releases', t('Speech engine (Whisper)'), () => invoke('install_whisper', { onProgress: progress(0) }), size);
  }
  await trackDownload(MODEL.url, t('Speech model (Whisper)'), () => invoke('download_model', { url: MODEL.url, file: MODEL.file, onProgress: progress(ENGINE_BYTES) }), size);
}

export function cancelWhisperDownload(): Promise<void> {
  return Promise.all([invoke('cancel_download', { id: 'whisper' }), invoke('cancel_download', { id: MODEL.file })]).then(() => {});
}

export async function removeWhisper(): Promise<void> {
  await invoke('remove_whisper');
  await invoke('delete_model', { file: MODEL.file });
  port = null;
}

let port: Promise<number> | null = null;

/** Start the server (model loaded once, kept while the app is open). */
export function loadWhisper(): Promise<number> {
  port ??= invoke<number>('start_whisper', { file: MODEL.file });
  port.catch(() => { port = null; });
  return port;
}

/** 16-bit PCM WAV from 16 kHz mono samples (what whisper-server reads without ffmpeg). */
export function wav(samples: Float32Array): ArrayBuffer {
  const out = new DataView(new ArrayBuffer(44 + samples.length * 2));
  const str = (o: number, s: string) => [...s].forEach((c, i) => out.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF'); out.setUint32(4, 36 + samples.length * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, 1, true);
  out.setUint32(24, 16000, true); out.setUint32(28, 32000, true); out.setUint16(32, 2, true); out.setUint16(34, 16, true);
  str(36, 'data'); out.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) out.setInt16(44 + i * 2, Math.max(-1, Math.min(1, samples[i])) * 0x7fff, true);
  return out.buffer as ArrayBuffer;
}

export async function transcribeWhisper(audio: Float32Array): Promise<{ text: string; secs: number }> {
  const t0 = performance.now();
  const p = await loadWhisper();
  const { fetch } = await import('@tauri-apps/plugin-http');
  const form = new FormData();
  form.append('file', new Blob([wav(audio)], { type: 'audio/wav' }), 'speech.wav');
  form.append('response_format', 'json');
  form.append('temperature', '0.0');
  const res = await fetch(`http://127.0.0.1:${p}/inference`, { method: 'POST', body: form });
  if (!res.ok) throw new Error(`whisper-server: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as { text?: string; error?: string };
  if (json.error) throw new Error(`whisper-server: ${json.error}`);
  // Whisper marks silence and noise with [BLANK_AUDIO], (music) and the like.
  const text = (json.text ?? '').replace(/\[[A-Z_ ]+\]|\((?:music|silence|applause)\)/gi, '').replace(/\s+/g, ' ').trim();
  return { text, secs: (performance.now() - t0) / 1000 };
}
