// GGUF models the user adds from Hugging Face (desktop, llama.cpp). Paste a
// repository or file link: the app lists its quantizations (split files
// grouped), finds the image encoder, and reads the chat template to decide how
// to talk to it: "<think>" → a thinking model (Qwen-style tool calls), else
// JSON tool calls, which llama.cpp can enforce on any model. Gated repositories
// need the user's Hugging Face token (Settings → Model).
import { getSetting, setSetting } from '../db';
import { tauriFetch } from '../net/http';
import type { ModelInfo } from '../models';
import { hfToken, type GgufFile, type NativeModel } from './backend';
import { isDesktopApp } from '../native';
import { t } from '../i18n/i18n';

export interface CustomGguf {
  id: string;
  /** "owner/name" on Hugging Face. */
  repo: string;
  name: string;
  /** Quantization label ("Q4_K_M"). */
  quant: string;
  /** First (or only) weights file, by its path in the repository. */
  file: string;
  bytes: number;
  parts?: { file: string; bytes: number }[];
  mmproj?: { file: string; bytes: number };
  /** Parameters, from the GGUF metadata (for the context estimate). */
  params?: number;
  reasoning: boolean;
  contextLength?: number;
}

export interface Quant { label: string; file: string; bytes: number; parts: { file: string; bytes: number }[] }

export interface RepoInfo {
  repo: string;
  name: string;
  gated: boolean;
  architecture?: string;
  params?: number;
  contextLength?: number;
  reasoning: boolean;
  mmproj?: { file: string; bytes: number };
  quants: Quant[];
}

const HF = 'https://huggingface.co';

async function hfFetch(path: string): Promise<Response> {
  // The desktop app's own HTTP client; elsewhere (tests) the page's fetch, which Hugging Face's API allows.
  const token = isDesktopApp ? await hfToken() : null;
  const init: RequestInit = { headers: token ? { Authorization: `Bearer ${token}` } : {} };
  return isDesktopApp ? tauriFetch(`${HF}${path}`, init, 'Hugging Face model lookup') : fetch(`${HF}${path}`, init);
}

