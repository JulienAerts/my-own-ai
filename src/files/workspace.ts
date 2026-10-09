// Workspace folders (desktop app): folders the user chose, which the assistant
// can list, read, search and — after asking — write. The Rust side
// (src-tauri/src/files.rs) keeps every path inside its folder. A folder can be
// indexed for meaning search: its documents go through the same pipeline as
// attached files (tagged with the folder, so they stay out of the library list).
import { useEffect, useState } from 'preact/hooks';
import { getSetting, newChatId, setSetting } from '../db';
import { isDesktopApp } from '../native';
import { extract, isSupportedDocument } from '../docs/extract';
import { ingest, removeDoc, searchDocs } from '../docs/store';
import type { ToolContext, ToolDef } from '../agent/tools';
import { t } from '../i18n/i18n';

export interface WorkspaceFolder {
  id: string;
  /** Short name the model uses ("Documents"). */
  name: string;
  path: string;
  /** Meaning-search index: document id and modification time per file. */
  index?: { files: Record<string, { docId: string; modified: number }>; at: number };
}

interface Entry { path: string; isDir: boolean; bytes: number; modified: number }

const MAX_READ = 20 * 2 ** 20;
const MAX_INDEX_FILES = 3000;

async function invoke<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(cmd, args);
}

// ---------------------------------------------------------------------------
// Config

let folders: WorkspaceFolder[] = [];
let loaded: Promise<void> | null = null;
const subs = new Set<() => void>();

function load(): Promise<void> {
  loaded ??= getSetting('folders').then((v) => { folders = v ?? []; }).catch(() => {});
  return loaded;
}

async function save(next: WorkspaceFolder[]) {
  folders = next;
  subs.forEach((fn) => fn());
  await setSetting('folders', next);
}

export function useFolders(): WorkspaceFolder[] {
  const [, bump] = useState(0);
  useEffect(() => {
    const fn = () => bump((n) => n + 1);
    subs.add(fn);
    load().then(fn);
    return () => void subs.delete(fn);
  }, []);
  return folders;
}

export async function listFolders(): Promise<WorkspaceFolder[]> {
  await load();
  return folders;
}

/** Ask Windows for a folder and add it. */
export async function pickFolder(): Promise<WorkspaceFolder | null> {
  const { open } = await import('@tauri-apps/plugin-dialog');
  const path = await open({ directory: true, multiple: false, title: 'Choose a folder for the assistant' });
  if (typeof path !== 'string') return null;
  await load();
  if (folders.some((f) => f.path === path)) return null;
  const base = path.split(/[\\/]/).filter(Boolean).pop() || path;
  let name = base;
  for (let i = 2; folders.some((f) => f.name.toLowerCase() === name.toLowerCase()); i++) name = `${base} ${i}`;
  const folder: WorkspaceFolder = { id: newChatId(), name, path };
  await save([...folders, folder]);
  return folder;
}

export async function removeFolder(id: string): Promise<void> {
  await load();
  const f = folders.find((x) => x.id === id);
  for (const { docId } of Object.values(f?.index?.files ?? {})) await removeDoc(docId).catch(() => {});
  await save(folders.filter((x) => x.id !== id));
}

export async function renameFolder(id: string, name: string): Promise<void> {
  await load();
  await save(folders.map((f) => (f.id === id ? { ...f, name: name.trim() || f.name } : f)));
}

// ---------------------------------------------------------------------------
// Files

const list = (f: WorkspaceFolder, path: string, recursive: boolean, limit: number) =>
  invoke<Entry[]>('fs_list', { root: f.path, path, recursive, limit });

async function readBytes(f: WorkspaceFolder, path: string): Promise<ArrayBuffer> {
  return invoke<ArrayBuffer>('fs_read', { root: f.path, path, maxBytes: MAX_READ });
}

const baseName = (p: string) => p.split('/').pop() ?? p;

