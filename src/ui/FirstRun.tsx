// First run: what the app is, a model to pick (with lighter and smarter
// alternatives to the recommendation), and a few choices before the download.
// Shown once; later visits that still need a download get the plain Welcome card.
import { useEffect, useState } from 'preact/hooks';
import { modelChoices, start, type BootState } from '../boot';
import { setSetting } from '../db';
import { TOOLS } from '../agent/tools';
import { setToolsEnabled, useEnabledTools } from '../agent/toolPrefs';
import { isNativeModel } from '../native/backend';
import type { ModelInfo } from '../models';
import { setAppearance, useAppearance, type Appearance } from './appearance';
import { fmtBytes } from './format';
import { BrainIcon, CheckIcon, GlobeIcon, LockIcon } from './icons';
import { t } from '../i18n/i18n';

const MB = 1024 ** 2;
/** Tools that send a query to an outside service (Settings → Tools lists them one by one). */
const WEB_TOOLS = TOOLS.filter((t) => t.service).map((t) => t.name);

type Welcome = Extract<BootState, { kind: 'welcome' }>;
interface Choice { id: string; model: ModelInfo; label: string; hint: string }

/** The recommendation, plus one lighter and one smarter model when this device has them. */
export function firstRunChoices(s: Welcome): Choice[] {
  const all = modelChoices().filter((c) => !(c.model.vision && !isNativeModel(c.model)));
  const rec = s.model.downloadMB;
  const lighter = all.filter((c) => c.model.downloadMB < rec * 0.7).sort((a, b) => b.model.downloadMB - a.model.downloadMB)[0];
  const smarter = all.filter((c) => c.model.downloadMB > rec * 1.3).sort((a, b) => a.model.downloadMB - b.model.downloadMB)[0];
  return [
    { id: s.modelId, model: s.model, label: t('Recommended'), hint: t('The best balance for this device') },
    ...(lighter ? [{ id: lighter.id, model: lighter.model, label: t('Lighter'), hint: t('Quicker to download, faster answers') }] : []),
    ...(smarter ? [{ id: smarter.id, model: smarter.model, label: t('Smarter'), hint: t('Better answers, bigger download') }] : []),
  ];
}

const size = (c: Choice, s: Welcome) => (c.id === s.modelId ? s.totalBytes : c.model.downloadMB * MB);

export function FirstRun({ s }: { s: Welcome }) {
  const [step, setStep] = useState(0);
  const [pick, setPick] = useState(s.modelId);
  const choices = firstRunChoices(s);
  const chosen = choices.find((c) => c.id === pick) ?? choices[0];

  async function go() {
    await setSetting('onboarded', true).catch(() => {});
    start(chosen.id);
  }

  return (
    <div class="boot-card first-run">
      <ol class="first-steps" aria-label={t('Step {n} of {total}', { n: step + 1, total: 3 })}>
        {[0, 1, 2].map((i) => <li class={i === step ? 'on' : i < step ? 'done' : ''} />)}
      </ol>

      {step === 0 && (
        <>
          <h2 class="first-title">{t('Your own AI, on this device')}</h2>
          <ul class="first-points">
            <li>
              <LockIcon />
              <span><strong>{t('Private by design.')}</strong> {t('The model runs here. Your conversations, documents and memories stay on this device.')}</span>
            </li>
            <li>
              <GlobeIcon />
              <span><strong>{t('Useful from the start.')}</strong> {t('It can search the web, check the weather, read your documents, run code and talk with you.')}</span>
            </li>
            <li>
              <BrainIcon />
              <span><strong>{t('Yours to shape.')}</strong> {t('It remembers what you choose, takes on roles you set up, and looks the way you like.')}</span>
            </li>
          </ul>
          <div class="boot-actions">
            <button class="btn btn-primary btn-lg" onClick={() => setStep(1)}>{t('Get started')}</button>
          </div>
        </>
      )}

      {step === 1 && (
        <>
          <h2 class="first-title">{t('Pick a model')}</h2>
          <p class="muted small">
            {t('It’s downloaded once and then starts straight from this device, even offline. You can switch anytime in Settings → Model.')}
          </p>
          <div class="first-models" role="radiogroup" aria-label={t('Model')}>
            {choices.map((c) => (
              <button class={c.id === pick ? 'first-model on' : 'first-model'} role="radio" aria-checked={c.id === pick} onClick={() => setPick(c.id)}>
                <span class="first-model-head">
                  <span class="eyebrow">{c.label}</span>
                  {c.id === pick && <CheckIcon />}
                </span>
                <strong>{c.model.displayName}</strong>
                <span class="muted small">
                  {[c.model.params && t('{params} parameters', { params: c.model.params }), fmtBytes(size(c, s)), c.model.reasoning && t('thinks'), c.model.vision && t('reads images')].filter(Boolean).join(' · ')}
                </span>
                <span class="muted small">{c.hint}</span>
              </button>
            ))}
          </div>
          {s.metered && <p class="notice">{t('You seem to be on cellular or data saver. Wi-Fi is recommended.')}</p>}
          <div class="boot-actions">
            <button class="btn btn-primary btn-lg" onClick={() => setStep(2)}>{t('Continue')}</button>
            <button class="btn btn-ghost" onClick={() => setStep(0)}>{t('Back')}</button>
          </div>
        </>
      )}

      {step === 2 && <Choices chosen={chosen} bytes={size(chosen, s)} onBack={() => setStep(1)} onGo={go} />}
    </div>
  );
}

