// Runs model-written code. This file is loaded as text (?raw) and started as a
// blob worker inside the sandboxed iframe (see sandbox.ts): it has an opaque
// origin (no access to the app's storage) and a CSP that only allows the
// Pyodide CDN. Plain JavaScript, not bundled.
const PYODIDE = 'https://cdn.jsdelivr.net/pyodide/v0.29.5/full/';
const MAX_OUTPUT = 100_000;

let python = null;

// What this worker downloads (Python and its packages, from the CDN the CSP
// allows) goes to the app's network activity: the sandbox can't reach it otherwise.
try {
  new PerformanceObserver((list) => {
    const entries = list.getEntries().map((r) => ({
      url: r.name, t: Math.round(performance.timeOrigin + r.startTime), ms: Math.round(r.duration),
      bytes: r.transferSize || r.encodedBodySize || undefined, status: r.responseStatus || 200,
    }));
    if (entries.length) postMessage({ type: 'net', entries });
  }).observe({ type: 'resource', buffered: true });
} catch {
  // No Resource Timing: nothing to report.
}

function status(text) {
  postMessage({ type: 'status', text });
}

function loadPython() {
  python ??= (async () => {
    status('Loading Python (about 12 MB the first time)…');
    importScripts(PYODIDE + 'pyodide.js');
    const py = await loadPyodide({ indexURL: PYODIDE });
    py.FS.mkdirTree('/data');
    py.FS.chdir('/data');
    return py;
  })();
  python.catch(() => { python = null; });
  return python;
}

// Saves open matplotlib figures as PNG data URLs, then closes them.
const FIGURES = `
def _local_ai_figures():
    import sys
    if 'matplotlib.pyplot' not in sys.modules:
        return []
    import base64, io
    import matplotlib.pyplot as plt
    out = []
    for n in plt.get_fignums():
        buf = io.BytesIO()
        plt.figure(n).savefig(buf, format='png', dpi=110, bbox_inches='tight')
        out.append('data:image/png;base64,' + base64.b64encode(buf.getvalue()).decode())
    plt.close('all')
    return out
_local_ai_figures()
`;

async function runPython(code, files, out) {
  const py = await loadPython();
  for (const f of files) {
    const path = '/data/' + f.name;
    py.FS.mkdirTree(path.slice(0, path.lastIndexOf('/'))); // skills/<name>/scripts/…
    py.FS.writeFile(path, new Uint8Array(f.bytes));
  }
  py.setStdout({ batched: (s) => out.push(s) });
  py.setStderr({ batched: (s) => out.push(s) });
  await py.loadPackagesFromImports(code, { messageCallback: (m) => /^Loading/.test(m) && status(m), errorCallback: () => {} });
  if (/\bmatplotlib\b|\bpandas\b.*\.plot\(/s.test(code)) {
    await py.loadPackage('matplotlib', { messageCallback: (m) => /^Loading/.test(m) && status(m), errorCallback: () => {} });
    await py.runPythonAsync("import matplotlib\nmatplotlib.use('agg')");
  }
  status('Running…');
  let value = await py.runPythonAsync(code);
  if (value !== undefined && value !== null) {
    const shown = typeof value === 'object' && typeof value.toString === 'function' ? value.toString() : String(value);
    value?.destroy?.();
    value = shown;
  } else value = undefined;
  const figures = py.runPython(FIGURES);
  const images = figures.toJs();
  figures.destroy();
  // plt.title(...) and friends return objects nobody wants to read once the chart is shown.
  if (images.length && value && /^(Text|Line2D|\[<matplotlib|<matplotlib|<Axes|Axes\()/.test(value)) value = undefined;
  return { value, images };
}

async function runJavaScript(code, files, out) {
  const fmt = (a) => (typeof a === 'string' ? a : (() => { try { return JSON.stringify(a, null, 2) ?? String(a); } catch { return String(a); } })());
  const log = (...a) => out.push(a.map(fmt).join(' '));
  const console = { log, info: log, warn: log, error: log, debug: log, table: (t) => log(t) };
  // Attached files: text by name, and their bytes.
  const decoder = new TextDecoder();
  const fileText = Object.fromEntries(files.map((f) => [f.name, decoder.decode(f.bytes)]));
  const fileBytes = Object.fromEntries(files.map((f) => [f.name, new Uint8Array(f.bytes)]));
  const AsyncFunction = (async () => {}).constructor;
  status('Running…');
  const value = await new AsyncFunction('console', 'files', 'fileBytes', code)(console, fileText, fileBytes);
  return { value: value === undefined ? undefined : fmt(value), images: [] };
}

self.onmessage = async ({ data }) => {
  const { id, language, code, files } = data;
  const out = [];
  try {
    const r = language === 'python' ? await runPython(code, files, out) : await runJavaScript(code, files, out);
    postMessage({ type: 'done', id, output: out.join('\n').slice(0, MAX_OUTPUT), value: r.value, images: r.images });
  } catch (e) {
    let message = (e && (e.message || String(e))) || 'Unknown error';
    // Python tracebacks: drop Pyodide's own frames, keep the user's code.
    const own = message.indexOf('  File "<exec>"');
    if (own > 0) message = 'Traceback (most recent call last):\n' + message.slice(own);
    postMessage({ type: 'done', id, output: out.join('\n').slice(0, MAX_OUTPUT), error: message.slice(-4000) });
  }
};
