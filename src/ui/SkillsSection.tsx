// Settings → Tools → Skills: import, write, switch on/off and edit skills.
import { useRef, useState } from 'preact/hooks';
import { EXAMPLE_SKILL, deleteSkill, parseSkillMd, readSkillFile, saveSkill, setSkillEnabled, useSkills, type Skill } from '../skills/skills';
import { EditIcon, TrashIcon } from './icons';
import { t, tj, tn } from '../i18n/i18n';

type Draft = { id?: string; name: string; description: string; body: string; files: Skill['files']; enabled: boolean };

export function SkillsSection() {
  const skills = useSkills();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  async function importFiles(files: FileList | null) {
    setError(null);
    for (const f of files ?? []) {
      try {
        await saveSkill(await readSkillFile(f));
      } catch (e) {
        setError(`${f.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (input.current) input.current.value = '';
  }

  async function addExample() {
    const p = parseSkillMd(EXAMPLE_SKILL);
    await saveSkill({ name: p.name!, description: p.description!, body: p.body, files: [], enabled: true });
  }

  if (draft) return <SkillEditor draft={draft} onDone={() => setDraft(null)} />;

  return (
    <div class="section">
      <h3>{t('Skills')}</h3>
      <p class="small muted">
        {tj('A skill is a set of instructions (and optional files) for a kind of task: a report format, a checklist, a script. The assistant sees each skill’s description and opens it when a task calls for it. Import a skill folder as a {zip} or its {md}, or write one.', { zip: <code>.zip</code>, md: <code>SKILL.md</code> })}
      </p>
      {skills?.length ? (
        <ul class="skills">
          {skills.map((s) => (
            <li>
              <div class="skill-info">
                <strong>{s.name}</strong>
                <span class="muted small">{s.description}</span>
                {s.files.length > 0 && <span class="muted small">{tn(s.files.length, '{n} file', '{n} files')}: {s.files.slice(0, 4).map((f) => f.path).join(', ')}{s.files.length > 4 ? '…' : ''}</span>}
              </div>
              <button class="icon-btn" aria-label={t('Edit {name}', { name: s.name })} title={t('Edit')} onClick={() => setDraft({ ...s })}><EditIcon /></button>
              <button class="icon-btn" aria-label={t('Delete {name}', { name: s.name })} title={t('Delete')} onClick={() => confirm(t('Delete the skill {name}?', { name: s.name })) && deleteSkill(s.id)}><TrashIcon /></button>
              <input type="checkbox" class="switch" aria-label={t('{name} on', { name: s.name })} checked={s.enabled} onChange={(e) => setSkillEnabled(s.id, e.currentTarget.checked)} />
            </li>
          ))}
        </ul>
      ) : skills && <p class="small muted">{t('No skills yet.')}</p>}
      {error && <p class="alert small">{error}</p>}
      <div class="row">
        <button class="btn btn-sm" onClick={() => input.current?.click()}>{t('Import (.zip or SKILL.md)')}</button>
        <button class="btn btn-sm" onClick={() => setDraft({ name: '', description: '', body: '', files: [], enabled: true })}>{t('Write a skill')}</button>
        {!skills?.some((s) => s.name === 'meeting-notes') && <button class="btn btn-sm btn-ghost" onClick={addExample}>{t('Add an example')}</button>}
      </div>
      <input ref={input} type="file" accept=".zip,.md,application/zip,text/markdown" multiple hidden onChange={(e) => importFiles(e.currentTarget.files)} />
    </div>
  );
}

function SkillEditor({ draft, onDone }: { draft: Draft; onDone(): void }) {
  const [d, setD] = useState(draft);
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<Draft>) => setD((x) => ({ ...x, ...patch }));

  async function save() {
    const name = d.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    if (!name || !d.description.trim() || !d.body.trim()) return setError(t('A skill needs a name, a description and instructions.'));
    await saveSkill({ ...d, name, description: d.description.trim(), body: d.body.trim() });
    onDone();
  }

  return (
    <div class="section assistant-editor">
      <h3>{d.id ? t('Edit {name}', { name: d.name }) : t('New skill')}</h3>
      <label class="field">
        <span>{t('Name')}</span>
        <input class="search-input" placeholder={t('e.g. weekly-report')} value={d.name} onInput={(e) => set({ name: e.currentTarget.value })} />
      </label>
      <label class="field">
        <span>{t('When to use it')}</span>
        <textarea rows={2} placeholder={t('e.g. Write the weekly status report. Use when the user asks for their weekly report or update.')} value={d.description} onInput={(e) => set({ description: e.currentTarget.value })} />
        <span class="small muted">{t('The assistant only sees this until it opens the skill: say what it does and when to use it.')}</span>
      </label>
      <label class="field">
        <span>{t('Instructions')}</span>
        <textarea rows={10} class="config-input" placeholder={t('# Weekly report\n\nSections: Done, Next, Blockers…')} value={d.body} onInput={(e) => set({ body: e.currentTarget.value })} />
      </label>
      {d.files.length > 0 && <p class="small muted">{t('Files kept with it: {list}', { list: d.files.map((f) => f.path).join(', ') })}</p>}
      {error && <p class="alert small">{error}</p>}
      <div class="row" style={{ justifyContent: 'flex-end' }}>
        <button class="btn btn-sm btn-ghost" onClick={onDone}>{t('Cancel')}</button>
        <button class="btn btn-sm btn-primary" onClick={save}>{t('Save')}</button>
      </div>
    </div>
  );
}
