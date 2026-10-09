// Syntax highlighting for code blocks (highlight.js core plus the languages
// small models write most). Loaded on first use; see markdown.tsx.
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import go from 'highlight.js/lib/languages/go';
import ini from 'highlight.js/lib/languages/ini';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import kotlin from 'highlight.js/lib/languages/kotlin';
import markdown from 'highlight.js/lib/languages/markdown';
import php from 'highlight.js/lib/languages/php';
import plaintext from 'highlight.js/lib/languages/plaintext';
import powershell from 'highlight.js/lib/languages/powershell';
import python from 'highlight.js/lib/languages/python';
import ruby from 'highlight.js/lib/languages/ruby';
import rust from 'highlight.js/lib/languages/rust';
import sql from 'highlight.js/lib/languages/sql';
import swift from 'highlight.js/lib/languages/swift';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

const LANGUAGES = { bash, c, cpp, csharp, css, diff, dockerfile, go, ini, java, javascript, json, kotlin, markdown, php, plaintext, powershell, python, ruby, rust, sql, swift, typescript, xml, yaml };
for (const [name, lang] of Object.entries(LANGUAGES)) hljs.registerLanguage(name, lang);

/** Guessing is slow on long code; only these are tried for blocks without a language. */
const GUESS = ['python', 'javascript', 'typescript', 'bash', 'json', 'xml', 'css', 'sql', 'java', 'cpp', 'csharp', 'go', 'rust'];

/** Highlighted HTML (escaped by highlight.js), and the language it was read as. */
export function highlight(code: string, lang?: string): { html: string; lang?: string } {
  if (lang && hljs.getLanguage(lang)) {
    return { html: hljs.highlight(code, { language: lang, ignoreIllegals: true }).value, lang };
  }
  const r = hljs.highlightAuto(code, GUESS);
  return { html: r.value, lang: r.relevance >= 5 ? r.language : undefined };
}
