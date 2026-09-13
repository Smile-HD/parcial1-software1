/**
 * Photo import REST client (PR 16, task 16.3-WEB) — drives the photo import
 * job API exposed by apps/api/src/photo-import.ts.
 *
 * POST /diagrams/:id/photo  → 202 { jobId }
 * GET  /diagrams/:id/photo/:jobId  → { status, batch?, warnings?, error? }
 *
 * Mirrors the pattern in codegenApi.ts (job polling) and xmiApi.ts
 * (typed REST client with DiagramApiError).
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
 * Upload a photo for extraction. Sends the base64-encoded image and
 * returns the job id for polling.
 *
 * photo:R4 — the client MUST call validatePhotoFile + validatePhotoBytes
 * BEFORE this function; this function does NOT validate locally.
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
      // ignore non-JSON body
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
 * Poll job status. Returns the full job result including batch + warnings
 * when succeeded. Throws DiagramApiError on transport / HTTP errors.
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
      // ignore
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
