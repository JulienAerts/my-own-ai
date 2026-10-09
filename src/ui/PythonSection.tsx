// Settings → Connectors → Python on this PC (desktop, opt-in).
import { useEffect, useState } from 'preact/hooks';
import { nativePythonEnabled, pythonInfo, setNativePython } from '../native/python';
import { t } from '../i18n/i18n';

export function PythonSection() {
  const [version, setVersion] = useState<string | null | undefined>(undefined);
  const [on, setOn] = useState(false);
  useEffect(() => {
    pythonInfo().then((p) => setVersion(p?.version ?? null));
    nativePythonEnabled().then(setOn);
  }, []);
  return (
    <div class="section">
      <h3>{t('Python on this PC')}</h3>
      <p class="small muted">
        {t('Let the assistant run code with your own Python, its packages, your files and programs. Unlike the built-in code sandbox it has full access to this PC, so it shows you the code and waits for your yes every time.')}
      </p>
      {version === null ? (
        <p class="small muted">{t('No Python 3 found. Install it from python.org (tick “Add to PATH”), then restart the app.')}</p>
      ) : (
        <label class="switch-row">
          <span>
            <strong>{t('Allow real Python')}</strong>
            <span class="muted small">{version ?? t('Checking…')}</span>
          </span>
          <input type="checkbox" class="switch" disabled={!version} checked={on} onChange={(e) => { setOn(e.currentTarget.checked); void setNativePython(e.currentTarget.checked); }} />
        </label>
      )}
    </div>
  );
}
