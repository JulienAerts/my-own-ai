// Web search and page reading for the apps. A web page can't read other sites
// (no CORS), but the apps can: Android sends requests through its own network
// stack (CapacitorHttp), the desktop app through Tauri's HTTP plugin (Rust).
// Straight from the device, no server in between, and only the model's query
// (or the page it asked for) leaves the device.
//
// Parsers take the HTML/XML as a string, so they can be tested in a browser.
import { CapacitorHttp } from '@capacitor/core';
import { tauriFetch } from '../net/http';
import { track } from '../net/netlog';
import { isDesktopApp } from '../native';

export interface WebResult {
  title: string;
  url: string;
  snippet: string;
  /** YYYY-MM-DD when the engine shows one. */
  date?: string;
}

export interface NewsHeadline {
  title: string;
  source?: string;
  /** YYYY-MM-DD */
  date?: string;
}

const TIMEOUT_MS = 12_000;

/**
 * The WebView's own identity minus its markers: what Chrome on this device sends
 * (Android adds "wv" and "Version/4.0"; WebView2 on Windows, like Edge, "Edg/…").
 */
function userAgent(): string {
  return navigator.userAgent.replace('; wv)', ')').replace(/ Version\/[\d.]+/, '').replace(/ Edg\/[\d.]+/, '');
}

const HEADERS = () => ({
  'User-Agent': userAgent(),
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
});

/** Desktop app: Tauri's HTTP plugin, a fetch() that runs in Rust. */
async function tauriText(url: string, init: { method?: 'GET' | 'POST'; form?: Record<string, string> }): Promise<{ status: number; text: string; url: string }> {
  const res = await tauriFetch(url, {
    method: init.method ?? 'GET',
    headers: { ...HEADERS(), ...(init.form && { 'Content-Type': 'application/x-www-form-urlencoded' }) },
    body: init.form ? new URLSearchParams(init.form).toString() : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS * 2),
  }).catch((e: unknown) => {
    throw new Error(`${new URL(url).host} could not be reached (${e instanceof Error ? e.message : String(e)})`);
  });
  return { status: res.status, text: await res.text(), url: res.url || url };
}

async function nativeText(url: string, init: { method?: 'GET' | 'POST'; form?: Record<string, string> } = {}): Promise<{ status: number; text: string; url: string }> {
  if (navigator.onLine === false) throw new Error('No internet connection');
  if (isDesktopApp) return tauriText(url, init);
  const done = track(url, init.method ?? 'GET');
  const res = await CapacitorHttp.request({
    url,
    method: init.method ?? 'GET',
    headers: {
      ...HEADERS(),
      ...(init.form && { 'Content-Type': 'application/x-www-form-urlencoded' }),
    },
    data: init.form ? new URLSearchParams(init.form).toString() : undefined,
    responseType: 'text',
    connectTimeout: TIMEOUT_MS,
    readTimeout: TIMEOUT_MS,
  }).catch((e: unknown) => {
    done({ status: 'error' });
    throw new Error(`${new URL(url).host} could not be reached (${e instanceof Error ? e.message : String(e)})`);
  });
  const text = typeof res.data === 'string' ? res.data : JSON.stringify(res.data ?? '');
  done({ status: res.status, bytes: text.length });
  return { status: res.status, text, url: res.url || url };
}

const parse = (html: string, type: DOMParserSupportedType = 'text/html') => new DOMParser().parseFromString(html, type);
const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
const isoDate = (d: Date) => (Number.isNaN(d.getTime()) ? undefined : d.toISOString().slice(0, 10));

// ---------------------------------------------------------------------------
// Search engines

