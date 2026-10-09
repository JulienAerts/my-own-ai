import { expect, test } from '@playwright/test';
import { openApp, send, toolCall } from './fixtures';

test('answers, with a tool call shown as a readable row', async ({ page }) => {
  await openApp(page, { replies: [toolCall('calculator', { expression: '17*23' }), '17 × 23 is **391**.'] });
  await send(page, 'What is 17 times 23?');
  const row = page.locator('.tool').first();
  await expect(row).toContainText('Calculator');
  await expect(row).toContainText('17*23');
  await expect(row).toContainText('391');
  await expect(page.locator('.msg.assistant').last()).toContainText('17 × 23 is 391.');
  await expect(page.locator('.msg.assistant strong').last()).toHaveText('391');
});

test('a lead-in before a tool call still runs the tool', async ({ page }) => {
  await openApp(page, { replies: [`Let me calculate that:\n\n${toolCall('calculator', { expression: '2+2' })}`, 'It is 4.'] });
  await send(page, 'Whats 2+2');
  await expect(page.locator('.tool').first()).toContainText('4');
  await expect(page.locator('.msg.assistant').last()).toHaveText(/It is 4\./);
  await expect(page.getByText('<tool_call>')).toHaveCount(0);
});

test('regenerating keeps the earlier answer as a version', async ({ page }) => {
  await openApp(page, { replies: ['First answer.', 'Second answer.'] });
  await send(page, 'Hello');
  await expect(page.locator('.msg.assistant').last()).toContainText('First answer.');
  await page.getByRole('button', { name: 'Regenerate answer' }).click();
  await expect(page.locator('.msg.assistant').last()).toContainText('Second answer.');
  await expect(page.locator('.versions-n')).toHaveText('2 / 2');
  await page.getByRole('button', { name: 'Previous version' }).click();
  await expect(page.locator('.msg.assistant').last()).toContainText('First answer.');
  await expect(page.locator('.versions-n')).toHaveText('1 / 2');
});

test('editing a question keeps the old conversation as a version', async ({ page }) => {
  await openApp(page, { replies: ['About cats.', 'About dogs.'] });
  await send(page, 'Tell me about cats');
  await expect(page.locator('.msg.assistant').last()).toContainText('About cats.');
  await page.locator('.user-wrap').first().hover();
  await page.getByRole('button', { name: 'Edit and resend' }).first().click();
  await page.locator('.msg.user.editing textarea').fill('Tell me about dogs');
  await page.locator('.edit-actions').getByRole('button', { name: 'Send' }).click();
  await expect(page.locator('.msg.assistant').last()).toContainText('About dogs.');
  await page.getByRole('button', { name: 'Previous version' }).click();
  await expect(page.locator('.msg.user').first()).toHaveText('Tell me about cats');
  await expect(page.locator('.msg.assistant').last()).toContainText('About cats.');
});

test('conversations are saved and listed in the history', async ({ page }) => {
  await openApp(page, { replies: ['Ghent is in Belgium.'] });
  await send(page, 'Where is Ghent?');
  await expect(page.locator('.msg.assistant').last()).toContainText('Belgium');
  await page.getByRole('button', { name: 'Conversations' }).click();
  await expect(page.locator('.history-item')).toContainText('Where is Ghent?');
});

test('switching to another assistant and back to the default one', async ({ page }) => {
  await openApp(page);
  await page.locator('.assistant-btn').click();
  await page.getByRole('button', { name: 'New assistant' }).click();
  await page.getByRole('button', { name: /Tutor/ }).click();
  await page.getByRole('button', { name: 'Save' }).click();
  // Start a conversation with the Tutor.
  await page.getByRole('button', { name: /Tutor/ }).first().click();
  await expect(page.locator('.chat-head .brand-name')).toHaveText('Tutor');
  await expect(page.locator('.chat-head .assistant-mark')).toHaveText('🎓');
  // And back to the built-in assistant.
  await page.locator('.assistant-btn').click();
  await page.getByRole('button', { name: /My Own AI/ }).first().click();
  await expect(page.locator('.chat-head .brand-name')).toHaveText('My Own AI');
  await expect(page.locator('.chat-head .orb')).toBeVisible();
});

test('an assistant can use the app’s logo, and the emoji logo is shown full size', async ({ page }) => {
  await openApp(page);
  await page.locator('.assistant-btn').click();
  await page.getByRole('button', { name: 'New assistant' }).click();
  await page.getByRole('button', { name: /Tutor/ }).click();
  await page.getByLabel(/Use the app’s logo/).check();
  await page.getByRole('button', { name: 'Save' }).click();
  await page.getByRole('button', { name: /Tutor/ }).first().click();
  await expect(page.locator('.chat-head .orb')).toBeVisible();
  // The app's logo, set to an emoji, follows into this assistant, without a sphere behind it.
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('tab', { name: 'Appearance' }).click();
  await page.getByRole('radiogroup', { name: 'Logo' }).getByRole('radio', { name: 'Emoji' }).click();
  await page.getByRole('button', { name: '🦉' }).click();
  await page.keyboard.press('Escape');
  const logo = page.locator('.chat-head .orb-emoji');
  await expect(logo).toHaveText('🦉');
  expect(await logo.evaluate((el) => getComputedStyle(el).backgroundImage)).toBe('none');
});
