// Model catalog kept separate from @mlc-ai/web-llm so the main bundle never
// pulls in the inference runtime. IDs must exist in web-llm's prebuiltAppConfig.
// Sizes are the summed tensor-cache.json shard bytes from huggingface.co/mlc-ai
// (weights only; the WASM model lib adds a few MB).
import { num, t, UNIT } from './i18n/i18n';

export type Tier = 'unsupported' | 'tiny' | 'small' | 'medium';

export const TIER_ORDER: Tier[] = ['unsupported', 'tiny', 'small', 'medium'];

export const TIER_LABEL: Record<Tier, string> = {
  unsupported: 'Unsupported',
  tiny: 'Tiny',
  small: 'Small',
  medium: 'Medium',
};

export interface ModelInfo {
  /** Base id without the quantization suffix, e.g. "Hermes-3-Llama-3.2-3B" */
  family: string;
  displayName: string;
  params: string;
  downloadMB: number;
  /** Approx. VRAM from web-llm's model_list (q4f16_1 variant) */
  vramMB: number;
  /** Uses the Hermes <tool_call> format */
  hermes: boolean;
  tier: Tier;
  /**
   * Largest single weight tensor (bytes, from tensor-cache.json; same for f16/f32).
   * It must fit the GPU's maxStorageBufferBindingSize: many phones allow only
   * 128 MiB, and an oversized binding is a silent WebGPU validation error that
   * makes the model emit random tokens.
   */
  maxTensorBytes: number;
  /** Accepts images (Phi-3.5 vision). */
  vision?: boolean;
  /**
   * Thinks before answering (Qwen3): writes its reasoning in <think>…</think>,
   * which the app shows folded. Thinking can be turned off per message.
   */
  reasoning?: boolean;
  /** Longest context the model was trained for (tokens); caps the context-size setting. */
  maxContext?: number;
  /**
   * Largest working (activation) buffer while answering, when it's larger than
   * any weight tensor. Model libraries reserve it for a full prefill chunk
   * whatever the prompt length: Phi-3.5 vision's library is compiled with
   * 2048-token chunks (`_cs2k`), 2,048 × 72 KiB = 144 MiB. Text models' `_cs1k`
   * libraries need half that, under every limit seen so far.
   */
  workspaceBytes?: number;
  /**
   * Set for models the user added (from WebLLM's catalog or a link): their exact
   * WebLLM model id, instead of family + quantization.
   */
  fixedId?: string;
  /** Where an added model came from; absent for the curated models above. */
  source?: 'catalog' | 'custom';
  /** Custom models: Hugging Face repo and compiled library. */
  url?: string;
  lib?: string;
  contextWindow?: number;
}

