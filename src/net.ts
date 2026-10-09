import type { ConnectionReport } from './probe/device';

// Network Information API `effectiveType` → representative throughput (Mbps).
// Chromium caps `downlink` at 10 Mbps, so real broadband is often faster.
const EFFECTIVE_MBPS: Record<string, number> = {
  'slow-2g': 0.05,
  '2g': 0.25,
  '3g': 1.5,
  '4g': 10,
};
const UNKNOWN_MBPS = 25;

export interface DownloadEstimate {
  seconds: number;
  mbps: number;
  basis: 'downlink' | 'effectiveType' | 'assumed';
}

export function estimateDownload(bytes: number, conn?: ConnectionReport): DownloadEstimate {
  let mbps = UNKNOWN_MBPS;
  let basis: DownloadEstimate['basis'] = 'assumed';
  if (conn?.downlinkMbps) {
    mbps = conn.downlinkMbps;
    basis = 'downlink';
  } else if (conn?.effectiveType && EFFECTIVE_MBPS[conn.effectiveType]) {
    mbps = EFFECTIVE_MBPS[conn.effectiveType];
    basis = 'effectiveType';
  }
  return { seconds: (bytes * 8) / (mbps * 1e6), mbps, basis };
}

export function formatDuration(s: number): string {
  if (s < 60) return `${Math.max(1, Math.round(s))} s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  const h = Math.floor(s / 3600);
  return `${h} h ${Math.round((s - h * 3600) / 60)} min`;
}

/** The spec's "metered" signal: data saver on, or a known cellular link. */
export function isMetered(conn?: ConnectionReport): boolean {
  return !!conn && (conn.saveData === true || conn.type === 'cellular');
}

export function onConnectionChange(cb: () => void): () => void {
  const c = (navigator as Navigator & { connection?: EventTarget }).connection;
  c?.addEventListener('change', cb);
  return () => c?.removeEventListener('change', cb);
}
