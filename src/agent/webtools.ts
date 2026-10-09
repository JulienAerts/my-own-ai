// Tools that call keyless, CORS-enabled public APIs straight from the browser.
// Only the tool's own arguments (the model's query) are sent, never the chat.
// Results are kept short: phones run with a 2048-token context.

const MAX_RESULT = 1000;
const TIMEOUT_MS = 12_000;

async function getJson<T = unknown>(url: string): Promise<T> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) throw new Error('No internet connection');
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    const timeout = e instanceof DOMException && e.name === 'TimeoutError';
    throw new Error(`${new URL(url).host} ${timeout ? 'did not answer in time' : 'could not be reached'}`);
  }
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status} from ${new URL(url).host}`), { status: res.status });
  return res.json() as Promise<T>;
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, '').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Keep whole lines while the total stays under `max` characters. */
function clipLines(lines: string[], max = MAX_RESULT): string {
  const out: string[] = [];
  let used = 0;
  for (const l of lines) {
    if (used + l.length + 1 > max) break;
    out.push(l);
    used += l.length + 1;
  }
  return out.join('\n');
}

/** Cut at a sentence end before `max` characters when possible. */
function clip(text: string, max = MAX_RESULT): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('.\n'));
  return (end > max * 0.5 ? cut.slice(0, end + 1) : cut.trimEnd() + '…');
}

const enc = encodeURIComponent;

// ---------------------------------------------------------------------------
// search: DuckDuckGo instant answer (entities only) + Wikipedia full-text search

interface DdgAnswer { Abstract?: string; AbstractSource?: string; Answer?: string; Definition?: string; Heading?: string }
interface WikiSearch { query?: { search: { title: string; snippet: string }[] } }

export async function search(query: string): Promise<string> {
  const q = query.trim();
  if (!q) throw new Error('Empty search query');
  const [ddg, wiki] = await Promise.allSettled([
    getJson<DdgAnswer>(`https://api.duckduckgo.com/?q=${enc(q)}&format=json&no_html=1&skip_disambig=1`),
    getJson<WikiSearch>(`https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${enc(q)}&srlimit=5&srprop=snippet&format=json&origin=*`),
  ]);
  const lines: string[] = [];
  if (ddg.status === 'fulfilled') {
    const a = ddg.value;
    const text = a.Answer || a.Abstract || a.Definition;
    if (text) lines.push(`Quick answer${a.Heading ? ` (${a.Heading})` : ''}: ${clip(text, 400)}`);
  }
  const hits = wiki.status === 'fulfilled' ? wiki.value.query?.search ?? [] : [];
  if (hits.length) {
    lines.push('Wikipedia results:', ...hits.map((r, i) => `${i + 1}. ${r.title}: ${clip(stripHtml(r.snippet), 160)}`));
  }
  if (!lines.length) {
    if (wiki.status === 'rejected') throw wiki.reason;
    return `No results for "${q}". Try other keywords.`;
  }
  const hint = hits.length ? '\nCall read_article with one of these titles for details.' : '';
  return clipLines(lines, MAX_RESULT - hint.length) + hint;
}

// ---------------------------------------------------------------------------
// read_article: the intro of a Wikipedia article

interface WikiExtract { query?: { pages: Record<string, { title: string; extract?: string; missing?: string; fullurl?: string }> } }

export async function readArticle(title: string): Promise<string> {
  const t = title.trim();
  if (!t) throw new Error('Empty article title');
  const r = await getJson<WikiExtract>(
    `https://en.wikipedia.org/w/api.php?action=query&prop=extracts|info&inprop=url&exintro=1&explaintext=1&redirects=1&titles=${enc(t)}&format=json&origin=*`,
  );
  const page = Object.values(r.query?.pages ?? {})[0];
  if (!page || page.missing !== undefined || !page.extract) return `No Wikipedia article titled "${t}". Use search to find the right title.`;
  return clip(`${page.title} (Wikipedia, ${page.fullurl ?? ''}):\n${page.extract}`);
}

// ---------------------------------------------------------------------------
// weather: Open-Meteo geocoding + forecast

const WMO: Record<number, string> = {
  0: 'clear sky', 1: 'mainly clear', 2: 'partly cloudy', 3: 'overcast', 45: 'fog', 48: 'freezing fog',
  51: 'light drizzle', 53: 'drizzle', 55: 'heavy drizzle', 56: 'freezing drizzle', 57: 'freezing drizzle',
  61: 'light rain', 63: 'rain', 65: 'heavy rain', 66: 'freezing rain', 67: 'freezing rain',
  71: 'light snow', 73: 'snow', 75: 'heavy snow', 77: 'snow grains',
  80: 'rain showers', 81: 'rain showers', 82: 'violent rain showers', 85: 'snow showers', 86: 'heavy snow showers',
  95: 'thunderstorm', 96: 'thunderstorm with hail', 99: 'thunderstorm with heavy hail',
};

