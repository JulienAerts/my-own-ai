import { expect, test } from '@playwright/test';
import { openApp } from './fixtures';

test('settings list their sections down the side on a wide screen', async ({ page }) => {
  await openApp(page);
  await page.getByRole('button', { name: 'Settings' }).click();
  const tabs = page.getByRole('tab');
  await expect(tabs.first()).toBeVisible();
  await page.waitForTimeout(400); // the window's opening animation scales it
  const first = await tabs.nth(0).boundingBox();
  const second = await tabs.nth(1).boundingBox();
  expect(second!.x).toBeCloseTo(first!.x, 0); // a column, not a row
  expect(second!.y).toBeGreaterThan(first!.y);
  // Arrow keys move between sections.
  await tabs.nth(0).focus();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('tab', { selected: true })).toHaveText('Tools');
});

test('the interface switches to French', async ({ page }) => {
  await openApp(page, { lang: 'fr' });
  await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
  await expect(page.locator('.composer textarea')).toHaveAttribute('placeholder', 'Écrire à My Own AI');
  await page.getByRole('button', { name: 'Réglages' }).click();
  await expect(page.locator('#settings-title')).toHaveText('Réglages');
  await page.getByRole('tab', { name: 'App', exact: true }).click();
  await page.locator('.lang-select').selectOption('en');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
});

test('the network log lists requests to the internet', async ({ page }) => {
  await page.route('https://example.org/**', (route) => route.fulfill({ status: 200, body: 'hello', headers: { 'content-length': '5' } }));
  await openApp(page);
  await page.evaluate(() => fetch('https://example.org/test?q=1').then((r) => r.text()));
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('tab', { name: 'Network' }).click();
  await expect(page.locator('.net-item')).toContainText('example.org');
  await page.locator('.net-item summary').first().click();
  await expect(page.locator('.net-detail')).toContainText('https://example.org/test?q=1');
});

test('a problem report has the diagnostics but not the conversation', async ({ page, context }) => {
  await openApp(page, { replies: ['Secret answer.'] });
  await page.locator('.composer textarea').fill('my secret question');
  await page.keyboard.press('Enter');
  await expect(page.locator('.msg.assistant').last()).toContainText('Secret answer.');
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('tab', { name: 'App', exact: true }).click();
  await page.getByRole('button', { name: 'Prepare a report…' }).click();
  const report = page.getByRole('textbox', { name: 'Report' });
  await expect(report).toHaveValue(/Version: .+\(browser, interface: en\)/);
  await expect(report).toHaveValue(/Model: Hermes-3-Llama-3.2-3B/);
  expect(await report.inputValue()).not.toContain('secret');
  const [github] = await Promise.all([context.waitForEvent('page'), page.getByRole('button', { name: 'Open on GitHub' }).click()]);
  expect(github.url()).toContain('/issues/new?');
  expect(decodeURIComponent(github.url())).toContain('Diagnostics');
});

test('the logo and background can be personalised', async ({ page }) => {
  await openApp(page);
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('tab', { name: 'Appearance' }).click();
  await page.getByRole('radiogroup', { name: 'Background' }).getByRole('radio', { name: 'Aurora' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-bg', 'aurora');
  await page.getByRole('radiogroup', { name: 'Logo' }).getByRole('radio', { name: 'Emoji' }).click();
  await page.getByRole('button', { name: '🦊' }).click();
  await page.keyboard.press('Escape');
  await expect(page.locator('.chat-head .orb-emoji')).toHaveText('🦊');
  // A picture as the background, shrunk and kept for next time.
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('tab', { name: 'Appearance' }).click();
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('radiogroup', { name: 'Background' }).getByRole('radio', { name: 'Picture' }).click();
  await (await chooser).setFiles({ name: 'bg.png', mimeType: 'image/png', buffer: png });
  await expect(page.locator('html')).toHaveAttribute('data-bg', 'image');
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bg-image'))).toContain('data:image/jpeg');
});
