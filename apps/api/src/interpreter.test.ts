/**
 * Text interpreter (PR 7) â€” API-side tests.
 *
 * 7.1 whole-design refusal (interpreter:R3) â€” automated RED first.
 * 7.2 schema-invalid LLM output â†’ 422, model untouched (interpreter:R1).
 * Pending-delta store + confirm/reject gate (interpreter:R2).
 * 7.5 out-of-vocabulary â†’ refused with supported categories surfaced.
 *
 * The LLM is injected as a stub: the deterministic fake lives in
 * @app/adapters-ai; these tests pin the ENDPOINT contract, not the LLM.
 */
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import { buildApp, closePool } from './index.js';
import { DiagramSchema, type Diagram, type LlmPort, type LlmResult } from '@app/core';

function makeDiagram(): Diagram {
  const customerId = crypto.randomUUID();
  const orderId = crypto.randomUUID();
  return {
    id: crypto.randomUUID(),
    name: 'Interpreter Test',
    classes: [
      {
        id: customerId,
        name: 'Customer',
        position: { x: 0, y: 0 },
        attributes: [{ id: crypto.randomUUID(), name: 'name', type: 'string' }],
        methods: [],
      },
      { id: orderId, name: 'Order', position: { x: 300, y: 0 }, attributes: [], methods: [] },
    ],
    associations: [],
  };
}

function llmStub(result: LlmResult | Error): LlmPort {
  return {
    interpret: async () => {
      if (result instanceof Error) {
        throw result;
      }
      return result;
    },
  };
}

async function createDiagram(app: ReturnType<typeof buildApp>, diagram: Diagram): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/diagrams',
    payload: { name: diagram.name, diagram },
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as { id: string }).id;
}

afterAll(async () => {
  await closePool();
});

