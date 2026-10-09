// Response versions: regenerating an answer or editing a question keeps what it
// replaces. The question that starts the turn holds every version of the
// conversation from there on (`versions`, each one beginning with its own copy
// of the question) and which one is shown (`version`). The open version lives in
// the conversation itself; its stored copy is refreshed when switching away.
import type { ChatEntry } from './agent/dialects';

type UserEntry = Extract<ChatEntry, { role: 'user' }>;
export type Versioned = UserEntry & { versions?: ChatEntry[][]; version?: number };

/** Versions kept per question; the oldest go first. */
const MAX_VERSIONS = 20;

const plain = (u: Versioned): UserEntry => {
  const { versions: _v, version: _n, ...rest } = u;
  return rest;
};

/** The tail from question `i` on, as stored in a version (its question without the version list). */
function snapshot(entries: ChatEntry[], i: number): ChatEntry[] {
  return [plain(entries[i] as Versioned), ...entries.slice(i + 1)];
}

/** Version info of the question at `i`, or null when it has only one. */
export function versionsAt(entries: ChatEntry[], i: number): { current: number; total: number } | null {
  const u = entries[i] as Versioned | undefined;
  if (u?.role !== 'user' || !u.versions || u.versions.length < 2) return null;
  return { current: u.version ?? u.versions.length - 1, total: u.versions.length };
}

/**
 * The conversation with question `i` replaced by `next` (a regeneration passes the same
 * question again, an edit a new one). Everything from `i` on is kept as a version; the
 * result ends with the new question, ready for its answer.
 */
export function replaceTurn(entries: ChatEntry[], i: number, next: UserEntry): ChatEntry[] {
  const old = entries[i] as Versioned | undefined;
  if (old?.role !== 'user') return [...entries.slice(0, i), next];
  const versions = [...(old.versions ?? [snapshot(entries, i)])];
  versions[old.version ?? versions.length - 1] = snapshot(entries, i);
  versions.push([plain(next)]);
  const kept = versions.slice(-MAX_VERSIONS);
  return [...entries.slice(0, i), { ...plain(next), versions: kept, version: kept.length - 1 } as ChatEntry];
}

/** Show version `target` of the question at `i` (what follows it changes with it). */
export function switchVersion(entries: ChatEntry[], i: number, target: number): ChatEntry[] {
  const u = entries[i] as Versioned | undefined;
  if (u?.role !== 'user' || !u.versions?.[target]) return entries;
  const versions = [...u.versions];
  versions[u.version ?? versions.length - 1] = snapshot(entries, i);
  const [head, ...tail] = versions[target];
  return [...entries.slice(0, i), { ...(head as UserEntry), versions, version: target } as ChatEntry, ...tail];
}

/**
 * Where each turn's version switcher goes: question index → the entry that shows it,
 * the turn's last answer (or the question itself when the turn has no answer).
 */
export function switcherPlaces(entries: ChatEntry[]): Map<number, number> {
  const at = new Map<number, number>();
  let q = -1;
  let answer = -1;
  const close = () => {
    if (q >= 0 && versionsAt(entries, q)) at.set(answer >= 0 ? answer : q, q);
  };
  entries.forEach((e, i) => {
    if (e.role === 'user') {
      close();
      q = i;
      answer = -1;
    } else if (e.role === 'assistant') answer = i;
  });
  close();
  return at;
}
