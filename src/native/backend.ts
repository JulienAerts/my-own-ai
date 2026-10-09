// The desktop app's native engine: llama.cpp on the PC's GPU — the CUDA build
// on NVIDIA, the Vulkan build on AMD, Intel Arc and others. Used when the GPU
// has enough dedicated memory; otherwise the app keeps WebLLM.
// Rust side: src-tauri/src/llama.rs. Chat requests: ./llama.ts.
import type { ChatCompletionMessageParam } from '@mlc-ai/web-llm';
import { trackDownload } from '../net/netlog';
import type { GenerateOptions, GenerateResult } from '../worker/engine.worker';
import type { ModelInfo } from '../models';
import { isDesktopApp } from '../native';
import { llamaGenerate, type LlamaServer } from './llama';
import { num, t } from '../i18n/i18n';

const MB = 2 ** 20;
const GB = 1e9;

export interface Gpu {
  name: string;
  vramMB: number;
  driver: string;
  vendor: 'nvidia' | 'amd' | 'intel' | 'other';
  /** The CUDA builds run on it (llama.cpp's and Whisper's): an NVIDIA GPU on Windows. */
  cuda: boolean;
  /** The llama.cpp build for it on this system, from the app ("cuda-12.4", "vulkan", "metal"). */
  engine?: string;
}

interface Progress {
  received: number;
  total: number;
  label: string;
}

/** Below this, the desktop app stays on WebLLM (an old laptop, integrated graphics). */
export const MIN_NATIVE_VRAM_MB = 7500;

/**
 * The llama.cpp build for a GPU: CUDA on Windows with NVIDIA (about 650 MB with its runtime),
 * Metal on Apple Silicon, Vulkan otherwise (about 33 MB).
 */
export function engineFor(gpu: Gpu | null): string {
  return gpu?.engine ?? (gpu?.cuda ? 'cuda-12.4' : 'vulkan');
}

interface Gguf {
  /** Hugging Face file URL. */
  url: string;
  file: string;
  bytes: number;
  /** KV cache per token of context at 16-bit, in bytes (attention layers × 2 × KV heads × head size × 2). */
  kvPerToken: number;
  /** Trained context that YaRN stretches beyond (Qwen3: 32k); unset when the model needs no scaling. */
  yarnFrom?: number;
  /** Vision models: the image encoder, a second file ("mmproj"). */
  mmproj?: GgufFile;
  /** Models split in several files: the parts after the first (llama.cpp loads them from the first). */
  parts?: GgufFile[];
}

export interface GgufFile { url: string; file: string; bytes: number }

/** Every file a model needs: weights (and their other parts), then the image encoder. */
export function modelFiles(m: NativeModel): (GgufFile & { label: string })[] {
  const g = m.gguf;
  return [
    { url: g.url, file: g.file, bytes: g.bytes, label: m.displayName },
    ...(g.parts ?? []).map((p, i) => ({ ...p, label: t('{model} (part {n})', { model: m.displayName, n: i + 2 }) })),
    ...(g.mmproj ? [{ ...g.mmproj, label: t('the image encoder') }] : []),
  ];
}

export type NativeModel = ModelInfo & { engine: 'llama'; gguf: Gguf };

const qwen3 = (size: string, params: string, bytes: number, layers: number, kvHeads: number, extra: Partial<ModelInfo> = {}): NativeModel => ({
  family: `Qwen3-${size}-GGUF`,
  fixedId: `gguf:Qwen3-${size}-Q4_K_M`,
  displayName: `Qwen3 ${size} (${t('thinks')})`,
  params,
  downloadMB: Math.round(bytes / MB),
  vramMB: 0, // set from the context size chosen for this GPU (see nativeContext)
  hermes: true,
  reasoning: true,
  tier: 'medium',
  maxTensorBytes: 0,
  // 32k as trained, up to 128k with YaRN (Qwen's recommended way to go longer).
  maxContext: 131072,
  engine: 'llama',
  gguf: {
    url: `https://huggingface.co/Qwen/Qwen3-${size}-GGUF/resolve/main/Qwen3-${size}-Q4_K_M.gguf`,
    file: `Qwen3-${size}-Q4_K_M.gguf`,
    bytes,
    kvPerToken: layers * 2 * kvHeads * 128 * 2,
    yarnFrom: 32768,
  },
  ...extra,
});

