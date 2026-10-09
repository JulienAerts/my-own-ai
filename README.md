# My Own AI

**A private AI assistant that runs on your own device — in the browser, on Android, and on Windows, Mac and Linux.**
No account, no subscription, no cloud: your conversations, documents, voice and memories stay with you.

<p>
  <img src="docs/images/chat-light.png" alt="A conversation in the browser, light theme" width="62%">
  <img src="docs/images/phone-dark.png" alt="The Android app, dark theme" width="24%">
</p>

My Own AI is an assistant, not just a model runner: it searches the web, reads pages and your
documents, runs code, remembers what matters to you and talks with you — and it picks the model
that fits your hardware, from a phone to a gaming PC.

## Ways to use it

| | Runs on | Best for |
|---|---|---|
| **Browser** | Any recent Chrome, Edge or Brave with WebGPU (also Safari 26+, Chrome on Android) | Trying it with zero install; works offline once installed as an app |
| **Android app** | Phones with WebGPU (Android 12+, recent Qualcomm or ARM GPUs) | Your assistant in your pocket, with real web search |
| **Desktop app** | Windows, macOS (Apple Silicon) and Linux; with a GPU of 8 GB+ (NVIDIA, AMD Radeon, Intel Arc, Apple M-series) it runs large models natively | The full experience: big models, your folders, connectors (image generation and Whisper: Windows) |

Downloads are on the [Releases page](https://github.com/JulienAerts/my-own-ai/releases); the desktop app
then updates itself (it checks GitHub for signed new versions). The installers aren't code-signed by a
certificate yet: Windows SmartScreen asks for confirmation (*More info → Run anyway*), and on a Mac
right-click the app → *Open* the first time. The Android APK installs from a file (allow installs from your browser or file manager).

## What it can do

**Chat with models on your device**
- Picks a model for your hardware and context size for your GPU memory; you can choose others, add any model from the
  [WebLLM catalog](https://github.com/mlc-ai/web-llm) or — on Windows — any GGUF model from Hugging Face (gated models with your token).
- Reasoning models (Qwen3, Qwen3.5) with a live, foldable "Thought for 12 s" view and a Think switch.
- Images: Phi-3.5 vision in the browser, Qwen3.5 on Windows.
- Markdown with highlighted code (copy button), maths (KaTeX) and tables.
- Edit and resend, regenerate (earlier answers kept: ‹ 1/2 ›), read aloud, copy; long conversations keep their thread with a rolling summary.

**Tools**
- Web search and news, reading web pages (full search and page reading in the apps), weather, currency, units, dictionary, calculator, date.
- A code sandbox (Python with numpy, pandas, matplotlib — or JavaScript), isolated from your data and the network, with charts in the chat.
- Chat with your documents (PDF, text, Markdown, CSV…), searched by meaning on your device.

**Memory, assistants and skills**
- Memory: it notes lasting facts you share (with an *Undo*), uses the ones relevant to each question, and you manage them in Settings.
- Assistants: named setups (*Code helper*, *Tutor*…) with their own instructions, tools, documents, memory and preferred model.
- Skills: packaged instructions and scripts (the `SKILL.md` format) the model opens when a task needs them.

**Voice**
- Dictation and hands-free voice mode, in English, French and 23 other languages; answers read aloud with on-device voices (English and French).
- Windows with an NVIDIA GPU: Whisper large-v3-turbo, in about 100 languages.

**Desktop app extras**
- llama.cpp on your GPU (CUDA or Vulkan on Windows, Vulkan on Linux, Metal on Apple Silicon): Qwen3 up to 32B, Qwen3.5 with images, or your own GGUF models.
- **Connectors (MCP)**: plug in any Model Context Protocol server (files, GitHub, databases, Home Assistant…) with Claude Desktop's config format; actions that change something ask you first.
- **Your folders**: the assistant can list, read and search folders you choose, and save files there after asking.
- **Image generation** with Z-Image-Turbo, a few seconds per image.
- Ctrl+Alt+Space from any app, a tray icon, start with Windows; optional local OpenAI-compatible API for your other apps; optional access to your own Python (asks before every run).

**Make it yours**: eight themes or any colour, light/dark/pure black; your own logo (orb, aurora, halo, an emoji or your picture) and background (glow, a slowly moving aurora, mesh, dots or your photo); bubble style, corners, text size and font.
In English or French (it follows your device, or choose in Settings → App).

<p>
  <img src="docs/images/chat-dark.png" alt="Ocean theme, dark mode" width="62%">
  <img src="docs/images/appearance.png" alt="Settings → Appearance" width="24%">
</p>

## Privacy

Everything runs on your device: the models, speech recognition, voices, document search, memory and the code sandbox.
There is no account, no analytics and no server of ours. What does go out, and only when used:

- **Model and voice downloads**, once, from Hugging Face (and the runtimes from jsDelivr and GitHub releases).
- **Web tools** send only their query (a search, a city name, a page address) to the service named in Settings → Tools — never your conversation. Each call shows in the chat, and each tool can be turned off.
- **Connectors** you add yourself talk to whatever server you configured.

**Settings → Network** lists every request the app made since it opened (what, where, why and how big), so you can check this yourself.

Your data lives in your browser's or the app's storage. Settings → App exports a backup of conversations, memories, assistants and skills.

## Models

The app recommends models for your device; all are downloaded on demand from their publishers' Hugging Face pages.

| Where | Models |
|---|---|
| Browser and Android (WebLLM) | Qwen2.5 0.5B / 1.5B, Llama 3.2 1B, Hermes 3 (Llama 3.2 3B and 3.1 8B), Phi-3.5 mini, Phi-3.5 vision, Qwen3 0.6B–8B, + the WebLLM catalog |
| Windows with a GPU of 8 GB+ (llama.cpp) | Qwen3 8B, 14B, 30B-A3B, 32B, Qwen3.5 9B and 27B (images), + any GGUF from Hugging Face |
| Speech | Phonon-2 (English) or Parakeet v3 (French and 24 other languages) on-device, Whisper large-v3-turbo (Windows) |
| Voices | Piper in English (Lessac, Ryan, Alba, Alan) and French (Siwis, Tom), or your device's own voices |

Each model keeps its own license; see [THIRD_PARTY.md](THIRD_PARTY.md).

## Build from source

You need [Node.js](https://nodejs.org) 22.

```sh
npm install
npm run dev        # http://localhost:5173 — the browser version
npm run build      # production build in dist/
npm test           # unit tests
```

- **Android**: JDK 21 and the Android SDK (platform 36), then `npm run android` builds a debug APK
  (`android/app/build/outputs/apk/debug/`).
- **Windows**: the [Desktop app workflow](.github/workflows/desktop.yml) builds the installer on GitHub Actions for each `desktop-v*` tag;
  locally, install Rust and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) and run `npm run tauri build`.

How it works inside — WebGPU limits on phones, the tool-calling grammars, the sandbox, the native engines — is written up in
[docs/ENGINEERING.md](docs/ENGINEERING.md).

## Contributing

Bug reports, ideas and pull requests are welcome: see [CONTRIBUTING.md](CONTRIBUTING.md).
Security issues: please report them privately, as described in [SECURITY.md](SECURITY.md).

## License

My Own AI is free software under the [GNU General Public License v3.0 or later](LICENSE).
It builds on many open-source projects and openly licensed models, listed with their licenses in [THIRD_PARTY.md](THIRD_PARTY.md).
