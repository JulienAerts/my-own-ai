import { expect, test } from '@playwright/test';
import { modelCalls, openApp, send } from './fixtures';

test('a detail from early in a long conversation comes back when asked about', async ({ page }) => {
  const long = (n: number) => `Answer ${n}. ${'This part of the answer is long, to fill the conversation. '.repeat(30)}`;
  await openApp(page, { replies: [...Array.from({ length: 10 }, (_, i) => long(i + 1)), 'The cellar code is 4417.'] });
  await send(page, 'Please remember for later: the door code for the cellar is 4417.');
  await expect(page.locator('.msg.assistant')).toHaveCount(1);
  for (let i = 2; i <= 10; i++) {
    await send(page, `Tell me something interesting about topic number ${i}.`);
    await expect(page.locator('.msg.assistant')).toHaveCount(i);
  }
  // The start of the conversation has been folded into a summary by now.
  await expect(page.locator('.summary-row')).toHaveCount(1);
  await send(page, 'What was the code for the cellar door again?');
  await expect(page.locator('.msg.assistant').last()).toContainText('4417');
  const last = (await modelCalls(page)).filter((m) => !String(m[0].content).startsWith('You keep a')).at(-1)!;
  const system = String(last[0].content);
  expect(system).toContain('From earlier in this conversation');
  expect(system).toContain('the door code for the cellar is 4417');
  // The early message itself is no longer in the conversation the model sees.
  expect(last.slice(1).map((m) => String(m.content)).join('\n')).not.toContain('door code for the cellar is 4417');
});

test('an unrelated question brings nothing back', async ({ page }) => {
  const long = (n: number) => `Answer ${n}. ${'This part of the answer is long, to fill the conversation. '.repeat(30)}`;
  await openApp(page, { replies: Array.from({ length: 11 }, (_, i) => long(i + 1)) });
  await send(page, 'The door code for the cellar is 4417.');
  await expect(page.locator('.msg.assistant')).toHaveCount(1);
  for (let i = 2; i <= 10; i++) {
    await send(page, `Tell me something interesting about topic number ${i}.`);
    await expect(page.locator('.msg.assistant')).toHaveCount(i);
  }
  await send(page, 'Explain how photosynthesis works.');
  await expect(page.locator('.msg.assistant')).toHaveCount(11);
  const last = (await modelCalls(page)).filter((m) => !String(m[0].content).startsWith('You keep a')).at(-1)!;
  expect(String(last[0].content)).not.toContain('From earlier in this conversation');
});
