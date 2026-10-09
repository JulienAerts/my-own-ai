import { useEffect, useRef, useState } from 'preact/hooks';
import { preloadStt, toMono16k, transcribe, useStt } from '../stt';
import { MicIcon, StopIcon } from './icons';
import { explainMicError, micProblemText } from '../voice/micErrors';
import { t } from '../i18n/i18n';

type MicState = 'idle' | 'recording' | 'transcribing';

/**
 * Tap to record, tap again to transcribe into the composer. Hidden until the
 * speech model is installed (Settings → Speech recognition).
 */
export function Mic({ disabled, onText, onError }: {
  disabled: boolean;
  onText: (text: string) => void;
  onError: (msg: string) => void;
}) {
  const stt = useStt();
  const [mic, setMic] = useState<MicState>('idle');
  const rec = useRef<MediaRecorder | null>(null);

  // Leaving the page releases the microphone.
  useEffect(() => () => stopTracks(), []);

  function stopTracks() {
    rec.current?.stream.getTracks().forEach((t) => t.stop());
  }

  async function start() {
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
    } catch (e) {
      return onError(micProblemText(await explainMicError(e)));
    }
    // Warm the model while the user speaks.
    preloadStt().catch(() => {});
    const chunks: Blob[] = [];
    const r = new MediaRecorder(stream);
    r.ondataavailable = (ev) => ev.data.size && chunks.push(ev.data);
    r.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      setMic('transcribing');
      try {
        const audio = await toMono16k(new Blob(chunks, { type: r.mimeType }));
        const { text } = await transcribe(audio);
        if (text) onText(text);
        else onError(t('No speech recognized. Try again, a little closer to the microphone.'));
      } catch (e) {
        onError(t('Speech recognition failed: {error}', { error: e instanceof Error ? e.message : String(e) }));
      } finally {
        setMic('idle');
      }
    };
    rec.current = r;
    r.start();
    setMic('recording');
  }

  if (stt.kind !== 'installed' || !navigator.mediaDevices?.getUserMedia) return null;

  return mic === 'recording' ? (
    <button type="button" class="icon-btn mic-rec" onClick={() => rec.current?.stop()} aria-label={t('Stop recording')} title={t('Stop and transcribe')}>
      <StopIcon />
    </button>
  ) : (
    <button
      type="button"
      class={mic === 'transcribing' ? 'icon-btn mic-busy' : 'icon-btn'}
      disabled={disabled || mic === 'transcribing'}
      onClick={start}
      aria-label={mic === 'transcribing' ? t('Transcribing') : t('Dictate')}
      title={mic === 'transcribing' ? t('Transcribing…') : t('Dictate')}
    >
      {mic === 'transcribing' ? <span class="spinner" /> : <MicIcon />}
    </button>
  );
}
