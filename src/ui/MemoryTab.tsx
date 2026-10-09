// Settings → Memory: what the assistant remembers about the user, and how.
import { useEffect, useState } from 'preact/hooks';
import { getSetting, setSetting } from '../db';
import { addMemory, clearMemories, deleteMemory, untilLabel, updateMemory, useMemories, type Memory } from '../memory/memory';
import { CloseIcon, EditIcon, PinIcon } from './icons';
import { locale, t, tn } from '../i18n/i18n';

const day = (ts: number) => new Date(ts).toLocaleDateString(locale, { month: 'short', day: 'numeric', year: 'numeric' });

export function MemoryTab() {
  const list = useMemories();
  const [auto, setAuto] = useState(true);
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState('');
  useEffect(() => {
    getSetting('autoMemory').then((v) => setAuto(v ?? true), () => {});
  }, []);

  if (!list) return <p class="muted small">{t('Loading…')}</p>;
  const q = query.trim().toLowerCase();
  const shown = q ? list.filter((m) => m.text.toLowerCase().includes(q)) : list;
  const pinned = shown.filter((m) => m.pinned);
  const others = shown.filter((m) => !m.pinned);

  async function add() {
    if (!draft.trim()) return;
    await addMemory(draft);
    setDraft('');
  }

  return (
    <>
      <p class="muted small">
        {t('What the assistant knows about you, kept on this device only. Pinned memories are part of every conversation; the others are used when they relate to what you ask, by meaning (with a small search model, 23 MB, downloaded once). Temporary things, like a trip next week, are forgotten after two weeks, and a fact that changes replaces the old one.')}
      </p>
      <label class="switch-row">
        <span>
          <strong>{t('Save memories automatically')}</strong>
          <span class="muted small">
            {t('After you mention something lasting about yourself (your name, where you live, a preference), the assistant notes it. A “Memory updated” line in the chat lets you undo it.')}
            {' '}{t('Needs a model of 2B parameters or more: smaller ones save only what you ask them to remember.')}
          </span>
        </span>
        <input
          type="checkbox"
          class="switch"
          checked={auto}
          onChange={(e) => {
            setAuto(e.currentTarget.checked);
            setSetting('autoMemory', e.currentTarget.checked);
          }}
        />
      </label>

      <div class="section">
        <div class="row spread">
          <h3>{list.length ? tn(list.length, '{n} memory', '{n} memories') : t('Nothing remembered yet')}</h3>
          {list.length > 1 && (
            <button class="btn btn-sm btn-ghost" onClick={() => confirm(t('Forget everything the assistant remembers about you?')) && clearMemories()}>
              {t('Forget all')}
            </button>
          )}
        </div>
        {list.length > 5 && (
          <input class="search-input" type="search" placeholder={t('Search memories')} value={query} onInput={(e) => setQuery(e.currentTarget.value)} />
        )}
        {!list.length && (
          <p class="small muted">{t('Tell the assistant about yourself, or ask it to “remember” something.')}</p>
        )}
        {pinned.length > 0 && <MemoryList items={pinned} />}
        {others.length > 0 && <MemoryList items={others} />}
        {q && !shown.length && <p class="small muted">{t('No memory matches “{query}”.', { query })}</p>}
        <form class="row" onSubmit={(e) => { e.preventDefault(); add(); }}>
          <input class="search-input grow" placeholder={t('Add a memory, e.g. I’m vegetarian')} value={draft} onInput={(e) => setDraft(e.currentTarget.value)} />
          <button class="btn btn-sm" type="submit" disabled={!draft.trim()}>{t('Add')}</button>
        </form>
      </div>
    </>
  );
}

function MemoryList({ items }: { items: Memory[] }) {
  return (
    <ul class="memories">
      {items.map((m) => <MemoryItem key={m.id} m={m} />)}
    </ul>
  );
}

function MemoryItem({ m }: { m: Memory }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(m.text);
  const origin = [
    m.auto ? t('Saved automatically') : t('Saved on request'),
    day(m.updatedAt),
    m.until && t('forgotten after {date}', { date: untilLabel(m) }),
    m.source?.title && t('from “{title}”', { title: m.source.title }),
  ].filter(Boolean).join(' · ');

  if (editing) {
    const save = async () => {
      if (text.trim() && text.trim() !== m.text) await updateMemory(m.id, { text });
      setEditing(false);
    };
    return (
      <li class="memory editing">
        <textarea
          value={text}
          rows={2}
          onInput={(e) => setText(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); save(); }
            if (e.key === 'Escape') { setText(m.text); setEditing(false); }
          }}
          ref={(el) => el?.focus()}
        />
        <div class="row">
          <button class="btn btn-sm btn-ghost" onClick={() => { setText(m.text); setEditing(false); }}>{t('Cancel')}</button>
          <button class="btn btn-sm btn-primary" disabled={!text.trim()} onClick={save}>{t('Save')}</button>
        </div>
      </li>
    );
  }
  return (
    <li class={m.pinned ? 'memory pinned' : 'memory'}>
      <div class="memory-body">
        <span>{m.text}</span>
        <span class="muted small">{origin}</span>
      </div>
      <button
        class={m.pinned ? 'icon-btn on' : 'icon-btn'}
        aria-pressed={!!m.pinned}
        aria-label={m.pinned ? t('Unpin') : t('Pin: always include it')}
        title={m.pinned ? t('Pinned: in every conversation. Click to unpin.') : t('Pin: include it in every conversation')}
        onClick={() => updateMemory(m.id, { pinned: !m.pinned })}
      >
        <PinIcon />
      </button>
      <button class="icon-btn" aria-label={t('Edit')} title={t('Edit')} onClick={() => setEditing(true)}><EditIcon /></button>
      <button class="icon-btn" aria-label={t('Forget this')} title={t('Forget')} onClick={() => deleteMemory(m.id)}><CloseIcon /></button>
    </li>
  );
}
