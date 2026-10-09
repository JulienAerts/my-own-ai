import { expect, test } from '@playwright/test';
import { openApp } from './fixtures';

test('a new visitor gets the welcome steps and model choices', async ({ page }) => {
  // A WebGPU-capable device without a real GPU: enough for the start-up checks.
  await page.addInitScript(() => {
    const adapter = {
      features: new Set(['shader-f16']), limits: { maxBufferSize: 2 ** 31, maxStorageBufferBindingSize: 2 ** 31 },
      info: { vendor: 'nvidia', architecture: 'lovelace', description: '' }, isFallbackAdapter: false,
      requestAdapterInfo: async () => ({ vendor: 'nvidia', architecture: 'lovelace' }),
    };
    Object.defineProperty(navigator, 'gpu', { value: { requestAdapter: async () => adapter, getPreferredCanvasFormat: () => 'bgra8unorm' } });
    Object.defineProperty(navigator, 'deviceMemory', { value: 32 });
  });
  await openApp(page, { chat: false });
  await expect(page.getByRole('heading', { name: 'Your own AI, on this device' })).toBeVisible();
  await page.getByRole('button', { name: 'Get started' }).click();
  const models = page.locator('.first-model');
  await expect(models.first()).toContainText('Recommended');
  expect(await models.count()).toBeGreaterThanOrEqual(2);
  await models.nth(1).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'A few choices' })).toBeVisible();
  // The download button names the chosen model; the test stops before downloading.
  await expect(page.getByRole('button', { name: /^Download / })).toBeVisible();
});
