/**
 * Cliente REST de importación XMI (PR 15) — envía un archivo XMI 2.1 a la API y
 * retorna el delta de lote parseado. El cliente web lo aplica atómicamente a su
 * Y.Doc; el servidor NO muta el diagrama (la respuesta transporta
 * el delta de lote, no el nuevo estado del diagrama).
 *
 * Endpoint: POST /diagrams/:id/import/xmi
 * Cuerpo:   { xmi: string }   (texto XMI sin procesar)
 * Respuesta:{ deltaId, batch: BatchDelta, summary: {...conteos...} }
 */
import type { BatchDelta } from '@app/core';

import { DiagramApiError } from './diagramApi';

const API_BASE_URL: string = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';

export interface XmiImportSummary {
  classes: number;
  associations: number;
  generalizations: number;
  realizations: number;
  dependencies: number;
  naryAssociations: number;
}

export interface XmiImportResult {
  deltaId: string;
  batch: BatchDelta;
  summary: XmiImportSummary;
}

export async function importXmi(diagramId: string, xmiText: string): Promise<XmiImportResult> {
  const response = await fetch(`${API_BASE_URL}/diagrams/${diagramId}/import/xmi`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ xmi: xmiText }),
  });
  if (!response.ok) {
    let message = `XMI import failed (${response.status})`;
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
  const body = (await response.json()) as {
    deltaId?: string;
    batch?: BatchDelta;
    summary?: XmiImportSummary;
  };
  if (!body.batch) {
    throw new DiagramApiError(500, 'XMI import response did not include batch');
  }
  return {
    deltaId: typeof body.deltaId === 'string' ? body.deltaId : `import-${Date.now()}`,
    batch: body.batch,
    summary: body.summary ?? {
      classes: 0,
      associations: 0,
      generalizations: 0,
      realizations: 0,
      dependencies: 0,
      naryAssociations: 0,
    },
  };
}

/**
 * Exporta un diagrama como XMI 2.1 para descarga (PR 15b).
 * Endpoint: GET /diagrams/:id/export/xmi
 * Respuesta: archivo .xmi como adjunto (application/xml)
 */
export async function exportXmi(diagramId: string): Promise<Blob> {
  const response = await fetch(`${API_BASE_URL}/diagrams/${diagramId}/export/xmi`);
  if (!response.ok) {
    let message = `XMI export failed (${response.status})`;
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
  return response.blob();
}
