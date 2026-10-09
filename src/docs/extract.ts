// Text out of user files, then split into overlapping passages for search.
// PDFs go through pdf.js (loaded only when a PDF is added); text formats are
// read directly. Scanned PDFs have no text layer and are reported as such.
import { t } from '../i18n/i18n';

export interface Passage {
  text: string;
  /** 1-based PDF page the passage starts on. */
  page?: number;
}

export interface Extracted {
  passages: Passage[];
  pages?: number;
  chars: number;
}

const EXTENSIONS = ['.pdf', '.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.html', '.htm', '.xml', '.log', '.yaml', '.yml'];
const MIME_TYPES = ['application/pdf', 'text/*', 'application/json', 'application/xml', 'application/yaml', 'application/x-yaml'];
/**
 * For `<input accept>`. Desktop file dialogs filter by extension, but Android
 * turns `accept` into MIME types for the system picker. With only extensions
 * next to `image/*`, it offered photos and the camera and no documents, so the
 * MIME types are listed too.
 */
export const ACCEPT = [...MIME_TYPES, ...EXTENSIONS].join(',');

/** Whether a picked file is a document this app can read. */
export function isSupportedDocument(file: File): boolean {
  const name = file.name.toLowerCase();
  return EXTENSIONS.some((e) => name.endsWith(e)) || isPdf(file) || file.type.startsWith('text/') ||
    ['application/json', 'application/xml', 'application/yaml', 'application/x-yaml'].includes(file.type);
}
const MAX_BYTES = 50 * 1024 * 1024;
const TARGET = 450; // characters per passage: small enough to stay on one topic
const OVERLAP = 80;

export function isPdf(file: File): boolean {
  return file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
}

async function pdfPages(file: File, onProgress?: (fraction: number) => void): Promise<string[]> {
  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).href;
  const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
  let doc;
  try {
    doc = await task.promise;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(/password/i.test(msg) ? 'This PDF is password-protected.' : `Couldn't read this PDF (${msg}).`);
  }
  const pages: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const content = await (await doc.getPage(i)).getTextContent();
    let text = '';
    for (const item of content.items) {
      if (!('str' in item)) continue;
      text += item.str + (item.hasEOL ? '\n' : ' ');
    }
    pages.push(text.replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').trim());
    onProgress?.(i / doc.numPages);
  }
  await task.destroy();
  return pages;
}

function plainText(raw: string, name: string): string {
  if (/\.(html?|xml)$/i.test(name)) {
    const doc = new DOMParser().parseFromString(raw, /\.xml$/i.test(name) ? 'application/xml' : 'text/html');
    doc.querySelectorAll('script, style, noscript').forEach((n) => n.remove());
    return (doc.body ?? doc.documentElement).textContent ?? '';
  }
  return raw;
}

/** Split into ~TARGET-char passages on paragraph, then sentence, boundaries, with overlap. */
export function splitPassages(text: string, page?: number): Passage[] {
  const paras = text.split(/\n\s*\n/).map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const pieces: string[] = [];
  for (const p of paras) {
    if (p.length <= TARGET) {
      pieces.push(p);
      continue;
    }
    // Long paragraph: break on sentence ends, falling back to hard cuts.
    let cur = '';
    for (const s of p.split(/(?<=[.!?;:])\s+/)) {
      if (cur && cur.length + s.length + 1 > TARGET) {
        pieces.push(cur);
        cur = '';
      }
      if (s.length > TARGET) {
        for (let i = 0; i < s.length; i += TARGET) pieces.push(s.slice(i, i + TARGET));
      } else cur = cur ? `${cur} ${s}` : s;
    }
    if (cur) pieces.push(cur);
  }
  // Merge small pieces up to TARGET, carrying a little overlap into the next passage.
  const out: Passage[] = [];
  let cur = '';
  for (const piece of pieces) {
    if (cur && cur.length + piece.length + 1 > TARGET) {
      out.push({ text: cur, page });
      cur = cur.slice(-OVERLAP).replace(/^\S*\s/, '');
    }
    cur = cur ? `${cur} ${piece}` : piece;
  }
  if (cur.trim()) out.push({ text: cur, page });
  return out;
}

export async function extract(file: File, onProgress?: (fraction: number) => void): Promise<Extracted> {
  if (!isSupportedDocument(file)) {
    throw new Error('This file type isn\'t supported. Attach a PDF, a text file (TXT, Markdown, CSV, JSON, HTML, XML, YAML) or an image.');
  }
  if (file.size > MAX_BYTES) throw new Error(t('This file is too large ({size} MB; the limit is 50 MB).', { size: Math.round(file.size / 1024 / 1024) }));
  if (isPdf(file)) {
    const pages = await pdfPages(file, onProgress);
    const passages = pages.flatMap((t, i) => splitPassages(t, i + 1));
    const chars = pages.reduce((n, p) => n + p.length, 0);
    if (chars < 20 * pages.length && chars < 200) {
      throw new Error('No text found in this PDF. It may be a scanned image; text recognition (OCR) is not supported yet.');
    }
    return { passages, pages: pages.length, chars };
  }
  const text = plainText(await file.text(), file.name);
  onProgress?.(1);
  if (!text.trim()) throw new Error('This file has no text.');
  return { passages: splitPassages(text), chars: text.length };
}
