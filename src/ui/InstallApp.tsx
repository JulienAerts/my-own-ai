import { useEffect, useState } from 'preact/hooks';
import { promptInstall, usePwa } from '../pwa';
import { detectPlatform } from '../probe/device';
import { getSetting, setSetting } from '../db';
import { t, tj } from '../i18n/i18n';

/**
 * "Install this app" call to action. Chromium gets the native prompt. iOS has
 * no prompt API, so it gets Add to Home Screen instructions: installed web apps
 * are exempt from Safari's 7-day eviction of script-writable storage, which
 * would otherwise delete the downloaded model.
 */
export function InstallApp({ dismissible = false }: { dismissible?: boolean }) {
  const pwa = usePwa();
  const { isIOS } = detectPlatform();
  const [dismissed, setDismissed] = useState<boolean | null>(dismissible ? null : false);

  useEffect(() => {
    if (dismissible) getSetting('a2hsDismissed').then((v) => setDismissed(!!v));
  }, []);

  if (pwa.installed || dismissed !== false) return null;

  function dismiss() {
    setDismissed(true);
    setSetting('a2hsDismissed', true);
  }

  if (isIOS) {
    return (
      <div class="install-app">
        <strong>{t('Add to your Home Screen')}</strong>
        <p class="small">
          {t('Safari may delete the downloaded model if you don’t use this site for 7 days. Apps added to the Home Screen are exempt, and they open full-screen and work offline.')}
        </p>
        <ol class="small">
          <li>{tj('Tap the {share} button {icon} in Safari’s toolbar.', { share: <strong>{t('Share')}</strong>, icon: <ShareIcon /> })}</li>
          <li>{tj('Choose {a2hs}, then {add}.', { a2hs: <strong>{t('Add to Home Screen')}</strong>, add: <strong>{t('Add')}</strong> })}</li>
          <li>{t('Open My Own AI from your Home Screen.')}</li>
        </ol>
        {dismissible && <button class="btn btn-ghost" onClick={dismiss}>{t('Not now')}</button>}
      </div>
    );
  }

  if (!pwa.canInstall) return null;
  return (
    <div class="install-app">
      <strong>{t('Install as an app')}</strong>
      <p class="small">{t('Opens in its own window and works offline once a model is downloaded.')}</p>
      <div class="row">
        <button class="btn btn-primary" onClick={() => promptInstall()}>{t('Install app')}</button>
        {dismissible && <button class="btn btn-ghost" onClick={dismiss}>{t('Not now')}</button>}
      </div>
    </div>
  );
}

function ShareIcon() {
  return (
    <svg class="inline-icon" viewBox="0 0 24 24" aria-label={t('Share')} role="img">
      <path d="M12 3v12M7 8l5-5 5 5M5 12v8h14v-8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  );
}
