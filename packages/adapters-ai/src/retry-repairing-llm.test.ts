/**
 * RetryRepairingLlmPort (interpreter-llm-resilience, R1) — RED tests.
 *
 * The decorator wraps any LlmPort and, on a Zod delta-schema failure, retries
 * the inner port with a concise repair prompt. The shape of the contract:
 *
 * - First attempt valid → 1 call, return the validated delta.
 * - First invalid, second valid → 2 calls, return the second.
 * - All attempts invalid → return a refusal whose reason carries the Zod
 *   digest; call count equals maxAttempts.
 * - `maxAttempts` is clamped: 0 → 1, > 3 → 3.
 * - Transport errors from the inner port propagate untouched; no retry.
 *
 * These tests pin the decorator in isolation — no Fastify, no Postgres.
 */
import { describe, expect, it } from 'vitest';
import { DeltaSchema, type Diagram, type LlmPort, type LlmResult } from '@app/core';
import { RetryRepairingLlmPort } from './retry-repairing-llm.js';

function emptyDiagram(): Diagram {
  return {
    id: crypto.randomUUID(),
    name: 'Retry Test',
    classes: [],
    associations: [],
    generalizations: [],
    realizations: [],
    dependencies: [],
    naryAssociations: [],
  };
}

function classCreateDelta(diagramId: string, name: string): unknown {
  return {
    kind: 'class',
    op: 'create',
    id: crypto.randomUUID(),
    diagramId,
    timestamp: new Date().toISOString(),
    classId: crypto.randomUUID(),
    name,
    position: { x: 0, y: 0 },
  };
}

interface StubLlm {
  port: LlmPort;
  state: { calls: number; lastRepairUtterance: string | null };
}

function stubLlm(results: ReadonlyArray<LlmResult>): StubLlm {
  const state = { calls: 0, lastRepairUtterance: null as string | null };
  const port: LlmPort = {
    interpret: async (utterance: string) => {
      const idx = state.calls;
      state.calls += 1;
      if (utterance.startsWith('repair:')) {
        state.lastRepairUtterance = utterance;
      }
      const next = results[idx] ?? results[results.length - 1];
      if (next === undefined) {
        throw new Error('stub exhausted');
      }
      return next;
    },
  };
  return { port, state };
}

const schema = DeltaSchema;

describe('RetryRepairingLlmPort (R1) — first-attempt-valid passes through', () => {
  it('returns the validated delta on the first attempt and calls the inner port exactly once', async () => {
    const diagram = emptyDiagram();
    const value = classCreateDelta(diagram.id, 'Invoice');
    const stub = stubLlm([{ kind: 'delta', value }]);
    const decorator = new RetryRepairingLlmPort(stub.port, { maxAttempts: 2 });

    const result = await decorator.interpret('add class Invoice', schema, diagram);

    expect(result.kind).toBe('delta');
    if (result.kind === 'delta') {
      expect(result.value).toEqual(value);
    }
    expect(stub.state.calls).toBe(1);
  });
});

describe('RetryRepairingLlmPort (R1) — first invalid, second valid', () => {
  it('returns the second (validated) delta and calls the inner port exactly twice', async () => {
    const diagram = emptyDiagram();
    const goodValue = classCreateDelta(diagram.id, 'Customer');
    const stub = stubLlm([
      { kind: 'delta', value: { kind: 'class', op: 'create', id: 'not-a-uuid' } },
      { kind: 'delta', value: goodValue },
    ]);
    const decorator = new RetryRepairingLlmPort(stub.port, { maxAttempts: 2 });

    const result = await decorator.interpret('add class Customer', schema, diagram);

    expect(result.kind).toBe('delta');
    if (result.kind === 'delta') {
      expect(result.value).toEqual(goodValue);
    }
    expect(stub.state.calls).toBe(2);
    // The second call was a repair prompt.
    expect(stub.state.lastRepairUtterance).not.toBeNull();
    expect(stub.state.lastRepairUtterance).toMatch(/^repair:/);
  });
});

describe('RetryRepairingLlmPort (R1) — all attempts invalid', () => {
  it('returns a refused outcome with a reason that includes the Zod digest; call count equals maxAttempts', async () => {
    const diagram = emptyDiagram();
    const stub = stubLlm([
      { kind: 'delta', value: { kind: 'class', op: 'create', id: 'not-a-uuid' } },
      { kind: 'delta', value: { kind: 'class', op: 'create', id: 'still-not-a-uuid' } },
    ]);
    const decorator = new RetryRepairingLlmPort(stub.port, { maxAttempts: 2 });

    const result = await decorator.interpret('add class Anything', schema, diagram);

    expect(result.kind).toBe('refused');
    if (result.kind === 'refused') {
      expect(result.reason).toContain('Issues:');
      // Digest carries at least one /path: message line.
      expect(result.reason).toMatch(/\/id:/);
    }
    expect(stub.state.calls).toBe(2);
  });
});

describe('RetryRepairingLlmPort (R1) — maxAttempts clamping', () => {
  it('clamps maxAttempts = 0 up to 1: single attempt, refusal on Zod failure, no retry', async () => {
    const diagram = emptyDiagram();
    const stub = stubLlm([{ kind: 'delta', value: { kind: 'class', op: 'create', id: 'bad' } }]);
    const decorator = new RetryRepairingLlmPort(stub.port, { maxAttempts: 0 });

    const result = await decorator.interpret('add class X', schema, diagram);

    expect(result.kind).toBe('refused');
    expect(stub.state.calls).toBe(1);
    // No repair prompt was issued.
    expect(stub.state.lastRepairUtterance).toBeNull();
  });

  it('clamps maxAttempts = 10 down to 3: three attempts, refusal on Zod failure', async () => {
    const diagram = emptyDiagram();
    const stub = stubLlm([
      { kind: 'delta', value: { kind: 'class', op: 'create', id: 'bad-1' } },
      { kind: 'delta', value: { kind: 'class', op: 'create', id: 'bad-2' } },
      { kind: 'delta', value: { kind: 'class', op: 'create', id: 'bad-3' } },
    ]);
    const decorator = new RetryRepairingLlmPort(stub.port, { maxAttempts: 10 });

    const result = await decorator.interpret('add class X', schema, diagram);

    expect(result.kind).toBe('refused');
    expect(stub.state.calls).toBe(3);
  });

  it('uses the constructor default of 2 attempts when maxAttempts is omitted', async () => {
    const diagram = emptyDiagram();
    const stub = stubLlm([
      { kind: 'delta', value: { kind: 'class', op: 'create', id: 'bad-1' } },
      { kind: 'delta', value: { kind: 'class', op: 'create', id: 'bad-2' } },
    ]);
    const decorator = new RetryRepairingLlmPort(stub.port);

    const result = await decorator.interpret('add class X', schema, diagram);

    expect(result.kind).toBe('refused');
    expect(stub.state.calls).toBe(2);
  });
});

describe('RetryRepairingLlmPort (R2) — transport errors bypass retry', () => {
  it('inner LLM throws → exception propagates untouched, no retry', async () => {
    const diagram = emptyDiagram();
    const boom = new Error('LLM transport exploded');
    const port: LlmPort = {
      interpret: async () => {
        throw boom;
      },
    };
    const decorator = new RetryRepairingLlmPort(port, { maxAttempts: 5 });

    let caught: unknown = null;
    try {
      await decorator.interpret('add class X', schema, diagram);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBe(boom);
  });
});
