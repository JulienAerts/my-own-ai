# Releasing the desktop app

A tag `desktop-vX.Y.Z` runs `.github/workflows/desktop.yml`: it builds the app for
Windows, macOS (Apple Silicon) and Linux and publishes a GitHub release with the
installers and `latest.json`. Installed apps check that file at start and every six
hours, and install a new version only if it is signed with the project's key.

First add the version's section at the top of `CHANGELOG.md` (`## 0.20.0 — YYYY-MM-DD`,
then one line per change, written for users) and push it. The build uses that section as
the release text, which is also what the app shows under "What's new" when it offers the
update; a tag without a section fails at the "Release notes" step. Then:

```sh
git tag desktop-v0.20.0 && git push origin desktop-v0.20.0
```

Check a section with `node scripts/release-notes.mjs 0.20.0`.

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

## The Android signing key (once)

Android installs an update only if it's signed with the same key as the installed app, so this
key must never change or be lost. It lives outside the repository, in `~/.android-signing/`:
`my-own-ai-release.jks` (alias `my-own-ai`, valid until 2054, certificate "CN=My Own AI"), its
password in `my-own-ai-release.password`, and the keystore as one line of base64 in
`my-own-ai-release.jks.base64`. Repository secrets (Settings → Secrets and variables → Actions):

- `ANDROID_KEYSTORE_BASE64`: the contents of `my-own-ai-release.jks.base64`;
- `ANDROID_KEYSTORE_PASSWORD`: the contents of `my-own-ai-release.password`.

Keep a copy of the `.jks` and its password somewhere safe (a password manager). With the secrets
set, each release also carries `My.Own.AI_X.Y.Z_android.apk`, versioned from the tag. An app
installed from a debug build (`npm run android`) has another signature: uninstall it once (export
a backup first: uninstalling deletes its conversations), then install the release APK.

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
