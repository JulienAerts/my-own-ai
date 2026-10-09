// Copy to the clipboard, with a check mark for a moment afterwards.
import { useState } from 'preact/hooks';
import { CheckIcon, CopyIcon } from './icons';
import { t } from '../i18n/i18n';

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Older browsers, or a page without clipboard permission.
    const ta = Object.assign(document.createElement('textarea'), { value: text });
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

export function CopyButton({ text, label = t('Copy') }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      class="act"
      onClick={async () => {
        if (await copyText(text)) {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        }
      }}
      aria-label={done ? t('Copied') : label}
      title={done ? t('Copied') : label}
    >
      {done ? <CheckIcon /> : <CopyIcon />}
    </button>
  );
}
