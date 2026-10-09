// Settings → Appearance: themes and personal style, applied live.
import { useRef, useState } from 'preact/hooks';
import { DEFAULT_APPEARANCE, THEMES, resolveTheme, setAppearance, setPicture, shrinkPicture, useAppearance, usePictures, type Appearance } from './appearance';
import { CheckIcon, Orb, ToolIcon } from './icons';
import { t } from '../i18n/i18n';

function Seg<K extends keyof Appearance>({ k, options }: { k: K; options: [Appearance[K], string][] }) {
  const a = useAppearance();
  return (
    <div class="seg" role="radiogroup">
      {options.map(([v, label]) => (
        <button class={a[k] === v ? 'seg-btn on' : 'seg-btn'} role="radio" aria-checked={a[k] === v} onClick={() => setAppearance({ [k]: v } as Partial<Appearance>)}>{label}</button>
      ))}
    </div>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: preact.ComponentChildren }) {
  return (
    <div class="look-row">
      <span class="look-label">
        <strong>{label}</strong>
        {hint && <span class="muted small">{hint}</span>}
      </span>
      {children}
    </div>
  );
}

export function AppearanceTab() {
  const a = useAppearance();
  const custom = a.theme === 'custom';
  const accent = resolveTheme(a).accent;

  return (
    <>
      {/* Live preview with the real chat styles. */}
      <div class="look-preview" aria-hidden="true">
        <div class="look-preview-head"><Orb size={20} /><strong>My Own AI</strong></div>
        <div class="msg user">{t('Plan a weekend in Ghent?')}</div>
        <div class="tool"><ToolIcon /><span class="tool-name">weather</span><span class="tool-args">(location: "Ghent")</span><span class="tool-arrow">→</span><span class="tool-result">17°C, sunny</span></div>
        <div class="msg assistant"><div class="md"><p><strong>{t('Saturday:')}</strong> {t('Gravensteen and a canal boat.')} <strong>{t('Sunday:')}</strong> {t('the Patershol, then lunch on the Graslei.')}</p></div></div>
        <div class="row"><button class="btn btn-sm btn-primary" tabIndex={-1}>{t('Button')}</button><span class="pill pill-accent">{t('Accent')}</span><a href="#" tabIndex={-1} onClick={(e) => e.preventDefault()}>{t('Link')}</a></div>
      </div>

      <div class="section">
        <h3>{t('Theme')}</h3>
        <div class="themes">
          {THEMES.map((t) => (
            <button class={a.theme === t.id ? 'theme on' : 'theme'} onClick={() => setAppearance({ theme: t.id })} aria-pressed={a.theme === t.id} title={t.name}>
              <span class="theme-swatch" style={{ '--sw': t.accent, '--sh': String(t.hue), '--st': String(t.tint) } as Record<string, string>}>
                {a.theme === t.id && <CheckIcon />}
              </span>
              <span class="small">{t.name}</span>
            </button>
          ))}
          <label class={custom ? 'theme on' : 'theme'} title={t('Pick any colour')}>
            <span class="theme-swatch theme-custom" style={{ '--sw': custom ? accent : 'conic-gradient(red, orange, yellow, lime, cyan, blue, magenta, red)' } as Record<string, string>}>
              {custom && <CheckIcon />}
              <input type="color" value={custom ? accent : '#5b5bf0'} onInput={(e) => setAppearance({ theme: 'custom', accent: e.currentTarget.value })} />
            </span>
            <span class="small">{t('Custom')}</span>
          </label>
        </div>
      </div>

      <LogoSection />
      <BackgroundSection />

      <div class="section look">
        <Row label={t('Mode')}><Seg k="mode" options={[['system', t('System')], ['light', t('Light')], ['dark', t('Dark')]]} /></Row>
        <label class="switch-row">
          <span>
            <strong>{t('Pure black')}</strong>
            <span class="muted small">{t('Black backgrounds in dark mode: easier on OLED screens and batteries.')}</span>
          </span>
          <input type="checkbox" class="switch" checked={a.black} disabled={a.mode === 'light'} onChange={(e) => setAppearance({ black: e.currentTarget.checked })} />
        </label>
        <Row label={t('Your messages')}><Seg k="bubble" options={[['gradient', t('Gradient')], ['solid', t('Solid')], ['soft', t('Soft')]]} /></Row>
        <Row label={t('Corners')}><Seg k="corners" options={[['round', t('Round')], ['soft', t('Rounded slightly')], ['sharp', t('Sharp')]]} /></Row>
      </div>

      <div class="section look">
        <Row label={t('Text size')}><Seg k="size" options={[['s', 'S'], ['m', 'M'], ['l', 'L'], ['xl', 'XL']]} /></Row>
        <Row label={t('Message font')} hint={t('For the conversation; menus keep Inter.')}>
          <Seg k="font" options={[['inter', 'Inter'], ['system', t('System')], ['serif', t('Serif')], ['rounded', t('Rounded')]]} />
        </Row>
      </div>

      {JSON.stringify(a) !== JSON.stringify(DEFAULT_APPEARANCE) && (
        <button class="btn btn-ghost" onClick={() => setAppearance(DEFAULT_APPEARANCE)}>{t('Reset to the default look')}</button>
      )}
    </>
  );
}

