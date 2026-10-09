// All WebLLM code lives here so inference never blocks the UI thread and the
// runtime (~6 MB) is only fetched when a worker is actually started.
import '../net/install'; // first: records this worker's network activity
import * as Comlink from 'comlink';
import {
  MLCEngine, hasModelInCache, deleteModelAllInfoInCache, prebuiltAppConfig, ModelType,
  type AppConfig, type ModelRecord,
  type ChatCompletionMessageParam, type InitProgressReport, type ResponseFormat,
} from '@mlc-ai/web-llm';
import type { BenchResult } from '../probe/tiers';
import { isGpuFailure } from './errors';

export type ProgressFn = (p: InitProgressReport) => void;

// web-llm always requests powerPreference "high-performance". Some Android
// builds return null for that but succeed with a plain request, so retry.
if (navigator.gpu) {
  const requestAdapter = navigator.gpu.requestAdapter.bind(navigator.gpu);
  navigator.gpu.requestAdapter = async (opts) => (await requestAdapter(opts)) ?? (opts ? requestAdapter() : null);
}

// WebGPU validation errors don't throw: the invalid work is skipped and the
// model silently computes garbage. Record them (and the limits web-llm asked
// for) so the UI can show what actually went wrong on a device.
export interface GpuDiagnostics {
  errors: string[];
  limits: string[];
}
const diag: GpuDiagnostics = { errors: [], limits: [] };
function note(list: string[], msg: string) {
  if (list.length < 12 && !list.includes(msg)) list.push(msg);
}
if (typeof GPUAdapter !== 'undefined') {
  const requestDevice = GPUAdapter.prototype.requestDevice;
  GPUAdapter.prototype.requestDevice = async function (this: GPUAdapter, desc?: GPUDeviceDescriptor) {
    const device = await requestDevice.call(this, desc);
    for (const k of ['maxStorageBufferBindingSize', 'maxBufferSize', 'maxComputeWorkgroupStorageSize', 'maxComputeInvocationsPerWorkgroup'] as const) {
      const asked = desc?.requiredLimits?.[k];
      note(diag.limits, `${k}: device ${device.limits[k]}, adapter ${this.limits[k]}${asked != null ? `, requested ${asked}` : ''}`);
    }
    device.addEventListener('uncapturederror', (e) => note(diag.errors, (e as GPUUncapturedErrorEvent).error.message.slice(0, 400)));
    device.lost.then((info) => note(diag.errors, `Device lost (${info.reason}): ${info.message}`));
    return device;
  };
}

// Android GPU watchdog. Since web-llm 0.2.83 the runtime batches every compute
// dispatch of a step into one command buffer and submits it at the next sync.
// On Android (Adreno) a long prefill batch trips the driver's watchdog, the
// device is lost, and the logits readback fails with "mapAsync … Buffer was
// unmapped before mapping was resolved". The runtime reads `debugLogFinish`
// right after ending each compute pass, so on Android that read submits the
// work so far. It returns false, which skips the debug path's per-shader logging.
// The runtime's WebGPU context class isn't exported, so the hook goes on
// Object.prototype; nothing else in this worker reads that property name.
// See github.com/mlc-ai/web-llm/issues/497.
const ANDROID = /Android/i.test(navigator.userAgent);
if (ANDROID) {
  Object.defineProperty(Object.prototype, 'debugLogFinish', {
    configurable: true,
    get(this: { flushCommands?: () => void }) {
      this.flushCommands?.();
      return false;
    },
    set() {},
  });
}
// 2048 tokens on Android, for every model, the vision one included. Besides
// leaving GPU memory headroom, it bounds the prefill: Phi-3's per-token
// activation buffer is 72 KiB, so a full 2048-token prefill chunk needs a
// 144 MiB binding, over the 128 MiB that phones like the OnePlus 13R allow
// (seen as "Binding size (150994944) … is larger than … (134217728)", then an
// empty answer). With 2048 tokens and a 512-token answer, a prompt is at most
// 1,536 tokens (~108 MiB), which fits; a phone-sized image is 1,357 of them.
const chatOpts = (contextWindow?: number) => (ANDROID ? { context_window_size: 2048 } : contextWindow ? { context_window_size: contextWindow } : undefined);

