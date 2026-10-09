// What changed in each version: CHANGELOG.md, bundled with the app (a few KB), and
// the notes of an update the desktop app offers (the release text, from the same file;
// see scripts/release-notes.mjs, which reads sections the same way).
import changelog from '../CHANGELOG.md?raw';
import { REPO_URL } from './report';

export const CHANGELOG_URL = `${REPO_URL}/blob/main/CHANGELOG.md`;

/** The text of one version's section ("## 0.19.2 — date"), or null. */
export function sectionOf(text: string, version: string): string | null {
  const section = text.split(/^## /m).slice(1).find((s) => s.split(/[\s—]/, 1)[0] === version);
  return section ? section.slice(section.indexOf('\n') + 1).trim() : null;
}

/** Release notes as items: one per bullet (its wrapped lines joined), or per paragraph. */
export function noteItems(notes: string | undefined): string[] {
  const text = (notes ?? '').split(/^---\s*$/m)[0]; // the release page's install help follows "---"
  const items: string[] = [];
  let cur: string | null = null;
  for (const line of text.split('\n')) {
    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    if (bullet) {
      if (cur) items.push(cur);
      cur = bullet[1].trim();
    } else if (line.trim()) cur = cur ? `${cur} ${line.trim()}` : line.trim();
    else if (cur) {
      items.push(cur);
      cur = null;
    }
  }
  if (cur) items.push(cur);
  return items;
}

/** The bundled notes of a version (the one running, after an update). */
export const notesFor = (version: string): string[] => noteItems(sectionOf(changelog, version) ?? '');
