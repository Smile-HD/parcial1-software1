/**
 * Cliente REST tipado para la API de persistencia de diagramas (apps/api).
 *
 * editor:R5 — la aplicación web carga y guarda el diagrama canónico a través
 * de este cliente; el Y.Doc se hidrata a partir de la respuesta de la API (IR JSON) y
 * los guardados se proyectan desde el Y.Doc de regreso al IR JSON.
 */
import type { Delta, Diagram } from '@app/core';

const API_BASE_URL: string = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';

/** Error lanzado ante cualquier respuesta no-OK de la API. */
export class DiagramApiError extends Error {
  readonly status: number;
  /** Presente en respuestas de conflicto 409 (concurrencia optimista). */
  readonly currentVersion?: number | undefined;

  constructor(status: number, message: string, currentVersion?: number) {
    super(message);
    this.name = 'DiagramApiError';
    this.status = status;
    this.currentVersion = currentVersion;
  }
}

/** Recurso REST del diagrama tal como lo retorna la API. */
export interface DiagramResource {
  id: string;
  name: string;
  diagram: Diagram;
  /**
   * Blob de actualización autoritativo de Yjs (base64). Los clientes conectados
   * por colaboración se hidratan desde aquí en lugar de reconstruir un doc desde `diagram`
   * para que sus relojes de Yjs coincidan con los del servidor y las fusiones en vivo
   * nunca dupliquen elementos de arreglos (6b).
   */
  yjsState: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

async function parseErrorResponse(response: Response): Promise<never> {
  let message = `API error ${response.status}`;
  let currentVersion: number | undefined;
  try {
    const body = (await response.json()) as { error?: string; currentVersion?: number };
    if (typeof body.error === 'string' && body.error.length > 0) {
      message = body.error;
    }
    if (typeof body.currentVersion === 'number') {
      currentVersion = body.currentVersion;
    }
  } catch {
    // Cuerpo no-JSON — conservar el mensaje de estado genérico.
  }
  throw new DiagramApiError(response.status, message, currentVersion);
}

async function parseOkResponse<T>(response: Response): Promise<T> {
  try {
    return (await response.json()) as T;
  } catch {
    throw new DiagramApiError(response.status, 'API returned a non-JSON body');
  }
}

/** POST /diagrams — crea un nuevo diagrama. */
export async function createDiagram(name: string, diagram: Diagram): Promise<DiagramResource> {
  const response = await fetch(`${API_BASE_URL}/diagrams`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, diagram }),
  });
  if (!response.ok) {
    await parseErrorResponse(response);
  }
  return parseOkResponse<DiagramResource>(response);
}

/** GET /diagrams/:id — carga un diagrama. */
export async function loadDiagram(id: string): Promise<DiagramResource> {
  const response = await fetch(`${API_BASE_URL}/diagrams/${id}`);
  if (!response.ok) {
    await parseErrorResponse(response);
  }
  return parseOkResponse<DiagramResource>(response);
}

/**
 * PUT /diagrams/:id — guarda un diagrama (concurrencia optimista por versión).
 * `yjsState` transporta el propio blob de Yjs del cliente para que el estado almacenado
 * conserve los relojes que comparten todos los clientes conectados (guardado preservando blob, 6b).
 */
export async function saveDiagram(
  id: string,
  name: string,
  diagram: Diagram,
  version: number,
  yjsState: string,
): Promise<DiagramResource> {
  const response = await fetch(`${API_BASE_URL}/diagrams/${id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, diagram, version, yjsState }),
  });
  if (!response.ok) {
    await parseErrorResponse(response);
  }
  return parseOkResponse<DiagramResource>(response);
}

// ── Intérprete (PR 7, tarea 7.6) ────────────────────────────────────────────

/** Resultado de POST /diagrams/:id/interpret, reflejado desde apps/api. */
export type InterpretResponse =
  | { status: 'refused'; reason: string; supportedCategories: readonly string[] }
  | { status: 'pending'; deltaId: string; delta: Delta }
  | { status: 'error'; message: string };

/**
 * POST /diagrams/:id/interpret — lenguaje natural → rechazo | delta pendiente.
 * Un 422 (la salida del LLM no superó la barrera del esquema delta, interpreter:R1) se expone
 * como un resultado explícito `error` en lugar de un error lanzado para que la UI muestre
 * la misma forma de mensaje ante cualquier rechazo del intérprete.
 */
export async function interpretCommand(diagramId: string, text: string): Promise<InterpretResponse> {
  const response = await fetch(`${API_BASE_URL}/diagrams/${diagramId}/interpret`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (!response.ok) {
    if (response.status === 422) {
      let message = `API error ${response.status}`;
      try {
        const body = (await response.json()) as { error?: string };
        if (typeof body.error === 'string' && body.error.length > 0) {
          message = body.error;
        }
      } catch {
        // Cuerpo no-JSON — conservar el mensaje de estado genérico.
      }
      return { status: 'error', message };
    }
    await parseErrorResponse(response);
  }
  return parseOkResponse<InterpretResponse>(response);
}

/** POST /deltas/:id/confirm — libera el delta pendiente para este cliente. */
export async function confirmDelta(deltaId: string): Promise<{ status: 'confirmed'; delta: Delta; diagramId: string }> {
  const response = await fetch(`${API_BASE_URL}/deltas/${deltaId}/confirm`, { method: 'POST' });
  if (!response.ok) {
    await parseErrorResponse(response);
  }
  return parseOkResponse<{ status: 'confirmed'; delta: Delta; diagramId: string }>(response);
}

/** POST /deltas/:id/reject — descarta el delta pendiente, dejando el modelo sin cambios. */
export async function rejectDelta(deltaId: string): Promise<{ status: 'rejected' }> {
  const response = await fetch(`${API_BASE_URL}/deltas/${deltaId}/reject`, { method: 'POST' });
  if (!response.ok) {
    await parseErrorResponse(response);
  }
  return parseOkResponse<{ status: 'rejected' }>(response);
}