/** The context size each model was last loaded with (switching back after a vision answer reuses it). */
const contextOf = new Map<string, number | undefined>();
let loadedContext: number | undefined;

export interface CacheStatus {
  modelId: string;
  totalShards: number;
  cachedShards: number;
  totalBytes: number;
  cachedBytes: number;
  complete: boolean;
}

export interface InstallResult {
  /** All weight shards are in the cache */
  downloaded: boolean;
  /** Set if the weights downloaded but the model failed to initialize on the GPU */
  gpuError?: string;
}

export interface GenerateOptions {
  responseFormat?: ResponseFormat;
  maxTokens: number;
  temperature: number;
  /** Nucleus sampling; unset = the model's default. */
  topP?: number;
  /**
   * Reasoning models (Qwen3) only: false skips the <think> phase (WebLLM then
   * starts the answer with an empty think block). Leave unset for other
   * models: WebLLM would add the empty block to any model's answer.
   */
  thinking?: boolean;
}

export interface GenerateResult {
  text: string;
  /** "stop" = grammar/EOS completed; "length" = hit maxTokens; "abort" = interrupted */
  finishReason: string;
  decodeTps?: number;
  /** Tokens in the prompt and the answer: how full the context window was. */
  promptTokens?: number;
  completionTokens?: number;
}

// Must match web-llm's Cache API scope for weights (see hasModelInCache).
const MODEL_CACHE = 'webllm/model';

let engine: MLCEngine | null = null;

// WebLLM's prebuilt models plus any the user added by link (see setCustomModels).
let appConfig: AppConfig = prebuiltAppConfig;

/** A model the user added from a Hugging Face link (MLC format). */
export interface CustomModelRecord {
  id: string;
  /** Hugging Face repo URL with the MLC weights. */
  url: string;
  /** Compiled model library (.wasm). */
  lib: string;
  vramMB?: number;
  contextWindow?: number;
  vision?: boolean;
  needsF16?: boolean;
}

export interface CatalogEntry {
  id: string;
  url: string;
  /** Compiled library; its name tells the prefill chunk size (`_cs1k`, `_cs2k`). */
  lib: string;
  vramMB?: number;
  lowResource?: boolean;
  vision: boolean;
  needsF16: boolean;
  contextWindow?: number;
}

/** What a model repo says about itself, from mlc-chat-config.json and tensor-cache.json. */
export interface RepoInfo {
  url: string;
  modelType: string;
  quantization: string;
  contextWindow?: number;
  sizeBytes: number;
  maxTensorBytes: number;
  vision: boolean;
  /** Architecture fingerprint: model_type, quantization and numeric model_config fields. */
  signature: Record<string, string | number>;
}

function repoBase(url: string): string {
  // Accept https://huggingface.co/org/repo, …/tree/main, …/resolve/main/, or "org/repo".
  let u = url.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//.test(u)) u = `https://huggingface.co/${u}`;
  u = u.replace(/\/(tree|blob)\/[^/]+.*$/, '');
  if (!u.includes('/resolve/')) u += '/resolve/main';
  return `${u.replace(/\/+$/, '')}/`;
}

async function inspectRepo(url: string): Promise<RepoInfo> {
  const base = repoBase(url);
  const get = async (name: string) => {
    let res: Response;
    try {
      res = await fetch(base + name);
    } catch {
      throw new Error(`Couldn't reach ${new URL(base).host}.`);
    }
    if (!res.ok) throw new Error(res.status === 404 ? `${name} not found: is this a WebLLM / MLC-format model repo?` : `HTTP ${res.status} for ${name}`);
    return res.json();
  };
  const [cfg, cache] = await Promise.all([get('mlc-chat-config.json'), get('tensor-cache.json')]);
  let sizeBytes = 0, maxTensorBytes = 0;
  for (const shard of cache.records ?? []) {
    sizeBytes += shard.nbytes;
    for (const r of shard.records ?? []) maxTensorBytes = Math.max(maxTensorBytes, r.nbytes);
  }
  const mc = cfg.model_config ?? {};
  const signature: Record<string, string | number> = { model_type: cfg.model_type, quantization: cfg.quantization };
  for (const [k, v] of Object.entries(mc)) if (typeof v === 'number' && !/window|chunk|max_position|batch/i.test(k)) signature[k] = v;
  return {
    url: base.replace(/\/resolve\/main\/$/, ''),
    modelType: String(cfg.model_type ?? 'unknown'),
    quantization: String(cfg.quantization ?? 'unknown'),
    contextWindow: cfg.context_window_size,
    sizeBytes,
    maxTensorBytes,
    vision: !!mc.vision_config || /_v$|vl/i.test(String(cfg.model_type)),
    signature,
  };
}