interface Geo { results?: { name: string; country?: string; admin1?: string; latitude: number; longitude: number }[] }
interface Forecast {
  current: { time: string; temperature_2m: number; apparent_temperature: number; relative_humidity_2m: number; weather_code: number; wind_speed_10m: number; precipitation: number };
  daily: { time: string[]; weather_code: number[]; temperature_2m_max: number[]; temperature_2m_min: number[]; precipitation_probability_max: (number | null)[] };
}

export async function weather(location: string): Promise<string> {
  const name = location.trim().replace(/,.*$/, ''); // Open-Meteo matches names, not "City, Country"
  if (!name) throw new Error('Empty location');
  const geo = await getJson<Geo>(`https://geocoding-api.open-meteo.com/v1/search?name=${enc(name)}&count=1&language=en&format=json`);
  const place = geo.results?.[0];
  if (!place) return `Couldn't find a place called "${location}".`;
  const f = await getJson<Forecast>(
    `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}` +
    '&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,precipitation' +
    '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto&forecast_days=3',
  );
  const c = f.current;
  const where = [place.name, place.admin1, place.country].filter(Boolean).join(', ');
  const day = (iso: string) => new Date(`${iso}T12:00:00`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  const days = f.daily.time.map((d, i) => {
    const rain = f.daily.precipitation_probability_max[i];
    return `${day(d)}: ${Math.round(f.daily.temperature_2m_min[i])} to ${Math.round(f.daily.temperature_2m_max[i])}°C, ${WMO[f.daily.weather_code[i]] ?? 'unknown'}${rain != null ? `, ${rain}% chance of rain` : ''}`;
  });
  return `${where}, now (local time ${c.time.slice(11)}): ${Math.round(c.temperature_2m)}°C (feels like ${Math.round(c.apparent_temperature)}°C), ` +
    `${WMO[c.weather_code] ?? 'unknown'}, humidity ${c.relative_humidity_2m}%, wind ${Math.round(c.wind_speed_10m)} km/h` +
    `${c.precipitation ? `, precipitation ${c.precipitation} mm` : ''}.\nForecast:\n${days.join('\n')}\n(Source: Open-Meteo)`;
}

// ---------------------------------------------------------------------------
// convert_currency: European Central Bank reference rates via Frankfurter

interface Rates { amount: number; base: string; date: string; rates: Record<string, number> }

export async function convertCurrency(amount: string, from: string, to: string): Promise<string> {
  const n = parseFloat(amount.replace(/[, ]/g, ''));
  if (!Number.isFinite(n)) throw new Error(`"${amount}" is not a number`);
  const code = (s: string) => {
    const c = s.trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(c)) throw new Error(`"${s}" is not a 3-letter currency code like EUR or USD`);
    return c;
  };
  const f = code(from), t = code(to);
  if (f === t) return `${n} ${f} = ${n} ${t}`;
  let r: Rates;
  try {
    r = await getJson<Rates>(`https://api.frankfurter.dev/v1/latest?amount=${n}&from=${f}&to=${t}`);
  } catch (e) {
    if ((e as { status?: number }).status === 404) throw new Error(`Unsupported currency (${f} or ${t}). Only the ~30 currencies the ECB publishes are available.`);
    throw e;
  }
  const v = r.rates[t];
  return `${n.toLocaleString('en-US')} ${f} = ${v.toLocaleString('en-US', { maximumFractionDigits: 2 })} ${t} (ECB reference rate of ${r.date})`;
}

// ---------------------------------------------------------------------------
// define_word: Wiktionary

interface Wikt { [lang: string]: { partOfSpeech: string; language: string; definitions: { definition: string }[] }[] }

export async function defineWord(word: string): Promise<string> {
  const w = word.trim();
  if (!w) throw new Error('Empty word');
  let d: Wikt;
  try {
    d = await getJson<Wikt>(`https://en.wiktionary.org/api/rest_v1/page/definition/${enc(w.replace(/ /g, '_'))}`);
  } catch (e) {
    if ((e as { status?: number }).status === 404) return `No dictionary entry for "${w}".`;
    throw e;
  }
  const entries = d.en ?? Object.values(d)[0] ?? [];
  if (!entries.length) return `No dictionary entry for "${w}".`;
  const lines = entries.slice(0, 3).map((e) => {
    const defs = e.definitions.map((x) => stripHtml(x.definition)).filter(Boolean).slice(0, 3);
    return `${e.partOfSpeech}${e.language !== 'English' ? ` (${e.language})` : ''}:\n${defs.map((x, i) => `  ${i + 1}. ${x}`).join('\n')}`;
  });
  return clip(`${w} (Wiktionary):\n${lines.join('\n')}`);
}

