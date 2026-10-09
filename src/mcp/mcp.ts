// MCP (Model Context Protocol) connectors: servers that give the assistant
// tools (files, GitHub, databases, Home Assistant…). Two transports:
//  - stdio: a local program (command + args), started by the desktop app
//    (src-tauri/src/mcp.rs), one JSON-RPC message per line;
//  - http: a remote server (Streamable HTTP), through the HTTP plugin.
// Their tools join the app's tools; tools not marked read-only ask first.
import { useEffect, useState } from 'preact/hooks';
import { getSetting, newChatId, setSetting } from '../db';
import { isDesktopApp } from '../native';
import { tauriFetch } from '../net/http';
import type { ToolContext, ToolDef, ToolOutput } from '../agent/tools';

const PROTOCOL = '2025-06-18';
const CALL_TIMEOUT_MS = 120_000;

export interface McpServerConfig {
  id: string;
  name: string;
  enabled: boolean;
  transport: 'stdio' | 'http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  /** Tools the user allowed without asking ("Always allow"). */
  alwaysAllow?: string[];
}

interface McpToolInfo {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: { properties?: Record<string, JsonSchema>; required?: string[] };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; title?: string };
}

interface JsonSchema { type?: string | string[]; description?: string; enum?: unknown[]; default?: unknown; items?: JsonSchema }

export type ServerStatus =
  | { state: 'off' }
  | { state: 'starting' }
  | { state: 'ready'; tools: McpToolInfo[] }
  | { state: 'error'; message: string };

// ---------------------------------------------------------------------------
// Config

/** Accepts Claude Desktop's format ({"mcpServers": {...}}), a name→server map, or one server. */
export function parseServers(text: string): Omit<McpServerConfig, 'id'>[] {
  const json = JSON.parse(text) as Record<string, unknown>;
  const map = (json.mcpServers ?? json.servers ?? (('command' in json || 'url' in json) ? { [String(json.name ?? 'server')]: json } : json)) as Record<string, Record<string, unknown>>;
  return Object.entries(map).map(([name, s]) => {
    const url = typeof s.url === 'string' ? s.url : undefined;
    if (!url && typeof s.command !== 'string') throw new Error(`"${name}" has neither a command nor a url.`);
    return {
      name,
      enabled: true,
      transport: url ? 'http' : 'stdio',
      ...(url ? { url, headers: (s.headers as Record<string, string>) ?? undefined } : {
        command: s.command as string,
        args: Array.isArray(s.args) ? s.args.map(String) : [],
        env: (s.env as Record<string, string>) ?? undefined,
      }),
    };
  });
}

let servers: McpServerConfig[] = [];
let loaded: Promise<void> | null = null;
const statuses = new Map<string, ServerStatus>();
const subs = new Set<() => void>();
const notify = () => subs.forEach((fn) => fn());

function loadConfig(): Promise<void> {
  loaded ??= getSetting('mcpServers').then((v) => { servers = v ?? []; }).catch(() => {});
  return loaded;
}

async function saveConfig(next: McpServerConfig[]) {
  servers = next;
  notify();
  await setSetting('mcpServers', next);
}

export async function addServers(list: Omit<McpServerConfig, 'id'>[]): Promise<void> {
  await loadConfig();
  const added = list.map((s) => ({ ...s, id: newChatId() }));
  await saveConfig([...servers, ...added]);
  for (const s of added) if (s.enabled) void connect(s);
}

export async function updateServer(id: string, patch: Partial<McpServerConfig>): Promise<void> {
  await loadConfig();
  const next = servers.map((s) => (s.id === id ? { ...s, ...patch } : s));
  await saveConfig(next);
  const s = next.find((x) => x.id === id)!;
  if ('enabled' in patch || 'command' in patch || 'args' in patch || 'env' in patch || 'url' in patch) {
    disconnect(id);
    if (s.enabled) void connect(s);
  }
}

export async function removeServer(id: string): Promise<void> {
  disconnect(id);
  await loadConfig();
  await saveConfig(servers.filter((s) => s.id !== id));
}

export function useMcp(): { servers: McpServerConfig[]; status(id: string): ServerStatus } {
  const [, bump] = useState(0);
  useEffect(() => {
    const fn = () => bump((n) => n + 1);
    subs.add(fn);
    loadConfig().then(fn);
    return () => void subs.delete(fn);
  }, []);
  return { servers, status: (id) => statuses.get(id) ?? { state: 'off' } };
}

