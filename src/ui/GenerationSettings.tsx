// Settings → Model → Generation: temperature, top-p, answer length and context
// size for the model in use. Unset = Auto (the app picks per turn).
import { contextChoices, start, useBoot } from '../boot';
import { setGenSettings, useGenSettings, type GenSettings } from '../agent/genPrefs';
import type { ModelInfo } from '../models';
import { locale, t } from '../i18n/i18n';

const LENGTHS = [256, 512, 1024, 2048, 4096];

export function GenerationSettings({ modelId, model, onReload }: { modelId: string; model: ModelInfo; onReload(): void }) {
  const gen = useGenSettings(modelId);
  const boot = useBoot();
  const loadedContext = boot.kind === 'ready' ? boot.contextWindow : undefined;
  const contexts = contextChoices(model);
  const context = loadedContext ?? 4096;
  const lengths = LENGTHS.filter((n) => n <= context / 2);
  const custom = Object.keys(gen).length > 0;
  const set = (patch: GenSettings) => setGenSettings(modelId, patch);

  /** The context size takes effect when the model is loaded again. */
  async function setContext(n: number | undefined) {
    await set({ contextWindow: n });
    onReload();
    start(modelId);
  }

  return (
    <div class="section gen">
      <div class="row spread">
        <h3>{t('Generation · {model}', { model: model.displayName })}</h3>
        {custom && (
          <button
            class="btn btn-sm btn-ghost"
            onClick={async () => {
              const reload = gen.contextWindow !== undefined;
              await setGenSettings(modelId, null);
              if (reload) { onReload(); start(modelId); }
            }}
          >
            {t('Reset to Auto')}
          </button>
        )}
      </div>

      <label class="gen-field">
        <span class="row spread"><span>{t('Temperature')}</span><span class="gen-value">{gen.temperature?.toLocaleString(locale, { minimumFractionDigits: 2 }) ?? (model.reasoning ? t('Auto (0.3, or 0.6 while thinking)') : t('Auto (0.3)'))}</span></span>
        <input type="range" min="0" max="1.5" step="0.05" value={gen.temperature ?? 0.3} onInput={(e) => set({ temperature: Number(e.currentTarget.value) })} />
        <span class="small muted">{t('Lower is focused and consistent (best for tools and facts); higher is more varied and creative.')}</span>
      </label>

      <label class="gen-field">
        <span class="row spread"><span>Top-p</span><span class="gen-value">{gen.topP?.toLocaleString(locale, { minimumFractionDigits: 2 }) ?? t('Auto (model default)')}</span></span>
        <input type="range" min="0.1" max="1" step="0.05" value={gen.topP ?? 1} onInput={(e) => set({ topP: Number(e.currentTarget.value) })} />
        <span class="small muted">{t('Only words within this share of the probability are considered. Lower cuts off unlikely words.')}</span>
      </label>

      <div class="gen-field">
        <span class="row spread"><span>{t('Answer length')}</span><span class="gen-value">{gen.maxTokens ? t('{n} tokens', { n: gen.maxTokens.toLocaleString(locale) }) : t('Auto')}</span></span>
        <div class="seg">
          <button class={gen.maxTokens === undefined ? 'seg-btn on' : 'seg-btn'} onClick={() => set({ maxTokens: undefined })}>{t('Auto')}</button>
          {lengths.map((n) => (
            <button class={gen.maxTokens === n ? 'seg-btn on' : 'seg-btn'} onClick={() => set({ maxTokens: n })}>{n >= 1024 ? `${n / 1024}k` : n}</button>
          ))}
        </div>
        <span class="small muted">
          {model.reasoning
            ? t('Most tokens per answer (a token is about ¾ of a word). Auto: 512, or {n} while thinking. At most half of the context.', { n: context <= 2048 ? '1k' : '2k' })
            : t('Most tokens per answer (a token is about ¾ of a word). Auto: 512. At most half of the context.')}
        </span>
      </div>

      <div class="gen-field">
        <span class="row spread"><span>{t('Context size')}</span><span class="gen-value">{t('{n} tokens', { n: context.toLocaleString(locale) })}</span></span>
        {contexts.length ? (
          <>
            <div class="seg">
              <button class={gen.contextWindow === undefined ? 'seg-btn on' : 'seg-btn'} disabled={boot.kind !== 'ready'} onClick={() => gen.contextWindow !== undefined && setContext(undefined)}>{t('Auto')}</button>
              {contexts.map((n) => (
                <button class={gen.contextWindow === n ? 'seg-btn on' : 'seg-btn'} disabled={boot.kind !== 'ready'} onClick={() => gen.contextWindow !== n && setContext(n)}>{n / 1024}k</button>
              ))}
            </div>
            <span class="small muted">
              {t('How much of the conversation the model keeps in mind; beyond it, older messages are summarized. Bigger uses more GPU memory and makes long prompts slower, and local models recall less well far back in a very long context. Changing it reloads the model. If loading fails, go back to Auto.')}
            </span>
          </>
        ) : (
          <span class="small muted">{t('Fixed on phones: a longer prompt needs a bigger GPU buffer than phones allow.')}</span>
        )}
      </div>
    </div>
  );
}
