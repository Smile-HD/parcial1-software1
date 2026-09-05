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
    generalizations: [],
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

describe('FakeLlm aggregation/composition + association names/roles (unit 10.5)', () => {
  function makeDiagramWithOrderLines(): Diagram {
    const orderId = crypto.randomUUID();
    const orderLineId = crypto.randomUUID();
    const customerId = crypto.randomUUID();
    return {
      id: crypto.randomUUID(),
      name: 'Shop',
      classes: [
        { id: orderId, name: 'Order', position: { x: 0, y: 0 }, attributes: [], methods: [] },
        { id: orderLineId, name: 'OrderLine', position: { x: 300, y: 0 }, attributes: [], methods: [] },
        { id: customerId, name: 'Customer', position: { x: 150, y: 200 }, attributes: [], methods: [] },
      ],
      associations: [],
    };
  }

  it('interprets "X is composed of Y" as composite aggregation (Order is composed of OrderLine)', async () => {
    const llm = new FakeLlm();
    const diagram = makeDiagramWithOrderLines();
    const result = await llm.interpret('Order is composed of OrderLine', {}, diagram);
    expect(result.kind).toBe('delta');
    if (result.kind === 'delta') {
      const delta = result.value as { kind: string; aggregation?: string; sourceMultiplicity?: string; targetMultiplicity?: string };
      expect(delta.kind).toBe('association');
      expect(delta.aggregation).toBe('composite');
      expect(delta.sourceMultiplicity).toBe('1');
      expect(delta.targetMultiplicity).toBe('0..*');
    }
  });

  it('interprets "X composes Y" as composite aggregation', async () => {
    const llm = new FakeLlm();
    const diagram = makeDiagramWithOrderLines();
    const result = await llm.interpret('Order composes OrderLine', {}, diagram);
    expect(result.kind).toBe('delta');
    if (result.kind === 'delta') {
      const delta = result.value as { aggregation?: string };
      expect(delta.aggregation).toBe('composite');
    }
  });

  it('interprets "aggregation between X and Y" as shared aggregation', async () => {
    const llm = new FakeLlm();
    const diagram = makeDiagramWithOrderLines();
    const result = await llm.interpret('aggregation between Customer and Order', {}, diagram);
    expect(result.kind).toBe('delta');
    if (result.kind === 'delta') {
      const delta = result.value as { aggregation?: string };
      expect(delta.aggregation).toBe('shared');
    }
  });

  it('interprets "shared aggregation between X and Y" as shared aggregation', async () => {
    const llm = new FakeLlm();
    const diagram = makeDiagramWithOrderLines();
    const result = await llm.interpret('shared aggregation between Customer and Order', {}, diagram);
    expect(result.kind).toBe('delta');
    if (result.kind === 'delta') {
      const delta = result.value as { aggregation?: string };
      expect(delta.aggregation).toBe('shared');
    }
  });

  it('interprets named association with roles', async () => {
    const llm = new FakeLlm();
    const diagram = makeDiagramWithOrderLines();
    const result = await llm.interpret('association Customer Order named places role buyer role order', {}, diagram);
    expect(result.kind).toBe('delta');
    if (result.kind === 'delta') {
      const delta = result.value as { name?: string; sourceRole?: string; targetRole?: string };
      expect(delta.name).toBe('places');
      expect(delta.sourceRole).toBe('buyer');
      expect(delta.targetRole).toBe('order');
    }
  });

  it('interprets named association without roles', async () => {
    const llm = new FakeLlm();
    const diagram = makeDiagramWithOrderLines();
    const result = await llm.interpret('association Customer Order named places', {}, diagram);
    expect(result.kind).toBe('delta');
    if (result.kind === 'delta') {
      const delta = result.value as { name?: string; sourceRole?: string; targetRole?: string };
      expect(delta.name).toBe('places');
      expect(delta.sourceRole).toBeUndefined();
      expect(delta.targetRole).toBeUndefined();
    }
  });

  it('rejects unknown classes in composition command', async () => {
    const llm = new FakeLlm();
    const diagram = makeDiagramWithOrderLines();
    const result = await llm.interpret('Ghost is composed of OrderLine', {}, diagram);
    expect(result.kind).toBe('refused');
  });

  it('rejects unknown classes in aggregation command', async () => {
    const llm = new FakeLlm();
    const diagram = makeDiagramWithOrderLines();
    const result = await llm.interpret('aggregation between Ghost and Order', {}, diagram);
    expect(result.kind).toBe('refused');
  });

  it('interprets "X is part of Y" as composite with aggregationEnd pointing to whole (OrderLine is part of Order)', async () => {
    const llm = new FakeLlm();
    const diagram = makeDiagramWithOrderLines();
    const result = await llm.interpret('OrderLine is part of Order', {}, diagram);
    expect(result.kind).toBe('delta');
    if (result.kind === 'delta') {
      const delta = result.value as { kind: string; aggregation?: string; aggregationEnd?: string; sourceMultiplicity?: string; targetMultiplicity?: string };
      expect(delta.kind).toBe('association');
      expect(delta.aggregation).toBe('composite');
      expect(delta.aggregationEnd).toBe('target'); // whole (Order) is at target end
      expect(delta.sourceMultiplicity).toBe('0..*'); // part end
      expect(delta.targetMultiplicity).toBe('1');   // whole end
    }
  });

  it('interprets "X belongs to Y" as composite with aggregationEnd pointing to whole', async () => {
    const llm = new FakeLlm();
    const diagram = makeDiagramWithOrderLines();
    const result = await llm.interpret('OrderLine belongs to Order', {}, diagram);
    expect(result.kind).toBe('delta');
    if (result.kind === 'delta') {
      const delta = result.value as { aggregationEnd?: string };
      expect(delta.aggregationEnd).toBe('target');
    }
  });
});

