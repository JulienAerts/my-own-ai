# Contributing to My Own AI

Thanks for helping! Bug reports, ideas, translations and code are all welcome.

## Reporting a bug

Open an issue with the **bug report** template and include:
- where it happened (browser and version, Android app, Windows app) and your device (phone model, GPU);
- the model you were using;
- what you did, what you expected and what happened;
- for GPU problems, the **GPU diagnostics** (Settings → App) or the llama.cpp log (Windows: `%APPDATA%\ai.local.assistant\llama-server.log`).

Please don't paste private conversations; describe them instead.

## Development

```sh
npm install
npm run dev     # browser version on http://localhost:5173
npm test        # unit tests (Vitest)
npm run build   # type check + production build
```

- The browser version is the base; the Android (Capacitor) and Windows (Tauri) apps wrap the same build
  and add native features detected at runtime (`src/native.ts`).
- [docs/ENGINEERING.md](docs/ENGINEERING.md) explains how the pieces work and why — read the section about the area you touch.
- Phones are the tightest target: 2048-token contexts and GPUs that allow only 128 MiB per buffer. Changes to prompts,
  tools or models should still fit there.

## Tests

- `npm test`: unit tests (Vitest), including the check that every interface text has a French version.
- `npm run e2e`: end-to-end tests (Playwright, `e2e/`), the app in Chromium on the dev server with a
  stand-in chat engine, so no GPU or download is needed. The first time: `npx playwright install chromium`.
  Script the model's answers with `openApp(page, { replies: [...] })` (`e2e/fixtures.ts`).

Both run in CI on every push and pull request; a pull request that adds a feature should add a test for it.

## Translations

The interface is in English and French. Every text the app shows goes through `t()`
(`src/i18n/i18n.ts`): the English text is the key, and `src/i18n/fr.ts` maps it to French.
`npm test` fails when a text has no French entry or loses a `{placeholder}`, so add the
French line in the same pull request as a new text. Prompts for the model stay in English.

To add a language: copy `fr.ts`, translate the values, and add it to `LANGUAGES` and
`DICTS` in `i18n.ts` (and to the language names in `src/agent/dialects.ts`).

## Pull requests

- Keep each pull request to one change, with a short description of why.
- Match the surrounding code's style; comment the *why*, not the *what*.
- Run `npm test` and `npm run build`; add a test for logic you change when you can.
- Describe how you tested it (which browser or app, which model).
- Don't add services that receive user data, analytics or a backend: everything runs on the user's device.

By contributing, you agree that your contribution is licensed under the GNU GPL v3.0 or later.
