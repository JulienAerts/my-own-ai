import { describe, expect, it } from 'vitest';
import { aboutUser, bigEnoughForMemory, extractionMessages, grounded, parseExtraction, worthReading } from './extract';
import { sameTopic } from './memory';

const mem = (text: string) => ({ id: '1', text, createdAt: 0, updatedAt: 0 });

describe('automatic memory', () => {
  it('reads messages about the user in many languages, and statements in any', () => {
    expect(worthReading('I live in Ghent with my two cats')).toBe(true);
    expect(worthReading('Je suis allergique aux arachides.')).toBe(true);
    expect(worthReading('Mi hija Ana empieza la universidad.')).toBe(true);
    expect(worthReading('Ich bin allergisch gegen Nüsse.')).toBe(true);
    expect(worthReading('私は東京に住んでいて、猫を二匹飼っています。')).toBe(true); // a statement
    expect(worthReading('What is the capital of Peru?')).toBe(false);
    expect(worthReading('hi')).toBe(false);
  });

  it('parses facts with their lasting flag, and the outdated numbers', () => {
    expect(parseExtraction('<think>\n{"facts": [{"text": "The user is Sam.", "lasting": true}], "outdated": []}').facts).toHaveLength(1);
    expect(parseExtraction('<think>ok</think>\n{"facts": [], "outdated": [2]}').outdated).toEqual([2]);
    expect(parseExtraction('{"facts": [{"text": "The user lives in Paris.", "lasting": true}, {"text": "The user flies to Rome on Tuesday.", "lasting": false}], "outdated": [1]}'))
      .toEqual({ facts: [{ text: 'The user lives in Paris.', lasting: true }, { text: 'The user flies to Rome on Tuesday.', lasting: false }], outdated: [1] });
    expect(parseExtraction('{"facts": ["The user is Sam."]}')).toEqual({ facts: [{ text: 'The user is Sam.', lasting: true }], outdated: [] });
    expect(parseExtraction('not json')).toEqual({ facts: [], outdated: [] });
  });

  it('numbers the known facts and dates the prompt', () => {
    const [sys, user] = extractionMessages({ user: 'We moved to Paris', assistant: 'Nice!' }, ['The user lives in Brussels.'], new Date('2026-10-09T12:00:00'));
    expect(sys.content).toContain('Today is Friday, October 9, 2026');
    expect(user.content).toContain('1. The user lives in Brussels.');
  });

  it('saves facts unasked only with models of 2B parameters or more', () => {
    expect(bigEnoughForMemory('0.6B')).toBe(false);
    expect(bigEnoughForMemory('360M')).toBe(false);
    expect(bigEnoughForMemory('1.7B')).toBe(false);
    expect(bigEnoughForMemory('2B')).toBe(true);
    expect(bigEnoughForMemory('30B (3B active)')).toBe(true);
    expect(bigEnoughForMemory(undefined)).toBe(true);
  });

  it('keeps facts about the user, not general knowledge or the request', () => {
    expect(aboutUser('The user is allergic to nuts.')).toBe(true);
    expect(aboutUser("L'utilisatrice habite à Gand.")).toBe(true);
    expect(aboutUser('The Eiffel Tower is 330 metres tall.')).toBe(false);
    expect(aboutUser('The user is asking for help to write a polite email.')).toBe(false);
    expect(aboutUser('The user wants to know how to cook rice.')).toBe(false);
    expect(aboutUser('The user wants to learn Japanese.')).toBe(true);
  });

  it('keeps facts grounded in the message', () => {
    expect(grounded('The user lives in Paris.', 'We moved to Paris last month')).toBe(true);
    expect(grounded('The user loves jazz.', 'We moved to Paris last month')).toBe(false);
    expect(grounded('The user is allergic to nuts.', 'Ich bin allergisch gegen Nüsse')).toBe(true);
  });

  it('only lets a new fact replace a memory about the same thing', () => {
    expect(sameTopic(mem('The user lives in Brussels.'), 'The user lives in Paris.')).toBe(true);
    expect(sameTopic(mem('The user loves coffee.'), 'The user quit coffee and drinks tea.')).toBe(true);
    expect(sameTopic(mem('The user has a dog named Rex.'), 'The user lives in Paris.')).toBe(false);
    expect(sameTopic(mem('The user has a dog named Rex.'), 'The user has a cat named Mimi.')).toBe(false);
    expect(sameTopic(mem('The user works at Google as a designer.'), 'The user started a new job at Spotify.')).toBe(true);
    expect(sameTopic(mem("L'utilisateur habite à Gand."), "L'utilisateur a déménagé à Lyon.")).toBe(true);
    expect(sameTopic(mem('The user works at Google.'), 'The user has twins.')).toBe(false);
  });
});