function toRecord(c: CustomModelRecord): ModelRecord {
  return {
    model: c.url,
    model_id: c.id,
    model_lib: c.lib,
    vram_required_MB: c.vramMB,
    overrides: c.contextWindow ? { context_window_size: Math.min(c.contextWindow, 4096) } : { context_window_size: 4096 },
    ...(c.vision && { model_type: ModelType.VLM }),
    ...(c.needsF16 && { required_features: ['shader-f16'] }),
  } as ModelRecord;
}
let loadedModel: string | null = null;

// Every GPU operation runs one at a time. Overlapping reload/unload/generate on
// one engine destroys buffers mid-read ("Buffer was unmapped before mapping was
// resolved"). interrupt() deliberately bypasses this so Stop works mid-generation.
let queue: Promise<unknown> = Promise.resolve();
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

// Bumped by interrupt(): a generate() still waiting in the queue when Stop is
// pressed resolves as aborted instead of running afterwards.
let epoch = 0;

/** After a GPU failure the engine's state is unknown: drop it and start fresh. */
async function resetEngine() {
  const e = engine;
  engine = null;
  loadedModel = null;
  await e?.unload().catch(() => {});
}

function getEngine(onProgress?: ProgressFn): MLCEngine {
  engine ??= new MLCEngine({ appConfig });
  engine.setInitProgressCallback((p) => onProgress?.(p));
  return engine;
}

function modelBaseUrl(modelId: string): string {
  const rec = appConfig.model_list.find((m) => m.model_id === modelId);
  if (!rec) throw new Error(`Unknown model ${modelId}`);
  // Same normalization web-llm uses: <repo>/resolve/main/
  let url = rec.model;
  if (!url.endsWith('/')) url += '/';
  if (!url.includes('/resolve/')) url += 'resolve/main/';
  return url;
}

interface TensorCacheJson {
  records: { dataPath: string; nbytes: number }[];
}

async function tensorIndex(base: string, cache: Cache): Promise<TensorCacheJson | null> {
  const url = new URL('tensor-cache.json', base).href;
  try {
    const hit = await cache.match(url);
    const res = hit ?? (await fetch(url));
    return res.ok ? ((await res.json()) as TensorCacheJson) : null;
  } catch {
    return null; // offline and not cached
  }
}

/** Inspect web-llm's cache directly to report per-shard download progress. */
async function cacheStatuses(modelIds: string[]): Promise<CacheStatus[]> {
  const cache = await caches.open(MODEL_CACHE);
  const keys = new Set((await cache.keys()).map((r) => r.url));
  return Promise.all(
    modelIds.map(async (modelId): Promise<CacheStatus> => {
      const base = modelBaseUrl(modelId);
      const empty = { modelId, totalShards: 0, cachedShards: 0, totalBytes: 0, cachedBytes: 0, complete: false };
      // Skip the network round-trip for models we've never touched.
      if (!keys.has(new URL('tensor-cache.json', base).href)) return empty;
      const index = await tensorIndex(base, cache);
      if (!index) return empty;
      let cachedShards = 0, cachedBytes = 0, totalBytes = 0;
      for (const r of index.records) {
        totalBytes += r.nbytes;
        if (keys.has(new URL(r.dataPath, base).href)) {
          cachedShards++;
          cachedBytes += r.nbytes;
        }
      }
      const totalShards = index.records.length;
      return { modelId, totalShards, cachedShards, totalBytes, cachedBytes, complete: cachedShards === totalShards };
    }),
  );
}

