import { useEffect, useRef, useState } from 'preact/hooks';
import { bootState, device, modelChoices, nativeGpu, refreshNativeModels, removeExtraModel, start, tooLargeModels, useBoot } from '../boot';
import { MoreModels } from './MoreModels';
import { GenerationSettings } from './GenerationSettings';
import { deleteNativeModel, isNativeModel, llamaStatus, nativeComplete, totalBytes } from '../native/backend';
import { removeCustomModel } from '../native/custom';
import { CustomGgufSection } from './CustomGgufSection';
import { nativeModels } from '../models';
import { getSetting, listConversations, setSetting } from '../db';
import { exportAll, importBackup } from '../backup';
import { listDocs, removeDoc, type DocInfo } from '../docs/store';
import { allModelIds, formatMB, modelById, safeBinding } from '../models';
import { freeStorage, probeStorage, type StorageReport } from '../probe/device';
import { usePwa, applyUpdate } from '../pwa';
import { engine } from '../worker/client';
import type { CacheStatus } from '../worker/engine.worker';
import { fmtBytes, openDialog } from './format';
import { issueUrl, reportBody } from '../report';
import { openExternal } from '../desktop/links';
import { CheckIcon, CloseIcon } from './icons';
import { InstallApp } from './InstallApp';
import { SpeechCard } from './SpeechCard';
import { ReadAloudCard } from './ReadAloudCard';
import { GpuReport } from './GpuReport';
import { TOOLS, type ToolDef } from '../agent/tools';
import { MemoryTab } from './MemoryTab';
import { AppearanceTab } from './AppearanceTab';
import { ConnectorsTab } from './ConnectorsTab';
import { NetworkTab } from './NetworkTab';
import { SkillsSection } from './SkillsSection';
import { DesktopSection } from './DesktopSection';
import { isDesktopApp } from '../native';
import { setToolsEnabled, useEnabledTools } from '../agent/toolPrefs';
import { DownloadIcon, GlobeIcon, ToolIcon } from './icons';
import { LANGUAGES, languageChoice, setLanguage, t, tj, tn, UNIT, type LangChoice } from '../i18n/i18n';

export type SettingsTab = 'model' | 'tools' | 'connectors' | 'look' | 'memory' | 'voice' | 'network' | 'app';
const TABS: { id: SettingsTab; label: string }[] = [
  { id: 'model', label: t('Model') },
  { id: 'tools', label: t('Tools') },
  // MCP connectors need the desktop app (local servers).
  ...(isDesktopApp ? [{ id: 'connectors' as const, label: t('Connectors') }] : []),
  { id: 'look', label: t('Appearance') },
  { id: 'memory', label: t('Memory') },
  { id: 'voice', label: t('Voice') },
  { id: 'network', label: t('Network') },
  { id: 'app', label: t('App') },
];

