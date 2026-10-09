// Settings → Model → "More models": add any model from WebLLM's catalog, or a
// custom MLC-format model from a Hugging Face link. Added models join the
// model list (Download / Use / Remove); recommendations stay curated.
import { useEffect, useState } from 'preact/hooks';
import { addExtraModel, device, extraModelProblem } from '../boot';
import { allModelIds, estimateWorkspace, extraModels, nameFromId, tierForVram, type ModelInfo } from '../models';
import { engine } from '../worker/client';
import type { CatalogEntry, RepoInfo } from '../worker/engine.worker';
import { fmtBytes } from './format';
import { locale, t, tj } from '../i18n/i18n';

const MB = 2 ** 20;

function infoFor(id: string, repo: RepoInfo, extra: Partial<ModelInfo>, lib?: string): ModelInfo {
  const downloadMB = repo.sizeBytes / MB;
  const hidden = Number(repo.signature.hidden_size ?? repo.signature.n_embd ?? repo.signature.hidden_dim) || undefined;
  return {
    family: id,
    fixedId: id,
    displayName: nameFromId(id),
    params: '',
    downloadMB,
    // Weights plus KV cache and activations; a rough guess when WebLLM gives none.
    vramMB: extra.vramMB ?? Math.round(downloadMB * 1.25 + 600),
    hermes: /hermes-(2-pro|3)/i.test(id),
    tier: tierForVram(extra.vramMB ?? downloadMB * 1.25 + 600),
    maxTensorBytes: repo.maxTensorBytes,
    workspaceBytes: lib ? estimateWorkspace(lib, hidden) : undefined,
    vision: repo.vision,
    contextWindow: repo.contextWindow,
    ...extra,
  };
}

export function MoreModels({ onAdded }: { onAdded(): void }) {
  const [panel, setPanel] = useState<'catalog' | 'custom' | null>(null);
  const [catalog, setCatalog] = useState<CatalogEntry[] | null>(null);
  useEffect(() => {
    if (panel && !catalog) engine().catalog().then(setCatalog, () => setCatalog([]));
  }, [panel]);

  return (
    <div class="section">
      <h3>{t('More models')}</h3>
      <p class="small muted">
        {t('Pick any model WebLLM offers, or add your own from a link. The recommendation above is based on this device; larger models may not fit in its memory.')}
      </p>
      <div class="row">
        <button class={panel === 'catalog' ? 'btn btn-sm btn-primary' : 'btn btn-sm'} onClick={() => setPanel(panel === 'catalog' ? null : 'catalog')}>{t('Browse WebLLM models')}</button>
        <button class={panel === 'custom' ? 'btn btn-sm btn-primary' : 'btn btn-sm'} onClick={() => setPanel(panel === 'custom' ? null : 'custom')}>{t('Add from a link')}</button>
      </div>
      {panel === 'catalog' && <CatalogPanel catalog={catalog} onAdded={onAdded} />}
      {panel === 'custom' && <CustomPanel catalog={catalog} onAdded={onAdded} />}
    </div>
  );
}

