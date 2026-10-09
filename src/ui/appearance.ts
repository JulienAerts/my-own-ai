// Themes and personal style (Settings → Appearance). Colours come from two
// numbers per theme — an accent and a tint hue for backgrounds and surfaces —
// which style.css turns into every shade, light and dark. Choices are applied
// as attributes on <html>, saved in settings, and mirrored in localStorage so
// the theme is there before the first paint (no flash of the wrong colours).
import { useEffect, useState } from 'preact/hooks';
import { getSetting, setSetting } from '../db';
import { t } from '../i18n/i18n';

export interface Theme {
  id: string;
  name: string;
  accent: string;
  /** Hue of the background/surface tint (OKLCH degrees). */
  hue: number;
  /** Tint strength: 0 = neutral greys, 1 = the default. */
  tint: number;
}

export const THEMES: Theme[] = [
  { id: 'indigo', name: t('Indigo'), accent: '#5b5bf0', hue: 286, tint: 1 },
  { id: 'violet', name: t('Violet'), accent: '#8b5cf6', hue: 300, tint: 1 },
  { id: 'ocean', name: t('Ocean'), accent: '#0284c7', hue: 235, tint: 1.1 },
  { id: 'teal', name: t('Teal'), accent: '#0d9488', hue: 185, tint: 1 },
  { id: 'forest', name: t('Forest'), accent: '#16a34a', hue: 150, tint: 0.9 },
  { id: 'sunset', name: t('Sunset'), accent: '#ea580c', hue: 50, tint: 1 },
  { id: 'rose', name: t('Rose'), accent: '#e11d48', hue: 10, tint: 1 },
  { id: 'graphite', name: t('Graphite'), accent: '#52525b', hue: 286, tint: 0 },
];

export interface Appearance {
  /** A theme id, or 'custom' (then `accent`). */
  theme: string;
  accent?: string;
  mode: 'system' | 'light' | 'dark';
  /** Pure black backgrounds in dark mode (OLED). */
  black: boolean;
  /** The page behind everything: soft glow, slowly moving aurora, mesh gradient, dots, plain, or the user's picture. */
  background: 'glow' | 'aurora' | 'mesh' | 'dots' | 'plain' | 'image';
  /** How much the picture background is darkened (light mode: lightened), 0–0.85. */
  bgDim: number;
  /** The app's logo: the orb, a swirling aurora orb, a halo ring, an emoji, or the user's picture. */
  logo: 'orb' | 'aurora' | 'halo' | 'emoji' | 'image';
  logoEmoji: string;
  bubble: 'gradient' | 'solid' | 'soft';
  corners: 'round' | 'soft' | 'sharp';
  size: 's' | 'm' | 'l' | 'xl';
  font: 'inter' | 'system' | 'serif' | 'rounded';
}

export const DEFAULT_APPEARANCE: Appearance = {
  theme: 'indigo', mode: 'system', black: false, background: 'glow', bgDim: 0.35, logo: 'orb', logoEmoji: '✨', bubble: 'gradient', corners: 'round', size: 'm', font: 'inter',
};

const CACHE_KEY = 'appearance';

// ---------------------------------------------------------------------------
// Colour maths: sRGB hex → OKLCH lightness and hue (for custom accents).

function oklch(hex: string): { l: number; c: number; h: number } {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return { l: 0.55, c: 0.2, h: 286 };
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(m[1].slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const l_ = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m_ = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s_ = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_;
  const A = 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_;
  const B = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_;
  return { l: L, c: Math.hypot(A, B), h: ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360 };
}

/** The theme in effect: a preset, or the custom colour with its own hue. */
export function resolveTheme(a: Appearance): Theme {
  if (a.theme === 'custom' && a.accent) return { id: 'custom', name: t('Custom'), accent: a.accent, hue: Math.round(oklch(a.accent).h), tint: 1 };
  return THEMES.find((t) => t.id === a.theme) ?? THEMES[0];
}

// ---------------------------------------------------------------------------
// Applying

export function applyAppearance(a: Appearance): void {
  const root = document.documentElement;
  const t = resolveTheme(a);
  const { l, c } = oklch(t.accent);
  root.style.setProperty('--accent-base', t.accent);
  root.style.setProperty('--tint-h', String(t.hue));
  root.style.setProperty('--tint', String(t.tint));
  // Text on the accent: dark on light colours. Dark mode lightens the accent to at least L 0.66.
  root.style.setProperty('--accent-ink', l > 0.72 ? '#14141a' : '#ffffff');
  // Greys lose white text sooner than saturated colours at the same lightness.
  root.style.setProperty('--accent-ink-dark', Math.max(l, 0.66) > 0.78 || c < 0.06 ? '#14141a' : '#ffffff');
  const set = (name: string, value: string | false) => (value ? root.setAttribute(name, value) : root.removeAttribute(name));
  set('data-theme', a.mode !== 'system' && a.mode);
  if (a.black) root.setAttribute('data-black', ''); else root.removeAttribute('data-black');
  set('data-bg', a.background !== 'glow' && a.background);
  set('data-logo', a.logo !== 'orb' && a.logo);
  root.style.setProperty('--bg-dim', String(Math.min(0.85, Math.max(0, a.bgDim ?? 0.35))));
  set('data-bubble', a.bubble !== 'gradient' && a.bubble);
  set('data-corners', a.corners !== 'round' && a.corners);
  set('data-size', a.size !== 'm' && a.size);
  set('data-font', a.font !== 'inter' && a.font);
  // The phone's status bar follows the page background.
  requestAnimationFrame(() => {
    const bg = getComputedStyle(root).getPropertyValue('--bg').trim();
    for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
      meta.dataset.orig ??= meta.content; // index.html's light/dark colours, for System
      meta.content = a.mode === 'system' || !bg ? meta.dataset.orig : bg;
    }
  });
}

