// Client-only persistence. Nothing here is ever sent to a server.
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { ChatEntry } from './agent/dialects';

export interface Selection {
  modelId: string;
}

export interface PendingDownload {
  modelId: string;
  startedAt: number;
}

interface Settings {
  selection: Selection;
  wifiOnly: boolean;
  pendingDownload: PendingDownload;
  a2hsDismissed: boolean;
  /** Before v5: facts to remember (moved to the memories store, see memory/memory.ts). */
  notes: string[];
  /** Save durable facts about the user automatically after a conversation turn. */
  autoMemory: boolean;
  /** Dictation model in the browser and the Android app (src/stt.ts). */
  sttModel: 'phonon2' | 'parakeet3';
  /** Appearance pictures as data URLs ('' = none): the logo and the background. */
  logoImage: string;
  backgroundImage: string;
  /** The first-run welcome was completed (src/ui/FirstRun.tsx). */
  onboarded: boolean;
  /** Tools the user switched off in Settings → Tools. */
  disabledTools: string[];
  /** Custom instructions added to every system prompt. */
  instructions: string;
  /** The conversation open in Chat. */
  currentChat: string;
  /** Read aloud: "device" or a Piper voice id; device voiceURI; auto-read; speed. */
  ttsVoice: string;
  ttsDeviceVoice: string;
  ttsAuto: boolean;
  ttsRate: number;
  /** Models added from WebLLM's catalog or by link (models.ts ModelInfo with fixedId). */
  extraModels: import('./models').ModelInfo[];
  /** Desktop app: serve the llama.cpp model to other apps on a fixed port (native/backend.ts). */
  localApi: { enabled: boolean; port: number; key: string };
  /** Desktop app: let the assistant run the PC's own Python (asks every time). */
  nativePython: boolean;
  /** Hugging Face access token, for gated models (desktop; sent only to huggingface.co). */
  hfToken: string;
  /** GGUF models the user added from Hugging Face (native/custom.ts). */
  customGguf: import('./native/custom').CustomGguf[];
  /** Theme and style (ui/appearance.ts). */
  appearance: import('./ui/appearance').Appearance;
  /** Desktop app: close the window to the tray (default on). */
  keepInTray: boolean;
  /** Workspace folders the assistant may use (files/workspace.ts, desktop app). */
  folders: import('./files/workspace').WorkspaceFolder[];
  /** MCP connectors (mcp/mcp.ts). */
  mcpServers: import('./mcp/mcp').McpServerConfig[];
  /** Assistants the user made (assistants/assistants.ts); the built-in one isn't stored. */
  assistants: import('./assistants/assistants').Assistant[];
  /** Reasoning models (Qwen3) think before answering; the Think switch in Chat. */
  thinking: boolean;
  /** Temperature, top-p, answer length and context size, per model id (agent/genPrefs.ts). */
  generation: Record<string, import('./agent/genPrefs').GenSettings>;
}

/** List entry for the history panel; the messages live in `chats` under the same id. */
export interface ConversationMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: number;
  /** The assistant the conversation is with; unset = the built-in one. */
  assistantId?: string;
}

/** A document added to a conversation (see src/docs/store.ts). */
export interface DocRecord {
  id: string;
  name: string;
  size: number;
  pages?: number;
  addedAt: number;
  passages: { text: string; page?: number }[];
  /** passages.length × 384 MiniLM embeddings; absent if the model couldn't run. */
  vectors?: Float32Array;
  /** The original file (up to 10 MB), so code can read it (run_code). */
  raw?: ArrayBuffer;
  /** Indexed from a workspace folder (files/workspace.ts): not listed in the document library. */
  folderId?: string;
}

/** Something the assistant remembers about the user (memory/memory.ts). */
export interface MemoryRecord {
  id: string;
  text: string;
  createdAt: number;
  updatedAt: number;
  /** Always in the prompt, whatever the question. */
  pinned?: boolean;
  /** Saved by automatic memory, not on request. */
  auto?: boolean;
  /** The assistant it belongs to; unset = shared by all. */
  assistantId?: string;
  /** The conversation it came from. */
  source?: { chatId: string; title?: string };
  /** A fact that will soon be over (a trip, an exam): forgotten after this time (ms). */
  until?: number;
  /** MiniLM embedding (384), when the search model is installed. */
  vector?: Float32Array;
}

/** A skill: instructions (and files) the model opens when a task needs them (skills/skills.ts). */
export interface SkillRecord {
  id: string;
  /** Short identifier, as in SKILL.md ("meeting-notes"). */
  name: string;
  /** When to use it: the model sees only this until it opens the skill. */
  description: string;
  /** SKILL.md without its front matter. */
  body: string;
  /** Bundled files (scripts, references, templates), by path inside the skill. */
  files: { path: string; data: ArrayBuffer }[];
  enabled: boolean;
  createdAt: number;
}

interface HarnessDB extends DBSchema {
  settings: { key: keyof Settings; value: Settings[keyof Settings] };
  /** Messages of one conversation per id. */
  chats: { key: string; value: ChatEntry[] };
  conversations: { key: string; value: ConversationMeta };
  docs: { key: string; value: DocRecord };
  memories: { key: string; value: MemoryRecord };
  skills: { key: string; value: SkillRecord };
}

let dbp: Promise<IDBPDatabase<HarnessDB>> | null = null;

