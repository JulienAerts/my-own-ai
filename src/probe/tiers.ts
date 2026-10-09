import type { DeviceReport } from './device';
import { TIER_ORDER, type Tier } from '../models';
import { t } from '../i18n/i18n';

export interface BenchResult {
  modelId: string;
  decodeTps: number;
  prefillTps: number;
  tokens: number;
  loadMs: number;
  /** True if the model was already in the browser cache (no download) */
  cached: boolean;
}

export interface TierDecision {
  tier: Tier;
  /** Highest tier the user may override to (iOS cap, buffer limits) */
  maxTier: Tier;
  reasons: string[];
  provisional: boolean;
}

// Decode tok/s for SmolLM2-360M (q4). Rough bands, tune once we have field data:
// phones ~8–30, integrated GPUs ~30–80, Apple M-series/discrete GPUs 80+.
export const BENCH_SLOW_TPS = 25;
export const BENCH_FAST_TPS = 80;

const GiB = 1024 ** 3;

const rank = (t: Tier) => TIER_ORDER.indexOf(t);
const minTier = (a: Tier, b: Tier) => (rank(a) <= rank(b) ? a : b);

export function decideTier(d: DeviceReport, bench?: BenchResult): TierDecision {
  const reasons: string[] = [];
  const { gpu, platform } = d;

  if (!gpu.apiPresent && !gpu.secureContext) {
    return { tier: 'unsupported', maxTier: 'unsupported', provisional: false,
      reasons: [t('This page was opened over plain HTTP ({origin}). Browsers only enable WebGPU on HTTPS or localhost, so open it via an https:// address instead.', { origin: location.origin })] };
  }
  if (!gpu.apiPresent) {
    return { tier: 'unsupported', maxTier: 'unsupported', provisional: false,
      reasons: [t('This browser does not expose WebGPU (navigator.gpu is missing).')] };
  }
  if (!gpu.adapter) {
    return { tier: 'unsupported', maxTier: 'unsupported', provisional: false,
      reasons: [gpu.error
        ? t('WebGPU adapter request failed: {error}', { error: gpu.error })
        : t('WebGPU is present but no GPU adapter is available. The browser has most likely blocklisted this GPU driver.')] };
  }
  if (gpu.isFallbackAdapter) {
    return { tier: 'unsupported', maxTier: 'unsupported', provisional: false,
      reasons: [t('Only a software (CPU fallback) WebGPU adapter is available — far too slow for an LLM.')] };
  }

  // Ceiling: what this device can physically attempt.
  let maxTier: Tier = 'medium';
  if ((gpu.maxStorageBufferBindingSize ?? 0) < GiB) {
    // web-llm requests a 1 GiB binding for non-"low resource" models (all 7–8B).
    maxTier = 'small';
    reasons.push('GPU storage-buffer limit is under 1 GiB, which rules out 7–8B models.');
  }
  if (platform.isIOS) {
    maxTier = 'tiny';
    reasons.push('iOS restricts per-tab memory; capped at Tiny regardless of benchmark.');
  } else if (platform.isMobile) {
    maxTier = minTier(maxTier, 'small');
  }

  // Heuristic tier.
  let tier: Tier;
  const lowMem = d.deviceMemory !== undefined && d.deviceMemory < 8;
  if (platform.isMobile) {
    // Chrome reports at most 8 GB, so this means "8 GB or more". Phones like the
    // OnePlus 13R run Phi-3.5 mini (3.8B) at ~14 tok/s; smaller phones stay Tiny.
    if (d.deviceMemory !== undefined && d.deviceMemory >= 8) {
      tier = 'small';
      reasons.push('Phone with 8 GB of memory or more.');
    } else {
      tier = 'tiny';
      reasons.push(d.deviceMemory === undefined ? 'Mobile device (memory not reported).' : `Mobile device with ${d.deviceMemory} GB of memory.`);
    }
  } else if (lowMem) {
    tier = 'tiny';
    reasons.push(`Reported device memory is ${d.deviceMemory} GB (< 8 GB).`);
  } else {
    tier = 'small';
    reasons.push(d.deviceMemory === undefined
      ? 'Desktop device (memory not reported by this browser).'
      : 'Desktop device with ≥ 8 GB memory.');
  }

  if (bench) {
    const tps = bench.decodeTps.toFixed(1);
    if (bench.decodeTps < BENCH_SLOW_TPS) {
      tier = 'tiny';
      reasons.push(`Benchmark was slow (${tps} tok/s < ${BENCH_SLOW_TPS}).`);
    } else if (bench.decodeTps >= BENCH_FAST_TPS) {
      if (platform.isMobile && !lowMem) {
        // Flagship phone: fast GPU and ≥ 8 GB RAM.
        tier = 'small';
        reasons.push(`Fast benchmark (${tps} tok/s) on a high-memory phone.`);
      } else if (!lowMem) {
        tier = 'medium';
        reasons.push(`Fast benchmark (${tps} tok/s ≥ ${BENCH_FAST_TPS}).`);
      } else {
        reasons.push(`Fast benchmark (${tps} tok/s), but limited system memory.`);
      }
    } else {
      reasons.push(`Benchmark: ${tps} tok/s (mid-range).`);
    }
  }

  return { tier: minTier(tier, maxTier), maxTier, reasons, provisional: !bench };
}

/** Tiers the user may pick: detected tier ± 1, within [tiny, maxTier]. */
export function overrideOptions(dec: TierDecision): Tier[] {
  if (dec.tier === 'unsupported') return [];
  const r = rank(dec.tier);
  return TIER_ORDER.filter(
    (t) => t !== 'unsupported' && Math.abs(rank(t) - r) <= 1 && rank(t) <= rank(dec.maxTier),
  );
}