let current: Appearance = DEFAULT_APPEARANCE;
const subs = new Set<(a: Appearance) => void>();

/** Before the first render: the cached choice, then the saved one if it differs. */
export function initAppearance(): void {
  try {
    const cached = localStorage.getItem(CACHE_KEY);
    if (cached) current = { ...DEFAULT_APPEARANCE, ...JSON.parse(cached) };
  } catch { /* private mode: the defaults */ }
  applyAppearance(current);
  void getSetting('appearance').then((saved) => {
    if (saved && JSON.stringify(saved) !== JSON.stringify(current)) {
      current = { ...DEFAULT_APPEARANCE, ...saved };
      applyAppearance(current);
      subs.forEach((fn) => fn(current));
    }
  }, () => {});
}

export async function setAppearance(patch: Partial<Appearance>): Promise<void> {
  current = { ...current, ...patch };
  applyAppearance(current);
  subs.forEach((fn) => fn(current));
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(current)); } catch { /* ignore */ }
  await setSetting('appearance', current);
}

export function useAppearance(): Appearance {
  const [a, setA] = useState(current);
  useEffect(() => {
    subs.add(setA);
    return () => void subs.delete(setA);
  }, []);
  return a;
}

// ---------------------------------------------------------------------------
// Pictures (logo, background): kept in their own settings, not in the cached
// appearance, so a 300 KB photo isn't rewritten on every change of colour.

type Pictures = { logo?: string; background?: string };
let pictures: Pictures = {};
const pictureSubs = new Set<(p: Pictures) => void>();

function applyBackgroundPicture() {
  const root = document.documentElement;
  if (pictures.background) root.style.setProperty('--bg-image', `url("${pictures.background}")`);
  else root.style.removeProperty('--bg-image');
}

/** Load the saved pictures (after the first paint). */
export async function loadPictures(): Promise<void> {
  const [logo, background] = await Promise.all([getSetting('logoImage').catch(() => undefined), getSetting('backgroundImage').catch(() => undefined)]);
  pictures = { logo: logo || undefined, background: background || undefined };
  applyBackgroundPicture();
  pictureSubs.forEach((fn) => fn(pictures));
}

/** Save (or with null, remove) the logo or background picture. */
export async function setPicture(kind: 'logo' | 'background', dataUrl: string | null): Promise<void> {
  pictures = { ...pictures, [kind]: dataUrl ?? undefined };
  applyBackgroundPicture();
  pictureSubs.forEach((fn) => fn(pictures));
  await setSetting(kind === 'logo' ? 'logoImage' : 'backgroundImage', dataUrl ?? '');
}

export function usePictures(): Pictures {
  const [p, setP] = useState(pictures);
  useEffect(() => {
    pictureSubs.add(setP);
    setP(pictures);
    return () => void pictureSubs.delete(setP);
  }, []);
  return p;
}

/**
 * A picture file, shrunk for storage: the logo cropped to a 256 px square, a background
 * at most 1920 px wide. JPEG for photos, PNG for the logo (it may be transparent).
 */
export async function shrinkPicture(file: Blob, kind: 'logo' | 'background'): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  if (kind === 'logo') {
    const side = Math.min(bitmap.width, bitmap.height);
    canvas.width = canvas.height = 256;
    ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, 256, 256);
    bitmap.close();
    return canvas.toDataURL('image/png');
  }
  const scale = Math.min(1, 1920 / Math.max(bitmap.width, bitmap.height));
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas.toDataURL('image/jpeg', 0.82);
}
