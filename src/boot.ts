// App boot as a module-level store: probe the device, pick a model, download
// whatever is missing and load it onto the GPU. web-llm's reload() does the
// download and the load in one pass, so one progress stream covers both.
import { useEffect, useState } from 'preact/hooks';
import { deleteSetting, getSetting, setSetting } from './db';
import { engine, terminateEngine, Comlink } from './worker/client';
import { probeConnection, probeDevice, type DeviceReport } from './probe/device';
import { decideTier, type TierDecision } from './probe/tiers';
import { getGenSettings } from './agent/genPrefs';
import { customModels, toNativeModel } from './native/custom';
import { TIER_ORDER, chatModels, extraModels, fitsBinding, modelById, safeBinding, modelForTier, modelId, nativeModels, setExtraModels, setNativeModels, type ModelInfo, type Tier } from './models';
import {
  cancelNativeDownload, downloadedBytes, isNativeModel, nativeContext, nativeContexts, nativeModelsFor, bestGpu,
  recommendedNative, startNative, stopNative, activeNative, totalBytes as nativeTotalBytes, type Gpu, type NativeModel,
  nativeComplete, llamaStatus,
} from './native/backend';
import { isMetered, onConnectionChange } from './net';
import { parseProgress, type ParsedProgress } from './ui/progress';
import { MAX_IMAGE_TOKENS, PHONE_IMAGE_TOKENS } from './ui/image';
import { t } from './i18n/i18n';

const MB = 1024 ** 2;

export type BootState =
  | { kind: 'probing' }
  | { kind: 'unsupported'; device: DeviceReport; decision: TierDecision }
  /** First run (or an unfinished download): one tap to start, since it may be GBs. */
  | { kind: 'welcome'; modelId: string; model: ModelInfo; totalBytes: number; cachedBytes: number; metered: boolean }
  | { kind: 'running'; modelId: string; model: ModelInfo; totalBytes: number; progress: ParsedProgress; downloading: boolean }
  | { kind: 'paused'; modelId: string; model: ModelInfo; totalBytes: number; cachedBytes: number; reason: string }
  | { kind: 'error'; modelId: string; model: ModelInfo; message: string; downloaded: boolean }
  | { kind: 'ready'; modelId: string; model: ModelInfo; contextWindow: number };

let state: BootState = { kind: 'probing' };
const subs = new Set<(s: BootState) => void>();
// Bumped on pause/switch so callbacks from an abandoned load are ignored.
let run = 0;
let unwatch: (() => void) | null = null;

export let device: DeviceReport | null = null;
export let decision: TierDecision | null = null;

function set(s: BootState) {
  state = s;
  subs.forEach((fn) => fn(s));
}

export function useBoot(): BootState {
  const [s, setS] = useState(state);
  useEffect(() => {
    subs.add(setS);
    setS(state);
    return () => void subs.delete(setS);
  }, []);
  return s;
}

export function bootState(): BootState {
  return state;
}

/** The build to use on this device: f16 when the GPU supports shader-f16. */
function buildId(m: ModelInfo, d: DeviceReport): string {
  return modelId(m, d.gpu.shaderF16);
}

const rank = (t: Tier) => TIER_ORDER.indexOf(t);

/**
 * High-end enough for the vision model (~4 GB of GPU memory, 4096-token context
 * on phones too): 8 GB of memory or more. Desktops that don't report memory
 * (Firefox, Safari) are given the benefit of the doubt; phones are not.
 */
function highEnd(d: DeviceReport): boolean {
  return d.deviceMemory === undefined ? !d.platform.isMobile : d.deviceMemory >= 8;
}

/** Most tokens an image may cost on this device (fewer crops on phones: faster, less memory). */
export function imageTokenBudget(): number {
  return device?.platform.isMobile ? PHONE_IMAGE_TOKENS : MAX_IMAGE_TOKENS;
}

/** Models this device can run: within its tier ceiling and its GPU binding limit. */
function runnable(d: DeviceReport, dec: TierDecision): ModelInfo[] {
  const curated = chatModels(d.platform.isIOS).filter(
    (m) => rank(m.tier) <= rank(dec.maxTier) && fitsBinding(m, d.gpu.maxStorageBufferBindingSize) && (!m.vision || highEnd(d)),
  );
  // Added models are the user's choice: only hard limits apply (binding size, f16 support).
  const added = extraModels().filter(
    (m) => fitsBinding(m, d.gpu.maxStorageBufferBindingSize) && (d.gpu.shaderF16 || !/f16/i.test(m.fixedId ?? '')),
  );
  return [...curated, ...added];
}

