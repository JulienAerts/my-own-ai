// Every text the code passes to t(), tn() or tj() needs a French entry, with the same placeholders.
import { describe, expect, it } from 'vitest';
import { FR } from './fr';

// Every source file, as text (Vite's glob import, so no Node APIs are needed).
const SOURCES = import.meta.glob(['../**/*.ts', '../**/*.tsx', '!../**/*.test.ts', '!./i18n.ts'], { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

// A string literal: '…' or "…" (no template literals: placeholders go through vars).
const LIT = String.raw`'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"`;
const unescape = (s: string) => s.replace(/\\(['"\\])/g, '$1').replace(/\\n/g, '\n');

/** Every literal key used in the source. */
function usedKeys(): Map<string, string> {
  const keys = new Map<string, string>();
  const one = new RegExp(String.raw`\b(?:t|tj)\(\s*(?:${LIT})`, 'g');
  const two = new RegExp(String.raw`\btn\(\s*[^,]+,\s*(?:${LIT})\s*,\s*(?:${LIT})`, 'g');
  for (const [f, src] of Object.entries(SOURCES)) {
    for (const m of src.matchAll(one)) keys.set(unescape(m[1] ?? m[2]), f);
    for (const m of src.matchAll(two)) {
      keys.set(unescape(m[1] ?? m[2]), f);
      keys.set(unescape(m[3] ?? m[4]), f);
    }
  }
  return keys;
}

const holes = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');

describe('French interface', () => {
  const keys = usedKeys();

  it('finds the interface texts', () => {
    expect(keys.size).toBeGreaterThan(300);
  });

  it('translates every text', () => {
    const missing = [...keys].filter(([k]) => !(k in FR)).map(([k, f]) => `${f}: ${k}`);
    expect(missing).toEqual([]);
  });

  it('keeps the placeholders', () => {
    const wrong = Object.entries(FR).filter(([en, fr]) => holes(en) !== holes(fr)).map(([en]) => en);
    expect(wrong).toEqual([]);
  });

  it('has no leftover entries', () => {
    const unused = Object.keys(FR).filter((k) => !keys.has(k));
    expect(unused).toEqual([]);
  });
});
