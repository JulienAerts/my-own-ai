// Service worker registration + install prompts, as a tiny store.
import { useEffect, useState } from 'preact/hooks';
import { registerSW } from 'virtual:pwa-register';
import { detectPlatform } from './probe/device';
import { isNativeApp } from './native';

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export interface PwaState {
  /** A new version is waiting; call applyUpdate() to switch. */
  needRefresh: boolean;
  /** Chromium's install prompt is available (desktop Chrome/Edge, Android). */
  canInstall: boolean;
  /** Running as an installed app. */
  installed: boolean;
  /**
   * The site's sign-in (Cloudflare Access on the test site) expired: the update
   * check is redirected to a login page, so new versions can't be fetched.
   */
  signInNeeded: boolean;
}

let state: PwaState = {
  needRefresh: false,
  canInstall: false,
  installed: isNativeApp || detectPlatform().standalone,
  signInNeeded: false,
};
const subs = new Set<(s: PwaState) => void>();
let deferredPrompt: BeforeInstallPromptEvent | null = null;

function set(patch: Partial<PwaState>) {
  state = { ...state, ...patch };
  subs.forEach((fn) => fn(state));
}

// The apps serve their files themselves (from the APK, or the desktop app's
// bundle): no service worker there, and updates come with a new install.
const HOUR = 3_600_000;
const updateSW = isNativeApp
  ? async () => {}
  : registerSW({
    onNeedRefresh: () => set({ needRefresh: true }),
    // The browser only looks for a new version when the page loads, and an installed
    // app can stay open for days: check every hour and when it comes back to the front.
    onRegisteredSW(swUrl, registration) {
      if (!registration) return;
      let last = 0;
      const check = async () => {
        if (registration.installing || !navigator.onLine || Date.now() - last < 5 * 60_000) return;
        last = Date.now();
        // A sign-in page answers with a redirect, which the browser's own check drops silently.
        const res = await fetch(swUrl, { cache: 'no-store', redirect: 'manual' }).catch(() => null);
        if (!res) return;
        if (res.type === 'opaqueredirect' || res.status === 401 || res.status === 403) return set({ signInNeeded: true });
        set({ signInNeeded: false });
        if (res.ok) await registration.update().catch(() => {});
      };
      setInterval(check, HOUR);
      addEventListener('visibilitychange', () => document.visibilityState === 'visible' && void check());
      void check();
    },
  });

// Back from the sign-in page (see signInAgain): drop the marker from the address.
if (/[?&]signin=/.test(location.search)) history.replaceState(null, '', location.pathname);

/**
 * Load the page from the network once, past the offline copy, so the site's
 * sign-in page can show; it brings the visitor back here, signed in.
 */
export function signInAgain() {
  location.href = `${location.pathname}?signin=${Date.now()}`;
}

addEventListener('beforeinstallprompt', (e) => {
  // Keep Chrome's mini-infobar from showing at a random moment; we offer
  // install at a meaningful point (after a model download, and in Settings).
  e.preventDefault();
  deferredPrompt = e as BeforeInstallPromptEvent;
  set({ canInstall: true });
});

addEventListener('appinstalled', () => {
  deferredPrompt = null;
  set({ canInstall: false, installed: true });
});

export async function promptInstall(): Promise<boolean> {
  if (!deferredPrompt) return false;
  await deferredPrompt.prompt();
  const { outcome } = await deferredPrompt.userChoice;
  deferredPrompt = null; // a prompt can only be used once
  set({ canInstall: false });
  return outcome === 'accepted';
}

export function applyUpdate(): Promise<void> {
  return updateSW(true);
}

export function usePwa(): PwaState {
  const [s, setS] = useState(state);
  useEffect(() => {
    subs.add(setS);
    setS(state);
    return () => void subs.delete(setS);
  }, []);
  return s;
}
