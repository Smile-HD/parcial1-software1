/**
 * FakeLlm (task 7.3) — deterministic interpretation of the bounded command
 * vocabulary, zero network. The OpenAiLlm adapter is contract-tested for
 * wiring (response parsing) with a stubbed fetch.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { deltaJsonSchema, type Diagram } from '@app/core';

import { FakeLlm, OpenAiLlm } from './index.js';

function makeDiagram(): Diagram {
  const customerId = crypto.randomUUID();
  return {
    id: crypto.randomUUID(),
    name: 'Shop',
    classes: [
      {
        id: customerId,
        name: 'Customer',
        position: { x: 0, y: 0 },
        attributes: [{ id: crypto.randomUUID(), name: 'name', type: 'string' }],
        methods: [{ id: crypto.randomUUID(), name: 'getId', returnType: 'string', parameters: [] }],
      },
    ],
    associations: [],
  };
}

const schema = deltaJsonSchema as object;

describe('FakeLlm', () => {
  it('7.1 refuses whole-design generation (interpreter:R3)', async () => {
    const llm = new FakeLlm();
    const result = await llm.interpret('generate me a full design for a library system', schema, makeDiagram());

    expect(result.kind).toBe('refused');
    if (result.kind === 'refused') {
      expect(result.reason).toContain('explicit instruction');
    }
  });

  it('a scoped edit is accepted after a refusal (interpreter:R3 scenario 2)', async () => {
    const llm = new FakeLlm();
    const diagram = makeDiagram();
    const refused = await llm.interpret('generate me a full design for a library system', schema, diagram);
    expect(refused.kind).toBe('refused');

    const accepted = await llm.interpret('add class Book with attribute isbn: String', schema, diagram);
    expect(accepted.kind).toBe('delta');
  });

  it('add class with attribute emits a batch delta that matches the real delta schema', async () => {
    const llm = new FakeLlm();
    const result = await llm.interpret(
      'add a class Invoice with attribute total of type decimal',
      schema,
      makeDiagram(),
    );

    expect(result.kind).toBe('delta');
    if (result.kind !== 'delta') return;
    const value = result.value as { kind: string; deltas?: { kind: string; op: string }[] };
    expect(value.kind).toBe('batch');
    expect(value.deltas?.[0]).toMatchObject({ kind: 'class', op: 'create', name: 'Invoice' });
    expect(value.deltas?.[1]).toMatchObject({ kind: 'member', op: 'addAttribute', name: 'total', type: 'decimal' });
  });

  it('7.5 refuses out-of-vocabulary commands instead of guessing (interpreter:R4)', async () => {
    const llm = new FakeLlm();
    const result = await llm.interpret('make the diagram prettier', schema, makeDiagram());
    expect(result.kind).toBe('refused');
  });

  it('rename/delete reference existing classes by name', async () => {
    const llm = new FakeLlm();
    const diagram = makeDiagram();

    const renamed = await llm.interpret('rename class Customer to Client', schema, diagram);
    expect(renamed.kind).toBe('delta');

    const deleted = await llm.interpret('delete class Customer', schema, diagram);
    expect(deleted.kind).toBe('delta');

    const unknown = await llm.interpret('rename class Ghost to Phantom', schema, diagram);
    expect(unknown.kind).toBe('refused');
  });
});

describe('OpenAiLlm (wiring contract, stubbed fetch)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('parses an apply action into a delta result', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify({ action: 'apply', delta: { kind: 'class', op: 'create', id: crypto.randomUUID(), diagramId: crypto.randomUUID(), timestamp: new Date().toISOString(), classId: crypto.randomUUID(), name: 'Invoice', position: { x: 0, y: 0 } } }) } }],
        }),
      }),
    );

    const llm = new OpenAiLlm({ apiKey: 'test-key' });
    const result = await llm.interpret('add class Invoice', schema, makeDiagram());

    expect(result.kind).toBe('delta');
  });

  it('parses a refuse action into a refusal result', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify({ action: 'refuse', reason: 'I edit, not generate.' }) } }],
        }),
      }),
    );

    const llm = new OpenAiLlm({ apiKey: 'test-key' });
    const result = await llm.interpret('generate a full design', schema, makeDiagram());

    expect(result.kind).toBe('refused');
    if (result.kind === 'refused') {
      expect(result.reason).toContain('I edit, not generate.');
    }
  });

  it('throws a transport-style error on a non-JSON LLM response (caller maps to 502, not 422)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ choices: [{ message: { content: 'not json at all' } }] }),
      }),
    );

    const llm = new OpenAiLlm({ apiKey: 'test-key' });
    await expect(llm.interpret('add class Invoice', schema, makeDiagram())).rejects.toThrow('non-JSON');
  });
});