/**
 * Qwen3.5 (Unsloth's GGUF) reads images through its mmproj file. Its hybrid
 * attention keeps a KV cache in one layer of four only (4 KV heads of 256), the
 * others hold a small fixed state: long contexts are cheap, up to its trained 256k.
 */
const qwen35 = (size: string, bytes: number, mmprojBytes: number, attentionLayers: number): NativeModel => ({
  ...qwen3(size, size, bytes, attentionLayers, 4, { displayName: `Qwen3.5 ${size} (${t('images')}, ${t('thinks')})`, vision: true, maxContext: 262144 }),
  family: `Qwen3.5-${size}-GGUF`,
  fixedId: `gguf:Qwen3.5-${size}-Q4_K_M`,
  downloadMB: Math.round((bytes + mmprojBytes) / MB),
  gguf: {
    url: `https://huggingface.co/unsloth/Qwen3.5-${size}-GGUF/resolve/main/Qwen3.5-${size}-Q4_K_M.gguf`,
    file: `Qwen3.5-${size}-Q4_K_M.gguf`,
    bytes,
    kvPerToken: attentionLayers * 2 * 4 * 256 * 2,
    mmproj: {
      url: `https://huggingface.co/unsloth/Qwen3.5-${size}-GGUF/resolve/main/mmproj-F16.gguf`,
      file: `Qwen3.5-${size}-mmproj-F16.gguf`,
      bytes: mmprojBytes,
    },
  },
});

/** Qwen3 at 4-bit (Q4_K_M), smallest first, then the Qwen3.5 vision models. */
const NATIVE_MODELS: NativeModel[] = [
  qwen3('8B', '8B', 5_027_783_488, 36, 8),
  qwen3('14B', '14B', 9_001_753_280, 40, 8),
  // Mixture of experts: 30B parameters, 3B used per token, so it answers fast.
  qwen3('30B-A3B', '30B (3B active)', 18_556_686_208, 48, 4),
  qwen3('32B', '32B', 19_762_150_464, 64, 8),
  qwen35('9B', 5_680_000_000, 920_000_000, 8), // 32 layers, 8 with attention
  qwen35('27B', 16_740_000_000, 930_000_000, 16), // 64 layers, 16 with attention
];

export function isNativeModel(m: ModelInfo | undefined): m is NativeModel {
  return !!m && (m as NativeModel).engine === 'llama';
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(cmd, args);
}

async function channel(onProgress: (p: Progress) => void) {
  const { Channel } = await import('@tauri-apps/api/core');
  const ch = new Channel<Progress>();
  ch.onmessage = onProgress;
  return ch;
}

let gpuCache: Gpu | null | undefined;

/** The GPU with the most dedicated memory, of any vendor, or null (none, or not the desktop app). */
export async function bestGpu(): Promise<Gpu | null> {
  if (gpuCache !== undefined) return gpuCache;
  if (!isDesktopApp) return (gpuCache = null);
  const list = await invoke<Gpu[]>('gpu_info').catch(() => []);
  return (gpuCache = list.sort((a, b) => b.vramMB - a.vramMB || Number(b.cuda) - Number(a.cuda))[0] ?? null);
}

/** Memory left for the weights and the context: the display, the driver and llama.cpp's working buffers take ~2 GB. */
const usableMB = (gpu: Gpu) => gpu.vramMB - 2000;

/** KV cache for `ctx` tokens: llama-server keeps it at 8-bit (q8_0: 34 bytes per 32 values, vs 64 at 16-bit). */
export function kvBytes(m: NativeModel, ctx: number): number {
  return (ctx * m.gguf.kvPerToken * 17) / 32;
}

const CONTEXTS = [4096, 8192, 16384, 32768, 65536, 131072, 262144];

/** Context sizes that fit next to the weights on this GPU, largest last. */
export function nativeContexts(m: NativeModel, gpu: Gpu): number[] {
  const room = usableMB(gpu) * MB - totalBytes(m);
  return CONTEXTS.filter((n) => n <= (m.maxContext ?? 32768) && kvBytes(m, n) <= room);
}

/** YaRN's trained context when `ctx` goes beyond it (llama-server then stretches the positions), else null. */
export function yarnFor(m: NativeModel, ctx: number): number | null {
  const from = m.gguf.yarnFrom;
  return from && ctx > from ? from : null;
}

/**
 * Free GPU memory when the driver can't say (no nvidia-smi on AMD or Intel): the card's
 * memory minus the display's ~1 GB and what the loaded chat model takes.
 */
