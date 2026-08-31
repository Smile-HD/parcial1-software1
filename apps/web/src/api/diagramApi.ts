/**
 * Typed REST client for the diagram persistence API (apps/api).
 *
 * editor:R5 — the web app loads and saves the canonical diagram through
 * this client; the Y.Doc is hydrated from the API response (JSON IR) and
 * saves are projected from the Y.Doc back to JSON IR.
 */
import type { Delta, Diagram } from '@app/core';

const API_BASE_URL: string = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';

/** Error thrown for every non-OK API response. */
export class DiagramApiError extends Error {
  readonly status: number;
  /** Present on 409 conflict responses (optimistic concurrency). */
  readonly currentVersion?: number | undefined;

  constructor(status: number, message: string, currentVersion?: number) {
    super(message);
    this.name = 'DiagramApiError';
    this.status = status;
    this.currentVersion = currentVersion;
  }
}

/** Diagram REST resource as returned by the API. */
export interface DiagramResource {
  id: string;
  name: string;
  diagram: Diagram;
  /**
   * Authoritative Yjs update blob (base64). Collab-connected clients hydrate
   * from this instead of rebuilding a doc from `diagram` so their Yjs clocks
   * match the server's and live merges never duplicate array members (6b).
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
    // Non-JSON body — keep the generic status message.
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

/** POST /diagrams — create a new diagram. */
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

/** GET /diagrams/:id — load a diagram. */
export async function loadDiagram(id: string): Promise<DiagramResource> {
  const response = await fetch(`${API_BASE_URL}/diagrams/${id}`);
  if (!response.ok) {
    await parseErrorResponse(response);
  }
  return parseOkResponse<DiagramResource>(response);
}

/**
 * PUT /diagrams/:id — save a diagram (optimistic concurrency by version).
 * `yjsState` carries the client's own Yjs blob so the stored state keeps the
 * clocks every connected client shares (blob-preserving save, 6b).
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

// ── Interpreter (PR 7, task 7.6) ────────────────────────────────────────────

/** Outcome of POST /diagrams/:id/interpret, mirrored from apps/api. */
export type InterpretResponse =
  | { status: 'refused'; reason: string; supportedCategories: readonly string[] }
  | { status: 'pending'; deltaId: string; delta: Delta }
  | { status: 'error'; message: string };

/**
 * POST /diagrams/:id/interpret — natural language → refusal | pending delta.
 * A 422 (LLM output failed the delta-schema gate, interpreter:R1) is surfaced
 * as an explicit `error` outcome instead of a thrown error so the UI shows
 * the same message shape for every interpreter rejection.
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
        // Non-JSON body — keep the generic status message.
      }
      return { status: 'error', message };
    }
    await parseErrorResponse(response);
  }
  return parseOkResponse<InterpretResponse>(response);
}

/** POST /deltas/:id/confirm — releases the pending delta to this client. */
export async function confirmDelta(deltaId: string): Promise<{ status: 'confirmed'; delta: Delta; diagramId: string }> {
  const response = await fetch(`${API_BASE_URL}/deltas/${deltaId}/confirm`, { method: 'POST' });
  if (!response.ok) {
    await parseErrorResponse(response);
  }
  return parseOkResponse<{ status: 'confirmed'; delta: Delta; diagramId: string }>(response);
}

/** POST /deltas/:id/reject — discards the pending delta, model unchanged. */
export async function rejectDelta(deltaId: string): Promise<{ status: 'rejected' }> {
  const response = await fetch(`${API_BASE_URL}/deltas/${deltaId}/reject`, { method: 'POST' });
  if (!response.ok) {
    await parseErrorResponse(response);
  }
  return parseOkResponse<{ status: 'rejected' }>(response);
}
