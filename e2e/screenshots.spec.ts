// The README's screenshots (docs/images), from a sample conversation written straight
// into the app's storage. Not part of the test run: `SCREENSHOTS=1 npx playwright test
// screenshots`. The sample person is "Sam": never a real name.
import { test, type Page } from '@playwright/test';
import { openApp } from './fixtures';

test.skip(!process.env.SCREENSHOTS, 'Set SCREENSHOTS=1 to refresh docs/images.');

const MODEL = 'Qwen3-8B-q4f16_1-MLC';
const T = Date.UTC(2026, 9, 9, 9, 0);

const trip = [
  { role: 'user', text: 'What’s 17 × 23? Check it in Python.', ts: T },
  {
    role: 'assistant', ts: T + 4000, tps: 42.3, thinking: 'Simple multiplication; show the code and why it works.', thinkSecs: 2,
    text: '**391**. In Python:\n\n```python\nprint(17 * 23)  # 391\n```\n\nIt works because $17 \\times 23 = 17 \\times 20 + 17 \\times 3 = 340 + 51$.',
  },
  { role: 'user', text: 'I’m Sam and I live in Brussels. Any idea for a weekend trip?', ts: T + 60_000 },
  {
    role: 'assistant', ts: T + 66_000, tps: 41.0,
    text: 'From Brussels, a few easy weekend trips:\n\n- **Ghent** (30 min by train): canals, Gravensteen castle.\n- **Bruges**: medieval centre, best early morning.\n- **Ardennes** (Durbuy, La Roche): hiking and kayaking.\n\n| Trip | Travel | Best for |\n|---|---|---|\n| Ghent | 30 min | City walks |\n| Ardennes | 1h30 | Nature |',
  },
  { role: 'memory', ids: ['m1'], texts: ['The user lives in Brussels.'], ts: T + 67_000 },
];

const weather = [
  { role: 'user', text: 'Will it rain in Ghent tomorrow? I want to cycle to work.', ts: T + 120_000 },
  {
    role: 'tool', name: 'weather', args: { place: 'Ghent' }, ts: T + 123_000,
    result: 'Ghent, Belgium. Tomorrow: 14–19 °C, light rain 7–9 h (2 mm), then dry and cloudy; wind 18 km/h SW.',
  },
  {
    role: 'assistant', ts: T + 128_000, tps: 38.6, thinking: 'Rain only early; suggest leaving after 9.', thinkSecs: 3,
    text: 'Light rain in the morning, **7–9 h** (about 2 mm), then dry and cloudy, 14–19 °C.\n\nIf you can leave **after 9**, you’ll stay dry; otherwise a light rain jacket is enough. The wind is mild (18 km/h, south-west).',
  },
];

/** Start the app with `entries` as the open conversation and `look` as the appearance. */
async function open(page: Page, entries: unknown[], look: Record<string, unknown> = {}) {
  await openApp(page, { model: MODEL });
  await page.evaluate(async ({ entries, look }) => {
    const db = await new Promise<IDBDatabase>((ok, ko) => {
      const r = indexedDB.open('harness');
      r.onsuccess = () => ok(r.result);
      r.onerror = () => ko(r.error);
    });
    const id = 'sample';
    const list = entries as { ts: number; role: string; text?: string }[];
    const tx = db.transaction(['chats', 'conversations', 'settings'], 'readwrite');
    tx.objectStore('chats').put(entries, id);
    tx.objectStore('conversations').put({
      id, title: list.find((e) => e.role === 'user')?.text, createdAt: list[0].ts, updatedAt: list.at(-1)!.ts,
      messages: list.filter((e) => e.role === 'user' || e.role === 'assistant').length,
    });
    tx.objectStore('settings').put(id, 'currentChat');
    await new Promise((ok) => (tx.oncomplete = ok));
    const appearance = { theme: 'indigo', mode: 'light', black: false, background: 'glow', bgDim: 0.35, logo: 'orb', logoEmoji: '✨', bubble: 'gradient', corners: 'round', size: 'm', font: 'inter', ...look };
    localStorage.setItem('appearance', JSON.stringify(appearance));
    const t2 = db.transaction('settings', 'readwrite');
    t2.objectStore('settings').put(appearance, 'appearance');
    await new Promise((ok) => (t2.oncomplete = ok));
  }, { entries, look });
  await page.reload();
  await page.locator('.composer textarea').waitFor();
  await page.waitForTimeout(1200); // entrance animations
}

const shot = (name: string) => `docs/images/${name}.png`;

test('chat, light', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 760 });
  await open(page, trip);
  await page.screenshot({ path: shot('chat-light') });
});

test('phone, dark', async ({ page }) => {
  await page.setViewportSize({ width: 400, height: 860 });
  await open(page, trip, { theme: 'ocean', mode: 'dark' });
  await page.screenshot({ path: shot('phone-dark') });
});

test('a tool and its answer, Ocean dark', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 760 });
  await open(page, [...trip.slice(2), ...weather], { theme: 'ocean', mode: 'dark', background: 'aurora' });
  await page.screenshot({ path: shot('chat-dark') });
});

test('appearance settings', async ({ page }) => {
  await page.setViewportSize({ width: 400, height: 860 });
  await open(page, trip);
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('tab', { name: 'Appearance' }).click();
  await page.waitForTimeout(700);
  await page.screenshot({ path: shot('appearance') });
});
