import { useEffect, useRef, useState } from 'preact/hooks';
import { MicListener } from '../voice/listener';
import { explainMicError, type MicProblem } from '../voice/micErrors';
import { preloadStt, transcribe, useStt } from '../stt';
import { canSpeak, stopSpeaking, unlockAudio, useTts, whenSilent } from '../tts';
import { CloseIcon } from './icons';
import { t } from '../i18n/i18n';

type Phase = 'starting' | 'listening' | 'hearing' | 'transcribing' | 'thinking' | 'paused' | 'error';

const LABEL: Record<Phase, string> = {
  starting: t('Getting ready…'),
  listening: t('Listening'),
  hearing: t('Listening…'),
  transcribing: t('Got it'),
  thinking: t('Thinking'),
  paused: t('Paused · the microphone is off'),
  error: t('Something went wrong'),
};

/**
 * Hands-free conversation: listen → transcribe → answer (read aloud) → listen.
 * Nothing is recorded while an answer is being spoken, so it never hears itself.
 */
export function VoiceMode({ onAsk, onStop, onClose, onOpenSettings, answer }: {
  /** Send the text; resolves when the answer is complete. */
  onAsk(text: string): Promise<void>;
  /** Stop a generation in progress. */
  onStop(): void;
  onClose(): void;
  onOpenSettings(): void;
  /** The answer being written or last given, shown under the orb. */
  answer: string;
}) {
  const stt = useStt();
  const tts = useTts();
  const [phase, setPhase] = useState<Phase>('starting');
  const [heard, setHeard] = useState('');
  const [hint, setHint] = useState<string | null>(null);
  const [mute, setMute] = useState(false); // no offline voice: answers are only shown
  const [problem, setProblem] = useState<MicProblem | null>(null);
  // Bumped by "Try again" to restart the loop after fixing a permission.
  const [attempt, setAttempt] = useState(0);
  // Pause: stop listening (and release the mic) until resumed.
  const [paused, setPaused] = useState(false);
  const pause = useRef<{ on: boolean; listen: AbortController | null; resume: (() => void) | null; release: (() => void) | null }>(
    { on: false, listen: null, resume: null, release: null },
  );
  const level = useRef(0);
  const orb = useRef<HTMLDivElement>(null);
  const abort = useRef(new AbortController());
  // The loop outlives renders; always call the latest onAsk (it closes over the current messages).
  const ask = useRef(onAsk);
  ask.current = onAsk;

  const ready = stt.kind === 'installed';

  useEffect(() => {
    if (!ready) return;
    const ac = (abort.current = new AbortController());
    setProblem(null);
    setHint(null);
    setPhase('starting');
    const listener = new MicListener();
    pause.current.release = () => listener.close();
    let wake: WakeLockSentinel | null = null;
    const keepAwake = async () => {
      // A locked screen suspends the GPU mid-answer on phones.
      if (document.visibilityState === 'visible') wake = await navigator.wakeLock?.request('screen').catch(() => null) ?? null;
    };
    document.addEventListener('visibilitychange', keepAwake);

    (async () => {
      try {
        keepAwake();
        setMute(!(await canSpeak()));
        const stt = preloadStt();
        stt.catch(() => {}); // awaited below; don't report it as unhandled if the mic fails first
        try {
          await listener.open();
        } catch (e) {
          if (ac.signal.aborted) return;
          setProblem(await explainMicError(e));
          setPhase('error');
          return;
        }
        await stt;
        while (!ac.signal.aborted) {
          if (pause.current.on) {
            setPhase('paused');
            await new Promise<void>((r) => { pause.current.resume = r; });
            continue;
          }
          setPhase('listening');
          // Its own signal, so pausing cancels just this listen.
          const listening = new AbortController();
          pause.current.listen = listening;
          const stopListening = () => listening.abort();
          ac.signal.addEventListener('abort', stopListening);
          const audio = await listener.listen({
            signal: listening.signal,
            onLevel: (l) => { level.current = l; },
            onSpeech: () => { setPhase('hearing'); setHint(null); },
          });
          ac.signal.removeEventListener('abort', stopListening);
          level.current = 0;
          if (ac.signal.aborted) break;
          if (!audio) continue; // paused while listening
          setPhase('transcribing');
          const { text } = await transcribe(audio);
          if (ac.signal.aborted) break;
          if (!text.trim()) {
            setHint(t('I didn’t catch that. Try again.'));
            continue;
          }
          setHeard(text);
          setPhase('thinking');
          await ask.current(text);
          await whenSilent();
        }
      } catch (e) {
        if (ac.signal.aborted) return;
        setPhase('error');
        setHint(e instanceof Error ? e.message : String(e));
      }
    })();

    // Animate the orb from the input level without re-rendering.
    let raf = 0;
    const tick = () => {
      if (orb.current) orb.current.style.setProperty('--level', String(level.current));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      ac.abort();
      pause.current.resume?.(); // let a paused loop see the abort and exit
      cancelAnimationFrame(raf);
      listener.close();
      document.removeEventListener('visibilitychange', keepAwake);
      wake?.release().catch(() => {});
    };
  }, [ready, attempt]);

  function togglePause() {
    const p = pause.current;
    if (p.on) {
      p.on = false;
      setPaused(false);
      p.resume?.();
      p.resume = null;
    } else {
      p.on = true;
      setPaused(true);
      p.listen?.abort();
      p.release?.(); // reopened by the next listen()
    }
  }

  function end() {
    abort.current.abort();
    stopSpeaking();
    onStop();
    onClose();
  }

  // Tap the orb to cut the answer short and talk again.
  function tapOrb() {
    unlockAudio();
    if (tts.speaking) stopSpeaking();
  }

  const speaking = !!tts.speaking;
  const state = speaking ? 'speaking' : phase;
  const label = speaking ? t('Speaking · tap to interrupt') : problem ? t('Microphone unavailable') : LABEL[phase];

  return (
    <div class="voice" role="dialog" aria-label={t('Voice mode')} aria-modal="true">
      <button class="icon-btn voice-close" onClick={end} aria-label={t('End voice mode')}><CloseIcon /></button>
      {!ready ? (
        <div class="voice-setup">
          <h2>{t('Voice mode needs dictation')}</h2>
          <p class="muted">
            {t('Turn on dictation in Settings → Voice. It downloads the on-device speech recognizer once (about 700 MB).')}
          </p>
          <button class="btn btn-primary btn-lg" onClick={() => { onClose(); onOpenSettings(); }}>{t('Open voice settings')}</button>
        </div>
      ) : (
        <>
          <div class="voice-stage">
            <div ref={orb} class={`voice-orb ${state}`} onClick={tapOrb} role="button" aria-label={label} tabIndex={0} />
            <p class="voice-label" aria-live="polite">{label}</p>
            {hint && <p class="voice-hint">{hint}</p>}
            {problem && (
              <div class="voice-problem">
                <strong>{problem.title}</strong>
                <ol>{problem.steps.filter(Boolean).map((s) => <li>{s}</li>)}</ol>
                <button class="btn btn-primary" onClick={() => setAttempt((n) => n + 1)}>{t('Try again')}</button>
              </div>
            )}
          </div>
          <div class="voice-transcript">
            {heard && <p class="voice-you">“{heard}”</p>}
            {answer && state !== 'listening' && state !== 'hearing' && <p class="voice-answer">{answer}</p>}
            {mute && (
              <p class="voice-hint">
                {t('No offline voice is available, so answers are only shown.')}{' '}
                <button class="link" onClick={() => { end(); onOpenSettings(); }}>{t('Download a voice')}</button>
              </p>
            )}
          </div>
          <div class="vm-actions">
            <button class="btn btn-lg" onClick={togglePause} disabled={!!problem || phase === 'starting'}>
              {paused ? t('Resume') : t('Pause')}
            </button>
            <button class="btn btn-lg voice-end" onClick={end}>{t('End')}</button>
          </div>
        </>
      )}
    </div>
  );
}
