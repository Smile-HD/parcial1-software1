/**
 * Servicio del intérprete (PR 7, tareas 7.1–7.5).
 *
 * Flujo: elocución + IR actual → LlmPort → o un rechazo o un delta candidato.
 * El candidato es validado con Zod contra el esquema de deltas aquí
 * (interpreter:R1): la salida malformada del modelo NUNCA alcanza el modelo canónico.
 * Los candidatos válidos se guardan como PENDIENTES y solo se entregan al cliente
 * tras confirmación explícita (interpreter:R2) — la API nunca muta el diagrama
 * en nombre del intérprete; el cliente que confirma aplica el delta a su
 * Y.Doc y lo propaga a través del transporte de colaboración (preservando blobs,
 * unidad de trabajo 6b).
 */
import { DeltaSchema, deltaJsonSchema, type Delta, type Diagram, type LlmPort, type LlmResult } from '@app/core';

/**
 * Se expone en los rechazos para que el usuario conozca el conjunto acotado de comandos
 * (interpreter:R4 + interpreter-llm-resilience R3). Cubre cada tipo en la unión
 * discriminada de `DeltaSchema`: class, member, association, generalization,
 * realization, dependency, n-ary association, Y batch.
 *
 * La lista es un `readonly string[]` (no un enum cerrado) para que el texto de cara
 * al usuario permanezca en lenguaje natural, pero una constante separada `SUPPORTED_DELTA_KINDS`
 * fija la pertenencia a la unión discriminada para seguridad en tiempo de compilación.
 */
export const SUPPORTED_CATEGORIES: readonly string[] = [
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

/**
 * Fijación en tiempo de compilación de la unión discriminada de `DeltaSchema`.
 * Cada entrada DEBE coincidir con un literal `kind` en
 * `packages/core/src/delta.ts:DeltaSchema` (interpreter-llm-resilience R3:
 * SUPPORTED_CATEGORIES enumera los 7 tipos individuales + batch).
 */
export const SUPPORTED_DELTA_KINDS = [
  'class',
  'member',
  'association',
  'generalization',
  'realization',
  'dependency',
  'naryAssociation',
  'batch',
] as const;
export type SupportedDeltaKind = (typeof SUPPORTED_DELTA_KINDS)[number];

export interface PendingDelta {
  id: string;
  diagramId: string;
  delta: Delta;
  createdAt: string;
}

/** Almacén en memoria de deltas pendientes: viven hasta ser confirmados o rechazados. */
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

  /** Consume atómicamente el delta pendiente (tanto confirm como reject lo consumen). */
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
    // Las fallas de transporte/configuración NO son fallas de validación de esquema.
    throw new LlmUnavailableError(error instanceof Error ? error.message : 'LLM unavailable');
  }

  if (result.kind === 'refused') {
    return { status: 'refused', reason: result.reason, supportedCategories: SUPPORTED_CATEGORIES };
  }

  // interpreter:R1 — la compuerta. La salida de formato libre del modelo nunca pasa.
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