/** A file's text: PDFs through the extractor, everything else as is (line breaks kept). */
async function readText(f: WorkspaceFolder, path: string): Promise<string> {
  const bytes = await readBytes(f, path);
  if (/\.pdf$/i.test(path)) {
    const file = new File([bytes], baseName(path), { type: 'application/pdf' });
    const { passages } = await extract(file);
    // Passages overlap a little; rebuild the text from their non-overlapping parts.
    return passages.map((p, i) => (i && p.page === passages[i - 1].page ? p.text.slice(80) : p.text)).join(' ');
  }
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  if (/\u0000/.test(text.slice(0, 2000))) throw new Error(`${path} is a binary file, not text.`);
  return text;
}

// ---------------------------------------------------------------------------
// Index (meaning search)

export type IndexProgress = (done: number, total: number, file: string) => void;

/** Index (or refresh) a folder's documents: new and changed files are read, deleted ones dropped. */
export async function indexFolder(id: string, onProgress?: IndexProgress): Promise<{ indexed: number; skipped: number }> {
  await load();
  const f = folders.find((x) => x.id === id);
  if (!f) throw new Error('Folder not found.');
  const entries = (await list(f, '', true, 20_000))
    .filter((e) => !e.isDir && e.bytes <= MAX_READ && isSupportedDocument(new File([], baseName(e.path))))
    .slice(0, MAX_INDEX_FILES);
  const old = f.index?.files ?? {};
  const files: Record<string, { docId: string; modified: number }> = {};
  const todo = entries.filter((e) => old[e.path]?.modified !== e.modified);
  for (const e of entries) if (old[e.path]?.modified === e.modified) files[e.path] = old[e.path];
  let skipped = 0;
  for (const [i, e] of todo.entries()) {
    onProgress?.(i, todo.length, e.path);
    try {
      if (old[e.path]) await removeDoc(old[e.path].docId).catch(() => {});
      const doc = await ingest(new File([await readBytes(f, e.path)], e.path), undefined, f.id);
      files[e.path] = { docId: doc.id, modified: e.modified };
    } catch {
      skipped++; // unreadable or empty (a scanned PDF without text, say)
    }
  }
  for (const [path, v] of Object.entries(old)) if (!entries.some((e) => e.path === path)) await removeDoc(v.docId).catch(() => {});
  onProgress?.(todo.length, todo.length, '');
  await load();
  await save(folders.map((x) => (x.id === id ? { ...x, index: { files, at: Date.now() } } : x)));
  return { indexed: Object.keys(files).length, skipped };
}

// ---------------------------------------------------------------------------
// Tools

function pick(name: string): WorkspaceFolder {
  const n = name.trim().toLowerCase();
  // A name must match; only an empty one means "the only folder".
  const f = n ? folders.find((x) => x.name.toLowerCase() === n) ?? folders.find((x) => x.name.toLowerCase().includes(n)) : folders.length === 1 ? folders[0] : undefined;
  if (!f) throw new Error(`No folder named "${name}". Folders: ${folders.map((x) => x.name).join(', ')}.`);
  return f;
}

