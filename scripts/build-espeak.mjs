// Builds public/espeak/: eSpeak-NG (Echogarden's Emscripten port) with only the
// English and French data, for the French Piper voices (the `phonemizer`
// package only has English). The full package carries every language (24 MB);
// this keeps the shared phoneme tables, en_dict, fr_dict and their voice files
// (about 1 MB). Run with `npm run espeak` after updating the package; the output
// is committed so builds don't depend on it.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const pkg = dirname(createRequire(import.meta.url).resolve('@echogarden/espeak-ng-emscripten/package.json'));
const js = readFileSync(join(pkg, 'espeak-ng.js'), 'utf8');
const data = readFileSync(join(pkg, 'espeak-ng.data'));

// The file packager's table: loadPackage({files:[{filename,start,end},…],remote_package_size:N})
const table = /loadPackage\(\{files:\[(.*?)\],remote_package_size:(\d+)\}\)/s.exec(js);
if (!table) throw new Error('espeak-ng.js: file table not found (package layout changed?)');
const files = [...table[1].matchAll(/\{filename:"([^"]*)",start:(\d+),end:(\d+)\}/g)].map((m) => ({ name: m[1], start: +m[2], end: +m[3] }));

const LANGS = ['en', 'fr'];
const keep = files.filter(({ name }) => {
  const dict = /\/([a-z]+)_dict$/.exec(name);
  if (dict) return LANGS.includes(dict[1]);
  const lang = /\/lang\/(.+)$/.exec(name);
  if (lang) return /^(gmw\/en|roa\/fr)/.test(lang[1]);
  return true; // phoneme tables, intonations, voice variants
});

const parts = [];
let offset = 0;
const entries = keep.map((f) => {
  const bytes = data.subarray(f.start, f.end);
  parts.push(bytes);
  const entry = `{filename:"${f.name}",start:${offset},end:${offset + bytes.length}}`;
  offset += bytes.length;
  return entry;
});

const out = join(dirname(createRequire(import.meta.url).resolve('../package.json')), 'public', 'espeak');
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'espeak-ng.data'), Buffer.concat(parts));
writeFileSync(join(out, 'espeak-ng.js'), js.replace(table[0], `loadPackage({files:[${entries.join(',')}],remote_package_size:${offset}})`));
writeFileSync(join(out, 'COPYING'), readFileSync(join(pkg, 'COPYING')));
console.log(`public/espeak: ${keep.length} of ${files.length} files, ${(offset / 1e6).toFixed(2)} MB of data`);
