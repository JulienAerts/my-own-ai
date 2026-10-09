# Releasing the desktop app

A tag `desktop-vX.Y.Z` runs `.github/workflows/desktop.yml`: it builds the app for
Windows, macOS (Apple Silicon) and Linux and publishes a GitHub release with the
installers and `latest.json`. Installed apps check that file at start and every six
hours, and install a new version only if it is signed with the project's key.

```sh
git tag desktop-v0.17.0 && git push origin desktop-v0.17.0
```

## The update signing key (once)

The key pair was made with `npx tauri signer generate -w ~/.tauri/my-own-ai.key`.
The public half is in `src-tauri/tauri.conf.json` (`plugins.updater.pubkey`); the private
half and its password stay out of the repository:

1. On GitHub: the repository → Settings → Secrets and variables → Actions → New repository secret.
2. `TAURI_SIGNING_PRIVATE_KEY`: the whole content of `~/.tauri/my-own-ai.key`.
3. `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: the content of `~/.tauri/my-own-ai.key.password`.

Keep a copy of both files somewhere safe (a password manager). If the private key is
lost, installed apps can't be updated anymore: a new key means everyone reinstalls once.
Without the secrets the workflow still builds installers, just without update files.

## Where updates come from

`https://github.com/JulienAerts/my-own-ai/releases/latest/download/latest.json`.
"Latest" skips drafts and pre-releases. Versions up to 0.19.0 were built in the earlier,
private repository and look for updates there, where GitHub doesn't serve them: install the
first release from this repository by hand once; updates are automatic after that.

## Platforms

| System | Bundle | llama.cpp engine | Not yet |
|---|---|---|---|
| Windows | NSIS `-setup.exe` | CUDA (NVIDIA), Vulkan (others) | — |
| macOS 13+, Apple Silicon | `.dmg` (ad-hoc signed: right-click → Open the first time) | Metal | Whisper, image generation |
| Linux (x64, glibc of Ubuntu 22.04 or newer) | `.AppImage`, `.deb` | Vulkan (all GPUs) | Whisper, image generation |

Intel Macs get the browser engine (WebLLM). Code signing for Windows and notarization for
macOS need paid certificates; see the discussion in the README's install notes.