describe('FakeLlm generalization commands (unit 11.5)', () => {
  function makeInheritanceDiagram(): Diagram {
    const itemId = crypto.randomUUID();
    const productId = crypto.randomUUID();
    return {
      id: crypto.randomUUID(),
      name: 'Shop',
      classes: [
        { id: itemId, name: 'Item', position: { x: 0, y: 0 }, attributes: [], methods: [] },
        { id: productId, name: 'Product', position: { x: 300, y: 0 }, attributes: [], methods: [] },
      ],
      associations: [],
      generalizations: [
        { id: crypto.randomUUID(), subClassId: productId, superClassId: itemId },
      ],
    };
  }

  it('interprets "Product is a kind of Item" as a generalization create (sub=Product, super=Item)', async () => {
    const llm = new FakeLlm();
    const diagram: Diagram = { ...makeInheritanceDiagram(), generalizations: [] };
    const result = await llm.interpret('Product is a kind of Item', {}, diagram);
    expect(result.kind).toBe('delta');
    if (result.kind === 'delta') {
      const delta = result.value as { kind: string; op: string; subClassId?: string; superClassId?: string };
      expect(delta.kind).toBe('generalization');
      expect(delta.op).toBe('create');
      expect(delta.subClassId).toBe(diagram.classes[1]!.id); // Product
      expect(delta.superClassId).toBe(diagram.classes[0]!.id); // Item
    }
  });

  it('interprets "Item inherits from X" as a generalization create (sub=Item)', async () => {
    const llm = new FakeLlm();
    const diagram: Diagram = { ...makeInheritanceDiagram(), generalizations: [] };
    const result = await llm.interpret('Item inherits from Product', {}, diagram);
    expect(result.kind).toBe('delta');
    if (result.kind === 'delta') {
      const delta = result.value as { kind: string; op: string; subClassId?: string; superClassId?: string };
      expect(delta.kind).toBe('generalization');
      expect(delta.op).toBe('create');
      expect(delta.subClassId).toBe(diagram.classes[0]!.id); // Item is the sub
      expect(delta.superClassId).toBe(diagram.classes[1]!.id); // Product is the super
    }
  });

  it('interprets "X is a subclass of Y" as a generalization create', async () => {
    const llm = new FakeLlm();
    const diagram: Diagram = { ...makeInheritanceDiagram(), generalizations: [] };
    const result = await llm.interpret('Product is a subclass of Item', {}, diagram);
    expect(result.kind).toBe('delta');
    if (result.kind === 'delta') {
      const delta = result.value as { kind: string; subClassId?: string };
      expect(delta.kind).toBe('generalization');
      expect(delta.subClassId).toBe(diagram.classes[1]!.id);
    }
  });

  it('refuses a generalization naming an unknown class', async () => {
    const llm = new FakeLlm();
    const diagram: Diagram = { ...makeInheritanceDiagram(), generalizations: [] };
    const result = await llm.interpret('Ghost is a kind of Item', {}, diagram);
    expect(result.kind).toBe('refused');
  });

  it('interprets "remove inheritance from Product" as a generalization delete of the existing edge', async () => {
    const llm = new FakeLlm();
    const diagram = makeInheritanceDiagram();
    const existing = diagram.generalizations[0]!;
    const result = await llm.interpret('remove inheritance from Product', {}, diagram);
    expect(result.kind).toBe('delta');
    if (result.kind === 'delta') {
      const delta = result.value as { kind: string; op: string; generalizationId?: string };
      expect(delta.kind).toBe('generalization');
      expect(delta.op).toBe('delete');
      expect(delta.generalizationId).toBe(existing.id);
    }
  });

  it('interprets "Product does not inherit from Item" as a generalization delete', async () => {
    const llm = new FakeLlm();
    const diagram = makeInheritanceDiagram();
    const result = await llm.interpret('Product does not inherit from Item', {}, diagram);
    expect(result.kind).toBe('delta');
    if (result.kind === 'delta') {
      const delta = result.value as { kind: string; op: string; generalizationId?: string };
      expect(delta.kind).toBe('generalization');
      expect(delta.op).toBe('delete');
      expect(delta.generalizationId).toBe(diagram.generalizations[0]!.id);
    }
  });

  it('refuses "remove inheritance" when no such edge exists', async () => {
    const llm = new FakeLlm();
    const diagram: Diagram = { ...makeInheritanceDiagram(), generalizations: [] };
    const result = await llm.interpret('remove inheritance from Product', {}, diagram);
    expect(result.kind).toBe('refused');
  });
});

