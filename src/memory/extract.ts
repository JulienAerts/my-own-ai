// Automatic memory: after an answer, the model reads the user's message and
// notes what it reveals about them (name, family, home, work, tastes, projects,
// plans). Constrained to a small JSON shape, so small models can't ramble:
//  - facts, each marked lasting (a home, a job) or temporary (a trip next week,
//    an exam on Friday: forgotten after two weeks);
//  - the numbers of known facts the message makes untrue ("we moved to Paris"
//    outdates "lives in Brussels"), which the new fact replaces.
// The app checks the model's work: a fact must share words with the message
// (or it was made up), and a fact is only replaced by one about the same thing.
import type { Remote } from 'comlink';
import type { EngineApi } from '../worker/engine.worker';
import { Comlink } from '../worker/client';
import { splitThinking } from '../agent/dialects';
import { embedIfInstalled } from '../docs/store';
import { addMemory, deleteMemory, memoryRecordsFor, sameTopic, terms, type Memory } from './memory';

const DAY = 86_400_000;
/** A temporary fact is kept this long. */
const TEMPORARY_DAYS = 14;

function system(today: string): string {
  return 'You keep a memory of facts about the user, to personalise future conversations. ' + `Today is ${today}.\n` +
    'From the user\'s latest message, list what it reveals about the user: name, family and pets, where they live, ' +
    'work and studies, languages, tastes and preferences, health constraints, projects and goals, plans and important dates.\n' +
    '- "lasting": true for facts that stay true (name, home, job, tastes), false for things that will soon be over ' +
    '(a trip, an appointment, an exam, being ill).\n' +
    '- "outdated": the numbers of known facts that the message shows are no longer true (they moved, changed jobs, ' +
    'changed their mind); also write what is true now as a new fact.\n' +
    '- Facts mentioned in passing count too, even in a question or a request ("I\'m allergic to eggs, any cake recipe?").\n' +
    'Skip: the question itself, one-off tasks, general knowledge, what the assistant said, passwords or account numbers, ' +
    'and facts already known. Write each fact as a short sentence about "the user", in the language of the message.\n\n' +
    'Examples:\n' +
    'Known facts: (none)\n' +
    'Message: "I\'m Sam and I teach maths in Lyon. Any tips for grading faster?"\n' +
    '{"facts": [{"text": "The user\'s name is Sam.", "lasting": true}, {"text": "The user teaches maths in Lyon.", "lasting": true}], "outdated": []}\n\n' +
    'Known facts:\n1. The user lives in Brussels.\n2. The user has a dog named Rex.\n' +
    'Message: "We just moved to Paris, the flat is small but Rex loves it"\n' +
    '{"facts": [{"text": "The user lives in Paris.", "lasting": true}], "outdated": [1]}\n\n' +
    'Known facts:\n1. The user is vegetarian.\n' +
    'Message: "I\'m flying to Rome next Tuesday for a conference, what should I pack?"\n' +
    '{"facts": [{"text": "The user is flying to Rome next Tuesday for a conference.", "lasting": false}], "outdated": []}\n\n' +
    'Known facts:\n1. The user is vegetarian.\n' +
    'Message: "How do I convert a string to a number in Python?"\n' +
    '{"facts": [], "outdated": []}';
}

export const SCHEMA = JSON.stringify({
  type: 'object',
  properties: {
    // Limits are applied below: not every grammar engine supports maxItems/maxLength.
    facts: {
      type: 'array',
      items: { type: 'object', properties: { text: { type: 'string' }, lasting: { type: 'boolean' } }, required: ['text', 'lasting'] },
    },
    outdated: { type: 'array', items: { type: 'integer' } },
  },
  required: ['facts', 'outdated'],
});

// A message worth reading talks about the user. First-person words in the languages small
// models handle best; and any statement (not a question) of some length, in any language.
const ABOUT_ME = new RegExp(
  '(^|[^\\p{L}])(' + [
    "i|i'm|im|i've|i'd|i'll|my|mine|me|myself|we|we're|our|us", // English
    "je|j'|j’|mon|ma|mes|moi|nous|notre|nos|suis", // French
    'yo|mi|mis|me|nosotros|nuestro|nuestra|soy|estoy', // Spanish
    'ich|mein|meine|meinen|mich|mir|wir|unser|unsere|bin', // German
    'io|mio|mia|miei|mie|noi|nostro|nostra|sono', // Italian
    'eu|meu|minha|meus|minhas|nós|nosso|nossa|sou|estou', // Portuguese
    'ik|mijn|mij|wij|we|ons|onze|ben', // Dutch
  ].join('|') + ')(?=$|[^\\p{L}])',
  'iu',
);
// Never stored, whatever the model says.
const SECRET = /\b(password|passcode|pin code|mot de passe|iban|cvv)\b|\b\d{4}[ -]?\d{4}[ -]?\d{4}[ -]?\d{4}\b|\b\d{9,}\b/i;

export function worthReading(userText: string): boolean {
  const text = userText.trim();
  if (text.length < 8) return false;
  // Chinese, Japanese and Korean say a lot in few characters.
  const dense = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(text);
  const statement = !/[?？]\s*$/.test(text) && text.length >= (dense ? 12 : 30);
  return (text.length >= 12 && ABOUT_ME.test(text)) || statement;
}

/**
 * Below 2B parameters, models get it wrong too often to save facts unasked (in tests, Qwen3
 * 0.6B and 1.7B copied back facts the message had just made untrue: "I'm not vegetarian
 * anymore" → "The user is vegetarian"). They still
 * save what the user asks them to remember. Unknown sizes (custom models) are allowed.
 */
