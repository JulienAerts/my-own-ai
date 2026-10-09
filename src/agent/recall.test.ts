import { describe, expect, it } from 'vitest';
import type { ChatEntry } from './dialects';
import { earlierExchanges, keywordScores, recallBudget, recallEarlier } from './recall';

const u = (text: string, ts: number): ChatEntry => ({ role: 'user', text, ts });
const a = (text: string, ts: number): ChatEntry => ({ role: 'assistant', text, ts });

// A long conversation whose start was folded into a summary.
const chat: ChatEntry[] = [
  u('Our wifi network is called Maple-5G and the password hint is the dog name.', 1), a('Noted.', 2),
  u('The door code for the cellar is 4417.', 3), a('Got it, 4417.', 4),
  u('Can you suggest a recipe with leeks?', 5), a('Leek and potato soup.', 6),
  u('My sister Clara arrives on the 14th at 9:40 at Brussels-Midi.', 7), a('Noted.', 8),
  { role: 'summary', text: 'The user shared home details and plans.', ts: 9 },
  u('What should I cook tonight?', 10), a('Maybe a risotto.', 11),
];

describe('recall of summarized messages', () => {
  it('only offers exchanges the summary stands for', () => {
    const p = earlierExchanges(chat);
    expect(p.map((x) => x.ts)).toEqual([1, 3, 5, 7]);
    expect(p[1].text).toBe('User: The door code for the cellar is 4417.\nAssistant: Got it, 4417.');
    expect(earlierExchanges(chat.filter((e) => e.role !== 'summary'))).toEqual([]);
  });

  it('ranks by rare shared words', () => {
    const p = earlierExchanges(chat);
    const s = keywordScores('what was the cellar code again?', p);
    expect(s.indexOf(Math.max(...s))).toBe(1);
  });

  it('brings back the exact detail for a question about it, and nothing for an unrelated one', async () => {
    const hits = await recallEarlier(chat, 'When does Clara arrive, and at which station?', 4096);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toContain('9:40');
    expect(await recallEarlier(chat, 'Explain how photosynthesis works', 4096)).toEqual([]);
  });

  it('keeps to a small budget on phones', async () => {
    expect(recallBudget(2048)).toBe(600);
    expect(recallBudget(32768)).toBe(2400);
    const long = [u(`The plan: ${'cellar shelves '.repeat(200)}`, 1), a('OK', 2), { role: 'summary', text: 's', ts: 3 } as ChatEntry, u('x', 4)];
    const hits = await recallEarlier(long, 'cellar shelves plan', 2048);
    expect(hits.join('').length).toBeLessThanOrEqual(601);
  });
});
