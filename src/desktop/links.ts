// Desktop app: links meant for a new tab (answers' links, model pages, bug
// reports) open in the system browser. The webview doesn't open new windows
// on its own, so without this they did nothing.
import { isDesktopApp } from '../native';

export async function openExternal(url: string): Promise<void> {
  if (!isDesktopApp) {
    window.open(url, '_blank', 'noopener');
    return;
  }
  const { openUrl } = await import('@tauri-apps/plugin-opener');
  await openUrl(url);
}

/** Send clicks on http(s) links with target="_blank" to the system browser. */
export function catchExternalLinks(): void {
  if (!isDesktopApp) return;
  document.addEventListener('click', (e) => {
    const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
    if (!a || a.target !== '_blank' || !/^(https?:|mailto:)/.test(a.href)) return;
    e.preventDefault();
    void openExternal(a.href);
  });
}
