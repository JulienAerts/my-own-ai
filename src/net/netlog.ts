// Network activity (Settings → App): every request the app makes to the
// internet, so anyone can check what leaves the device. Requests are seen where
// they start:
//  - fetch() and the Cache API (WebLLM's downloads), patched in the page and in
//    each worker (src/net/install.ts, imported first);
//  - everything else the browser loads (scripts, images…) through Resource Timing;
//  - the apps' native HTTP (Tauri, Capacitor) and the desktop app's downloads in
//    Rust, through track() at the call site.
// Workers send their entries to the page over a BroadcastChannel. The app's own
// files and local servers (llama.cpp, Whisper on 127.0.0.1) aren't listed: they
// don't leave the device. Kept for this session only.

export interface NetEntry {
  id: string;
  /** Start time (ms since epoch). */
  t: number;
  url: string;
  host: string;
  method: string;
  /** What asked for it: a tool, a model download, a worker… */
  source: string;
  status: 'pending' | 'error' | number;
  bytes?: number;
  ms?: number;
}

const CHANNEL = 'my-own-ai-network';
const MAX_ENTRIES = 400;
const isPage = typeof document !== 'undefined';
const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(CHANNEL) : null;

/** True for requests that leave the device (not the app's own files, not local servers). */
export function isExternal(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url, location.href);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  if (u.origin === location.origin) return false;
  const h = u.hostname;
  return !(h === 'localhost' || h.endsWith('.localhost') || h === '127.0.0.1' || h === '[::1]');
}

/** The service behind a host, for grouping. */
export function serviceOf(host: string): string {
  const h = host.toLowerCase();
  const is = (d: string) => h === d || h.endsWith(`.${d}`);
  if (is('huggingface.co') || is('hf.co')) return 'Hugging Face';
  if (is('jsdelivr.net')) return 'jsDelivr';
  if (is('github.com') || is('githubusercontent.com')) return 'GitHub';
  if (is('wikipedia.org') || is('wikimedia.org')) return 'Wikipedia';
  if (is('wiktionary.org')) return 'Wiktionary';
  if (is('duckduckgo.com')) return 'DuckDuckGo';
  if (is('bing.com')) return 'Bing';
  if (is('news.google.com')) return 'Google News';
  if (is('open-meteo.com')) return 'Open-Meteo';
  if (is('frankfurter.app') || is('frankfurter.dev')) return 'Frankfurter';
  return h.replace(/^www\./, '');
}

// ---------------------------------------------------------------------------
// The page's list

const entries: NetEntry[] = [];
const subs = new Set<() => void>();

function upsert(e: NetEntry & { sizeOnly?: boolean }) {
  const i = entries.findIndex((x) => x.id === e.id);
  if (e.sizeOnly) {
    // Resource Timing's size, for a response without Content-Length.
    if (i >= 0 && !entries[i].bytes) entries[i] = { ...entries[i], bytes: e.bytes };
    if (i >= 0) for (const fn of subs) fn();
    return;
  }
  if (i >= 0) entries[i] = { ...entries[i], ...e, bytes: e.bytes ?? entries[i].bytes };
  else {
    entries.push(e);
    if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
  }
  for (const fn of subs) fn();
}

if (isPage && channel) channel.onmessage = (m) => upsert(m.data as NetEntry);

function publish(e: NetEntry) {
  if (isPage) upsert(e);
  else channel?.postMessage(e);
}

/** Every request so far this session, oldest first. */
export function netEntries(): readonly NetEntry[] {
  return entries;
}

export function onNetChange(fn: () => void): () => void {
  subs.add(fn);
  return () => void subs.delete(fn);
}

export function clearNetEntries() {
  entries.length = 0;
  for (const fn of subs) fn();
}

/** Added by the code sandbox, which can't reach the channel (opaque origin). */
export function addNetEntry(e: Omit<NetEntry, 'id' | 'host'> & { id?: string }) {
  if (!isExternal(e.url)) return;
  publish({ ...e, id: e.id ?? newId(), host: new URL(e.url).host });
}

// ---------------------------------------------------------------------------
// Recording

let seq = 0;
const prefix = Math.random().toString(36).slice(2, 7);
const newId = () => `${prefix}-${++seq}`;

/** The page's current reason for requests (the tool running, say); workers use their name. */
let pageSource: string | null = null;
export function setNetSource(source: string | null) {
  pageSource = source;
}
let defaultSource = 'App';
const currentSource = () => (isPage ? pageSource : null) ?? defaultSource;