/** "owner/name" from a Hugging Face link (repository, file or folder page) or a bare id. */
export function repoFromLink(link: string): { repo: string; file?: string } | null {
  const t = link.trim().replace(/[?#].*$/, '');
  const m = /^(?:(?:https?:\/\/)?(?:www\.)?huggingface\.co\/)?([\w.-]+\/[\w.-]+)(?:\/(?:blob|resolve|tree)\/[^/]+\/(.+))?\/?$/.exec(t);
  if (!m || m[1].startsWith('api/')) return null;
  return { repo: m[1], file: m[2] && /\.gguf$/i.test(m[2]) ? decodeURIComponent(m[2]) : undefined };
}

const QUANT = /(?:^|[-_.])((?:I?Q\d(?:_[A-Z0-9]+)*)|F16|BF16|F32)(?=[-_.]|$)/i;
const SPLIT = /-(\d{5})-of-(\d{5})\.gguf$/i;

/** List a repository's GGUF quantizations, its image encoder, and what its template says. */
export async function inspectRepo(link: string): Promise<RepoInfo> {
  const parsed = repoFromLink(link);
  if (!parsed) throw new Error(t('Paste a Hugging Face link, like https://huggingface.co/owner/Model-GGUF.'));
  const info = await hfFetch(`/api/models/${parsed.repo}`);
  if (info.status === 404) throw new Error(t('No model “{repo}” on Hugging Face (or it is private).', { repo: parsed.repo }));
  if (!info.ok) throw new Error(t('Hugging Face answered {status}.', { status: info.status }));
  const meta = (await info.json()) as { gated?: false | string; gguf?: { architecture?: string; total?: number; context_length?: number; chat_template?: string } };
  const tree = await hfFetch(`/api/models/${parsed.repo}/tree/main?recursive=true`);
  if (tree.status === 401 || tree.status === 403) throw new Error(t('This repository is gated: accept its terms on Hugging Face, then add your token below.'));
  if (!tree.ok) throw new Error(t('Couldn’t list the files (Hugging Face answered {status}).', { status: tree.status }));
  const files = ((await tree.json()) as { path: string; size?: number; lfs?: { size?: number } }[])
    .filter((f) => /\.gguf$/i.test(f.path))
    .map((f) => ({ file: f.path, bytes: f.lfs?.size ?? f.size ?? 0 }));
  if (!files.length) throw new Error(t('This repository has no GGUF files. Look for a “-GGUF” version of the model.'));

  const encoders = files.filter((f) => /mmproj/i.test(f.file));
  const mmproj = encoders.find((f) => /f16/i.test(f.file) && !/bf16/i.test(f.file)) ?? encoders[0];
  // Split models: group "-00001-of-0000N" parts under the first.
  const groups = new Map<string, Quant>();
  for (const f of files.filter((x) => !/mmproj/i.test(x.file)).sort((a, b) => a.file.localeCompare(b.file))) {
    const split = SPLIT.exec(f.file);
    const key = split ? f.file.replace(SPLIT, '') : f.file;
    const label = QUANT.exec(f.file.split('/').pop()!.replace(SPLIT, '.gguf'))?.[1]?.toUpperCase() ?? f.file.split('/').pop()!.replace(/\.gguf$/i, '');
    const g = groups.get(key);
    if (!g) groups.set(key, { label, file: f.file, bytes: f.bytes, parts: [] });
    else { g.parts.push(f); g.bytes += f.bytes; }
  }
  let quants = [...groups.values()].sort((a, b) => a.bytes - b.bytes);
  if (parsed.file) quants = quants.filter((q) => q.file === parsed.file || q.parts.some((p) => p.file === parsed.file)).concat(quants.filter((q) => q.file !== parsed.file));
  const name = parsed.repo.split('/')[1].replace(/[-_]GGUF$/i, '').replace(/[-_]/g, ' ');
  return {
    repo: parsed.repo,
    name,
    gated: !!meta.gated,
    architecture: meta.gguf?.architecture,
    params: meta.gguf?.total,
    contextLength: meta.gguf?.context_length,
    reasoning: !!meta.gguf?.chat_template?.includes('<think>'),
    mmproj,
    quants,
  };
}

/** The quantization to suggest: Q4_K_M (or the closest 4-bit) when it fits, else the biggest that fits. */
export function suggestedQuant(quants: Quant[], fits: (q: Quant) => boolean): Quant | undefined {
  const ok = quants.filter(fits);
  return ok.find((q) => q.label === 'Q4_K_M') ?? ok.find((q) => /^(I?Q4)/.test(q.label)) ?? ok.at(-1);
}

// ---------------------------------------------------------------------------
// Saved models, as native models

/** Local file name: prefixed by the repository, since many share names like "mmproj-F16.gguf". */
const localName = (repo: string, path: string) => `${repo.replace(/[^\w.-]+/g, '_')}--${path.split('/').pop()}`;
const url = (repo: string, path: string) => `${HF}/${repo}/resolve/main/${path.split('/').map(encodeURIComponent).join('/')}`;

/** KV cache per token, estimated from the size (no layer counts in the API): errs on the large side. */
function kvEstimate(params = 8e9): number {
  const b = params / 1e9;
  return b <= 4 ? 115_000 : b <= 9 ? 147_000 : b <= 15 ? 164_000 : b <= 35 ? 262_000 : 330_000;
}

export function toNativeModel(c: CustomGguf): NativeModel {
  const file = (path: string, bytes: number): GgufFile => ({ url: url(c.repo, path), file: localName(c.repo, path), bytes });
  const main = file(c.file, c.bytes - (c.parts ?? []).reduce((n, p) => n + p.bytes, 0));
  const model: ModelInfo = {
    family: c.repo,
    fixedId: `gguf:custom:${c.repo}:${c.quant}`,
    displayName: `${c.name} · ${c.quant}`,
    params: c.params ? `${Math.round(c.params / 1e9)}B` : '',
    downloadMB: Math.round((c.bytes + (c.mmproj?.bytes ?? 0)) / 2 ** 20),
    vramMB: 0,
    hermes: c.reasoning,
    reasoning: c.reasoning || undefined,
    vision: c.mmproj ? true : undefined,
    tier: 'medium',
    maxTensorBytes: 0,
    maxContext: Math.min(c.contextLength ?? 32768, 262144),
    source: 'custom',
  };
  return {
    ...model,
    engine: 'llama',
    gguf: {
      ...main,
      kvPerToken: kvEstimate(c.params),
      parts: (c.parts ?? []).map((p) => file(p.file, p.bytes)),
      mmproj: c.mmproj ? file(c.mmproj.file, c.mmproj.bytes) : undefined,
    },
  };
}

export async function customModels(): Promise<CustomGguf[]> {
  return (await getSetting('customGguf').catch(() => undefined)) ?? [];
}

export async function addCustomModel(info: RepoInfo, q: Quant): Promise<CustomGguf> {
  const c: CustomGguf = {
    id: `gguf:custom:${info.repo}:${q.label}`,
    repo: info.repo,
    name: info.name,
    quant: q.label,
    file: q.file,
    bytes: q.bytes,
    parts: q.parts.length ? q.parts : undefined,
    mmproj: info.mmproj,
    params: info.params,
    reasoning: info.reasoning,
    contextLength: info.contextLength,
  };
  const list = (await customModels()).filter((x) => x.id !== c.id);
  await setSetting('customGguf', [...list, c]);
  return c;
}

export async function removeCustomModel(id: string): Promise<void> {
  await setSetting('customGguf', (await customModels()).filter((x) => x.id !== id));
}

export async function setHfToken(token: string): Promise<void> {
  await setSetting('hfToken', token.trim());
}
