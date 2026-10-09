import type { InitProgressReport } from '@mlc-ai/web-llm';

export interface ParsedProgress {
  stage: 'init' | 'fetch' | 'load' | 'ready';
  /** 0..1 within the current stage */
  fraction: number;
  mb?: number;
  shard?: number;
  shards?: number;
  text: string;
}

// web-llm only reports progress as free text plus a 0..1 number. Formats:
//   "Fetching param cache[4/7]: 127MB fetched. 65% completed, ..."
//   "Loading model from cache[4/7]: 127MB loaded. 65% completed, ..."
//   "Finish loading on WebGPU - ..."
const SHARD_RE = /cache\[(\d+)\/(\d+)\]: (\d+)MB (fetched|loaded)/;

export function parseProgress(p: InitProgressReport): ParsedProgress {
  const m = SHARD_RE.exec(p.text);
  if (m) {
    return {
      stage: m[4] === 'fetched' ? 'fetch' : 'load',
      fraction: p.progress,
      shard: +m[1],
      shards: +m[2],
      mb: +m[3],
      text: p.text,
    };
  }
  if (p.text.startsWith('Finish loading')) return { stage: 'ready', fraction: 1, text: p.text };
  return { stage: 'init', fraction: p.progress, text: p.text };
}
