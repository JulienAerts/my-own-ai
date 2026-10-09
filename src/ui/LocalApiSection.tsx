// Settings → Connectors → Local API (desktop): the loaded llama.cpp model for other apps.
import { useEffect, useState } from 'preact/hooks';
import { localApi, setLocalApi, activeNative, type LocalApi } from '../native/backend';
import { bootState, start } from '../boot';
import { CopyButton } from './copy';
import { t } from '../i18n/i18n';

export function LocalApiSection() {
  const [api, setApi] = useState<LocalApi | null>(null);
  const [port, setPort] = useState('');
  useEffect(() => { localApi().then((a) => { setApi(a); setPort(String(a.port)); }); }, []);
  if (!api) return null;
  const url = `http://127.0.0.1:${api.port}/v1`;
  const running = activeNative();

  // The server picks up a new port or key when the model loads again.
  async function apply(patch: Partial<LocalApi>) {
    setApi(await setLocalApi(patch));
    const s = bootState();
    if (running && s.kind === 'ready') void start(s.modelId);
  }

  return (
    <div class="section">
      <h3>{t('Local API')}</h3>
      <p class="small muted">
        {t('Let other apps on this PC (VS Code extensions, scripts, other chat apps) use the loaded GPU · llama.cpp model through the OpenAI API. Only this PC can reach it, and requests need the key.')}
      </p>
      <label class="switch-row">
        <span>
          <strong>{t('Serve the model to other apps')}</strong>
          <span class="muted small">{running ? t('Serving {model} while it’s loaded.', { model: running.model.displayName }) : t('Works while a GPU · llama.cpp model is loaded.')}</span>
        </span>
        <input type="checkbox" class="switch" checked={api.enabled} onChange={(e) => apply({ enabled: e.currentTarget.checked })} />
      </label>
      {api.enabled && (
        <dl class="kv api-kv">
          <dt>{t('Base URL')}</dt>
          <dd><code>{url}</code> <CopyButton text={url} label={t('Copy URL')} /></dd>
          <dt>{t('API key')}</dt>
          <dd><code>{api.key.slice(0, 12)}…</code> <CopyButton text={api.key} label={t('Copy key')} /></dd>
          <dt>{t('Port')}</dt>
          <dd>
            <input class="search-input port-input" inputMode="numeric" value={port} onInput={(e) => setPort(e.currentTarget.value)}
              onChange={() => { const p = Number(port); if (p >= 1024 && p <= 65535 && p !== api.port) void apply({ port: p }); else setPort(String(api.port)); }} />
          </dd>
        </dl>
      )}
      {api.enabled && (
        <details>
          <summary class="small">{t('Example')}</summary>
          <pre class="code-out">{`curl ${url}/chat/completions \\
  -H "Authorization: Bearer ${api.key}" \\
  -H "Content-Type: application/json" \\
  -d '{"messages":[{"role":"user","content":"Hello"}]}'`}</pre>
        </details>
      )}
    </div>
  );
}