const MODELS = {
  bench: {
    family: 'SmolLM2-360M-Instruct',
    maxContext: 8192,
    displayName: 'SmolLM2 360M Instruct',
    params: '360M',
    downloadMB: 194,
    vramMB: 376,
    hermes: false,
    tier: 'tiny',
    maxTensorBytes: 23_592_960,
  },
  tinyIOS: {
    family: 'Qwen2.5-0.5B-Instruct',
    maxContext: 32768,
    displayName: 'Qwen2.5 0.5B Instruct',
    params: '0.5B',
    downloadMB: 265,
    vramMB: 945,
    hermes: false,
    tier: 'tiny',
    maxTensorBytes: 68_067_328,
  },
  llama1b: {
    family: 'Llama-3.2-1B-Instruct',
    maxContext: 131072,
    displayName: 'Llama 3.2 1B Instruct',
    params: '1B',
    downloadMB: 663,
    vramMB: 879,
    hermes: false,
    tier: 'tiny',
    maxTensorBytes: 131_334_144,
  },
  tiny: {
    family: 'Qwen2.5-1.5B-Instruct',
    maxContext: 32768,
    displayName: 'Qwen2.5 1.5B Instruct',
    params: '1.5B',
    downloadMB: 828,
    vramMB: 1630,
    hermes: false,
    tier: 'tiny',
    maxTensorBytes: 116_686_848,
  },
  small: {
    family: 'Hermes-3-Llama-3.2-3B',
    maxContext: 131072,
    displayName: 'Hermes 3 (Llama 3.2 3B)',
    params: '3B',
    downloadMB: 1723,
    vramMB: 2264,
    hermes: true,
    tier: 'small',
    maxTensorBytes: 197_001_216,
  },
  vision: {
    family: 'Phi-3.5-vision-instruct',
    maxContext: 131072,
    displayName: `Phi-3.5 vision (${t('images')})`,
    params: '4.2B',
    downloadMB: 2641,
    vramMB: 3952,
    hermes: false,
    tier: 'small',
    maxTensorBytes: 49_250_304,
    workspaceBytes: 150_994_944, // measured on a OnePlus 13R (128 MiB limit)
    vision: true,
  },
  qwen3Tiny: {
    family: 'Qwen3-0.6B',
    maxContext: 40960,
    displayName: `Qwen3 0.6B (${t('thinks')})`,
    params: '0.6B',
    downloadMB: 320,
    vramMB: 1403,
    hermes: true,
    reasoning: true,
    tier: 'tiny',
    maxTensorBytes: 77_791_232,
  },
  qwen3Small: {
    family: 'Qwen3-1.7B',
    maxContext: 40960,
    displayName: `Qwen3 1.7B (${t('thinks')})`,
    params: '1.7B',
    downloadMB: 923,
    vramMB: 2037,
    hermes: true,
    reasoning: true,
    tier: 'tiny',
    maxTensorBytes: 155_582_464,
  },
  qwen3Mid: {
    family: 'Qwen3-4B',
    maxContext: 40960,
    displayName: `Qwen3 4B (${t('thinks')})`,
    params: '4B',
    downloadMB: 2158,
    vramMB: 3432,
    hermes: true,
    reasoning: true,
    tier: 'small',
    maxTensorBytes: 194_478_080,
  },
  qwen3Large: {
    family: 'Qwen3-8B',
    maxContext: 40960,
    displayName: `Qwen3 8B (${t('thinks')})`,
    params: '8B',
    downloadMB: 4394,
    vramMB: 5696,
    hermes: true,
    reasoning: true,
    tier: 'medium',
    maxTensorBytes: 311_164_928,
  },
  phi35: {
    family: 'Phi-3.5-mini-instruct',
    maxContext: 131072,
    displayName: 'Phi-3.5 mini (3.8B)',
    params: '3.8B',
    downloadMB: 2050,
    vramMB: 3672,
    hermes: false,
    tier: 'small',
    maxTensorBytes: 49_250_304,
  },
  medium: {
    family: 'Hermes-3-Llama-3.1-8B',
    maxContext: 131072,
    displayName: 'Hermes 3 (Llama 3.1 8B)',
    params: '8B',
    downloadMB: 4308,
    vramMB: 4876,
    hermes: true,
    tier: 'medium',
    maxTensorBytes: 262_668_288,
  },
} satisfies Record<string, ModelInfo>;

export const BENCH_MODEL: ModelInfo = MODELS.bench;

export const ALL_MODELS: ModelInfo[] = Object.values(MODELS);

/** Chat models offered in settings, smallest first (tier defaults plus alternatives). */
export function chatModels(isIOS: boolean): ModelInfo[] {
  return isIOS
    ? [MODELS.tinyIOS, MODELS.qwen3Tiny, MODELS.llama1b, MODELS.tiny, MODELS.qwen3Small]
    : [MODELS.tinyIOS, MODELS.qwen3Tiny, MODELS.llama1b, MODELS.tiny, MODELS.qwen3Small, MODELS.small,
      MODELS.qwen3Mid, MODELS.phi35, MODELS.vision, MODELS.medium, MODELS.qwen3Large];
}

/** The biggest single GPU buffer the model binds: its largest tensor or its working buffer. */
export function largestBinding(m: ModelInfo): number {
  return Math.max(m.maxTensorBytes, m.workspaceBytes ?? 0);
}

