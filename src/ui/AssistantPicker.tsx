// Assistants: pick one to start a conversation with, or create and edit them.
import { useEffect, useRef, useState } from 'preact/hooks';
import {
  DEFAULT_ASSISTANT, TEMPLATES, deleteAssistant, saveAssistant, useAssistants, type Assistant,
} from '../assistants/assistants';
import { TOOLS } from '../agent/tools';
import { modelChoices } from '../boot';
import { ingest, listDocs, type DocInfo } from '../docs/store';
import { ACCEPT } from '../docs/extract';
import { CheckIcon, CloseIcon, EditIcon } from './icons';
import { t, tn } from '../i18n/i18n';
import { openDialog } from './format';
import { AssistantMark } from './AssistantMark';

type Draft = Omit<Assistant, 'id' | 'createdAt'> & { id?: string; createdAt?: number };

const BLANK: Draft = { name: '', emoji: '🤖', instructions: '', memory: 'shared', starters: [] };

export function AssistantPicker({ open, current, onClose, onPick }: {
  open: boolean;
  current: string;
  onClose(): void;
  /** Start a new conversation with this assistant. */
  onPick(id: string): void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const assistants = useAssistants();
  const [editing, setEditing] = useState<Draft | null>(null);
  const [choosing, setChoosing] = useState(false);

  useEffect(() => {
    const d = ref.current!;
    if (open && !d.open) {
      setEditing(null);
      setChoosing(false);
      openDialog(d);
    } else if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog ref={ref} class="sheet" onClose={onClose} onClick={(e) => e.target === ref.current && onClose()} aria-labelledby="assistants-title">
      <div class="sheet-body">
        <header class="sheet-head">
          <h2 id="assistants-title">{editing ? (editing.id ? t('Edit {name}', { name: editing.name }) : t('New assistant')) : choosing ? t('New assistant') : t('Assistants')}</h2>
          <button class="icon-btn" onClick={onClose} aria-label={t('Close')}><CloseIcon /></button>
        </header>
        <div class="sheet-content">
          {editing ? (
            <AssistantEditor draft={editing} onDone={() => { setEditing(null); setChoosing(false); }} />
          ) : choosing ? (
            <>
              <p class="muted small">{t('Start from a template, or from scratch. Everything can be changed later.')}</p>
              <ul class="assistant-list">
                <li>
                  <button class="assistant-item" onClick={() => setEditing({ ...BLANK })}>
                    <span class="assistant-emoji">➕</span>
                    <span class="assistant-info"><strong>{t('Blank')}</strong><span class="muted small">{t('Your own role and instructions')}</span></span>
                  </button>
                </li>
                {TEMPLATES.map((tpl) => (
                  <li>
                    <button class="assistant-item" onClick={() => setEditing({ ...tpl, starters: [...(tpl.starters ?? [])], tools: tpl.tools && [...tpl.tools] })}>
                      <span class="assistant-emoji">{tpl.emoji}</span>
                      <span class="assistant-info"><strong>{tpl.name}</strong><span class="muted small">{tpl.instructions.split('. ')[0]}.</span></span>
                    </button>
                  </li>
                ))}
              </ul>
              <button class="btn btn-sm btn-ghost" onClick={() => setChoosing(false)}>{t('Back')}</button>
            </>
          ) : (
            <>
              <p class="muted small">
                {t('Each assistant has its own role, tools, documents and memory. Pick one to start a new conversation with it.')}
              </p>
              <ul class="assistant-list">
                {assistants.map((a) => (
                  <li class={a.id === current ? 'current' : undefined}>
                    <button class="assistant-item" onClick={() => onPick(a.id)}>
                      <AssistantMark a={a} size={28} />
                      <span class="assistant-info">
                        <strong>{a.name}</strong>
                        <span class="muted small">{a.id === DEFAULT_ASSISTANT.id ? t('The all-round assistant, with your default tools') : summary(a)}</span>
                      </span>
                      {a.id === current && <span class="pill pill-ok"><CheckIcon /> {t('Current')}</span>}
                    </button>
                    {a.id !== DEFAULT_ASSISTANT.id && (
                      <button class="icon-btn" aria-label={t('Edit {name}', { name: a.name })} title={t('Edit')} onClick={() => setEditing({ ...a })}><EditIcon /></button>
                    )}
                  </li>
                ))}
              </ul>
              <button class="btn btn-primary" onClick={() => setChoosing(true)}>{t('New assistant')}</button>
            </>
          )}
        </div>
      </div>
    </dialog>
  );
}

function summary(a: Assistant): string {
  const bits = [
    a.instructions.split(/(?<=[.!?])\s/)[0]?.slice(0, 90),
    a.docIds?.length && tn(a.docIds.length, '{n} document', '{n} documents'),
    a.memory === 'own' && t('private memory'),
  ];
  return bits.filter(Boolean).join(' · ');
}

function AssistantEditor({ draft: initial, onDone }: { draft: Draft; onDone(): void }) {
  const [d, setD] = useState<Draft>(initial);
  const [docs, setDocs] = useState<DocInfo[] | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const set = (patch: Partial<Draft>) => setD((x) => ({ ...x, ...patch }));
  const models = modelChoices();
  const ownTools = !!d.tools;

  useEffect(() => { listDocs().then(setDocs, () => setDocs([])); }, []);

  async function addDocument(files: FileList | null) {
    const file = files?.[0];
    if (!file) return;
    setAdding(file.name);
    try {
      const doc = await ingest(file);
      setDocs(await listDocs());
      set({ docIds: [...(d.docIds ?? []), doc.id] });
    } catch (e) {
      alert(t('Couldn’t add {file}: {error}', { file: file.name, error: e instanceof Error ? e.message : String(e) }));
    } finally {
      setAdding(null);
    }
  }

  async function save() {
    await saveAssistant({
      ...d,
      name: d.name.trim(),
      emoji: d.emoji.trim() || '🤖',
      instructions: d.instructions.trim(),
      starters: (d.starters ?? []).map((s) => s.trim()).filter(Boolean).slice(0, 4),
    });
    onDone();
  }

  return (
    <form class="assistant-editor" onSubmit={(e) => { e.preventDefault(); if (d.name.trim()) save(); }}>
      <div class="row">
        {!d.appLogo && <input class="search-input emoji-input" aria-label={t('Emoji')} value={d.emoji} maxLength={8} onInput={(e) => set({ emoji: e.currentTarget.value })} />}
        <input class="search-input grow" placeholder={t('Name, e.g. French tutor')} value={d.name} onInput={(e) => set({ name: e.currentTarget.value })} required />
      </div>
      <label class="check">
        <input type="checkbox" checked={!!d.appLogo} onChange={(e) => set({ appLogo: e.currentTarget.checked || undefined })} />
        {t('Use the app’s logo instead of an emoji (Settings → Appearance)')}
      </label>

      <label class="field">
        <span>{t('Role and instructions')}</span>
        <textarea
          rows={5}
          placeholder={t('What it’s for and how it should answer, e.g. You help me practise French: answer in simple French and correct my mistakes.')}
          value={d.instructions}
          onInput={(e) => set({ instructions: e.currentTarget.value })}
        />
        <span class="small muted">{t('Your own instructions (Settings → App) still apply on top.')}</span>
      </label>

      <label class="field">
        <span>{t('Preferred model')}</span>
        <select class="search-input" value={d.modelId ?? ''} onChange={(e) => set({ modelId: e.currentTarget.value || undefined })}>
          <option value="">{t('Any (the one in use)')}</option>
          {models.map((m) => <option value={m.id}>{m.model.displayName}</option>)}
        </select>
        <span class="small muted">{t('The chat offers to switch to it; models aren’t swapped without asking.')}</span>
      </label>

      <fieldset class="field">
        <legend>{t('Tools')}</legend>
        <label class="check"><input type="radio" checked={!ownTools} onChange={() => set({ tools: undefined })} /> {t('My default tools (Settings → Tools)')}</label>
        <label class="check"><input type="radio" checked={ownTools} onChange={() => set({ tools: d.tools ?? [] })} /> {t('Only these:')}</label>
        {ownTools && (
          <div class="tool-checks">
            {TOOLS.map((tool) => (
              <label class="check">
                <input
                  type="checkbox"
                  checked={d.tools!.includes(tool.name)}
                  onChange={(e) => set({ tools: e.currentTarget.checked ? [...d.tools!, tool.name] : d.tools!.filter((n) => n !== tool.name) })}
                />
                {tool.label}
              </label>
            ))}
          </div>
        )}
      </fieldset>

      <fieldset class="field">
        <legend>{t('Knowledge')}</legend>
        <span class="small muted">{t('Documents this assistant can always search, in every conversation with it.')}</span>
        {docs === null ? <span class="small muted">{t('Loading…')}</span> : docs.length === 0 ? null : (
          <div class="tool-checks">
            {docs.map((doc) => (
              <label class="check">
                <input
                  type="checkbox"
                  checked={!!d.docIds?.includes(doc.id)}
                  onChange={(e) => set({ docIds: e.currentTarget.checked ? [...(d.docIds ?? []), doc.id] : (d.docIds ?? []).filter((x) => x !== doc.id) })}
                />
                {doc.name}
              </label>
            ))}
          </div>
        )}
        <label class="btn btn-sm file-btn">
          {adding ? t('Adding {file}…', { file: adding }) : t('Add a document')}
          <input type="file" accept={ACCEPT} hidden disabled={!!adding} onChange={(e) => addDocument(e.currentTarget.files)} />
        </label>
      </fieldset>

      <fieldset class="field">
        <legend>{t('Memory')}</legend>
        <label class="check"><input type="radio" checked={d.memory === 'shared'} onChange={() => set({ memory: 'shared' })} /> {t('Shared: it knows and learns what all assistants know')}</label>
        <label class="check"><input type="radio" checked={d.memory === 'own'} onChange={() => set({ memory: 'own' })} /> {t('Private: what it learns stays with it (it still sees shared memories)')}</label>
      </fieldset>

      <label class="field">
        <span>{t('Conversation starters')}</span>
        <textarea
          rows={3}
          placeholder={t('One per line, e.g.\nQuiz me on irregular verbs')}
          value={(d.starters ?? []).join('\n')}
          onInput={(e) => set({ starters: e.currentTarget.value.split('\n') })}
        />
      </label>

      <div class="row spread">
        {d.id ? (
          <button type="button" class="btn btn-sm btn-ghost danger" onClick={async () => {
            if (!confirm(t('Delete {name}? Its conversations stay, with the default assistant.', { name: d.name }))) return;
            await deleteAssistant(d.id!);
            onDone();
          }}>{t('Delete')}</button>
        ) : <span />}
        <div class="row">
          <button type="button" class="btn btn-sm btn-ghost" onClick={onDone}>{t('Cancel')}</button>
          <button type="submit" class="btn btn-sm btn-primary" disabled={!d.name.trim()}>{t('Save')}</button>
        </div>
      </div>
    </form>
  );
}
