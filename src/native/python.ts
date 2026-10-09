// Real Python on the PC (desktop, opt-in): the user's interpreter and
// packages (src-tauri/src/python.rs). Unlike run_code's sandbox it can reach
// files and the network, so every run is shown to the user and needs a yes.
import { getSetting, setSetting } from '../db';
import { isDesktopApp } from '../native';
import type { ToolContext, ToolDef, ToolOutput } from '../agent/tools';
import { listFolders } from '../files/workspace';
import { t } from '../i18n/i18n';

interface PythonInfo { command: string[]; version: string }

async function invoke<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(cmd, args);
}

let info: Promise<PythonInfo | null> | null = null;
export function pythonInfo(): Promise<PythonInfo | null> {
  info ??= isDesktopApp ? invoke<PythonInfo | null>('python_info').catch(() => null) : Promise.resolve(null);
  return info;
}

let enabled = false;
export async function nativePythonEnabled(): Promise<boolean> {
  enabled = isDesktopApp && !!(await getSetting('nativePython').catch(() => false));
  return enabled;
}
export async function setNativePython(on: boolean): Promise<void> {
  enabled = on;
  await setSetting('nativePython', on);
}

async function run({ code, folder }: Record<string, string>, ctx?: ToolContext): Promise<ToolOutput> {
  const py = await pythonInfo();
  if (!py) throw new Error('No Python 3 found on this PC.');
  const f = folder?.trim() ? (await listFolders()).find((x) => x.name.toLowerCase() === folder.trim().toLowerCase()) : undefined;
  const answer = ctx?.confirm
    ? await ctx.confirm({ server: t('Python on this PC'), tool: f ? t('Run this code in {folder}', { folder: f.name }) : t('Run this code'), args: { code }, everyTime: true })
    : 'deny';
  if (answer === 'deny') return { text: 'The user declined to run this code.', error: true };
  ctx?.onStatus?.('Running Python…');
  const r = await invoke<{ output: string; exitCode: number | null; timedOut: boolean }>('run_python', {
    command: py.command, code, cwd: f?.path ?? null, timeoutS: 120,
  });
  let text = r.output.trim() || '(The code printed nothing. Print the values you need.)';
  if (r.timedOut) text += '\nStopped after 120 seconds (time limit).';
  else if (r.exitCode) text += `\n(Exit code ${r.exitCode}.)`;
  const max = ctx?.maxChars ?? 2400;
  if (text.length > max) text = `…${text.slice(-max)}`;
  return { text, error: r.timedOut || !!r.exitCode };
}

/** The tool, when the user turned it on and Python is installed. */
export function pythonTools(): ToolDef[] {
  if (!isDesktopApp || !enabled) return [];
  return [{
    name: 'run_python_local',
    label: t('Python on this PC'),
    summary: t('Run Python with your installed packages (asks every time).'),
    description: 'Run Python on the user\'s PC with their installed packages, files and programs (the user approves each run). ' +
      'Prefer run_code for calculations and charts; use this only when the user\'s own packages, files or tools are needed.',
    params: {
      code: { description: 'Complete Python code; print what you want to see', example: 'import sys; print(sys.version)' },
      folder: { description: 'A workspace folder to run in (its name), or ""', example: '' },
    },
    run,
  }];
}
