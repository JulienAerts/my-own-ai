// Feature/capability probe. Every field is optional-tolerant: browsers expose
// wildly different subsets, and nothing here may throw.

export interface GpuReport {
  /** WebGPU is only exposed on HTTPS or localhost */
  secureContext: boolean;
  apiPresent: boolean;
  adapter: boolean;
  isFallbackAdapter: boolean;
  vendor?: string;
  architecture?: string;
  description?: string;
  shaderF16: boolean;
  maxBufferSize?: number;
  maxStorageBufferBindingSize?: number;
  error?: string;
  /** Which requestAdapter() calls were tried, for diagnosing "no adapter" */
  attempts: string[];
}

export interface PlatformReport {
  isMobile: boolean;
  isIOS: boolean;
  isAndroid: boolean;
  isSafari: boolean;
  /** Launched from the home screen / installed PWA */
  standalone: boolean;
}

export interface ConnectionReport {
  effectiveType?: string;
  type?: string;
  saveData?: boolean;
  downlinkMbps?: number;
}

export interface DeviceReport {
  gpu: GpuReport;
  platform: PlatformReport;
  /** GB, Chromium-only, rounded down to a power of two (capped at 8 or 32 depending on version) */
  deviceMemory?: number;
  hardwareConcurrency?: number;
  storage?: StorageReport;
  connection?: ConnectionReport;
}

interface NavigatorExtras {
  deviceMemory?: number;
  connection?: { effectiveType?: string; type?: string; saveData?: boolean; downlink?: number };
  userAgentData?: { mobile?: boolean; platform?: string };
  standalone?: boolean;
}

export function detectPlatform(): PlatformReport {
  const nav = navigator as Navigator & NavigatorExtras;
  const ua = navigator.userAgent;
  // iPadOS 13+ reports itself as "Macintosh"; touch points give it away.
  const isIOS =
    /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const isAndroid = /Android/i.test(ua);
  const isMobile = nav.userAgentData?.mobile ?? (isIOS || isAndroid || /Mobi/i.test(ua));
  const isSafari = /Safari/.test(ua) && !/Chrome|Chromium|CriOS|FxiOS|Edg/.test(ua);
  const standalone =
    nav.standalone === true || matchMedia('(display-mode: standalone)').matches;
  return { isMobile, isIOS, isAndroid, isSafari, standalone };
}

async function probeGpu(): Promise<GpuReport> {
  const report: GpuReport = {
    secureContext: window.isSecureContext,
    apiPresent: 'gpu' in navigator && !!navigator.gpu,
    adapter: false,
    isFallbackAdapter: false,
    shaderF16: false,
    attempts: [],
  };
  if (!report.apiPresent) return report;
  try {
    // Some Android builds return null for an explicit powerPreference, so fall
    // back to a plain request before concluding there's no adapter.
    let adapter: GPUAdapter | null = null;
    for (const opts of [{ powerPreference: 'high-performance' } as const, undefined]) {
      adapter = await navigator.gpu.requestAdapter(opts);
      report.attempts.push(`${opts ? 'high-performance' : 'default'}: ${adapter ? 'ok' : 'null'}`);
      if (adapter) break;
    }
    if (!adapter) return report;
    report.adapter = true;
    // `isFallbackAdapter` moved to GPUAdapterInfo in newer specs; check both.
    const legacy = adapter as GPUAdapter & { isFallbackAdapter?: boolean };
    const info = adapter.info as (GPUAdapterInfo & { isFallbackAdapter?: boolean }) | undefined;
    report.isFallbackAdapter = !!(info?.isFallbackAdapter ?? legacy.isFallbackAdapter);
    report.vendor = info?.vendor || undefined;
    report.architecture = info?.architecture || undefined;
    report.description = info?.description || undefined;
    report.shaderF16 = adapter.features.has('shader-f16');
    report.maxBufferSize = adapter.limits.maxBufferSize;
    report.maxStorageBufferBindingSize = adapter.limits.maxStorageBufferBindingSize;
  } catch (e) {
    report.error = e instanceof Error ? e.message : String(e);
  }
  return report;
}

export interface StorageReport {
  usage: number;
  /** Undefined when the browser's number is known to be fake (Brave). */
  quota?: number;
  /** Brave always reports a 2 GiB quota (anti-fingerprinting) and enforces Chromium's real, disk-based one. */
  quotaHiddenByBrave?: boolean;
}

export async function probeStorage(): Promise<StorageReport | undefined> {
  try {
    const est = await navigator.storage?.estimate?.();
    if (!est) return undefined;
    const brave = (navigator as Navigator & { brave?: { isBrave(): Promise<boolean> } }).brave;
    if (brave && (await brave.isBrave().catch(() => false))) {
      return { usage: est.usage ?? 0, quotaHiddenByBrave: true };
    }
    if (est.quota == null) return undefined;
    return { quota: est.quota, usage: est.usage ?? 0 };
  } catch {
    return undefined;
  }
}

/** Bytes the site may still store, or undefined if the browser won't say. */
export function freeStorage(s?: StorageReport): number | undefined {
  return s?.quota != null ? s.quota - s.usage : undefined;
}

export function probeConnection(): ConnectionReport | undefined {
  const c = (navigator as Navigator & NavigatorExtras).connection;
  if (!c) return undefined;
  return {
    effectiveType: c.effectiveType,
    type: c.type,
    saveData: c.saveData,
    downlinkMbps: c.downlink,
  };
}

export async function probeDevice(): Promise<DeviceReport> {
  const nav = navigator as Navigator & NavigatorExtras;
  const [gpu, storage] = await Promise.all([probeGpu(), probeStorage()]);
  return {
    gpu,
    platform: detectPlatform(),
    deviceMemory: nav.deviceMemory,
    hardwareConcurrency: navigator.hardwareConcurrency || undefined,
    storage,
    connection: probeConnection(),
  };
}
