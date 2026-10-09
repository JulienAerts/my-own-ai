import { CHANGELOG_URL, noteItems } from '../changelog';
import { t } from '../i18n/i18n';

/** "What's new" for a version: its notes, folded, and a link to every version's changes. */
export function WhatsNew({ notes, items }: { notes?: string; items?: string[] }) {
  const list = items ?? noteItems(notes);
  return (
    <details class="whats-new">
      <summary>{t('What’s new')}</summary>
      {list.length > 0 && <ul>{list.map((item) => <li key={item}>{item}</li>)}</ul>}
      <a href={CHANGELOG_URL} target="_blank" rel="noreferrer">{t('All changes')}</a>
    </details>
  );
}
