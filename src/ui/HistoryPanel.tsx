import { useEffect, useRef, useState } from 'preact/hooks';
import { allChats, deleteChat, listConversations, updateConversation, type ConversationMeta } from '../db';
import type { ChatEntry } from '../agent/dialects';
import { CloseIcon, MoreIcon, NewChatIcon, PinIcon } from './icons';
import { exportMarkdown } from '../backup';
import { searchConversations, type SearchHit } from '../search';
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

/** Saved conversations: open, search (inside the messages too), rename, pin, save or delete. */
export function HistoryPanel({ open, onClose, onClosed, currentId, busy, onOpen, onNew }: {
  open: boolean;
  onClose: () => void;
  /** After the panel has closed (and the browser has given focus back to what opened it). */
  onClosed?: () => void;
  currentId: string;
  /** A reply is being generated: switching is disabled until it ends. */
  busy: boolean;
  /** `ts`: the message to show (a search result). */
  onOpen: (id: string, ts?: number) => void;
  onNew: () => void;
}) {
  useAssistants(); // names and emojis in the list
  const ref = useRef<HTMLDialogElement>(null);
  const [items, setItems] = useState<ConversationMeta[] | null>(null);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  // Every conversation's messages, loaded on the first search while the panel is open.
  const chats = useRef<Map<string, ChatEntry[]> | null>(null);

  useEffect(() => {
    const d = ref.current!;
    if (open && !d.open) {
      setQuery('');
      setHits(null);
      setMenu(null);
      setRenaming(null);
      chats.current = null;
      listConversations().then(setItems, () => setItems([]));
      openDialog(d);
    } else if (!open && d.open) d.close();
  }, [open]);

  // Search as the user types (briefly debounced).
  useEffect(() => {
    if (!query.trim() || !items) {
      setHits(null);
      return;
    }
    let live = true;
    const timer = setTimeout(async () => {
      chats.current ??= await allChats();
      if (live) setHits(searchConversations(query, items, chats.current));
    }, 120);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [query, items]);

  const replace = (m: ConversationMeta) => setItems((xs) => xs?.map((x) => (x.id === m.id ? m : x)) ?? null);

  async function remove(c: ConversationMeta) {
    if (!confirm(t('Delete “{title}”?', { title: c.title }))) return;
    await deleteChat(c.id);
    chats.current?.delete(c.id);
    setItems((xs) => xs?.filter((x) => x.id !== c.id) ?? null);
    if (c.id === currentId) onNew();
  }

  async function pin(c: ConversationMeta) {
    const m = await updateConversation(c.id, { pinned: !c.pinned });
    if (m) replace(m);
  }

  async function rename(c: ConversationMeta, title: string) {
    setRenaming(null);
    if (title.trim() === c.title) return;
    const m = await updateConversation(c.id, { title });
    if (m) replace(m);
  }

  function row(c: ConversationMeta, hit?: SearchHit) {
    const a = c.assistantId ? assistantById(c.assistantId) : DEFAULT_ASSISTANT;
    return (
      <div class={c.id === currentId ? 'history-item current' : 'history-item'} key={c.id}>
        {renaming === c.id ? (
          <RenameField title={c.title} onDone={(title) => (title === null ? setRenaming(null) : rename(c, title))} />
        ) : (
          <button class="history-open" disabled={busy} onClick={() => { onOpen(c.id, hit?.ts); onClose(); }}>
            <span class="history-title">
              {c.pinned && <span class="history-pin" title={t('Pinned')}><PinIcon /></span>}
              {c.title}
            </span>
            {hit && hit.snippet.length > 0 && (
              <span class="history-snippet small">
                {hit.snippet.map((p) => (p.hit ? <mark>{p.text}</mark> : p.text))}
              </span>
            )}
            <span class="muted small">
              {a.id !== DEFAULT_ASSISTANT.id && `${a.appLogo ? '' : `${a.emoji} `}${a.name} · `}
              {when(c.updatedAt)} · {tn(c.messages, '{n} message', '{n} messages')}
            </span>
          </button>
        )}
        {renaming !== c.id && (
          <RowMenu
            title={c.title}
            open={menu === c.id}
            onToggle={(o) => setMenu(o ? c.id : null)}
            items={[
              { label: t('Rename'), run: () => setRenaming(c.id) },
              { label: c.pinned ? t('Unpin') : t('Pin to the top'), run: () => pin(c) },
              { label: t('Save as Markdown'), run: () => exportMarkdown(c).catch((e) => alert(t('The conversation couldn’t be saved: {error}', { error: e instanceof Error ? e.message : String(e) }))) },
              { label: t('Delete'), run: () => remove(c), danger: true, disabled: busy && c.id === currentId },
            ]}
          />
        )}
      </div>
    );
  }

  const list = items ?? [];
  const pinned = list.filter((c) => c.pinned);
  let lastGroup = '';

  return (
    <dialog
      ref={ref}
      class="sheet drawer"
      onClose={() => {
        onClose();
        onClosed?.();
      }}
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
          {list.length > 0 && (
            <input
              class="search-input"
              type="search"
              placeholder={t('Search in all conversations')}
              aria-label={t('Search in all conversations')}
              value={query}
              onInput={(e) => setQuery(e.currentTarget.value)}
            />
          )}
        </div>
        <div class="sheet-content history-list">
          {items === null && <p class="muted small">{t('Loading…')}</p>}
          {items?.length === 0 && <p class="muted small">{t('No saved conversations yet. They appear here after your first message.')}</p>}
          {busy && <p class="notice">{t('Wait for the current answer to finish to switch conversations.')}</p>}
          {query.trim() ? (
            hits === null ? <p class="muted small">{t('Searching…')}</p>
              : hits.length === 0 ? <p class="muted small">{t('No conversation matches “{query}”.', { query: query.trim() })}</p>
                : (
                  <>
                    <p class="history-group" role="status">{tn(hits.length, '{n} conversation found', '{n} conversations found')}</p>
                    {hits.map((h) => row(list.find((c) => c.id === h.meta.id) ?? h.meta, h))}
                  </>
                )
          ) : (
            <>
              {pinned.length > 0 && <h3 class="history-group">{t('Pinned')}</h3>}
              {pinned.map((c) => row(c))}
              {list.filter((c) => !c.pinned).map((c) => {
                const g = group(c.updatedAt);
                const header = g !== lastGroup ? <h3 class="history-group">{g}</h3> : null;
                lastGroup = g;
                return <>{header}{row(c)}</>;
              })}
            </>
          )}
        </div>
      </div>
    </dialog>
  );
}

/** The title, editable: Enter or leaving the field saves, Escape cancels (`null`). */
function RenameField({ title, onDone }: { title: string; onDone: (title: string | null) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  const finish = (value: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(value);
  };
  return (
    <input
      ref={input}
      class="search-input history-rename"
      value={title}
      maxLength={120}
      aria-label={t('New name for the conversation (empty: automatic)')}
      onKeyDown={(e) => {
        if (e.key === 'Enter') finish(e.currentTarget.value);
        else if (e.key === 'Escape') {
          e.preventDefault(); // keeps the panel open
          e.stopPropagation();
          finish(null);
        }
      }}
      onBlur={(e) => finish(e.currentTarget.value)}
    />
  );
}

interface MenuItem {
  label: string;
  run: () => void;
  danger?: boolean;
  disabled?: boolean;
}

/** A conversation's actions behind "⋯": arrow keys move, Escape closes. */
function RowMenu({ title, open, onToggle, items }: { title: string; open: boolean; onToggle: (open: boolean) => void; items: MenuItem[] }) {
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);

  // Placed against the window (fixed), so the scrolling list can't clip it: under the button,
  // right-aligned, or above it when there's no room (rows near the bottom of a phone's sheet).
  // "Fixed" may be relative to a transformed ancestor (the sheet), so the menu is placed,
  // measured, then moved by the difference.
  useEffect(() => {
    const menu = list.current;
    if (!open || !menu) return;
    const b = button.current!.getBoundingClientRect();
    const want = (m: DOMRect) => ({
      left: Math.max(8, b.right - m.width),
      top: b.bottom + m.height + 8 > window.innerHeight ? b.top - m.height - 4 : b.bottom + 4,
    });
    menu.style.left = '0px';
    menu.style.top = '0px';
    const origin = menu.getBoundingClientRect();
    const target = want(origin);
    menu.style.left = `${target.left - origin.left}px`;
    menu.style.top = `${target.top - origin.top}px`;
    menu.style.visibility = 'visible';
    menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    const outside = (e: PointerEvent) => {
      if (!menu.contains(e.target as Node) && !button.current?.contains(e.target as Node)) onToggle(false);
    };
    const moved = (e: Event) => !menu.contains(e.target as Node) && onToggle(false);
    // Escape closes the menu, not the panel, wherever the focus is.
    const escape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      onToggle(false);
      button.current?.focus();
    };
    document.addEventListener('keydown', escape, true);
    document.addEventListener('pointerdown', outside);
    document.addEventListener('scroll', moved, true);
    window.addEventListener('resize', moved);
    return () => {
      document.removeEventListener('keydown', escape, true);
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('scroll', moved, true);
      window.removeEventListener('resize', moved);
    };
  }, [open]);

  function onKey(e: KeyboardEvent) {
    const buttons = [...(list.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      buttons[(at + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
    } else if (e.key === 'Tab') onToggle(false);
  }

  return (
    <div class="row-menu">
      <button
        ref={button}
        class="icon-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('Actions for {title}', { title })}
        title={t('More')}
        onClick={() => onToggle(!open)}
      >
        <MoreIcon />
      </button>
      {open && (
        <div ref={list} class="menu" role="menu" onKeyDown={onKey}>
          {items.map((it) => (
            <button
              role="menuitem"
              class={it.danger ? 'menu-item danger' : 'menu-item'}
              disabled={it.disabled}
              onClick={() => {
                onToggle(false);
                it.run();
              }}
            >
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
