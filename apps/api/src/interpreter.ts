/**
 * Interpreter service (PR 7, tasks 7.1–7.5).
 *
 * Flow: utterance + current IR → LlmPort → either a refusal or a candidate
 * delta. The candidate is Zod-validated against the delta schema here
 * (interpreter:R1): malformed model output NEVER reaches the canonical model.
 * Valid candidates are stored as PENDING and are only released to the client
 * after explicit confirm (interpreter:R2) — the API never mutates the diagram
 * on behalf of the interpreter; the confirming client applies the delta to
 * its Y.Doc and propagates it through the collab transport (blob-preserving,
 * work unit 6b).
 */
import { DeltaSchema, deltaJsonSchema, type Delta, type Diagram, type LlmPort, type LlmResult } from '@app/core';

/** Surfaced on refusals so the user knows the bounded command set (interpreter:R4). */
export const SUPPORTED_CATEGORIES: readonly string[] = [
  'add/rename/delete class',
  'add/remove attribute (name: type)',
  'add/remove method (name: returnType)',
  'add/remove association with multiplicities',
];

export interface PendingDelta {
  id: string;
  diagramId: string;
  delta: Delta;
  createdAt: string;
}

/** In-memory pending store: pending deltas live until confirmed or rejected. */
export class PendingDeltaStore {
  private readonly map = new Map<string, PendingDelta>();

  put(diagramId: string, delta: Delta): PendingDelta {
    const pending: PendingDelta = {
      id: crypto.randomUUID(),
      diagramId,
      delta,
      createdAt: new Date().toISOString(),
    };
    this.map.set(pending.id, pending);
    return pending;
  }

  /** Atomically consumes the pending delta (confirm and reject both consume). */
  take(id: string): PendingDelta | undefined {
    const pending = this.map.get(id);
    if (pending) {
      this.map.delete(id);
    }
    return pending;
  }
}

export type InterpretOutcome =
  | { status: 'refused'; reason: string; supportedCategories: readonly string[] }
  | { status: 'pending'; deltaId: string; delta: Delta }
  | { status: 'error'; message: string };

export class LlmUnavailableError extends Error {}

export async function interpretCommand(
  text: string,
  llm: LlmPort,
  currentIr: Diagram,
  store: PendingDeltaStore,
): Promise<InterpretOutcome> {
  let result: LlmResult;
  try {
    result = await llm.interpret(text, deltaJsonSchema, currentIr);
  } catch (error) {
    // Transport/configuration failures are NOT schema-validation failures.
    throw new LlmUnavailableError(error instanceof Error ? error.message : 'LLM unavailable');
  }

  if (result.kind === 'refused') {
    return { status: 'refused', reason: result.reason, supportedCategories: SUPPORTED_CATEGORIES };
  }

  // interpreter:R1 — the gate. Free-form model output never passes through.
  const parsed = DeltaSchema.safeParse(result.value);
  if (!parsed.success) {
    return {
      status: 'error',
      message: 'The command could not be interpreted: the AI output did not match the delta schema.',
    };
  }

  const pending = store.put(currentIr.id, parsed.data);
  return { status: 'pending', deltaId: pending.id, delta: pending.delta };
}
