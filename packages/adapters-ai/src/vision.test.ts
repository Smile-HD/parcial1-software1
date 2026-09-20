/**
 * Vision adapters (PR 16, task 16.2) — unit tests.
 *
 * photo:R1 — extraction JSON schema validated; prose rejected.
 * - FakeVision: deterministic, zero-network, golden fixture.
 * - OpenAiVision: real multimodal adapter (env-configured).
 */
import { describe, expect, it, vi, afterEach } from 'vitest';

import { FakeVision, VisionExtractionError, OpenAiVision, normalizeBatchPayload } from './vision.js';
import { BatchDeltaSchema, type BatchDelta } from '@app/core';

// No static fixture — FakeVision generates valid UUIDs at construction time.

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_BASE_URL;
  delete process.env.VISION_API_KEY;
  delete process.env.VISION_BASE_URL;
  delete process.env.VISION_MODEL;
});

describe('FakeVision', () => {
  it('returns a deterministic golden extraction (3 classes)', async () => {
    const vision = new FakeVision();
    const result = await vision.extract(new Uint8Array([0x89]), 'image/png');
    expect(result.kind).toBe('batch');
    if (result.kind !== 'batch') return;
    // FakeVision returns 3 classes by default
    expect(result.deltas.length).toBeGreaterThanOrEqual(3);
    const classes = result.deltas.filter((d) => d.kind === 'class' && d.op === 'create');
    expect(classes.length).toBe(3);
  });

  it('returns extraction that validates against BatchDeltaSchema', async () => {
    const vision = new FakeVision();
    const result = await vision.extract(new Uint8Array([0x89]), 'image/png');
    const parsed = BatchDeltaSchema.parse(result);
    expect(parsed.kind).toBe('batch');
  });

  it('forces zero-element mode when configured', async () => {
    const vision = new FakeVision({ zeroElements: true });
    const result = await vision.extract(new Uint8Array([0x89]), 'image/png');
    expect(result.kind).toBe('batch');
    if (result.kind !== 'batch') return;
    expect(result.deltas).toHaveLength(0);
  });

  it('throws VisionExtractionError when configured for forced-invalid', async () => {
    const vision = new FakeVision({ forceInvalid: true });
    await expect(vision.extract(new Uint8Array([0x89]), 'image/png')).rejects.toThrow(VisionExtractionError);
  });

  it('returns the same fixture on every call (deterministic)', async () => {
    const vision = new FakeVision();
    const r1 = await vision.extract(new Uint8Array([0x89]), 'image/png');
    const r2 = await vision.extract(new Uint8Array([0x89]), 'image/png');
    expect(r1).toEqual(r2);
  });
});