describe('text interpreter API (PR 7)', () => {
  it('7.1 refuses whole-design generation: no delta, no pending, model untouched (interpreter:R3)', async () => {
    const app = buildApp({
      logger: false,
      llm: llmStub({
        kind: 'refused',
        reason: 'I edit an existing model on explicit instruction; I do not generate whole designs.',
      }),
    });

    const diagram = makeDiagram();
    const id = await createDiagram(app, diagram);

    const res = await app.inject({
      method: 'POST',
      url: `/diagrams/${id}/interpret`,
      payload: { text: 'generate me a full design for a library system' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { status: string; reason: string; supportedCategories: string[] };
    expect(body.status).toBe('refused');
    expect(body.reason).toContain('explicit instruction');
    expect(Array.isArray(body.supportedCategories)).toBe(true);
    expect(body.supportedCategories.length).toBeGreaterThan(0);

    // Model untouched.
    const loaded = await app.inject({ method: 'GET', url: `/diagrams/${id}` });
    expect((loaded.json() as { diagram: Diagram }).diagram).toEqual(DiagramSchema.parse(diagram));
  });

  it('7.2 returns 422 and leaves the model untouched when LLM output fails delta-schema validation (interpreter:R1)', async () => {
    const app = buildApp({
      logger: false,
      llm: llmStub({
        kind: 'delta',
        value: { kind: 'class', op: 'create', id: 'not-a-uuid' }, // garbage
      }),
    });

    const diagram = makeDiagram();
    const id = await createDiagram(app, diagram);

    const res = await app.inject({
      method: 'POST',
      url: `/diagrams/${id}/interpret`,
      payload: { text: 'add a class Invoice' },
    });

    expect(res.statusCode).toBe(422);
    const body = res.json() as { status: string; error: string };
    expect(body.status).toBe('error');
    expect(body.error).toContain('could not be interpreted');

    // Model untouched AND nothing pending.
    const loaded = await app.inject({ method: 'GET', url: `/diagrams/${id}` });
    expect((loaded.json() as { diagram: Diagram }).diagram).toEqual(DiagramSchema.parse(diagram));
  });

  it('a valid command stores a pending delta and the model stays untouched until confirm (interpreter:R2)', async () => {
    const diagram = makeDiagram();
    const delta = {
      kind: 'class',
      op: 'create',
      id: crypto.randomUUID(),
      diagramId: diagram.id,
      timestamp: new Date().toISOString(),
      classId: crypto.randomUUID(),
      name: 'Invoice',
      position: { x: 600, y: 0 },
    };
    const app = buildApp({ logger: false, llm: llmStub({ kind: 'delta', value: delta }) });
    const id = await createDiagram(app, diagram);

    const res = await app.inject({
      method: 'POST',
      url: `/diagrams/${id}/interpret`,
      payload: { text: 'add a class Invoice' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { status: string; deltaId: string; delta: typeof delta };
    expect(body.status).toBe('pending');
    expect(body.delta).toEqual(delta);

    // Not applied yet.
    const loaded = await app.inject({ method: 'GET', url: `/diagrams/${id}` });
    expect((loaded.json() as { diagram: Diagram }).diagram).toEqual(DiagramSchema.parse(diagram));

    // Confirm returns the delta exactly once.
    const confirmed = await app.inject({ method: 'POST', url: `/deltas/${body.deltaId}/confirm` });
    expect(confirmed.statusCode).toBe(200);
    expect((confirmed.json() as { status: string; delta: typeof delta }).status).toBe('confirmed');
    expect((confirmed.json() as { delta: typeof delta }).delta).toEqual(delta);

    // Double-confirm is rejected.
    const again = await app.inject({ method: 'POST', url: `/deltas/${body.deltaId}/confirm` });
    expect(again.statusCode).toBe(404);
  });

  it('reject discards the pending delta without mutating the model (interpreter:R2)', async () => {
    const diagram = makeDiagram();
    const delta = {
      kind: 'class',
      op: 'create',
      id: crypto.randomUUID(),
      diagramId: diagram.id,
      timestamp: new Date().toISOString(),
      classId: crypto.randomUUID(),
      name: 'Invoice',
      position: { x: 600, y: 0 },
    };
    const app = buildApp({ logger: false, llm: llmStub({ kind: 'delta', value: delta }) });
    const id = await createDiagram(app, diagram);

    const res = await app.inject({
      method: 'POST',
      url: `/diagrams/${id}/interpret`,
      payload: { text: 'add a class Invoice' },
    });
    const { deltaId } = res.json() as { deltaId: string };

    const rejected = await app.inject({ method: 'POST', url: `/deltas/${deltaId}/reject` });
    expect(rejected.statusCode).toBe(200);
    expect((rejected.json() as { status: string }).status).toBe('rejected');

    const again = await app.inject({ method: 'POST', url: `/deltas/${deltaId}/confirm` });
    expect(again.statusCode).toBe(404);

    const loaded = await app.inject({ method: 'GET', url: `/diagrams/${id}` });
    expect((loaded.json() as { diagram: Diagram }).diagram).toEqual(DiagramSchema.parse(diagram));
  });

  it('7.5 surfaces supported categories on out-of-vocabulary commands (interpreter:R4)', async () => {
    const app = buildApp({
      logger: false,
      llm: llmStub({ kind: 'refused', reason: 'Unsupported command.' }),
    });

    const diagram = makeDiagram();
    const id = await createDiagram(app, diagram);

    const res = await app.inject({
      method: 'POST',
      url: `/diagrams/${id}/interpret`,
      payload: { text: 'make the diagram prettier' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { status: string; supportedCategories: string[] };
    expect(body.status).toBe('refused');
    expect(body.supportedCategories).toContain('add/rename/delete class');
    // Unit 11.5 — generalization is part of the bounded vocabulary.
    expect(body.supportedCategories).toContain('create/remove generalization (inheritance)');
    // Unit 12.5 (12a) — interfaces/abstract + realization join the vocabulary.
    expect(body.supportedCategories).toContain('create interfaces and abstract classes');
    expect(body.supportedCategories).toContain('create/remove realization (class realizes interface)');
    // Unit 12.5 (12b) — dependency joins the vocabulary.
    expect(body.supportedCategories).toContain('create/remove dependency (client depends on supplier)');
  });

  it('returns 404 when interpreting a diagram that does not exist', async () => {
    const app = buildApp({
      logger: false,
      llm: llmStub({ kind: 'refused', reason: 'whatever' }),
    });

    const res = await app.inject({
      method: 'POST',
      url: `/diagrams/${crypto.randomUUID()}/interpret`,
      payload: { text: 'add a class Invoice' },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('buildApp wires the production LLM path through RetryRepairingLlmPort (R2, R5)', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.unstubAllGlobals();
  });

  it('RED: when OPENAI_API_KEY is set, the production path retries on Zod failure and returns a refusal (R1, R5)', async () => {
    // Mark the env as "real" so buildApp picks the OpenAiLlm branch.
    process.env.OPENAI_API_KEY = 'test-key';
    delete process.env.OPENAI_LLM_MAX_ATTEMPTS;

    // Two calls, both invalid: the wrapper retries, then refuses.
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{
          message: {
            content: JSON.stringify({
              action: 'apply',
              delta: { kind: 'class', op: 'create', id: 'not-a-uuid' },
            }),
          },
        }],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const app = buildApp({ logger: false });
    const diagram = makeDiagram();
    const id = await createDiagram(app, diagram);

    const res = await app.inject({
      method: 'POST',
      url: `/diagrams/${id}/interpret`,
      payload: { text: 'add a class Invoice' },
    });

    // Production path: NEVER 422 with the banned literal. Either 200 (refused)
    // or 502 (transport). Here the model "succeeded" (HTTP 200) but the delta
    // is invalid → the wrapper retries once and returns a refusal.
    expect(res.statusCode).toBe(200);
    const body = res.json() as { status: string; reason: string; error?: string };
    expect(body.status).toBe('refused');
    expect(body.reason).toContain('Issues:');
    // Banned literal never reaches the user.
    expect(res.body).not.toContain('the AI output did not match the delta schema');
    // The wrapper called the inner port twice.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('RED: with OPENAI_LLM_MAX_ATTEMPTS=1, the production path returns a single-attempt refusal and never the banned literal (R5)', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    process.env.OPENAI_LLM_MAX_ATTEMPTS = '1';

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{
          message: {
            content: JSON.stringify({
              action: 'apply',
              delta: { kind: 'class', op: 'create', id: 'not-a-uuid' },
            }),
          },
        }],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const app = buildApp({ logger: false });
    const diagram = makeDiagram();
    const id = await createDiagram(app, diagram);

    const res = await app.inject({
      method: 'POST',
      url: `/diagrams/${id}/interpret`,
      payload: { text: 'add a class Invoice' },
    });

    // maxAttempts=1 → wrapper has no repair budget; the single invalid attempt
    // is converted into a refusal, the banned literal stays out of the body.
    expect(res.statusCode).toBe(200);
    const body = res.json() as { status: string; reason: string };
    expect(body.status).toBe('refused');
    expect(res.body).not.toContain('the AI output did not match the delta schema');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('RED: the defensive 422 only fires when the LLM is NOT wrapped (e.g. test-injected stub that bypasses repair) (R2, R5)', async () => {
    // No OPENAI_API_KEY in this test — `buildApp` falls back to FakeLlm
    // (not an OpenAiLlm), so the wrapper is NOT applied. Inject a stub that
    // returns Zod-invalid output directly: the defensive 422 must still
    // surface (interpreter:R1).
    delete process.env.OPENAI_API_KEY;

    const app = buildApp({
      logger: false,
      llm: llmStub({ kind: 'delta', value: { kind: 'class', op: 'create', id: 'not-a-uuid' } }),
    });
    const diagram = makeDiagram();
    const id = await createDiagram(app, diagram);

    const res = await app.inject({
      method: 'POST',
      url: `/diagrams/${id}/interpret`,
      payload: { text: 'add a class Invoice' },
    });

    // Wrapper is bypassed: the raw invalid delta hits the interpreter's
    // defensive Zod gate → 422.
    expect(res.statusCode).toBe(422);
    const body = res.json() as { status: string; error: string };
    expect(body.status).toBe('error');
    expect(body.error).toContain('the AI output did not match the delta schema');
  });
});

describe('multi-command utterances (R4) and SUPPORTED_CATEGORIES coverage (R3)', () => {
  it('3.1 a multi-command utterance through the wrapped LLM yields a single BatchDelta with three class creates', async () => {
    const diagram = makeDiagram();
    const batchId = crypto.randomUUID();
    const deltas = [
      {
        kind: 'class', op: 'create', id: crypto.randomUUID(), diagramId: diagram.id, timestamp: new Date().toISOString(),
        classId: crypto.randomUUID(), name: 'Supplier', position: { x: 0, y: 0 },
      },
      {
        kind: 'class', op: 'create', id: crypto.randomUUID(), diagramId: diagram.id, timestamp: new Date().toISOString(),
        classId: crypto.randomUUID(), name: 'Part', position: { x: 100, y: 0 },
      },
      {
        kind: 'class', op: 'create', id: crypto.randomUUID(), diagramId: diagram.id, timestamp: new Date().toISOString(),
        classId: crypto.randomUUID(), name: 'Project', position: { x: 200, y: 0 },
      },
    ];
    const batch = {
      kind: 'batch', id: batchId, diagramId: diagram.id, timestamp: new Date().toISOString(), deltas,
    };
    const app = buildApp({ logger: false, llm: llmStub({ kind: 'delta', value: batch }) });
    const id = await createDiagram(app, diagram);

    const res = await app.inject({
      method: 'POST',
      url: `/diagrams/${id}/interpret`,
      payload: { text: 'create classes Supplier, Part, Project' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { status: string; delta: { kind: string; deltas: { kind: string; op: string; name?: string }[] } };
    expect(body.status).toBe('pending');
    expect(body.delta.kind).toBe('batch');
    expect(body.delta.deltas).toHaveLength(3);
    expect(body.delta.deltas.map((d) => d.kind)).toEqual(['class', 'class', 'class']);
    expect(body.delta.deltas.map((d) => d.name)).toEqual(['Supplier', 'Part', 'Project']);
  });

  it('3.2 a n-ary association utterance is NOT wrapped in a BatchDelta', async () => {
    const diagram = makeDiagram();
    const naryDelta = {
      kind: 'naryAssociation', op: 'create', id: crypto.randomUUID(), diagramId: diagram.id, timestamp: new Date().toISOString(),
      naryAssociationId: crypto.randomUUID(),
      memberEnds: [
        { classId: diagram.classes[0]!.id, multiplicity: '1' },
        { classId: diagram.classes[1]!.id, multiplicity: '1' },
        { classId: crypto.randomUUID(), multiplicity: '1' },
      ],
    };
    const app = buildApp({ logger: false, llm: llmStub({ kind: 'delta', value: naryDelta }) });
    const id = await createDiagram(app, diagram);

    const res = await app.inject({
      method: 'POST',
      url: `/diagrams/${id}/interpret`,
      payload: { text: 'create a ternary association between Supplier, Part, and Project' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { status: string; delta: { kind: string; deltas?: unknown[] } };
    expect(body.status).toBe('pending');
    expect(body.delta.kind).toBe('naryAssociation');
    expect(body.delta.deltas).toBeUndefined();
  });

  it('3.3 SUPPORTED_CATEGORIES covers all 7 Delta kinds plus batch and is typed for export', async () => {
    const { SUPPORTED_CATEGORIES } = await import('./interpreter.js');
    const expected = [
      'add/rename/delete class',
      'add/remove attribute (name: type)',
      'add/remove method (name: returnType)',
      'add/remove association with multiplicities',
      'add/remove n-ary association (3+ members)',
      'create/remove generalization (inheritance)',
      'create interfaces and abstract classes',
      'create/remove realization (class realizes interface)',
      'create/remove dependency (client depends on supplier)',
      'multi-command batch (combine several edits in one delta)',
    ];
    expect(Array.isArray(SUPPORTED_CATEGORIES)).toBe(true);
    for (const label of expected) {
      expect(SUPPORTED_CATEGORIES).toContain(label);
    }
  });
});
