import { defineConfig, type Plugin } from 'vite';
import preact from '@preact/preset-vite';
import { VitePWA } from 'vite-plugin-pwa';
import { existsSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

/**
 * The app's version, for bug reports: the latest desktop tag ("0.17.1", or "0.17.1+3.1fff25b"
 * a few commits later), else the commit, else package.json's.
 */
function appVersion(): string {
  const git = (cmd: string) => {
    try {
      return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    } catch {
      return '';
    }
  };
  const tag = git('git describe --tags --match "desktop-v*"');
  const m = /^desktop-v([\d.]+)(?:-(\d+)-g(\w+))?$/.exec(tag);
  if (m) return m[2] ? `${m[1]}+${m[2]}.${m[3]}` : m[1];
  return git('git rev-parse --short HEAD') || JSON.parse(readFileSync('package.json', 'utf8')).version;
}

// `npm run dev:https` serves over HTTPS with the self-signed cert from
// `npm run cert`, so phones on the LAN get a secure context for WebGPU.
const https =
  process.env.HTTPS && existsSync('.certs/dev.key')
    ? { key: readFileSync('.certs/dev.key'), cert: readFileSync('.certs/dev.crt') }
    : undefined;

// onnxruntime's WebGPU runtime (27 MB) is over Cloudflare's 25 MiB per-file
// limit; stt.worker.ts loads it from jsDelivr instead, so leave it out.
const dropOrtAsyncify: Plugin = {
  name: 'drop-ort-asyncify-wasm',
  apply: 'build',
  generateBundle(_, bundle) {
    for (const f of Object.keys(bundle)) if (/ort-wasm-simd-threaded\.asyncify-[\w-]+\.wasm$/.test(f)) delete bundle[f];
  },
};

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(appVersion()) },
  plugins: [
    preact(),
    dropOrtAsyncify,
    VitePWA({
      // 'prompt': never reload under a running download or generation; the app
      // shows an "Update available" banner instead.
      registerType: 'prompt',
      // Send cookies with the manifest request, so it passes Cloudflare Access
      // (otherwise it's redirected to the login page and blocked by CORS).
      useCredentials: true,
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'My Own AI',
        short_name: 'My Own AI',
        description: 'A small AI agent that runs entirely in your browser. Nothing you type leaves the device.',
        start_url: './',
        scope: './',
        display: 'standalone',
        background_color: '#f7f7f5',
        theme_color: '#3b5bdb',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // App shell only. The inference workers (~6 MB LLM, ~27 MB speech
        // runtime) are cached on first use (below), so visitors who never run a
        // model don't download them.
        globPatterns: ['**/*.{js,css,html,svg,png}', '**/inter-*.woff2'],
        globIgnores: ['espeak/**', '**/engine.worker-*.js', '**/stt.worker-*.js', '**/tts.worker-*.js', '**/embed.worker-*.js', '**/pdf-*.js', '**/pdf.worker*', '**/ort-*'],
        navigateFallback: 'index.html',
        // "Sign in again" (src/pwa.ts) must reach the network, where the sign-in page is,
        // and so must Cloudflare Access's callback (/cdn-cgi/access/authorized), which
        // sets the sign-in cookie: answered from the cache, the sign-in would loop.
        navigateFallbackDenylist: [/[?&]signin=/, /^\/cdn-cgi\//],
        runtimeCaching: [
          {
            urlPattern: ({ url }) => /\/assets\/engine\.worker-[\w-]+\.js$/.test(url.pathname),
            // Hashed filename, so cache-first is safe.
            handler: 'CacheFirst',
            options: { cacheName: 'engine-worker', expiration: { maxEntries: 2 } },
          },
          {
            urlPattern: ({ url }) => /\/assets\/(stt\.worker|tts\.worker|embed\.worker|pdf|ort-wasm)[\w.-]*\.(js|mjs|wasm)$/.test(url.pathname),
            handler: 'CacheFirst',
            options: { cacheName: 'stt-runtime', expiration: { maxEntries: 12 } },
          },
          {
            // eSpeak-NG for the French voices (public/espeak, not hashed): kept for offline
            // use after the first French reading, refreshed in the background.
            urlPattern: ({ url }) => url.pathname.startsWith('/espeak/'),
            handler: 'StaleWhileRevalidate',
            options: { cacheName: 'espeak', expiration: { maxEntries: 4 } },
          },
          {
            // Maths fonts, fetched the first time a formula is shown.
            urlPattern: ({ url }) => /\/assets\/KaTeX_[\w-]+\.(woff2|woff|ttf)$/.test(url.pathname),
            handler: 'CacheFirst',
            options: { cacheName: 'katex-fonts', expiration: { maxEntries: 40 } },
          },
          {
            // The speech runtime's WebGPU .wasm, served from jsDelivr (versioned URL).
            urlPattern: ({ url }) => url.origin === 'https://cdn.jsdelivr.net' && /\/onnxruntime-web@[\d.]+\/dist\/[\w.-]+\.wasm$/.test(url.pathname),
            handler: 'CacheFirst',
            options: { cacheName: 'stt-runtime-cdn', expiration: { maxEntries: 2 } },
          },
        ],
        // Model weights, WASM and configs are cached by web-llm itself (Cache API),
        // and the speech weights by stt.worker.ts;
        // the service worker must not intercept those cross-origin requests
        // (jsDelivr's onnxruntime .wasm above is the one exception).
      },
    }),
  ],
  worker: { format: 'es' },
  // onnxruntime-web locates its .wasm via import.meta.url; pre-bundling breaks that.
  optimizeDeps: { exclude: ['onnxruntime-web'] },
  // Phones need HTTPS for WebGPU; allow Cloudflare quick tunnels to the dev server.
  server: { allowedHosts: ['.trycloudflare.com'], https },
  preview: { allowedHosts: ['.trycloudflare.com'], https },
  build: { target: 'es2022' },
});
