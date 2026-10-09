// Piper voices offered for download (rhasspy/piper-voices). Kept out of the
// worker so the UI can list them without loading the TTS runtime.
import { t } from './i18n/i18n';

export interface VoiceInfo {
  id: string;
  label: string;
  accent: string;
  /** Its language ("en", "fr"): French voices come first in a French interface. */
  lang: string;
  /** Path under the repo, without extension. */
  path: string;
  bytes: number;
}

export const PIPER_VOICES: VoiceInfo[] = [
  { id: 'fr_FR-siwis-medium', lang: 'fr', label: 'Siwis', accent: t('French, female'), path: 'fr/fr_FR/siwis/medium/fr_FR-siwis-medium', bytes: 63_201_294 },
  { id: 'fr_FR-tom-medium', lang: 'fr', label: 'Tom', accent: t('French, male'), path: 'fr/fr_FR/tom/medium/fr_FR-tom-medium', bytes: 63_511_038 },
  { id: 'en_US-lessac-medium', lang: 'en', label: 'Lessac', accent: t('US English, female'), path: 'en/en_US/lessac/medium/en_US-lessac-medium', bytes: 63_201_294 },
  { id: 'en_US-ryan-medium', lang: 'en', label: 'Ryan', accent: t('US English, male'), path: 'en/en_US/ryan/medium/en_US-ryan-medium', bytes: 63_201_294 },
  { id: 'en_GB-alba-medium', lang: 'en', label: 'Alba', accent: t('British English, female'), path: 'en/en_GB/alba/medium/en_GB-alba-medium', bytes: 63_201_294 },
  { id: 'en_GB-alan-medium', lang: 'en', label: 'Alan', accent: t('British English, male'), path: 'en/en_GB/alan/medium/en_GB-alan-medium', bytes: 63_201_294 },
];