/** DuckDuckGo's HTML results (no JavaScript needed). Ads and redirects are unwrapped. */
export function parseDuckDuckGo(html: string): WebResult[] {
  const doc = parse(html);
  const out: WebResult[] = [];
  for (const r of doc.querySelectorAll('.result')) {
    if (r.classList.contains('result--ad')) continue;
    const a = r.querySelector<HTMLAnchorElement>('a.result__a');
    let href = a?.getAttribute('href') ?? '';
    // Older markup links through //duckduckgo.com/l/?uddg=<target>.
    const redirect = /[?&]uddg=([^&]+)/.exec(href);
    if (redirect) href = decodeURIComponent(redirect[1]);
    if (href.startsWith('//')) href = `https:${href}`;
    if (!a || !/^https?:\/\//.test(href) || /duckduckgo\.com\/y\.js/.test(href)) continue;
    const date = /(\d{4}-\d{2}-\d{2})T/.exec(r.querySelector('.result__extras__url')?.textContent ?? '')?.[1];
    out.push({ title: clean(a.textContent), url: href, snippet: clean(r.querySelector('.result__snippet')?.textContent), date });
  }
  return out;
}

/** Bing's results; its tracking links carry the target as base64 in `u=a1…`. */
export function parseBing(html: string): WebResult[] {
  const doc = parse(html);
  const out: WebResult[] = [];
  for (const li of doc.querySelectorAll('li.b_algo')) {
    // Desktop: <h2><a>title</a></h2>; mobile: <div class="b_algoheader"><a><h2>title</h2></a></div>.
    const a = li.querySelector<HTMLAnchorElement>('h2 a, .b_algoheader a');
    let href = a?.getAttribute('href') ?? '';
    const u = /[?&]u=a1([^&]+)/.exec(href);
    if (u) {
      try {
        href = atob(u[1].replace(/-/g, '+').replace(/_/g, '/'));
      } catch { /* keep the tracking link */ }
    }
    if (!a || !/^https?:\/\//.test(href)) continue;
    const snippet = li.querySelector('.b_caption p, .b_lineclamp2, .b_lineclamp3, .b_lineclamp4, p')?.cloneNode(true) as Element | undefined;
    snippet?.querySelector('.news_dt')?.remove(); // "6 hours ago ·"
    out.push({ title: clean(a.textContent), url: href, snippet: clean(snippet?.textContent).replace(/^[\s·]+/, '') });
  }
  return out;
}

/** `recent`: d (day), w (week), m (month): only pages from that period. */
export async function webSearch(query: string, recent?: 'd' | 'w' | 'm'): Promise<{ engine: string; results: WebResult[] }> {
  const errors: string[] = [];
  try {
    const r = await nativeText('https://html.duckduckgo.com/html/', { method: 'POST', form: { q: query, kl: 'wt-wt', ...(recent && { df: recent }) } });
    const results = r.status === 200 ? parseDuckDuckGo(r.text) : [];
    if (results.length) return { engine: 'DuckDuckGo', results };
    errors.push(`DuckDuckGo answered ${r.status}${r.status === 200 ? ' with no results' : ''}`);
  } catch (e) {
    errors.push(e instanceof Error ? e.message : String(e));
  }
  // Bing as a fallback (DuckDuckGo sometimes shows a bot check instead of results).
  const fresh = recent ? `&filters=${encodeURIComponent(`ex1:"ez${{ d: 1, w: 2, m: 3 }[recent]}"`)}` : '';
  const r = await nativeText(`https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=en${fresh}`);
  const results = r.status === 200 ? parseBing(r.text) : [];
  if (!results.length && r.status !== 200) throw new Error(`${errors.join('; ')}; Bing answered ${r.status}`);
  return { engine: 'Bing', results };
}

// ---------------------------------------------------------------------------
// News

/** Google News RSS: "Headline - Source" titles with dates. */
export function parseGoogleNews(xml: string): NewsHeadline[] {
  const doc = parse(xml, 'text/xml');
  return [...doc.querySelectorAll('item')].map((it) => {
    const source = clean(it.querySelector('source')?.textContent) || undefined;
    let title = clean(it.querySelector('title')?.textContent);
    if (source && title.endsWith(` - ${source}`)) title = title.slice(0, -(source.length + 3));
    // "ABC News - Breaking News, Latest News and Videos" → "ABC News"
    return { title, source: source?.split(/ [-|–] /)[0], date: isoDate(new Date(clean(it.querySelector('pubDate')?.textContent))) };
  }).filter((h) => h.title);
}

/** Latest headlines for `topic` (or the top stories), newest first. */
export async function googleNews(topic: string): Promise<NewsHeadline[]> {
  const q = topic.trim();
  const url = q
    ? `https://news.google.com/rss/search?q=${encodeURIComponent(`${q} when:7d`)}&hl=en-US&gl=US&ceid=US:en`
    : 'https://news.google.com/rss?hl=en-US&gl=US&ceid=US:en';
  const r = await nativeText(url);
  if (r.status !== 200) throw new Error(`Google News answered ${r.status}`);
  return parseGoogleNews(r.text).sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
}

// ---------------------------------------------------------------------------
// Reading pages

/**
 * Only public web pages: the app can reach the local network, so a page (or a
 * prompt hidden in one) must not make it read the router or other devices.
 */
export function isPublicWebUrl(raw: string): URL | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!h.includes('.') || h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.lan') || h.endsWith('.home')) return null;
  if (/^(127|10|0)\.|^192\.168\.|^169\.254\.|^172\.(1[6-9]|2\d|3[01])\.|^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h)) return null;
  if (h.includes(':')) return null; // IPv6 literals (::1, fc00::/7, fe80::…)
  return u;
}

