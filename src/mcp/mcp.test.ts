import { describe, expect, it } from 'vitest';
import { parseServers } from './mcp';

describe('parseServers', () => {
  it("reads Claude Desktop's mcpServers block", () => {
    const list = parseServers(JSON.stringify({ mcpServers: {
      files: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', 'C:\\x'] },
      remote: { url: 'https://example.com/mcp', headers: { Authorization: 'Bearer t' } },
    } }));
    expect(list).toEqual([
      { name: 'files', enabled: true, transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', 'C:\\x'], env: undefined },
      { name: 'remote', enabled: true, transport: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer t' } },
    ]);
  });
  it('accepts a bare name → server map', () => {
    expect(parseServers('{"time": {"command": "uvx", "args": ["mcp-server-time"]}}')[0]).toMatchObject({ name: 'time', command: 'uvx' });
  });
  it('rejects a server with neither command nor url', () => {
    expect(() => parseServers('{"mcpServers": {"x": {"args": []}}}')).toThrow(/neither a command nor a url/);
  });
});