describe('OpenAiLlm generalization prompt + repair (unit 11.5)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('system prompt documents the generalization create/delete shapes', async () => {
    const captured: { system?: string } = {};
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((_url: string, init: { body: string }) => {
        const body = JSON.parse(init.body) as { messages: { role: string; content: string }[] };
        captured.system = body.messages.find((m) => m.role === 'system')?.content;
        return Promise.resolve({
          ok: true,
          json: async () => ({
            choices: [{ message: { content: JSON.stringify({ action: 'refuse', reason: 'noop' }) } }],
          }),
        });
      }),
    );

    const llm = new OpenAiLlm({ apiKey: 'test-key' });
    await llm.interpret('Product is a kind of Item', {}, makeDiagram());

    expect(captured.system).toBeDefined();
    expect(captured.system).toContain('GENERALIZATION CREATE');
    expect(captured.system).toContain('GENERALIZATION DELETE');
    expect(captured.system).toContain('subClassId');
    expect(captured.system).toContain('superClassId');
  });

  it('repairs placeholder subClassId/superClassId coherently across a batch', async () => {
    const diagram = makeDiagram();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify({ action: 'apply', delta: {
            kind: 'batch',
            id: crypto.randomUUID(),
            diagramId: diagram.id,
            timestamp: new Date().toISOString(),
            deltas: [
              { kind: 'class', op: 'create', id: crypto.randomUUID(), diagramId: diagram.id, timestamp: new Date().toISOString(), classId: 'NEW_CLASS_1', name: 'Product', position: { x: 0, y: 0 } },
              { kind: 'generalization', op: 'create', id: crypto.randomUUID(), diagramId: diagram.id, timestamp: new Date().toISOString(), generalizationId: 'gen-1-placeholder', subClassId: 'NEW_CLASS_1', superClassId: diagram.classes[0]!.id },
            ],
          } }) } }],
        }),
      }),
    );

    const llm = new OpenAiLlm({ apiKey: 'test-key' });
    const result = await llm.interpret('create class Product that is a kind of Customer', {}, diagram);

    expect(result.kind).toBe('delta');
    if (result.kind === 'delta') {
      const batch = result.value as { kind: string; deltas: Array<{ classId?: string; subClassId?: string }> };
      expect(batch.kind).toBe('batch');
      const [created, gen] = batch.deltas;
      expect(gen!.subClassId).toMatch(/^[0-9a-f-]{36}$/i);
      // The SAME placeholder maps to the SAME uuid as the created class.
      expect(gen!.subClassId).toBe(created!.classId);
    }
  });
});
