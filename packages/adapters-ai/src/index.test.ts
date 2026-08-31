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

  /**
   * Groq's gpt-oss-120b hallucinates non-hex UUID characters ("...5f6g") even
   * with strict shape instructions. The adapter repairs malformed ids BEFORE
   * returning the result — the caller's Zod gate (interpreter:R1) still
   * validates everything, but legitimate commands stop failing on ids.
   */
  it('repairs hallucinated non-hex ids with fresh UUID v4 values', async () => {
    const diagram = makeDiagram();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify({ action: 'apply', delta: { kind: 'class', op: 'create', id: 'not-a-valid-uuid-at-all', diagramId: diagram.id, timestamp: 'garbage-timestamp', classId: 'e7f8g9h0-1i2j-3k4l-5m6n-7o8p9q0r1s2t', name: 'Product', position: { x: 0, y: 0 } } }) } }],
        }),
      }),
    );

    const llm = new OpenAiLlm({ apiKey: 'test-key' });
    const result = await llm.interpret('add class Product', schema, diagram);

    expect(result.kind).toBe('delta');
    if (result.kind === 'delta') {
      const delta = result.value as { id: string; classId: string; timestamp: string; diagramId: string };
      const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      expect(delta.id).toMatch(UUID_V4);
      expect(delta.classId).toMatch(UUID_V4);
      expect(delta.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/);
      // diagramId is NEVER repaired: it must match the current IR exactly.
      expect(delta.diagramId).toBe(diagram.id);
    }
  });

  /**
   * Cross-reference coherence: when a batch creates a class and other inner
   * deltas reference it, the model may use a symbolic placeholder (or repeat
   * the same malformed id). Every occurrence of the SAME invalid string must
   * map to the SAME generated UUID, or applyDelta fails with dangling refs.
   */
  it('maps every occurrence of the same placeholder id to one shared UUID', async () => {
    const diagram = makeDiagram();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify({ action: 'apply', delta: {
            kind: 'batch',
            id: 'batch-id-placeholder',
            diagramId: diagram.id,
            timestamp: new Date().toISOString(),
            deltas: [
              { kind: 'class', op: 'create', id: 'delta-1-placeholder', diagramId: diagram.id, timestamp: new Date().toISOString(), classId: 'NEW_CLASS_1', name: 'Supplier', position: { x: 0, y: 0 } },
              { kind: 'member', op: 'addAttribute', id: 'delta-2-placeholder', diagramId: diagram.id, timestamp: new Date().toISOString(), classId: 'NEW_CLASS_1', memberId: 'member-1-placeholder', name: 'name', type: 'string' },
              { kind: 'association', op: 'create', id: 'delta-3-placeholder', diagramId: diagram.id, timestamp: new Date().toISOString(), associationId: 'assoc-1-placeholder', sourceClassId: 'NEW_CLASS_1', targetClassId: diagram.classes[0]!.id, sourceMultiplicity: '1', targetMultiplicity: '0..*', directed: false },
            ],
          } }) } }],
        }),
      }),
    );

    const llm = new OpenAiLlm({ apiKey: 'test-key' });
    const result = await llm.interpret('create class Supplier with attribute name: string and link Supplier with Customer', schema, diagram);

    expect(result.kind).toBe('delta');
    if (result.kind === 'delta') {
      const batch = result.value as { kind: string; deltas: Array<{ classId?: string; sourceClassId?: string }> };
      expect(batch.kind).toBe('batch');
      const [created, added, assoc] = batch.deltas;
      expect(created!.classId).toMatch(/^[0-9a-f-]{36}$/i);
      // The SAME placeholder → the SAME uuid across all three deltas.
      expect(added!.classId).toBe(created!.classId);
      expect(assoc!.sourceClassId).toBe(created!.classId);
      // Distinct placeholders get distinct uuids.
      expect(added!['memberId' as keyof typeof added]).not.toBe(created!.classId);
    }
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

describe('FakeLlm member adornments (unit 9.5)', () => {
  it('extracts visibility/static/derived from the utterance into the delta', async () => {
    const llm = new FakeLlm();
    const diagram = makeDiagram();
    const result = await llm.interpret(
      'add a private static derived attribute cache: int to Customer',
      {},
      diagram,
    );
    expect(result.kind).toBe('delta');
    if (result.kind === 'delta') {
      const delta = result.value as { kind: string; visibility?: string; isStatic?: boolean; isDerived?: boolean };
      expect(delta.kind).toBe('member');
      expect(delta.visibility).toBe('-');
      expect(delta.isStatic).toBe(true);
      expect(delta.isDerived).toBe(true);
    }
  });

  it('omits adornments when the utterance has none', async () => {
    const llm = new FakeLlm();
    const result = await llm.interpret('add attribute email: string to Customer', {}, makeDiagram());
    expect(result.kind).toBe('delta');
    if (result.kind === 'delta') {
      const delta = result.value as { visibility?: string; isStatic?: boolean };
      expect(delta.visibility).toBeUndefined();
      expect(delta.isStatic).toBeUndefined();
    }
  });

  it('attribute-to-existing-class commands are not misread as class creation', async () => {
    const llm = new FakeLlm();
    const result = await llm.interpret('add attribute email: string to the class Customer', {}, makeDiagram());
    expect(result.kind).toBe('delta');
    if (result.kind === 'delta') {
      const delta = result.value as { kind: string; name?: string };
      expect(delta.kind).toBe('member');
      expect(delta.name).toBe('email');
    }
  });
});
