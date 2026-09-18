/**
 * Vision adapters (PR 16, task 16.2) — unit tests.
 *
 * photo:R1 — extraction JSON schema validated; prose rejected.
 * - FakeVision: deterministic, zero-network, golden fixture.
 * - OpenAiVision: real multimodal adapter (env-configured).
 */
import { describe, expect, it, vi, afterEach } from 'vitest';

import { FakeVision, VisionExtractionError, OpenAiVision } from './vision.js';
import { BatchDeltaSchema, type BatchDelta } from '@app/core';

// No static fixture — FakeVision generates valid UUIDs at construction time.

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_BASE_URL;
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
});
