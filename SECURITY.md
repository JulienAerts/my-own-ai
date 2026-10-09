# Security

My Own AI runs code written by AI models, reads web pages and documents, and, in the desktop
app, can read folders, run MCP servers and (if enabled) the user's own Python. This page says
what it protects against, how, and what it leaves to the user.

## What stays on the device

Models, conversations, memory, documents, voice and the code sandbox all run locally. What goes
out is listed request by request in **Settings → Network**: model and voice downloads, the query
of a web tool (never the conversation), and connectors the user added. No account, analytics or
server of ours.

## Protections

**Prompt injection** (a page, file or tool result with instructions aimed at the model):
- The model is told that tool results are information, not instructions.
- A web address the model makes up (not in the conversation, not on a site the user named, not a
  reference site like Wikipedia) opens only after the user agrees: a page can't make the assistant
  send personal details to its own server. Links from search results and addresses the user typed
  open as usual. (`src/agent/guard.ts`)
- A memory saved right after reading outside content asks first, so a page can't plant a lasting
  "memory". Memories the user asks for are saved directly.

**Actions that change something ask first**, showing exactly what will happen: connector tools not
marked read-only (the user may "always allow" one tool), saving a file in a folder, running Python
on the PC and the image model download (these ask every time).

**Model output is never HTML.** Answers are built as text nodes: no script, image or iframe from a
model can run or load; links must be http(s) and open outside the app. Maths (KaTeX, untrusted
commands off) and code highlighting escape their input.

**Code sandbox** (`run_code`): an opaque-origin iframe with a Content Security Policy that blocks
the network (except the Python package CDN), and a worker with a time limit. It can't read the
app's conversations, memory or documents.

**Folders** (desktop): paths are resolved inside the chosen folders; `..`, absolute paths and links
leading out are refused by the Rust side, whatever the model asks.

**Local servers** (llama.cpp, whisper.cpp) listen on 127.0.0.1 only, with a random port; llama.cpp
also needs a random key unless the user enables the local API (then a key they control).

**Secrets**: the Hugging Face token is sent only to huggingface.co; backups contain no tokens or
keys. Desktop updates install only if signed with the project's key.

**The website** is served with headers that forbid framing by other sites, MIME sniffing and
plugins, and allow only the microphone.

## Limits

- The approvals and the folder list are enforced by the app's interface. Its pages render no
  model-written HTML, but if one were ever compromised, the desktop app's native functions (files,
  Python, connectors) would trust it.
- MCP connectors run with the user's permissions; add only servers you trust. A connector's
  "read-only" label comes from the server itself.
- Skills are instructions the model follows; import only skills you trust.
- Small models follow instructions less reliably than large ones, including the instruction to
  ignore pages' instructions; the guards above don't depend on the model obeying.

## Reporting a vulnerability

Please **don't open a public issue**. Report it privately through
[GitHub's private vulnerability reporting](https://github.com/JulienAerts/my-own-ai/security/advisories/new),
with the steps to reproduce and what an attacker could do. You'll get an answer within a week.

Reports of prompt-injection paths that escape the protections above are especially welcome.
