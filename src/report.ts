// "Report a problem" (Settings → App): a GitHub issue filled in with what helps
// to reproduce a bug: version, system, device, model, recent GPU errors and, in
// the desktop app, the end of the engine's log. Never the conversations, memory
// or documents. The user sees and can edit all of it before anything is sent:
// the app only opens GitHub's form, and GitHub sends nothing until they submit.
import { bootState, device, nativeGpu } from './boot';
import { lang } from './i18n/i18n';
import { desktopOS, isAndroidApp, isDesktopApp } from './native';
import { engine } from './worker/client';

export const REPO_URL = 'https://github.com/JulienAerts/my-own-ai';
/** GitHub's new-issue page takes the text in the address, which has a size limit. */
const MAX_BODY = 6000;

const platform = () =>
  isDesktopApp ? `desktop app (${desktopOS})` : isAndroidApp ? 'Android app' : 'browser';

/** The diagnostics part of the report, in English (the issue tracker's language). */
export async function diagnostics(): Promise<string> {
  const s = bootState();
  const d = device;
  const lines = [
    `- Version: ${__APP_VERSION__} (${platform()}, interface: ${lang})`,
    `- Browser: ${navigator.userAgent}`,
  ];
  if (d) {
    lines.push(
      `- GPU (WebGPU): ${[d.gpu.vendor, d.gpu.architecture, d.gpu.description].filter(Boolean).join(' · ') || (d.gpu.adapter ? 'unknown' : 'none')}` +
        `; shader-f16: ${d.gpu.shaderF16 ? 'yes' : 'no'}; max binding: ${Math.round((d.gpu.maxStorageBufferBindingSize ?? 0) / 2 ** 20)} MB`,
      `- Memory: ${d.deviceMemory ?? '?'} GB; CPU threads: ${d.hardwareConcurrency ?? '?'}`,
    );
  }
  if (nativeGpu) lines.push(`- Native GPU: ${nativeGpu.name}, ${Math.round(nativeGpu.vramMB / 1024)} GB (${nativeGpu.engine ?? (nativeGpu.cuda ? 'cuda' : 'vulkan')})`);
  lines.push(`- Model: ${'modelId' in s ? `${s.modelId}${s.kind === 'ready' ? `, context ${s.contextWindow}` : ` (${s.kind})`}` : s.kind}`);
  if (s.kind === 'error') lines.push(`- Load error: ${s.message.slice(0, 400)}`);

  const gpu = await engine().gpuDiagnostics().catch(() => null);
  if (gpu?.errors.length) lines.push('', 'GPU errors:', '```', ...gpu.errors.slice(-5).map((e) => e.slice(0, 300)), '```');
  if (isDesktopApp) {
    const { invoke } = await import('@tauri-apps/api/core');
    const log = await invoke<string>('llama_log').catch(() => '');
    if (log.trim()) lines.push('', 'End of llama-server.log:', '```', log.trim().slice(-1500), '```');
  }
  return lines.join('\n');
}

/** The report's text: what the user describes, then the diagnostics. */
export async function reportBody(): Promise<string> {
  return [
    '**What happened**',
    '',
    '',
    '**Steps to reproduce**',
    '1. ',
    '',
    '**Diagnostics** (filled in by the app; no conversations, memory or documents)',
    await diagnostics(),
  ].join('\n');
}

/** GitHub's form for a new issue with this text. */
export function issueUrl(body: string, title = ''): string {
  const trimmed = body.length > MAX_BODY ? `${body.slice(0, MAX_BODY)}\n…(cut)` : body;
  const q = new URLSearchParams({ labels: 'bug', title, body: trimmed });
  return `${REPO_URL}/issues/new?${q}`;
}
