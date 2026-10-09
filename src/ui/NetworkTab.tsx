// Settings → Network: what the app sent to the internet this session (src/net/netlog.ts).
import { useEffect, useState } from 'preact/hooks';
import { clearNetEntries, netEntries, onNetChange, serviceOf, type NetEntry } from '../net/netlog';
import { locale, num, t, tn, UNIT } from '../i18n/i18n';

function useNet(): readonly NetEntry[] {
  const [, bump] = useState(0);
  useEffect(() => onNetChange(() => bump((n) => n + 1)), []);
  return netEntries();
}

function size(n?: number): string {
  if (!n) return '';
  if (n < 1024) return `${n} ${UNIT.B}`;
  if (n < 1024 ** 2) return `${Math.round(n / 1024)} ${UNIT.KB}`;
  if (n < 1024 ** 3) return `${num(n / 1024 ** 2, n < 10 * 1024 ** 2 ? 1 : 0)} ${UNIT.MB}`;
  return `${num(n / 1024 ** 3, 1)} ${UNIT.GB}`;
}

const time = (ms: number) => new Date(ms).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' });

function Status({ e }: { e: NetEntry }) {
  if (e.status === 'pending') return <span class="pill pill-accent">{t('In progress')}</span>;
  if (e.status === 'error') return <span class="pill net-bad">{t('Failed')}</span>;
  if (e.status >= 400) return <span class="pill net-bad">HTTP {e.status}</span>;
  return null;
}

export function NetworkTab() {
  const list = useNet();
  const [service, setService] = useState<string | null>(null);

  const groups = new Map<string, { count: number; bytes: number }>();
  for (const e of list) {
    const g = groups.get(serviceOf(e.host)) ?? { count: 0, bytes: 0 };
    g.count++;
    g.bytes += e.bytes ?? 0;
    groups.set(serviceOf(e.host), g);
  }
  const shown = list.filter((e) => !service || serviceOf(e.host) === service).slice().reverse();
  const pending = list.filter((e) => e.status === 'pending').length;

  return (
    <>
      <p class="muted small">
        {t('Everything this app has sent to the internet since it opened. The models, your conversations, documents and memory stay on this device: a web tool sends only its query (it’s in the address below), a download only asks for its file. The app’s own files and the local engines on this device aren’t listed, since they don’t leave it.')}
      </p>

      <div class="section">
        <div class="row spread">
          <h3>{list.length ? `${tn(list.length, '{n} request', '{n} requests')} ${tn(groups.size, 'to {n} service', 'to {n} services')}` : t('No requests yet')}</h3>
          {pending > 0 && <span class="pill pill-accent">{t('{n} in progress', { n: pending })}</span>}
        </div>
        {list.length === 0 ? (
          <p class="muted small">{t('Nothing has left this device since the app opened.')}</p>
        ) : (
          <div class="net-services" role="radiogroup" aria-label={t('Filter by service')}>
            <button class={service === null ? 'net-service on' : 'net-service'} role="radio" aria-checked={service === null} onClick={() => setService(null)}>
              <strong>{t('All')}</strong>
              <span class="muted small">{list.length}</span>
            </button>
            {[...groups].sort((a, b) => b[1].count - a[1].count).map(([name, g]) => (
              <button class={service === name ? 'net-service on' : 'net-service'} role="radio" aria-checked={service === name} onClick={() => setService(service === name ? null : name)}>
                <strong>{name}</strong>
                <span class="muted small">{g.count}{g.bytes ? ` · ${size(g.bytes)}` : ''}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {shown.length > 0 && (
        <ul class="net-list">
          {shown.map((e) => (
            <li key={e.id}>
              <details class="net-item">
                <summary>
                  <span class="net-time muted small">{time(e.t)}</span>
                  <span class="net-what">
                    <strong>{serviceOf(e.host)}</strong>
                    <span class="muted small">{netSourceLabel(e.source)}</span>
                  </span>
                  <span class="net-meta small">
                    <Status e={e} />
                    <span class="muted">{size(e.bytes)}</span>
                  </span>
                </summary>
                <dl class="net-detail small">
                  <dt>{t('Address')}</dt><dd><code>{e.url}</code></dd>
                  <dt>{t('Method')}</dt><dd>{e.method}</dd>
                  {e.status !== 'pending' && <><dt>{t('Result')}</dt><dd>{e.status === 'error' ? t('Failed (no answer)') : `HTTP ${e.status}`}{e.ms !== undefined ? ` ${t('in {time}', { time: e.ms < 1000 ? `${e.ms} ms` : `${(e.ms / 1000).toLocaleString(locale, { maximumFractionDigits: 1 })} s` })}` : ''}</dd></>}
                  {e.bytes ? <><dt>{t('Received')}</dt><dd>{size(e.bytes)}</dd></> : null}
                </dl>
              </details>
            </li>
          ))}
        </ul>
      )}

      {list.length > 0 && (
        <button class="btn btn-ghost" onClick={() => { clearNetEntries(); setService(null); }}>{t('Clear the list')}</button>
      )}
      <p class="muted small">{t('The list is kept until you close the app; nothing is saved.')}</p>
    </>
  );
}

/** Sources are recorded in English (workers name themselves); shown in the interface language. */
function netSourceLabel(source: string): string {
  const fixed: Record<string, () => string> = {
    App: () => t('App'),
    'Chat model (WebLLM)': () => t('Chat model (WebLLM)'),
    'Document search': () => t('Document search'),
    'Speech recognition': () => t('Speech recognition'),
    Voices: () => t('Voices'),
    'Code sandbox (Python)': () => t('Code sandbox (Python)'),
    'Background worker': () => t('Background worker'),
  };
  return fixed[source]?.() ?? source;
}
