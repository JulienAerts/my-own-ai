import { useEffect, useState } from 'preact/hooks';
import { engine } from '../worker/client';
import type { GpuDiagnostics } from '../worker/engine.worker';
import { t, tn } from '../i18n/i18n';

/** GPU errors and limits recorded in the inference worker, for bug reports. */
export function GpuReport({ open = false }: { open?: boolean }) {
  const [d, setD] = useState<GpuDiagnostics | null>(null);
  useEffect(() => {
    engine().gpuDiagnostics().then(setD, () => {});
  }, []);
  if (!d) return null;
  return (
    <details class="gpu-report" open={open}>
      <summary>{t('GPU diagnostics ({summary})', { summary: d.errors.length ? tn(d.errors.length, '{n} error', '{n} errors') : t('no errors') })}</summary>
      {d.errors.length > 0 && <ol>{d.errors.map((e) => <li>{e}</li>)}</ol>}
      <ul class="muted">{d.limits.map((l) => <li>{l}</li>)}</ul>
    </details>
  );
}