const size = (b: number) => (b < 1024 ? `${b} B` : b < 2 ** 20 ? `${Math.round(b / 1024)} KB` : `${(b / 2 ** 20).toFixed(1)} MB`);
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}… [cut: ${text.length} characters in total]` : text);

/** The folder tools, when the desktop app has folders. Their descriptions name the folders. */
export function folderTools(): ToolDef[] {
  if (!isDesktopApp || !folders.length) return [];
  const names = folders.map((f) => `"${f.name}"`).join(', ');
  const folderParam = { description: `Folder: ${names}${folders.length === 1 ? ' (or "")' : ''}`, example: folders[0].name };
  return [
    {
      name: 'list_files',
      label: t('List files'),
      summary: t('See what is in your folders.'),
      service: t('Your folders'),
      description: `List the files and subfolders of one of the user's folders (${names}).`,
      params: { folder: folderParam, path: { description: 'Subfolder inside it, or "" for the top', example: '' } },
      run: async ({ folder, path }, ctx?: ToolContext) => {
        const f = pick(folder);
        const items = await list(f, path ?? '', false, 300);
        if (!items.length) return `${f.name}/${path ?? ''} is empty.`;
        const lines = items.map((e) => (e.isDir ? `📁 ${e.path}/` : `${e.path} (${size(e.bytes)}, ${day(e.modified)})`));
        return clip(`${f.name}/${path ? `${path}/` : ''}:\n${lines.join('\n')}`, ctx?.maxChars ?? 2400);
      },
    },
    {
      name: 'search_files',
      label: t('Find files'),
      summary: t('Find files by name in your folders.'),
      service: t('Your folders'),
      description: `Find files by name in the user's folders (${names}).`,
      params: { query: { description: 'Words in the file name', example: 'invoice 2025' }, folder: { ...folderParam, description: `${folderParam.description}, or "" for all` } },
      run: async ({ query, folder }, ctx?: ToolContext) => {
        const words = query.toLowerCase().split(/\s+/).filter(Boolean);
        const where = folder?.trim() ? [pick(folder)] : folders;
        const hits: string[] = [];
        for (const f of where) {
          for (const e of await list(f, '', true, 20_000)) {
            if (words.every((w) => e.path.toLowerCase().includes(w))) hits.push(`${f.name}/${e.path}${e.isDir ? '/' : ` (${size(e.bytes)}, ${day(e.modified)})`}`);
            if (hits.length >= 40) break;
          }
        }
        return hits.length ? clip(hits.join('\n'), ctx?.maxChars ?? 2400) : `No file name matches "${query}".`;
      },
    },
    {
      name: 'read_file',
      label: t('Read files'),
      summary: t('Read a file from your folders (text, PDF, CSV…).'),
      service: t('Your folders'),
      description: 'Read a file from one of the user\'s folders (text, Markdown, PDF, CSV, JSON, code…).',
      params: { folder: folderParam, path: { description: 'The file\'s path inside the folder', example: 'notes/todo.md' } },
      run: async ({ folder, path }, ctx?: ToolContext) => {
        const f = pick(folder);
        return clip(`${f.name}/${path}:\n${await readText(f, path)}`, Math.max(1500, (ctx?.maxChars ?? 2400) * 1.5));
      },
    },
    {
      name: 'search_folder',
      label: t('Search in files'),
      summary: t('Search inside the documents of an indexed folder.'),
      service: t('Your folders'),
      description: `Search inside the documents of the user's folders by meaning (indexed folders only: ${folders.filter((f) => f.index).map((f) => `"${f.name}"`).join(', ') || 'none yet'}).`,
      params: { query: { description: 'What to look for', example: 'notice period in the lease' }, folder: { ...folderParam, description: `${folderParam.description}, or "" for all` } },
      run: async ({ query, folder }, ctx?: ToolContext) => {
        const where = (folder?.trim() ? [pick(folder)] : folders).filter((f) => f.index);
        if (!where.length) return 'This folder isn\'t indexed yet (Settings → Connectors → Folders → Index). Use search_files and read_file instead.';
        const ids = where.flatMap((f) => Object.values(f.index!.files).map((v) => v.docId));
        return searchDocs(ids, query, { maxChars: ctx?.maxChars ?? 2400, k: 5 });
      },
    },
    {
      name: 'write_file',
      label: t('Write files'),
      summary: t('Save a text file in your folders (asks you first).'),
      service: t('Your folders'),
      description: 'Save text to a file in one of the user\'s folders (asks the user first). Use only when the user asks to save or create a file.',
      params: {
        folder: folderParam,
        path: { description: 'The file\'s path inside the folder', example: 'notes/summary.md' },
        content: { description: 'The full text to save', example: '# Summary' },
      },
      run: async ({ folder, path, content }, ctx?: ToolContext) => {
        const f = pick(folder);
        const exists = await invoke<boolean>('fs_exists', { root: f.path, path });
        const answer = ctx?.confirm
          ? await ctx.confirm({ server: t('Files'), tool: exists ? t('Replace {file}', { file: `${f.name}/${path}` }) : t('Create {file}', { file: `${f.name}/${path}` }), args: { content: content.length > 600 ? `${content.slice(0, 600)}…` : content }, everyTime: true })
          : 'deny';
        if (answer === 'deny') return { text: 'The user declined to save the file.', error: true };
        await invoke('fs_write', { root: f.path, path, content, overwrite: true });
        return `Saved ${f.name}/${path} (${content.length} characters).`;
      },
    },
  ];
}

/** Load the folders before tools are listed (call once). */
export function startFolders(): Promise<void> {
  return isDesktopApp ? load() : Promise.resolve();
}
