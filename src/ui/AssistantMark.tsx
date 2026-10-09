// An assistant's mark: the app's logo (Settings → Appearance) for the built-in
// assistant and for others that chose it, else their emoji, shown full size.
import { DEFAULT_ASSISTANT, type Assistant } from '../assistants/assistants';
import { Orb } from './icons';

export function AssistantMark({ a, size }: { a: Pick<Assistant, 'id' | 'emoji' | 'appLogo'>; size: number }) {
  if (a.id === DEFAULT_ASSISTANT.id || a.appLogo) return <Orb size={size} />;
  return <span class="assistant-mark" style={{ fontSize: `${Math.round(size * 0.82)}px`, width: `${size}px`, height: `${size}px` }} aria-hidden="true">{a.emoji}</span>;
}
