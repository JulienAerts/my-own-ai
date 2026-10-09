import { expect, test } from '@playwright/test';
import { openApp, send } from './fixtures';

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('the header shows the assistant name in full and nothing scrolls sideways', async ({ page }) => {
    await openApp(page, { replies: ['Fine.'] });
    const name = page.locator('.brand-name');
    await expect(name).toHaveText('My Own AI');
    expect(await name.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await expect(page.locator('.chip-short')).toBeVisible();
    await send(page, 'Hi');
    await expect(page.locator('.msg.assistant').last()).toContainText('Fine.');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });

  test('settings open as a sheet with a scrollable tab row', async ({ page }) => {
    await openApp(page);
    await page.getByRole('button', { name: 'Settings' }).click();
    const tabs = page.locator('.tabs');
    await expect(tabs).toBeVisible();
    const row = await tabs.evaluate((el) => ({ scrolls: el.scrollWidth > el.clientWidth, dir: getComputedStyle(el).flexDirection }));
    expect(row.dir).toBe('row');
    expect(row.scrolls).toBe(true);
    await page.getByRole('tab', { name: 'App', exact: true }).click();
    await expect(page.getByRole('tab', { name: 'App', exact: true })).toHaveAttribute('aria-selected', 'true');
  });
});

test('scrolling up during a long chat shows a button back to the latest message', async ({ page }) => {
  await openApp(page, { replies: Array.from({ length: 6 }, (_, i) => `Answer ${i + 1}.\n\n${'Some text. '.repeat(60)}`) });
  for (let i = 0; i < 6; i++) {
    await send(page, `Question ${i + 1}`);
    await expect(page.locator('.msg.assistant')).toHaveCount(i + 1);
  }
  await page.locator('.messages').evaluate((el) => { el.scrollTop = 0; el.dispatchEvent(new Event('scroll')); });
  const back = page.getByRole('button', { name: 'Go to the latest message' });
  await expect(back).toBeVisible();
  await back.click();
  await expect(back).toBeHidden();
});