export interface Article {
  title: string;
  site?: string;
  byline?: string;
  date?: string;
  text: string;
}

/** The main text of a page (Firefox Reader View's algorithm), or its body text. */
export async function extractArticle(html: string, url: string): Promise<Article> {
  const doc = parse(html);
  // Relative links and images resolve against the page, not the app.
  const base = doc.createElement('base');
  base.href = url;
  doc.head?.prepend(base);
  const { Readability } = await import('@mozilla/readability');
  const r = new Readability(doc.cloneNode(true) as Document, { charThreshold: 300 }).parse();
  const meta = (name: string) => doc.querySelector(`meta[property="${name}"], meta[name="${name}"]`)?.getAttribute('content') ?? undefined;
  const published = r?.publishedTime ?? meta('article:published_time') ?? meta('date');
  const text = (r?.content && blockText(r.content)) || clean(r?.textContent) || clean(doc.body?.textContent);
  const site = clean(r?.siteName ?? meta('og:site_name')) || new URL(url).hostname.replace(/^www\./, '');
  const byline = clean(r?.byline);
  return {
    title: clean(r?.title ?? doc.title) || new URL(url).hostname,
    site,
    byline: byline && byline !== site ? byline : undefined,
    date: published ? isoDate(new Date(published)) : undefined,
    text,
  };
}

const BLOCKS = 'h1, h2, h3, h4, h5, h6, p, li, blockquote, pre, figcaption, td, th';

/**
 * One line per paragraph, heading or list item: textContent runs them together
 * ("…on Tuesday.Exporters shipped…"), which is harder for a small model to read.
 */
function blockText(html: string): string {
  const doc = parse(html);
  const lines: string[] = [];
  for (const el of doc.querySelectorAll(BLOCKS)) {
    if (el.parentElement?.closest(BLOCKS)) continue; // a <p> inside an <li> is read with it
    const t = clean(el.textContent);
    if (t) lines.push(/^H\d$/.test(el.tagName) ? `## ${t}` : el.tagName === 'LI' ? `- ${t}` : t);
  }
  const text = lines.join('\n');
  // Pages built from bare <div>s have few blocks: then keep all the text.
  return text.length >= clean(doc.body?.textContent).length * 0.5 ? text : clean(doc.body?.textContent);
}

export async function readPage(raw: string): Promise<Article & { url: string }> {
  const u = isPublicWebUrl(raw);
  if (!u) throw new Error(`Can't read "${raw}": only public http(s) web pages can be read.`);
  const r = await nativeText(u.href);
  if (r.status >= 400) throw new Error(`${u.hostname} answered ${r.status}${r.status === 403 || r.status === 401 ? ' (it blocks automated reading or needs a login)' : ''}`);
  if (/^\s*[{[]/.test(r.text) || /%PDF-/.test(r.text.slice(0, 20))) throw new Error('That address is not a web page (PDF or data).');
  // Cloudflare and similar walls answer 200 with a "checking your browser" page.
  if (/<title>\s*(Just a moment|Attention Required|Access denied|Are you a robot)/i.test(r.text) || /cf_chl_opt|captcha-delivery|Enable JavaScript and cookies to continue/.test(r.text)) {
    throw new Error(`${u.hostname} blocks automated reading (bot check). Try another result.`);
  }
  const article = await extractArticle(r.text, r.url || u.href);
  if (article.text.length < 200) throw new Error(`${u.hostname} returned almost no text (it may need JavaScript, a login or a subscription).`);
  return { ...article, url: r.url || u.href };
}
