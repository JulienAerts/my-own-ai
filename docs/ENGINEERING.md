# Engineering notes

How My Own AI works inside, and why it's built this way: the decisions, the device limits that shaped
them, and what was tested. It grew feature by feature, so sections are in roughly the order things were
built. For using the app, see the [README](../README.md).

## Origins

It started as a browser-only agent runtime prototype ("Local AI Harness"). Inference runs on-device through WebLLM over
WebGPU, and no user data leaves the browser.

## Develop

```sh
export PATH=~/.local/node/bin:$PATH   # Node 22 installed user-locally in WSL
npm install
npm run dev        # http://localhost:5173
npm run build      # typecheck + production build
npm run preview    # serve dist/ on :4173
```

WebGPU needs a secure context: HTTPS, or `localhost`. To test on a phone on your LAN:

```sh
npm run dev:https   # self-signed cert on first run (npm run cert to regenerate), serves https on :5173
```

Open `https://<pc-lan-ip>:5173` on the phone and accept the certificate warning. On
WSL2 the phone reaches Windows, not WSL, so Windows needs a port proxy to the WSL IP
(admin PowerShell):
`netsh interface portproxy add v4tov4 listenport=5173 listenaddress=0.0.0.0 connectport=5173 connectaddress=<wsl-ip>`.
The WSL IP (`hostname -I`) changes after a reboot.

Browsers refuse to register service workers on pages with an untrusted certificate. So
for PWA install testing (Phase 4), use a real-HTTPS tunnel instead:
`npx cloudflared tunnel --url http://localhost:5173`.

## Hosting on Cloudflare (Workers static assets)

The `dist/` folder deploys as is. Three things it relies on:

- **25 MiB per file**: onnxruntime's WebGPU `.wasm` (27 MB) is left out of the build and
  loaded from jsDelivr (see Speech recognition).
- **No referrer**: Hugging Face answers 404, without CORS headers, to downloads whose
  `Referer` is a `*.workers.dev` site (the browser shows a CORS error). `public/_headers`
  sets `Referrer-Policy: no-referrer` (module workers follow this header), and
  `index.html` has the matching `<meta>`.
- **Cloudflare Access** (private testing): the manifest link uses
  `crossorigin="use-credentials"` (`useCredentials` in `vite.config.ts`). Without it the
  manifest request has no Access cookie and is redirected to the login page.

## Android app (Capacitor)

The same build wrapped as an Android app (`capacitor.config.ts`, `android/`), so it can
later make requests a web page can't (native HTTP: real web search, reading articles).
First question to answer: does WebGPU work in the Android WebView?

- **Build**: `npm run android` (web build, `cap sync`, Gradle debug build) →
  `android/app/build/outputs/apk/debug/app-debug.apk`. Needs JDK 21 and the Android SDK
  (platform 36, build-tools); here they live in `~/.local/jdk` and `~/.local/android-sdk`.
- **Install**: open the APK on the phone (allow installs from this source). With the dev
  server on the LAN: `https://<PC IP>:5173/android/app/build/outputs/apk/debug/app-debug.apk`.
- **Differences**: served from `https://localhost` inside the APK (a secure context); no
  service worker (`src/native.ts` → `isNativeApp`), so no update banner: updates come with
  a new APK. The manifest adds `RECORD_AUDIO` for dictation and voice mode.
- **Storage**: the app has its own storage, so models, chats and settings start empty.
- **Debugging**: `webContentsDebuggingEnabled` lets desktop Chrome inspect it at
  `chrome://inspect` over USB.
- **WebGPU works** in the Android WebView (OnePlus 13R): models, dictation and read
  aloud all run as in Chrome.

### Web search in the app (`agent/nativeweb.ts`)

The app sends requests through Android's network stack (`CapacitorHttp`), which isn't
bound by CORS: straight from the phone to the site, no server in between. Only the
model's query, or the page it asked for, leaves the device. In the app:

- **`search`** posts to DuckDuckGo's HTML endpoint (`html.duckduckgo.com/html/`) with the
  phone's Chrome user agent and parses `.result` blocks (ads skipped, redirects
  unwrapped, dates kept); if that fails or is empty, Bing (`li.b_algo`, desktop and mobile
  markup, `u=a1<base64>` links decoded). Results: title, site, date, snippet, link.
- **`news`** puts Google News RSS headlines (`when:7d`, newest first, source names
  shortened) before the Wikipedia Current events summaries. Google's article links are
  encoded redirects, so headlines carry no link: the model searches for one to read it.
- **`read_page(url)`** fetches a page and extracts its main text with Mozilla Readability
  (Firefox's Reader View), with title, site, author and date, cut to the tool budget.
  Only public http(s) addresses: localhost, private IPv4 ranges, IPv6 literals and
  single-label or `.local/.lan/.home` hosts are refused, so a page can't make the app
  read the router. Bot walls ("Just a moment…") and near-empty pages return a clear error.
- `read_article` is dropped in the app (`read_page` reads Wikipedia too).
- Tool budgets grow with the context: 1,300 characters at 2048 tokens, 2,400 at 4096,
  up to 8,000 with larger contexts.
- The website keeps its browser-only tools; `isNativeApp` picks the set at startup.

## Desktop app (Tauri)

The same build in a Windows window (`src-tauri/`). Tauri uses the system's web engine,
WebView2 on Windows (Chromium, like Edge), so WebGPU works as in Chrome and the
installer stays small.

- **Build**: GitHub Actions (`.github/workflows/desktop.yml`) builds the NSIS installer on
  `windows-latest` when a `desktop-v*` tag is pushed, or from Actions → Desktop app →
  Run workflow. Download it from the run's artifacts (`local-ai-windows-installer`).
  Windows minutes count double on private repos, hence no build on every push.
- **Origin**: `https://tauri.localhost` (`useHttpsScheme`), a secure context for WebGPU.
  Separate storage from the browsers: models download again.
- **Web search**: the same tools as the Android app (`isNativeApp`), with requests sent
  by Tauri's HTTP plugin (Rust, outside CORS; `unsafe-headers` to send a browser
  User-Agent). `capabilities/default.json` allows http(s) URLs; `read_page` still
  refuses local addresses before any request.
- `src/native.ts`: `isAndroidApp` (Capacitor), `isDesktopApp` (Tauri), `isNativeApp`
  (either: no service worker, native HTTP tools).

### Other systems and updates

