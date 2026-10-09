import { describe, expect, it } from 'vitest';
import { EXAMPLE_SKILL, parseSkillMd } from './skills';

describe('parseSkillMd', () => {
  it('reads front matter, including folded blocks and quotes', () => {
    const s = parseSkillMd('---\nname: "Invoice Filer"\ndescription: >\n  File invoices.\n  Use when asked.\nlicense: MIT\n---\n# Steps\n1. Read.\n');
    expect(s).toEqual({ name: 'Invoice Filer', description: 'File invoices. Use when asked.', body: '# Steps\n1. Read.' });
  });
  it('treats a file without front matter as instructions only', () => {
    expect(parseSkillMd('Just do it.')).toEqual({ body: 'Just do it.' });
  });
  it('parses the built-in example', () => {
    const s = parseSkillMd(EXAMPLE_SKILL);
    expect(s.name).toBe('meeting-notes');
    expect(s.description).toMatch(/^Turn rough meeting notes/);
  });
});
