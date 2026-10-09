// Inline stroke icons (24×24 grid), sized by the parent's font size.
import type { ComponentChildren } from 'preact';
import { usePictures, useAppearance, type Appearance } from './appearance';

function Icon({ children, size = 20 }: { children: ComponentChildren; size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor"
      stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

export const GearIcon = () => (
  <Icon>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
  </Icon>
);

export const SendIcon = () => (
  <Icon><path d="M12 19V5M5 12l7-7 7 7" /></Icon>
);

export const StopIcon = () => (
  <Icon><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none" /></Icon>
);

export const MicIcon = () => (
  <Icon>
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
  </Icon>
);

export const CloseIcon = () => (
  <Icon><path d="M18 6 6 18M6 6l12 12" /></Icon>
);

export const NewChatIcon = () => (
  <Icon>
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
  </Icon>
);

export const ToolIcon = () => (
  <Icon size={14}>
    <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.8-3.8a6 6 0 0 1-7.9 7.9l-6.9 6.9a2.1 2.1 0 0 1-3-3l6.9-6.9a6 6 0 0 1 7.9-7.9z" />
  </Icon>
);

export const CameraIcon = () => (
  <Icon>
    <path d="M14.5 4h-5L7.5 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3.5z" />
    <circle cx="12" cy="13" r="3.5" />
  </Icon>
);

export const PaperclipIcon = () => (
  <Icon>
    <path d="m21.4 11.1-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5" />
  </Icon>
);

export const FileIcon = () => (
  <Icon size={20}>
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <path d="M14 2v6h6M8 13h8M8 17h5" />
  </Icon>
);

export const DownloadIcon = () => (
  <Icon size={18}>
    <path d="M12 3v12M7 10l5 5 5-5M5 21h14" />
  </Icon>
);

export const CopyIcon = () => (
  <Icon size={16}>
    <rect x="9" y="9" width="12" height="12" rx="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </Icon>
);

export const RetryIcon = () => (
  <Icon size={16}>
    <path d="M21 12a9 9 0 1 1-3-6.7L21 8" />
    <path d="M21 3v5h-5" />
  </Icon>
);

export const EditIcon = () => (
  <Icon size={16}>
    <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
  </Icon>
);

export const VoiceIcon = () => (
  <Icon>
    <path d="M4 10v4M8 6v12M12 3v18M16 7v10M20 10v4" />
  </Icon>
);

export const SpeakerIcon = () => (
  <Icon size={16}>
    <path d="M11 5 6 9H2v6h4l5 4z" />
    <path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14" />
  </Icon>
);

export const TrashIcon = () => (
  <Icon size={18}>
    <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6" />
  </Icon>
);

export const HistoryIcon = () => (
  <Icon>
    <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
    <path d="M3 3v5h5M12 7v5l3 2" />
  </Icon>
);

export const GlobeIcon = () => (
  <Icon size={14}>
    <circle cx="12" cy="12" r="10" />
    <path d="M2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20" />
  </Icon>
);

export const ChipIcon = () => (
  <Icon size={16}>
    <rect x="5" y="5" width="14" height="14" rx="2" />
    <path d="M9 9h6v6H9zM9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3" />
  </Icon>
);

export const LockIcon = () => (
  <Icon size={14}>
    <rect x="4" y="11" width="16" height="10" rx="2" />
    <path d="M8 11V7a4 4 0 0 1 8 0v4" />
  </Icon>
);

export const CheckIcon = () => (
  <Icon size={14}><path d="M20 6 9 17l-5-5" /></Icon>
);

/** The app mark: a soft gradient orb. `pulse` animates it while booting. */
/**
 * The app's logo, as chosen in Settings → Appearance: the orb, a swirling aurora,
 * a halo ring, an emoji, or the user's own picture.
 */
export function Orb({ size = 64, pulse = false, variant }: { size?: number; pulse?: boolean; variant?: Appearance['logo'] }) {
  const a = useAppearance();
  const pics = usePictures();
  const logo = variant ?? a.logo;
  const style = { width: `${size}px`, height: `${size}px` };
  const cls = (kind: string) => `orb orb-${kind}${pulse ? ' orb-pulse' : ''}`;
  if (logo === 'image' && pics.logo) return <img class={cls('image')} src={pics.logo} style={style} alt="" aria-hidden="true" />;
  if (logo === 'emoji') {
    return <div class={cls('emoji')} style={{ ...style, fontSize: `${Math.round(size * 0.82)}px` }} aria-hidden="true">{a.logoEmoji || '✨'}</div>;
  }
  return <div class={cls(logo === 'aurora' || logo === 'halo' ? logo : 'orb')} style={style} aria-hidden="true" />;
}

export const BulbIcon = () => (
  <Icon>
    <path d="M9 18h6M10 21h4" />
    <path d="M12 3a6 6 0 0 0-3.6 10.8c.7.5 1.1 1.3 1.1 2.2h5c0-.9.4-1.7 1.1-2.2A6 6 0 0 0 12 3z" />
  </Icon>
);

export const CodeIcon = () => (
  <Icon size={14}>
    <path d="m8 6-6 6 6 6M16 6l6 6-6 6" />
  </Icon>
);

export const BrainIcon = () => (
  <Icon size={15}>
    <path d="M9.5 3a3 3 0 0 0-3 3 3 3 0 0 0-2 5.2A3 3 0 0 0 6 16.5 3 3 0 0 0 9.5 21h.5V3z" />
    <path d="M14.5 3a3 3 0 0 1 3 3 3 3 0 0 1 2 5.2 3 3 0 0 1-1.5 5.3 3 3 0 0 1-3.5 4.5H14V3z" />
  </Icon>
);

export const PinIcon = () => (
  <Icon size={16}>
    <path d="M12 17v5M9 3h6l-1 6 3 3v2H7v-2l3-3z" />
  </Icon>
);

export const ChevronIcon = () => (
  <Icon size={16}>
    <path d="m6 9 6 6 6-6" />
  </Icon>
);

export const MoreIcon = () => (
  <Icon size={18}><circle cx="5" cy="12" r="1.4" fill="currentColor" /><circle cx="12" cy="12" r="1.4" fill="currentColor" /><circle cx="19" cy="12" r="1.4" fill="currentColor" /></Icon>
);
