# Changelog

What changed in each version of My Own AI. Versions are those of the desktop app; the
web and Android apps are built from the same code at the same time.

Releasing: add a section for the new version at the top (`## 0.20.0 — YYYY-MM-DD`), then
push the tag (see `docs/RELEASING.md`). The release page and the update the app offers
show that section; a tag without one doesn't build.

## 0.20.0 — 2026-10-09

- The website offers the desktop app to visitors on Windows, Mac and Linux, with what it adds
  (bigger, faster models on the graphics card, folders, connectors…): in Settings → App, in the
  model list, and once on the chat screen. One click downloads the right installer.
- What's new in each update is now shown in the app on Windows too.

## 0.19.2 — 2026-10-09

- What's new: when an update is available, the app shows what changed. Every version's
  changes are in this changelog and on the release page.

## 0.19.1 — 2026-10-09

- The project is now public at github.com/JulienAerts/my-own-ai. Updates come from there:
  apps on 0.19.0 or older need a version from there installed by hand once.

## 0.19.0 — 2026-10-09

- Memory keeps up with changes: "we moved to Paris" replaces "lives in Brussels", and the
  chat line shows what was replaced (Undo restores it).
- Temporary things (a trip, an exam) are forgotten after two weeks.
- Memory works in any language and checks the model's work: facts must be about you and come
  from what you wrote. Models under 2B parameters only save what you ask them to remember.
- Long conversations: details from early on (a code, a name, a number) come back when you ask
  about them, even after the conversation was summarized.
- Desktop: automatic memory and JSON tool calls work with Qwen3.5 models.

## 0.18.1 — 2026-10-09

- Switch back to the default assistant.
- The logo choice applies to every assistant; an assistant's emoji is shown full size.

## 0.18.0 — 2026-10-09

- Your own logo and background (several styles, or your own picture), a start-up animation
  and a livelier chat.

## 0.17.4 — 2026-10-09

- Desktop: a downloaded model starts directly instead of offering to resume its download.
- SECURITY.md: what the app protects against, how, and its limits.

## 0.17.3 — 2026-10-08

- Security: web addresses the model makes up ask before opening, a memory saved right after
  reading a page asks first, and approvals say exactly what will happen.

## 0.17.2 — 2026-10-08

- "Report a problem": a ready-made report with diagnostics, without your conversations.
- Links in the desktop app open in your browser.

## 0.17.1 — 2026-10-08

- Interface fixes: the full name in the phone header, easier settings navigation, tool rows,
  scrolling.

## 0.17.0 — 2026-10-08

- The desktop app for macOS and Linux, and automatic updates.
- The website offers updates again after its sign-in expires.

## 0.16.1 — 2026-10-08

- French voices and French dictation.

## 0.16.0 — 2026-10-08

- The app in French, with a language setting.

## 0.15.1 — 2026-10-08

- Small models' tool calls run instead of showing as text, and answers lose a leading "Name:".

## 0.15.0 — 2026-10-08

- Regenerating or editing keeps the earlier answers: switch between them with ‹ 1 / 2 ›.

## 0.14.0 — 2026-10-08

- A first-run welcome: what the app is, a model to pick, a few choices.

## 0.13.0 — 2026-10-08

- Settings → Network: every request the app makes to the internet.

## 0.12.2 — 2026-10-08

- Thinking models no longer loop on tool calls inside their thoughts.

## 0.12.1 — 2026-10-08

- A local connector that fails to start shows its log, and gets up to 2 minutes to start.

## 0.12.0 — 2026-10-08

- Desktop: long contexts, up to 128k tokens for Qwen3 and 256k for Qwen3.5.

## 0.11.0 — 2026-10-08

- Desktop: AMD and Intel graphics cards (Vulkan).

## 0.10.1 — 2026-10-08

- Some models' thinking no longer leaks into answers.

## 0.10.0 — 2026-10-08

- The app is now called My Own AI, and is open source (GPL-3.0).

## 0.9.0 — 2026-10-08

- Desktop: add any GGUF model from Hugging Face, with an optional access token.

## 0.8.1 — 2026-10-08

- The settings tab bar is no longer cut in half.

## 0.8.0 — 2026-10-08

- Themes and an Appearance tab.

## 0.7.0 — 2026-10-08

- Desktop: run Python on your PC (asks before every run), serve the model to other apps
  (local OpenAI-compatible API), tray icon, Ctrl+Alt+Space and start with Windows.

## 0.6.0 — 2026-10-08

- Desktop: image generation (Z-Image-Turbo), dictation in many languages (Whisper) and
  image understanding (Qwen3.5).

## 0.5.0 — 2026-10-08

- Desktop: workspace folders the assistant can read and write.

## 0.4.0 — 2026-10-08

- Skills: packaged instructions and files the model opens when needed.
- Desktop: MCP connectors.

## 0.3.1 — 2026-10-07

- Desktop: chat with llama.cpp models works, and shows the server's errors.

## 0.3.0 — 2026-10-07

- Assistants: named setups with their own role, tools, documents and memory.
- Automatic memory with Undo, and a Memory tab.

## 0.2.1 — 2026-10-07

- Desktop installers are published as releases.

## 0.2.0 — 2026-10-07

- Desktop: big models on NVIDIA graphics cards (llama.cpp).

## 0.1.0 — 2026-10-07

First release: a private assistant that runs in the browser, on Android and on Windows.

- Chat with models running on the device (WebGPU), reasoning models with a visible thinking
  view, and a rolling summary for long conversations.
- Tools: web search, page reading, news, weather, calculator, code (Python and JavaScript in
  a sandbox).
- Your documents, images (with vision models), voice mode and read-aloud.
- History, backups, custom instructions, message actions (copy, regenerate, edit).