// ---------------------------------------------------------------------------
// Connections

interface Pending { resolve(v: unknown): void; reject(e: Error): void; timer: number }

class Connection {
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private session?: string;
  closed = false;

  constructor(readonly cfg: McpServerConfig) {}

  async open(): Promise<McpToolInfo[]> {
    if (this.cfg.transport === 'stdio') {
      const { invoke, Channel } = await import('@tauri-apps/api/core');
      const ch = new Channel<string>();
      ch.onmessage = (line) => this.receive(line);
      await invoke('mcp_start', {
        id: this.cfg.id, program: this.cfg.command, args: this.cfg.args ?? [], env: this.cfg.env ?? {}, onMessage: ch,
      });
    }
    await this.request('initialize', {
      protocolVersion: PROTOCOL,
      capabilities: {},
      clientInfo: { name: 'my-own-ai', title: 'My Own AI', version: '0.4' },
    }, 120_000); // some servers check their app first (Blender's waits on Blender's main thread)
    await this.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    return this.listTools();
  }

  async listTools(): Promise<McpToolInfo[]> {
    const tools: McpToolInfo[] = [];
    let cursor: string | undefined;
    do {
      const r = await this.request('tools/list', cursor ? { cursor } : {}) as { tools: McpToolInfo[]; nextCursor?: string };
      tools.push(...(r.tools ?? []));
      cursor = r.nextCursor;
    } while (cursor && tools.length < 500);
    return tools;
  }

  callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    return this.request('tools/call', { name, arguments: args }, CALL_TIMEOUT_MS);
  }

  request(method: string, params: unknown, timeoutMs = 30_000): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.cfg.name} didn't answer ${method} in ${timeoutMs / 1000} s.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: '2.0', id, method, params }).catch((e) => {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      });
    });
  }

  private async send(msg: Record<string, unknown>): Promise<void> {
    if (this.cfg.transport === 'stdio') {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('mcp_send', { id: this.cfg.id, line: JSON.stringify(msg) });
      return;
    }
    // Streamable HTTP: POST each message; responses come back as JSON or as SSE events.
    const fetch = isDesktopApp
      ? (url: string, init: RequestInit) => tauriFetch(url, init, `Connector: ${this.cfg.name}`)
      : globalThis.fetch;
    const res = await fetch(this.cfg.url!, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': PROTOCOL,
        ...(this.session && { 'Mcp-Session-Id': this.session }),
        ...this.cfg.headers,
      },
      body: JSON.stringify(msg),
    });
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.session = sid;
    if (!res.ok) throw new Error(`${this.cfg.name}: HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`);
    const type = res.headers.get('content-type') ?? '';
    const body = await res.text();
    if (!body.trim()) return;
    if (type.includes('text/event-stream')) {
      for (const block of body.split(/\r?\n\r?\n/)) {
        const data = block.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
        if (data) this.receive(data);
      }
    } else this.receive(body);
  }

  private receive(line: string) {
    let msg: { id?: number | string; result?: unknown; error?: { message?: string }; method?: string; __exit?: boolean } | unknown[];
    try {
      msg = JSON.parse(line);
    } catch {
      return; // a server logging to stdout
    }
    if (Array.isArray(msg)) return msg.forEach((m) => this.receive(JSON.stringify(m)));
    if (msg.__exit) return this.fail('The server stopped.');
    if (msg.method && msg.id !== undefined) {
      // A request from the server: answer pings, decline the rest (sampling, roots…).
      void this.send(msg.method === 'ping'
        ? { jsonrpc: '2.0', id: msg.id, result: {} }
        : { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Not supported by this client' } }).catch(() => {});
      return;
    }
    if (msg.method === 'notifications/tools/list_changed') {
      void this.listTools().then((tools) => setStatus(this.cfg.id, { state: 'ready', tools })).catch(() => {});
      return;
    }
    if (typeof msg.id !== 'number') return;
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) p.reject(new Error(msg.error.message ?? 'MCP error'));
    else p.resolve(msg.result);
  }

  private async fail(reason: string) {
    if (this.closed) return;
    this.closed = true;
    let detail = '';
    if (this.cfg.transport === 'stdio') {
      const { invoke } = await import('@tauri-apps/api/core');
      detail = await invoke<string>('mcp_stderr', { id: this.cfg.id }).catch(() => '');
    }
    const message = `${reason}${detail ? `\n${detail.split('\n').slice(-6).join('\n')}` : ''}`;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error(message)); }
    this.pending.clear();
    if (connections.get(this.cfg.id) === this) {
      connections.delete(this.cfg.id);
      setStatus(this.cfg.id, { state: 'error', message });
    }
  }

  close() {
    this.closed = true;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('Disconnected.')); }
    this.pending.clear();
    if (this.cfg.transport === 'stdio') void import('@tauri-apps/api/core').then(({ invoke }) => invoke('mcp_stop', { id: this.cfg.id })).catch(() => {});
  }
}