const api = {
  cacheStatuses,

  /** WebLLM's prebuilt chat models (text and vision; not embedding models). */
  catalog: (): CatalogEntry[] => prebuiltAppConfig.model_list
    .filter((m) => m.model_type !== ModelType.embedding)
    .map((m) => ({
      id: m.model_id,
      url: m.model,
      lib: m.model_lib,
      vramMB: m.vram_required_MB,
      lowResource: m.low_resource_required,
      vision: m.model_type === ModelType.VLM,
      needsF16: !!m.required_features?.includes('shader-f16'),
      contextWindow: m.overrides?.context_window_size,
    })),

  /** Register models added by link, alongside the prebuilt ones. */
  setCustomModels(list: CustomModelRecord[]): void {
    const custom = list.map(toRecord);
    appConfig = { ...prebuiltAppConfig, model_list: [...prebuiltAppConfig.model_list.filter((m) => !list.some((c) => c.id === m.model_id)), ...custom] };
    engine?.setAppConfig(appConfig);
  },

  /** Read a model repo's config and weight index (size, largest tensor, architecture). */
  inspect: (url: string): Promise<RepoInfo> => inspectRepo(url),

  /** A prebuilt model's library URL and architecture, to reuse its library for a fine-tune. */
  async libraryOf(modelId: string): Promise<{ lib: string; info: RepoInfo }> {
    const rec = prebuiltAppConfig.model_list.find((m) => m.model_id === modelId);
    if (!rec) throw new Error(`Unknown model ${modelId}`);
    return { lib: rec.model_lib, info: await inspectRepo(rec.model) };
  },

  gpuDiagnostics: (): GpuDiagnostics => diag,

  /** Total shard bytes for a model, fetched from its tensor-cache.json. */
  async modelSize(modelId: string): Promise<number | null> {
    const index = await tensorIndex(modelBaseUrl(modelId), await caches.open(MODEL_CACHE));
    return index ? index.records.reduce((n, r) => n + r.nbytes, 0) : null;
  },

  /**
   * Download (or resume) a model. web-llm skips shards already in the Cache
   * API, so calling this again after a closed tab only fetches the remainder.
   */
  install: (modelId: string, onProgress: ProgressFn): Promise<InstallResult> => exclusive(async () => {
    const e = getEngine(onProgress);
    try {
      loadedModel = null;
      await e.reload(modelId);
      await e.unload();
      return { downloaded: true };
    } catch (err) {
      await resetEngine();
      const downloaded = await hasModelInCache(modelId, appConfig).catch(() => false);
      if (!downloaded) throw err;
      return { downloaded, gpuError: err instanceof Error ? err.message : String(err) };
    }
  }),

  /**
   * Load a model for chat and keep it resident. If it's already loaded this
   * returns at once instead of queueing behind a generation that's winding down.
   */
  /**
   * `contextWindow`: tokens to keep in mind (desktop; Android is always 2048).
   * Omitted, the model's last choice is reused. A different size reloads it.
   */
  load: async (modelId: string, onProgress: ProgressFn, contextWindow?: number): Promise<{ contextWindow: number }> => {
    const ctx = contextWindow ?? contextOf.get(modelId);
    if (loadedModel !== modelId || loadedContext !== ctx) {
      await exclusive(async () => {
        if (loadedModel === modelId && loadedContext === ctx) return; // loaded while we were queued
        const e = getEngine(onProgress);
        loadedModel = null;
        try {
          await e.reload(modelId, chatOpts(ctx));
        } catch (err) {
          await resetEngine();
          throw err;
        }
        loadedModel = modelId;
        loadedContext = ctx;
        contextOf.set(modelId, ctx);
      });
    }
    const rec = appConfig.model_list.find((m) => m.model_id === modelId);
    return { contextWindow: chatOpts(ctx)?.context_window_size ?? rec?.overrides?.context_window_size ?? 4096 };
  },

  /** Stream one completion; `onDelta` receives each text chunk. */
  generate: (
    messages: ChatCompletionMessageParam[],
    opts: GenerateOptions,
    onDelta: (text: string) => void,
  ): Promise<GenerateResult> => {
    const myEpoch = epoch;
    return exclusive(async () => {
      if (epoch !== myEpoch) return { text: '', finishReason: 'abort' };
      if (!engine || !loadedModel) throw new Error('No model loaded');
      try {
        return await streamCompletion(engine, messages, opts, onDelta);
      } catch (err) {
        // Only a GPU failure needs a fresh engine; validation errors, sampler
        // glitches and the like leave the loaded model usable.
        if (isGpuFailure(err)) await resetEngine();
        throw err;
      }
    });
  },

  /** Stop the in-flight and any queued generate(); they resolve with finishReason "abort". */
  interrupt(): void {
    epoch++;
    engine?.interruptGenerate();
  },

  remove: (modelId: string): Promise<void> => exclusive(async () => {
    // Deleting another model's files must not unload the one in use for chat.
    if (loadedModel === null || loadedModel === modelId) await resetEngine();
    await deleteModelAllInfoInCache(modelId, appConfig);
  }),

  /** Load `modelId`, warm up, then time a ~20-token greedy generation. */
  benchmark: (modelId: string, onProgress: ProgressFn): Promise<BenchResult> => exclusive(async () => {
    try {
      return await runBenchmark(modelId, onProgress);
    } catch (err) {
      await resetEngine();
      throw err;
    }
  }),
};

