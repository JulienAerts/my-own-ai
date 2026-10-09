// Which tools the user has switched off. Stored as a deny-list so tools added
// in later versions start enabled. A module-level store keeps the settings
// dialog and the chat in sync without a reload.
import { useEffect, useState } from 'preact/hooks';
import { getSetting, setSetting } from '../db';
import { TOOLS, type ToolDef } from './tools';

let disabled: Set<string> = new Set();
let loaded: Promise<void> | null = null;
const subs = new Set<() => void>();

function load(): Promise<void> {
  loaded ??= getSetting('disabledTools')
    .then((v) => { disabled = new Set(v ?? []); })
    .catch(() => {})
    .finally(() => subs.forEach((fn) => fn()));
  return loaded;
}

export async function enabledTools(): Promise<ToolDef[]> {
  await load();
  return TOOLS.filter((t) => !disabled.has(t.name));
}

export async function setToolsEnabled(names: string[], on: boolean): Promise<void> {
  await load();
  disabled = new Set(disabled);
  for (const n of names) {
    if (on) disabled.delete(n);
    else disabled.add(n);
  }
  subs.forEach((fn) => fn());
  await setSetting('disabledTools', [...disabled]);
}

/** Enabled tools, re-rendering when the selection changes. */
export function useEnabledTools(): { tools: ToolDef[]; isOn(name: string): boolean; ready: boolean } {
  const [, bump] = useState(0);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const fn = () => bump((n) => n + 1);
    subs.add(fn);
    load().then(() => setReady(true));
    return () => void subs.delete(fn);
  }, []);
  return {
    tools: TOOLS.filter((t) => !disabled.has(t.name)),
    isOn: (name) => !disabled.has(name),
    ready,
  };
}
