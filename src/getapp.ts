// "Get the app": on the website, offer the desktop app for the visitor's system
// (it runs bigger models on the graphics card and has folders, connectors…).
// The release's file names carry the version, so the download link is looked up
// in GitHub's release list, only when the user clicks; if that fails, the
// releases page opens instead.
import { isNativeApp } from './native';
import { REPO_URL } from './report';

export type DesktopOS = 'windows' | 'mac' | 'linux';

export const RELEASES_URL = `${REPO_URL}/releases/latest`;
const LATEST_API = REPO_URL.replace('https://github.com/', 'https://api.github.com/repos/') + '/releases/latest';

/** The installer for each system: Windows setup, Mac disk image (Apple Silicon), Linux AppImage. */
const INSTALLER: Record<DesktopOS, RegExp> = {
  windows: /_x64-setup\.exe$/,
  mac: /_aarch64\.dmg$/,
  linux: /_amd64\.AppImage$/,
};

/**
 * The desktop system this browser runs on, or null: inside the apps, on phones and
 * tablets (iPads say "Macintosh"), and on ChromeOS.
 */
export function desktopOffer(
  ua = typeof navigator !== 'undefined' ? navigator.userAgent : '',
  touchPoints = typeof navigator !== 'undefined' ? navigator.maxTouchPoints : 0,
): DesktopOS | null {
  if (isNativeApp || /Android|iPhone|iPad|iPod|Mobi|CrOS/i.test(ua)) return null;
  if (/Windows/i.test(ua)) return 'windows';
  if (/Macintosh|Mac OS X/i.test(ua)) return touchPoints > 1 ? null : 'mac';
  if (/Linux|X11/i.test(ua)) return 'linux';
  return null;
}

export interface Installer {
  url: string;
  name: string;
  version: string;
  bytes: number;
}

/** The latest release's installer for `os`, or null if GitHub can't be reached or has none. */
export async function latestInstaller(os: DesktopOS, fetchFn: typeof fetch = fetch): Promise<Installer | null> {
  try {
    const res = await fetchFn(LATEST_API, { headers: { Accept: 'application/vnd.github+json' }, referrerPolicy: 'no-referrer' });
    if (!res.ok) return null;
    const release = (await res.json()) as { tag_name?: string; assets?: { name: string; browser_download_url: string; size: number }[] };
    const asset = release.assets?.find((a) => INSTALLER[os].test(a.name));
    if (!asset) return null;
    return { url: asset.browser_download_url, name: asset.name, version: (release.tag_name ?? '').replace(/^desktop-v/, ''), bytes: asset.size };
  } catch {
    return null;
  }
}

/** Start the download (or open the releases page). */
export async function downloadDesktopApp(os: DesktopOS): Promise<Installer | null> {
  const installer = await latestInstaller(os);
  const a = document.createElement('a');
  a.href = installer?.url ?? RELEASES_URL;
  a.rel = 'noreferrer';
  if (!installer) a.target = '_blank';
  document.body.append(a);
  a.click();
  a.remove();
  return installer;
}
