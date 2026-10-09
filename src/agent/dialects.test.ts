import { describe, expect, it } from 'vitest';
import { dialectFor, splitThinking } from './dialects';
import type { ToolDef } from './tools';

const calc = { name: 'calculator', label: '', summary: '', description: 'Arithmetic', params: { expression: { description: 'e', example: '2+2' } }, run: () => '' } as ToolDef;

describe('splitThinking', () => {
  it('separates thoughts from the answer', () => {
    expect(splitThinking('<think>\nhmm\n</think>\n\nHello')).toEqual({ thinking: 'hmm', done: true, rest: 'Hello' });
  });
  it('reports thinking in progress', () => {
    expect(splitThinking('<think>\nLet me')).toEqual({ thinking: 'Let me', done: false, rest: '' });
    expect(splitThinking('<thi')).toEqual({ thinking: '', done: false, rest: '' });
  });
  it('drops the empty block WebLLM adds when thinking is off', () => {
    expect(splitThinking('<think>\n\n</think>\n\nHi').rest).toBe('Hi');
  });
  it('drops a repeated <think> (templates that open one themselves)', () => {
    expect(splitThinking('<think><think>\nidea</think>ok').thinking).toBe('idea');
  });
  it('reads thoughts when the template opened <think> itself', () => {
    expect(splitThinking('Let me see.\n</think>\n\nHello', true)).toEqual({ thinking: 'Let me see.', done: true, rest: 'Hello' });
    expect(splitThinking('Still thinking', true)).toEqual({ thinking: 'Still thinking', done: false, rest: '' });
  });
  it('keeps only the final answer when the model closes </think> twice', () => {
    const out = '<think>\nI generated it.\n</think>\n\nDraft answer.\n</think>\n\nFinal answer.';
    expect(splitThinking(out, true)).toEqual({ thinking: 'I generated it.\n\nDraft answer.', done: true, rest: 'Final answer.' });
  });
  it('leaves plain answers alone', () => {
    expect(splitThinking('Hello')).toEqual({ done: true, rest: 'Hello' });
  });
});

describe('Hermes / Qwen grammar', () => {
  it('uses rule names llama.cpp accepts (no underscores)', () => {
    const g = (dialectFor('hermes', { toolRole: false, tools: [calc] }).responseFormat(false) as { grammar: string }).grammar;
    for (const rule of g.matchAll(/^(\S+) ::=/gm)) expect(rule[1]).toMatch(/^[a-zA-Z0-9-]+$/);
  });
  it('lets Qwen3 think before a name-first tool call', () => {
    const g = (dialectFor('hermes', { toolRole: false, tools: [calc], reasoning: true, thinking: true }).responseFormat(false) as { grammar: string }).grammar;
    expect(g).toMatch(/^root ::= think \(toolcall \| reply toolcall\?\)/m);
    expect(g).toContain('{\\"name\\": \\"calculator\\", \\"arguments\\": {');
  });
  it('parses a tool call', () => {
    const d = dialectFor('hermes', { toolRole: false, tools: [calc], reasoning: true });
    expect(d.parse('<tool_call>\n{"name": "calculator", "arguments": {"expression": "2+2"}}\n</tool_call>'))
      .toEqual({ kind: 'tool', name: 'calculator', args: { expression: '2+2' } });
  });
});

describe('JSON dialect', () => {
  it('parses replies and tool calls', () => {
    const d = dialectFor('json', { toolRole: false, tools: [calc] });
    expect(d.parse('{"action": "reply", "text": "Hi"}')).toEqual({ kind: 'reply', text: 'Hi' });
    expect(d.parse('{"action": "calculator", "expression": "1+1"}')).toEqual({ kind: 'tool', name: 'calculator', args: { expression: '1+1' } });
  });
});

describe('tool call after a lead-in', () => {
  const calc = { name: 'calculator', label: '', summary: '', description: 'Calculator', params: { expression: { description: 'x', example: '1+1' } }, run: () => '' } as never;
  const d = dialectFor('hermes', { toolRole: false, tools: [calc], reasoning: true });
  it('runs the call and drops the lead-in', () => {
    expect(d.parse('Let me call the calculator:\n\n<tool_call>\n{"name": "calculator", "arguments": {"expression": "2+2"}}\n</tool_call>'))
      .toEqual({ kind: 'tool', name: 'calculator', args: { expression: '2+2' } });
  });
  it('hides the call while it streams', () => {
    expect(d.partialReply('Let me check.\n<tool_c')).toBe('Let me check.\n');
    expect(d.partialReply('Let me check.\n<tool_call>\n{"na')).toBeNull();
  });
  it('lets a reply be followed by a call in the grammar, but no "<tool_" inside a reply', () => {
    const g = (d.responseFormat(false) as { grammar: string }).grammar;
    expect(g).toMatch(/root ::= \(toolcall \| reply toolcall\?\)/);
    expect(g).toMatch(/rchr ::= .*"l" \[\^_</);
  });
});
