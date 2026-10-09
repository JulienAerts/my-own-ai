// Running inside one of the app shells rather than a browser tab:
//  - Android: Capacitor, which defines window.Capacitor before the page's scripts;
//  - Windows/Mac: Tauri, which defines window.__TAURI_INTERNALS__.
// Both can make HTTP requests outside the browser's CORS rules (web search,
// read_page) and serve the files themselves (no service worker).
type ShellWindow = { Capacitor?: { isNativePlatform?(): boolean }; __TAURI_INTERNALS__?: unknown };
const w = (typeof window !== 'undefined' ? window : {}) as ShellWindow;

export const isAndroidApp: boolean = !!w.Capacitor?.isNativePlatform?.();
export const isDesktopApp: boolean = !!w.__TAURI_INTERNALS__;
export const isNativeApp: boolean = isAndroidApp || isDesktopApp;

/** The desktop app's system, for features that exist only on one (Whisper and image generation: Windows). */
export const desktopOS: 'windows' | 'mac' | 'linux' | null = !isDesktopApp
  ? null
  : /Windows/i.test(navigator.userAgent) ? 'windows' : /Mac OS X|Macintosh/i.test(navigator.userAgent) ? 'mac' : 'linux';
