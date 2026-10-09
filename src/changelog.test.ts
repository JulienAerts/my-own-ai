import { describe, expect, it } from 'vitest';
import changelog from '../CHANGELOG.md?raw';
import { noteItems, notesFor, sectionOf } from './changelog';
// @ts-expect-error: a plain Node script, without types
import { releaseNotes } from '../scripts/release-notes.mjs';

describe('changelog', () => {
  it('has a dated section per version, newest first', () => {
    const versions = [...changelog.matchAll(/^## (\S+) — (\d{4}-\d{2}-\d{2})$/gm)].map((m) => m[1]);
    expect(versions.length).toBeGreaterThan(30);
    expect(changelog.match(/^## /gm)).toHaveLength(versions.length);
    const key = (v: string) => v.split('.').map(Number).reduce((n, x) => n * 1000 + x, 0);
    expect([...versions].sort((a, b) => key(b) - key(a))).toEqual(versions);
  });

  it('gives a version its own notes, as the release build does', () => {
    expect(sectionOf(changelog, '0.19.1')).toBe(releaseNotes(changelog, '0.19.1'));
    expect(notesFor('0.16.0')).toEqual(['The app in French, with a language setting.']);
    expect(sectionOf(changelog, '0.1')).toBeNull();
    expect(notesFor('9.9.9')).toEqual([]);
  });

  it('turns release notes into items, without the install help', () => {
    const body = '- One thing,\n  on two lines.\n- Another.\n\n---\nDesktop app for Windows…\n- Windows: run the setup';
    expect(noteItems(body)).toEqual(['One thing, on two lines.', 'Another.']);
    expect(noteItems(undefined)).toEqual([]);
  });
});
