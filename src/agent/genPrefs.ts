// Generation settings per model (Settings → Model → Generation). Unset values
// mean "Auto": the app's own defaults, which depend on the turn (tools, thinking).
// A module-level store keeps the settings dialog and the chat in sync.
import { useEffect, useState } from 'preact/hooks';
import { getSetting, setSetting } from '../db';

export interface GenSettings {
  /** 0–1.5. Auto: 0.3 (tool calls need steady output), 0.6 while a reasoning model thinks. */
  temperature?: number;
  /** Nucleus sampling, 0.1–1. Auto: the model's own default. */
  topP?: number;
  /** Longest answer, in tokens. Auto: 512, or more while thinking. */
  maxTokens?: number;
  /** Tokens the model keeps in mind (desktop only; changing it reloads the model). Auto: 4096. */
  contextWindow?: number;
}

let all: Record<string, GenSettings> = {};
let loaded: Promise<void> | null = null;
const subs = new Set<() => void>();

function load(): Promise<void> {
  loaded ??= getSetting('generation')
    .then((v) => { all = v ?? {}; })
    .catch(() => {})
    .finally(() => subs.forEach((fn) => fn()));
  return loaded;
}

export async function getGenSettings(modelId: string): Promise<GenSettings> {
  await load();
  return all[modelId] ?? {};
}

/** Merge `patch` into a model's settings; `undefined` values go back to Auto. */
export async function setGenSettings(modelId: string, patch: GenSettings | null): Promise<void> {
  await load();
  const next = patch ? { ...all[modelId], ...patch } : {};
  for (const k of Object.keys(next) as (keyof GenSettings)[]) if (next[k] === undefined) delete next[k];
  all = { ...all, [modelId]: next };
  if (!Object.keys(next).length) delete all[modelId];
  subs.forEach((fn) => fn());
  await setSetting('generation', all);
}

/** A model's settings, re-rendering when they change. */
export function useGenSettings(modelId: string): GenSettings {
  const [, bump] = useState(0);
  useEffect(() => {
    const fn = () => bump((n) => n + 1);
    subs.add(fn);
    load();
    return () => void subs.delete(fn);
  }, []);
  return all[modelId] ?? {};
}