/** Register models added from the catalog or by link (models.ts and the engine worker). */
async function loadExtraModels(list?: ModelInfo[]): Promise<void> {
  list ??= (await getSetting('extraModels')) ?? [];
  setExtraModels(list);
  await engine().setCustomModels(list.filter((m) => m.source === 'custom').map((m) => ({
    id: m.fixedId!, url: m.url!, lib: m.lib!, vramMB: m.vramMB, contextWindow: m.contextWindow, vision: m.vision,
    needsF16: /f16/i.test(m.fixedId ?? ''),
  })));
}

export async function addExtraModel(m: ModelInfo): Promise<void> {
  const list = [...extraModels().filter((x) => x.fixedId !== m.fixedId), m];
  await setSetting('extraModels', list);
  await loadExtraModels(list);
}

export async function removeExtraModel(id: string): Promise<void> {
  const list = extraModels().filter((x) => x.fixedId !== id);
  await setSetting('extraModels', list);
  await loadExtraModels(list);
}

/** Why an added model isn't offered on this device, or null if it is. */
export function extraModelProblem(m: ModelInfo): string | null {
  if (!device) return null;
  if (!fitsBinding(m, device.gpu.maxStorageBufferBindingSize)) {
    // Reported limit with the safety margin (see SAFE_BINDING_SHARE in models.ts).
    const limit = Math.round(safeBinding(device.gpu.maxStorageBufferBindingSize ?? 0) / 2 ** 20);
    return (m.workspaceBytes ?? 0) > m.maxTensorBytes
      ? t('While answering it needs a {size} MB GPU buffer, and this GPU handles up to {limit} MB reliably.', { size: Math.round(m.workspaceBytes! / 2 ** 20), limit })
      : t('Its largest weight block ({size} MB) is bigger than this GPU handles reliably ({limit} MB).', { size: Math.round(m.maxTensorBytes / 2 ** 20), limit });
  }
  if (!device.gpu.shaderF16 && /f16/i.test(m.fixedId ?? '')) return t('This build needs 16-bit GPU math (shader-f16), which this GPU lacks.');
  return null;
}

/** The tier's default model, or the largest runnable model at or below that tier. */
function defaultModel(d: DeviceReport, dec: TierDecision): ModelInfo | undefined {
  const preferred = modelForTier(dec.tier, d.platform.isIOS);
  // Recommendations come from the curated list only, never from models the user added.
  const ok = runnable(d, dec).filter((m) => !m.source);
  if (preferred && ok.includes(preferred)) return preferred;
  // Never default to the vision model: it's a bigger download, chosen on purpose.
  const text = ok.filter((m) => !m.vision);
  return text.filter((m) => rank(m.tier) <= rank(dec.tier)).at(-1) ?? text[0];
}

const MiB = 1024 * 1024;

/**
 * Phones: context sizes a text model can use. Phones refuse any GPU buffer over 128 MiB, but
 * what grows with the context is the conversation memory (KV cache), held in one buffer per
 * layer: each must stay under 96 MiB, and all of them under 1 GiB. (Prompts are processed in
 * 1,024-token chunks whatever the context, ~72 MiB for text models.) The vision model's library
 * processes 2,048 tokens at a time (144 MiB), so it stays at 2048; so do models without figures.
 * `f32`: the 32-bit build (no 16-bit shaders), whose memory doubles.
 */
export function phoneContexts(m: ModelInfo, f32 = false): number[] {
  if (m.vision || m.workspaceBytes || !m.kv) return [];
  const { layers, perToken: raw } = m.kv;
  const perToken = raw * (f32 ? 2 : 1);
  return [2048, 4096, 8192].filter((n) =>
    n <= (m.maxContext ?? 4096) && perToken * n <= 1024 * MiB && (perToken / layers) * n <= 96 * MiB);
}

/** Phones, "Auto": the largest context whose conversation memory stays within 640 MiB. */
export function phoneAutoContext(m: ModelInfo, f32 = false): number {
  const perToken = (m.kv?.perToken ?? Infinity) * (f32 ? 2 : 1);
  return [...phoneContexts(m, f32)].reverse().find((n) => perToken * n <= 640 * MiB) ?? 2048;
}

const isF32 = (id: string) => /q\d+f32/.test(id);

/** Context sizes the user may pick for a model (Settings → Model → Generation); none = fixed. */
export function contextChoices(m: ModelInfo, id = ''): number[] {
  if (isNativeModel(m)) return nativeGpu ? nativeContexts(m, nativeGpu) : [];
  if (!device) return [];
  if (device.platform.isMobile) {
    const sizes = phoneContexts(m, isF32(id));
    return sizes.length > 1 ? sizes : [];
  }
  return [2048, 4096, 8192, 16384, 32768].filter((n) => n <= (m.maxContext ?? m.contextWindow ?? 4096));
}

/** The context to load with when the user left it on Auto: phones decide by memory; elsewhere the model's default. */
function autoContext(m: ModelInfo, id: string): number | undefined {
  return device?.platform.isMobile && !isNativeModel(m) && contextChoices(m, id).length ? phoneAutoContext(m, isF32(id)) : undefined;
}

