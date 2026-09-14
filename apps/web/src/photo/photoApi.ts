/**
 * Cliente REST de importación de fotos (PR 16, tarea 16.3-WEB) — gestiona la API
 * de trabajos de importación de fotos expuesta por apps/api/src/photo-import.ts.
 *
 * POST /diagrams/:id/photo  → 202 { jobId }
 * GET  /diagrams/:id/photo/:jobId  → { status, batch?, warnings?, error? }
 *
 * Refleja el patrón de codegenApi.ts (sondeo de trabajos) y xmiApi.ts
 * (cliente REST tipado con DiagramApiError).
 */
import type { BatchDelta } from '@app/core';

import { DiagramApiError } from '../api/diagramApi';

const API_BASE_URL: string = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';

export type PhotoJobStatus = 'queued' | 'running' | 'succeeded' | 'failed';

export interface PhotoJobResult {
  id: string;
  status: PhotoJobStatus;
  diagramId: string;
  batch?: BatchDelta;
  warnings?: string[];
  error?: string;
}

/**
 * Sube una foto para extracción. Envía la imagen codificada en base64 y
 * retorna el id del trabajo para sondeo.
 *
 * photo:R4 — el cliente DEBE llamar a validatePhotoFile + validatePhotoBytes
 * ANTES de esta función; esta función NO valida localmente.
 */
export async function uploadPhoto(
  diagramId: string,
  imageBase64: string,
  mimeType: string,
): Promise<string> {
  const response = await fetch(`${API_BASE_URL}/diagrams/${diagramId}/photo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: imageBase64, mimeType }),
  });
  if (!response.ok) {
    let message = `Photo upload failed (${response.status})`;
    try {
      const body = (await response.json()) as { error?: string };
      if (typeof body.error === 'string' && body.error.length > 0) {
        message = body.error;
      }
    } catch {
      // ignorar cuerpo no-JSON
    }
    throw new DiagramApiError(response.status, message);
  }
  const body = (await response.json()) as { jobId?: string };
  if (typeof body.jobId !== 'string' || body.jobId.length === 0) {
    throw new DiagramApiError(500, 'Photo endpoint did not return a jobId');
  }
  return body.jobId;
}

/**
 * Consulta el estado del trabajo. Retorna el resultado completo del trabajo incluyendo lote + advertencias
 * en caso de éxito. Lanza DiagramApiError ante errores de transporte / HTTP.
 */
export async function getPhotoJob(diagramId: string, jobId: string): Promise<PhotoJobResult> {
  const response = await fetch(
    `${API_BASE_URL}/diagrams/${diagramId}/photo/${jobId}`,
  );
  if (!response.ok) {
    let message = `Failed to read photo job ${jobId} (${response.status})`;
    try {
      const body = (await response.json()) as { error?: string };
      if (typeof body.error === 'string' && body.error.length > 0) {
        message = body.error;
      }
    } catch {
      // ignorar
    }
    throw new DiagramApiError(response.status, message);
  }
  const body = (await response.json()) as {
    id?: string;
    status?: PhotoJobStatus;
    diagramId?: string;
    batch?: BatchDelta;
    warnings?: string[];
    error?: string;
  };
  return {
    id: body.id ?? jobId,
    status: body.status ?? 'failed',
    diagramId: body.diagramId ?? diagramId,
    ...(body.batch !== undefined ? { batch: body.batch } : {}),
    ...(body.warnings !== undefined ? { warnings: body.warnings } : {}),
    ...(body.error !== undefined ? { error: body.error } : {}),
  };
}