async function streamCompletion(
  engine: MLCEngine,
  messages: ChatCompletionMessageParam[],
  opts: GenerateOptions,
  onDelta: (text: string) => void,
): Promise<GenerateResult> {
  const stream = await engine.chat.completions.create({
    messages,
    stream: true,
    stream_options: { include_usage: true },
    response_format: opts.responseFormat,
    max_tokens: opts.maxTokens,
    temperature: opts.temperature,
    ...(opts.topP !== undefined && { top_p: opts.topP }),
    ...(opts.thinking !== undefined && { extra_body: { enable_thinking: opts.thinking } }),
  });
  let text = '';
  let finishReason = 'stop';
  let decodeTps: number | undefined;
  let promptTokens: number | undefined;
  let completionTokens: number | undefined;
  for await (const chunk of stream) {
    const choice = chunk.choices[0];
    const delta = choice?.delta?.content;
    if (delta) {
      text += delta;
      onDelta(delta); // fire-and-forget across the worker boundary
    }
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    if (chunk.usage) {
      decodeTps = chunk.usage.extra?.decode_tokens_per_s;
      promptTokens = chunk.usage.prompt_tokens;
      completionTokens = chunk.usage.completion_tokens;
    }
  }
  return { text, finishReason, decodeTps, promptTokens, completionTokens };
}

async function runBenchmark(modelId: string, onProgress: ProgressFn): Promise<BenchResult> {
  const cached = await hasModelInCache(modelId, appConfig);
  const e = getEngine(onProgress);
  const t0 = performance.now();
  loadedModel = null;
  await e.reload(modelId);
  const loadMs = performance.now() - t0;
  try {
    // Warm-up: first call compiles shaders/pipelines and would skew the numbers.
    await e.chat.completions.create({
      messages: [{ role: 'user', content: 'Hi' }],
      max_tokens: 4,
      temperature: 0,
    });
    const r = await e.chat.completions.create({
      messages: [{ role: 'user', content: 'Write a short paragraph about the ocean.' }],
      max_tokens: 20,
      ignore_eos: true,
      temperature: 0,
    });
    const extra = r.usage?.extra;
    if (!extra) throw new Error('Benchmark returned no usage stats');
    return {
      modelId,
      decodeTps: extra.decode_tokens_per_s,
      prefillTps: extra.prefill_tokens_per_s,
      tokens: r.usage?.completion_tokens ?? 0,
      loadMs,
      cached,
    };
  } finally {
    // Free GPU memory; weights stay in the Cache API for later runs.
    await e.unload();
  }
}

export type EngineApi = typeof api;

Comlink.expose(api);