function db() {
  dbp ??= openDB<HarnessDB>('harness', 6, {
    upgrade(d, oldVersion) {
      if (oldVersion < 1) d.createObjectStore('settings');
      if (oldVersion < 2) d.createObjectStore('chats');
      // v3: many conversations. The single v2 chat ("default") is indexed lazily by listConversations().
      if (oldVersion < 3) d.createObjectStore('conversations', { keyPath: 'id' });
      if (oldVersion < 4) d.createObjectStore('docs', { keyPath: 'id' });
      // v5: memories as records (the old `notes` setting is migrated on first read).
      if (oldVersion < 5) d.createObjectStore('memories', { keyPath: 'id' });
      if (oldVersion < 6) d.createObjectStore('skills', { keyPath: 'id' });
    },
  });
  return dbp;
}

export async function getSetting<K extends keyof Settings>(key: K): Promise<Settings[K] | undefined> {
  return (await db()).get('settings', key) as Promise<Settings[K] | undefined>;
}

export async function setSetting<K extends keyof Settings>(key: K, value: Settings[K]): Promise<void> {
  await (await db()).put('settings', value, key);
}

export async function deleteSetting(key: keyof Settings): Promise<void> {
  await (await db()).delete('settings', key);
}

const TITLE_MAX = 60;

function titleOf(entries: ChatEntry[]): string {
  const first = entries.find((e) => e.role === 'user');
  const doc = entries.find((e) => e.role === 'doc');
  const t = first && 'text' in first ? first.text.replace(/\s+/g, ' ').trim() : doc && 'name' in doc ? doc.name : 'New conversation';
  return t.length > TITLE_MAX ? `${t.slice(0, TITLE_MAX - 1)}…` : t;
}

export function newChatId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export async function loadChat(id: string): Promise<ChatEntry[]> {
  return (await (await db()).get('chats', id)) ?? [];
}

/**
 * Save messages and refresh the history entry. An empty conversation is removed.
 * `assistantId` is recorded once (a conversation keeps its assistant).
 */
export async function saveChat(id: string, entries: ChatEntry[], assistantId?: string): Promise<void> {
  const d = await db();
  const tx = d.transaction(['chats', 'conversations'], 'readwrite');
  if (!entries.length) {
    await Promise.all([tx.objectStore('chats').delete(id), tx.objectStore('conversations').delete(id), tx.done]);
    return;
  }
  const prev = await tx.objectStore('conversations').get(id);
  const last = entries[entries.length - 1].ts || Date.now();
  await Promise.all([
    tx.objectStore('chats').put(entries, id),
    tx.objectStore('conversations').put({
      id,
      title: prev?.title && prev.messages > 0 ? prev.title : titleOf(entries),
      createdAt: prev?.createdAt ?? (entries[0].ts || last),
      updatedAt: last,
      messages: entries.filter((e) => e.role === 'user' || e.role === 'assistant').length,
      ...((prev?.assistantId ?? assistantId) && { assistantId: prev?.assistantId ?? assistantId }),
    }),
    tx.done,
  ]);
}

export async function getConversation(id: string): Promise<ConversationMeta | undefined> {
  return (await db()).get('conversations', id);
}

/** All conversations, most recent first. */
export async function listConversations(): Promise<ConversationMeta[]> {
  const d = await db();
  let metas = await d.getAll('conversations');
  // Index chats saved before v3 (the old single "default" conversation).
  const indexed = new Set(metas.map((m) => m.id));
  const orphans = (await d.getAllKeys('chats')).filter((k) => !indexed.has(k));
  for (const id of orphans) {
    const entries = await loadChat(id);
    if (entries.length) await saveChat(id, entries);
    else await d.delete('chats', id);
  }
  if (orphans.length) metas = await d.getAll('conversations');
  return metas.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function deleteChat(id: string): Promise<void> {
  await saveChat(id, []);
}

export async function deleteAllChats(): Promise<void> {
  const d = await db();
  const tx = d.transaction(['chats', 'conversations'], 'readwrite');
  await Promise.all([tx.objectStore('chats').clear(), tx.objectStore('conversations').clear(), tx.done]);
}

export async function allSkillRecords(): Promise<SkillRecord[]> {
  return (await db()).getAll('skills');
}

export async function putSkillRecord(s: SkillRecord): Promise<void> {
  await (await db()).put('skills', s);
}

export async function deleteSkillRecord(id: string): Promise<void> {
  await (await db()).delete('skills', id);
}

export async function allMemoryRecords(): Promise<MemoryRecord[]> {
  return (await db()).getAll('memories');
}

export async function putMemoryRecord(m: MemoryRecord): Promise<void> {
  await (await db()).put('memories', m);
}

export async function deleteMemoryRecord(id: string): Promise<void> {
  await (await db()).delete('memories', id);
}

export async function clearMemoryRecords(): Promise<void> {
  await (await db()).clear('memories');
}

export async function putDoc(doc: DocRecord): Promise<void> {
  await (await db()).put('docs', doc);
}

export async function getDoc(id: string): Promise<DocRecord | undefined> {
  return (await db()).get('docs', id);
}

export async function allDocs(): Promise<DocRecord[]> {
  return (await db()).getAll('docs');
}

export async function deleteDoc(id: string): Promise<void> {
  await (await db()).delete('docs', id);
}
