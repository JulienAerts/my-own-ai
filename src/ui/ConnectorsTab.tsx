// Settings → Connectors (desktop): MCP servers that give the assistant tools.
import { useState } from 'preact/hooks';
import { addServers, parseServers, reconnect, removeServer, updateServer, useMcp, type McpServerConfig, type ServerStatus } from '../mcp/mcp';
import { RetryIcon, TrashIcon } from './icons';
import { FoldersSection } from './FoldersSection';
import { LocalApiSection } from './LocalApiSection';
import { PythonSection } from './PythonSection';
import { t, tj, tn } from '../i18n/i18n';

const EXAMPLES: { label: string; needs: string; json: string }[] = [
  {
    label: t('Files in a folder'),
    needs: 'Node.js',
    json: JSON.stringify({ mcpServers: { files: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', 'C:\\Users\\you\\Documents'] } } }, null, 2),
  },
  {
    label: t('Fetch web pages'),
    needs: 'uv (Python)',
    json: JSON.stringify({ mcpServers: { fetch: { command: 'uvx', args: ['mcp-server-fetch'] } } }, null, 2),
  },
  {
    label: t('Remote server (URL)'),
    needs: t('nothing'),
    json: JSON.stringify({ mcpServers: { example: { url: 'https://example.com/mcp', headers: { Authorization: 'Bearer …' } } } }, null, 2),
  },
];

export function ConnectorsTab() {
  const { servers, status } = useMcp();
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function add() {
    setError(null);
    try {
      const list = parseServers(text);
      if (!list.length) throw new Error(t('No server found in this text.'));
      await addServers(list);
      setText('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <>
      <p class="muted small">
        {tj('Connectors give the assistant more tools through MCP (Model Context Protocol), the standard used by Claude, ChatGPT and LM Studio: your files, GitHub, databases, Home Assistant and hundreds more. Tools that may change something ask you first. Local servers run on this PC; most need Node.js ({npx}) or uv ({uvx}) installed.', { npx: <code>npx</code>, uvx: <code>uvx</code> })}
      </p>

      <FoldersSection />

      {servers.map((s) => <ServerCard s={s} st={status(s.id)} />)}

      <div class="section">
        <h3>{t('Add a connector')}</h3>
        <p class="small muted">
          {tj('Paste its configuration: the {block} block from Claude Desktop’s config or a server’s README works as is.', { block: <code>mcpServers</code> })}
        </p>
        <div class="row">
          {EXAMPLES.map((ex) => (
            <button class="btn btn-sm btn-ghost" title={t('Needs {what}', { what: ex.needs })} onClick={() => setText(ex.json)}>{ex.label}</button>
          ))}
        </div>
        <textarea
          class="config-input"
          rows={7}
          spellcheck={false}
          placeholder={'{\n  "mcpServers": {\n    "name": { "command": "npx", "args": ["-y", "package"] }\n  }\n}'}
          value={text}
          onInput={(e) => setText(e.currentTarget.value)}
        />
        {error && <p class="alert small">{error}</p>}
        <button class="btn btn-primary" disabled={!text.trim()} onClick={add}>{t('Add')}</button>
      </div>

      <PythonSection />

      <LocalApiSection />
    </>
  );
}

function ServerCard({ s, st }: { s: McpServerConfig; st: ServerStatus }) {
  const [open, setOpen] = useState(false);
  const what = s.transport === 'http' ? s.url : [s.command, ...(s.args ?? [])].join(' ');
  return (
    <div class="section connector">
      <div class="row spread">
        <span class="connector-name">
          <span class={`dot dot-${st.state}`} />
          <strong>{s.name}</strong>
          <span class="muted small">
            {st.state === 'ready' ? tn(st.tools.length, '{n} tool', '{n} tools') : st.state === 'starting' ? t('Starting…') : st.state === 'error' ? t('Not working') : t('Off')}
          </span>
        </span>
        <span class="row">
          <button class="icon-btn" title={t('Restart')} aria-label={t('Restart {name}', { name: s.name })} disabled={!s.enabled} onClick={() => reconnect(s.id)}><RetryIcon /></button>
          <button class="icon-btn" title={t('Remove')} aria-label={t('Remove {name}', { name: s.name })} onClick={() => confirm(t('Remove {name}?', { name: s.name })) && removeServer(s.id)}><TrashIcon /></button>
          <input type="checkbox" class="switch" checked={s.enabled} aria-label={t('{name} on', { name: s.name })} onChange={(e) => updateServer(s.id, { enabled: e.currentTarget.checked })} />
        </span>
      </div>
      <code class="small connector-cmd">{what}</code>
      {st.state === 'error' && <pre class="alert small connector-error">{st.message}</pre>}
      {st.state === 'ready' && st.tools.length > 0 && (
        <details open={open} onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
          <summary class="small">{t('Tools')}</summary>
          <ul class="connector-tools">
            {st.tools.map((tool) => (
              <li>
                <span>{tool.title ?? tool.name}</span>
                {tool.annotations?.readOnlyHint ? <span class="pill">{t('read-only')}</span>
                  : (s.alwaysAllow ?? []).includes(tool.name)
                    ? <button class="pill" title={t('Ask again before using it')} onClick={() => updateServer(s.id, { alwaysAllow: (s.alwaysAllow ?? []).filter((n) => n !== tool.name) })}>{t('always allowed ✕')}</button>
                    : <span class="pill pill-accent">{t('asks first')}</span>}
                {tool.description && <span class="muted small">{tool.description.split('\n')[0].slice(0, 140)}</span>}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
