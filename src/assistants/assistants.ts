// Assistants: named setups for different jobs ("Code helper", "French tutor"),
// each with its own instructions, preferred model, tools, documents, memory
// and conversation starters. Conversations belong to one. The built-in
// assistant ("My Own AI") is the app as it always was and isn't stored.
import { useEffect, useState } from 'preact/hooks';
import { getSetting, newChatId, setSetting } from '../db';
import { t } from '../i18n/i18n';

export interface Assistant {
  id: string;
  name: string;
  /** One emoji, shown in the header and the history. */
  emoji: string;
  /** Show the app's logo (Settings → Appearance) instead of the emoji. */
  appLogo?: boolean;
  /** Its role and how it should answer; the user's own instructions still apply. */
  instructions: string;
  /** Preferred model id; the chat offers to switch when another one is loaded. */
  modelId?: string;
  /** Tool names it may use; unset = the user's default tools (Settings → Tools). */
  tools?: string[];
  /** Documents it always has at hand (knowledge), from the document library. */
  docIds?: string[];
  /** 'own': what it learns about the user stays with it (it still sees shared memories). */
  memory: 'shared' | 'own';
  /** Suggestions on an empty chat. */
  starters?: string[];
  createdAt: number;
}

export const DEFAULT_ASSISTANT: Assistant = {
  id: 'default',
  name: 'My Own AI',
  emoji: '✨',
  instructions: '',
  memory: 'shared',
  starters: [t('What’s the weather in Brussels?'), t('Who was Ada Lovelace?'), t('Convert 250 USD to EUR'), t('What’s 17% of 2,340?')],
  createdAt: 0,
};

/** Starting points for a new assistant. */
export const TEMPLATES: Omit<Assistant, 'id' | 'createdAt'>[] = [
  {
    name: t('Writing coach'),
    emoji: '✍️',
    instructions: t('You help the user write clearly. Point out unclear sentences, suggest tighter wording, and keep their voice. When asked to rewrite, show the improved text first, then a short list of what changed.'),
    tools: ['define_word', 'search'],
    memory: 'shared',
    starters: [t('Make this email more concise'), t('Is this paragraph clear?'), t('Help me write a polite reminder')],
  },
  {
    name: t('Code helper'),
    emoji: '🧑‍💻',
    instructions: t('You are a senior software engineer. Give working code with brief explanations, mention edge cases, and prefer simple, standard solutions. Use the code tool to check results when it helps.'),
    tools: ['run_code', 'search', 'calculator'],
    memory: 'own',
    starters: [t('Explain this error message'), t('Write a Python function that…'), t('Review this code for bugs')],
  },
  {
    name: t('Translator'),
    emoji: '🌍',
    instructions: t('You translate between English and French (and other languages when asked). Give the translation first, natural and idiomatic, then note any expression that has no direct equivalent.'),
    tools: ['define_word'],
    memory: 'shared',
    starters: [t('Translate to French: …'), t('How do you say “it’s raining cats and dogs” in French?')],
  },
  {
    name: t('Tutor'),
    emoji: '🎓',
    instructions: t('You are a patient tutor. Explain step by step, check understanding with a short question, and give hints before full answers when the user is practising.'),
    tools: ['calculator', 'search', 'run_code'],
    memory: 'own',
    starters: [t('Explain photosynthesis simply'), t('Quiz me on French verbs'), t('Help me understand derivatives')],
  },
];

// ---------------------------------------------------------------------------
// Store

let list: Assistant[] = [];
let loaded: Promise<void> | null = null;
const subs = new Set<() => void>();

function load(): Promise<void> {
  loaded ??= getSetting('assistants')
    .then((v) => { list = v ?? []; })
    .catch(() => {})
    .finally(() => subs.forEach((fn) => fn()));
  return loaded;
}

async function save(next: Assistant[]) {
  list = next;
  subs.forEach((fn) => fn());
  await setSetting('assistants', next);
}

/** Every assistant, the built-in one first. */
export async function listAssistants(): Promise<Assistant[]> {
  await load();
  return [DEFAULT_ASSISTANT, ...list];
}

export function assistantById(id: string | undefined): Assistant {
  return (id && list.find((a) => a.id === id)) || DEFAULT_ASSISTANT;
}

export function useAssistants(): Assistant[] {
  const [, bump] = useState(0);
  useEffect(() => {
    const fn = () => bump((n) => n + 1);
    subs.add(fn);
    load();
    return () => void subs.delete(fn);
  }, []);
  return [DEFAULT_ASSISTANT, ...list];
}

export async function saveAssistant(a: Omit<Assistant, 'id' | 'createdAt'> & { id?: string; createdAt?: number }): Promise<Assistant> {
  await load();
  const full: Assistant = { ...a, id: a.id ?? newChatId(), createdAt: a.createdAt ?? Date.now() } as Assistant;
  await save(list.some((x) => x.id === full.id) ? list.map((x) => (x.id === full.id ? full : x)) : [...list, full]);
  return full;
}

export async function deleteAssistant(id: string): Promise<void> {
  await load();
  await save(list.filter((a) => a.id !== id));
}

/** The memory owner for an assistant: itself when its memory is private, else shared (undefined). */
export function memoryOwner(a: Assistant): string | undefined {
  return a.memory === 'own' && a.id !== DEFAULT_ASSISTANT.id ? a.id : undefined;
}
