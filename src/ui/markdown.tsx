// Markdown for model output: paragraphs, headings, lists, quotes, tables,
// rules, code blocks (highlighted, with a Copy button), maths ($…$, $$…$$,
// \(…\), \[…\]), **bold**, *italic*, ~~strike~~, `code` and http(s) links.
// Builds vnodes directly, so model text is never parsed as HTML; only
// highlight.js and KaTeX output (both escape their input) is set as HTML.
// Those two libraries load the first time a message needs them.
import type { ComponentChildren } from 'preact';
import { useEffect, useMemo, useState } from 'preact/hooks';
import { CopyButton } from './copy';
import { t } from '../i18n/i18n';

// ---------------------------------------------------------------------------
// Lazily loaded renderers

interface Lazy<T> { value?: T; promise?: Promise<T>; failed?: boolean }
const highlighter: Lazy<typeof import('./highlight')> = {};
const mathRenderer: Lazy<typeof import('./math')> = {};

function useLazy<T>(slot: Lazy<T>, load: () => Promise<T>): T | undefined {
  const [, rerender] = useState(0);
  useEffect(() => {
    if (slot.value || slot.failed) return;
    slot.promise ??= load().then((v) => (slot.value = v), (e) => {
      slot.failed = true; // offline before it was ever cached: stay plain
      console.warn('Renderer unavailable', e);
      throw e;
    });
    let live = true;
    slot.promise.then(() => live && rerender((n) => n + 1), () => {});
    return () => { live = false; };
  }, []);
  return slot.value;
}

// ---------------------------------------------------------------------------
// Inline

