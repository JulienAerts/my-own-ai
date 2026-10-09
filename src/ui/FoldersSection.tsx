// Settings → Connectors → Folders (desktop): folders the assistant may use.
import { useState } from 'preact/hooks';
import { indexFolder, pickFolder, removeFolder, renameFolder, useFolders, type WorkspaceFolder } from '../files/workspace';
import { TrashIcon } from './icons';
import { locale, t } from '../i18n/i18n';

export function FoldersSection() {
  const folders = useFolders();
  return (
    <div class="section">
      <h3>{t('Folders')}</h3>
      <p class="small muted">
        {t('Folders on this PC the assistant can list, read and search. It can save files there too, but asks you each time. Nothing outside these folders is reachable. Index a folder to search inside its documents (PDF, text, Markdown, CSV…) by meaning.')}
      </p>
      {folders.map((f) => <FolderRow f={f} />)}
      <button class="btn btn-sm" onClick={() => pickFolder()}>{t('Add a folder')}</button>
    </div>
  );
}

function FolderRow({ f }: { f: WorkspaceFolder }) {
  const [progress, setProgress] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const indexed = f.index ? Object.keys(f.index.files).length : 0;

  async function index() {
    setResult(null);
    setProgress(t('Listing files…'));
    try {
      const r = await indexFolder(f.id, (done, total, file) => setProgress(total ? `${t('{done} of {total}', { done, total })} · ${file}` : t('Finishing…')));
      setResult(r.skipped
        ? t('{n} documents indexed, {skipped} unreadable.', { n: r.indexed, skipped: r.skipped })
        : t('{n} documents indexed.', { n: r.indexed }));
    } catch (e) {
      setResult(e instanceof Error ? e.message : String(e));
    } finally {
      setProgress(null);
    }
  }

  return (
    <div class="folder-row">
      <div class="folder-info">
        <input class="search-input folder-name" value={f.name} aria-label={t('Name the assistant uses')} onChange={(e) => renameFolder(f.id, e.currentTarget.value)} />
        <code class="small muted">{f.path}</code>
        <span class="small muted">
          {progress ?? result ?? (f.index ? `${t('{n} documents indexed.', { n: indexed }).replace(/\.$/, '')} · ${new Date(f.index.at).toLocaleDateString(locale)}` : t('Not indexed'))}
        </span>
      </div>
      <button class="btn btn-sm" disabled={!!progress} onClick={index}>{f.index ? t('Re-index') : t('Index')}</button>
      <button class="icon-btn" aria-label={t('Remove {name}', { name: f.name })} title={t('Remove (the files stay on disk)')} onClick={() => confirm(t('Stop using {path}? The files stay on your disk.', { path: f.path })) && removeFolder(f.id)}><TrashIcon /></button>
    </div>
  );
}
