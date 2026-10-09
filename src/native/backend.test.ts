import { describe, expect, it } from 'vitest';
import { engineFor, estimatedFreeMB, modelFiles, nativeComplete, nativeContext, nativeContexts, nativeModelsFor, recommendedNative, yarnFor, type Gpu } from './backend';

const gpu = (gb: number, cuda = true): Gpu => ({ name: 'test', vramMB: gb * 1024, driver: '', vendor: cuda ? 'nvidia' : 'amd', cuda });

describe('native model sizing', () => {
  it('keeps small GPUs on WebLLM', () => {
    expect(nativeModelsFor(gpu(6))).toEqual([]);
  });
  it('offers what fits, with a context that fits too', () => {
    const list = nativeModelsFor(gpu(24));
    expect(list.map((m) => m.fixedId)).toContain('gguf:Qwen3-32B-Q4_K_M');
    const big = list.find((m) => m.fixedId === 'gguf:Qwen3-32B-Q4_K_M')!;
    expect(nativeContext(big, gpu(24))).toBe(16384);
    expect(recommendedNative(list)?.fixedId).toBe('gguf:Qwen3-30B-A3B-Q4_K_M');
  });
  it('recommends a smaller model on a 12 GB card', () => {
    const list = nativeModelsFor(gpu(12));
    expect(list.some((m) => m.fixedId === 'gguf:Qwen3-30B-A3B-Q4_K_M')).toBe(false);
    expect(recommendedNative(list)).toBeDefined();
  });
});

describe('AMD and Intel GPUs', () => {
  it('picks the CUDA build only for NVIDIA cards, Vulkan otherwise', () => {
    expect(engineFor(gpu(24))).toBe('cuda-12.4');
    expect(engineFor(gpu(16, false))).toBe('vulkan');
    expect(engineFor(null)).toBe('vulkan');
    // The app names the build for each system: Metal on Apple Silicon, Vulkan on Linux.
    expect(engineFor({ ...gpu(48, false), vendor: 'other', engine: 'metal' } as Gpu)).toBe('metal');
    expect(engineFor({ ...gpu(24, false), vendor: 'nvidia', engine: 'vulkan' } as Gpu)).toBe('vulkan');
  });
  it('sizes models the same way whatever the vendor', () => {
    expect(nativeModelsFor(gpu(16, false)).map((m) => m.fixedId)).toEqual(nativeModelsFor(gpu(16)).map((m) => m.fixedId));
  });
  it('estimates free memory from the loaded chat model', () => {
    const g = gpu(16, false);
    expect(estimatedFreeMB(g, null)).toBe(16 * 1024 - 1000);
    const m = nativeModelsFor(g)[0];
    expect(estimatedFreeMB(g, { model: m, ctx: 8192 })).toBeLessThan(16 * 1024 - 1000 - 4000);
  });
});

describe('long contexts', () => {
  const max = (id: string, gb = 24) => {
    const m = nativeModelsFor(gpu(gb)).find((x) => x.fixedId === id)!;
    return nativeContexts(m, gpu(gb)).at(-1);
  };
  it('fits what each model allows on a 24 GB card', () => {
    expect(max('gguf:Qwen3.5-9B-Q4_K_M')).toBe(262144);
    expect(max('gguf:Qwen3.5-27B-Q4_K_M')).toBe(131072);
    expect(max('gguf:Qwen3-14B-Q4_K_M')).toBe(131072);
    expect(max('gguf:Qwen3-30B-A3B-Q4_K_M')).toBe(65536);
  });
  it('keeps the automatic choice at 16k', () => {
    for (const m of nativeModelsFor(gpu(24))) expect(nativeContext(m, gpu(24))).toBeLessThanOrEqual(16384);
  });
  it('turns on YaRN only past Qwen3\'s trained 32k', () => {
    const [q3] = nativeModelsFor(gpu(24));
    expect(yarnFor(q3, 32768)).toBeNull();
    expect(yarnFor(q3, 65536)).toBe(32768);
    const q35 = nativeModelsFor(gpu(24)).find((x) => x.fixedId === 'gguf:Qwen3.5-9B-Q4_K_M')!;
    expect(yarnFor(q35, 262144)).toBeNull();
  });
});

describe('downloaded models', () => {
  it('counts a model as downloaded when all its files are there, whatever their exact size', () => {
    const m = nativeModelsFor(gpu(24)).find((x) => x.fixedId === 'gguf:Qwen3.5-9B-Q4_K_M')!;
    const files = modelFiles(m).map((f) => ({ file: f.file, bytes: f.bytes - 12_345_678 })); // listed sizes are estimates
    expect(nativeComplete(m, { models: files })).toBe(true);
    expect(nativeComplete(m, { models: files.slice(0, 1) })).toBe(false); // the image encoder is missing
    expect(nativeComplete(m, null)).toBe(false);
  });
});