function CatalogPanel({ catalog, onAdded }: { catalog: CatalogEntry[] | null; onAdded(): void }) {
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ id: string; ok: boolean; text: string } | null>(null);
  if (!catalog) return <p class="muted small">{t('Loading the catalog…')}</p>;

  const f16 = !!device?.gpu.shaderF16;
  const have = new Set([...allModelIds(), ...extraModels().map((m) => m.fixedId)]);
  const q = query.trim().toLowerCase();
  const list = catalog
    // Show the build this GPU can run: f16 when supported, else the f32 builds.
    .filter((m) => (f16 ? !/q\d+f32/i.test(m.id) || !catalog.some((x) => x.id === m.id.replace(/f32/, 'f16')) : !m.needsF16))
    .filter((m) => !have.has(m.id))
    .filter((m) => !q || m.id.toLowerCase().includes(q))
    .sort((a, b) => (a.vramMB ?? 1e9) - (b.vramMB ?? 1e9));

  async function add(m: CatalogEntry) {
    setBusy(m.id);
    setMsg(null);
    try {
      const repo = await engine().inspect(m.url);
      const info = infoFor(m.id, repo, { source: 'catalog', vramMB: m.vramMB ? Math.round(m.vramMB) : undefined, vision: m.vision, contextWindow: m.contextWindow }, m.lib);
      const problem = extraModelProblem(info);
      if (problem) return setMsg({ id: m.id, ok: false, text: t('Can’t run here: {problem}', { problem }) });
      await addExtraModel(info);
      setMsg({ id: m.id, ok: true, text: t('Added: find {model} in the list above.', { model: info.displayName }) });
      onAdded();
    } catch (e) {
      setMsg({ id: m.id, ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div class="more-panel">
      {/* An added model leaves this list, so its confirmation sits above it. */}
      {msg?.ok && <p class="notice ok small">{msg.text}</p>}
      <input class="search-input" type="search" placeholder={t('Search {n} models (e.g. llama, qwen, gemma, phi)', { n: list.length })} value={query} onInput={(e) => setQuery(e.currentTarget.value)} />
      <ul class="catalog">
        {list.slice(0, 60).map((m) => (
          <li>
            <div class="catalog-info">
              <strong>{nameFromId(m.id)}</strong>
              <span class="muted small">
                {[m.vramMB && t('~{size} GPU memory', { size: fmtBytes(m.vramMB * MB) }), m.vision && t('images'), m.lowResource && t('suits phones')].filter(Boolean).join(' · ')}
              </span>
              <span class="mono muted">{m.id}</span>
              {msg?.id === m.id && !msg.ok && <span class="alert small">{msg.text}</span>}
            </div>
            <button class="btn btn-sm" disabled={!!busy} onClick={() => add(m)}>{busy === m.id ? t('Checking…') : t('Add')}</button>
          </li>
        ))}
      </ul>
      {list.length > 60 && <p class="small muted">{t('Showing 60 of {n}. Search to narrow down.', { n: list.length })}</p>}
    </div>
  );
}

/** Longest common prefix length, to guess which catalog model a fine-tune derives from. */
function common(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i].toLowerCase() === b[i].toLowerCase()) i++;
  return i;
}

