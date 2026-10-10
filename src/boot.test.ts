import { describe, expect, it } from 'vitest';
import { phoneAutoContext, phoneContexts } from './boot';
import { ALL_MODELS } from './models';

const model = (family: string) => ALL_MODELS.find((m) => m.family === family)!;

describe('context size on phones', () => {
  it('gives text models more than 2048 tokens when their conversation memory fits', () => {
    expect(phoneContexts(model('Qwen2.5-1.5B-Instruct'))).toEqual([2048, 4096, 8192]);
    expect(phoneContexts(model('Qwen3-1.7B'))).toEqual([2048, 4096, 8192]); // 896 MiB at 8k
    expect(phoneAutoContext(model('Qwen2.5-1.5B-Instruct'))).toBe(8192); // 224 MiB
    expect(phoneAutoContext(model('Llama-3.2-1B-Instruct'))).toBe(8192); // 256 MiB
    expect(phoneAutoContext(model('Qwen3-1.7B'))).toBe(4096); // 448 MiB (8k would be 896)
    expect(phoneAutoContext(model('Qwen3-4B'))).toBe(4096); // 576 MiB
  });

  it('keeps the vision model at 2048, and models whose memory per layer is too big lower', () => {
    expect(phoneContexts(model('Phi-3.5-vision-instruct'))).toEqual([]);
    expect(phoneAutoContext(model('Phi-3.5-vision-instruct'))).toBe(2048);
    // Phi-3.5 mini: 12 KiB per token per layer, so 8k would be 96 MiB in one buffer; 1.5 GiB in all at 4k.
    expect(phoneContexts(model('Phi-3.5-mini-instruct'))).toEqual([2048]);
    expect(phoneAutoContext(model('Phi-3.5-mini-instruct'))).toBe(2048);
  });

  it('counts double for 32-bit builds (no 16-bit shaders)', () => {
    expect(phoneAutoContext(model('Qwen3-1.7B'), true)).toBe(2048); // 4k would be 896 MiB
    expect(phoneContexts(model('Qwen3-1.7B'), true)).toEqual([2048, 4096]);
  });
});
