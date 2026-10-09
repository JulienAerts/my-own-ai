import { expect, test, type Page } from '@playwright/test';
import { openApp, send } from './fixtures';

/** Two conversations: one about a trip (its answer names Porto), then one about Python. */
async function twoConversations(page: Page) {
  await openApp(page, { replies: ['Lisbon is lovely, and Porto has the best pastéis in May.', 'Use the csv module.'] });
  await send(page, 'Where should I travel in Portugal?');
  await expect(page.locator('.msg.assistant').last()).toContainText('Porto');
  await page.getByRole('button', { name: 'Conversations' }).click();
  await page.locator('.history-tools').getByRole('button', { name: 'New conversation' }).click();
  // The panel closes and the message box is ready to type in.
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.composer textarea')).toBeFocused();
  await send(page, 'How do I read a CSV file?');
  await expect(page.locator('.msg.assistant').last()).toContainText('csv module');
  await page.getByRole('button', { name: 'Conversations' }).click();
}

test('search finds words inside answers and opens the conversation on that message', async ({ page }) => {
  await twoConversations(page);
  const search = page.getByRole('searchbox', { name: 'Search in all conversations' });
  await search.fill('pasteis porto'); // without the accent, words in any order
  await expect(page.getByRole('status')).toHaveText('1 conversation found');
  const result = page.locator('.history-item');
  await expect(result).toHaveCount(1);
  await expect(result.locator('.history-title')).toHaveText('Where should I travel in Portugal?');
  await expect(result.locator('mark')).toHaveText(['Porto', 'pastéis']);
  await result.locator('.history-open').click();
  await expect(page.locator('.msg.user').first()).toHaveText('Where should I travel in Portugal?');
  await expect(page.locator('.msg.assistant.found')).toContainText('Porto');
  // Nothing found.
  await page.getByRole('button', { name: 'Conversations' }).click();
  await search.fill('kangaroo');
  await expect(page.getByText('No conversation matches “kangaroo”.')).toBeVisible();
});

test('a conversation can be renamed and pinned, and stays so', async ({ page }) => {
  await twoConversations(page);
  const trip = page.locator('.history-item').filter({ hasText: 'Portugal' });
  // Rename with the menu, from the keyboard.
  await trip.getByRole('button', { name: /Actions for/ }).click();
  await expect(page.getByRole('menuitem', { name: 'Rename' })).toBeFocused();
  await page.keyboard.press('Enter');
  const field = page.getByRole('textbox', { name: /New name/ });
  await field.fill('Portugal trip');
  await field.press('Enter');
  await expect(page.locator('.history-title').filter({ hasText: 'Portugal trip' })).toBeVisible();
  // Pin it: it moves above the more recent one, under "Pinned".
  await page.locator('.history-item').filter({ hasText: 'Portugal trip' }).getByRole('button', { name: /Actions for/ }).click();
  await page.getByRole('menuitem', { name: 'Pin to the top' }).click();
  await expect(page.locator('.history-group').first()).toHaveText('Pinned');
  await expect(page.locator('.history-title').first()).toHaveText('Portugal trip');
  // Escape closes a menu without closing the panel.
  await page.locator('.history-item').first().getByRole('button', { name: /Actions for/ }).click();
  await expect(page.getByRole('menu')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Conversations' })).toBeVisible();
  // Still renamed and pinned after a reload, and after a new message in it.
  await page.locator('.history-item').first().locator('.history-open').click();
  await page.reload();
  await page.locator('textarea').first().waitFor();
  await page.getByRole('button', { name: 'Conversations' }).click();
  await expect(page.locator('.history-title').first()).toHaveText('Portugal trip');
  await expect(page.locator('.history-item').first().locator('.history-pin')).toBeVisible();
});
