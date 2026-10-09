import { describe, expect, it } from 'vitest';
import { repoFromLink, suggestedQuant, type Quant } from './custom';

describe('repoFromLink', () => {
  it('reads repository and file links', () => {
    expect(repoFromLink('https://huggingface.co/owner/Model-GGUF')).toEqual({ repo: 'owner/Model-GGUF' });
    expect(repoFromLink('huggingface.co/owner/Model-GGUF')).toEqual({ repo: 'owner/Model-GGUF' });
    expect(repoFromLink('owner/Model-GGUF')).toEqual({ repo: 'owner/Model-GGUF' });
    expect(repoFromLink('https://huggingface.co/o/m/blob/main/sub/m-Q4_K_M.gguf?download=true')).toEqual({ repo: 'o/m', file: 'sub/m-Q4_K_M.gguf' });
  });
  it('refuses what is not a model link', () => {
    expect(repoFromLink('not a link')).toBeNull();
    expect(repoFromLink('https://huggingface.co/api/models')).toBeNull();
  });
});

describe('suggestedQuant', () => {
  const q = (label: string, gb: number): Quant => ({ label, file: `${label}.gguf`, bytes: gb * 1e9, parts: [] });
  const list = [q('IQ2_XXS', 9), q('Q3_K_M', 13), q('Q4_K_S', 16), q('Q4_K_M', 17), q('Q6_K', 22)];
  it('prefers Q4_K_M when it fits', () => {
    expect(suggestedQuant(list, (x) => x.bytes < 20e9)?.label).toBe('Q4_K_M');
  });
  it('falls back to another 4-bit, then the biggest that fits', () => {
    expect(suggestedQuant(list, (x) => x.bytes < 16.5e9)?.label).toBe('Q4_K_S');
    expect(suggestedQuant(list, (x) => x.bytes < 14e9)?.label).toBe('Q3_K_M');
    expect(suggestedQuant(list, () => false)).toBeUndefined();
  });
});
