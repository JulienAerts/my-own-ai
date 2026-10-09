// Desktop app conveniences (src-tauri/src/desktop.rs): the window closes to
// the tray, Ctrl+Alt+Space summons it with a new chat, and it can start with
// Windows. Preferences live in settings; Rust is told at startup.
import { getSetting, setSetting } from '../db';
import { isDesktopApp } from '../native';

export const SHORTCUT = 'Ctrl+Alt+Space';

async function invoke<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(cmd, args);
}

export async function keepInTray(): Promise<boolean> {
  return (await getSetting('keepInTray').catch(() => undefined)) ?? true;
}

export async function setKeepInTray(on: boolean): Promise<void> {
  await setSetting('keepInTray', on);
  await invoke('set_keep_in_tray', { on });
}

export async function startsWithWindows(): Promise<boolean> {
  const { isEnabled } = await import('@tauri-apps/plugin-autostart');
  return isEnabled().catch(() => false);
}

export async function setStartsWithWindows(on: boolean): Promise<void> {
  const { enable, disable } = await import('@tauri-apps/plugin-autostart');
  await (on ? enable() : disable());
}

/** Apply saved preferences and call `onQuickAsk` when the shortcut (or the tray's "New chat") fires. */
export async function startDesktop(onQuickAsk: () => void): Promise<() => void> {
  if (!isDesktopApp) return () => {};
  await invoke('set_keep_in_tray', { on: await keepInTray() }).catch(() => {});
  const { listen } = await import('@tauri-apps/api/event');
  return listen('quick-ask', onQuickAsk);
}