/**
 * Models this device may run, smallest first, with the recommended one flagged.
 * Desktop app with a big enough GPU (NVIDIA, AMD, Intel Arc…): the llama.cpp models come first.
 */
export function modelChoices(): { id: string; model: ModelInfo; recommended: boolean }[] {
  if (!device || !decision) return [];
  const rec = pickDefault(device, decision);
  const native = nativeModels().map((m) => ({ id: m.fixedId!, model: m, recommended: m === rec }));
  if (decision.tier === 'unsupported') return native;
  return [...native, ...runnable(device, decision).map((m) => ({ id: buildId(m, device!), model: m, recommended: m === rec }))];
}

/**
 * A vision model this device can run (curated first), to answer about images for a text model.
 * Not while a llama.cpp model holds the GPU: WebLLM's vision model wouldn't fit next to it.
 */
export function visionHelper(): { id: string; model: ModelInfo } | null {
  if (activeNative()) return null;
  return modelChoices().find((c) => c.model.vision) ?? null;
}

/** The recommendation: the best llama.cpp model when the GPU allows it, else WebLLM's. */
function pickDefault(d: DeviceReport, dec: TierDecision): ModelInfo | undefined {
  return recommendedNative(nativeModels().filter(isNativeModel)) ?? (dec.tier === 'unsupported' ? undefined : defaultModel(d, dec));
}

async function sizes(id: string, model: ModelInfo) {
  if (isNativeModel(model)) {
    const status = await llamaStatus().catch(() => null);
    const have = await downloadedBytes(model, status);
    return { totalBytes: nativeTotalBytes(model), cachedBytes: have, complete: nativeComplete(model, status) };
  }
  const [status] = await engine().cacheStatuses([id]).catch(() => []);
  let totalBytes = status?.totalBytes || 0;
  if (!totalBytes) totalBytes = (await engine().modelSize(id).catch(() => null)) ?? model.downloadMB * MB;
  return { totalBytes, cachedBytes: status?.cachedBytes ?? 0, complete: !!status?.complete };
}

/** Models left out because a weight tensor exceeds this GPU's binding limit. */
export function tooLargeModels(): ModelInfo[] {
  if (!device) return [];
  return chatModels(device.platform.isIOS).filter((m) => !fitsBinding(m, device!.gpu.maxStorageBufferBindingSize));
}

/** Called once at startup. */
export async function boot(): Promise<void> {
  device = await probeDevice();
  decision = decideTier(device);
  // End-to-end tests (dev server only): straight to the chat with this model and the stand-in engine.
  const e2e = import.meta.env?.DEV ? (globalThis as { __E2E_BOOT__?: { modelId: string } }).__E2E_BOOT__ : undefined;
  const e2eModel = e2e && modelById(e2e.modelId);
  if (e2e && e2eModel) return set({ kind: 'ready', modelId: e2e.modelId, model: e2eModel, contextWindow: 4096 });
  await loadExtraModels().catch((e) => console.warn('Added models unavailable', e));
  // Desktop app: llama.cpp models when the GPU has enough dedicated memory.
  await refreshNativeModels(await nativeGpuProbe());
  if (decision.tier === 'unsupported' && !nativeModels().length) return set({ kind: 'unsupported', device, decision });

  const saved = (await getSetting('selection'))?.modelId;
  // A saved choice that no longer fits this device (e.g. a model whose weights
  // exceed the GPU's binding limit) falls back to the default.
  const savedModel = saved ? modelById(saved) : undefined;
  const allowed = modelChoices().map((c) => c.model);
  const model = savedModel && allowed.includes(savedModel) ? savedModel : pickDefault(device, decision);
  if (!model) return set({ kind: 'unsupported', device, decision: { ...decision, reasons: [...decision.reasons, 'None of the available models fits this GPU\'s buffer limits.'] } });
  const id = isNativeModel(model) ? model.fixedId! : buildId(model, device);
  const { totalBytes, cachedBytes, complete } = await sizes(id, model);
  if (complete) return start(id);
  set({ kind: 'welcome', modelId: id, model, totalBytes, cachedBytes, metered: isMetered(probeConnection()) });
}