export function bigEnoughForMemory(params: string | undefined): boolean {
  const m = params?.match(/^([\d.]+)\s*([MB])/i);
  if (!m) return true;
  return parseFloat(m[1]) * (m[2].toUpperCase() === 'M' ? 0.001 : 1) >= 2;
}

export interface Extraction {
  facts: { text: string; lasting: boolean }[];
  outdated: number[];
}

/** The prompt for one exchange; `known` are numbered from 1. */
export function extractionMessages(exchange: { user: string; assistant: string }, known: string[], today = new Date()) {
  const date = today.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  return [
    { role: 'system' as const, content: system(date) },
    {
      role: 'user' as const,
      content:
        `Known facts:\n${known.length ? known.map((k, i) => `${i + 1}. ${k}`).join('\n') : '(none)'}\n\n` +
        `Message: ${JSON.stringify(exchange.user.slice(0, 1500))}\n\n` +
        `(The assistant answered, for context only: ${JSON.stringify(exchange.assistant.slice(0, 400))})`,
    },
  ];
}

/** The model's answer, tolerant of the older shape (facts as plain strings). */
export function parseExtraction(raw: string): Extraction {
  try {
    // The JSON, after any thinking: some templates open a <think> block the answer never closes.
    const rest = splitThinking(raw).rest.trim() || raw.replace(/^\s*<think>/, '');
    const o = JSON.parse(rest.slice(rest.indexOf('{'))) as { facts?: unknown[]; outdated?: unknown[] };
    const facts = (o.facts ?? []).flatMap((f) => {
      if (typeof f === 'string') return [{ text: f, lasting: true }];
      if (f && typeof f === 'object' && typeof (f as { text?: unknown }).text === 'string') {
        return [{ text: (f as { text: string }).text, lasting: (f as { lasting?: unknown }).lasting !== false }];
      }
      return [];
    });
    const outdated = (o.outdated ?? []).filter((n): n is number => Number.isInteger(n));
    return { facts, outdated };
  } catch {
    return { facts: [], outdated: [] };
  }
}

/**
 * Grounded in the message: a fact sharing none of its words was made up. Words with the same
 * first five letters count too: forms of a word, and the same word in another language (models
 * often write the fact in English: "allergisch" → "allergic").
 */
export function grounded(fact: string, message: string): boolean {
  const said = terms(message);
  const shares = (t: string) => said.some((w) => w === t || (Math.min(w.length, t.length) >= 5 && w.slice(0, 5) === t.slice(0, 5)));
  return terms(fact).some(shares);
}

// A fact is written about "the user" (in the message's language); one that isn't is general
// knowledge ("The Eiffel Tower is 330 m tall"). One that describes the request itself isn't a fact.
const ABOUT_USER = /\b(user|utilisat(eur|rice)|usuari[oa]|usuário|(be)?nutzer(in)?|utente|utilizador(a)?|gebruiker)\b/i;
const THE_REQUEST = /\b(is|was) (asking|requesting|looking for help|wondering)|\bwants? (to know|help|advice)|\b(asks|asked) (for|about|how|what|if)\b|\bdemande\b/i;

/** A fact worth keeping: about the user, not the question they asked. */
export function aboutUser(fact: string): boolean {
  return ABOUT_USER.test(fact) && !THE_REQUEST.test(fact);
}

export interface MemoryChange {
  /** Memories added or refreshed. */
  saved: Memory[];
  /** Memories the new ones replaced (kept whole, for Undo). */
  replaced: Memory[];
}

/**
 * Read one exchange and update memory. Returns what changed (for the "Memory
 * updated" chip and its Undo), with empty lists if nothing did.
 */
export async function extractMemories(
  engine: Remote<EngineApi>,
  exchange: { user: string; assistant: string },
  opts: { reasoning?: boolean; assistantId?: string; source: Memory['source'] },
): Promise<MemoryChange> {
  const none: MemoryChange = { saved: [], replaced: [] };
  if (!worthReading(exchange.user)) return none;
  const known = await memoryRecordsFor(exchange.user, { assistantId: opts.assistantId, limit: 12 });
  const res = await engine.generate(
    extractionMessages(exchange, known.map((m) => m.text)),
    { responseFormat: { type: 'json_object', schema: SCHEMA }, maxTokens: 320, temperature: 0.1, ...(opts.reasoning && { thinking: false }) },
    Comlink.proxy(() => {}),
  );
  if (res.finishReason !== 'stop') return none;
  const { facts, outdated } = parseExtraction(res.text);

  const now = Date.now();
  const kept = facts
    .slice(0, 3)
    .map((f) => ({ text: f.text.trim().replace(/\s+/g, ' ').slice(0, 200), lasting: f.lasting }))
    .filter((f) => f.text.length >= 8 && !SECRET.test(f.text) && aboutUser(f.text) && grounded(f.text, exchange.user));
  if (!kept.length) return none;

  // Known facts the model says are no longer true, if a new fact is about the same thing.
  const vectors = (await embedIfInstalled(kept.map((f) => f.text))) ?? [];
  const old = [...new Set(outdated)]
    .map((n) => known[n - 1])
    .filter((m): m is Memory => !!m && kept.some((f, i) => sameTopic(m, f.text, vectors[i])));

  const saved: Memory[] = [];
  for (const f of kept) {
    const pinned = old.some((m) => m.pinned); // a replaced pinned fact stays pinned
    const { memory } = await addMemory(f.text, {
      auto: true, assistantId: opts.assistantId, source: opts.source, pinned,
      until: f.lasting ? undefined : now + TEMPORARY_DAYS * DAY,
    });
    saved.push(memory);
  }
  const replaced = old.filter((m) => !saved.some((s) => s.id === m.id));
  if (replaced.length) await deleteMemory(...replaced.map((m) => m.id));
  return { saved, replaced };
}
