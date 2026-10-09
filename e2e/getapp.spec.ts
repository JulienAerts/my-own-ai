import { expect, test, type Page } from '@playwright/test';
import { openApp } from './fixtures';

const WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36';
const ANDROID = 'Mozilla/5.0 (Linux; Android 15; CPH2611) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Mobile Safari/537.36';
const SETUP = 'My.Own.AI_0.19.2_x64-setup.exe';

/** GitHub, answered here: the latest release, and its installer as a download. */
async function fakeGitHub(page: Page) {
  await page.route('https://api.github.com/repos/**/releases/latest', (route) => route.fulfill({
    contentType: 'application/json',
    headers: { 'access-control-allow-origin': '*' },
    body: JSON.stringify({
      tag_name: 'desktop-v0.19.2',
      assets: [SETUP, 'My.Own.AI_0.19.2_aarch64.dmg'].map((name) => ({ name, size: 9_400_000, browser_download_url: `https://github.com/test/releases/download/desktop-v0.19.2/${name}` })),
    }),
  }));
  await page.route('https://github.com/test/releases/download/**', (route) => route.fulfill({
    body: 'installer', headers: { 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename="${SETUP}"` },
  }));
}

test.describe('on a Windows PC', () => {
  test.use({ userAgent: WINDOWS });

  test('settings offer the Windows app, and the button downloads the installer', async ({ page }) => {
    await fakeGitHub(page);
    await openApp(page);
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('tab', { name: 'App', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Desktop app' })).toBeVisible();
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download for Windows' }).click()]);
    expect(download.suggestedFilename()).toBe(SETUP);
    await expect(page.getByRole('status').filter({ hasText: 'Downloading version 0.19.2' })).toContainText('More info → Run anyway');
    // The lookup is listed with the app's other requests.
    await page.getByRole('tab', { name: 'Network' }).click();
    await expect(page.locator('.net-item').filter({ hasText: 'GitHub' }).first()).toBeVisible();
  });

  test('the chat suggests the app from the third visit, until dismissed', async ({ page }) => {
    await openApp(page);
    await expect(page.locator('.get-app-card')).toHaveCount(0);
    await page.reload();
    await expect(page.locator('.get-app-card')).toHaveCount(0);
    await page.reload();
    await expect(page.locator('.get-app-card')).toContainText('My Own AI for Windows');
    await expect(page.locator('.get-app-card')).toContainText('image generation'); // Windows only
    await page.locator('.get-app-card').getByRole('button', { name: 'Not now' }).click();
    await expect(page.locator('.get-app-card')).toHaveCount(0);
    await page.reload();
    await page.locator('textarea').first().waitFor();
    await expect(page.locator('.get-app-card')).toHaveCount(0);
  });
});

test.describe('on an Android phone', () => {
  test.use({ userAgent: ANDROID, viewport: { width: 390, height: 844 } });

  test('settings offer the Android app, and the model list doesn’t', async ({ page }) => {
    await openApp(page);
    await page.getByRole('button', { name: 'Settings' }).click();
    await expect(page.locator('.get-app-line')).toHaveCount(0);
    await page.getByRole('tab', { name: 'App', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Android app' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Download for Android' })).toBeVisible();
    await expect(page.getByText('Web search and page reading that work on every site')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Desktop app' })).toHaveCount(0);
  });
});
