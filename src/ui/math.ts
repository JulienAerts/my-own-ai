// Maths formulas (LaTeX) with KaTeX. Loaded on first use; see markdown.tsx.
import katex from 'katex';
import 'katex/dist/katex.min.css';

/** HTML for a formula; KaTeX escapes the input and refuses \href and the like (trust: false). */
export function renderMath(tex: string, display: boolean): string {
  return katex.renderToString(tex, { displayMode: display, throwOnError: false, output: 'html', strict: 'ignore' });
}
