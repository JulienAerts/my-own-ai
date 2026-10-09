import { useState } from 'preact/hooks';
import { desktopOffer, downloadDesktopApp, RELEASES_URL, type DesktopOS, type Installer } from '../getapp';
import { t } from '../i18n/i18n';
import { fmtBytes } from './format';

const OS_NAME: Record<DesktopOS, string> = { windows: 'Windows', mac: 'Mac', linux: 'Linux' };
const DISMISSED = 'my-own-ai.desktopOfferDismissed';
const VISITS = 'my-own-ai.visits';

/** Visits to the site, counted once per page load: the card waits for the third. */
let visits = 0;
try {
  visits = Number(localStorage.getItem(VISITS) ?? 0) + 1;
  localStorage.setItem(VISITS, String(visits));
} catch {
  // Storage blocked: never show the card.
}

function dismissed(): boolean {
  try {
    return localStorage.getItem(DISMISSED) === '1';
  } catch {
    return true;
  }
}

/** What opening the installer takes, per system (unsigned app, for now). */
function firstOpen(os: DesktopOS): string {
  if (os === 'windows') return t('Open it when it’s downloaded. If Windows warns about an unknown app: More info → Run anyway.');
  if (os === 'mac') return t('Open it, drag My Own AI to Applications, then the first time right-click the app → Open.');
  return t('Make it executable (Properties → Permissions, or chmod +x), then open it.');
}

function DownloadButton({ os, primary = true }: { os: DesktopOS; primary?: boolean }) {
  const [state, setState] = useState<'idle' | 'busy' | Installer | 'page'>('idle');
  async function go() {
    setState('busy');
    setState((await downloadDesktopApp(os)) ?? 'page');
  }
  return (
    <>
      <button class={primary ? 'btn btn-primary' : 'btn'} disabled={state === 'busy'} onClick={go}>
        {state === 'busy' ? t('Finding the download…') : t('Download for {os}', { os: OS_NAME[os] })}
      </button>
      {typeof state === 'object' && (
        <p class="small muted" role="status">
          {t('Downloading version {version} ({size}).', { version: state.version, size: fmtBytes(state.bytes) })} {firstOpen(os)}
        </p>
      )}
      {state === 'page' && <p class="small muted" role="status">{t('GitHub couldn’t be reached for the file list, so its releases page opened instead.')}</p>}
    </>
  );
}

/** What the desktop app adds, in a few words. */
function Benefits({ os }: { os: DesktopOS }) {
  return (
    <ul class="small get-app-list">
      <li>{t('Bigger, faster models on your graphics card (up to 32B), with long conversations.')}</li>
      <li>{t('Your folders, connectors (MCP) and running Python.')}</li>
      {os === 'windows' && <li>{t('With an NVIDIA graphics card: image generation and dictation in many languages.')}</li>}
      <li>{t('Ready in the tray, with a keyboard shortcut. Still private: everything stays on your computer.')}</li>
    </ul>
  );
}

/**
 * The desktop app, offered on the website to visitors on Windows, Mac or Linux.
 *  - section: in Settings → App, always;
 *  - card: on the empty chat screen, from the third visit, until dismissed;
 *  - line: a sentence where the browser falls short (the model list).
 */
export function GetDesktopApp({ variant }: { variant: 'section' | 'card' | 'line' }) {
  const os = desktopOffer();
  const [hidden, setHidden] = useState(() => variant === 'card' && (visits < 3 || dismissed()));
  if (!os || hidden) return null;
  const mac = os === 'mac' && <p class="small muted">{t('For Macs with Apple Silicon (M1 or newer).')}</p>;
  const others = <a class="small" href={RELEASES_URL} target="_blank" rel="noreferrer">{t('Other systems and versions')}</a>;

  if (variant === 'line') {
    return (
      <div class="get-app-line small">
        <span>{t('Bigger and faster models (up to 32B, on your graphics card) run in the desktop app for {os}.', { os: OS_NAME[os] })}</span>
        <DownloadButton os={os} primary={false} />
      </div>
    );
  }

  if (variant === 'card') {
    const close = () => {
      setHidden(true);
      try {
        localStorage.setItem(DISMISSED, '1');
      } catch {
        // Storage blocked: hidden for this visit only.
      }
    };
    return (
      <div class="get-app-card">
        <strong>{t('My Own AI for {os}', { os: OS_NAME[os] })}</strong>
        <Benefits os={os} />
        {mac}
        <div class="row">
          <DownloadButton os={os} />
          <button class="btn btn-ghost" onClick={close}>{t('Not now')}</button>
        </div>
      </div>
    );
  }

  return (
    <div class="section">
      <h3>{t('Desktop app')}</h3>
      <p class="small">{t('The same assistant as an app for {os}, with more it can do:', { os: OS_NAME[os] })}</p>
      <Benefits os={os} />
      {mac}
      <div class="row">
        <DownloadButton os={os} />
        {others}
      </div>
    </div>
  );
}
