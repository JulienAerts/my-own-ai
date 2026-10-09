// Settings → Model → Add a GGUF model (desktop, llama.cpp): any model from Hugging Face.
import { useEffect, useState } from 'preact/hooks';
import { nativeGpu, refreshNativeModels } from '../boot';
import { nativeContexts, type NativeModel } from '../native/backend';
import { addCustomModel, inspectRepo, setHfToken, suggestedQuant, toNativeModel, type Quant, type RepoInfo } from '../native/custom';
import { getSetting } from '../db';
import { fmtBytes } from './format';
import { t, tj } from '../i18n/i18n';

export function CustomGgufSection({ onAdded }: { onAdded(): void }) {
  const [link, setLink] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [repo, setRepo] = useState<RepoInfo | null>(null);
  const [added, setAdded] = useState<string | null>(null);
  const [token, setToken] = useState('');
  const [hasToken, setHasToken] = useState(false);
  useEffect(() => { getSetting('hfToken').then((t) => setHasToken(!!t)); }, []);

  async function check() {
    setBusy(true); setError(null); setRepo(null); setAdded(null);
    try {
      setRepo(await inspectRepo(link));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  // As a native model (for the size checks), with this quantization.
  const asModel = (q: Quant): NativeModel | null => (repo ? toNativeModel({
    id: '', repo: repo.repo, name: repo.name, quant: q.label, file: q.file, bytes: q.bytes, parts: q.parts, mmproj: repo.mmproj,
    params: repo.params, reasoning: repo.reasoning, contextLength: repo.contextLength,
  }) : null);
  const fits = (q: Quant) => { const m = asModel(q); return !!m && !!nativeGpu && nativeContexts(m, nativeGpu).length > 0; };
  const suggested = repo ? suggestedQuant(repo.quants, fits) : undefined;

  async function add(q: Quant) {
    await addCustomModel(repo!, q);
    await refreshNativeModels();
    setAdded(`${repo!.name} · ${q.label}`);
    onAdded();
  }

  return (
    <div class="section">
      <h3>{t('Add a GGUF model')}</h3>
      <p class="small muted">
        {tj('Any model in GGUF format from Hugging Face, run by llama.cpp on your GPU: paste the link of its repository (often ending in {suffix}) or of one of its files.', { suffix: <code>-GGUF</code> })}
      </p>
      <div class="row">
        <input class="search-input grow" placeholder="https://huggingface.co/owner/Model-GGUF" value={link}
          onInput={(e) => setLink(e.currentTarget.value)} onKeyDown={(e) => e.key === 'Enter' && link.trim() && check()} />
        <button class="btn btn-sm" disabled={busy || !link.trim()} onClick={check}>{busy ? t('Checking…') : t('Check')}</button>
      </div>
      {error && <p class="alert small">{error}</p>}
      {added && <p class="notice ok small">{t('Added {model}: find it in the model list above.', { model: added })}</p>}
      {repo && (
        <>
          <dl class="kv">
            <dt>{t('Model')}</dt><dd>{repo.repo}</dd>
            {repo.params && <><dt>{t('Size')}</dt><dd>{t('{params} parameters', { params: `${Math.round(repo.params / 1e9)}B` })}{repo.architecture ? ` · ${repo.architecture}` : ''}</dd></>}
            <dt>{t('Thinks')}</dt><dd>{repo.reasoning ? t('Yes (<think> in its template)') : t('No')}</dd>
            <dt>{t('Images')}</dt><dd>{repo.mmproj ? t('Yes (+{size} encoder)', { size: fmtBytes(repo.mmproj.bytes) }) : t('No')}</dd>
            {repo.gated && <><dt>{t('Access')}</dt><dd>{hasToken ? t('Gated: accept its terms on Hugging Face') : t('Gated: accept its terms on Hugging Face and add your token below')}</dd></>}
          </dl>
          <ul class="quants">
            {repo.quants.map((q) => {
              const ok = fits(q);
              return (
                <li class={ok ? undefined : 'too-big'}>
                  <span class="quant-info">
                    <strong>{q.label}</strong>
                    <span class="muted small">
                      {fmtBytes(q.bytes)}{q.parts.length ? ` ${t('in {n} files', { n: q.parts.length + 1 })}` : ''}
                      {/^(I?Q[12])/.test(q.label) && ` · ${t('low quality')}`}
                    </span>
                  </span>
                  {q === suggested && <span class="pill pill-accent">{t('Recommended')}</span>}
                  {!ok && <span class="pill">{t('Too big for this GPU')}</span>}
                  <button class="btn btn-sm" disabled={!ok} onClick={() => add(q)}>{t('Add')}</button>
                </li>
              );
            })}
          </ul>
        </>
      )}
      <details>
        <summary class="small">{hasToken ? t('Hugging Face token (saved)') : t('Hugging Face token (for gated models)')}</summary>
        <p class="small muted">
          {tj('Some models are gated: accept their terms on their Hugging Face page, then create a {read} token at {link}. It stays on this PC and is only sent to huggingface.co.', {
            read: <em>{t('read')}</em>,
            link: <a href="https://huggingface.co/settings/tokens" target="_blank" rel="noopener">huggingface.co/settings/tokens</a>,
          })}
        </p>
        <div class="row">
          <input class="search-input grow" type="password" autocomplete="off" placeholder={hasToken ? `•••••••• (${t('saved')})` : 'hf_…'} value={token} onInput={(e) => setToken(e.currentTarget.value)} />
          <button class="btn btn-sm" disabled={!token.trim()} onClick={async () => { await setHfToken(token); setToken(''); setHasToken(true); }}>{t('Save')}</button>
          {hasToken && <button class="btn btn-sm btn-ghost" onClick={async () => { await setHfToken(''); setHasToken(false); }}>{t('Remove')}</button>}
        </div>
      </details>
    </div>
  );
}