const INLINE = new RegExp([
  /(`[^`]+`)/.source, // 1 code
  /(\\\((?:(?!\\\)).)+\\\))/.source, // 2 \( math \)
  // 3 $math$: no space inside the dollars, and no digit right after ("$5 and $10" stays text).
  /((?<![\\$\w])\$(?=[^\s$])[^$\n]*?[^\s\\$]\$(?![\d$]))/.source,
  /(\*\*[^*]+\*\*|__[^_]+__)/.source, // 4 bold
  // 5 italic: _x_ only between non-word characters, so snake_case names stay intact.
  /(\*[^*\s][^*]*\*|(?<!\w)_[^_\s][^_]*_(?!\w))/.source,
  /(~~[^~]+~~)/.source, // 6 strike
  /(\[[^\]]+\]\(https?:\/\/[^\s)]+\))/.source, // 7 link
].join('|'), 'g');

function inline(text: string): ComponentChildren[] {
  const out: ComponentChildren[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0];
    if (m[1]) out.push(<code>{t.slice(1, -1)}</code>);
    else if (m[2]) out.push(<MathTex tex={t.slice(2, -2)} />);
    else if (m[3]) out.push(<MathTex tex={t.slice(1, -1)} />);
    else if (m[4]) out.push(<strong>{inline(t.slice(2, -2))}</strong>);
    else if (m[5]) out.push(<em>{inline(t.slice(1, -1))}</em>);
    else if (m[6]) out.push(<s>{inline(t.slice(2, -2))}</s>);
    else {
      const i = t.indexOf('](');
      out.push(<a href={t.slice(i + 2, -1)} target="_blank" rel="noopener noreferrer">{t.slice(1, i)}</a>);
    }
    last = m.index + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function MathTex({ tex, display }: { tex: string; display?: boolean }) {
  const m = useLazy(mathRenderer, () => import('./math'));
  const html = useMemo(() => m?.renderMath(tex, !!display), [m, tex, display]);
  if (!html) return display ? <pre class="md-math-src"><code>{tex}</code></pre> : <code>{tex}</code>;
  return display
    ? <div class="md-math" dangerouslySetInnerHTML={{ __html: html }} />
    : <span class="md-math-inline" dangerouslySetInnerHTML={{ __html: html }} />;
}

// ---------------------------------------------------------------------------
// Code blocks

export function CodeBlock({ code, lang, streaming }: { code: string; lang?: string; streaming?: boolean }) {
  const hl = useLazy(highlighter, () => import('./highlight'));
  // Not while streaming: re-highlighting on every token costs GPU-time-sensitive frames.
  const out = useMemo(() => (hl && !streaming && code.length < 20_000 ? hl.highlight(code, lang) : null), [hl, code, lang, streaming]);
  const label = lang || out?.lang || 'code';
  return (
    <div class="code-block">
      <div class="code-head">
        <span>{label}</span>
        {!streaming && <CopyButton text={code} label={t('Copy code')} />}
      </div>
      {out
        ? <pre><code class="hljs" dangerouslySetInnerHTML={{ __html: out.html }} /></pre>
        : <pre><code>{code}</code></pre>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Blocks

const BULLET = /^\s*[-*+]\s+/;
const NUMBER = /^\s*\d+[.)]\s+/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const QUOTE = /^\s*>\s?/;
const FENCE = /^\s*```/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

function cells(row: string): string[] {
  let r = row.trim();
  if (r.startsWith('|')) r = r.slice(1);
  if (r.endsWith('|') && !r.endsWith('\\|')) r = r.slice(0, -1);
  return r.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
}

/** `$$` or `\[` display maths: [closing delimiter, text after the opening one]. */
function mathOpen(line: string): [string, string] | null {
  const t = line.trim();
  if (t.startsWith('$$')) return ['$$', t.slice(2)];
  if (t.startsWith('\\[')) return ['\\]', t.slice(2)];
  return null;
}

function blocks(lines: string[], streaming?: boolean): ComponentChildren[] {
  const out: ComponentChildren[] = [];
  let i = 0;
  const startsBlock = (l: string, next?: string) =>
    !l.trim() || BULLET.test(l) || NUMBER.test(l) || HEADING.test(l) || FENCE.test(l) || QUOTE.test(l) || RULE.test(l) ||
    !!mathOpen(l) || (l.includes('|') && next !== undefined && TABLE_SEP.test(next));

  while (i < lines.length) {
    const line = lines[i];

    if (FENCE.test(line)) {
      const lang = line.trim().slice(3).trim().split(/\s/)[0].toLowerCase() || undefined;
      const code: string[] = [];
      i++;
      while (i < lines.length && !FENCE.test(lines[i])) code.push(lines[i++]);
      i++; // closing fence (or end of a still-streaming block)
      out.push(<CodeBlock code={code.join('\n')} lang={lang} streaming={streaming} />);
      continue;
    }

    const math = mathOpen(line);
    if (math) {
      const [close, first] = math;
      const tex: string[] = [];
      if (first.trimEnd().endsWith(close) && first.trim().length > close.length - 1) {
        // One line: $$ x $$
        tex.push(first.trimEnd().slice(0, -close.length));
        i++;
      } else {
        if (first.trim()) tex.push(first);
        i++;
        while (i < lines.length && !lines[i].includes(close)) tex.push(lines[i++]);
        if (i < lines.length) {
          const before = lines[i].slice(0, lines[i].indexOf(close));
          if (before.trim()) tex.push(before);
          i++;
        }
      }
      out.push(<MathTex tex={tex.join('\n').trim()} display />);
      continue;
    }

    const h = HEADING.exec(line);
    if (h) {
      out.push(<p class={`md-h md-h${Math.min(h[1].length, 3)}`}>{inline(h[2])}</p>);
      i++;
      continue;
    }

    if (RULE.test(line)) {
      out.push(<hr />);
      i++;
      continue;
    }

    if (line.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
      const head = cells(line);
      const align = cells(lines[i + 1]).map((c) => (c.endsWith(':') ? (c.startsWith(':') ? 'center' : 'right') : undefined));
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(cells(lines[i++]));
      out.push(
        <div class="md-table">
          <table>
            <thead><tr>{head.map((c, j) => <th style={align[j] && { textAlign: align[j] }}>{inline(c)}</th>)}</tr></thead>
            <tbody>{rows.map((r) => <tr>{head.map((_, j) => <td style={align[j] && { textAlign: align[j] }}>{inline(r[j] ?? '')}</td>)}</tr>)}</tbody>
          </table>
        </div>,
      );
      continue;
    }

    if (QUOTE.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i])) quoted.push(lines[i++].replace(QUOTE, ''));
      out.push(<blockquote>{blocks(quoted, streaming)}</blockquote>);
      continue;
    }

    if (BULLET.test(line) || NUMBER.test(line)) {
      const ordered = NUMBER.test(line);
      const re = ordered ? NUMBER : BULLET;
      const items: ComponentChildren[] = [];
      while (i < lines.length && re.test(lines[i])) items.push(<li>{inline(lines[i++].replace(re, ''))}</li>);
      out.push(ordered ? <ol>{items}</ol> : <ul>{items}</ul>);
      continue;
    }

    if (!line.trim()) {
      i++;
      continue;
    }

    const para: string[] = [];
    while (i < lines.length && (para.length === 0 || !startsBlock(lines[i], lines[i + 1]))) para.push(lines[i++]);
    out.push(<p>{para.flatMap((l, j) => (j ? [<br />, ...inline(l)] : inline(l)))}</p>);
  }
  return out;
}

/** `streaming`: the text is still arriving (no highlighting or Copy buttons yet). */
export function Markdown({ text, streaming }: { text: string; streaming?: boolean }) {
  return <div class="md">{blocks(text.split('\n'), streaming)}</div>;
}
