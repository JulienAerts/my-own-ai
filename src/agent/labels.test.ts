import { describe, expect, it } from 'vitest';
import { withoutSpeakerLabel } from './dialects';

describe('speaker labels', () => {
  it('drops the assistant’s own name at the start of a reply', () => {
    expect(withoutSpeakerLabel('J.A.R.V.I.S.: A simple sum: 4.', 'Jarvis')).toBe('A simple sum: 4.');
    expect(withoutSpeakerLabel('**Tutor:** Let’s see.', 'Tutor')).toBe('Let’s see.');
    expect(withoutSpeakerLabel('Assistant: Hello!')).toBe('Hello!');
  });
  it('leaves other replies alone', () => {
    expect(withoutSpeakerLabel('Note: 2+2 is 4.', 'Jarvis')).toBe('Note: 2+2 is 4.');
    expect(withoutSpeakerLabel('Jarvis is a character from Iron Man.', 'Jarvis')).toBe('Jarvis is a character from Iron Man.');
  });
});
