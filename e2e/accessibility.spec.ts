// Automated accessibility checks (axe-core, WCAG 2.2 A and AA) on every main screen in
// both themes, and what screen readers are told while the assistant answers.
import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { openApp, send } from './fixtures';

const ANSWER = 'Here is **bold** and a [link](https://example.org).\n\n```python\nimport math\nclass Point:\n    def norm(self, x: float = 2.5) -> float:\n        name = "point"  # a comment\n        return math.sqrt(x * 3) if True else None\n```\n\n```js\nconst total = items.reduce((a, b) => a + b, 0);\n```';

async function violations(page: Page): Promise<string[]> {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  return r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(', ')}`);
}

for (const scheme of ['light', 'dark'] as const) {
  test(`no accessibility violations, ${scheme} theme`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await openApp(page, { replies: [ANSWER] });
    await page.waitForTimeout(1200); // entrance animations (they fade colours in)
    expect(await violations(page), 'empty chat').toEqual([]);
    await send(page, 'Hello');
    await page.locator('.msg.assistant').waitFor();
    await page.waitForTimeout(500);
    expect(await violations(page), 'chat').toEqual([]);
    await page.getByRole('button', { name: 'Conversations' }).click();
    await page.waitForTimeout(400);
    expect(await violations(page), 'history').toEqual([]);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Settings' }).click();
    for (const tab of await page.getByRole('tab').allTextContents()) {
      await page.getByRole('tab', { name: tab, exact: true }).click();
      await page.waitForTimeout(350);
      expect(await violations(page), `settings → ${tab}`).toEqual([]);
    }
  });
}

for (const scheme of ['light', 'dark'] as const) {
  test(`no violations in the first-run welcome and the assistants, ${scheme} theme`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await openApp(page, { chat: false });
    await page.waitForTimeout(2500);
    expect(await violations(page), 'first run').toEqual([]);
    await page.goto('about:blank');
    await openApp(page);
    await page.locator('.assistant-btn').click();
    await page.waitForTimeout(500);
    expect(await violations(page), 'assistant picker').toEqual([]);
    await page.getByRole('button', { name: 'New assistant' }).click();
    await page.waitForTimeout(500);
    expect(await violations(page), 'assistant editor').toEqual([]);
  });
}

test('screen readers hear the finished answer once, as plain text', async ({ page }) => {
  await openApp(page, { replies: ['The **answer** is [42](https://example.org).'] });
  const live = page.locator('[aria-live="polite"].sr-only');
  await send(page, 'What is the answer?');
  await expect(live).toHaveText('The answer is 42.');
  // The message list itself isn't a live region (it would repeat the answer while it streams).
  await expect(page.locator('main.messages')).not.toHaveAttribute('aria-live', /./);
});
