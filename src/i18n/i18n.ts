// Interface languages. The English text is the key: t('Settings') looks it up
// in the language's dictionary (src/i18n/fr.ts) and falls back to English, so
// an untranslated string still reads fine. `{name}` placeholders are filled from
// `vars`. The choice (Settings → App) lives in localStorage, since it must be
// known synchronously before the first render; "auto" follows the device.
// src/i18n/i18n.test.ts checks that every t('…') in the code has a French entry.
import type { ComponentChildren } from 'preact';
import { FR } from './fr';

export type Lang = 'en' | 'fr';
export type LangChoice = 'auto' | Lang;

export const LANGUAGES: { id: Lang; name: string }[] = [
  { id: 'en', name: 'English' },
  { id: 'fr', name: 'Français' },
];

const KEY = 'my-own-ai.language';
const DICTS: Record<Lang, Record<string, string>> = { en: {}, fr: FR };

export function languageChoice(): LangChoice {
  try {
    const v = globalThis.localStorage?.getItem(KEY);
    return v === 'en' || v === 'fr' ? v : 'auto';
  } catch {
    return 'auto';
  }
}

function detect(): Lang {
  const choice = languageChoice();
  if (choice !== 'auto') return choice;
  const prefs = typeof navigator === 'undefined' ? [] : navigator.languages?.length ? navigator.languages : [navigator.language];
  for (const p of prefs) {
    const base = (p ?? '').toLowerCase().split('-')[0];
    if (base === 'fr' || base === 'en') return base;
  }
  return 'en';
}

export const lang: Lang = detect();

/** The locale for dates and numbers: the device's own when it speaks the interface language. */
export const locale: string = (() => {
  const own = typeof navigator === 'undefined' ? undefined : navigator.language;
  return own?.toLowerCase().startsWith(lang) ? own : lang === 'fr' ? 'fr-FR' : 'en-US';
})();

if (typeof document !== 'undefined') document.documentElement.lang = lang;

/** Save the choice and reload, so every screen (and the assistant) switches language. */
export function setLanguage(choice: LangChoice) {
  try {
    if (choice === 'auto') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, choice);
  } catch {
    // Storage blocked: the choice lasts until the reload only.
  }
  location.reload();
}

/** Byte units: French writes octets (Mo, Go). */
export const UNIT = lang === 'fr'
  ? { B: 'o', KB: 'Ko', MB: 'Mo', GB: 'Go' }
  : { B: 'B', KB: 'KB', MB: 'MB', GB: 'GB' };

/** A number with `digits` decimals in the interface's locale ("1.4" or "1,4"). */
export function num(n: number, digits = 0): string {
  return n.toLocaleString(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

const fill = (s: string, vars?: Record<string, string | number>) =>
  vars ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : s;

/** The text in the interface language. */
export function t(text: string, vars?: Record<string, string | number>): string {
  return fill(DICTS[lang][text] ?? text, vars);
}

/** One or several: tn(n, '{n} file', '{n} files'). French uses the singular for 0 and 1. */
export function tn(n: number, one: string, other: string, vars?: Record<string, string | number>): string {
  const single = lang === 'fr' ? n < 2 : n === 1;
  return t(single ? one : other, { n: n.toLocaleString(locale), ...vars });
}

/** Like t(), with markup in the placeholders: tj('Open {link} to start', { link: <a…/> }). */
export function tj(text: string, parts: Record<string, ComponentChildren>): ComponentChildren[] {
  return t(text).split(/(\{\w+\})/).map((piece) => {
    const m = /^\{(\w+)\}$/.exec(piece);
    return m && m[1] in parts ? parts[m[1]] : piece;
  });
}