function CustomPanel({ catalog, onAdded }: { catalog: CatalogEntry[] | null; onAdded(): void }) {
  const [url, setUrl] = useState('');
  const [libMode, setLibMode] = useState<'catalog' | 'url'>('catalog');
  const [libFrom, setLibFrom] = useState('');
  const [libUrl, setLibUrl] = useState('');
  const [repo, setRepo] = useState<RepoInfo | null>(null);
  const [lib, setLib] = useState<{ url: string; mismatch: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const repoName = repo ? repo.url.split('/').pop() ?? '' : '';
  const sameQuant = (catalog ?? []).filter((m) => !repo || m.id.toLowerCase().includes(repo.quantization.toLowerCase()));

  async function check() {
    setBusy(true);
    setMsg(null);
    setRepo(null);
    setLib(null);
    try {
      const r = await engine().inspect(url);
      setRepo(r);
      // Suggest the catalog model whose id shares the longest prefix (fine-tunes keep the base name).
      const name = r.url.split('/').pop() ?? '';
      const guess = [...(catalog ?? [])]
        .filter((m) => m.id.toLowerCase().includes(r.quantization.toLowerCase()))
        .sort((a, b) => common(b.id, name) - common(a.id, name))[0];
      if (guess && !libFrom) setLibFrom(guess.id);
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  // Compare the chosen catalog model's architecture with the custom repo's.
  useEffect(() => {
    if (!repo || libMode !== 'catalog' || !libFrom) return;
    let live = true;
    engine().libraryOf(libFrom).then(({ lib: l, info }) => {
      if (!live) return;
      const keys = new Set([...Object.keys(repo.signature), ...Object.keys(info.signature)]);
      const mismatch = [...keys].filter((k) => repo.signature[k] !== info.signature[k]);
      setLib({ url: l, mismatch });
    }, (e) => live && setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) }));
    return () => { live = false; };
  }, [repo, libMode, libFrom]);

  const info = repo && infoFor(
    (catalog ?? []).some((m) => m.id === repoName) ? `custom-${repoName}` : repoName,
    repo,
    { source: 'custom', url: repo.url, lib: libMode === 'url' ? libUrl.trim() : lib?.url },
    libMode === 'url' ? libUrl.trim() : lib?.url,
  );
  const problem = info && extraModelProblem(info);
  const libOk = libMode === 'url' ? /^https?:\/\/.+\.wasm(\?.*)?$/i.test(libUrl.trim()) : !!lib && lib.mismatch.length === 0;

  async function add() {
    if (!info) return;
    await addExtraModel(info);
    setMsg({ ok: true, text: t('Added {model}: download it from the list above.', { model: info.displayName }) });
    onAdded();
  }

  return (
    <div class="more-panel">
      <p class="small muted">
        {tj('The model must be in WebLLM’s MLC format: a Hugging Face repo with {config} and {cache} (most {repos} repos), plus its compiled library ({wasm}). Fine-tunes can reuse the library of the model they’re based on.', {
          config: <code>mlc-chat-config.json</code>, cache: <code>tensor-cache.json</code>, repos: <code>mlc-ai/…-MLC</code>, wasm: <code>.wasm</code>,
        })}
      </p>
      <div class="row">
        <input class="search-input grow" placeholder="https://huggingface.co/org/Model-q4f16_1-MLC" value={url} onInput={(e) => { setUrl(e.currentTarget.value); setRepo(null); }} />
        <button class="btn btn-sm" disabled={busy || !url.trim()} onClick={check}>{busy ? t('Checking…') : t('Check')}</button>
      </div>
      {repo && info && (
        <>
          <dl class="kv">
            <dt>{t('Architecture')}</dt><dd>{repo.modelType} · {repo.quantization}</dd>
            <dt>{t('Download')}</dt><dd>{fmtBytes(repo.sizeBytes)}</dd>
            <dt>{t('Largest weight block')}</dt><dd>{fmtBytes(repo.maxTensorBytes)}</dd>
            {repo.contextWindow && <><dt>{t('Context')}</dt><dd>{t('{n} tokens (capped at 4,096)', { n: repo.contextWindow.toLocaleString(locale) })}</dd></>}
            {repo.vision && <><dt>{t('Images')}</dt><dd>{t('Yes')}</dd></>}
          </dl>
          {problem && <p class="alert small">{t('Can’t run on this device: {problem}', { problem })}</p>}
          <div class="lib-choice">
            <label class="check"><input type="radio" checked={libMode === 'catalog'} onChange={() => setLibMode('catalog')} /> {t('Use the library of a WebLLM model')}</label>
            {libMode === 'catalog' && (
              <>
                <select class="search-input" value={libFrom} onChange={(e) => setLibFrom(e.currentTarget.value)}>
                  <option value="">{t('Choose…')}</option>
                  {sameQuant.map((m) => <option value={m.id}>{m.id}</option>)}
                </select>
                {lib && (lib.mismatch.length === 0
                  ? <p class="notice ok small">{t('Compatible: same architecture and quantization.')}</p>
                  : <p class="alert small">{t('Not compatible ({fields} differ). Choose the model this one is based on, or give a library URL.', { fields: lib.mismatch.slice(0, 4).join(', ') + (lib.mismatch.length > 4 ? ', …' : '') })}</p>)}
              </>
            )}
            <label class="check"><input type="radio" checked={libMode === 'url'} onChange={() => setLibMode('url')} /> {t('Library URL (.wasm)')}</label>
            {libMode === 'url' && (
              <input class="search-input" placeholder="https://…/Model-webgpu.wasm" value={libUrl} onInput={(e) => setLibUrl(e.currentTarget.value)} />
            )}
          </div>
          <button class="btn btn-primary" disabled={!!problem || !libOk} onClick={add}>{t('Add {model}', { model: info.displayName })}</button>
        </>
      )}
      {msg && <p class={msg.ok ? 'notice ok small' : 'alert small'}>{msg.text}</p>}
    </div>
  );
}
