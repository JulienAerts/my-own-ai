import { describe, expect, it } from 'vitest';
import type { ChatEntry } from './agent/dialects';
import { replaceTurn, switchVersion, switcherPlaces, versionsAt } from './versions';

const u = (text: string, ts: number) => ({ role: 'user' as const, text, ts });
const a = (text: string, ts: number): ChatEntry => ({ role: 'assistant', text, ts });
const texts = (list: ChatEntry[]) => list.map((e) => ('text' in e ? e.text : e.role));

describe('response versions', () => {
  const chat = [u('hi', 1), a('hello', 2), u('2+2?', 3), a('5', 4)];

  it('keeps the replaced answer when regenerating', () => {
    let next = replaceTurn(chat, 2, u('2+2?', 5));
    expect(texts(next)).toEqual(['hi', 'hello', '2+2?']);
    next = [...next, a('4', 6)];
    expect(versionsAt(next, 2)).toEqual({ current: 1, total: 2 });
    const back = switchVersion(next, 2, 0);
    expect(texts(back)).toEqual(['hi', 'hello', '2+2?', '5']);
    expect(texts(switchVersion(back, 2, 1))).toEqual(['hi', 'hello', '2+2?', '4']);
  });

  it('keeps the old question and everything after it when editing', () => {
    let next = [...replaceTurn(chat, 0, u('hey', 7)), a('hey there', 8)];
    expect(versionsAt(next, 0)).toEqual({ current: 1, total: 2 });
    next = switchVersion(next, 0, 0);
    expect(texts(next)).toEqual(['hi', 'hello', '2+2?', '5']);
  });

  it('remembers what was added to a version before switching away', () => {
    let next = [...replaceTurn(chat, 2, u('2+2?', 5)), a('4', 6)];
    next = [...next, u('and 3+3?', 7), a('6', 8)];
    const v0 = switchVersion(next, 2, 0);
    expect(texts(switchVersion(v0, 2, 1))).toEqual(['hi', 'hello', '2+2?', '4', 'and 3+3?', '6']);
  });

  it('adds a third version from any shown version', () => {
    let next = [...replaceTurn(chat, 2, u('2+2?', 5)), a('4', 6)];
    next = switchVersion(next, 2, 0);
    next = [...replaceTurn(next, 2, u('2+2?', 9)), a('four', 10)];
    expect(versionsAt(next, 2)).toEqual({ current: 2, total: 3 });
    expect(texts(switchVersion(next, 2, 0))).toEqual(['hi', 'hello', '2+2?', '5']);
    expect(texts(switchVersion(next, 2, 1))).toEqual(['hi', 'hello', '2+2?', '4']);
  });

  it('puts the switcher on the turn’s answer, or on the question without one', () => {
    const next = [...replaceTurn(chat, 2, u('2+2?', 5)), a('4', 6)];
    expect([...switcherPlaces(next)]).toEqual([[3, 2]]);
    expect([...switcherPlaces(replaceTurn(chat, 2, u('2+2?', 5)))]).toEqual([[2, 2]]);
  });
});
