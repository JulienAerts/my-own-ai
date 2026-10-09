import { describe, expect, it } from 'vitest';
import { constraint, llamaBody, schemaGrammar } from './llama';

describe('llama.cpp requests', () => {
  it('sends a JSON schema as a plain grammar', () => {
    const schema = { type: 'object', properties: { facts: { type: 'array', items: { type: 'string' } }, n: { type: 'integer' } } };
    const c = constraint({ type: 'json_object', schema: JSON.stringify(schema) });
    expect(c.response_format).toBeUndefined();
    expect(c.grammar).toMatch(/^root ::= space v0 space$/m);
    expect(c.grammar).toContain('"\\"facts\\"" space ":" space v1 space "," space "\\"n\\"" space ":" space integer');
    expect(c.grammar).toContain('v1 ::= "[" space (string (space "," space string)*)? space "]"');
  });

  it('turns the tool-call choice into alternatives with fixed action names', () => {
    const g = schemaGrammar({
      anyOf: [
        { type: 'object', properties: { action: { type: 'string', enum: ['reply'] }, text: { type: 'string' } } },
        { type: 'object', properties: { action: { type: 'string', enum: ['calculator'] }, expression: { type: 'string' } } },
      ],
    } as never);
    expect(g).toMatch(/^root ::= space \(v0 \| v1\) space$/m);
    expect(g).toContain('("\\"calculator\\"")');
  });

  it('asks for thinking off with a schema too', () => {
    const body = llamaBody([], { responseFormat: { type: 'json_object', schema: '{"type":"object","properties":{}}' }, thinking: false, maxTokens: 10, temperature: 0 });
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
  });
});
