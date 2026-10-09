// Hands-free listening for voice mode: keeps the microphone open and returns
// one utterance at a time, ended by silence. Voice activity detection is
// energy-based against an adaptive noise floor, which is enough for one
// person talking to their phone; the samples never leave the device.

const WINDOW_MS = 30;
const PRE_ROLL_MS = 300; // keep the start of the first word
const START_MS = 120; // loud this long to count as speech
const END_SILENCE_MS = 900; // quiet this long after speech ends the turn
const MAX_UTTERANCE_MS = 30_000;
const MIN_SPEECH_MS = 250;
const MIN_THRESHOLD = 0.012;

// Copies every 128-sample render quantum to the main thread.
const TAP = `registerProcessor('tap', class extends AudioWorkletProcessor {
  process(inputs) { const ch = inputs[0] && inputs[0][0]; if (ch) this.port.postMessage(ch.slice(0)); return true; }
});`;

export interface ListenOptions {
  /** 0..1 input level, ~30 times a second (for the orb). */
  onLevel?(level: number): void;
  /** Speech has started (so the UI can show "hearing you"). */
  onSpeech?(): void;
  signal?: AbortSignal;
}

export class MicListener {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: AudioWorkletNode | null = null;
  private onFrame: ((f: Float32Array) => void) | null = null;
  private floor = 0.004;

  async open(): Promise<void> {
    if (this.ctx) return;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    // The device's native rate; utterances are resampled to 16 kHz at the end
    // (some browsers refuse to mix rates between a stream and a context).
    this.ctx = new AudioContext();
    const url = URL.createObjectURL(new Blob([TAP], { type: 'text/javascript' }));
    try {
      await this.ctx.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    this.node = new AudioWorkletNode(this.ctx, 'tap');
    this.node.port.onmessage = (e) => this.onFrame?.(e.data as Float32Array);
    this.ctx.createMediaStreamSource(this.stream).connect(this.node);
  }

  /** Wait for one utterance; resolves with 16 kHz mono samples, or null if aborted. */
  async listen(opts: ListenOptions = {}): Promise<Float32Array | null> {
    await this.open();
    const ctx = this.ctx!;
    await ctx.resume();
    const rate = ctx.sampleRate;
    const winLen = Math.round((rate * WINDOW_MS) / 1000);
    const preRollWins = Math.ceil(PRE_ROLL_MS / WINDOW_MS);

    return new Promise((resolve) => {
      const pre: Float32Array[] = []; // ring of recent windows before speech
      const speech: Float32Array[] = [];
      let win = new Float32Array(winLen);
      let fill = 0;
      let loudMs = 0, quietMs = 0, speechMs = 0;
      let speaking = false;

      const done = (result: Float32Array[] | null) => {
        this.onFrame = null;
        opts.signal?.removeEventListener('abort', abort);
        if (!result) return resolve(null);
        resample(result, rate).then(resolve, () => resolve(null));
      };
      const abort = () => done(null);
      if (opts.signal?.aborted) return resolve(null);
      opts.signal?.addEventListener('abort', abort);

      const onWindow = (w: Float32Array) => {
        let sum = 0;
        for (let i = 0; i < w.length; i++) sum += w[i] * w[i];
        const rms = Math.sqrt(sum / w.length);
        const threshold = Math.max(MIN_THRESHOLD, this.floor * 3);
        opts.onLevel?.(Math.min(1, rms / (threshold * 4)));

        if (!speaking) {
          // Track background noise slowly while nobody speaks.
          this.floor = this.floor * 0.95 + Math.min(rms, threshold) * 0.05;
          pre.push(w);
          if (pre.length > preRollWins) pre.shift();
          loudMs = rms > threshold ? loudMs + WINDOW_MS : 0;
          if (loudMs >= START_MS) {
            speaking = true;
            speech.push(...pre);
            speechMs = loudMs;
            opts.onSpeech?.();
          }
          return;
        }
        speech.push(w);
        speechMs += WINDOW_MS;
        quietMs = rms > threshold * 0.7 ? 0 : quietMs + WINDOW_MS;
        if (quietMs >= END_SILENCE_MS || speechMs >= MAX_UTTERANCE_MS) {
          if (speechMs - quietMs < MIN_SPEECH_MS) {
            // A cough or a click: keep listening.
            speaking = false;
            speech.length = 0;
            loudMs = quietMs = speechMs = 0;
            return;
          }
          done(speech);
        }
      };

      this.onFrame = (frame) => {
        let i = 0;
        while (i < frame.length) {
          const n = Math.min(frame.length - i, winLen - fill);
          win.set(frame.subarray(i, i + n), fill);
          fill += n;
          i += n;
          if (fill === winLen) {
            onWindow(win);
            win = new Float32Array(winLen);
            fill = 0;
          }
        }
      };
    });
  }

  /** Release the microphone. */
  close(): void {
    this.onFrame = null;
    this.node?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.stream = null;
    this.node = null;
  }
}

async function resample(chunks: Float32Array[], rate: number): Promise<Float32Array> {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const joined = new Float32Array(total);
  let o = 0;
  for (const c of chunks) {
    joined.set(c, o);
    o += c.length;
  }
  if (rate === 16000) return joined;
  const off = new OfflineAudioContext(1, Math.ceil((total * 16000) / rate), 16000);
  const buf = off.createBuffer(1, total, rate);
  buf.copyToChannel(joined, 0);
  const src = off.createBufferSource();
  src.buffer = buf;
  src.connect(off.destination);
  src.start();
  return (await off.startRendering()).getChannelData(0).slice();
}
