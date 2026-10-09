import { useEffect, useRef, useState } from 'preact/hooks';
import { pause, start, type BootState } from '../boot';
import { getSetting } from '../db';
import { FirstRun, Tips } from './FirstRun';
import { formatDuration } from '../net';
import { fmtBytes } from './format';
import { LockIcon, Orb } from './icons';
import { SettingsDialog } from './SettingsDialog';
import { t, tj } from '../i18n/i18n';

const MB = 1024 ** 2;

export function BootScreen({ s }: { s: Exclude<BootState, { kind: 'ready' }> }) {
  const [settings, setSettings] = useState(false);
  // The first-run steps, once: undefined while the setting loads, to avoid a flash of the plain card.
  const [onboarded, setOnboarded] = useState<boolean | undefined>();
  useEffect(() => {
    getSetting('onboarded').then((v) => setOnboarded(!!v), () => setOnboarded(true));
  }, []);
  const firstRun = s.kind === 'welcome' && s.cachedBytes === 0 && onboarded === false;

  return (
    <main class="boot">
      <div class="boot-inner">
        <LogoStage s={s} />
        <h1 class="boot-title">My Own AI</h1>
        <p class="boot-tag"><LockIcon /> {t('Runs entirely on your device. Nothing you type leaves it.')}</p>

        {s.kind === 'probing' && <Status label={t('Checking your device…')} />}
        {s.kind === 'running' && <Running s={s} />}
        {s.kind === 'running' && s.downloading && <Tips />}
        {firstRun && <FirstRun s={s} />}
        {((s.kind === 'welcome' && onboarded !== undefined && !firstRun) || s.kind === 'paused') && (
          <Welcome s={s} onChoose={() => setSettings(true)} />
        )}
        {s.kind === 'error' && (
          <div class="boot-card">
            <div class="alert">
              {s.downloaded
                ? t('{model} is downloaded but couldn’t start on your GPU. A smaller model may work.', { model: s.model.displayName })
                : t('Couldn’t load {model}.', { model: s.model.displayName })}
              <details class="small"><summary>{t('Details')}</summary>{s.message}</details>
            </div>
            <div class="boot-actions">
              <button class="btn btn-primary" onClick={() => start(s.modelId)}>{t('Try again')}</button>
              <button class="btn" onClick={() => setSettings(true)}>{t('Choose another model')}</button>
            </div>
          </div>
        )}
        {s.kind === 'unsupported' && <Unsupported s={s} />}
      </div>
      <SettingsDialog open={settings} onClose={() => setSettings(false)} initialTab="model" />
    </main>
  );
}

function Status({ label }: { label: string }) {
  return (
    <div class="boot-card">
      <div class="bar bar-indeterminate"><div /></div>
      <p class="boot-status">{label}</p>
    </div>
  );
}

function Welcome({ s, onChoose }: { s: Extract<BootState, { kind: 'welcome' | 'paused' }>; onChoose: () => void }) {
  const remaining = Math.max(0, s.totalBytes - s.cachedBytes);
  const resuming = s.cachedBytes > 0;
  return (
    <div class="boot-card">
      {s.kind === 'paused' && <p class="notice">{s.reason}</p>}
      <div class="model-hero">
        <div>
          <div class="eyebrow">{resuming ? t('Continue setup') : t('Recommended for this device')}</div>
          <div class="model-name">{s.model.displayName}</div>
          <div class="muted small">{t('{params} parameters · runs on your GPU', { params: s.model.params })}</div>
        </div>
      </div>
      {resuming && (
        <div class="bar"><div style={{ width: `${(s.cachedBytes / s.totalBytes) * 100}%` }} /></div>
      )}
      <dl class="kv">
        <dt>{resuming ? t('Left to download') : t('One-time download')}</dt><dd>{fmtBytes(remaining)}</dd>
        <dt>{t('GPU memory')}</dt><dd>≈ {fmtBytes(s.model.vramMB * MB)}</dd>
      </dl>
      {s.kind === 'welcome' && s.metered && (
        <p class="notice">{t('You seem to be on cellular or data saver. Wi-Fi is recommended.')}</p>
      )}
      <div class="boot-actions">
        <button class="btn btn-primary btn-lg" onClick={() => start(s.modelId)}>
          {resuming ? t('Resume download') : t('Download & start')}
        </button>
        <button class="btn btn-ghost" onClick={onChoose}>{t('Choose another model')}</button>
      </div>
      <p class="fine">{t('Stored only in this browser. Next time it starts straight from your device.')}</p>
    </div>
  );
}