const EMOJIS = ['✨', '🤖', '🧠', '🦊', '🐙', '🌙', '🔮', '🌿', '🦉', '⚡'];

/** Pick a picture file and store it shrunk; reports errors inline. */
function usePicturePicker(kind: 'logo' | 'background', onDone: () => void) {
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const pick = () => input.current?.click();
  const field = (
    <input ref={input} type="file" accept="image/*" hidden onChange={async (e) => {
      const file = e.currentTarget.files?.[0];
      e.currentTarget.value = '';
      if (!file) return;
      setError(null);
      try {
        await setPicture(kind, await shrinkPicture(file, kind));
        onDone();
      } catch {
        setError(t('This picture couldn’t be read. Try a JPEG or PNG.'));
      }
    }} />
  );
  return { pick, field, error };
}

/** The app's logo: four styles, or the user's picture. */
function LogoSection() {
  const a = useAppearance();
  const pics = usePictures();
  const picker = usePicturePicker('logo', () => setAppearance({ logo: 'image' }));
  const kinds: [Appearance['logo'], string][] = [['orb', t('Orb')], ['aurora', t('Aurora')], ['halo', t('Halo')], ['emoji', t('Emoji')], ['image', t('Picture')]];
  return (
    <div class="section">
      <h3>{t('Logo')}</h3>
      <div class="choice-grid" role="radiogroup" aria-label={t('Logo')}>
        {kinds.map(([k, label]) => (
          <button
            class={a.logo === k ? 'choice on' : 'choice'}
            role="radio"
            aria-checked={a.logo === k}
            onClick={() => (k === 'image' && !pics.logo ? picker.pick() : setAppearance({ logo: k }))}
          >
            <span class="choice-art">
              {k === 'image' && !pics.logo ? <span class="choice-add">+</span> : <Orb size={40} variant={k} />}
            </span>
            <span class="small">{label}</span>
          </button>
        ))}
      </div>
      {a.logo === 'emoji' && (
        <div class="row">
          {EMOJIS.map((e) => (
            <button class={a.logoEmoji === e ? 'emoji-pick on' : 'emoji-pick'} onClick={() => setAppearance({ logoEmoji: e })} aria-label={e}>{e}</button>
          ))}
          <input class="search-input emoji-input" aria-label={t('Any emoji')} maxLength={8} value={a.logoEmoji} onInput={(e) => setAppearance({ logoEmoji: e.currentTarget.value.trim() || '✨' })} />
        </div>
      )}
      {a.logo === 'image' && pics.logo && (
        <div class="row">
          <button class="btn btn-sm" onClick={picker.pick}>{t('Choose another picture…')}</button>
          <button class="btn btn-sm btn-ghost" onClick={async () => { await setPicture('logo', null); await setAppearance({ logo: 'orb' }); }}>{t('Remove the picture')}</button>
        </div>
      )}
      {picker.error && <p class="alert small">{picker.error}</p>}
      {picker.field}
    </div>
  );
}

/** The background behind every screen, or the user's picture with a tone slider. */
function BackgroundSection() {
  const a = useAppearance();
  const pics = usePictures();
  const picker = usePicturePicker('background', () => setAppearance({ background: 'image' }));
  const kinds: [Appearance['background'], string][] = [
    ['glow', t('Glow')], ['aurora', t('Aurora')], ['mesh', t('Mesh')], ['dots', t('Dots')], ['plain', t('Plain')], ['image', t('Picture')],
  ];
  return (
    <div class="section">
      <h3>{t('Background')}</h3>
      <div class="choice-grid" role="radiogroup" aria-label={t('Background')}>
        {kinds.map(([k, label]) => (
          <button
            class={a.background === k ? 'choice on' : 'choice'}
            role="radio"
            aria-checked={a.background === k}
            onClick={() => (k === 'image' && !pics.background ? picker.pick() : setAppearance({ background: k }))}
          >
            <span class={`choice-art bg-thumb bg-thumb-${k}`} style={k === 'image' && pics.background ? { backgroundImage: `url("${pics.background}")` } : undefined}>
              {k === 'image' && !pics.background && <span class="choice-add">+</span>}
            </span>
            <span class="small">{label}</span>
          </button>
        ))}
      </div>
      {a.background === 'aurora' && <p class="small muted">{t('Moves slowly, and pauses while the assistant writes so it never slows the model down.')}</p>}
      {a.background === 'image' && pics.background && (
        <>
          <label class="gen-field">
            <span class="row spread"><span>{t('Tone down')}</span><span class="gen-value">{Math.round((a.bgDim ?? 0.35) * 100)}%</span></span>
            <input type="range" min="0" max="0.85" step="0.05" value={a.bgDim ?? 0.35} onInput={(e) => setAppearance({ bgDim: Number(e.currentTarget.value) })} />
            <span class="small muted">{t('Blends the picture into the page colour, so text stays easy to read.')}</span>
          </label>
          <div class="row">
            <button class="btn btn-sm" onClick={picker.pick}>{t('Choose another picture…')}</button>
            <button class="btn btn-sm btn-ghost" onClick={async () => { await setPicture('background', null); await setAppearance({ background: 'glow' }); }}>{t('Remove the picture')}</button>
          </div>
        </>
      )}
      {picker.error && <p class="alert small">{picker.error}</p>}
      {picker.field}
    </div>
  );
}
