// Backup of conversations (and memory/instructions) as a JSON file, plus a
// readable Markdown export of one conversation. Browser storage can be wiped;
// these files are the user's copy. Nothing is uploaded anywhere.
import type { ChatEntry } from './agent/dialects';
import { addMemory, listMemories } from './memory/memory';
import { listAssistants, saveAssistant, DEFAULT_ASSISTANT, type Assistant } from './assistants/assistants';
import { listSkills, saveSkill } from './skills/skills';

const toBase64 = (buf: ArrayBuffer) => {
  let s = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
const fromBase64 = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer as ArrayBuffer;
import { getSetting, listConversations, loadChat, saveChat, setSetting, type ConversationMeta } from './db';
import { t } from './i18n/i18n';

const FORMAT = 'local-ai-backup';

interface Backup {
  format: typeof FORMAT;
  version: 1;
  exportedAt: string;
  conversations: { meta: ConversationMeta; entries: ChatEntry[] }[];
  /** Before memories were records (older backups). */
  notes?: string[];
  memories?: { text: string; pinned?: boolean; auto?: boolean; assistantId?: string; createdAt?: number }[];
  assistants?: Assistant[];
  /** Files as base64. */
  skills?: { name: string; description: string; body: string; enabled: boolean; files: { path: string; base64: string }[] }[];
  instructions?: string;
}

export function download(name: string, content: string, type: string): void {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const stamp = () => new Date().toISOString().slice(0, 10);

export async function exportAll(): Promise<number> {
  const metas = await listConversations();
  const backup: Backup = {
    format: FORMAT,
    version: 1,
    exportedAt: new Date().toISOString(),
    conversations: await Promise.all(metas.map(async (meta) => ({ meta, entries: await loadChat(meta.id) }))),
    assistants: (await listAssistants()).filter((a) => a.id !== DEFAULT_ASSISTANT.id),
    skills: (await listSkills()).map(({ name, description, body, enabled, files }) => ({ name, description, body, enabled, files: files.map((f) => ({ path: f.path, base64: toBase64(f.data) })) })),
    memories: (await listMemories()).map(({ text, pinned, auto, assistantId, createdAt }) => ({ text, pinned, auto, assistantId, createdAt })),
    instructions: (await getSetting('instructions')) ?? '',
  };
  download(`my-own-ai-backup-${stamp()}.json`, JSON.stringify(backup, null, 1), 'application/json');
  return metas.length;
}

function validEntry(e: unknown): e is ChatEntry {
  if (!e || typeof e !== 'object') return false;
  const x = e as Record<string, unknown>;
  if (typeof x.ts !== 'number') return false;
  if (x.role === 'user' || x.role === 'assistant') return typeof x.text === 'string';
  if (x.role === 'doc') return typeof x.docId === 'string' && typeof x.name === 'string';
  if (x.role === 'summary') return typeof x.text === 'string';
  if (x.role === 'memory') return Array.isArray(x.ids) && Array.isArray(x.texts);
  return x.role === 'tool' && typeof x.name === 'string' && typeof x.result === 'string' && !!x.args && typeof x.args === 'object';
}

export interface ImportResult {
  added: number;
  updated: number;
  skipped: number;
  notes: number;
}

/**
 * Merge a backup: new conversations are added, ones that exist here are
 * replaced only if the backup's copy is newer. Memory notes are merged;
 * instructions are restored only if none are set here.
 */
export async function importBackup(file: File): Promise<ImportResult> {
  let data: Backup;
  try {
    data = JSON.parse(await file.text());
  } catch {
    throw new Error(t('This file isn’t valid JSON.'));
  }
  if (data?.format !== FORMAT || !Array.isArray(data.conversations)) {
    throw new Error(t('This isn’t a My Own AI backup file.'));
  }
  const existing = new Map((await listConversations()).map((m) => [m.id, m]));
  const result: ImportResult = { added: 0, updated: 0, skipped: 0, notes: 0 };
  for (const c of data.conversations) {
    const id = c?.meta?.id;
    const entries = Array.isArray(c?.entries) ? c.entries.filter(validEntry) : [];
    if (typeof id !== 'string' || !entries.length) {
      result.skipped++;
      continue;
    }
    const here = existing.get(id);
    const last = entries[entries.length - 1].ts;
    if (here && here.updatedAt >= last) {
      result.skipped++;
      continue;
    }
    const m = c.meta as Partial<ConversationMeta>;
    await saveChat(id, entries, typeof m.assistantId === 'string' ? m.assistantId : undefined, {
      title: typeof m.title === 'string' ? m.title.slice(0, 120) : '',
      ...(m.renamed === true && { renamed: true }),
      ...(m.pinned === true && { pinned: true }),
    });
    if (here) result.updated++;
    else result.added++;
  }
  // Assistants: added when missing (by id); one already here is kept as it is.
  if (Array.isArray(data.assistants)) {
    const have = new Set((await listAssistants()).map((a) => a.id));
    for (const a of data.assistants) {
      if (a && typeof a.id === 'string' && typeof a.name === 'string' && !have.has(a.id)) {
        await saveAssistant({ ...a, emoji: a.emoji || '🤖', instructions: a.instructions ?? '', memory: a.memory === 'own' ? 'own' : 'shared' });
      }
    }
  }
  // Skills: added, or replacing the one with the same name.
  if (Array.isArray(data.skills)) {
    for (const s of data.skills) {
      if (!s || typeof s.name !== 'string' || typeof s.body !== 'string' || typeof s.description !== 'string') continue;
      await saveSkill({
        name: s.name, description: s.description, body: s.body, enabled: s.enabled !== false,
        files: Array.isArray(s.files) ? s.files.filter((f) => typeof f?.path === 'string' && typeof f.base64 === 'string').map((f) => ({ path: f.path, data: fromBase64(f.base64) })) : [],
      });
    }
  }
  // Memories (and older backups' notes): near-duplicates of existing ones only refresh them.
  const incoming = [
    ...(Array.isArray(data.memories) ? data.memories : []),
    ...(Array.isArray(data.notes) ? data.notes.map((text) => ({ text })) : []),
  ].filter((m): m is NonNullable<Backup['memories']>[number] => !!m && typeof m.text === 'string' && !!m.text.trim());
  for (const m of incoming) {
    const { updated } = await addMemory(m.text, { pinned: !!m.pinned, auto: !!m.auto, assistantId: typeof m.assistantId === 'string' ? m.assistantId : undefined });
    if (!updated) result.notes++;
  }
  if (typeof data.instructions === 'string' && data.instructions.trim() && !(await getSetting('instructions'))?.trim()) {
    await setSetting('instructions', data.instructions.slice(0, 600));
  }
  return result;
}

/** One conversation as readable Markdown. */
export async function exportMarkdown(meta: ConversationMeta): Promise<void> {
  const entries = await loadChat(meta.id);
  const lines = [`# ${meta.title}`, '', `_${new Date(meta.createdAt).toLocaleString()}, exported from My Own AI_`, ''];
  for (const e of entries) {
    if (e.role === 'user') lines.push(`**You:** ${e.image ? '🖼️ _(image)_ ' : ''}${e.text}`, '');
    else if (e.role === 'assistant') lines.push(`**Assistant:** ${e.text}`, '');
    else if (e.role === 'doc') lines.push(`📄 _Attached ${e.name}${e.pages ? ` (${e.pages} pages)` : ''}_`, '');
    else if (e.role === 'summary') lines.push(`> _Summary of the earlier messages:_ ${e.text}`, '');
    else if (e.role === 'memory') { if (!e.undone) lines.push(`> 🧠 _Memory updated: ${e.texts.join(' · ')}_`, ''); }
    else lines.push(`> 🔧 \`${e.name}(${Object.entries(e.args).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(', ')})\``, `> ${e.result.replace(/\n/g, '\n> ')}`, '');
  }
  const slug = meta.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'conversation';
  download(`${slug}.md`, lines.join('\n'), 'text/markdown');
}
