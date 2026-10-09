// Test helpers: start the app straight in the chat with a stand-in engine that
// replays scripted answers (see the __E2E_ENGINE__ and __E2E_BOOT__ hooks in
// src/worker/client.ts and src/boot.ts, active on the dev server only).
import type { Page } from '@playwright/test';

export const MODEL = 'Hermes-3-Llama-3.2-3B-q4f16_1-MLC';

interface Options {
  /** The model's answers, in order; then "OK." */
  replies?: string[];
  /** Interface language ("fr"); the default follows the browser (English here). */
  lang?: 'en' | 'fr';
  /** Start in the chat (default) or go through the normal start-up. */
  chat?: boolean;
  /** The model shown as loaded (any id from src/models.ts). */
  model?: string;
}

export async function openApp(page: Page, { replies = [], lang, chat = true, model = MODEL }: Options = {}) {
  await page.addInitScript(({ replies, lang, chat, model }) => {
    if (lang) localStorage.setItem('my-own-ai.language', lang);
    const queue = [...replies];
    const w = window as unknown as Record<string, unknown>;
    w.__E2E_REPLIES__ = queue;
    const known: Record<string, unknown> = {
      async generate(messages: { role: string; content: unknown }[], opts: { responseFormat?: { type?: string } }, onDelta?: (t: string) => void) {
        // Every call is kept, so tests can check what the model was shown.
        ((w.__E2E_CALLS__ ??= []) as unknown[]).push(messages);
        const system = String(messages?.[0]?.content ?? '');
        // Automatic memory asks for JSON (nothing to remember); the summary has its own prompt.
        const text = opts?.responseFormat?.type === 'json_object' ? '{"facts": [], "outdated": []}'
          : system.startsWith('You keep a running summary') ? 'The user talked about their home and plans. Details: (summary)'
            : (queue.shift() ?? 'OK.');
        onDelta?.(text);
        return { text, finishReason: 'stop', promptTokens: 1200, completionTokens: 40, decodeTps: 42 };
      },
      async interrupt() {},
      async load() { return { contextWindow: 4096 }; },
      async cacheStatuses() { return []; },
      async gpuDiagnostics() { return { errors: [], limits: [] }; },
    };
    // Anything else the app asks the engine resolves to nothing.
    w.__E2E_ENGINE__ = new Proxy(known, { get: (t, k) => (k in t ? t[k as string] : async () => undefined) });
    if (chat) w.__E2E_BOOT__ = { modelId: model };
  }, { replies, lang, chat, model });
  await page.goto('/');
  if (chat) await page.locator('textarea').first().waitFor();
}

/** Send a message from the composer. */
export async function send(page: Page, text: string) {
  await page.locator('.composer textarea').fill(text);
  await page.keyboard.press('Enter');
}

/** A tool call in the Qwen/Hermes format the app's grammar expects. */
export const toolCall = (name: string, args: Record<string, string>) =>
  `<tool_call>\n${JSON.stringify({ name, arguments: args })}\n</tool_call>`;

/** What the model was shown in each call so far (system prompt first). */
export async function modelCalls(page: Page): Promise<{ role: string; content: string }[][]> {
  return page.evaluate(() => ((window as unknown as Record<string, unknown>).__E2E_CALLS__ ?? []) as { role: string; content: string }[][]);
}
