import { useEffect, useRef, useState } from 'preact/hooks';
import { deleteChat, listConversations, type ConversationMeta } from '../db';
import { CloseIcon, DownloadIcon, NewChatIcon, TrashIcon } from './icons';
import { exportMarkdown } from '../backup';
import { DEFAULT_ASSISTANT, assistantById, useAssistants } from '../assistants/assistants';
import { locale, t, tn } from '../i18n/i18n';
import { openDialog } from './format';

const DAY = 86_400_000;

function group(ts: number): string {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const start = today.getTime();
  if (ts >= start) return t('Today');
  if (ts >= start - DAY) return t('Yesterday');
  if (ts >= start - 7 * DAY) return t('Previous 7 days');
  if (ts >= start - 30 * DAY) return t('Previous 30 days');
  return t('Older');
}

function when(ts: number): string {
  const d = new Date(ts);
  return Date.now() - ts < DAY
    ? d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString(locale, { day: 'numeric', month: 'short' });
}

/** Saved conversations: open one, start a new one, or delete. */
export function HistoryPanel({ open, onClose, currentId, busy, onOpen, onNew }: {
  open: boolean;
  onClose: () => void;
  currentId: string;
  /** A reply is being generated: switching is disabled until it ends. */
  busy: boolean;
  onOpen: (id: string) => void;
  onNew: () => void;
}) {
  useAssistants(); // names and emojis in the list
  const ref = useRef<HTMLDialogElement>(null);
  const [items, setItems] = useState<ConversationMeta[] | null>(null);
  const [query, setQuery] = useState('');

  useEffect(() => {
    const d = ref.current!;
    if (open && !d.open) {
      setQuery('');
      listConversations().then(setItems, () => setItems([]));
      openDialog(d);
    } else if (!open && d.open) d.close();
  }, [open]);

  async function remove(c: ConversationMeta) {
    if (!confirm(t('Delete “{title}”?', { title: c.title }))) return;
    await deleteChat(c.id);
    setItems((xs) => xs?.filter((x) => x.id !== c.id) ?? null);
    if (c.id === currentId) onNew();
  }

  const q = query.trim().toLowerCase();
  const shown = (items ?? []).filter((c) => !q || c.title.toLowerCase().includes(q));
  let lastGroup = '';

  return (
    <dialog
      ref={ref}
      class="sheet drawer"
      onClose={onClose}
      onClick={(e) => e.target === ref.current && onClose()}
      aria-labelledby="history-title"
    >
      <div class="sheet-body">
        <header class="sheet-head">
          <h2 id="history-title">{t('Conversations')}</h2>
          <button class="icon-btn" onClick={onClose} aria-label={t('Close')}><CloseIcon /></button>
        </header>
        <div class="history-tools">
          <button class="btn btn-primary" disabled={busy} onClick={() => { onNew(); onClose(); }}>
            <NewChatIcon /> {t('New conversation')}
          </button>
          {(items?.length ?? 0) > 4 && (
            <input
              class="search-input"
              type="search"
              placeholder={t('Search conversations')}
              value={query}
              onInput={(e) => setQuery(e.currentTarget.value)}
            />
          )}
        </div>
        <div class="sheet-content history-list">
          {items === null && <p class="muted small">{t('Loading…')}</p>}
          {items?.length === 0 && <p class="muted small">{t('No saved conversations yet. They appear here after your first message.')}</p>}
          {items && items.length > 0 && shown.length === 0 && <p class="muted small">{t('No conversation matches “{query}”.', { query })}</p>}
          {busy && <p class="notice">{t('Wait for the current answer to finish to switch conversations.')}</p>}
          {shown.map((c) => {
            const g = group(c.updatedAt);
            const header = g !== lastGroup ? <h3 class="history-group">{g}</h3> : null;
            lastGroup = g;
            return (
              <>
                {header}
                <div class={c.id === currentId ? 'history-item current' : 'history-item'}>
                  <button class="history-open" disabled={busy} onClick={() => { onOpen(c.id); onClose(); }}>
                    <span class="history-title">{c.title}</span>
                    <span class="muted small">
                      {c.assistantId && assistantById(c.assistantId).id !== DEFAULT_ASSISTANT.id && `${assistantById(c.assistantId).appLogo ? '' : `${assistantById(c.assistantId).emoji} `}${assistantById(c.assistantId).name} · `}
                      {when(c.updatedAt)} · {tn(c.messages, '{n} message', '{n} messages')}
                    </span>
                  </button>
                  <button class="icon-btn" onClick={() => exportMarkdown(c)} aria-label={t('Save {title} as Markdown', { title: c.title })} title={t('Save as Markdown')}>
                    <DownloadIcon />
                  </button>
                  <button class="icon-btn" disabled={busy && c.id === currentId} onClick={() => remove(c)} aria-label={t('Delete {name}', { name: c.title })} title={t('Delete')}>
                    <TrashIcon />
                  </button>
                </div>
              </>
            );
          })}
        </div>
      </div>
    </dialog>
  );
}