const connections = new Map<string, Connection>();

function setStatus(id: string, s: ServerStatus) {
  statuses.set(id, s);
  notify();
}

async function connect(cfg: McpServerConfig): Promise<void> {
  if (cfg.transport === 'stdio' && !isDesktopApp) return setStatus(cfg.id, { state: 'error', message: 'Local servers need the desktop app.' });
  const c = new Connection(cfg);
  connections.set(cfg.id, c);
  setStatus(cfg.id, { state: 'starting' });
  try {
    const tools = await c.open();
    if (connections.get(cfg.id) === c) setStatus(cfg.id, { state: 'ready', tools });
  } catch (e) {
    if (connections.get(cfg.id) !== c) return;
    let message = e instanceof Error ? e.message : String(e);
    // A local server that never answered: its log usually says why (Blender not answering, a missing package…).
    if (cfg.transport === 'stdio' && !message.includes('\n')) {
      const { invoke } = await import('@tauri-apps/api/core');
      const log = await invoke<string>('mcp_stderr', { id: cfg.id }).catch(() => '');
      if (log.trim()) message += `\n${log.trim().split('\n').slice(-6).join('\n')}`;
    }
    connections.delete(cfg.id);
    c.close();
    setStatus(cfg.id, { state: 'error', message });
  }
}

function disconnect(id: string) {
  connections.get(id)?.close();
  connections.delete(id);
  setStatus(id, { state: 'off' });
}

/** Start every enabled server (once per session). */
let started = false;
export async function startMcp(): Promise<void> {
  if (started) return;
  started = true;
  await loadConfig();
  for (const s of servers) if (s.enabled) void connect(s);
}

export async function reconnect(id: string): Promise<void> {
  await loadConfig();
  const s = servers.find((x) => x.id === id);
  disconnect(id);
  if (s?.enabled) await connect(s);
}

// ---------------------------------------------------------------------------
// Tools for the model

/** Asked before a tool that may change something runs ("Allow once / Always / Deny"). */
export interface ApprovalRequest {
  server: string;
  tool: string;
  /** Asked every time (Python on the PC, saving a file…): no "Always allow". */
  everyTime?: boolean;
  args: Record<string, unknown>;
}
export type Approval = 'once' | 'always' | 'deny';

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 20) || 'mcp';

function typeOf(p: JsonSchema): string {
  return (Array.isArray(p.type) ? p.type.find((t) => t !== 'null') : p.type) ?? 'string';
}

/** The model writes every argument as a string; give the server the types it declared. */
function coerce(args: Record<string, string>, schema: McpToolInfo['inputSchema']): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const required = new Set(schema?.required ?? []);
  for (const [k, raw] of Object.entries(args)) {
    const p = schema?.properties?.[k] ?? {};
    const v = String(raw ?? '');
    if (v === '' && !required.has(k)) continue; // optional and left out
    const t = typeOf(p);
    if (t === 'number' || t === 'integer') {
      const n = Number(v);
      out[k] = Number.isNaN(n) ? v : t === 'integer' ? Math.round(n) : n;
    } else if (t === 'boolean') out[k] = /^(true|yes|1)$/i.test(v.trim());
    else if (t === 'array' || t === 'object') {
      try {
        out[k] = JSON.parse(v);
      } catch {
        out[k] = t === 'array' ? v.split(',').map((x) => x.trim()).filter(Boolean) : v;
      }
    } else out[k] = v;
  }
  return out;
}

