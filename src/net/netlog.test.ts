import { beforeAll, describe, expect, it } from 'vitest';

beforeAll(() => {
  (globalThis as { location?: unknown }).location ??= new URL('https://app.example/');
});

describe('network activity', async () => {
  const { isExternal, serviceOf } = await import('./netlog');

  it('lists only requests that leave the device', () => {
    expect(isExternal('https://huggingface.co/x')).toBe(true);
    expect(isExternal('/assets/app.js')).toBe(false);
    expect(isExternal('https://app.example/sw.js')).toBe(false);
    expect(isExternal('http://127.0.0.1:8080/v1/chat/completions')).toBe(false);
    expect(isExternal('http://ipc.localhost/plugin%3Ahttp%7Cfetch')).toBe(false);
    expect(isExternal('blob:https://app.example/1234')).toBe(false);
    expect(isExternal('data:text/plain,hi')).toBe(false);
  });

  it('groups hosts by service', () => {
    expect(serviceOf('cas-bridge.xethub.hf.co')).toBe('Hugging Face');
    expect(serviceOf('en.wikipedia.org')).toBe('Wikipedia');
    expect(serviceOf('release-assets.githubusercontent.com')).toBe('GitHub');
    expect(serviceOf('www.cbc.ca')).toBe('cbc.ca');
  });
});
