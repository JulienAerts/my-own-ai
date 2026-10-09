// Settings → App → Desktop (desktop app only).
import { useEffect, useState } from 'preact/hooks';
import { SHORTCUT, keepInTray, setKeepInTray, setStartsWithWindows, startsWithWindows } from '../desktop/desktop';
import { t, tj } from '../i18n/i18n';
import { appVersion, checkForUpdate, installUpdate, useUpdate } from '../desktop/updates';
import { desktopOS } from '../native';

export function DesktopSection() {
  const [tray, setTray] = useState(true);
  const [autostart, setAutostart] = useState(false);
  const [version, setVersion] = useState('');
  const update = useUpdate();
  useEffect(() => {
    appVersion().then(setVersion, () => {});
    keepInTray().then(setTray);
    startsWithWindows().then(setAutostart);
  }, []);
  return (
    <div class="section">
      <h3>{t('Desktop')}</h3>
      <p class="small muted">
        {tj('Press {keys} anywhere to bring My Own AI up with a new chat.', { keys: <kbd>{SHORTCUT}</kbd> })}
      </p>
      <label class="switch-row">
        <span>
          <strong>{t('Keep running in the tray')}</strong>
          <span class="muted small">{t('Closing the window hides it; the model stays loaded, so answers start at once. Quit from the tray icon.')}</span>
        </span>
        <input type="checkbox" class="switch" checked={tray} onChange={(e) => { setTray(e.currentTarget.checked); void setKeepInTray(e.currentTarget.checked); }} />
      </label>
      <label class="switch-row">
        <span>
          <strong>{desktopOS === 'windows' ? t('Start with Windows') : t('Start at login')}</strong>
          <span class="muted small">{t('Starts in the tray when you sign in, ready for the shortcut.')}</span>
        </span>
        <input type="checkbox" class="switch" checked={autostart} onChange={async (e) => {
          const on = e.currentTarget.checked;
          setAutostart(on);
          await setStartsWithWindows(on).catch(() => setAutostart(!on));
        }} />
      </label>
      <div class="row spread">
        <span>
          <strong>{t('Updates')}</strong>
          <span class="muted small update-status">
            {version && t('Version {version}', { version })}
            {update.kind === 'checking' && ` · ${t('Checking…')}`}
            {update.kind === 'current' && ` · ${t('Up to date')}`}
            {update.kind === 'available' && ` · ${t('Version {version} is available.', { version: update.version })}`}
            {update.kind === 'downloading' && ` · ${t('Downloading version {version}… {pct}%', { version: update.version, pct: Math.floor(update.fraction * 100) })}`}
            {update.kind === 'error' && ` · ${t('Couldn’t check: {error}', { error: update.message })}`}
          </span>
        </span>
        {update.kind === 'available'
          ? <button class="btn btn-sm btn-primary" onClick={() => installUpdate()}>{t('Update and restart')}</button>
          : <button class="btn btn-sm" disabled={update.kind === 'checking' || update.kind === 'downloading'} onClick={() => checkForUpdate()}>{t('Check now')}</button>}
      </div>
      <p class="small muted">{t('New versions come from the project’s GitHub releases and are installed only if they carry its signature.')}</p>
    </div>
  );
}
