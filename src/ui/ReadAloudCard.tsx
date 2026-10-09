import { PIPER_VOICES } from '../ttsVoices';
import { deleteVoice, downloadVoice, setTtsPrefs, speakText, useDeviceVoices, useTts } from '../tts';
import { fmtBytes } from './format';
import { CheckIcon, SpeakerIcon, StopIcon } from './icons';
import { lang, num, t } from '../i18n/i18n';

/** The preview sentence in the voice's own language. */
const SAMPLES: Record<string, string> = {
  en: 'Hi! I’m your local assistant. This is how I sound when I read my answers aloud.',
  fr: 'Bonjour ! Je suis votre assistant local. Voici ma voix quand je lis mes réponses à voix haute.',
};
const sample = (voiceLang: string) => SAMPLES[voiceLang.toLowerCase().split(/[-_]/)[0]] ?? SAMPLES[lang] ?? SAMPLES.en;
// Voices in the interface's language first.
const VOICES = [...PIPER_VOICES].sort((a, b) => Number(b.lang === lang) - Number(a.lang === lang));
const RATES = [0.8, 1, 1.2, 1.5];

export function ReadAloudCard() {
  const s = useTts();
  const deviceVoices = useDeviceVoices();
  const hasSynth = typeof speechSynthesis !== 'undefined';

  function preview(voice: string, deviceVoice?: string) {
    const voiceLang = PIPER_VOICES.find((v) => v.id === voice)?.lang ?? deviceVoices.find((v) => v.voiceURI === deviceVoice)?.lang ?? lang;
    speakText(`preview-${voice}-${deviceVoice ?? ''}`, sample(voiceLang), { voice, deviceVoice });
  }

  const PreviewBtn = ({ voice, deviceVoice }: { voice: string; deviceVoice?: string }) => {
    const on = s.speaking === `preview-${voice}-${deviceVoice ?? ''}`;
    return (
      <button class="icon-btn" onClick={() => preview(voice, deviceVoice)} aria-label={on ? t('Stop preview') : t('Preview voice')} title={on ? t('Stop') : t('Preview')}>
        {on ? <StopIcon /> : <SpeakerIcon />}
      </button>
    );
  };

  return (
    <>
      <div class="feature">
        <div class="feature-icon"><SpeakerIcon /></div>
        <div>
          <h3>{t('Read aloud')}</h3>
          <p class="small muted">
            {t('Hear the answers. Tap the speaker under any answer, or turn on automatic reading. Speech is generated on this device, in English or French.')}
          </p>
        </div>
      </div>

      <div class="section">
        <label class="switch-row">
          <span>
            <strong>{t('Read answers aloud automatically')}</strong>
            <span class="muted small">{t('Starts with the first sentence while the answer is still being written.')}</span>
          </span>
          <input type="checkbox" class="switch" checked={s.auto} onChange={(e) => setTtsPrefs({ auto: e.currentTarget.checked })} />
        </label>
        <div class="row spread">
          <span class="small">{t('Speed')}</span>
          <div class="seg">
            {RATES.map((r) => (
              <button class={s.rate === r ? 'seg-btn on' : 'seg-btn'} onClick={() => setTtsPrefs({ rate: r })}>{num(r, r % 1 ? 1 : 0)}×</button>
            ))}
          </div>
        </div>
      </div>

      <div class="section">
        <h3>{t('Natural voices')}</h3>
        <p class="small muted">{t('Neural voices (Piper) that run on your processor, not the GPU, so they don’t slow down the chat model. About {size} each, downloaded once.', { size: fmtBytes(PIPER_VOICES[0].bytes) })}</p>
        {s.downloadError && <p class="alert small">{t('Download failed: {error}', { error: s.downloadError })}</p>}
        <ul class="voice-list">
          {VOICES.map((v) => {
            const installed = s.installed.includes(v.id);
            const dl = s.download?.id === v.id ? s.download : null;
            return (
              <li class={s.voice === v.id ? 'voice-item current' : 'voice-item'}>
                <div class="voice-info">
                  <strong>{v.label}</strong>
                  {s.voice === v.id && <span class="pill pill-ok"><CheckIcon /> {t('In use')}</span>}
                  <span class="muted small">{v.accent}</span>
                  {dl && <div class="bar"><div style={{ width: `${(dl.got / dl.total) * 100}%` }} /></div>}
                </div>
                <div class="voice-actions">
                  {installed && <PreviewBtn voice={v.id} />}
                  {installed && s.voice !== v.id && <button class="btn btn-sm btn-primary" onClick={() => setTtsPrefs({ voice: v.id })}>{t('Use')}</button>}
                  {installed && <button class="btn btn-sm btn-ghost" onClick={() => confirm(t('Delete the {voice} voice?', { voice: v.label })) && deleteVoice(v.id)}>{t('Delete')}</button>}
                  {!installed && (
                    <button class="btn btn-sm btn-primary" disabled={!!s.download} onClick={() => downloadVoice(v.id)}>
                      {dl ? `${Math.floor((dl.got / dl.total) * 100)}%` : t('Download')}
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </div>

      <div class="section">
        <h3>{t('Device voices')}</h3>
        {!hasSynth || deviceVoices.length === 0 ? (
          <p class="small muted">
            {t('This browser has no offline voices. Download a natural voice above. (Online voices are hidden because they send the text to a server.)')}
          </p>
        ) : (
          <>
            <p class="small muted">{t('Built into your system: no download, quality depends on the device. Online voices are hidden because they send the text to a server.')}</p>
            <ul class="voice-list">
              {deviceVoices.map((v) => {
                const current = s.voice === 'device' && (s.deviceVoice === v.voiceURI || (!s.deviceVoice && v === deviceVoices.find((x) => x.default) ) );
                return (
                  <li class={current ? 'voice-item current' : 'voice-item'}>
                    <div class="voice-info">
                      <strong>{v.name.replace(/^Microsoft |^Google /, '')}</strong>
                      {current && <span class="pill pill-ok"><CheckIcon /> {t('In use')}</span>}
                      <span class="muted small">{v.lang}</span>
                    </div>
                    <div class="voice-actions">
                      <PreviewBtn voice="device" deviceVoice={v.voiceURI} />
                      {!current && <button class="btn btn-sm btn-ghost" onClick={() => setTtsPrefs({ voice: 'device', deviceVoice: v.voiceURI })}>{t('Use')}</button>}
                    </div>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>
    </>
  );
}