function Choices({ chosen, bytes, onBack, onGo }: { chosen: Choice; bytes: number; onBack: () => void; onGo: () => void }) {
  const tools = useEnabledTools();
  const look = useAppearance();
  const [memory, setMemory] = useState(true);
  const webOn = WEB_TOOLS.some((n) => tools.isOn(n));
  const modes: [Appearance['mode'], string][] = [['system', t('System')], ['light', t('Light')], ['dark', t('Dark')]];

  return (
    <>
      <h2 class="first-title">{t('A few choices')}</h2>
      <p class="muted small">{t('All of these can be changed later in Settings.')}</p>
      <label class="switch-row">
        <span>
          <strong>{t('Web tools')}</strong>
          <span class="muted small">{t('Search, news, weather, currency, dictionary. Only the query is sent, never your conversation; Settings → Network shows each request.')}</span>
        </span>
        <input type="checkbox" class="switch" checked={webOn} disabled={!tools.ready} onChange={(e) => setToolsEnabled(WEB_TOOLS, e.currentTarget.checked)} />
      </label>
      <label class="switch-row">
        <span>
          <strong>{t('Memory')}</strong>
          <span class="muted small">{t('Notes lasting facts you share (your name, your projects…), with an Undo each time.')}</span>
        </span>
        <input type="checkbox" class="switch" checked={memory} onChange={(e) => { setMemory(e.currentTarget.checked); setSetting('autoMemory', e.currentTarget.checked).catch(() => {}); }} />
      </label>
      <div class="look-row">
        <span class="look-label"><strong>{t('Appearance')}</strong></span>
        <div class="seg" role="radiogroup">
          {modes.map(([v, label]) => (
            <button class={look.mode === v ? 'seg-btn on' : 'seg-btn'} role="radio" aria-checked={look.mode === v} onClick={() => setAppearance({ mode: v })}>{label}</button>
          ))}
        </div>
      </div>
      <div class="boot-actions">
        <button class="btn btn-primary btn-lg" onClick={onGo}>{t('Download {model} · {size}', { model: chosen.model.displayName, size: fmtBytes(bytes) })}</button>
        <button class="btn btn-ghost" onClick={onBack}>{t('Back')}</button>
      </div>
      <p class="fine">{t('Downloaded from Hugging Face, the models’ publisher page. Safe to close: it resumes next time.')}</p>
    </>
  );
}

const TIPS = [
  t('Ask “What’s the weather in Lisbon this weekend?” and it checks a forecast service.'),
  t('Attach a PDF with the paperclip, then ask questions about it.'),
  t('Tap the microphone to dictate, or start voice mode for a hands-free conversation.'),
  t('Ask it to plot something: it writes and runs Python, and shows the chart.'),
  t('Tell it about yourself once (“I’m vegetarian”) and it will remember, with an Undo.'),
  t('Tap the name at the top of the chat to set up assistants: a Tutor, a Code helper… each with its own instructions.'),
  t('Settings → Network lists everything that went online, request by request.'),
  t('Settings → Appearance: eight themes or any colour, light, dark or pure black.'),
];

/** Things to try, while the first download runs. */
export function Tips() {
  const [i, setI] = useState(() => Math.floor(Math.random() * TIPS.length));
  useEffect(() => {
    const t = setInterval(() => setI((n) => (n + 1) % TIPS.length), 7000);
    return () => clearInterval(t);
  }, []);
  return (
    <div class="first-tip" aria-live="polite">
      <span class="eyebrow">{t('While you wait')}</span>
      <p key={i}>{TIPS[i]}</p>
    </div>
  );
}