function format(result: unknown, maxChars: number): ToolOutput {
  const r = (result ?? {}) as { content?: { type: string; text?: string; data?: string; mimeType?: string; resource?: { text?: string; uri?: string } }[]; structuredContent?: unknown; isError?: boolean };
  const texts: string[] = [];
  const images: string[] = [];
  for (const c of r.content ?? []) {
    if (c.type === 'text' && c.text) texts.push(c.text);
    else if (c.type === 'image' && c.data && /^image\/(png|jpeg|webp|gif)$/.test(c.mimeType ?? '')) images.push(`data:${c.mimeType};base64,${c.data}`);
    else if (c.type === 'resource' && c.resource) texts.push(c.resource.text ?? `[resource ${c.resource.uri ?? ''}]`);
  }
  if (!texts.length && r.structuredContent !== undefined) texts.push(JSON.stringify(r.structuredContent));
  let text = texts.join('\n').trim() || (images.length ? '(An image is shown to the user.)' : '(No output.)');
  if (text.length > maxChars) text = `${text.slice(0, maxChars)}… [cut: ${text.length} characters in total]`;
  return { text, images, error: !!r.isError };
}

/** The tools of every connected server, as app tools. */
export function mcpTools(): ToolDef[] {
  const out: ToolDef[] = [];
  for (const s of servers) {
    const st = statuses.get(s.id);
    if (!s.enabled || st?.state !== 'ready') continue;
    for (const t of st.tools) {
      const props = t.inputSchema?.properties ?? {};
      const required = new Set(t.inputSchema?.required ?? []);
      const name = `${slug(s.name)}__${t.name}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
      out.push({
        name,
        label: t.title ?? t.annotations?.title ?? t.name,
        summary: (t.description ?? '').split('\n')[0].slice(0, 120),
        service: s.name,
        description: `${(t.description ?? t.title ?? t.name).replace(/\s+/g, ' ').slice(0, 300)} (${s.name})`,
        params: Object.fromEntries(Object.entries(props).map(([k, p]) => {
          const t2 = typeOf(p);
          const hint = [t2 !== 'string' && t2, p.enum && `one of ${p.enum.map(String).join(', ')}`, !required.has(k) && 'optional, "" to skip', (t2 === 'array' || t2 === 'object') && 'as JSON']
            .filter(Boolean).join('; ');
          return [k, { description: `${(p.description ?? k).slice(0, 160)}${hint ? ` (${hint})` : ''}`, example: p.default !== undefined ? String(p.default) : '' }];
        })),
        mcp: { serverId: s.id, server: s.name, tool: t.name, readOnly: !!t.annotations?.readOnlyHint },
        run: async (args, ctx) => {
          const c = connections.get(s.id);
          if (!c) throw new Error(`${s.name} is not connected.`);
          const typed = coerce(args, t.inputSchema);
          const trusted = t.annotations?.readOnlyHint || (s.alwaysAllow ?? []).includes(t.name);
          if (!trusted) {
            const answer = ctx?.confirm ? await ctx.confirm({ server: s.name, tool: t.title ?? t.name, args: typed }) : 'deny';
            if (answer === 'deny') return { text: 'The user declined this action.', error: true };
            if (answer === 'always') await updateServer(s.id, { alwaysAllow: [...new Set([...(s.alwaysAllow ?? []), t.name])] });
          }
          return format(await c.callTool(t.name, typed), ctx?.maxChars ?? 2400);
        },
      });
    }
  }
  return out;
}

const words = (s: string) => new Set((s.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []));

/**
 * MCP tools for this message: all of them when there are few, else the ones
 * whose name, description or server best match the message (a server with 40
 * tools would otherwise fill the prompt).
 */
export function mcpToolsForTurn(message: string, max: number): ToolDef[] {
  const all = mcpTools();
  if (all.length <= max) return all;
  const q = words(message);
  return all
    .map((t, i) => {
      const hay = words(`${t.name} ${t.description} ${t.service}`);
      let score = 0;
      for (const w of q) if (hay.has(w)) score++;
      if (t.service && message.toLowerCase().includes(t.service.toLowerCase())) score += 3;
      return { t, score, i };
    })
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, max)
    .map((x) => x.t);
}

// Tool context: how the chat asks the user (see ChatPage's approval card).
export type Confirm = NonNullable<ToolContext['confirm']>;
