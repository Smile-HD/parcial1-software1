/**
 * Cliente REST de codegen (PR 14a/14d) — se comunica con la API de trabajos
 * generate-over-HTTP de apps/api. La aplicación web dispara la generación de artefactos
 * en el backend y consulta el estado del trabajo hasta que el artefacto esté listo,
 * para luego iniciar la descarga en el navegador.
 *
 * Máquina de estados expuesta por la API:
 *   POST /diagrams/:id/generate   -> 202 { jobId } | 404 | 409 (dedup) | 500
 *   GET  /jobs/:id                -> { id, status, artifactReady, error, ... }
 *   GET  /jobs/:id/artifact       -> application/zip | 404 | 409 | 500
 *
 * Transiciones de estado: queued -> running -> succeeded | failed
 * artifactReady es true únicamente cuando status === 'succeeded'.
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

/** Inicia la generación para un diagrama. Se resuelve con el id del trabajo. */
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
      // el cuerpo no era JSON — conservar el mensaje genérico
    }
    throw new DiagramApiError(response.status, message);
  }
  const body = (await response.json()) as { jobId?: string };
  if (typeof body.jobId !== 'string' || body.jobId.length === 0) {
    throw new DiagramApiError(500, 'Generation endpoint did not return a jobId');
  }
  return body.jobId;
}

/** Consulta el estado del trabajo. Lanza DiagramApiError en errores de transporte / 404. */
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
      // ignorar
    }
    throw new DiagramApiError(response.status, message);
  }
  return (await response.json()) as JobInfo;
}

/** Descarga el artefacto zip y lo retorna como un Blob + nombre de archivo sugerido. */
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
      // ignorar
    }
    throw new DiagramApiError(response.status, message);
  }
  const blob = await response.blob();
  const safeName = diagramId.replace(/[^a-zA-Z0-9-]/g, '_');
  return { blob, filename: `generated-${safeName}.zip` };
}

/** Inicia la descarga en el navegador del blob con el nombre de archivo sugerido. */
export function triggerBrowserDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  // Dar un tick al navegador para iniciar la descarga antes de revocar.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