/** Record a request that starts now; call the result when it ends. */
export function track(url: string, method = 'GET', source = currentSource(), id = newId()): (end: { status: number | 'error'; bytes?: number }) => void {
  if (!isExternal(url)) return () => {};
  const t = Date.now();
  const abs = new URL(url, location.href);
  publish({ id, t, url: abs.href, host: abs.host, method: method.toUpperCase(), source, status: 'pending' });
  return (end) => publish({ id, t, url: abs.href, host: abs.host, method: method.toUpperCase(), source, ...end, ms: Date.now() - t });
}

/** Track a native download (Rust) for its whole duration; `bytes` reads what it received. */
export async function trackDownload<T>(url: string, source: string, run: () => Promise<T>, bytes?: () => number | undefined): Promise<T> {
  const done = track(url, 'GET', source);
  try {
    const r = await run();
    done({ status: 200, bytes: bytes?.() });
    return r;
  } catch (e) {
    done({ status: 'error', bytes: bytes?.() });
    throw e;
  }
}

const sizeOf = (res: Response) => {
  const n = Number(res.headers.get('content-length'));
  return n > 0 ? n : undefined;
};

/** Patch fetch, the Cache API and Resource Timing in this context. Idempotent. */
export function installNetLog(source?: string) {
  const g = globalThis as typeof globalThis & { __netLog?: boolean };
  if (g.__netLog || typeof g.fetch !== 'function') return;
  g.__netLog = true;
  if (source) defaultSource = source;

  // Requests seen by the patches (URL → their ids): Resource Timing then only adds
  // the size when the server didn't send a Content-Length, instead of a second entry.
  const seen = new Map<string, string[]>();
  const mark = (url: string) => {
    if (seen.size > 500) seen.clear();
    const id = newId();
    seen.set(url, [...(seen.get(url) ?? []), id]);
    return id;
  };
  const urlOf = (input: RequestInfo | URL) => (typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);

  const fetch0 = g.fetch.bind(g);
  g.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = urlOf(input);
    if (!isExternal(url)) return fetch0(input, init);
    const id = mark(new URL(url, location.href).href);
    const done = track(url, init?.method ?? (input instanceof Request ? input.method : 'GET'), currentSource(), id);
    try {
      const res = await fetch0(input, init);
      const bytes = sizeOf(res);
      done({ status: res.status, bytes });
      // No Content-Length (a chunked API answer, small): count what arrives. Opaque responses can't be read.
      if (bytes === undefined && res.type !== 'opaque' && res.body) {
        res.clone().blob().then((b) => b.size && publish({ id, bytes: b.size, sizeOnly: true } as unknown as NetEntry), () => {});
      }
      return res;
    } catch (e) {
      done({ status: 'error' });
      throw e;
    }
  };

  if (typeof Cache !== 'undefined') {
    const add0 = Cache.prototype.add;
    const addAll0 = Cache.prototype.addAll;
    Cache.prototype.add = async function (this: Cache, req: RequestInfo | URL) {
      const url = urlOf(req);
      if (!isExternal(url)) return add0.call(this, req);
      const id = mark(new URL(url, location.href).href);
      const done = track(url, 'GET', currentSource(), id);
      try {
        await add0.call(this, req);
        const hit = await this.match(req).catch(() => undefined);
        done({ status: 200, bytes: hit ? sizeOf(hit) : undefined });
      } catch (e) {
        done({ status: 'error' });
        throw e;
      }
    };
    Cache.prototype.addAll = async function (this: Cache, reqs: RequestInfo[]) {
      if (!reqs.some((r) => isExternal(urlOf(r)))) return addAll0.call(this, reqs);
      for (const r of reqs) await this.add(r);
    };
  }

  // Scripts, styles, images, importScripts… anything that didn't go through fetch.
  if (typeof PerformanceObserver !== 'undefined') {
    try {
      performance.setResourceTimingBufferSize?.(1000);
      new PerformanceObserver((list) => {
        for (const r of list.getEntries() as PerformanceResourceTiming[]) {
          if (!isExternal(r.name)) continue;
          const ids = seen.get(r.name);
          if (ids?.length) {
            const id = ids.shift()!;
            if (!ids.length) seen.delete(r.name);
            const bytes = r.transferSize || r.encodedBodySize;
            if (bytes) publish({ id, bytes, sizeOnly: true } as unknown as NetEntry);
            continue;
          }
          const u = new URL(r.name);
          const status = (r as PerformanceResourceTiming & { responseStatus?: number }).responseStatus;
          publish({
            id: newId(), t: Math.round(performance.timeOrigin + r.startTime), url: u.href, host: u.host, method: 'GET',
            source: currentSource(), status: status || 200, bytes: r.transferSize || r.encodedBodySize || undefined, ms: Math.round(r.duration),
          });
        }
        if (performance.getEntriesByType('resource').length > 800) performance.clearResourceTimings();
      }).observe({ type: 'resource', buffered: true });
    } catch {
      // Resource Timing unavailable: fetch and the Cache API are still covered.
    }
  }
}
