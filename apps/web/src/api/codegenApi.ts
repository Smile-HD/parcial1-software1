/**
 * Codegen REST client (PR 14a/14d) — talks to apps/api's generate-over-HTTP
 * job API. The web app triggers backend artifact generation and polls job
 * status until the artifact is ready, then triggers a browser download.
 *
 * The state machine the API exposes:
 *   POST /diagrams/:id/generate   -> 202 { jobId } | 404 | 409 (dedup) | 500
 *   GET  /jobs/:id                -> { id, status, artifactReady, error, ... }
 *   GET  /jobs/:id/artifact       -> application/zip | 404 | 409 | 500
 *
 * Status transitions: queued -> running -> succeeded | failed
 * artifactReady is true only when status === 'succeeded'.
 */
import { DiagramApiError } from './diagramApi';

const API_BASE_URL: string = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed';

export interface JobInfo {
  id: string;
  status: JobStatus;
  diagramId: string;
  createdAt: string;
  updatedAt: string;
  artifactReady: boolean;
  error: string | null;
}

/** Kicks off generation for a diagram. Resolves with the job id. */
export async function startGeneration(diagramId: string): Promise<string> {
  const response = await fetch(`${API_BASE_URL}/diagrams/${diagramId}/generate`, {
    method: 'POST',
  });
  if (!response.ok) {
    let message = `Generation request failed (${response.status})`;
    try {
      const body = (await response.json()) as { error?: string };
      if (typeof body.error === 'string' && body.error.length > 0) {
        message = body.error;
      }
    } catch {
      // body wasn't JSON — keep the generic message
    }
    throw new DiagramApiError(response.status, message);
  }
  const body = (await response.json()) as { jobId?: string };
  if (typeof body.jobId !== 'string' || body.jobId.length === 0) {
    throw new DiagramApiError(500, 'Generation endpoint did not return a jobId');
  }
  return body.jobId;
}

/** Polls job status. Throws DiagramApiError on transport / 404. */
export async function getJob(jobId: string): Promise<JobInfo> {
  const response = await fetch(`${API_BASE_URL}/jobs/${jobId}`);
  if (!response.ok) {
    let message = `Failed to read job ${jobId} (${response.status})`;
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
  return (await response.json()) as JobInfo;
}

/** Downloads the zip artifact and returns it as a Blob + suggested filename. */
export async function downloadArtifact(
  jobId: string,
  diagramId: string,
): Promise<{ blob: Blob; filename: string }> {
  const response = await fetch(`${API_BASE_URL}/jobs/${jobId}/artifact`);
  if (!response.ok) {
    let message = `Failed to download artifact (${response.status})`;
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
  const blob = await response.blob();
  const safeName = diagramId.replace(/[^a-zA-Z0-9-]/g, '_');
  return { blob, filename: `generated-${safeName}.zip` };
}

/** Triggers a browser download of the blob under the suggested filename. */
export function triggerBrowserDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  // Give the browser a tick to start the download before revoking.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