function Running({ s }: { s: Extract<BootState, { kind: 'running' }> }) {
  const p = s.progress;
  const eta = useEta(p.stage === 'fetch' ? p.mb : undefined, s.totalBytes / MB);
  const step = p.stage === 'fetch' ? 1 : p.stage === 'load' || p.stage === 'ready' ? 2 : s.downloading ? 1 : 2;
  const pct = Math.floor(p.fraction * 100);
  const label =
    p.stage === 'fetch' ? t('Downloading {model}', { model: s.model.displayName })
    : p.stage === 'load' ? t('Loading onto your GPU')
    : p.stage === 'ready' ? t('Almost ready')
    : s.downloading ? t('Preparing download') : t('Starting the model');
  return (
    <div class="boot-card">
      <ol class="steps">
        <li class="done">{t('Device')}</li>
        {s.downloading && <li class={step > 1 ? 'done' : 'active'}>{t('Download')}</li>}
        <li class={step === 2 ? 'active' : ''}>{t('Load')}</li>
        <li>{t('Chat')}</li>
      </ol>
      <div class="bar-row">
        <span class="boot-status">{label}</span>
        <span class="pct">{pct}%</span>
      </div>
      <div class="bar"><div style={{ width: `${Math.max(2, p.fraction * 100)}%` }} /></div>
      <p class="muted small boot-detail">
        {p.stage === 'fetch' && p.mb != null
          ? <>{t('{done} of {total}', { done: fmtBytes(p.mb * MB), total: fmtBytes(s.totalBytes) })}{eta && <> · {t('about {time} left', { time: eta })}</>}</>
          : p.stage === 'load' ? t('Reading from this device. Nothing is downloaded.')
          : p.stage === 'ready' ? t('Compiling GPU kernels…')
          : ' '}
      </p>
      {s.downloading && p.stage !== 'load' && p.stage !== 'ready' && (
        <div class="boot-actions">
          <button class="btn btn-ghost" onClick={() => pause()}>{t('Pause')}</button>
        </div>
      )}
      {s.downloading && p.stage !== 'load' && p.stage !== 'ready' && (
        <p class="fine">{t('Safe to close: finished parts are saved and the download resumes next time.')}</p>
      )}
    </div>
  );
}

/** Measured throughput beats the browser's coarse connection estimate. */
function useEta(mb: number | undefined, totalMB: number): string | null {
  const first = useRef<{ t: number; mb: number } | null>(null);
  const last = useRef(0);
  if (mb == null) return null;
  const now = performance.now();
  // Cached parts are reported in a burst on resume; keep moving the baseline through it.
  if (!first.current || (now - last.current < 300 && now - first.current.t < 2000)) first.current = { t: now, mb };
  last.current = now;
  const secs = (now - first.current.t) / 1000;
  const rate = (mb - first.current.mb) / secs;
  return secs > 3 && rate > 0 ? formatDuration((totalMB - mb) / rate) : null;
}

function Unsupported({ s }: { s: Extract<BootState, { kind: 'unsupported' }> }) {
  const { gpu } = s.device;
  return (
    <div class="boot-card">
      <p class="alert">{t('This browser can’t run local models.')}</p>
      <ul class="reasons">{s.decision.reasons.map((r) => <li>{r}</li>)}</ul>
      {gpu.apiPresent && gpu.secureContext && !gpu.adapter ? (
        <>
          <p class="small">{tj('On Chrome for Android, open {page} and check “WebGPU”. If it’s blocklisted:', { page: <code>chrome://gpu</code> })}</p>
          <ol class="small">
            <li>{tj('Enable {flag}.', { flag: <code>chrome://flags/#ignore-gpu-blocklist</code> })}</li>
            <li>{tj('Enable {flag1} and {flag2}.', { flag1: <code>chrome://flags/#enable-unsafe-webgpu</code>, flag2: <code>chrome://flags/#enable-vulkan</code> })}</li>
            <li>{t('Relaunch, fully close Chrome from recent apps, and reopen it.')}</li>
          </ol>
          <p class="fine">{t('Battery-saver or protected modes can also hide the GPU.')}</p>
        </>
      ) : (
        <p class="small">{t('Try a recent desktop Chrome or Edge, Safari 26+, or Chrome on Android.')}</p>
      )}
    </div>
  );
}

/**
 * The logo while starting: ripples while the device is checked and the model loads,
 * and a ring around it that fills with the download.
 */
function LogoStage({ s }: { s: Exclude<BootState, { kind: 'ready' }> }) {
  const active = s.kind === 'probing' || s.kind === 'running';
  const fraction = s.kind === 'running' && s.downloading && s.progress.stage === 'fetch' ? s.progress.fraction : null;
  const R = 56;
  const C = 2 * Math.PI * R;
  return (
    <div class={active ? 'logo-stage active' : 'logo-stage'}>
      {active && <><span class="ripple" /><span class="ripple r2" /><span class="ripple r3" /></>}
      {fraction !== null && (
        <svg class="logo-ring" viewBox="0 0 124 124" aria-hidden="true">
          <defs>
            <linearGradient id="ring-grad" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stop-color="var(--accent)" />
              <stop offset="1" stop-color="var(--accent-2)" />
            </linearGradient>
          </defs>
          <circle class="ring-track" cx="62" cy="62" r={R} />
          <circle class="ring-fill" cx="62" cy="62" r={R} style={{ strokeDasharray: C, strokeDashoffset: C * (1 - Math.max(0.01, fraction)) }} />
        </svg>
      )}
      <Orb size={88} pulse={active} />
    </div>
  );
}
