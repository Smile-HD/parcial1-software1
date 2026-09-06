/**
 * Voice input (PR 8, tasks 8.2/8.3) — API-side tests.
 *
 * voice:R2 — POST /diagrams/:id/voice transcribes and routes the transcript
 * through the SAME interpret/confirm pipeline (shared pending store, no
 * privileged path); a whole-design request is refused exactly as with text.
 * voice:R1 — an STT outage is an explicit failure that directs the user to
 * the text command input fallback.
 *
 * STT and LLM are injected as stubs: the endpoint contract is what these
 * tests pin, not the providers.
 */
import { afterAll, describe, expect, it } from 'vitest';

import { SttUnavailableError } from '@app/adapters-ai';
import { buildApp, closePool } from './index.js';
import { DiagramSchema, type Diagram, type LlmPort, type LlmResult, type SttPort } from '@app/core';

function makeDiagram(): Diagram {
  const customerId = crypto.randomUUID();
  return {
    id: crypto.randomUUID(),
    name: 'Voice Test',
    classes: [
      {
        id: customerId,
        name: 'Customer',
        position: { x: 0, y: 0 },
        attributes: [],
        methods: [],
      },
    ],
    associations: [],
    generalizations: [],
    realizations: [],
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

function sttStub(transcript: string | Error): SttPort {
  return {
    transcribe: async () => {
      if (transcript instanceof Error) {
        throw transcript;
      }
      return transcript;
    },
  };
}

function deltaStub(name: string, diagramId: string): unknown {
  return {
    id: crypto.randomUUID(),
    diagramId,
    timestamp: new Date().toISOString(),
    kind: 'class',
    op: 'create',
    classId: crypto.randomUUID(),
    name,
    position: { x: 100, y: 100 },
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

const AUDIO = Buffer.from('fake-audio-bytes').toString('base64');

afterAll(async () => {
  await closePool();
});

describe('voice API (PR 8, tasks 8.2/8.3)', () => {
  it('8.2 routes the transcript into the SAME pipeline: pending delta in the shared store, confirmable, model untouched (voice:R2)', async () => {
    const diagram = makeDiagram();
    const delta = deltaStub('Invoice', diagram.id);
    const app = buildApp({
      logger: false,
      llm: llmStub({ kind: 'delta', value: delta }),
      stt: sttStub('add class Invoice'),
    });
    const id = await createDiagram(app, diagram);

    const res = await app.inject({
      method: 'POST',
      url: `/diagrams/${id}/voice`,
      payload: { audio: AUDIO, mimeType: 'audio/webm' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      transcript: string;
      status: string;
      deltaId: string;
      delta: unknown;
    };
    expect(body.transcript).toBe('add class Invoice');
    expect(body.status).toBe('pending');
    expect(body.deltaId).toBeTruthy();
    expect(body.delta).toEqual(delta);

    // No privileged path: the SAME confirm gate releases the delta.
    const confirm = await app.inject({ method: 'POST', url: `/deltas/${body.deltaId}/confirm` });
    expect(confirm.statusCode).toBe(200);

    // The voice call itself never mutated the model.
    const loaded = await app.inject({ method: 'GET', url: `/diagrams/${id}` });
    // Model untouched. The canonical projection emits the full IR (defaults
    // included), so compare against the parsed diagram — same as interpreter.test.ts.
    expect((loaded.json() as { diagram: Diagram }).diagram).toEqual(DiagramSchema.parse(diagram));
  });

  it('8.2 refuses a whole-design request via voice exactly as with typed input (voice:R2)', async () => {
    const app = buildApp({
      logger: false,
      llm: llmStub({
        kind: 'refused',
        reason: 'I edit an existing model on explicit instruction; I do not generate whole designs.',
      }),
      stt: sttStub('generate me a full design for a hospital'),
    });
    const diagram = makeDiagram();
    const id = await createDiagram(app, diagram);

    const res = await app.inject({
      method: 'POST',
      url: `/diagrams/${id}/voice`,
      payload: { audio: AUDIO, mimeType: 'audio/webm' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { transcript: string; status: string; reason: string };
    expect(body.transcript).toBe('generate me a full design for a hospital');
    expect(body.status).toBe('refused');
    expect(body.reason).toContain('explicit instruction');
  });

  it('8.3 STT outage is an explicit 502 that directs the user to the text input fallback (voice:R1)', async () => {
    const app = buildApp({
      logger: false,
      llm: llmStub({ kind: 'delta', value: {} }),
      stt: sttStub(new SttUnavailableError('service unreachable')),
    });
    const diagram = makeDiagram();
    const id = await createDiagram(app, diagram);

    const res = await app.inject({
      method: 'POST',
      url: `/diagrams/${id}/voice`,
      payload: { audio: AUDIO, mimeType: 'audio/webm' },
    });

    expect(res.statusCode).toBe(502);
    const body = res.json() as { error: string };
    expect(body.error).toContain('Speech-to-text unavailable');
    expect(body.error).toContain('text command input');

    // Model untouched.
    const loaded = await app.inject({ method: 'GET', url: `/diagrams/${id}` });
    // Model untouched. The canonical projection emits the full IR (defaults
    // included), so compare against the parsed diagram — same as interpreter.test.ts.
    expect((loaded.json() as { diagram: Diagram }).diagram).toEqual(DiagramSchema.parse(diagram));
  });

  it('rejects a voice request without audio with 400', async () => {
    const app = buildApp({ logger: false, llm: llmStub({ kind: 'delta', value: {} }), stt: sttStub('x') });
    const diagram = makeDiagram();
    const id = await createDiagram(app, diagram);

    const res = await app.inject({ method: 'POST', url: `/diagrams/${id}/voice`, payload: {} });
    expect(res.statusCode).toBe(400);
  });

  it('returns 404 when the diagram does not exist', async () => {
    const app = buildApp({ logger: false, llm: llmStub({ kind: 'delta', value: {} }), stt: sttStub('x') });
    const res = await app.inject({
      method: 'POST',
      url: `/diagrams/${crypto.randomUUID()}/voice`,
      payload: { audio: AUDIO, mimeType: 'audio/webm' },
    });
    expect(res.statusCode).toBe(404);
  });
});