/**
 * Share of the reported binding limit a model may use. On a OnePlus 13R
 * (Adreno 750, 128 MiB limit), tensors of 49 and 68 MB work, but Qwen2.5 1.5B
 * (117 MB) and Llama 3.2 1B (131 MB) emit random tokens though they're under
 * the limit. Desktop limits (1–4 GiB) are far above any model's tensors.
 */
const SAFE_BINDING_SHARE = 0.75;

/** The largest buffer a model may bind on this GPU, with the safety margin. */
export function safeBinding(maxStorageBufferBindingSize: number): number {
  return Math.floor(maxStorageBufferBindingSize * SAFE_BINDING_SHARE);
}

export function fitsBinding(m: ModelInfo, maxStorageBufferBindingSize?: number): boolean {
  return maxStorageBufferBindingSize == null || largestBinding(m) <= safeBinding(maxStorageBufferBindingSize);
}

/**
 * Working-buffer estimate for models we haven't measured: prefill chunk (from
 * the library name, `_cs1k` / `_cs2k`) × 24 bytes × hidden size. Calibrated on
 * Phi-3 (hidden 3072 → 72 KiB per token); other architectures are a guess.
 */
export function estimateWorkspace(lib: string, hiddenSize?: number): number | undefined {
  const m = /_cs(\d+)k/i.exec(lib);
  if (!m || !hiddenSize) return undefined;
  return Number(m[1]) * 1024 * 24 * hiddenSize;
}

// Models the user added (Settings → Model → More models), loaded from settings at boot.
let extras: ModelInfo[] = [];

export function setExtraModels(list: ModelInfo[]): void {
  extras = list;
}

export function extraModels(): ModelInfo[] {
  return extras;
}

/** Every concrete model id the app might have cached (both quantizations, plus added models). */
export function allModelIds(): string[] {
  return [...ALL_MODELS.flatMap((m) => [modelId(m, true), modelId(m, false)]), ...extras.map((m) => m.fixedId!)];
}

/** Desktop app: GGUF models for llama.cpp that fit this GPU (see native/backend.ts). */
let natives: ModelInfo[] = [];

export function setNativeModels(list: ModelInfo[]): void {
  natives = list;
}

export function nativeModels(): ModelInfo[] {
  return natives;
}

export function modelById(id: string): ModelInfo | undefined {
  return ALL_MODELS.find((m) => id === modelId(m, true) || id === modelId(m, false))
    ?? extras.find((m) => m.fixedId === id)
    ?? natives.find((m) => m.fixedId === id);
}

/** Pick the f16 build when the GPU supports shader-f16, else the f32 fallback (added models: their own id). */
export function modelId(m: ModelInfo, shaderF16: boolean): string {
  return m.fixedId ?? `${m.family}-${shaderF16 ? 'q4f16_1' : 'q4f32_1'}-MLC`;
}

/** Tier from GPU memory, for models we know nothing else about. */
export function tierForVram(vramMB: number): Tier {
  return vramMB < 1800 ? 'tiny' : vramMB < 3500 ? 'small' : 'medium';
}

/** A readable name from a WebLLM model id, e.g. "gemma-2-2b-it-q4f16_1-MLC" → "gemma 2 2b it". */
export function nameFromId(id: string): string {
  return id.replace(/-MLC(-1k)?$/i, '').replace(/-q\d+f\d+(_\d+)?$/i, '').replace(/[-_]/g, ' ');
}

export function modelForTier(tier: Tier, isIOS: boolean): ModelInfo | null {
  switch (tier) {
    case 'unsupported':
      return null;
    case 'tiny':
      // iOS Safari kills tabs well below 1.5 GB of GPU memory; use the 0.5B model.
      return isIOS ? MODELS.tinyIOS : MODELS.tiny;
    case 'small':
      return MODELS.small;
    case 'medium':
      return MODELS.medium;
  }
}

export function formatMB(mb: number): string {
  return mb >= 1000 ? `${num(mb / 1024, 1)} ${UNIT.GB}` : `${Math.round(mb)} ${UNIT.MB}`;
}
