// Code execution for the run_code tool. Model-written code runs in a worker
// inside a sandboxed iframe:
//  - `sandbox="allow-scripts"` without allow-same-origin gives it an opaque
//    origin, so it can't read the app's IndexedDB (chats, documents, memory),
//    caches or cookies, nor touch the page;
//  - a Content-Security-Policy blocks every request except the Pyodide CDN
//    (Python and its packages), so code can't send anything anywhere;
//  - the code runs in a worker, so an endless loop can't freeze the app: past
//    the time limit, the iframe is removed and the next run starts fresh.
// Variables persist between runs of one conversation, like a notebook.
import { addNetEntry } from '../net/netlog';
import runnerSource from './runner.worker.js?raw';

export type Language = 'python' | 'javascript';

export interface RunFile {
  name: string;
  bytes: ArrayBuffer;
}

export interface RunResult {
  /** Printed output (stdout, stderr, console.*). */
  output: string;
  /** Value of the last expression (Python) or of `return` (JavaScript). */
  value?: string;
  /** Charts (matplotlib figures) as PNG data URLs. */
  images: string[];
  error?: string;
  timedOut?: boolean;
}

const CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob: https://cdn.jsdelivr.net",
  'worker-src blob:',
  'connect-src https://cdn.jsdelivr.net',
].join('; ');

// Relays messages between the app and the runner worker.
const RELAY = `<!doctype html><meta http-equiv="Content-Security-Policy" content="${CSP}"><script>
let worker;
addEventListener('message', (e) => {
  if (e.source !== parent) return;
  if (e.data.type === 'init') {
    try {
      worker = new Worker(URL.createObjectURL(new Blob([e.data.source], { type: 'text/javascript' })));
    } catch (err) {
      parent.postMessage({ type: 'crash', message: 'The code runner could not start: ' + err.message }, '*');
      return;
    }
    worker.onmessage = (m) => parent.postMessage(m.data, '*');
    worker.onerror = (err) => { err.preventDefault(); parent.postMessage({ type: 'crash', message: err.message || 'The code runner crashed.' }, '*'); };
    parent.postMessage({ type: 'ready' }, '*');
  } else if (worker) worker.postMessage(e.data);
});
<\/script>`;

/** Longest a run may take once its code starts (loading Python doesn't count). */
const RUN_TIMEOUT_MS = 30_000;
/** Longest the first Python download may take on a slow connection. */
const LOAD_TIMEOUT_MS = 180_000;

interface Pending {
  resolve(r: RunResult): void;
  onStatus?(text: string): void;
  /** Restarts the clock when the code itself starts. */
  running(): void;
}

let frame: HTMLIFrameElement | null = null;
let ready: Promise<void> | null = null;
let readyResolve: (() => void) | null = null;
let readyReject: ((e: Error) => void) | null = null;
const pending = new Map<number, Pending>();
let nextId = 1;

addEventListener('message', (e) => {
  if (!frame || e.source !== frame.contentWindow) return;
  const m = e.data as { type: string; id?: number; text?: string; message?: string } & Partial<RunResult>;
  if (m.type === 'ready') readyResolve?.();
  else if (m.type === 'crash') {
    readyReject?.(new Error(m.message));
    finishAll({ output: '', images: [], error: m.message ?? 'The code runner crashed.' });
    resetSandbox();
  } else if (m.type === 'net') {
    for (const r of (m as unknown as { entries: { url: string; t: number; ms: number; bytes?: number; status: number }[] }).entries ?? []) {
      if (typeof r.url === 'string' && r.url.startsWith('https://cdn.jsdelivr.net/')) addNetEntry({ ...r, method: 'GET', source: 'Code sandbox (Python)' });
    }
  } else if (m.type === 'status') {
    for (const p of pending.values()) {
      p.onStatus?.(m.text ?? '');
      if (m.text === 'Running…') p.running();
    }
  } else if (m.type === 'done' && m.id !== undefined) {
    const p = pending.get(m.id);
    pending.delete(m.id);
    p?.resolve({ output: m.output ?? '', value: m.value, images: m.images ?? [], error: m.error });
  }
});

function finishAll(r: RunResult) {
  for (const p of pending.values()) p.resolve(r);
  pending.clear();
}

function ensure(): Promise<void> {
  if (ready && frame?.isConnected) return ready;
  if (frame) resetSandbox(); // removed from the page behind our back
  frame = document.createElement('iframe');
  frame.sandbox.add('allow-scripts');
  frame.srcdoc = RELAY;
  frame.hidden = true;
  frame.title = 'Code sandbox';
  const f = frame;
  ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
    f.addEventListener('load', () => f.contentWindow?.postMessage({ type: 'init', source: runnerSource }, '*'), { once: true });
    setTimeout(() => reject(new Error('The code runner did not start.')), 10_000);
  });
  document.body.append(frame);
  ready.catch(() => resetSandbox());
  return ready;
}

/** Forget variables and stop anything running (a new conversation, or a timeout). */
export function resetSandbox(): void {
  frame?.remove();
  frame = null;
  ready = null;
  readyResolve = readyReject = null;
  finishAll({ output: '', images: [], error: 'The code runner was restarted.' });
}

export async function runCode(language: Language, code: string, files: RunFile[], onStatus?: (text: string) => void): Promise<RunResult> {
  await ensure();
  const id = nextId++;
  return new Promise<RunResult>((resolve) => {
    let timer = 0;
    const arm = (ms: number) => {
      clearTimeout(timer);
      timer = window.setTimeout(() => {
        pending.delete(id);
        resolve({ output: '', images: [], timedOut: true, error: `Stopped after ${Math.round(ms / 1000)} seconds (time limit).` });
        resetSandbox(); // the only way to stop a busy worker
      }, ms);
    };
    pending.set(id, {
      resolve: (r) => { clearTimeout(timer); resolve(r); },
      onStatus,
      running: () => arm(RUN_TIMEOUT_MS),
    });
    arm(language === 'python' ? LOAD_TIMEOUT_MS : RUN_TIMEOUT_MS);
    frame!.contentWindow!.postMessage({ id, language, code, files }, '*');
  });
}