/** Download (if needed) and load `id`, then switch to chat. */
export async function start(id: string): Promise<void> {
  const model = modelById(id);
  if (!model) return;
  const token = ++run;
  stopWatching();
  const { totalBytes, cachedBytes, complete } = await sizes(id, model);
  if (isNativeModel(model)) return startNativeModel(id, model, token, totalBytes, complete);
  // Switching from a llama.cpp model: free its GPU memory first.
  if (activeNative()) await stopNative();
  const wifiOnly = (await getSetting('wifiOnly')) ?? false;
  if (!complete && wifiOnly && probeConnection()?.type === 'cellular') {
    return set({ kind: 'paused', modelId: id, model, totalBytes, cachedBytes, reason: t('Waiting for Wi-Fi. Turn off “Wi-Fi only” in settings to download over cellular.') });
  }
  if (!complete) {
    // Ask the browser not to evict GBs of weights under storage pressure.
    await navigator.storage?.persist?.().catch(() => false);
    unwatch = onConnectionChange(() => {
      if (wifiOnly && probeConnection()?.type === 'cellular') pause('Paused because you switched to a cellular connection (Wi-Fi only is on).');
    });
  }
  await setSetting('selection', { modelId: id });
  await deleteSetting('pendingDownload');
  set({ kind: 'running', modelId: id, model, totalBytes, downloading: !complete, progress: { stage: 'init', fraction: 0, text: t('Starting…') } });
  const progress = Comlink.proxy((p: Parameters<typeof parseProgress>[0]) => {
    // Progress arrives on its own port and may trail the resolved result.
    if (token === run && state.kind === 'running') set({ ...state, progress: parseProgress(p) });
  });
  const wanted = contextChoices(model, id).length ? ((await getGenSettings(id)).contextWindow ?? autoContext(model, id)) : undefined;
  try {
    let contextWindow: number;
    try {
      ({ contextWindow } = await engine().load(id, progress, wanted));
    } catch (e) {
      // A phone that can't hold a longer context: load it as before, at 2048 tokens.
      if (!device?.platform.isMobile || !wanted || wanted <= 2048 || token !== run) throw e;
      console.warn(`Loading at ${wanted} tokens failed, retrying at 2048`, e);
      ({ contextWindow } = await engine().load(id, progress, 2048));
    }
    if (token !== run) return;
    set({ kind: 'ready', modelId: id, model, contextWindow });
  } catch (e) {
    if (token !== run) return;
    const after = await sizes(id, model);
    set({ kind: 'error', modelId: id, model, message: e instanceof Error ? e.message : String(e), downloaded: after.complete });
  } finally {
    if (token === run) stopWatching();
  }
}

function stopWatching() {
  unwatch?.();
  unwatch = null;
}

/** Stop a download. Finished parts stay in the Cache API. */
export async function pause(reason = 'Paused. Everything downloaded so far is saved on this device.'): Promise<void> {
  if (state.kind !== 'running') return;
  const { modelId: id, model, totalBytes } = state;
  run++;
  stopWatching();
  if (isNativeModel(model)) await cancelNativeDownload(model);
  // web-llm has no abort for reload(); killing the worker is the reliable stop.
  else terminateEngine();
  const { cachedBytes } = await sizes(id, model);
  set({ kind: 'paused', modelId: id, model, totalBytes, cachedBytes, reason });
}

/** The llama.cpp models for this GPU: built-in ones and those added from Hugging Face. */
export async function refreshNativeModels(gpu = nativeGpu): Promise<void> {
  const custom = gpu ? (await customModels().catch(() => [])).map(toNativeModel) : [];
  setNativeModels(nativeModelsFor(gpu, custom));
}

/** The desktop app's GPU (any vendor), kept for context-size choices. */
export let nativeGpu: Gpu | null = null;

async function nativeGpuProbe(): Promise<Gpu | null> {
  nativeGpu = await bestGpu();
  return nativeGpu;
}

/** Desktop app: install llama.cpp and the model if needed, then load it. */
async function startNativeModel(id: string, model: NativeModel, token: number, totalBytes: number, complete: boolean) {
  await setSetting('selection', { modelId: id });
  await deleteSetting('pendingDownload');
  // WebLLM's model, if one is loaded, would hold GPU memory the new one needs.
  terminateEngine();
  const ctx = (await getGenSettings(id)).contextWindow ?? (nativeGpu ? nativeContext(model, nativeGpu) : 8192);
  set({ kind: 'running', modelId: id, model, totalBytes, downloading: !complete, progress: { stage: 'init', fraction: 0, text: t('Starting…') } });
  try {
    await startNative(model, ctx, (p) => {
      if (token !== run || state.kind !== 'running') return;
      set({ ...state, downloading: p.stage !== 'load', progress: { stage: p.stage === 'load' ? 'load' : 'fetch', fraction: p.fraction, text: p.text } });
    });
    if (token !== run) return;
    set({ kind: 'ready', modelId: id, model, contextWindow: ctx });
  } catch (e) {
    if (token !== run) return;
    const message = e instanceof Error ? e.message : String(e);
    if (message === 'cancelled') return;
    const after = await sizes(id, model);
    set({ kind: 'error', modelId: id, model, message, downloaded: after.complete });
  }
}

/** Reload the current model, e.g. after the GPU device was lost mid-answer. */
export function reload(): Promise<void> {
  return 'modelId' in state ? start(state.modelId) : boot();
}
