import { describe, expect, it } from 'vitest';
import type { ChatEntry } from './agent/dialects';
import type { ConversationMeta } from './db';
import { queryWords, searchConversations, snippet } from './search';

const meta = (id: string, title: string, updatedAt: number): ConversationMeta => ({ id, title, createdAt: 0, updatedAt, messages: 2 });
const chat = (...texts: [string, string][]): ChatEntry[] =>
  texts.map(([role, text], i) => ({ role, text, ts: 1000 + i }) as ChatEntry);

const metas = [meta('a', 'Trip ideas', 300), meta('b', 'Python help', 200), meta('c', 'Mon CV', 100)];
const chats = new Map<string, ChatEntry[]>([
  ['a', chat(['user', 'Where should I go in Portugal in May?'], ['assistant', 'Lisbon and Porto are lovely in spring; the Douro valley too.'])],
  ['b', chat(['user', 'How do I read a CSV file?'], ['assistant', 'Use the csv module: import csv, then csv.reader(open("data.csv")).'])],
  ['c', chat(['user', 'Peux-tu relire mon résumé ?'], ['assistant', 'Bien sûr ! Ton résumé est clair, ajoute tes compétences en Python.'])],
]);

describe('conversation search', () => {
  it('finds words inside messages, not only titles', () => {
    const hits = searchConversations('porto', metas, chats);
    expect(hits.map((h) => h.meta.id)).toEqual(['a']);
    expect(hits[0].ts).toBe(1001);
    expect(hits[0].snippet.filter((p) => p.hit).map((p) => p.text)).toEqual(['Porto']);
  });

  it('ignores case and accents', () => {
    expect(searchConversations('RESUME', metas, chats).map((h) => h.meta.id)).toEqual(['c']);
    expect(searchConversations('résumé', metas, chats).map((h) => h.meta.id)).toEqual(['c']);
  });

  it('needs every word, and puts conversations with them in one message first', () => {
    expect(searchConversations('csv python', metas, chats).map((h) => h.meta.id)).toEqual(['b']);
    // "python" is in b's title and in c's answer: both match, the more recent first.
    expect(searchConversations('python', metas, chats).map((h) => h.meta.id)).toEqual(['b', 'c']);
    expect(searchConversations('lisbon csv', metas, chats)).toEqual([]);
    expect(searchConversations('   ', metas, chats)).toEqual([]);
  });

  it('matches titles too', () => {
    const [hit] = searchConversations('ideas', metas, chats);
    expect(hit.meta.id).toBe('a');
    expect(hit.snippet).toEqual([]);
  });

  it('cuts a snippet around the match and marks every occurrence', () => {
    const long = `${'word '.repeat(60)}the secret code is 4417 and the 4417 again ${'tail '.repeat(60)}`;
    const parts = snippet(long, queryWords('4417'));
    const text = parts.map((p) => p.text).join('');
    expect(text.startsWith('…')).toBe(true);
    expect(text.endsWith('…')).toBe(true);
    expect(text.length).toBeLessThan(170);
    expect(parts.filter((p) => p.hit).map((p) => p.text)).toEqual(['4417', '4417']);
    // Marks follow the original text, accents included.
    expect(snippet('Un résumé clair', queryWords('resume')).find((p) => p.hit)?.text).toBe('résumé');
  });
});
