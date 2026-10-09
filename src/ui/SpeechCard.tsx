import { useEffect, useState } from 'preact/hooks';
import { installStt, pauseStt, removeStt, setSttModel, sttEngine, useStt, type SttModel } from '../stt';
import { fmtBytes } from './format';
import { CheckIcon, MicIcon } from './icons';
import { num, t, tj, UNIT } from '../i18n/i18n';

export function SpeechCard() {
  const s = useStt();
  // Whisper on a desktop with an NVIDIA GPU, else the chosen model (Phonon-2 or Parakeet v3).
  const [kind, setKind] = useState<'whisper' | SttModel | null>(null);
  useEffect(() => { sttEngine().then(setKind); }, []);
  const whisper = kind === 'whisper';
  const choose = async (m: SttModel) => {
    setKind(m);
    await setSttModel(m);
  };
  const status = 'status' in s ? s.status : undefined;
  const partial = status && !status.complete && status.cachedBytes > 0;

  async function remove() {
    if (!confirm(t('Delete the speech model ({size}) from this device?', { size: fmtBytes(status?.cachedBytes) }))) return;
    await removeStt();
  }

  return (
    <>
      <div class="feature">
        <div class="feature-icon"><MicIcon /></div>
        <div>
          <h3>{t('Dictation')}</h3>
          {whisper ? (
            <p class="small muted">
              {tj('Speak instead of typing, in any of about 100 languages (detected automatically, French included). Your voice is transcribed on your GPU by {model} and never uploaded.', {
                model: <a href="https://github.com/ggml-org/whisper.cpp" target="_blank" rel="noopener">Whisper large-v3-turbo</a>,
              })}
            </p>
          ) : kind === 'parakeet3' ? (
            <p class="small muted">
              {tj('Speak instead of typing, in French, English and 23 other European languages (detected automatically). Your voice is transcribed on this device by {model} and never uploaded.', {
                model: <a href="https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3" target="_blank" rel="noopener">Parakeet TDT 0.6B v3</a>,
              })}
            </p>
          ) : (
            <p class="small muted">
              {tj('Speak instead of typing. Your voice is transcribed on this device by {model} and never uploaded. English only.', {
                model: <a href="https://huggingface.co/FermionResearch/Phonon-2" target="_blank" rel="noopener">Phonon-2</a>,
              })}
            </p>
          )}
        </div>
      </div>

      {kind && !whisper && (
        <div class="section">
          <div class="look-row">
            <span class="look-label"><strong>{t('Languages')}</strong></span>
            <div class="seg" role="radiogroup" aria-label={t('Languages')}>
              {([['parakeet3', t('25 languages')], ['phonon2', t('English only')]] as [SttModel, string][]).map(([m, label]) => (
                <button class={kind === m ? 'seg-btn on' : 'seg-btn'} role="radio" aria-checked={kind === m} disabled={s.kind === 'downloading'} onClick={() => kind !== m && choose(m)}>{label}</button>
              ))}
            </div>
          </div>
          <span class="small muted">
            {t('Phonon-2 is the most accurate for English; Parakeet v3 understands French, Spanish, German, Italian and more. Each is a separate download of about 670 MB.')}
          </span>
        </div>
      )}

      <div class="section">
        {s.kind === 'checking' && <p class="muted small">{t('Checking…')}</p>}
        {s.kind === 'downloading' && (
          <>
            <div class="bar-row">
              <span>{t('Downloading speech model')}</span>
              <span class="pct">{Math.floor((s.got / s.total) * 100)}%</span>
            </div>
            <div class="bar"><div style={{ width: `${(s.got / s.total) * 100}%` }} /></div>
            <p class="muted small">{t('{done} of {total}', { done: fmtBytes(s.got), total: fmtBytes(s.total) })}</p>
            <button class="btn btn-ghost" onClick={() => pauseStt()}>{t('Pause')}</button>
          </>
        )}
        {(s.kind === 'absent' || s.kind === 'paused' || s.kind === 'error') && (
          <>
            {s.kind === 'paused' && <p class="notice">{s.reason}</p>}
            {s.kind === 'error' && <p class="alert small">{t('Download failed: {error}', { error: s.message })}</p>}
            <dl class="kv">
              <dt>{partial ? t('Saved') : t('Download')}</dt>
              <dd>{partial ? t('{done} of {total}', { done: fmtBytes(s.status.cachedBytes), total: fmtBytes(s.status.totalBytes) }) : fmtBytes(s.status.totalBytes)}</dd>
              <dt>{t('Memory while in use')}</dt><dd>{whisper ? t('≈ 1 GB of GPU memory') : `≈ ${num(1.1, 1)} ${UNIT.GB}`}</dd>
            </dl>
            <div class="row">
              <button class="btn btn-primary" onClick={() => installStt()}>{partial ? t('Resume download') : t('Enable dictation')}</button>
              {partial && <button class="btn btn-ghost" onClick={remove}>{t('Delete')}</button>}
            </div>
          </>
        )}
        {s.kind === 'installed' && (
          <div class="row spread">
            <span class="pill pill-ok"><CheckIcon /> {t('Ready · {size}', { size: fmtBytes(s.status.totalBytes) })}</span>
            <button class="btn btn-sm btn-ghost" onClick={remove}>{t('Delete')}</button>
          </div>
        )}
        {s.kind === 'installed' && (
          <p class="small muted">{t('Tap the microphone in the message bar, speak, then tap again to stop.')}</p>
        )}
      </div>

      {!whisper && (
        <p class="fine">
          {kind === 'parakeet3'
            ? t('Parakeet TDT 0.6B v3 by NVIDIA; ONNX export by istupakov (onnx-asr). CC BY 4.0.')
            : t('Phonon-2 by Fermion Research, derived from NVIDIA Parakeet TDT 0.6B v3; ONNX export by tiyuvta. CC BY 4.0.')}
        </p>
      )}
    </>
  );
}