export function estimatedFreeMB(gpu: Gpu, loaded: { model: NativeModel; ctx: number } | null): number {
  const chat = loaded ? (totalBytes(loaded.model) + kvBytes(loaded.model, loaded.ctx)) / MB : 0;
  return Math.max(0, Math.round(gpu.vramMB - 1000 - chat));
}

/** The biggest context that fits (up to 16k by default: longer prompts get slow). */
export function nativeContext(m: NativeModel, gpu: Gpu): number {
  return nativeContexts(m, gpu).filter((n) => n <= 16384).at(-1) ?? 4096;
}

/** The native models this GPU can hold with at least a 4k context, with their memory needs filled in. */
export function nativeModelsFor(gpu: Gpu | null, custom: NativeModel[] = []): NativeModel[] {
  if (!gpu || gpu.vramMB < MIN_NATIVE_VRAM_MB) return [];
  return [...NATIVE_MODELS, ...custom].filter((m) => nativeContexts(m, gpu).length).map((m) => ({
    ...m,
    vramMB: Math.round((totalBytes(m) + kvBytes(m, nativeContext(m, gpu))) / MB),
  }));
}

/**
 * The recommendation: the fast 30B-A3B when it fits, else the biggest dense
 * model that does (32B is smarter but much slower on the same GPU).
 */
export function recommendedNative(list: NativeModel[]): NativeModel | undefined {
  return list.find((m) => m.fixedId === 'gguf:Qwen3-30B-A3B-Q4_K_M') ?? list.at(-1);
}

interface LlamaStatus {
  engine: string | null;
  /** Installed builds ("cuda-12.4", "vulkan"). */
  engines: string[];
  version: string;
  models: { file: string; bytes: number }[];
  running: boolean;
}

export function llamaStatus(): Promise<LlamaStatus> {
  return invoke<LlamaStatus>('llama_status');
}

/** Bytes downloaded for a model (all its files). */
export async function downloadedBytes(m: NativeModel, status?: LlamaStatus | null): Promise<number> {
  const s = status ?? await llamaStatus().catch(() => null);
  return modelFiles(m).reduce((n, f) => n + (s?.models.find((x) => x.file === f.file)?.bytes ?? 0), 0);
}

/**
 * Every file of the model is on disk. A download writes to a ".part" file and takes the final
 * name only once complete, so a present file is a finished one; the byte counts in the model
 * list can be estimates (Qwen3.5) and mustn't decide it.
 */
export function nativeComplete(m: NativeModel, status: { models: { file: string }[] } | null): boolean {
  return !!status && modelFiles(m).every((f) => status.models.some((x) => x.file === f.file));
}

/** Total download for a model (weights, their parts, image encoder). */
export function totalBytes(m: NativeModel): number {
  return m.gguf.bytes + (m.gguf.parts ?? []).reduce((n, p) => n + p.bytes, 0) + (m.gguf.mmproj?.bytes ?? 0);
}

export async function deleteNativeModel(m: NativeModel): Promise<void> {
  if (active?.model.fixedId === m.fixedId) await stopNative();
  for (const f of modelFiles(m)) await invoke('delete_model', { file: f.file });
}

/** Stop a download in progress (the engine or a model); received data is kept. */
export function cancelNativeDownload(m: NativeModel): Promise<void> {
  const ids = [...modelFiles(m).map((f) => f.file), 'engine'];
  return Promise.all(ids.map((id) => invoke('cancel_download', { id }))).then(() => {});
}

/** The Hugging Face token (Settings → Model), for gated models. */
export async function hfToken(): Promise<string | null> {
  const { getSetting } = await import('../db');
  return (await getSetting('hfToken').catch(() => undefined)) || null;
}

export interface StartProgress {
  stage: 'engine' | 'model' | 'load';
  fraction: number;
  text: string;
}

