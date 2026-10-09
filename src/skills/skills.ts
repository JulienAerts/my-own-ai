// Skills: packaged know-how the model opens when a task needs it (the Agent
// Skills format: a folder with SKILL.md — YAML front matter `name` and
// `description`, then instructions — plus optional scripts and references).
// The prompt lists only names and descriptions; `use_skill` loads the
// instructions, `read_skill_file` a bundled file, and run_code sees the files
// under skills/<name>/. Stored in IndexedDB, so they work on every platform.
import { useEffect, useState } from 'preact/hooks';
import { allSkillRecords, deleteSkillRecord, newChatId, putSkillRecord, type SkillRecord } from '../db';
import type { ToolContext, ToolDef } from '../agent/tools';

export type Skill = SkillRecord;

const MAX_FILES_BYTES = 10 * 2 ** 20;

// ---------------------------------------------------------------------------
// Parsing

/** Front matter (a small YAML subset: `key: value`, quoted or not, `>`/`|` blocks) and body. */
export function parseSkillMd(text: string): { name?: string; description?: string; body: string } {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { body: text.trim() };
  const meta: Record<string, string> = {};
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    let value = kv[2].trim();
    if (value === '>' || value === '|' || value === '>-' || value === '|-') {
      const block: string[] = [];
      while (i + 1 < lines.length && /^\s+/.test(lines[i + 1])) block.push(lines[++i].trim());
      value = block.join(value.startsWith('>') ? ' ' : '\n');
    }
    meta[kv[1]] = value.replace(/^(['"])([\s\S]*)\1$/, '$2');
  }
  return { name: meta.name, description: meta.description, body: m[2].trim() };
}

const slug = (s: string) => s.toLowerCase().normalize('NFD').replace(/\p{Mn}/gu, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64);

/** A skill from a .zip (SKILL.md at the root or in one top folder) or a SKILL.md / .md file. */
export async function readSkillFile(file: File): Promise<Omit<Skill, 'id' | 'createdAt'>> {
  if (/\.zip$/i.test(file.name) || file.type === 'application/zip') {
    const { unzipSync } = await import('fflate');
    const entries = unzipSync(new Uint8Array(await file.arrayBuffer()));
    const paths = Object.keys(entries).filter((p) => !p.endsWith('/') && !p.startsWith('__MACOSX/'));
    const skillMd = paths.filter((p) => /(^|\/)SKILL\.md$/i.test(p)).sort((a, b) => a.length - b.length)[0];
    if (!skillMd) throw new Error('No SKILL.md in this zip.');
    const root = skillMd.slice(0, skillMd.length - 'SKILL.md'.length);
    const parsed = parseSkillMd(new TextDecoder().decode(entries[skillMd]));
    let total = 0;
    const files = paths
      .filter((p) => p.startsWith(root) && p !== skillMd)
      .map((p) => {
        const data = entries[p];
        total += data.byteLength;
        return { path: p.slice(root.length), data: data.slice().buffer as ArrayBuffer };
      });
    if (total > MAX_FILES_BYTES) throw new Error('This skill\'s files are over 10 MB.');
    return finish(parsed, root.replace(/\/$/, '').split('/').pop() || file.name.replace(/\.zip$/i, ''), files);
  }
  const parsed = parseSkillMd(await file.text());
  return finish(parsed, file.name.replace(/\.md$/i, '').replace(/^SKILL$/i, 'skill'), []);
}

function finish(p: ReturnType<typeof parseSkillMd>, fallbackName: string, files: Skill['files']): Omit<Skill, 'id' | 'createdAt'> {
  const name = slug(p.name || fallbackName) || 'skill';
  const description = (p.description ?? '').replace(/\s+/g, ' ').trim();
  if (!description) throw new Error('The skill has no description (its SKILL.md front matter needs one): the model uses it to know when to open the skill.');
  if (!p.body) throw new Error('The skill has no instructions.');
  return { name, description: description.slice(0, 1024), body: p.body, files, enabled: true };
}

// ---------------------------------------------------------------------------
// Store

let cache: Promise<Skill[]> | null = null;
const subs = new Set<() => void>();
const changed = () => { cache = null; subs.forEach((fn) => fn()); };

export function listSkills(): Promise<Skill[]> {
  cache ??= allSkillRecords().then((l) => l.sort((a, b) => a.name.localeCompare(b.name)), () => []);
  return cache;
}

export function useSkills(): Skill[] | null {
  const [list, setList] = useState<Skill[] | null>(null);
  useEffect(() => {
    const load = () => listSkills().then(setList);
    subs.add(load);
    load();
    return () => void subs.delete(load);
  }, []);
  return list;
}

/** Save a skill; one with the same name is replaced (an update). */
export async function saveSkill(s: Omit<Skill, 'id' | 'createdAt'> & { id?: string; createdAt?: number }): Promise<Skill> {
  const existing = (await listSkills()).find((x) => x.id === s.id || x.name === s.name);
  const full: Skill = { ...s, id: existing?.id ?? s.id ?? newChatId(), createdAt: existing?.createdAt ?? Date.now() } as Skill;
  await putSkillRecord(full);
  changed();
  return full;
}

export async function deleteSkill(id: string): Promise<void> {
  await deleteSkillRecord(id);
  changed();
}

export async function setSkillEnabled(id: string, enabled: boolean): Promise<void> {
  const s = (await listSkills()).find((x) => x.id === id);
  if (s) {
    await putSkillRecord({ ...s, enabled });
    changed();
  }
}

// ---------------------------------------------------------------------------
// For the model

const words = (s: string) => new Set(s.toLowerCase().normalize('NFD').replace(/\p{Mn}/gu, '').match(/[a-z0-9]{4,}/g) ?? []);

/**
 * Skills to list in the prompt: all enabled ones, or on a small context only
 * those sharing words with the message (up to 3).
 */
export async function skillsForTurn(message: string, contextWindow: number): Promise<{ name: string; description: string }[]> {
  const enabled = (await listSkills()).filter((s) => s.enabled);
  if (contextWindow > 2048 || enabled.length <= 2) return enabled.slice(0, 30).map(({ name, description }) => ({ name, description }));
  const q = words(message);
  return enabled
    .map((s) => ({ s, score: [...words(`${s.name.replace(/-/g, ' ')} ${s.description}`)].filter((w) => q.has(w)).length }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map(({ s }) => ({ name: s.name, description: s.description }));
}

async function find(name: string): Promise<Skill> {
  const n = slug(name);
  const s = (await listSkills()).find((x) => x.enabled && (x.name === n || x.name === name));
  if (!s) throw new Error(`No skill named "${name}".`);
  return s;
}

const isText = (path: string) => /\.(md|txt|py|js|ts|json|csv|tsv|ya?ml|html?|xml|css|sh|sql|ini|toml)$/i.test(path);

export const SKILL_TOOLS: ToolDef[] = [
  {
    name: 'use_skill',
    label: 'Use a skill',
    summary: 'Open a skill\'s instructions.',
    description: 'Read the full instructions of one of the listed skills before doing a task it covers.',
    params: { name: { description: 'The skill\'s name, as listed', example: 'meeting-notes' } },
    run: async ({ name }, ctx?: ToolContext) => {
      const s = await find(name);
      const budget = Math.max(1500, (ctx?.maxChars ?? 2400) * 2);
      const body = s.body.length > budget ? `${s.body.slice(0, budget)}… [cut: read_skill_file "SKILL.md" for the rest]` : s.body;
      const files = s.files.map((f) => f.path);
      return `Skill "${s.name}":\n${body}` +
        (files.length ? `\n\nFiles in this skill: ${files.join(', ')}. Read one with read_skill_file; run_code finds them under skills/${s.name}/.` : '');
    },
  },
  {
    name: 'read_skill_file',
    label: 'Read a skill file',
    summary: 'Read a file bundled with a skill.',
    description: 'Read a file bundled with a skill (a reference, a template or a script).',
    params: {
      name: { description: 'The skill\'s name', example: 'meeting-notes' },
      path: { description: 'The file\'s path inside the skill', example: 'template.md' },
    },
    run: async ({ name, path }, ctx?: ToolContext) => {
      const s = await find(name);
      if (/^SKILL\.md$/i.test(path)) return s.body;
      const f = s.files.find((x) => x.path === path || x.path.endsWith(`/${path}`));
      if (!f) throw new Error(`No file "${path}" in skill "${s.name}". Files: ${s.files.map((x) => x.path).join(', ') || 'none'}.`);
      if (!isText(f.path)) return `${f.path} is a binary file (${f.data.byteLength} bytes); run_code can open it at skills/${s.name}/${f.path}.`;
      const text = new TextDecoder().decode(f.data);
      const budget = Math.max(1500, (ctx?.maxChars ?? 2400) * 2);
      return text.length > budget ? `${text.slice(0, budget)}… [cut: ${text.length} characters in total]` : text;
    },
  },
];

/** Every enabled skill's files, for run_code (skills/<name>/<path>). */
export async function skillFilesForCode(): Promise<{ name: string; bytes: ArrayBuffer }[]> {
  return (await listSkills()).filter((s) => s.enabled).flatMap((s) => s.files.map((f) => ({ name: `skills/${s.name}/${f.path}`, bytes: f.data })));
}

/** A small skill to show how they work (Settings → Skills → Add the example). */
export const EXAMPLE_SKILL = `---
name: meeting-notes
description: Turn rough meeting notes or a transcript into a clear summary with decisions, action items and open questions. Use when the user shares meeting notes or asks to summarise a meeting.
---
# Meeting notes

Produce exactly these sections, in this order:

## Summary
Two or three sentences: what the meeting was about and its outcome.

## Decisions
A bullet list of what was decided. If nothing was decided, write "None recorded".

## Action items
A table with the columns **Owner**, **Task** and **Due**. Use "?" when the notes don't say.

## Open questions
A bullet list of what is still unresolved.

Rules:
- Keep the participants' own wording for decisions.
- Never invent owners or dates.
- Put dates in YYYY-MM-DD form.
`;
