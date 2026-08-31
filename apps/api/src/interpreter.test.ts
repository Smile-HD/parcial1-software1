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
import { afterAll, describe, expect, it } from 'vitest';

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
