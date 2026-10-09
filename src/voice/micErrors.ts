// Turn a getUserMedia failure into an explanation the user can act on. The
// same error name covers different causes, so the site's permission state is
// checked too: on Android, "allowed for this site" plus NotAllowedError means
// Chrome itself (or the system microphone switch) is blocking the mic.
import { detectPlatform } from '../probe/device';
import { t } from '../i18n/i18n';

export interface MicProblem {
  title: string;
  steps: string[];
}

async function sitePermission(): Promise<PermissionState | undefined> {
  try {
    return (await navigator.permissions?.query({ name: 'microphone' as PermissionName }))?.state;
  } catch {
    return undefined; // Firefox and older Safari can't query the microphone
  }
}

export async function explainMicError(e: unknown): Promise<MicProblem> {
  const name = e instanceof DOMException || e instanceof Error ? e.name : '';
  const { isAndroid, isIOS, standalone } = detectPlatform();
  const browser = isIOS ? 'Safari' : 'Chrome';

  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    return {
      title: t('The microphone needs a secure (https) page.'),
      steps: [t('Open the app from its https:// address, or from localhost on this computer.')],
    };
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return { title: t('No microphone was found.'), steps: [t('Connect a microphone or headset, then try again.')] };
  }

  const systemSwitch = isAndroid
    ? t('Pull down the quick settings and make sure “Microphone access” is not turned off.')
    : isIOS ? t('Check Settings → Privacy & Security → Microphone.') : '';

  if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') {
    return {
      title: t('The microphone is unavailable right now.'),
      steps: [
        t('Close other apps that may be using it (calls, voice recorders, other tabs).'),
        ...(systemSwitch ? [systemSwitch] : []),
        t('Then try again.'),
      ],
    };
  }

  // NotAllowedError (or an unknown error): blocked for the site, or by the system.
  const site = await sitePermission();
  if (site === 'denied') {
    return {
      title: t('The microphone is blocked for this site.'),
      steps: isAndroid
        ? [t('Tap the icon left of the address bar (or ⋮ → ⓘ) → Permissions → Microphone → Allow.'), t('Reload the page and try again.')]
        : isIOS
          ? [t('Tap “aA” in the address bar → Website Settings → Microphone → Allow.'), t('Reload the page and try again.')]
          : [t('Click the icon left of the address bar → Site settings → Microphone → Allow.'), t('Reload the page and try again.')],
    };
  }
  if (isAndroid) {
    // The site is allowed (or asked), but Android refused Chrome itself.
    return {
      title: t('{browser} itself isn’t allowed to use the microphone.', { browser }),
      steps: [
        t('Open Android Settings → Apps → {browser} → Permissions → Microphone → “Allow only while using the app”.', { browser }),
        systemSwitch,
        standalone
          ? t('Close {browser} completely from the recent apps screen, reopen it (or the installed app) and try again.', { browser })
          : t('Close {browser} completely from the recent apps screen, reopen it and try again.', { browser }),
      ],
    };
  }
  if (isIOS) {
    return {
      title: t('Safari isn’t allowed to use the microphone.'),
      steps: [t('Settings → Apps → Safari → Microphone → Allow.'), systemSwitch, t('Then reload the page and try again.')],
    };
  }
  return {
    title: t('Microphone access was denied.'),
    steps: [
      t('Allow the microphone when the browser asks, or in the site settings (icon left of the address bar).'),
      t('Also check your system privacy settings allow this browser to use the microphone.'),
    ],
  };
}

/** One-line version for inline errors (dictation). */
export function micProblemText(p: MicProblem): string {
  return `${p.title} ${p.steps.map((s, i) => `${i + 1}. ${s}`).join(' ')}`;
}