// ---------------------------------------------------------------------------
// news: Wikipedia's Current events portal (world news, written daily by
// editors, with sources) + Hacker News (tech). Both allow browser requests;
// general news sites and search engines don't.

const NEWS_DAYS = 7;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export interface NewsItem {
  /** YYYY-MM-DD */
  date: string;
  /** "Armed conflicts and attacks", "Business and economy"… */
  category: string;
  /** Parent bullets: the story this item belongs to ("2026 Brazilian general election"). */
  story: string[];
  text: string;
  /** Outlets cited for it ("Reuters", "AFP via France 24"). */
  sources: string[];
}

/** Plain text from a line of wikitext; cited outlets are collected separately. */
function unwiki(s: string, sources?: string[]): string {
  return s
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<ref[^>]*\/>|<ref[^>]*>[\s\S]*?<\/ref>/g, '')
    .replace(/\[https?:\/\/\S+\s+\(([^)]*)\)\]/g, (_, name: string) => { sources?.push(name.replace(/'{2,}/g, '').trim()); return ''; })
    .replace(/\[https?:\/\/\S+(?:\s+([^\]]*))?\]/g, (_, label?: string) => label ?? '')
    .replace(/\{\{[^{}]*\}\}/g, '')
    .replace(/\[\[(?:[^|\]]*\|)?([^\]]*)\]\]/g, '$1')
    .replace(/'{2,}/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** News items of one day page: the deepest bullets, with their parent bullets as context. */
export function parseCurrentEvents(wikitext: string, date: string): NewsItem[] {
  const lines = wikitext.split('\n');
  const items: NewsItem[] = [];
  let category = '';
  const stack: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const cat = /^'''([^']+)'''\s*$/.exec(line);
    if (cat) {
      category = cat[1].trim();
      stack.length = 0;
      continue;
    }
    const b = /^(\*+)\s*(.*)$/.exec(line);
    if (!b) continue;
    const depth = b[1].length;
    const next = /^(\*+)/.exec(lines[i + 1]?.trim() ?? '');
    const sources: string[] = [];
    const text = unwiki(b[2], sources);
    stack.length = depth - 1;
    if (next && next[1].length > depth) {
      stack[depth - 1] = text; // a heading for the bullets below it
      continue;
    }
    if (text.length < 20) continue;
    items.push({ date, category, story: stack.filter(Boolean), text, sources });
  }
  return items;
}

// Follow-up questions (and several news calls in one answer) reuse the week's pages.
const NEWS_CACHE_MS = 10 * 60_000;
let newsCache: { at: number; items: Promise<NewsItem[]> } | null = null;

function currentEvents(): Promise<NewsItem[]> {
  if (!newsCache || Date.now() - newsCache.at > NEWS_CACHE_MS) {
    const items = fetchCurrentEvents();
    newsCache = { at: Date.now(), items };
    items.catch(() => { if (newsCache?.items === items) newsCache = null; });
  }
  return newsCache.items;
}

/** Day pages of the last week, newest first, in one request. */
async function fetchCurrentEvents(): Promise<NewsItem[]> {
  const days: string[] = [];
  const now = new Date();
  for (let i = 0; i < NEWS_DAYS; i++) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    days.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
  }
  const title = (iso: string) => {
    const [y, m, d] = iso.split('-').map(Number);
    return `Portal:Current events/${y} ${MONTHS[m - 1]} ${d}`;
  };
  const r = await getJson<{ query?: { pages: { title: string; missing?: boolean; revisions?: { slots: { main: { content: string } } }[] }[] } }>(
    'https://en.wikipedia.org/w/api.php?action=query&prop=revisions&rvprop=content&rvslots=main&formatversion=2&format=json&origin=*' +
    `&titles=${enc(days.map(title).join('|'))}`,
  );
  const byTitle = new Map((r.query?.pages ?? []).map((p) => [p.title, p.revisions?.[0]?.slots.main.content]));
  return days.flatMap((iso) => {
    const text = byTitle.get(title(iso));
    return text ? parseCurrentEvents(text, iso) : [];
  });
}