/** Install the engine and download the model if needed, then load it into GPU memory. */
export async function startNative(m: NativeModel, ctx: number, onProgress: (p: StartProgress) => void): Promise<void> {
  await stopNative();
  const pct = (p: Progress) => (p.total ? p.received / p.total : 0);
  const gb = (n: number) => num(n / GB, n < 10 * GB ? 1 : 0);
  const status = await llamaStatus();
  const variant = engineFor(await bestGpu());
  if (!status.engines.includes(variant)) {
    onProgress({ stage: 'engine', fraction: 0, text: t('Downloading the llama.cpp engine…') });
    let got = 0;
    await trackDownload(`https://github.com/ggml-org/llama.cpp/releases/tag/${status.version}`, t('llama.cpp engine ({variant})', { variant }), async () => invoke('install_engine', {
      variant,
      onProgress: await channel((p) => {
        got = p.received;
        onProgress({ stage: 'engine', fraction: pct(p), text: t('Downloading the {what} · {done} of {total} GB', { what: engineLabel(p.label), done: gb(p.received), total: gb(p.total) }) });
      }),
    }), () => got || undefined);
  }
  const token = await hfToken();
  for (const f of modelFiles(m)) {
    if (status.models.some((x) => x.file === f.file)) continue;
    onProgress({ stage: 'model', fraction: 0, text: t('Downloading {model}…', { model: f.label }) });
    let got = 0;
    await trackDownload(f.url, t('Model download: {model}', { model: f.label }), async () => invoke('download_model', {
      url: f.url,
      file: f.file,
      token,
      onProgress: await channel((p) => {
        got = p.received;
        onProgress({ stage: 'model', fraction: pct(p), text: t('Downloading {what} · {done} of {total} GB', { what: f.label, done: gb(p.received), total: gb(p.total || f.bytes) }) });
      }),
    }), () => got || undefined);
  }
  const mmproj = m.gguf.mmproj;
  onProgress({ stage: 'load', fraction: 0, text: t('Loading {model} into GPU memory…', { model: m.displayName }) });
  const api = await localApi();
  const server = await invoke<LlamaServer>('start_llama', {
    file: m.gguf.file, ctx, mmproj: mmproj?.file ?? null,
    port: api.enabled ? api.port : null, key: api.enabled ? api.key : null,
    variant, yarn: yarnFor(m, ctx),
  });
  active = { model: m, ctx, server };
}

// ---------------------------------------------------------------------------
// Local API: other apps on this PC use the loaded model (OpenAI-compatible).

export interface LocalApi { enabled: boolean; port: number; key: string }

export async function localApi(): Promise<LocalApi> {
  const { getSetting, setSetting } = await import('../db');
  const saved = await getSetting('localApi').catch(() => undefined);
  if (saved?.key) return saved;
  const api = { enabled: false, port: 8765, key: `sk-local-${crypto.randomUUID().replace(/-/g, '')}`, ...saved };
  await setSetting('localApi', api);
  return api;
}

export async function setLocalApi(patch: Partial<LocalApi>): Promise<LocalApi> {
  const { setSetting } = await import('../db');
  const api = { ...(await localApi()), ...patch };
  await setSetting('localApi', api);
  return api;
}

export async function stopNative(): Promise<void> {
  active = null;
  controller?.abort();
  if (isDesktopApp) await invoke('stop_llama').catch(() => {});
}

/** The server's last log lines, for an error report. */
export function nativeLog(): Promise<string> {
  return invoke<string>('llama_log').catch(() => '');
}

// ---------------------------------------------------------------------------
// Chat (what engine() uses while a native model is active)

let active: { model: NativeModel; ctx: number; server: LlamaServer } | null = null;
let controller: AbortController | null = null;

export function activeNative(): { model: NativeModel; ctx: number } | null {
  return active;
}

export async function nativeGenerate(messages: ChatCompletionMessageParam[], opts: GenerateOptions, onDelta: (t: string) => void): Promise<GenerateResult> {
  if (!active) throw new Error('llama-server is not running.');
  const { fetch } = await import('@tauri-apps/plugin-http');
  controller = new AbortController();
  try {
    return await llamaGenerate(fetch as typeof globalThis.fetch, active.server, messages, opts, onDelta, controller.signal);
  } catch (e) {
    // A crash (out of GPU memory, a driver reset) ends the server: say so with its log.
    const status = await llamaStatus().catch(() => null);
    if (status && !status.running) {
      active = null;
      throw new Error(`llama-server stopped: ${(await nativeLog()).split('\n').slice(-3).join(' ')}`);
    }
    throw e;
  } finally {
    controller = null;
  }
}

export function nativeInterrupt(): void {
  controller?.abort();
}

/** The Rust side names what it downloads in English ("llama.cpp engine", "CUDA runtime"). */
function engineLabel(label: string): string {
  return label === 'CUDA runtime' ? t('CUDA runtime') : label === 'llama.cpp engine' ? t('llama.cpp engine') : label;
}