export function SettingsDialog({ open, onClose, initialTab = 'model', onDeleteAllChats }: {
  open: boolean;
  onClose: () => void;
  initialTab?: SettingsTab;
  onDeleteAllChats?: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [tab, setTab] = useState<SettingsTab>(initialTab);
  const tabsRef = useRef<HTMLDivElement>(null);

  // When the tabs don't all fit (phones): fade the edges that hide more, keep the open tab in view.
  function fadeTabs() {
    const el = tabsRef.current;
    if (!el) return;
    el.style.setProperty('--fade-l', el.scrollLeft > 2 ? '24px' : '0px');
    el.style.setProperty('--fade-r', el.scrollLeft + el.clientWidth < el.scrollWidth - 2 ? '24px' : '0px');
  }
  useEffect(() => {
    tabsRef.current?.querySelector<HTMLElement>('.tab.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    requestAnimationFrame(fadeTabs); // after the dialog has its size
  }, [tab, open]);
  useEffect(() => {
    const el = tabsRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(fadeTabs);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const d = ref.current!;
    if (open && !d.open) {
      setTab(initialTab);
      openDialog(d);
    } else if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      class="sheet settings"
      onClose={onClose}
      // A click on the backdrop lands on the <dialog> itself.
      onClick={(e) => e.target === ref.current && onClose()}
      aria-labelledby="settings-title"
    >
      <div class="sheet-body">
        <header class="sheet-head">
          <h2 id="settings-title">{t('Settings')}</h2>
          <button class="icon-btn" onClick={onClose} aria-label={t('Close settings')}><CloseIcon /></button>
        </header>
        {/* A row on phones (scrolls sideways, also with a mouse wheel), a column on wide screens. */}
        <div
          class="tabs"
          role="tablist"
          ref={tabsRef}
          onScroll={fadeTabs}
          onWheel={(e) => {
            const el = e.currentTarget;
            if (el.scrollWidth > el.clientWidth && Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
              el.scrollLeft += e.deltaY;
              e.preventDefault();
            }
          }}
          onKeyDown={(e) => {
            // Arrow keys move between sections, as in any tab list.
            const i = TABS.findIndex((x) => x.id === tab);
            const step = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 0;
            if (!step) return;
            e.preventDefault();
            const next = TABS[(i + step + TABS.length) % TABS.length];
            setTab(next.id);
            requestAnimationFrame(() => tabsRef.current?.querySelector<HTMLElement>('.tab.on')?.focus());
          }}
        >
          {TABS.map((t) => (
            <button role="tab" aria-selected={tab === t.id} tabIndex={tab === t.id ? 0 : -1} class={tab === t.id ? 'tab on' : 'tab'} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </div>
        <div class="sheet-content">
          {open && tab === 'model' && <ModelTab onClose={onClose} />}
          {open && tab === 'memory' && <MemoryTab />}
          {open && tab === 'look' && <AppearanceTab />}
          {open && tab === 'connectors' && <ConnectorsTab />}
          {open && tab === 'tools' && <ToolsTab />}
          {open && tab === 'voice' && <><ReadAloudCard /><SpeechCard /></>}
          {open && tab === 'network' && <NetworkTab />}
          {open && tab === 'app' && <AppTab onDeleteAllChats={onDeleteAllChats && (() => { onDeleteAllChats(); onClose(); })} />}
        </div>
      </div>
    </dialog>
  );
}

function ModelTab({ onClose }: { onClose: () => void }) {
  const boot = useBoot();
  const [statuses, setStatuses] = useState<Record<string, CacheStatus>>({});
  const [wifiOnly, setWifiOnly] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  // Bumped when models are added or removed (the list comes from module state).
  const [, setVersion] = useState(0);
  const choices = modelChoices();
  const current = 'modelId' in boot ? boot.modelId : undefined;
  const downloading = boot.kind === 'running' && boot.downloading;

  async function refresh() {
    const list = await engine().cacheStatuses(allModelIds()).catch(() => []);
    // llama.cpp models (desktop app): files in the app's models folder.
    const files = nativeModels().length ? (await llamaStatus().catch(() => null))?.models ?? [] : [];
    const native: CacheStatus[] = nativeModels().filter(isNativeModel).map((m) => {
      const size = (file?: string) => (file && files.find((f) => f.file === file)?.bytes) || 0;
      const bytes = size(m.gguf.file) + size(m.gguf.mmproj?.file);
      const complete = nativeComplete(m, { models: files });
      return { modelId: m.fixedId!, totalShards: 1, cachedShards: complete ? 1 : 0, totalBytes: totalBytes(m), cachedBytes: bytes, complete };
    });
    setStatuses(Object.fromEntries([...list, ...native].map((s) => [s.modelId, s])));
  }
  // Downloaded builds this device no longer uses (e.g. an f16 build replaced by f32).
  const others = Object.values(statuses).filter((s) => s.cachedShards > 0 && !choices.some((c) => c.id === s.modelId));

  useEffect(() => {
    refresh();
    getSetting('wifiOnly').then((v) => setWifiOnly(!!v));
  }, [boot.kind]);

  async function remove(id: string, name: string, bytes: number) {
    if (!confirm(t('Delete {name} ({size}) from this device?', { name, size: fmtBytes(bytes) }))) return;
    setBusy(id);
    try {
      const m = modelById(id);
      if (isNativeModel(m)) await deleteNativeModel(m);
      else await engine().remove(id);
    } finally {
      setBusy(null);
      refresh();
    }
  }

  async function removeAdded(id: string, name: string, installedBytes: number) {
    if (!confirm(installedBytes ? t('Remove {name} and delete its {size} from this device?', { name, size: fmtBytes(installedBytes) }) : t('Remove {name} from the list?', { name }))) return;
    setBusy(id);
    try {
      const m = modelById(id);
      if (isNativeModel(m)) {
        // A GGUF added from Hugging Face: its files, then the entry.
        await deleteNativeModel(m);
        await removeCustomModel(id);
        await refreshNativeModels();
      } else {
        if (installedBytes) await engine().remove(id);
        await removeExtraModel(id);
      }
    } finally {
      setBusy(null);
      setVersion((v) => v + 1);
      refresh();
    }
  }

  function use(id: string) {
    onClose();
    start(id);
  }

  if (!choices.length) return <p class="muted">{t('No models can run in this browser.')}</p>;

  return (
    <>
      <p class="muted small">
        {t('Bigger models answer better but download more and need more GPU memory. Each is downloaded once and kept on this device.')}
      </p>
      {nativeModels().length > 0 && nativeGpu && (
        <p class="notice ok small">
          {tj('Your {gpu} ({gb} GB) runs the {label} models natively: bigger and faster than in a browser. The first one also downloads the llama.cpp engine ({size}, once).', {
            gpu: nativeGpu.name, gb: Math.round(nativeGpu.vramMB / 1024), label: <strong>GPU · llama.cpp</strong>,
            size: nativeGpu.cuda ? t('about 650 MB with NVIDIA’s CUDA runtime') : nativeGpu.engine === 'metal' ? t('the Metal build, about 12 MB') : t('the Vulkan build, about 33 MB'),
          })}
        </p>
      )}
      <ul class="model-list">
        {choices.map(({ id, model, recommended }) => {
          const st = statuses[id];
          const isCurrent = id === current;
          const installed = !!st?.complete;
          const partial = !!st && st.cachedShards > 0 && !installed;
          return (
            <li class={isCurrent ? 'model-item current' : 'model-item'}>
              <div class="model-info">
                <div class="model-title">
                  {model.displayName}
                  {recommended && <span class="pill pill-accent">{t('Recommended')}</span>}
                  {model.vision && <span class="pill pill-accent">{t('Images')}</span>}
                  {isNativeModel(model) && <span class="pill" title={t('Runs natively on your GPU with llama.cpp')}>GPU · llama.cpp</span>}
                  {model.source && <span class="pill">{model.source === 'custom' ? t('Custom') : t('Added')}</span>}
                  {isCurrent && boot.kind === 'ready' && <span class="pill pill-ok"><CheckIcon /> {t('In use')}</span>}
                </div>
                <div class="muted small">
                  {model.params && `${model.params} · `}{isNativeModel(model) ? t('4-bit GGUF') : /f16/i.test(id) ? t('16-bit') : t('32-bit')} · {installed ? t('{size} on device', { size: fmtBytes(st.totalBytes) }) : partial ? t('{done} of {total} saved', { done: fmtBytes(st.cachedBytes), total: fmtBytes(st.totalBytes) }) : t('{size} download', { size: formatMB(model.downloadMB) })}
                  {' '}· {t('~{size} GPU memory', { size: formatMB(model.vramMB) })}
                </div>
              </div>
              <div class="model-actions">
                {!(isCurrent && boot.kind === 'ready') && (
                  <button class="btn btn-sm btn-primary" disabled={downloading || busy === id} onClick={() => use(id)}>
                    {installed ? t('Use') : partial ? t('Resume') : t('Download')}
                  </button>
                )}
                {(installed || partial) && !isCurrent && !model.source && (
                  <button class="btn btn-sm btn-ghost" disabled={busy === id || downloading} onClick={() => remove(id, model.displayName, st.cachedBytes)}>
                    {busy === id ? t('Deleting…') : t('Delete')}
                  </button>
                )}
                {model.source && !isCurrent && (
                  <button class="btn btn-sm btn-ghost" disabled={busy === id || downloading} onClick={() => removeAdded(id, model.displayName, st?.cachedBytes ?? 0)}>
                    {busy === id ? t('Removing…') : t('Remove')}
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {boot.kind === 'ready' && <GenerationSettings modelId={boot.modelId} model={boot.model} onReload={onClose} />}
      {tooLargeModels().length > 0 && (
        <p class="small muted">
          {t('Not available on this GPU: {models}. They need bigger GPU buffers (for their weights, or while answering) than it handles reliably ({safe}, 75% of its {limit} limit).', {
            models: tooLargeModels().map((m) => m.displayName).join(', '),
            safe: fmtBytes(safeBinding(device?.gpu.maxStorageBufferBindingSize ?? 0)),
            limit: fmtBytes(device?.gpu.maxStorageBufferBindingSize),
          })}
        </p>
      )}
      <MoreModels onAdded={() => { setVersion((v) => v + 1); refresh(); }} />
      {nativeGpu && <CustomGgufSection onAdded={() => { setVersion((v) => v + 1); refresh(); }} />}
      {others.length > 0 && (
        <div class="section">
          <h3>{t('Other downloads')}</h3>
          <p class="small muted">{t('Not used on this device. Delete them to free space.')}</p>
          {others.map((s) => (
            <div class="row spread">
              <span class="small">{modelById(s.modelId)?.displayName ?? s.modelId} <span class="muted">· {s.modelId.includes('q4f16') ? t('16-bit') : t('32-bit')} · {fmtBytes(s.cachedBytes)}</span></span>
              <button class="btn btn-sm btn-ghost" disabled={busy === s.modelId || downloading} onClick={() => remove(s.modelId, modelById(s.modelId)?.displayName ?? s.modelId, s.cachedBytes)}>
                {busy === s.modelId ? t('Deleting…') : t('Delete')}
              </button>
            </div>
          ))}
        </div>
      )}
      {downloading && <p class="notice">{t('A download is running. Pause it to switch models.')}</p>}
      <label class="switch-row">
        <span>
          <strong>{t('Download on Wi-Fi only')}</strong>
          <span class="muted small">{t('Pauses model downloads on cellular connections.')}</span>
        </span>
        <input
          type="checkbox"
          class="switch"
          checked={wifiOnly}
          onChange={(e) => {
            setWifiOnly(e.currentTarget.checked);
            setSetting('wifiOnly', e.currentTarget.checked);
          }}
        />
      </label>
    </>
  );
}

function AppTab({ onDeleteAllChats }: { onDeleteAllChats?: () => void }) {
  const [chatCount, setChatCount] = useState<number | null>(null);
  const [backupMsg, setBackupMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const countChats = () => listConversations().then((c) => setChatCount(c.length), () => {});
  useEffect(() => {
    countChats();
  }, []);

  async function onImport(file: File | undefined) {
    if (!file) return;
    try {
      const r = await importBackup(file);
      const parts = [t('{n} added', { n: r.added }), r.updated && t('{n} updated', { n: r.updated }), r.skipped && t('{n} already here', { n: r.skipped }), r.notes && t('{n} memory notes', { n: r.notes })].filter(Boolean);
      setBackupMsg({
        ok: true,
        text: r.added + r.updated
          ? t('Imported: {list}. Open them from the history.', { list: parts.join(', ') })
          : r.skipped
            ? tn(r.skipped, 'Nothing new to import: {n} conversation is already here.', 'Nothing new to import: {n} conversations are already here.')
            : t('Nothing new to import.'),
      });
      countChats();
    } catch (e) {
      setBackupMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      if (fileInput.current) fileInput.current.value = '';
    }
  }
  const pwa = usePwa();
  const [storage, setStorage] = useState<StorageReport | undefined>();
  const [persisted, setPersisted] = useState<boolean | undefined>();
  const d = device;

  useEffect(() => {
    probeStorage().then(setStorage);
    navigator.storage?.persisted?.().then(setPersisted, () => {});
  }, []);

  const free = freeStorage(storage);
  return (
    <>
      {isDesktopApp && <DesktopSection />}
      {pwa.needRefresh && (
        <div class="section">
          <h3>{t('Update available')}</h3>
          <p class="small muted">{t('A new version of the app is ready.')}</p>
          <button class="btn btn-primary" disabled={bootState().kind === 'running'} onClick={() => applyUpdate()}>{t('Reload now')}</button>
        </div>
      )}

      <LanguageSection />

      <InstructionsSection />

      <DocumentsSection />


      {onDeleteAllChats && (
        <div class="section">
          <h3>{t('Conversations')}</h3>
          <p class="small muted">
            {chatCount
              ? tn(chatCount, '{n} saved conversation, stored only in this browser. Open it from the history button in the chat header.', '{n} saved conversations, stored only in this browser. Open them from the history button in the chat header.')
              : t('Conversations are stored only in this browser. Open them from the history button in the chat header.')}
          </p>
          <div class="row">
            <button class="btn btn-sm" disabled={!chatCount} onClick={async () => { const n = await exportAll(); setBackupMsg({ ok: true, text: tn(n, 'Saved a backup of {n} conversation.', 'Saved a backup of {n} conversations.') }); }}>
              <DownloadIcon /> {t('Export all')}
            </button>
            <button class="btn btn-sm" onClick={() => fileInput.current?.click()}>{t('Import…')}</button>
            <input ref={fileInput} type="file" accept="application/json,.json" hidden onChange={(e) => onImport(e.currentTarget.files?.[0])} />
          </div>
          <p class="small muted">{t('The backup is a JSON file with your conversations, memory and instructions. Keep it somewhere safe: browsers can clear site data.')}</p>
          {backupMsg && <p class={backupMsg.ok ? 'notice ok small' : 'alert small'}>{backupMsg.text}</p>}
          {!!chatCount && (
            <button class="btn btn-danger" onClick={() => confirm(tn(chatCount, 'Delete {n} conversation? This can’t be undone.', 'Delete all {n} conversations? This can’t be undone.')) && onDeleteAllChats()}>
              {t('Delete all conversations')}
            </button>
          )}
        </div>
      )}

      <div class="section">
        <h3>{t('Install')}</h3>
        {pwa.installed ? <p class="small">{t('Installed. Running as an app.')}</p> : <InstallApp />}
        {!pwa.installed && !pwa.canInstall && (
          <p class="small muted">{t('Use your browser menu: “Install app” or “Add to Home Screen”.')}</p>
        )}
      </div>

      <div class="section">
        <h3>{t('Storage')}</h3>
        <dl class="kv">
          <dt>{t('Used by this app')}</dt><dd>{storage ? fmtBytes(storage.usage) : '—'}</dd>
          <dt>{t('Available')}</dt>
          <dd>{storage?.quotaHiddenByBrave ? t('Hidden by Brave') : fmtBytes(free)}</dd>
          <dt>{t('Persistent')}</dt>
          <dd>{persisted === undefined ? t('Not supported') : persisted ? t('Yes, won’t be cleared automatically') : t('No, may be cleared if space runs low')}</dd>
        </dl>
      </div>

      {d && (
        <details class="section">
          <summary><h3>{t('Device details')}</h3></summary>
          <dl class="kv">
            <dt>GPU</dt>
            <dd>{[d.gpu.vendor, d.gpu.architecture, d.gpu.description].filter(Boolean).join(' · ') || (d.gpu.adapter ? t('Unknown') : t('None'))}</dd>
            <dt>shader-f16</dt><dd>{d.gpu.shaderF16 ? t('Yes') : t('No')}</dd>
            <dt>{t('Max buffer')}</dt><dd>{fmtBytes(d.gpu.maxBufferSize)}</dd>
            <dt>{t('Memory')}</dt><dd>{d.deviceMemory != null ? `≈ ${d.deviceMemory} ${UNIT.GB}` : t('Not reported')}</dd>
            <dt>{t('CPU threads')}</dt><dd>{d.hardwareConcurrency ?? t('Not reported')}</dd>
            <dt>{t('Platform')}</dt>
            <dd>{[d.platform.isIOS ? 'iOS' : d.platform.isAndroid ? 'Android' : t('Desktop'), d.platform.standalone ? t('installed') : null].filter(Boolean).join(' · ')}</dd>
            <dt>{t('Max storage binding')}</dt><dd>{fmtBytes(d.gpu.maxStorageBufferBindingSize)}</dd>
          </dl>
          <GpuReport open />
        </details>
      )}

      <ReportSection />

      <p class="fine">
        {t('My Own AI runs models with WebLLM on your GPU. Your messages and voice never leave this device.')}
        {' '}{t('Version {version}', { version: __APP_VERSION__ })}
      </p>
    </>
  );
}

function ToolsTab() {
  const { tools, isOn, ready } = useEnabledTools();
  if (!ready) return <p class="muted small">{t('Loading…')}</p>;
  const local = TOOLS.filter((t) => !t.service);
  const web = TOOLS.filter((t) => t.service);
  return (
    <>
      <p class="small muted">
        {t('The assistant can only use the tools switched on here. Fewer tools leave more room in the conversation and help small models pick the right one.')}
        {' '}{t('{n} of {total} on.', { n: tools.length, total: TOOLS.length })}
      </p>
      <ToolGroup title={t('On this device')} note={t('Never leave your device.')} tools={local} isOn={isOn} />
      <ToolGroup title={t('Uses the internet')} note={t('Only the tool’s query (like a city name) is sent, never your conversation.')} tools={web} isOn={isOn} />
      <SkillsSection />
    </>
  );
}

function ToolGroup({ title, note, tools, isOn }: { title: string; note: string; tools: ToolDef[]; isOn(name: string): boolean }) {
  const allOn = tools.every((t) => isOn(t.name));
  return (
    <div class="section">
      <div class="row spread">
        <h3>{title}</h3>
        <button class="btn btn-sm btn-ghost" onClick={() => setToolsEnabled(tools.map((t) => t.name), !allOn)}>
          {allOn ? t('Turn all off') : t('Turn all on')}
        </button>
      </div>
      <p class="small muted">{note}</p>
      <ul class="tool-list">
        {tools.map((t) => (
          <li>
            <label class="switch-row">
              <span class="tool-item">
                <span class="tool-item-icon">{t.service ? <GlobeIcon /> : <ToolIcon />}</span>
                <span>
                  <strong>{t.label}</strong>
                  <span class="muted small">{t.summary}{t.service && <> · {t.service}</>}</span>
                </span>
              </span>
              <input
                type="checkbox"
                class="switch"
                checked={isOn(t.name)}
                onChange={(e) => setToolsEnabled([t.name], e.currentTarget.checked)}
              />
            </label>
          </li>
        ))}
      </ul>
    </div>
  );
}

const INSTRUCTIONS_MAX = 600;

/** Free-text instructions added to the system prompt of every conversation. */
function InstructionsSection() {
  const [text, setText] = useState<string | null>(null);
  const [saved, setSaved] = useState(true);
  const timer = useRef(0);
  useEffect(() => {
    getSetting('instructions').then((v) => setText(v ?? ''));
    return () => clearTimeout(timer.current);
  }, []);

  function change(v: string) {
    setText(v);
    setSaved(false);
    clearTimeout(timer.current);
    timer.current = window.setTimeout(async () => {
      await setSetting('instructions', v.trim());
      setSaved(true);
    }, 400);
  }

  if (text === null) return null;
  return (
    <div class="section">
      <h3>{t('Custom instructions')}</h3>
      <p class="small muted">{t('Tell the assistant how to answer. Applied to every conversation from your next message.')}</p>
      <textarea
        class="instructions"
        value={text}
        maxLength={INSTRUCTIONS_MAX}
        placeholder={t('For example: Call me Sam. Keep answers short. Use metric units and euros.')}
        onInput={(e) => change(e.currentTarget.value)}
      />
      <div class="row spread small muted">
        <span>{saved ? (text.trim() ? t('Saved') : '') : t('Saving…')}</span>
        <span>{text.length}/{INSTRUCTIONS_MAX}</span>
      </div>
    </div>
  );
}

/** Documents stored on this device (attached in conversations with the 📎 button). */
function DocumentsSection() {
  const [docs, setDocs] = useState<DocInfo[] | null>(null);
  useEffect(() => {
    listDocs().then(setDocs, () => setDocs([]));
  }, []);
  if (!docs) return null;
  return (
    <div class="section">
      <h3>{t('Documents')}</h3>
      <p class="small muted">
        {docs.length
          ? t('Files you attached in conversations, indexed and stored only on this device. Deleting one makes it unsearchable in the conversations that use it.')
          : t('Attach a PDF or text file with the 📎 button in the message bar to ask questions about it. It is read and searched on this device.')}
      </p>
      {docs.length > 0 && (
        <ul class="notes">
          {docs.map((d) => (
            <li>
              <span>
                {d.name}{' '}
                <span class="muted small">· {[d.pages && tn(d.pages, '{n} page', '{n} pages'), fmtBytes(d.size), !d.semantic && t('keyword search only')].filter(Boolean).join(' · ')}</span>
              </span>
              <button
                class="icon-btn"
                aria-label={t('Delete {name}', { name: d.name })}
                title={t('Delete')}
                onClick={async () => {
                  if (!confirm(t('Delete {name} from this device?', { name: d.name }))) return;
                  await removeDoc(d.id);
                  setDocs(docs.filter((x) => x.id !== d.id));
                }}
              >
                <CloseIcon />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Interface language: the device's, or one chosen here (the page reloads to switch). */
function LanguageSection() {
  const choice = languageChoice();
  return (
    <div class="section">
      <div class="row spread">
        <h3>{t('Language')}</h3>
        <select class="search-input lang-select" value={choice} aria-label={t('Language')} onChange={(e) => setLanguage(e.currentTarget.value as LangChoice)}>
          <option value="auto">{t('Automatic (this device)')}</option>
          {LANGUAGES.map((l) => <option value={l.id}>{l.name}</option>)}
        </select>
      </div>
      <p class="small muted">{t('For the app’s menus and messages. The assistant answers in the language you write in.')}</p>
    </div>
  );
}

/**
 * "Report a problem": a GitHub issue with the app's diagnostics, shown and editable
 * first. Nothing is sent from here; GitHub's form opens with the text filled in.
 */
function ReportSection() {
  const [text, setText] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  return (
    <div class="section">
      <h3>{t('Report a problem')}</h3>
      <p class="small muted">
        {t('Prepares a bug report for GitHub with technical details: the app’s version, this device, the GPU, the model and recent errors. Your conversations, memory and documents are never included, and you can read and change everything before sending it.')}
      </p>
      {text === null ? (
        <button class="btn btn-sm" onClick={async () => setText(await reportBody())}>{t('Prepare a report…')}</button>
      ) : (
        <>
          <textarea class="config-input report-text" rows={12} value={text} aria-label={t('Report')} onInput={(e) => setText(e.currentTarget.value)} />
          <div class="row">
            <button class="btn btn-sm btn-primary" onClick={() => void openExternal(issueUrl(text))}>{t('Open on GitHub')}</button>
            <button class="btn btn-sm" onClick={async () => { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>
              {copied ? t('Copied') : t('Copy')}
            </button>
            <button class="btn btn-sm btn-ghost" onClick={() => setText(null)}>{t('Cancel')}</button>
          </div>
          <p class="small muted">{t('Describe what happened at the top. GitHub opens with this text; nothing is sent until you submit it there (a free GitHub account is needed).')}</p>
        </>
      )}
    </div>
  );
}