const NEWS_STOP = new Set('a an and the of in on at to for from with about by is are was were be been news latest recent today yesterday this week what whats happening happened any new update updates headlines top world'.split(' '));

function newsTerms(q: string): string[] {
  return (q.toLowerCase().normalize('NFD').replace(/\p{Mn}/gu, '').match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((t) => t.length > 1 && !NEWS_STOP.has(t))
    // "elections" finds "election", "Brazilian" finds "Brazil".
    .map((t) => (t.length > 4 ? t.replace(/(ians?|ese|ies|es|s)$/, '') : t));
}

/**
 * How many of the topic's words `text` contains, and how many it needs (half,
 * at least one). Whole words: "AI" must not match "Mali"; long words also
 * match as a prefix ("elect" → "electoral").
 */
function topicHits(terms: string[], text: string): { hits: number; need: number } {
  const words = new Set(newsTerms(text));
  const has = (t: string) => words.has(t) || (t.length >= 5 && [...words].some((w) => w.startsWith(t)));
  return { hits: terms.filter(has).length, need: Math.max(1, Math.ceil(terms.length / 2)) };
}

/** Items matching most of the topic's words (in the item or its story), best and newest first. */
export function rankNews(items: NewsItem[], topic: string): NewsItem[] {
  const terms = newsTerms(topic);
  if (!terms.length) return items;
  return items
    .map((it, order) => ({ it, order, ...topicHits(terms, [it.text, ...it.story, it.category].join(' ')) }))
    .filter((s) => s.hits >= s.need)
    .sort((a, b) => b.hits - a.hits || a.order - b.order)
    .map((s) => s.it);
}

function newsLine(it: NewsItem): string {
  const day = new Date(`${it.date}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const story = it.story.at(-1);
  const src = it.sources.length ? ` (${[...new Set(it.sources)].slice(0, 2).join(', ')})` : '';
  return `- ${day}${story && !it.text.includes(story) ? ` · ${story}` : ''}: ${it.text}${src}`;
}

interface HnHits { hits: { title: string; url?: string; points: number; num_comments: number; created_at_i: number; objectID: string }[] }

/** Well-received Hacker News stories of the past week about `topic`. */
async function hackerNews(topic: string): Promise<string[]> {
  const since = Math.floor(Date.now() / 1000) - NEWS_DAYS * 86_400;
  const r = await getJson<HnHits>(
    // optionalWords: stories matching only some of the words still count (ranked lower).
    `https://hn.algolia.com/api/v1/search?query=${enc(topic)}&optionalWords=${enc(topic)}&tags=story` +
    `&numericFilters=${enc(`created_at_i>${since},points>40`)}&hitsPerPage=12`,
  );
  const terms = newsTerms(topic);
  // optionalWords lets partial matches through; keep the titles with most of the words.
  return r.hits.filter((h) => { const m = topicHits(terms, h.title); return m.hits >= m.need; }).slice(0, 4).map((h) => {
    const day = new Date(h.created_at_i * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const host = h.url ? ` (${new URL(h.url).hostname.replace(/^www\./, '')})` : '';
    return `- ${day}: ${h.title}${host}, ${h.points} points`;
  });
}

export async function news(topic: string, maxChars = MAX_RESULT): Promise<string> {
  const t = topic.trim();
  const [world, tech] = await Promise.allSettled([currentEvents(), t ? hackerNews(t) : Promise.resolve([])]);
  const sections: string[] = [];
  let worldLines: string[] = [];
  if (world.status === 'fulfilled') {
    // Without a topic: everything, newest day first, cut to the budget below.
    worldLines = rankNews(world.value, t).map(newsLine);
  }
  const techLines = tech.status === 'fulfilled' ? tech.value : [];
  if (!worldLines.length && !techLines.length) {
    if (world.status === 'rejected') throw world.reason;
    return `No news${t ? ` about "${t}"` : ''} in the past ${NEWS_DAYS} days (Wikipedia Current events${t ? ', Hacker News' : ''}). ` +
      'Try fewer or broader keywords, or search for background.';
  }
  // Tech stories take at most a third of the room when world news also matched.
  const techBudget = techLines.length ? (worldLines.length ? Math.floor(maxChars / 3) : maxChars) : 0;
  if (worldLines.length) sections.push(`World news${t ? ` about "${t}"` : ''} (Wikipedia Current events, newest first):\n${clipLines(worldLines, maxChars - techBudget - 60)}`);
  if (techLines.length) sections.push(`Tech news (Hacker News):\n${clipLines(techLines, techBudget - 30)}`);
  return sections.join('\n');
}
