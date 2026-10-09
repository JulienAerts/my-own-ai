// Desktop app updates (Tauri's updater): the app reads latest.json from the
// project's GitHub Releases, and installs a new version only if it is signed
// with the project's key (the public half is in tauri.conf.json). Checked at
// start and every six hours; installing waits for the user, then restarts.
import { useEffect, useState } from 'preact/hooks';
import { isDesktopApp } from '../native';

export type UpdateState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'available'; version: string; notes?: string }
  | { kind: 'downloading'; version: string; fraction: number }
  | { kind: 'error'; message: string }
  | { kind: 'current'; checkedAt: number };

let state: UpdateState = { kind: 'idle' };
const subs = new Set<(s: UpdateState) => void>();
const set = (s: UpdateState) => {
  state = s;
  subs.forEach((fn) => fn(s));
};

type Update = Awaited<ReturnType<typeof import('@tauri-apps/plugin-updater').check>>;
let pending: Update = null;

/** Look for a new version. `quiet`: a failed background check leaves no message. */
export async function checkForUpdate(quiet = false): Promise<void> {
  if (!isDesktopApp || state.kind === 'downloading' || state.kind === 'checking') return;
  const before = state;
  set({ kind: 'checking' });
  try {
    const { check } = await import('@tauri-apps/plugin-updater');
    pending = await check();
    set(pending ? { kind: 'available', version: pending.version, notes: pending.body } : { kind: 'current', checkedAt: Date.now() });
  } catch (e) {
    // Offline, GitHub unreachable, or no release yet: try again later.
    set(quiet ? before : { kind: 'error', message: e instanceof Error ? e.message : String(e) });
  }
}

/** Download, install and restart into the new version. */
export async function installUpdate(): Promise<void> {
  if (!pending) return;
  const version = pending.version;
  let total = 0;
  let got = 0;
  set({ kind: 'downloading', version, fraction: 0 });
  try {
    await pending.downloadAndInstall((ev) => {
      if (ev.event === 'Started') total = ev.data.contentLength ?? 0;
      else if (ev.event === 'Progress') {
        got += ev.data.chunkLength;
        set({ kind: 'downloading', version, fraction: total ? got / total : 0 });
      }
    });
    const { relaunch } = await import('@tauri-apps/plugin-process');
    await relaunch();
  } catch (e) {
    set({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
  }
}

let started = false;
/** Check now and every six hours (desktop app only). */
export function startUpdateChecks(): void {
  if (!isDesktopApp || started) return;
  started = true;
  setTimeout(() => void checkForUpdate(true), 15_000); // after start-up, off the critical path
  setInterval(() => void checkForUpdate(true), 6 * 3_600_000);
}

export function useUpdate(): UpdateState {
  const [s, setS] = useState(state);
  useEffect(() => {
    subs.add(setS);
    setS(state);
    return () => void subs.delete(setS);
  }, []);
  return s;
}

/** The installed version ("0.17.0"). */
export async function appVersion(): Promise<string> {
  const { getVersion } = await import('@tauri-apps/api/app');
  return getVersion();
}