describe('OpenAiVision', () => {
  it('fromEnv returns null without an API key', () => {
    expect(OpenAiVision.fromEnv()).toBeNull();
  });

  it('fromEnv builds an adapter from OPENAI_API_KEY', () => {
    process.env.OPENAI_API_KEY = 'test-key';
    expect(OpenAiVision.fromEnv()).not.toBeNull();
  });

  it('posts image to /chat/completions with vision model and returns parsed extraction', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    const mockBatch: BatchDelta = {
      kind: 'batch',
      id: crypto.randomUUID(),
      diagramId: crypto.randomUUID(),
      timestamp: '2026-01-01T00:00:00.000Z',
      deltas: [
        {
          kind: 'class',
          op: 'create',
          id: crypto.randomUUID(),
          diagramId: crypto.randomUUID(),
          timestamp: '2026-01-01T00:00:00.000Z',
          classId: crypto.randomUUID(),
          name: 'Extracted',
          position: { x: 0, y: 0 },
        },
      ],
    };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(mockBatch) } }] }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const vision = OpenAiVision.fromEnv()!;
    const result = await vision.extract(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), 'image/png');

    expect(result.kind).toBe('batch');
    if (result.kind !== 'batch') return;
    expect(result.deltas).toHaveLength(1);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer test-key');

    const body = JSON.parse(init.body as string) as { model: string; messages: unknown[] };
    expect(body.model).toBe('gpt-4o-mini');
    expect(body.messages).toHaveLength(2);
    const userMsg = body.messages[1] as { role: string; content: unknown[] };
    expect(userMsg.role).toBe('user');
    // User message should be an array with text + image
    expect(Array.isArray(userMsg.content)).toBe(true);
  });

  it('extracts batch from markdown-fenced json response', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    const mockBatch: BatchDelta = {
      kind: 'batch',
      id: crypto.randomUUID(),
      diagramId: crypto.randomUUID(),
      timestamp: '2026-01-01T00:00:00.000Z',
      deltas: [
        {
          kind: 'class',
          op: 'create',
          id: crypto.randomUUID(),
          diagramId: crypto.randomUUID(),
          timestamp: '2026-01-01T00:00:00.000Z',
          classId: crypto.randomUUID(),
          name: 'MarkdownClass',
          position: { x: 120, y: 140 },
        },
      ],
    };
    const markdownContent = `Here is the diagram you requested:\n\`\`\`json\n${JSON.stringify(mockBatch, null, 2)}\n\`\`\`\nHope this helps!`;
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: markdownContent } }] }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const vision = OpenAiVision.fromEnv()!;
    const result = await vision.extract(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), 'image/png');

    expect(result.kind).toBe('batch');
    if (result.kind !== 'batch') return;
    expect(result.deltas).toHaveLength(1);
    const cls = result.deltas[0] as { name: string };
    expect(cls.name).toBe('MarkdownClass');
  });

  it('repairs non-UUID placeholder IDs and resolves class name references', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    const rawAiOutput = {
      kind: 'batch',
      id: 'batch-temp-id',
      diagramId: 'diag-temp-id',
      timestamp: 'not-a-timestamp',
      deltas: [
        {
          kind: 'class',
          op: 'create',
          id: 'create-user',
          diagramId: 'diag-temp-id',
          timestamp: 'invalid',
          classId: 'User',
          name: 'User',
        },
        {
          kind: 'class',
          op: 'create',
          id: 'create-order',
          diagramId: 'diag-temp-id',
          timestamp: 'invalid',
          classId: 'Order',
          name: 'Order',
        },
        {
          kind: 'association',
          op: 'create',
          id: 'assoc-1',
          diagramId: 'diag-temp-id',
          timestamp: 'invalid',
          associationId: 'rel-1',
          sourceClassId: 'User',
          targetClassId: 'Order',
          directed: true,
        },
      ],
    };

    const fetchMock = vi.fn().mockImplementation(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(rawAiOutput) } }] }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const vision = OpenAiVision.fromEnv()!;
    const result = await vision.extract(new Uint8Array([0x89]), 'image/png');

    expect(result.kind).toBe('batch');
    const parsed = BatchDeltaSchema.parse(result);
    expect(parsed.deltas).toHaveLength(3);

    const userClass = parsed.deltas.find((d) => d.kind === 'class' && d.name === 'User') as any;
    const orderClass = parsed.deltas.find((d) => d.kind === 'class' && d.name === 'Order') as any;
    const assoc = parsed.deltas.find((d) => d.kind === 'association') as any;

    expect(userClass).toBeDefined();
    expect(orderClass).toBeDefined();
    expect(assoc).toBeDefined();
    expect(assoc.sourceClassId).toBe(userClass.classId);
    expect(assoc.targetClassId).toBe(orderClass.classId);
    // Positions defaulted if missing
    expect(userClass.position).toBeDefined();
    expect(orderClass.position).toBeDefined();
  });

  it('extracts full UML diagram with members and relationships', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    const fullDiagram = {
      kind: 'batch',
      id: 'batch-1',
      diagramId: 'd-1',
      timestamp: '2026-01-01T00:00:00.000Z',
      deltas: [
        {
          kind: 'class',
          op: 'create',
          id: 'c1',
          diagramId: 'd-1',
          timestamp: '2026-01-01T00:00:00.000Z',
          classId: 'Account',
          name: 'Account',
          classKind: 'class',
          isAbstract: true,
          position: { x: 100, y: 100 },
        },
        {
          kind: 'member',
          op: 'addAttribute',
          id: 'm1',
          diagramId: 'd-1',
          timestamp: '2026-01-01T00:00:00.000Z',
          classId: 'Account',
          memberId: 'attr1',
          name: 'balance',
          type: 'BigDecimal',
          visibility: '-',
        },
        {
          kind: 'member',
          op: 'addMethod',
          id: 'm2',
          diagramId: 'd-1',
          timestamp: '2026-01-01T00:00:00.000Z',
          classId: 'Account',
          memberId: 'meth1',
          name: 'deposit',
          returnType: 'void',
          parameters: [{ name: 'amount', type: 'BigDecimal' }],
          visibility: '+',
        },
        {
          kind: 'class',
          op: 'create',
          id: 'c2',
          diagramId: 'd-1',
          timestamp: '2026-01-01T00:00:00.000Z',
          classId: 'SavingsAccount',
          name: 'SavingsAccount',
          position: { x: 400, y: 100 },
        },
        {
          kind: 'generalization',
          op: 'create',
          id: 'g1',
          diagramId: 'd-1',
          timestamp: '2026-01-01T00:00:00.000Z',
          generalizationId: 'gen1',
          subClassId: 'SavingsAccount',
          superClassId: 'Account',
        },
      ],
    };

    const fetchMock = vi.fn().mockImplementation(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(fullDiagram) } }] }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const vision = OpenAiVision.fromEnv()!;
    const result = await vision.extract(new Uint8Array([0x89]), 'image/png');
    const parsed = BatchDeltaSchema.parse(result);

    expect(parsed.deltas).toHaveLength(5);
    const gen = parsed.deltas.find((d) => d.kind === 'generalization') as any;
    const account = parsed.deltas.find((d) => d.kind === 'class' && d.name === 'Account') as any;
    const savings = parsed.deltas.find((d) => d.kind === 'class' && d.name === 'SavingsAccount') as any;

    expect(gen.superClassId).toBe(account.classId);
    expect(gen.subClassId).toBe(savings.classId);
  });

  it('self-heals on initial invalid response via retry loop', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    const validBatch: BatchDelta = {
      kind: 'batch',
      id: crypto.randomUUID(),
      diagramId: crypto.randomUUID(),
      timestamp: '2026-01-01T00:00:00.000Z',
      deltas: [
        {
          kind: 'class',
          op: 'create',
          id: crypto.randomUUID(),
          diagramId: crypto.randomUUID(),
          timestamp: '2026-01-01T00:00:00.000Z',
          classId: crypto.randomUUID(),
          name: 'SelfHealed',
          position: { x: 100, y: 100 },
        },
      ],
    };

    // 1st attempt: invalid JSON / schema
    // 2nd attempt: valid BatchDelta
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: '{"invalid": true}' } }] }), { status: 200 }),
      )
      .mockImplementationOnce(async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(validBatch) } }] }), { status: 200 }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const vision = OpenAiVision.fromEnv()!;
    const result = await vision.extract(new Uint8Array([0x89]), 'image/png');

    expect(result.kind).toBe('batch');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Second call should include repair context
    const [, secondInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    const body = JSON.parse(secondInit.body as string) as { messages: { role: string; content: unknown }[] };
    expect(body.messages.length).toBeGreaterThanOrEqual(3);
    const lastMsg = body.messages[body.messages.length - 1];
    expect(lastMsg?.role).toBe('user');
    expect(String(lastMsg?.content)).toContain('schema');
  });

  it('throws VisionExtractionError on non-OK responses', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('rate limited', { status: 429 })));
    const vision = OpenAiVision.fromEnv()!;
    await expect(vision.extract(new Uint8Array([0x89]), 'image/png')).rejects.toThrow(VisionExtractionError);
  });

  it('throws VisionExtractionError when response is not a valid batch schema', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: 'Here is the class diagram description: ...' } }] }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const vision = OpenAiVision.fromEnv()!;
    await expect(vision.extract(new Uint8Array([0x89]), 'image/png')).rejects.toThrow(VisionExtractionError);
  });

  it('throws VisionExtractionError on network failure', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    const vision = OpenAiVision.fromEnv()!;
    await expect(vision.extract(new Uint8Array([0x89]), 'image/png')).rejects.toThrow(VisionExtractionError);
  });

  it('fromEnv prioritizes VISION_API_KEY and VISION_BASE_URL over OPENAI_*', async () => {
    process.env.OPENAI_API_KEY = 'openai-key';
    process.env.OPENAI_BASE_URL = 'https://api.openai.com/v1';
    process.env.VISION_API_KEY = 'gemini-key';
    process.env.VISION_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai';

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: '{"kind":"batch","id":"b1","diagramId":"d1","timestamp":"2026-01-01T00:00:00Z","deltas":[]}' } }] }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const vision = OpenAiVision.fromEnv()!;
    await vision.extract(new Uint8Array([0x89]), 'image/png');

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer gemini-key');
  });

  it('normalizeBatchPayload sorts classes before members and relationships', () => {
    const raw = {
      kind: 'batch',
      deltas: [
        { kind: 'association', op: 'create', sourceClassId: 'B', targetClassId: 'A' },
        { kind: 'member', op: 'addAttribute', classId: 'A', name: 'id', type: 'string' },
        { kind: 'class', op: 'create', classId: 'A', name: 'A' },
        { kind: 'class', op: 'create', classId: 'B', name: 'B' },
      ],
    };

    const normalized = normalizeBatchPayload(raw) as { deltas: { kind: string }[] };
    expect(normalized.deltas[0]?.kind).toBe('class');
    expect(normalized.deltas[1]?.kind).toBe('class');
    expect(normalized.deltas[2]?.kind).toBe('member');
    expect(normalized.deltas[3]?.kind).toBe('association');
  });

  it('normalizeBatchPayload deduplicates duplicate class names and unifies references', () => {
    const raw = {
      kind: 'batch',
      deltas: [
        { kind: 'class', op: 'create', classId: 'id-1', name: 'Customer' },
        { kind: 'class', op: 'create', classId: 'id-2', name: 'Customer' },
        { kind: 'member', op: 'addAttribute', classId: 'id-2', name: 'email', type: 'string' },
      ],
    };

    const normalized = normalizeBatchPayload(raw) as { deltas: { kind: string; classId?: string }[] };
    const classes = normalized.deltas.filter((d) => d.kind === 'class');
    expect(classes).toHaveLength(1);

    const member = normalized.deltas.find((d) => d.kind === 'member');
    expect(member?.classId).toBeDefined();
    // Class and member must share the exact same repaired UUID
    expect(classes[0]?.classId).toBe(member?.classId);
  });

  it('normalizeBatchPayload removes orphaned members and associations', () => {
    const raw = {
      kind: 'batch',
      deltas: [
        { kind: 'class', op: 'create', classId: 'c1', name: 'ExistingClass' },
        { kind: 'member', op: 'addAttribute', classId: 'c1', name: 'validAttr' },
        { kind: 'member', op: 'addAttribute', classId: 'orphanClass', name: 'lostAttr' },
        { kind: 'association', op: 'create', sourceClassId: 'c1', targetClassId: 'orphanClass' },
      ],
    };

    const normalized = normalizeBatchPayload(raw) as { deltas: { kind: string; name?: string }[] };
    expect(normalized.deltas).toHaveLength(2);
    expect(normalized.deltas[0]?.kind).toBe('class');
    expect(normalized.deltas[1]?.kind).toBe('member');
    expect(normalized.deltas[1]?.name).toBe('validAttr');
  });

  it('normalizeBatchPayload preserves relationship names, roles, and label annotations', () => {
    const raw = {
      kind: 'batch',
      deltas: [
        { kind: 'class', op: 'create', classId: 'c1', name: 'Cliente' },
        { kind: 'class', op: 'create', classId: 'c2', name: 'Factura' },
        {
          kind: 'association',
          op: 'create',
          sourceClassId: 'c1',
          targetClassId: 'c2',
          name: 'facturas',
          sourceRole: 'emisor',
          targetRole: 'compras',
          sourceMultiplicity: '1',
          targetMultiplicity: '0..*',
        },
      ],
    };

    const normalized = normalizeBatchPayload(raw) as {
      deltas: { kind: string; name?: string; sourceRole?: string; targetRole?: string }[];
    };
    const assoc = normalized.deltas.find((d) => d.kind === 'association');
    expect(assoc).toBeDefined();
    expect(assoc?.name).toBe('facturas');
    expect(assoc?.sourceRole).toBe('emisor');
    expect(assoc?.targetRole).toBe('compras');
  });

  it('normalizeBatchPayload collapses diamond hub classes into naryAssociation deltas', () => {
    const raw = {
      kind: 'batch',
      deltas: [
        { kind: 'class', op: 'create', classId: 'c1', name: 'Proveedor' },
        { kind: 'class', op: 'create', classId: 'c2', name: 'Producto' },
        { kind: 'class', op: 'create', classId: 'c3', name: 'Empleado' },
        { kind: 'class', op: 'create', classId: 'diamondHub', name: 'SuministroTernario' },
        { kind: 'association', op: 'create', sourceClassId: 'c1', targetClassId: 'diamondHub', sourceMultiplicity: '1' },
        { kind: 'association', op: 'create', sourceClassId: 'c2', targetClassId: 'diamondHub', sourceMultiplicity: '0..*' },
        { kind: 'association', op: 'create', sourceClassId: 'c3', targetClassId: 'diamondHub', sourceMultiplicity: '1', sourceRole: 'supervisa' },
      ],
    };

    const normalized = normalizeBatchPayload(raw) as {
      deltas: { kind: string; name?: string; memberEnds?: { classId: string; multiplicity: string; role?: string }[] }[];
    };

    // The diamond hub class and binary associations must be collapsed into a single naryAssociation
    const classes = normalized.deltas.filter((d) => d.kind === 'class');
    expect(classes).toHaveLength(3);
    expect(classes.map((c) => c.name)).not.toContain('SuministroTernario');

    const assocs = normalized.deltas.filter((d) => d.kind === 'association');
    expect(assocs).toHaveLength(0);

    const nary = normalized.deltas.find((d) => d.kind === 'naryAssociation');
    expect(nary).toBeDefined();
    expect(nary?.name).toBe('SuministroTernario');
    expect(nary?.memberEnds).toHaveLength(3);
    expect(nary?.memberEnds?.map((e) => e.multiplicity).sort()).toEqual(['0..*', '1', '1']);
    const supervisingEnd = nary?.memberEnds?.find((e) => e.role === 'supervisa');
    expect(supervisingEnd).toBeDefined();
  });

  it('does NOT collapse regular classes with >= 3 associations into naryAssociation', () => {
    const raw = {
      kind: 'batch',
      deltas: [
        { kind: 'class', op: 'create', classId: 'cOrder', name: 'Order' },
        { kind: 'class', op: 'create', classId: 'cCust', name: 'Customer' },
        { kind: 'class', op: 'create', classId: 'cProd', name: 'Product' },
        { kind: 'class', op: 'create', classId: 'cPay', name: 'Payment' },
        { kind: 'association', op: 'create', sourceClassId: 'cCust', targetClassId: 'cOrder' },
        { kind: 'association', op: 'create', sourceClassId: 'cOrder', targetClassId: 'cProd' },
        { kind: 'association', op: 'create', sourceClassId: 'cOrder', targetClassId: 'cPay' },
      ],
    };

    const normalized = normalizeBatchPayload(raw) as {
      deltas: { kind: string; name?: string }[];
    };

    // Order must remain as a class with its 3 binary associations intact!
    const classes = normalized.deltas.filter((d) => d.kind === 'class');
    expect(classes).toHaveLength(4);
    expect(classes.map((c) => c.name)).toContain('Order');

    const assocs = normalized.deltas.filter((d) => d.kind === 'association');
    expect(assocs).toHaveLength(3);

    const nary = normalized.deltas.filter((d) => d.kind === 'naryAssociation');
    expect(nary).toHaveLength(0);
  });

  it('normalizes aggregation and composition deltas and maps synonyms', () => {
    const raw = {
      kind: 'batch',
      deltas: [
        { kind: 'class', op: 'create', classId: 'c1', name: 'Empresa' },
        { kind: 'class', op: 'create', classId: 'c2', name: 'Empleado' },
        { kind: 'class', op: 'create', classId: 'c3', name: 'Edificio' },
        // Composition via kind: 'composition' and informal source/target
        {
          kind: 'composition',
          source: 'Empresa',
          target: 'Edificio',
          sourceMultiplicity: '1',
          targetMultiplicity: '1..n',
        },
        // Aggregation via aggregation: 'aggregation'
        {
          kind: 'association',
          sourceClassId: 'Empresa',
          targetClassId: 'Empleado',
          aggregation: 'aggregation',
          aggregationEnd: 'source',
          sourceMultiplicity: '1',
          targetMultiplicity: '0..N',
        },
      ],
    };

    const normalized = normalizeBatchPayload(raw) as {
      deltas: {
        kind: string;
        aggregation?: string;
        aggregationEnd?: string;
        sourceMultiplicity?: string;
        targetMultiplicity?: string;
      }[];
    };

    const assocs = normalized.deltas.filter((d) => d.kind === 'association');
    expect(assocs).toHaveLength(2);

    // First: composition normalized
    const comp = assocs[0];
    expect(comp?.aggregation).toBe('composite');
    expect(comp?.aggregationEnd).toBe('source');
    expect(comp?.targetMultiplicity).toBe('1..*');

    // Second: aggregation normalized
    const agg = assocs[1];
    expect(agg?.aggregation).toBe('shared');
    expect(agg?.aggregationEnd).toBe('source');
    expect(agg?.targetMultiplicity).toBe('0..*');

    // The whole normalized payload must pass BatchDeltaSchema
    const parsed = BatchDeltaSchema.safeParse(normalized);
    expect(parsed.success).toBe(true);
  });

  it('resolves fuzzy class references such as plurals and prefixes', () => {
    const raw = {
      kind: 'batch',
      deltas: [
        { kind: 'class', op: 'create', classId: 'c1', name: 'Cliente' },
        { kind: 'class', op: 'create', classId: 'c2', name: 'Factura' },
        {
          kind: 'association',
          source: 'Clientes', // plural
          target: 'class Factura', // prefix
        },
      ],
    };

    const normalized = normalizeBatchPayload(raw) as {
      deltas: { kind: string; name?: string; classId?: string; sourceClassId?: string; targetClassId?: string }[];
    };

    const classes = normalized.deltas.filter((d) => d.kind === 'class');
    const c1Id = classes.find((c) => c.name === 'Cliente')?.classId;
    const c2Id = classes.find((c) => c.name === 'Factura')?.classId;

    const assoc = normalized.deltas.find((d) => d.kind === 'association');
    expect(assoc).toBeDefined();
    expect(assoc?.sourceClassId).toBe(c1Id);
    expect(assoc?.targetClassId).toBe(c2Id);
  });

  it('keeps inheritance (generalization) strictly separate from associations and aggregations', () => {
    const raw = {
      kind: 'batch',
      deltas: [
        { kind: 'class', op: 'create', classId: 'c1', name: 'Animal' },
        { kind: 'class', op: 'create', classId: 'c2', name: 'Perro' },
        {
          kind: 'generalization',
          child: 'Perro',
          parent: 'Animal',
        },
      ],
    };

    const normalized = normalizeBatchPayload(raw) as {
      deltas: { kind: string; name?: string; classId?: string; subClassId?: string; superClassId?: string }[];
    };

    const classes = normalized.deltas.filter((d) => d.kind === 'class');
    const animalId = classes.find((c) => c.name === 'Animal')?.classId;
    const perroId = classes.find((c) => c.name === 'Perro')?.classId;

    const gen = normalized.deltas.find((d) => d.kind === 'generalization');
    expect(gen).toBeDefined();
    expect(gen?.subClassId).toBe(perroId);
    expect(gen?.superClassId).toBe(animalId);

    const assocs = normalized.deltas.filter((d) => d.kind === 'association');
    expect(assocs).toHaveLength(0);
  });
});

