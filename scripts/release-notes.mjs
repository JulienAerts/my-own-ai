// Prints the CHANGELOG.md section of one version (without its heading), for the
// release page and the update the desktop app offers. Fails when there's none,
// so a release can't go out without saying what changed.
// Usage: node scripts/release-notes.mjs 0.20.0
import { readFileSync } from 'node:fs';

export function releaseNotes(changelog, version) {
  const sections = changelog.split(/^## /m).slice(1);
  const section = sections.find((s) => s.split(/[\s—]/, 1)[0] === version);
  return section ? section.slice(section.indexOf('\n') + 1).trim() : null;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const version = process.argv[2];
  const notes = releaseNotes(readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8'), version);
  if (!notes) {
    console.error(`CHANGELOG.md has no section "## ${version} — date". Add one before releasing.`);
    process.exit(1);
  }
  console.log(notes);
}