The Tauri app also builds for macOS (Apple Silicon) and Linux (`.github/workflows/desktop.yml`,
one job per system with `tauri-action`, all into the tag's release). `gpu_info` reports for
each GPU the llama.cpp build to install (`engine`): CUDA or Vulkan on Windows; Vulkan on Linux
for every vendor (the Linux CUDA build plus its runtime is 765 MB, Vulkan 31 MB), with AMD
memory read from `/sys/class/drm/card*/device/mem_info_vram_total`; Metal on Apple Silicon,
whose GPU gets about 70% of the unified memory (`hw.memsize`). Linux and macOS releases are
`.tar.gz` (`tar` + `flate2`, executable bits kept); llama-server gets `LD_LIBRARY_PATH` on
Linux for its libraries. Whisper and stable-diffusion.cpp stay Windows-only (`desktopOS` in
`src/native.ts`), since their pinned releases are Windows builds.

Updates: `tauri-plugin-updater` reads `latest.json` from the latest GitHub release and installs
only packages signed with the project's key (public key in `tauri.conf.json`; private key in
the repository's Actions secrets, see `docs/RELEASING.md`). `src/desktop/updates.ts` checks
15 s after start and every six hours; the chat shows "Version X is available · Update and
restart" (never during an answer), Settings → App → Desktop has the version and "Check now".
On Windows the installer runs in passive mode; then `tauri-plugin-process` relaunches the app.
What's new: the release text is the version's `CHANGELOG.md` section (`scripts/release-notes.mjs`,
which fails the build when there is none); the app shows it under "What's new" when it offers an
update (the part before `---`; install help follows), and once after updating (`justUpdated`,
from the bundled changelog).

Getting the app from the website (`src/getapp.ts`, `src/ui/GetApp.tsx`): on Windows, Mac, Linux
and Android browsers (not iPhones, iPads, Chromebooks, or inside the apps), the site offers the
app for that system: always in Settings → App, as a card on the empty chat from the third visit
until dismissed, and on computers as a line in the model list (above all when no model runs in the
browser; the Android app runs the same models, so not there). Installer names carry the version,
so the click asks GitHub's API for the latest release's files (CORS allowed; listed in Settings →
Network) and starts the matching download (`_x64-setup.exe`, `_aarch64.dmg`, `_amd64.AppImage`,
`_android.apk`), or opens the releases page if that fails.
Macs are offered the Apple Silicon build with a note: browsers don't reliably tell the chip.

### Native engine on the desktop (llama.cpp)

With a GPU of 8 GB or more, the desktop app runs GGUF models natively with llama.cpp
instead of WebLLM: bigger models, faster. NVIDIA cards get the CUDA build (~650 MB with
its runtime); AMD Radeon, Intel Arc and others get the Vulkan build (33 MB), picked by
`engineFor` in `src/native/backend.ts`. Other PCs (an old laptop, integrated graphics)
keep WebLLM. Both sets are in Settings → Model;
the recommendation picks the best that fits.

- **Detection**: `gpu_info` reads `nvidia-smi` (name, memory, driver; `cuda: true`) and,
  for every other adapter, the display class in the registry
  (`HardwareInformation.qwMemorySize`, 64-bit: WMI's `AdapterRAM` stops at 4 GB). The
  card with the most dedicated memory wins. Both builds can be installed side by side;
  `start_llama` takes the `variant` to run.
- **Models** (`src/native/backend.ts`): Qwen3 8B, 14B, 30B-A3B (mixture of experts, 3B
  active: fast) and 32B, Q4_K_M from the official Qwen GGUF repos. Each gets the largest
  context (≤ 16k by default, up to the model's maximum in Generation settings: 4k–256k)
  whose KV cache fits next to the weights in GPU memory minus 2 GB. The KV cache is 8-bit
  (`q8_0`, with flash attention): half the memory of 16-bit. Qwen3 is trained for 32k;
  beyond, `start_llama` gets `yarn: 32768` and passes `--rope-scaling yarn --rope-scale
  ctx/32k --yarn-orig-ctx 32768` (Qwen's recipe), up to 128k. Qwen3.5 is trained for 256k
  and its hybrid attention keeps a KV cache in 1 layer of 4 (4 KV heads × 256), about
  17 KB per token for the 9B at 8-bit (measured on llama.cpp: 6.6 KB for the 2B, as
  computed). On a 24 GB RTX 4090: all models; 30B-A3B recommended (16k, up to 64k), 32B
  up to 16k, Qwen3 14B and Qwen3.5 27B up to 128k, Qwen3.5 9B up to 256k.
- **Engine** (`src-tauri/src/llama.rs`): llama.cpp `b11480`, the Windows CUDA 12.4 build
  plus its runtime (about 650 MB), downloaded into the app's data folder on first use.
  Models download there too, resumably (`.part` + HTTP Range), with progress over a
  Tauri channel; Pause cancels and keeps what was received.
- **Server**: `llama-server` on 127.0.0.1, a random port and a random `--api-key`, all
  layers on the GPU, `--jinja` (the model's chat template), `--reasoning-format none` (so
  `<think>` stays in the text for the app), one slot, no web UI, no console window. It's
  stopped when the app exits or another model starts, and its log feeds error messages.
- **Chat** (`src/native/llama.ts`): `engine()` routes generate/interrupt/load to
  llama-server while a native model is active (streamed `/v1/chat/completions` through
  the HTTP plugin). WebLLM's constraints map to llama.cpp's: JSON schema →
  `response_format: json_schema`, EBNF grammar → `grammar` (GBNF, the same dialect: rule
  names without `_`, which llama.cpp rejects); thinking → `chat_template_kwargs.enable_thinking`.
  Usage and `timings.predicted_per_second` feed the memory gauge and tokens/s.
- **HTTP scope**: `capabilities/default.json` must list `http://127.0.0.1:*` and
  `http://localhost:*`: scope patterns don't match an explicit port otherwise, and
  llama-server listens on a random one (0.3.0 had only `http://*`, so every chat request
  was refused).
- **Errors**: llama.cpp errors say "llama-server" and are shown as they are; only
  "llama-server stopped" / "is not running" count as a GPU failure (restart). Before,
  `isGpuFailure` matched "engine" in them and reloaded the model in a loop.
- **Tested** with llama.cpp's Linux build on CPU and Qwen3 0.6B: JSON tool calls, Qwen3
  tool calls after thinking, thinking off, streaming and usage.
- **Images**: Qwen3.5 9B and 27B (Unsloth's GGUF, Q4_K_M) read images through their
  `mmproj-F16` file, downloaded alongside and passed as `--mmproj`. Images go to the model
  in the chat directly (data URLs in `image_url`), as plain-text turns with thinking off.
  Tested on llama.cpp (CPU, Qwen3.5 2B): thinking, thinking off, Qwen3-format tool calls
  after thinking, and a bar chart read correctly. Their KV estimate is a dense model's of
  the same depth (their hybrid attention needs less), so contexts err on the safe side.
  Some templates open `<think>` themselves and the grammar writes another: `splitThinking`
  drops the repeat.
- **Add a GGUF model** (Settings → Model, `src/native/custom.ts`): paste a Hugging Face
  repository or file link (with or without `https://`). The app reads `/api/models/<repo>`
  (GGUF metadata: architecture, parameters, context length, chat template, gated) and the
  file tree, groups split files (`-00001-of-0000N`), picks the image encoder (`mmproj`,
  F16 preferred), and lists quantizations by size with "fits this GPU" (≥ 4k context next
  to the weights) and a recommendation (Q4_K_M, else another 4-bit, else the biggest that
  fits); 1–2-bit ones are marked low quality. Behaviour comes from the template: `<think>`
  → a thinking model with Qwen-style tool calls, otherwise JSON tool calls. The KV cache is
  estimated from the parameter count (on the safe side). Local file names are prefixed with
  the repository (`owner_Repo--file.gguf`), since many repositories share names like
  `mmproj-F16.gguf`; split parts keep a common prefix so llama.cpp finds them.
- **Gated models**: a Hugging Face token (Settings → Model, setting `hfToken`) is sent as
  `Authorization: Bearer` to huggingface.co only (API calls and `/resolve/` downloads;
  reqwest drops it on the redirect to the CDN). A 401/403 explains what to do.
  Tested on real repositories: a gated 27B (Q4_K_M suggested, 16k context on 24 GB), Qwen3.5
  9B (images, thinking), Llama 3.2 3B (JSON tools), a 235B in 2–10 parts (all too big).
- **Not yet**: Vulkan for AMD/Intel GPUs.

## Layout

| Path | Purpose |
|---|---|
| `src/models.ts` | Tier → model catalog. Kept free of web-llm imports so the main bundle stays at about 11 KB gzipped. |
| `src/probe/device.ts` | Probes WebGPU, memory, CPU, storage, connection and platform. Never throws. |
| `src/probe/tiers.ts` | Tier decision and override rules. Benchmark thresholds are constants at the top. |
| `src/worker/engine.worker.ts` | The only place web-llm is imported. Exposed over Comlink. |
| `src/db.ts` | IndexedDB (`idb`): settings, and conversations (`chats` holds the messages, `conversations` the history index). |
| `src/worker/tts.worker.ts`, `src/tts.ts` | Read aloud: Piper voices (onnxruntime-web WASM + espeak-ng phonemizer) or local device voices, played sentence by sentence. |
| `src/ui/VoiceMode.tsx`, `src/voice/listener.ts` | Hands-free voice mode: listen (energy VAD) → transcribe → answer → read aloud → listen. |
| `src/ui/ReadAloudCard.tsx` | Settings → Voice: auto-read, speed, voice download/preview/selection. |
| `src/ui/HistoryPanel.tsx` | Conversation history: drawer on desktop, bottom sheet on phones. Pinned first, then grouped by date; search inside every message (`src/search.ts`); a ⋯ menu per row to rename, pin, save as Markdown or delete. |
| `src/net.ts` | Download-time estimate and metered-connection detection. |
| `src/boot.ts` | Boot store: probe → pick model → download + load (one progress stream from web-llm) → chat. Pause terminates the worker. |
| `src/ui/BootScreen.tsx` | Boot screen: welcome (first run, one tap to download), progress bar with steps, errors, unsupported browsers. |
| `src/ui/ChatPage.tsx` | Chat: streaming, tool-call rows, suggestions, Stop, history saved in IndexedDB. Gear opens settings. |
| `src/ui/SettingsDialog.tsx` | Settings dialog (bottom sheet on phones): Model (switch, delete, Wi-Fi only), Voice, App (install, storage, clear chat, device details). |
| `src/ui/markdown.tsx` | Minimal Markdown for replies (no HTML parsing). |
| `src/ui/icons.tsx` | Inline SVG icons and the app's orb mark. |
| `src/agent/tools.ts` | Tool registry (calculator with its own parser, never `eval`; date/time; memory notes) and `runTool`. |
| `src/agent/webtools.ts` | Web tools over keyless CORS APIs: search, read_article, weather, convert_currency, define_word. |
| `src/agent/units.ts` | Offline unit conversion (length, mass, volume, temperature, speed, area, data, time). |
| `src/agent/dialects.ts` | Constrained output formats. `json` uses a JSON schema; `hermes` uses an EBNF grammar for `<tool_call>…</tool_call>` or plain text. |
| `src/agent/loop.ts` | Agent loop and prompt windowing. |
| `src/worker/stt.worker.ts` | Speech recognition (Phonon-2, onnxruntime-web). Download, cache, greedy TDT decode. |
| `src/stt.ts` | Module-level speech state (download, pause) plus 16 kHz mono audio decoding. |
| `src/ui/SpeechCard.tsx`, `src/ui/Mic.tsx` | Settings card to install the speech model; mic button in the chat composer. |

## Tier → model

| Tier | Model | Download |
|---|---|---|
| Tiny (iOS) | Qwen2.5-0.5B-Instruct | 265 MB |
| Tiny | Qwen2.5-1.5B-Instruct | 828 MB |
| Small | Hermes-3-Llama-3.2-3B | 1.7 GB |
| Alternative (Tiny) | Llama-3.2-1B-Instruct | 663 MB |
| Alternative (Small) | Phi-3.5-mini-instruct (3.8B) | 2.0 GB |
| Medium | Hermes-3-Llama-3.1-8B | 4.2 GB |
| Benchmark | SmolLM2-360M-Instruct | 194 MB |

The `q4f16_1` build is used when the adapter has `shader-f16`. Otherwise the app uses
`q4f32_1`. Sizes are summed from each model's `tensor-cache.json` on Hugging Face.

### Tier rules (`decideTier`)

- **Unsupported**: no `navigator.gpu`, no adapter, or only a software fallback adapter.
- **Ceiling**: iOS is capped at Tiny. Other mobile devices are capped at Small. If
  `maxStorageBufferBindingSize` is below 1 GiB, the ceiling is Small, because web-llm
  needs a 1 GiB binding for 7–8B models.
- **Heuristic**: mobile, or `deviceMemory` < 8, gives Tiny. Otherwise the tier is Small
  until a benchmark runs.
- **Benchmark** (SmolLM2-360M decode speed):
  - Below 25 tok/s gives Tiny.
  - 80 tok/s or more gives Medium on desktop, or Small on a phone with 8 GB or more.
  - These thresholds are guesses and need real-device data.
- **Override**: one tier up or down from the detected tier, within the ceiling.


**Phones (2026-10-07):** Android phones reporting `deviceMemory` ≥ 8 (Chrome's maximum)
now start in the Small tier instead of Tiny. With a 128 MiB binding limit, that
recommends **Phi-3.5 mini**: the OnePlus 13R runs it at about 14 tok/s, and Hermes 3B
doesn't fit. With larger limits, it recommends Hermes 3 3B. Phones under 8 GB, phones
that don't report memory, and iOS keep Tiny.

## Phase 1 test log

Testing was done in headless Chromium (Playwright) on WSL2. This machine has no GPU
passthrough to Chromium.

| Scenario | How | Result |
|---|---|---|
| No adapter (real) | Default headless Chromium | "Can't run local models" card, no crash ✅ |
| Software adapter (real) | `--use-webgpu-adapter=swiftshader` | Detected as fallback → Unsupported ✅ |
| Desktop, 8 GB | Mocked `navigator.gpu` | Small (provisional). Override offers Tiny/Small/Medium ✅ |
| Desktop, 4 GB | Mocked | Tiny. Override offers Tiny/Small ✅ |
| Desktop, 128 MB binding, no f16 | Mocked | Small, Medium blocked, f32 model id ✅ |
| Fallback adapter | Mocked | Unsupported ✅ |
| iPhone UA | Mocked + iOS UA, 390px viewport | Tiny, Qwen 0.5B, no override above Tiny, iOS note shown ✅ |
| Android UA, 8 GB | Mocked | Tiny, can override to Small ✅ |
| End-to-end benchmark | Real SwiftShader adapter. The fallback flag is spoofed on the main thread only, so the worker uses the real software GPU. | Worker downloaded 194 MB (7 shards) with live progress. Generation ran at 0.4 tok/s decode, 1.9 tok/s prefill. Tier recomputed to Tiny (slow benchmark) ✅ |
| Cache resume | Same browser profile, page reloaded, re-run | Load 1.1 s "(from cache)", no re-download ✅ |

**Not yet tested on real hardware**: desktop Chrome/Edge with a GPU, desktop Safari,
Android Chrome, iOS Safari. These need a manual pass. Open the page, run the speed
check, and record the decode tok/s so the benchmark bands can be calibrated.

## Phase 2 test log

Same setup as Phase 1: headless Chromium on WSL2, real SwiftShader WebGPU, fallback flag
spoofed on the main thread. Model: Qwen2.5-0.5B (265 MB, 8 shards), iPhone UA, 390px
viewport.

| Scenario | Result |
|---|---|
| Metered connection (mocked `cellular`, `3g`, `saveData`) | Data-saver warning shown. "Wi-Fi only" checked by default and Download disabled. Unchecking enables it ✅ |
| Consent screen | Shows exact size from `tensor-cache.json`, estimated time, free storage, connection ✅ |
| Live progress | %, MB, "part N of 8" and a measured "about X left" ✅ |
| Reload mid-download (3/8 shards) | Install page shows "Already saved 95 MB (3 of 8 parts)" and "Resume download (170 MB left)". Device page shows the "interrupted" banner ✅ |
| Resume | Finishes and skips the cached shards ✅ |
| Pause | Worker terminated, "Paused" note, resume works ✅ |
| Install completes | Weights downloaded and model initialized on the GPU. "Installed ✓" ✅ |
| Settings | Lists the speed-check model and Qwen 0.5B with sizes. Delete asks for confirmation and removes it ✅ |
| Download running while on another page | Top banner shows progress, no duplicate download ✅ |
| `navigator.storage.persist()` | Called on the click. Headless Chromium denies it, and the UI says the model may be evicted ✅ |

Notes:
- `downlink` from the Network Information API is capped at 10 Mbps and was 1.35 Mbps
  in headless Chromium, which predicted 27 min for a download that took about 25 s.
  The up-front estimate is labelled rough. The live ETA uses measured throughput.
- Wi-Fi-only auto-pause on a switch to cellular is implemented (the `connection`
  `change` event) but not tested. It needs a real Android device.
- Safari and Firefox don't expose `navigator.connection`, so the estimate assumes
  25 Mbps and Wi-Fi-only can't be enforced. The UI says so.

**Not yet tested on real hardware**: same matrix as Phase 1.

## Phase 3: agent loop

Each model call is constrained by WebLLM's xgrammar to be either a reply or a tool call:

- **Non-Hermes models (Qwen)**: `response_format: json_object` with a schema containing
  `anyOf` one object per action, e.g. `{"action":"reply","text":…}` or
  `{"action":"calculator","expression":…}`. Tool results go back as a user turn,
  because Qwen's WebLLM template has no `tool` role.
- **Hermes models**: `response_format: grammar`. The output is either
  `<tool_call>\n{"arguments": {…}, "name": "…"}\n</tool_call>` or plain text whose first
  character isn't `<`. The system prompt uses the Hermes `<tools>` signature block.
  Results go back in the `tool` role as `<tool_response>`.
- **Step cap**: 3 model calls for Tiny, 5 for Small/Medium. The last allowed step is
  constrained to reply-only, so a turn always ends with an answer.
- **Prompt**: system prompt + skill index (one line per tool) + the most recent whole
  turns that fit in `context_window − max_tokens`.
- **Streaming**: reply text streams live. For JSON output, the `text` field is read out
  of the partial JSON as it arrives.
- `?dialect=hermes|json` (before the `#`) forces a dialect, for testing.

## Phase 3 test log

**Unit tests** (Node, bundled with rolldown), 47 checks, all pass:
- Calculator: precedence, right-associative `^`, unary minus, functions, constants, `×`/`÷`/`**`,
  thousands separators, float-noise trimming.
- It rejects malformed input, division by zero and unknown identifiers, so model output
  is never `eval`'d.
- Date/time with local, explicit and invalid time zones.
- Partial-JSON streaming extraction, including escapes and truncation.
- Parsing in both dialects, schema and grammar generation, history encoding for both
  dialects, and context trimming that drops whole old turns.

**Real inference.** Headless Chromium with SwiftShader WebGPU, running Qwen2.5-0.5B at about 0.2 tok/s.

| Scenario | Result |
|---|---|
| JSON dialect: "What is 17% of 2340?" | Step 1: constrained call `calculator("2340 * 0.17")` → 397.8. Step 2: streamed reply "The calculation is complete. The result is: 397.8" ✅ |
| Hermes grammar (`?dialect=hermes`, on Qwen): "What day of the week is it today?" | Step 1: `<tool_call>` → `get_datetime("UTC")`. Step 2: streamed reply with the correct date ✅ |
| UI states | "Thinking…" → "Calling a tool…" → tool row → streaming bubble with cursor → tok/s ✅ |

Bugs found and fixed during these runs:
- Comlink progress callbacks and token deltas arrive on their own message port. A late
  one could overwrite "ready" or "done", leaving the chat stuck at "Loading model 100%".
  They're now ignored once the call has settled, in chat load, download, speed check
  and streaming.
- Before the fix, Qwen 0.5B repeated the identical tool call at step 2, then answered
  with a wrong number. Two changes:
  - The tool result now includes an explicit "now answer" nudge.
  - A repeated identical call within a turn reuses the existing result and forces the
    next step to be reply-only.
- With the Hermes format on a model without a `tool` role, WebLLM threw
  "Role is not supported: tool". Tool responses now use a user turn for such models.

Not tested: Hermes-3 3B/8B with real weights. They're too large for software WebGPU, so
this needs a real GPU. The grammar itself is model-agnostic and was exercised above.

## Phase 4: PWA

- **Manifest**: `vite-plugin-pwa` with standalone display, theme color, 192/512 icons
  and a maskable 512 icon (glyph inside the 80% safe zone). iOS gets an
  `apple-touch-icon` (180, opaque) and `apple-mobile-web-app-*` meta tags.
- **Service worker** (Workbox `generateSW`):
  - Precaches the app shell, about 96 KB.
  - The 6 MB inference worker is cache-first at runtime, so it's stored on first use.
    Visitors who never run a model don't download it.
  - Model weights stay in web-llm's own Cache API storage. The service worker doesn't
    intercept those requests.
- **Updates**: `registerType: 'prompt'`. A new version shows an "Update available ·
  Reload" banner instead of reloading on its own, and it waits while a download runs.
- **Install**: Chromium's `beforeinstallprompt` is captured and offered at two points:
  after a model download (Install page) and in Settings.
- **iOS**: no prompt API exists. After a successful download, iOS users see Add to
  Home Screen steps explaining Safari's 7-day storage eviction. Dismissing it is saved
  in IndexedDB.
- The service worker only runs in `build`/`preview`, not in `npm run dev`.

## More models: WebLLM catalog and custom links

Settings → Model → **More models** (`src/ui/MoreModels.tsx`). Recommendations still
come only from the curated list. Added models are the user's choice; only hard limits
apply (GPU binding size, shader-f16).

- **Browse WebLLM models:** WebLLM's prebuilt chat models (157 text + 2 vision;
  embedding models excluded), shown in the build this GPU can run (f16, else f32) and
  searchable.
  - **Add** reads the repo's `tensor-cache.json` (size, largest tensor) and refuses
    models that can't fit, with the reason, e.g. *"Its largest weight block (281 MB) is
    bigger than this GPU allows (128 MB)"* for Gemma 2 2B on a 128 MiB phone.
- **Add from a link:** any MLC-format Hugging Face repo (`mlc-chat-config.json` +
  `tensor-cache.json`). The app shows architecture, quantization, download size,
  largest weight block and context window.
  - The compiled **library** (`.wasm`) is either a URL, or **the library of a catalog
    model**, which works for fine-tunes. The app suggests the catalog model with the
    longest matching name and the same quantization, then compares architecture
    fingerprints (`model_type`, quantization, numeric `model_config` fields). It
    flags a mismatch, e.g. Llama vs Qwen: *"model_type, hidden_size, … differ"*.
- **Storage:** added models live in settings (`extraModels`, a `ModelInfo` with a
  `fixedId`) and are registered at boot. Custom ones go to the worker
  (`setCustomModels`), which keeps one `AppConfig` (prebuilt + custom) for loading,
  cache checks and deletion. Context is capped at 4,096, and 2,048 on Android.
- **In the list:** an "Added" / "Custom" tag and **Remove**, which also deletes their
  files.
- **Tested:**
  - The catalog with a simulated 128 MiB GPU: Gemma 2 refused, SmolLM2 added.
  - Custom Qwen 0.5B from its link: the library was suggested and confirmed compatible,
    and Llama's was rejected.
  - A real load through the custom path: the model downloaded (265 MB), loaded in 20 s
    and generated text.

## Images (Phi-3.5 vision)

**Phi-3.5 vision** (`Phi-3.5-vision-instruct`, 2.6 GB download, ~4 GB of GPU memory,
47 MB largest tensor) is offered in Settings → Model on **high-end devices**: 8 GB of
memory or more, or desktops that don't report memory. It's never the default model.
Its text chat matches Phi-3.5 mini.

- **One attach button (📎):** documents and images go through the same button (or paste
  a screenshot). Documents are indexed. Images go to the vision model with the next
  message. **With a text-only model**, an image gets an immediate app-written reply ("I
  can't see images…", pointing to Phi-3.5 vision when the device can run it, no
  regenerate button). It's never indexed or sent, and older images are turned into a
  text placeholder before a text-only model sees the prompt. `src/ui/image.ts` applies EXIF orientation, scales
  to at most 1344 px (the model's own maximum, so nothing is lost) and stores a JPEG
  data URL (~100–200 KB) in the conversation. Images show as thumbnails; tap one to
  open it full size.
- **Token cost and the 2048-token prefill chunk** (`src/ui/image.ts`):
  - WebLLM 0.2.85 tiles a Phi-3.5-vision image into 336 px crops. The count, and so the
    token cost, depends **only on the aspect ratio**.
  - The prebuilt library (`…_cs2k-webgpu.wasm`) is compiled with a **2048-token prefill
    chunk**, and one image can't be split across chunks. So a square photo (2,509 tokens)
    or a 16:9 screenshot (2,353) failed with `PrefillChunkSizeSmallerThanImageError`
    (reproduced with the real model). 4:3, 3:4 and 9:16 images (1,921 / 1,933 / 1,657)
    fit.
  - `prepareImage` mirrors WebLLM's resize/crop/embed-size formulas. When an image's own
    shape exceeds 2,000 tokens, it's letterboxed (white margins, no cropping) onto the
    grid that shows it largest, e.g. a square photo → 3×4 crops (1008×1344, 1,933
    tokens).
  - Verified with the real model: the fitted image passes validation and runs. Headless
    SwiftShader then fails on a 1024-thread kernel (its limit is 256); real GPUs,
    including the OnePlus 13R, allow 1024.
  - **Per device** (`imageTokenBudget()` in `boot.ts`): desktops allow 2,000 tokens per
    image. Phones allow 1,400: a square photo is 9 crops (672×672 shown, 1,357 tokens)
    instead of 13 (1,933). That's ~30% less vision-encoder work, prefill and memory.
    Each image stores its token cost (`imageTokens`), and the prompt budget uses it.
  - **Not available on GPUs with a 128 MiB binding limit (e.g. the OnePlus 13R).** The
    phone reported *"Binding size (150994944) … is larger than … (134217728)"*, followed
    by an empty answer. 150,994,944 = 2,048 × 72 KiB: the per-token activation buffer of
    a **full** prefill chunk, reserved whatever the prompt length.
    - The Phi-3.5-vision library exists only with 2048-token chunks
      (`…_cs2k-webgpu.wasm`). Every text model's library uses 1024 (`_cs1k`), so 72 MiB:
      Phi-3.5 mini (same architecture) works on that phone.
    - Lowering the context didn't help, and there's no smaller vision build.
    - So `ModelInfo.workspaceBytes` records that working buffer (measured: 150,994,944),
      and `fitsBinding` checks `max(largest tensor, workspace)`. Phones under 144 MiB
      don't get the vision model; Settings says why.
    - For catalog and custom models, the app estimates it as chunk (from the library
      name) × 24 × `hidden_size`. That's calibrated on Phi-3 and reproduces the measured
      value. In the catalog only the two vision builds are `_cs2k`.
  - Android runs every model with a 2048-token context; desktop keeps 4096.
  - Only a recent image is sent: one on the latest question or the one before it (a
    follow-up). Older ones become "[The user shared an image here.]"
    (`activeImageIndex`). The prompt budget counts 2,000 tokens for the image.
- Image turns use a plain dialect: no tools, no grammar, one step. The tool list
    wouldn't fit next to an image, and it sidesteps grammar + image interactions in
    WebLLM. Tools come back on later turns.
- **WebLLM rules followed:** one text part per message (consecutive user turns are merged
  into one text part plus the image), and `data:image` URLs only.
- **Hand-off from text models:** on a device that can run the vision model, an image
  sent while a text model is in use is answered by Phi-3.5 vision, then the app switches
  back (`visionHelper()` in `boot.ts`, `send()` in `ChatPage.tsx`).
  - If the vision model isn't downloaded yet, the app asks before the 2.6 GB download.
  - The status line shows "Loading Phi-3.5 vision · x%", then "Switching back to …".
  - The answer is labelled "Answered by Phi-3.5 vision".
  - The model switches back even if the vision step fails (a GPU failure reloads the
    conversation's model instead).
  - Later turns give the text model a placeholder for the image, plus the vision answer
    to rely on.
  - Where the vision model can't run (e.g. 128 MiB phones), the app replies right away
    that the device can't analyse images.
  - Verified by the user on desktop (switches and asks to download) and on the OnePlus
    13R (explains it can't run there).
- Edit & resend and regenerate keep the message's image. The Markdown export marks image
  turns.
- **Tested:**
  - Prompt encoding: image turn, follow-up, later turn with placeholder, doc + image +
    tool merge, one text part per message, and a 61-message history trimmed to 11 to fit
    an image.
  - Model offering for six device profiles.
  - UI: a 780×1688 PNG became a 621×1344 JPEG of 140 KB, previewed, sent and saved.
  - **Not tested end to end:** a full answer needs a real GPU.
- **Also fixed:** the context window always started at a user message, so a document
  card just before the first question was dropped from the prompt. Cards right before
  the window's first question are now kept.

## Errors: reload only after a GPU failure

Before, any generation error made the worker drop the engine and the chat reload the
model, so a validation error (like the image one above) looked like "it reloads and
nothing happens". `isGpuFailure()` (`src/worker/errors.ts`) now limits that to
device-lost / mapAsync / buffer / out-of-memory style errors. Other errors keep the
model loaded and are shown as "Couldn't answer: …".

## Chat with your documents

Attach files with 📎 in the message bar: PDF, TXT, Markdown, CSV/TSV, JSON, HTML, XML,
log or YAML, up to 50 MB. They're read, indexed and searched **on the device**.

- **File picker:** `accept` lists MIME types (`application/pdf`, `text/*`, JSON/XML/YAML)
  as well as extensions. Android maps `accept` to MIME types for its picker; with only
  extensions next to `image/*`, it offered photos and the camera but no PDFs or text
  files. Unsupported files (e.g. `.docx`) get a clear message instead of being read as
  text.
- **Extraction** (`src/docs/extract.ts`): pdf.js (Apache-2.0, loaded on first PDF) gets
  text per page. HTML and XML go through `DOMParser`. Scanned PDFs without a text layer
  and password-protected PDFs get a clear error (no OCR).
- **Passages:** text is split into ~450-character passages on paragraph and sentence
  boundaries, with 80 characters of overlap, keeping the page number.
- **Index** (`src/docs/store.ts`, IndexedDB `docs` store, DB v4):
  - **Keyword:** BM25 with English and French stopwords and light suffix stemming. It
    works in any language and needs no model.
  - **Meaning:** all-MiniLM-L6-v2 (8-bit ONNX, 23 MB, downloaded once, Apache-2.0) in
    `embed.worker.ts` on onnxruntime-web WASM (the CPU, so the GPU stays free for the
    chat model), with a built-in BERT WordPiece tokenizer. Vectors are mean-pooled and
    normalized, 384 dimensions.
  - The two rankings are merged with reciprocal rank fusion. If the model can't be
    downloaded (offline the first time), documents are keyword-searchable only.
- **In the conversation:**
  - The file shows as a card (a `doc` entry). In the prompt, a note about it is merged
    into the next user message, since several chat templates reject two user turns in
    a row.
  - Every question in a conversation with documents **searches them first**, shown as
    a `search_documents` row, because small models don't reliably decide to.
  - The model can also call `search_documents` with its own query. That tool exists
    only in conversations with documents, and isn't listed in Settings → Tools.
- **Size:** excerpts are capped at 1300 characters / 3 passages on 2048-token phones,
  and at 2400 / 4 elsewhere.
- **Settings → App → Documents** lists stored files and deletes them. The backup JSON
  keeps attachment cards but **not** document contents.
- **Verified** (headless Chromium, a 3-page lease PDF printed by Chromium):
  - Indexing took 0.8 s (3 s the first time, including the model download).
  - Search took about 6 ms per question.
  - The right passage was in the top 2 for rent, "Can I keep a cat?" (the text says
    "animals"), the notice period, "Who fixes the roof?" (maintenance) and "Can I rent
    it on Airbnb?" (subletting). Stemming and smaller passages fixed the last two.
  - Through the UI: attach → card → question → automatic search with the page 3
    excerpt → saved conversation and prompt encoding checked. The model's answer wasn't
    tested, because there's no LLM in headless SwiftShader.

## Recall in long conversations

Messages folded into the rolling summary stay in the saved conversation; the model just no
longer sees them, and the summary keeps the gist, not every code or time. `src/agent/recall.ts`
brings the related ones back each turn, word for word, into the system prompt ("From earlier in
this conversation…"): the exchanges before the latest summary (a user message with its answer
and short tool results) are ranked against the new message by shared words weighted by rarity
(only words that occur somewhere earlier count, question words and thanks are ignored) and by
meaning when the search model is installed (vectors cached per exchange). An exchange needs a
third of the words' weight or a cosine of 0.5; at most 2 (phones) or 4, within 600 characters
on phones and 8% of the context elsewhere (up to 2,400). The summary's planned size makes room
for it. Automatic, since small models don't reliably call a search tool.

The summary itself: limits grow with the context (600 / 1,200 / 1,800 / 2,400 characters), and
the summarizer merges the old summary with the new messages, keeping every exact detail and
ending with a "Details:" line, so details don't fade at each rewrite.

## Rolling summary (long conversations)

Each message rebuilds the prompt from the newest turns that fit the context window
(2048 tokens on Android, 4096 elsewhere, minus 512 for the answer). Older turns used to
just drop out. Now (`src/agent/summary.ts`), when turns no longer fit, the model folds
them into a **rolling summary**: facts, names, numbers, decisions, goals and open
questions, in the third person.

- **Batched:** it summarizes down to ~60% of the room (`KEEP`), so the next several
  messages fit without a new summary. On a phone, each summary costs one short
  generation (~180 tokens).
- **Stored in the conversation:** a `summary` entry placed where the kept window starts.
  Only the latest one is kept (older ones are replaced, and fed into the new one). It's
  shown as an expandable "Earlier messages summarized" divider and included in backups
  and the Markdown export.
- **In the prompt:** the summary goes into the system prompt, and `windowStart` /
  `buildPrompt` never send messages it already covers. Its size is capped at 500
  characters on 2048-token phones and 1,200 elsewhere. Planning reserves room for a
  full-size summary, so the window doesn't shrink after.
- **The summarizer's own prompt** fits the same limits: the newest lines are kept if the
  batch is too long, and messages are clipped to 500 characters (tool results to 200).
- **Skipped** on image turns (another model and window). A failed summary doesn't block
  the answer, unless the GPU failed.
- **Tested** with a stub engine:
  - A short chat needs no summary.
  - 12 exchanges at 2048 → questions 1–9 summarized. The prompt is 6 recent messages
    plus the summary, ~1,125 tokens (≤ 1,536). The summarizer prompt is ~1,232 tokens
    plus 183 for its answer.
  - The next message needs no new summary.
  - At 20 exchanges, the summary is rebuilt from the previous one; still one summary,
    and older turns are excluded.

## Reasoning models (Qwen3)

Qwen3 0.6B, 1.7B, 4B and 8B ("thinks" in the model list) write their reasoning in
`<think>…</think>` before answering. The app shows it live, then folds it into
"Thought for 12 s" above the answer or tool call. Thoughts are saved with the
conversation but never sent back to the model.

- **Think switch** (bulb button in the composer, reasoning models only, remembered):
  off sends `extra_body.enable_thinking = false`, and WebLLM starts the answer with an
  empty think block. Summaries always run with thinking off.
- **Format**: Qwen3 uses the Hermes `<tool_call>` tags with the name first
  (`{"name": …, "arguments": …}`), and tool results in a user turn (its template has no
  tool role). With thinking on, the grammar is `think (tool_call | reply)`, where
  `think ::= "<think>" … "</think>"`, so tools still work after thinking.
- **Budget**: thoughts count against the answer's tokens, so thinking turns get
  1,024 tokens on 2048-token phones and 2,048 elsewhere, and temperature 0.6 (Qwen
  loops when sampling near-greedily while thinking). Running out while thinking ends
  with a hint to turn thinking off.
- **Sizes**: largest tensors 74 MiB (0.6B), 148 MiB (1.7B), 185 MiB (4B), 297 MiB
  (8B), so only the 0.6B model fits phones with a 128 MiB binding limit. Recommendations
  are unchanged; reasoning models are an opt-in choice.
- Qwen3.5 isn't offered: its WebLLM build uses the `qwen2` template, without thinking.

## Run code (Python and JavaScript)

The `run_code` tool (Settings → Tools → Run code) runs model-written Python or
JavaScript: data analysis on attached files, charts, multi-step maths.

- **Isolation** (`sandbox/sandbox.ts`): a hidden iframe with `sandbox="allow-scripts"` (no
  `allow-same-origin`, so an opaque origin: no access to the app's IndexedDB, caches or
  page), a CSP that only allows `cdn.jsdelivr.net` (Pyodide and its packages; any other
  `fetch`, `pyfetch` or socket fails), and a worker inside it, so a busy loop can't
  freeze the app. Verified: `fetch` blocked, `indexedDB.open` → `SecurityError`,
  `self.origin` is `null`.
- **Time limit**: 30 s once the code starts (the first Python load may take up to 3 min).
  Past it the iframe is removed; the next run starts fresh.
- **Python**: Pyodide 0.29.5 (Python 3.13), about 12 MB the first time, from the browser's
  HTTP cache afterwards. numpy, pandas, matplotlib, scipy… load on import. The last
  expression's value is returned like a notebook; open matplotlib figures come back as PNGs
  (shown under the output, downloadable). Tracebacks keep only the user's frames.
- **JavaScript**: an async function body with `console.*` captured; `return` a value.
- **Files**: documents attached to the conversation (up to 10 MB, `DocRecord.raw`) are in
  Python's working directory (`pd.read_csv("sales.csv")`), and in JavaScript as
  `files[name]` (text) and `fileBytes[name]`. Documents added before this feature have no
  original file kept.
- **State**: variables persist between runs in a conversation (like a notebook), and reset
  when another conversation is opened.
- **For the model**: output, value, error and "(A chart is shown to the user.)", cut to the
  tool budget from the end (where totals and errors are).

## Generation settings

Settings → Model → **Generation** sets, per model (`agent/genPrefs.ts`, stored under
`generation` by model id). Every value starts at Auto, the app's per-turn default:

| Setting | Auto | Range |
|---|---|---|
| Temperature | 0.3 (tool calls need steady output); 0.6 while a reasoning model thinks | 0–1.5 |
| Top-p | the model's own default | 0.1–1 |
| Answer length | 512 tokens; 1k (phones) or 2k while thinking | 256–4k, at most half the context |
| Context size | 4,096 (WebLLM's prebuilt setting) | 2k–32k in WebLLM, 4k–256k with llama.cpp, up to the model's maximum; desktop only |

- **Context size** reloads the model (`load(id, onProgress, contextWindow)`; the worker
  remembers each model's size, so the switch back after a vision answer keeps it).
  Phones stay at 2048: longer prompts need a bigger prefill buffer than the 128 MiB
  binding many phones allow.
- The vision helper always uses the app's defaults: the settings belong to the
  conversation's model.
- **Memory gauge**: under the message box, `used / context` tokens from the last
  answer (WebLLM's `usage.prompt_tokens + completion_tokens`). It turns amber past
  85%; the rolling summary keeps it from overflowing.

## Code and maths in answers

`ui/markdown.tsx` renders model output without ever parsing it as HTML: headings,
lists, quotes, rules, GFM tables (with column alignment), ~~strike~~, links, and:

- **Code blocks**: language label, Copy button, and syntax highlighting (highlight.js
  core plus 25 common languages, guessed when the fence has no language). Not while
  streaming, to keep frames free for the GPU.
- **Maths**: `$…$`, `\(…\)`, `$$…$$` and `\[…\]` with KaTeX (`trust` off). `$5 and $10`
  stays text: no space just inside the dollars, no digit right after the closing one.
- `_italic_` only between non-word characters, so `read_article` keeps its underscore.

Both libraries load the first time an answer needs them (39 kB and 78 kB gzipped),
are precached for offline use, and KaTeX's fonts are cached on first use.

## Memory

What the assistant remembers about the user (`src/memory/`), kept in IndexedDB
(`memories` store, DB v5; the old `notes` setting is migrated on first read).

- **Records**: text, created/updated dates, pinned, saved automatically or on request, the
  conversation it came from, the assistant it belongs to (unset = shared), and a MiniLM
  vector (the search model is fetched once, with the first memory; see Memory v2).
- **In the prompt** (`memoriesFor`): a short list goes in whole; a longer one gives the
  pinned memories plus those related to the latest two user messages (shared words, or
  meaning when vectors exist), up to 6 on 2048-token phones and 12 otherwise. Labelled
  "What you remember about the user (use it when relevant, without mentioning your memory)".
- **Automatic memory** (`extract.ts`, Settings → Memory, on by default): after an answer,
  if the user's message talks about them, the model lists facts in a fixed JSON shape (three
  at most; see Memory v2). Kept only if grounded (sharing a word with the message) and
  not secret-looking (passwords, card/IBAN-like numbers). A "Memory updated" chip
  (`role: 'memory'` entry, never sent to the model) offers Undo and Manage.
- **Duplicates**: a memory saying the same thing (same words both ways, one contained in
  the other, or cosine ≥ 0.85) updates the existing one instead ("lives in Brussels" →
  "lives in Brussels, Belgium").
- **Tools**: `remember`, `forget` (removes the best match, if it matches well) and
  `recall_chats` (keyword search over the 200 most recent other conversations, returning
  question/answer pairs).
- **Settings → Memory**: the automatic switch, search, add, edit, pin, forget, forget all,
  with each memory's origin. Backups export and import memories (and older backups' notes).
- **llama.cpp**: b11480's own schema conversion puts the chat template's opening (with special
  tokens) into the grammar for some models (Qwen3.5: every JSON request failed with "Failed to
  initialize samplers"), so `src/native/llama.ts` converts JSON schemas to GBNF itself
  (`schemaGrammar`) and sends `grammar`, with the thinking switch as for any request.

### Tools per turn on small contexts

With 13 tools, the system prompt was ~1,130 tokens (JSON dialect) or ~1,630 (Qwen3/Hermes),
most of a phone's 2048-token context. `toolsForTurn` offers the core tools (search, news,
weather, calculator, date, remember, document search) plus those the message calls for
(e.g. "forget…", a link, "convert 5 miles", "plot this csv"): ~590 / ~860 tokens. Larger
contexts get every tool.

### Memory v2

- **Changes replace**: the extractor sees the known facts numbered and returns
  `{"facts": [{"text", "lasting"}], "outdated": [numbers]}`. An outdated fact is deleted only if
  a new fact is about the same thing (`sameTopic`: a shared word or stem other than "named"/"called",
  words of one group such as job/work or home/live/moved, or cosine ≥ 0.6; MiniLM puts "has a dog
  named Rex" and "has a cat named Mimi" at 0.52), so a model can't drop unrelated memories; a
  replaced pinned fact stays pinned. The chat chip says
  what was replaced, and Undo restores it.
- **Temporary facts** (`lasting: false`: a trip, an exam) get `until` = two weeks and are deleted
  after; in the prompt they carry the day they were said ("next Tuesday" stays meaningful).
- **Meaning, always**: the first memory saved fetches the search model (MiniLM, 23 MB, once) and
  backfills vectors for older memories; matching then uses words and meaning.
- **Any language**: messages are read when they use first-person words (English, French, Spanish,
  German, Italian, Portuguese, Dutch) or are statements of some length in any language (shorter
  in Chinese, Japanese and Korean). Facts are written in the language of the message.
- **Checks that don't trust the model**: a fact must be about "the user" (in the message's
  language) and not describe the request ("the user is asking for…"); it must share a word, or
  its first five letters, with the message (models often write facts in English: "allergisch" →
  "allergic"). An unclosed `<think>` before the JSON is skipped.
- **Model size**: below 2B parameters, facts aren't saved unasked (`bigEnoughForMemory`);
  Qwen3 0.6B and 1.7B copied back facts the message had just made untrue ("I'm not vegetarian
  anymore" → "The user is vegetarian"). `remember` still works.
- Measured on real models with `extractionMessages`/`parseExtraction` and the app's checks
  (16 scenarios: names, a move, a job change, a changed taste, trips and exams, French, Spanish,
  German, unrelated known facts, plain questions); see the results in the commit message.

## Assistants

Named setups for different jobs (`src/assistants/assistants.ts`, stored in the
`assistants` setting), like ChatGPT/Claude Projects. The built-in **Local AI** is the app as
before and isn't stored.

- **An assistant has**: name and emoji, role and instructions, a preferred model, its own
  tool list (or the user's defaults), knowledge documents from the library, memory
  (`shared`, or `own`: what it learns is saved with its id; it still sees shared
  memories), and conversation starters.
- **Prompt**: `You are "<name>", an assistant that runs entirely on the user's device`,
  then "Your role: …", then the user's own instructions (Settings → App), memories, tools.
- **Accessibility**: `e2e/accessibility.spec.ts` runs axe-core (WCAG 2.2 A/AA) on the chat, the
  history, every settings tab, the first-run welcome and the assistants, in light and dark (after
  the entrance animations, which fade colours in). The message list is not a live region: a hidden
  announcer (`.sr-only`, `aria-live="polite"`) says "Writing an answer…", then the finished answer
  as plain text (Markdown marks removed, code blocks as "(code)"), then memory updates; errors use
  `role="alert"`. Animations stop under "reduce motion" (a global rule, and no smooth scrolling).
  Green text uses `--ok-fg`, darker than `--ok` in light mode.
- **Saving files** (`saveFile` in `src/backup.ts`: a conversation as Markdown, a backup): a download link on
  the website; the apps' web views ignore those, so the desktop app opens the save dialog from Rust
  (`save_as` in `src-tauri/src/files.rs`, which writes where the user chose: the page never names a path)
  and the Android app uses its "create document" picker (`SaveFilePlugin.java`).
- **Managing conversations**: `ConversationMeta` has `pinned` and `renamed` (a title the user set;
  `saveChat` keeps both, backups carry them; an empty name goes back to the automatic title).
  Search (`src/search.ts`) loads every conversation's messages once per opening of the panel and
  matches case- and accent-insensitively, every word somewhere in the conversation; conversations
  with one message holding all the words come first. A result opens its conversation scrolled to
  that message, outlined for a moment (`.entry[data-ts]`). The row menu is placed against the
  window (measured, since the sheet's transform shifts "fixed"), so the list can't clip it; it
  flips upward near the bottom, and Escape closes it, not the panel. After "New conversation"
  the message box gets the focus back once the panel has closed (the browser returns it to the
  history button first).
- **Conversations** record their assistant (`ConversationMeta.assistantId`, set once by
  `saveChat`); the history shows its emoji and name. The header button opens the picker;
  picking starts a new conversation with that assistant ("New conversation" keeps the
  current one).
- **Knowledge**: its documents are searched in every conversation with it (the same
  pre-search and `search_documents` tool as attached files).
- **Preferred model**: never swapped silently (it may be a 20 GB load); an empty chat
  shows "<name> prefers <model>. Switch to it".
- **Templates**: Writing coach, Code helper, Translator, Tutor. Backups export and import
  assistants (added when missing).

## Connectors (MCP)

Desktop app: Settings → Connectors adds MCP servers (Model Context Protocol), the way
Claude Desktop, ChatGPT and LM Studio do (`src/mcp/mcp.ts`, `src-tauri/src/mcp.rs`).

- **Config**: paste Claude Desktop's `{"mcpServers": {...}}` block (or a name→server map,
  or one server). `command` + `args` (+ `env`) is a local stdio server; `url` (+ `headers`)
  a remote Streamable HTTP one. Stored in the `mcpServers` setting; enabled servers start
  with the chat.
- **stdio**: Rust starts the program (through `cmd /C` on Windows, so `npx`/`uvx` work,
  without a console window), writes JSON-RPC lines to stdin and forwards stdout lines over
  a Tauri channel; stderr's last lines explain failures. Servers stop with the app.
- **Protocol** (TS): `initialize` (2025-06-18), `notifications/initialized`, `tools/list`
  (paged), `tools/call`; answers `ping`, declines other server requests, refreshes on
  `tools/list_changed`. HTTP: POST per message, JSON or SSE replies, `Mcp-Session-Id`.
- **Tools**: each MCP tool becomes `<server>__<tool>`. The model writes every argument
  as a string (the app's grammars); they're converted to the declared types (numbers,
  booleans, JSON arrays/objects; empty optional ones dropped). Results: text, images
  (shown in the chat), embedded resources, structured content, cut to the tool budget.
- **Per turn**: up to 12 MCP tools (6 at ≤4k context), the best matches for the message
  (name, description, server name), so a 40-tool server doesn't fill the prompt.
  Assistants with their own tool list get only the MCP tools they list.
- **Approval**: tools not annotated `readOnlyHint` ask first: an "Allow once / Always
  allow / Deny" card in the chat (Stop denies). "Always" is saved per server and can be
  revoked in the tool list. Without a way to ask, the answer is no.
- **Tested** against `@modelcontextprotocol/server-everything` over HTTP: handshake, 13
  tools, typed arguments (`get-sum` 17 + 25 = 42), image results, approval paths, both
  output formats. The stdio transport needs the desktop build.

## Skills

Packaged know-how in the Agent Skills format (`src/skills/skills.ts`, Settings → Tools →
Skills, every platform): a folder with `SKILL.md` (YAML front matter `name` and
`description`, then instructions) and optional files (scripts, references, templates).

- **Import** a `.zip` (SKILL.md at its root or in one top folder; files up to 10 MB, read
  with fflate) or a `SKILL.md`, **write** one in the app, or add the example
  (`meeting-notes`). Stored in IndexedDB (`skills` store, DB v6); same name = update.
- **Prompt**: "Skills (before a task one covers, call use_skill…)" lists name and
  description only; at 2048 tokens, only those sharing words with the message (≤ 3).
- **Tools** (offered when skills are listed): `use_skill(name)` returns the instructions
  and the file list; `read_skill_file(name, path)` returns a text file. `run_code` gets
  every enabled skill's files under `skills/<name>/` (Python's working directory), so a
  skill's scripts can be imported and run.
- Backups include skills (files as base64).

## Workspace folders (desktop)

Settings → Connectors → Folders: folders on the PC the assistant can use
(`src/files/workspace.ts`, `src-tauri/src/files.rs`), picked with the system dialog
(`tauri-plugin-dialog`). Each has a short name the model uses (editable).

- **Safety** (Rust `inside()`): every path is resolved inside its folder; `..`, absolute
  paths, drive prefixes and links leading out are refused, also for paths that don't exist
  yet (writes). Hidden folders and `node_modules`, `target`, `dist`, `venv`… are skipped
  when walking.
- **Tools** (offered when folders exist; the descriptions name them): `list_files`,
  `search_files` (by name, across folders), `read_file` (PDF via the extractor, other text
  as is, ≤ 20 MB, cut to 1.5× the tool budget), `search_folder` (meaning search), and
  `write_file`, which always asks (Create / Replace, with a preview) before saving.
- **Index**: "Index" reads the folder's supported documents (≤ 3,000 files, ≤ 20 MB
  each) through the same pipeline as attached files, tagged `folderId` so they stay out of
  the document library; "Re-index" redoes only new or changed files (by modification
  time) and drops deleted ones. Removing a folder drops its index; the files stay on disk.
- A folder name that doesn't match is an error (an empty name means the only folder).
- **Tested** in the browser with a stand-in for the Rust commands: listing, name search,
  reading, indexing (library unchanged), meaning search, write approval (deny, create,
  replace). The Rust side builds in CI.

## Image generation (desktop)

`generate_image(prompt, size)` (`src/native/images.ts`, `src-tauri/src/sdcpp.rs`), offered
in the desktop app with a GPU of 8 GB or more (any vendor: the engine is the Vulkan build).
Free memory comes from `nvidia-smi`; on AMD and Intel it is estimated as the card's
memory minus ~1 GB for the display and the loaded chat model (`estimatedFreeMB`):

- **Engine**: stable-diffusion.cpp `master-945-a1ded76`, Vulkan build (30 MB; the CUDA
  one is ~900 MB with its runtime). **Model**: Z-Image-Turbo Q4_K (leejet, 3.9 GB) with
  the Qwen3-4B-Instruct Q4_K_M text encoder (2.5 GB) and the FLUX VAE (Comfy-Org's open
  copy, 335 MB): 8 steps, CFG 1.0, flash attention, `--offload-to-cpu`, as in
  stable-diffusion.cpp's Z-Image docs. Square 1024², portrait 832×1216, landscape 1216×832.
- **One process per image** (`sd-cli`, not the server), so its GPU memory is freed as
  soon as the PNG is written.
- **First use** asks (approval card) before the 6.7 GB download. **GPU memory**: if
  `nvidia-smi` reports less than 7.5 GB free next to a llama.cpp chat model, that model
  is unloaded while the image renders and loaded again afterwards.
- Tool images (this one, MCP tools) now show under the tool row, downloadable.
- **Not tested here** (needs the Windows build and a GPU); the request follows the
  documented sd-cli example.

## Always ready (desktop)

`src-tauri/src/desktop.rs`, `src/desktop/desktop.ts`, Settings → App → Desktop:

- **Ctrl+Alt+Space** (global shortcut, `tauri-plugin-global-shortcut`, registered from
  Rust) shows and focuses the window and emits `quick-ask`: the chat starts a new
  conversation with the cursor in the box (unless an answer is running).
- **Tray icon** (Tauri `tray-icon`): left click opens the window; menu: Open, New chat,
  Quit. **Closing the window hides it** while "Keep running in the tray" is on (default),
  so the model stays loaded; Quit exits (and stops llama-server, whisper-server, MCP).
- **Start with Windows** (`tauri-plugin-autostart`, `--minimized`): starts hidden in
  the tray.
- No separate quick window on purpose: it would need its own copy of the model.

## Local API (desktop)

Settings → Connectors → Local API: with "Serve the model to other apps" on, llama-server
starts on a fixed port (8765 by default, editable) with a saved key
(`sk-local-…`, setting `localApi`) instead of a random port and key, so other apps on
the PC can use the loaded GPU · llama.cpp model through its OpenAI-compatible API
(`http://127.0.0.1:8765/v1`, `Authorization: Bearer <key>`). It stays bound to
127.0.0.1. Changing the switch or the port reloads the model; a port already in use
is reported. WebLLM models can't be served this way (they live in the page).

## Python on this PC (desktop, opt-in)

Settings → Connectors → Python on this PC: `run_python_local(code, folder)` runs the PC's
own Python 3 (`py -3`, `python` or `python3`, found by `python_info`) with its packages,
in a workspace folder or the app's scratch folder (`src/native/python.ts`,
`src-tauri/src/python.rs`). Off by default; every run shows the full code in the approval
card and waits for a yes. UTF-8 output, `MPLBACKEND=Agg`, stdout+stderr captured (capped
at 100 kB), killed after 120 s. The sandboxed `run_code` stays the default for
calculations and charts. Approval cards now show code and file contents in full.

## First run

On the first visit that needs a download, `src/ui/FirstRun.tsx` replaces the plain
"Download & start" card with three short steps: what the app is (private, useful, yours
to shape); a model to pick, the recommendation plus one lighter (< 70 % of its size) and
one smarter (> 130 %) model this device can run (`firstRunChoices`, WebLLM vision models
left out); then web tools, memory and light/dark mode, with the download size on the
button. Completing it sets the `onboarded` setting, so later visits (an unfinished
download, a cleared model) get the plain card. While a download runs, the boot screen
rotates tips on things to try (`Tips`).

## End-to-end tests and bug reports

`e2e/` (Playwright, `npm run e2e`, also in CI): the app on Vite's dev server in Chromium.
Two hooks, compiled out of production builds (`import.meta.env.DEV`), make it testable
without a GPU: `window.__E2E_ENGINE__` replaces the inference worker with a stand-in that
replays scripted answers (`src/worker/client.ts`), and `window.__E2E_BOOT__` starts in the
chat with a given model (`src/boot.ts`). Covered: answers with tool calls (and a lead-in
before one), response versions from regenerating and editing, history, the settings layout
and keyboard navigation, French, the network log, bug reports, the phone header and sheet,
the back-to-latest button, and the first-run steps (with a faked WebGPU adapter).

Settings → App → **Report a problem** (`src/report.ts`) prepares a GitHub issue: version
(`__APP_VERSION__`, from the latest `desktop-v*` tag at build time), system, browser, WebGPU
adapter and limits, native GPU, model and context, recent GPU errors and, in the desktop
app, the end of `llama-server.log`. No conversations, memory or documents. The text is
shown and editable; "Open on GitHub" opens the new-issue form with it (cut at 6,000
characters for the address), so nothing is sent until the user submits it there.

Desktop links: the webview opens no new windows by itself, so `src/desktop/links.ts` sends
clicks on `target="_blank"` links to the system browser (`tauri-plugin-opener`).

## Network activity

Settings → Network lists every request the app makes to the internet this session
(`src/net/netlog.ts`, `src/ui/NetworkTab.tsx`): time, service, what asked for it (a tool,
a model download, a worker), status, size, and on a click the full address. Nothing is
saved; the list is cleared when the app closes.

- **Where requests are seen**: `src/net/install.ts` is imported first by the page and by
  every worker (before any library can keep a reference to `fetch`). It patches `fetch`
  and `Cache.prototype.add/addAll` (WebLLM downloads weights with `cache.add`), and a
  `PerformanceObserver` on Resource Timing catches the rest (scripts, images,
  `importScripts`). Requests already seen by the patches only get their size from it
  when the server sent no `Content-Length`; a chunked answer without one is measured from
  a clone of the response.
- **Workers** are named (`new Worker(…, { name: 'Voices' })`); the name is the source of
  their requests, sent to the page over a `BroadcastChannel`. The code sandbox has an
  opaque origin, so its worker reports Resource Timing entries through the iframe relay
  and only `cdn.jsdelivr.net` addresses are accepted.
- **Native HTTP**: the desktop app's HTTP plugin goes through `tauriFetch`
  (`src/net/http.ts`), Capacitor's in `nativeweb.ts` calls `track()`, and the Rust
  downloads (llama.cpp, Whisper, stable-diffusion.cpp, GGUF files) are wrapped in
  `trackDownload()` with the bytes from their progress channel.
- **The source**: tools set it while they run (`setNetSource` in `runTool`), e.g.
  "Tool: Web search" or "Blender · get_objects_summary" for a connector.
- **Not listed**: the app's own origin (its files), `localhost`, `*.localhost` (Tauri's
  IPC) and `127.0.0.1` (llama-server, Whisper): they don't leave the device.

## Languages (English, French)

`src/i18n/i18n.ts`: `t('English text', { vars })` looks the text up in the interface
language's dictionary (`src/i18n/fr.ts`) and falls back to English; `tn(n, one, other)`
picks singular or plural (French uses the singular for 0 and 1); `tj()` takes markup in
its placeholders. The language is "auto" (the browser's languages) or a choice in
Settings → App, kept in `localStorage` because it must be known before the first render;
changing it reloads the page. `locale`, `num()` and `UNIT` format dates, decimals and byte
sizes (1,4 Go in French). Workers import the same module and detect the language
themselves.

- **What is translated**: everything the interface shows, the tool names and summaries,
  the assistant templates and starters, errors and progress. Prompts stay in English
  (small models follow English instructions best); in French the system prompt adds
  "The user's language is French: answer in French unless they write in another language."
  Read aloud also offers the device's French voices; the Piper voices are English.
- **Checks**: `src/i18n/i18n.test.ts` scans the source for literal `t()`, `tn()` and `tj()`
  keys and fails on a missing French entry, a different set of `{placeholders}`, or an
  unused entry. French typography (no-break spaces before `: ; ? !`, « guillemets ») is in
  the dictionary itself.

## Appearance

Settings → Appearance (`src/ui/appearance.ts`, `AppearanceTab.tsx`), with a live preview
made of the real chat components:

- **Themes**: Indigo (the original look), Violet, Ocean, Teal, Forest, Sunset, Rose,
  Graphite (neutral), or any custom colour. A theme is two numbers: an accent colour and a
  tint hue (with a strength). `style.css` derives every colour from them with OKLCH and
  relative colour syntax: tinted backgrounds, surfaces, borders and text (light and dark),
  the accent's second gradient stop (+30° hue), the orb highlight (+75°, neutral for greys),
  `--accent-soft`, the background glow, and `--accent-fg`, a version of the accent always
  readable as text (L ≤ 0.52 on light, ≥ 0.74 on dark). Dark mode lightens the accent to
  L ≥ 0.66. Text on the accent turns dark for light colours and greys (computed in JS from
  the colour's OKLCH lightness and chroma). Browsers without relative colours keep Indigo.
- **Mode**: System, Light or Dark (`data-theme`), plus **Pure black** for OLED (dark only).
- **Touches**: background glow or plain, your messages gradient / solid / soft, corners
  round / soft / sharp, text size S–XL (root font size), message font Inter / System /
  Serif / Rounded (message text only; the interface keeps Inter).
- **Inter** is bundled (`@fontsource-variable/inter`), precached for offline use.
- Applied as attributes and CSS variables on `<html>`, saved in settings and mirrored in
  localStorage so `main.tsx` applies it before the first paint. Forced Light/Dark also
  updates the status bar colour (`theme-color`).

### Logo, background and motion

Settings → Appearance also sets the **logo** (`Orb` in `src/ui/icons.tsx`: the orb, an "aurora"
orb whose conic gradient turns inside it, a "halo" ring, an emoji, or the user's picture cropped
to 256 px) and the **background**, a fixed `.backdrop` layer behind every screen (`App.tsx`): glow,
aurora (three soft colour fields drifting with transforms only), mesh, dots, plain, or the user's
photo (at most 1920 px, JPEG) blended into the page colour by a "tone down" slider (`--bg-dim`).
Pictures are separate settings (`logoImage`, `backgroundImage`), not in the cached appearance.
Motion: the start-up logo has ripples and a ring that fills with the download; screens and new
messages fade in; "Thinking" shimmers. While the model writes, `data-busy` on `<html>` pauses
background and logo animations (phones share their GPU with the model), and reduced-motion
settings turn animations off.

## Custom instructions

Settings → App → **Custom instructions**: free text, up to 600 characters (kept short
for phones' 2048-token context). It's saved as you type (`instructions` setting) and
added to the system prompt of every conversation, before the memory notes, from the
next message on. Both dialects build it through `PromptContext { notes, instructions }`.

## Message actions

- **Answers:** 🔊 read aloud, copy (Markdown source; falls back to `execCommand` when the
  Clipboard API is unavailable), and **regenerate** on the latest answer. Regenerating
  asks the last question again and replaces its answer, tool calls included.
- **Your messages:** copy, and **edit & resend**. Editing replaces that message and
  everything after it (no branching). The actions show on hover, and always, faintly,
  on touch screens.
- Under the hood, `send(text, { base })` answers from a prefix of the conversation.
  Tested in the browser: an edit leaves just the new question, and regenerate drops the
  last answer and its weather tool call.

## Response versions

Regenerate and edit-and-resend keep what they replace (`src/versions.ts`). The question
that starts the turn stores every version of the conversation from there on
(`versions`, each a list of entries beginning with that version's question) and which one
is shown (`version`); the shown one lives in the conversation itself and its stored copy
is refreshed when switching away, so follow-up messages in a version are kept too. A
‹ 2 / 3 › switcher sits on the turn's last answer (on the question when the turn has no
answer). Up to 20 versions per question. Only the shown version is sent to the model,
exported or counted.

## Conversation history

Every conversation is saved in IndexedDB on the device. The history button in the chat
header lists them by last message: Today, Yesterday, Previous 7 / 30 days, Older.

- **Titles:** taken from the first user message, at most 60 characters.
- **New conversation** starts a fresh chat. It isn't saved until the first message, so
  empty chats never appear.
- **Reopening:** the last open conversation reopens on launch (`currentChat` setting).
  Switching is disabled while an answer is being generated.
- **Deleting:** delete conversations one at a time from the history, or all at once in
  Settings → App.
- **Backup** (`src/backup.ts`):
  - Settings → App → **Export all** downloads `local-ai-backup-YYYY-MM-DD.json`: every
    conversation, plus memory notes and custom instructions.
  - **Import…** merges a backup. New conversations are added; existing ones are replaced
    only by a newer copy. Notes are merged; instructions are restored only if none are set.
  - Files that aren't backups are rejected, and invalid entries are dropped.
  - Each history entry can also be saved as readable **Markdown**.
  - Tested in the browser: export, delete all, import (2 added), import again ("already
    here"), a bad file (rejected), and the Markdown export.
- **Migration:** DB v3 adds the `conversations` store. The single v2 chat ("default") is
  indexed on first launch. Tested: a seeded v2 database upgrades and reopens.

## Tools

The model can call these tools. Every call appears as a row in the chat. Web tools show
a globe icon, and long results fold to one line.

| Tool | What it does | Runs where |
|---|---|---|
| `calculator` | Exact arithmetic and functions | Offline |
| `get_datetime` | Date and time in any time zone | Offline |
| `convert_units` | Length, weight, volume, °C/°F/K, speed, area, data size, time | Offline |
| `remember` | Saves a fact; saved notes go into every system prompt | Offline (IndexedDB) |
| `search` | Wikipedia full-text search plus a DuckDuckGo instant answer | api.duckduckgo.com, en.wikipedia.org |
| `news` | World news of the past 7 days (Wikipedia Current events) and tech news (Hacker News), by topic | en.wikipedia.org, hn.algolia.com |
| `read_article` | Intro of a Wikipedia article (after `search`) | en.wikipedia.org |
| `run_code` | Python or JavaScript in a sandbox (see Run code) | Pyodide from cdn.jsdelivr.net |
| `weather` | Current conditions and a 3-day forecast | Open-Meteo (geocoding + forecast) |
| `convert_currency` | ECB reference rates | api.frankfurter.dev |
| `define_word` | English definitions | en.wiktionary.org |

- **Privacy:** only the tool's arguments (the model's query) go to these services,
  never the chat. No API keys, no proxy, no backend. Every service sends CORS headers.
- **Size:** results are capped at about 1000 characters, because phones run with a
  2048-token context. The tool list itself takes about 700 tokens (JSON dialect).
- **Errors:** offline, timeouts (12 s), unknown places, missing articles and unsupported
  currencies return a readable message to the model instead of throwing.
- **Memory:** notes are managed in Settings → App → Memory, and capped at 30.
- **Choosing tools:** Settings → Tools turns each tool on or off (`src/agent/toolPrefs.ts`,
  stored as a deny-list so new tools start on). Disabled tools are removed from the
  system prompt and from the JSON schema or Hermes grammar, so the model can't call them.
  With no tools on, both dialects become reply-only. Fewer tools also shrink the prompt:
  all 9 tools take about 2400 characters; weather alone takes about 620.
- **Date:** the system prompt states today's date, so "latest" and "this week" have a
  meaning without a `get_datetime` call.
- **Not usable:** dictionaryapi.dev timed out, and the restcountries API version used
  was retired. General web search (Brave, SearXNG) needs a key or a proxy.

### News

`news(topic)` reads the last 7 days of
[Portal:Current events](https://en.wikipedia.org/wiki/Portal:Current_events) in one API
query (one page per day, written by editors with cited outlets) and parses the wikitext:
each deepest bullet is an item, its parent bullets the story ("2026 Brazilian general
election"), plus the day's category and the outlets cited. Items must contain at least
half of the topic's words (whole words: "AI" doesn't match "Mali"), best match then
newest first. Hacker News adds tech stories of the week with over 40 points, filtered
the same way. Without a topic it returns the latest headlines. Pages are cached for 10
minutes. Results fill the tool budget (1300 characters on phones, 2400 otherwise), at most
a third for tech.

Staying direct from the browser rules out most news: DuckDuckGo html/lite, Google News
RSS, Bing News RSS, Reddit, Mojeek and Qwant (news and web) send no CORS headers or
block automated requests, and GDELT rate-limits hard (one request per 5 s per IP).

## Voice mode

The waveform button in the message bar opens a full-screen, hands-free conversation:
**listen → transcribe (Phonon-2) → answer (agent and tools as usual) → read aloud → listen.**

- **Turn-taking:** the end of a turn is detected automatically. `listener.ts` keeps the
  mic open (echo cancellation, noise suppression) and runs an energy-based voice
  activity detector on 30 ms windows against an adaptive noise floor.
  - Speech starts after 120 ms above the threshold, with 300 ms of pre-roll kept.
  - The turn ends after 900 ms of silence (30 s maximum).
  - Blips under 250 ms are ignored.
  - Audio is resampled to 16 kHz with an `OfflineAudioContext`.
- **Half duplex:** nothing is recorded while an answer is spoken, so it never hears
  itself. Tap the orb to interrupt the answer; **End** stops everything.
- **Answers are always spoken** in voice mode, even with auto-read off, using the
  selected voice. With no offline voice, answers are only shown, with a link to
  download one.
- **Microphone problems are explained** (`src/voice/micErrors.ts`, used by voice mode and
  dictation). The error name is combined with `navigator.permissions` state:
  - Android, site allowed but `NotAllowedError`: Chrome itself lacks the Android
    microphone permission, or the system "Microphone access" switch is off. The user
    gets the Settings → Apps → Chrome path.
  - Site denied: the address-bar site settings, per platform.
  - `NotReadableError`: the mic is busy or switched off.
  - No device, or not https.

  Voice mode shows the steps with a **Try again** button.
- **Pause / Resume:** pausing cancels the current listen and **releases the microphone**
  (the OS mic indicator turns off). A spoken answer still finishes first. Resume reopens
  the mic. Tested with a fake microphone: track `live` → `ended` on pause, and a new
  `live` stream on resume.
- **Screen wake lock:** voice mode keeps the screen on, because a locked phone screen
  suspends the GPU mid-answer.
- **Saved like typing:** turns go into the current conversation.
- **Verified** (headless Chromium, fake microphone fed a WAV of Piper-spoken questions):
  - States went Getting ready → Listening → hearing → Got it → Speaking → Listening.
  - "Tell me a joke about computers." was transcribed exactly.
  - The loop returned to listening and caught the next question.
  - The model step was stubbed in this test: headless SwiftShader is too slow for the
    LLM.

## Read aloud (text-to-speech)

French voices (Siwis, Tom) need French phonemes, and the `phonemizer` package only has
English. `public/espeak/` is Echogarden's eSpeak-NG Emscripten build cut down to the
shared phoneme tables plus `en_dict`/`fr_dict` (0.95 MB of data instead of 24 MB) by
`npm run espeak` (`scripts/build-espeak.mjs`, which rewrites the file packager's table).
The TTS worker loads it on first use for non-English voices; its IPA uses `_` between
phonemes, removed so it matches what Piper was trained on (for English the two builds
give identical phonemes). The service worker caches it on first use (`espeak` cache).
Checked by synthesizing a French sentence and transcribing it back with Whisper: word
for word.

Every answer has a 🔊 button. Settings → Voice adds **Read answers aloud automatically**:
speech starts with the first complete sentence while the answer is still streaming.

- **Device voices:** `speechSynthesis`, filtered to `localService` English voices. Chrome's
  "Google …" voices are online and would send the text to Google, so they're hidden.
- **Natural voices:** [Piper](https://github.com/rhasspy/piper) VITS models from
  `rhasspy/piper-voices`, pinned to a commit. Lessac and Ryan (US), Alba and Alan (UK),
  63 MB each, cached in the Cache API (`piper-voices-v1`).
  - Run with `onnxruntime-web/wasm` on the CPU, in `tts.worker.ts`, so the GPU stays free
    for the chat model.
  - Text → IPA comes from [`phonemizer`](https://github.com/xenova/phonemizer.js)
    (espeak-ng compiled to WASM, bundled, 1.3 MB). Phonemes → ids come from the voice's
    `phoneme_id_map`, laid out as `^ _ (ph _)* $`. Punctuation is kept for prosody.
  - The next sentence is synthesized while the current one plays (Web Audio, scheduled
    back to back).
- **Speed:** 0.8×, 1×, 1.2× or 1.5× (Piper `length_scale`, device `rate`). Markdown, code
  blocks and URLs are stripped before speaking.
- **Verified** (headless Chromium, 1 WASM thread): Lessac speech for "The weather in
  Brussels is sixteen degrees and partly cloudy. Rain is expected tomorrow afternoon."
  was transcribed back word for word by Phonon-2. Synthesis ran about 3× real time after
  a 3 s first load.
- **Licence note:** espeak-ng is GPL-3.0. The `phonemizer` npm package declares
  Apache-2.0, but it bundles espeak-ng. Take that into account when choosing a licence
  for this repo.

## Speech recognition (Phonon-2)

Dictation in Chat, on-device. Install it from **Settings → Speech recognition**; a mic
button then appears next to the message box. Tap to record, tap again to transcribe into
the box, then edit and send as usual. Audio never leaves the device.

- **Model**: [FermionResearch/Phonon-2](https://huggingface.co/FermionResearch/Phonon-2),
  a 5-level quantization of NVIDIA Parakeet TDT 0.6B v3. **English only.** The official
  release is MLX-only (Apple silicon), so the browser uses the community ONNX export
  [tiyuvta/Phonon-2-ONNX](https://huggingface.co/tiyuvta/Phonon-2-ONNX), pinned to a commit.
- **Files**: preprocessor (1.2 MB), `encoder-model.exact4x2.onnx` (662 MB; the same weights
  as Fermion's fp32 runtime bit for bit), decoder/joint (72.5 MB) and vocab. That's 702 MB
  in total, not the 164 MB of the MLX package. About 1.1 GB of RAM once loaded.
- **Runtime**: `onnxruntime-web/webgpu`. Encoder on WebGPU, falling back to WASM. The
  preprocessor and decoder run on WASM (tiny per-frame tensors). The model loads the first
  time the mic is tapped, while you speak, and stays loaded. Audio over 30 s is cut at pauses.
- **Storage**: weights stream straight into the Cache API (`phonon2-onnx-v1`), file by file.
  Pause keeps finished files, and Wi-Fi only applies. The 27 MB ORT `.wasm` and the worker
  are cached by the service worker on first use, not precached.
- **CDN runtime**: that `.wasm` (`ort-wasm-simd-threaded.asyncify.wasm`) is over Cloudflare's
  25 MiB per-file limit, so production builds leave it out (`dropOrtAsyncify` in
  `vite.config.ts`) and load the identical file from jsDelivr at the installed
  onnxruntime-web version. The dev server still serves it locally.
- **License**: weights CC BY 4.0 (attribution in the Settings card).

### French and 23 other languages (Parakeet v3)

Phonon-2 is tuned for English: on French speech it keeps the vocabulary but mangles
words ("il fait dix-sept degrés" → "Ife di set degré"). Settings → Voice offers the
original multilingual **Parakeet TDT 0.6B v3** instead (istupakov's onnx-asr export,
8-bit encoder 652 MB + decoder 18 MB), the default when the interface isn't English
(`sttModel` setting, `src/stt.ts`). Same inputs, outputs, vocabulary and TDT decoding, so
`stt.worker.ts` only switches files and caches (one model loaded at a time). Its own
preprocessor (`nemo128.onnx`) computes in float64, which onnxruntime-web doesn't ship
("Could not find an implementation for Cast(13)"), so it reuses Phonon-2's float32
preprocessor, which yields the same 128 mel features. Test (Chromium, WASM, a Piper
French sentence): exact transcript in 1.4 s for 4.5 s of audio; English too.

### Whisper on the desktop

With an NVIDIA GPU (≥ 4 GB), the desktop app's dictation and voice mode use Whisper
large-v3-turbo (Q5_0, 574 MB) through whisper.cpp `b5454`'s CUDA build (685 MB with its
runtime), multilingual with the language detected (`src/native/whisper.ts`,
`src-tauri/src/whisper.rs`). `stt.ts` keeps one state machine and switches engines:
Phonon-2 elsewhere. whisper-server starts on first use (127.0.0.1, random port,
`--language auto`) and stays up; recordings go as 16-bit 16 kHz WAV in a multipart POST
to `/inference`; `[BLANK_AUDIO]`-style markers are removed. Tested with whisper.cpp's
Linux build (tiny model): a 20 s English recording, 0.5 s on CPU.

### Testing install on a phone

Service workers need a *trusted* certificate, so the self-signed `dev:https` setup
won't work for this. Use a tunnel:

```sh
npm run build && npm run preview          # http://localhost:4173
npx cloudflared tunnel --url http://localhost:4173   # prints https://<random>.trycloudflare.com
```

Each tunnel URL is a different origin, so models download again per URL.

### Phase 4 test log

Same headless Chromium setup (`vite preview`).

| Check | Result |
|---|---|
| Service worker registers and controls the page | ✅ |
| Chrome `Page.getInstallabilityErrors` (CDP) | `[]`, installable ✅ |
| `beforeinstallprompt` captured | "Install" button shown in Settings ✅ |
| Precache contents | 10 app-shell entries. Worker not precached ✅ |
| Worker runtime-cached on first use | `engine-worker` cache has the hashed worker ✅ |
| **Offline** reload of Settings | Installed models listed (worker and model cache read from Cache API) ✅ |
| **Offline** chat | Qwen 0.5B loaded from cache in about 2 s with no network ✅ |
| New build deployed | "A new version is available · Reload" banner. Reload activates it ✅ |
| iOS (UA) after download | Add to Home Screen card with Share-icon steps. "Not now" persists across reloads ✅ |

Bug found and fixed: closing the tab during the final "preparing on GPU" step left a
stale "download interrupted" banner, even though every shard was saved. The banner now
checks the cache and clears the marker when the model is complete.

Not tested (needs real devices): the actual install flow on desktop Chrome/Edge and
Android, standalone launch, and iOS Add to Home Screen.

## Known device issues

- **OnePlus 13R (and likely other Android phones)**: in battery-protection or "protected"
  mode, Chrome reports WebGPU present but returns no adapter. Turning the mode off fixes it.

## Fix: "mapAsync … Buffer was unmapped before mapping was resolved" (mobile)

Cause: engine operations could overlap on the single WebLLM engine. For example,
re-entering Chat during a slow mobile load started a second `reload()`, and a generation
kept running after leaving Chat while a speed check or download reloaded the model.

Fix (in `engine.worker.ts`):
- All GPU operations (`load`, `generate`, `install`, `benchmark`, `remove`) run
  one at a time through a queue.
- `interrupt()` bypasses the queue and also cancels generations still waiting in it.
- `load()` returns at once if the model is already resident.
- Any GPU error discards the engine, so the next call starts clean.
- Chat auto-reloads the model after an error and explains it. Leaving Chat stops the
  running generation.

Tested (headless, SwiftShader):
- Chat → Settings → Chat bounce during load gives a single load and no error.
- Leaving mid-generation keeps Settings usable, and Chat comes back ready.
- Send + Stop while the previous request was winding down gives a clean "(stopped)",
  with no console errors.

Not reproduced: a GPU reset by Android itself (backgrounding or screen lock). That path
is handled by the reset-and-reload logic but hasn't been tested on a device.

## Fix: Android "mapAsync … Buffer was unmapped" on every message (watchdog)

The queue fix above wasn't the whole story: on the OnePlus 13R (Adreno 750), every
answer still failed. Since 0.2.83, web-llm batches every compute dispatch of a step
into one command buffer. On Android a long prefill batch trips the GPU driver's
watchdog, the device is lost, and the logits readback fails
([web-llm#497](https://github.com/mlc-ai/web-llm/issues/497)).

Fix (in `engine.worker.ts`, Android only):
- Submit after every dispatch. The runtime reads `debugLogFinish` after each compute
  pass, and an `Object.prototype` getter there calls `flushCommands()` and returns
  `false`, which skips the debug logging. The WebGPU context class isn't exported, so
  this is the only hook.
- `context_window_size: 2048` to shrink the KV cache.

Verified on the OnePlus 13R with Qwen2.5 1.5B.

## Fix: "Grammar matcher rejected the newly sampled token"

This is a known upstream bug ([web-llm#766](https://github.com/mlc-ai/web-llm/issues/766),
[xgrammar#611](https://github.com/mlc-ai/xgrammar/issues/611)). The sampler occasionally
emits an out-of-range token id, at random. It showed up with Hermes 3 (Llama 3.2 3B).

- The worker no longer discards the engine on this error (`src/worker/errors.ts`).
- The agent loop retries the step up to 3 times with the same prompt.
- If every retry fails, the chat asks you to resend without reloading the model.
  Before, any error reloaded the model, which looked like a restart loop.

### Hermes on Android: gibberish, then the grammar error

On the OnePlus 13R, Hermes 3 (Llama 3.2 3B) in **f16** produced nonsense text and then
"Grammar matcher rejected…". Qwen2.5 f16 was fine on the same phone, and the desktop
was fine with both. The likely cause is f16 overflow in Llama activations on Adreno. So
`buildId()` in `boot.ts` picks the **q4f32** build of Hermes models on Android
(about 3.0 GB of GPU memory instead of 2.3 GB). An older f16 download appears under
Settings → Model → "Other downloads" so it can be deleted.

A headless check with an Android user agent (submit-per-dispatch hook active, SmolLM2
f32) gave coherent output, so the hook isn't what corrupts the numbers. The f32
switch still needs confirming on the phone.

### Correction: the real cause was the GPU's 128 MiB binding limit

The f16 theory above was wrong. With GPU diagnostics captured in the worker
(`uncapturederror` on every device, shown under chat errors and in Settings → App), the
phone reported:

> Binding size (197001216) … is larger than the maximum storage buffer binding size (134217728)

The OnePlus 13R allows 128 MiB per storage binding. Hermes 3 3B's `embed_tokens` is
197 MB. The bind group is invalid, WebGPU silently drops that work, and the logits are
garbage: random tokens, then the grammar error. Fix:

- Each catalog model records `maxTensorBytes`, the largest tensor in its
  `tensor-cache.json`.
- `boot.ts` only offers models whose largest tensor fits the adapter's
  `maxStorageBufferBindingSize`, and falls back from a saved choice that doesn't fit.
  Settings lists the hidden models and the reason.
- The Android f32 switch is reverted, since f16 is fine.
- Added Llama 3.2 1B (125 MB max tensor, just fits) and Phi-3.5 mini (47 MB max
  tensor, 3.8B params), so phones with this limit have a choice. Both use the JSON
  tool-call dialect. Phi-3.5 mini was verified on the OnePlus 13R at 14.3 tok/s;
  Llama 3.2 1B hasn't been tested on a device yet.

**Safety margin (75%)**: Qwen2.5 1.5B (111 MiB) and Llama 3.2 1B (125 MiB) are under the
128 MiB limit but still emit random tokens on the OnePlus 13R, while Qwen2.5 0.5B
(65 MiB) and Phi-3.5 mini (47 MiB) work. So `fitsBinding` only allows tensors up to
75% of the reported limit (`SAFE_BINDING_SHARE`, 96 MiB here), and Qwen2.5 0.5B is
offered on Android too, as the fallback for tiny-tier phones with this limit.

Largest tensors measured: Qwen2.5 0.5B 65 MB, Qwen2.5 1.5B 111 MB, Llama 3.2 1B 125 MB,
Phi-3.5 mini 47 MB, Hermes 3 3B 188 MB, Qwen2.5 3B 148 MB, Hermes 3 8B 251 MB,
Gemma 2 2B 281 MB.
