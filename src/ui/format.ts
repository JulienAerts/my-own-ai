import { num, UNIT } from '../i18n/i18n';

const GB = 1024 ** 3;

export function fmtBytes(n?: number | null): string {
  if (n == null) return '—';
  return n >= GB ? `${num(n / GB, 1)} ${UNIT.GB}` : `${Math.round(n / 1024 ** 2)} ${UNIT.MB}`;
}

/**
 * Open a dialog without a focus ring on its first button: the browser focuses the close
 * button and, with no keyboard use yet, draws its ring. The dialog keeps focus instead,
 * so Tab still starts inside it and Escape closes it.
 */
export function openDialog(d: HTMLDialogElement) {
  d.showModal();
  d.tabIndex = -1;
  d.focus();
}
