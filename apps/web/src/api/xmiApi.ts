/**
 * XMI import REST client (PR 15) — sends an XMI 2.1 file to the API and
 * returns the parsed batch delta. The web client applies it atomically to its
 * Y.Doc; the server does NOT mutate the diagram (the response carries
 * the batch delta, not the new diagram state).
 *
 * Endpoint: POST /diagrams/:id/import/xmi
 * Body:     { xmi: string }   (raw XMI text)
 * Reply:    { deltaId, batch: BatchDelta, summary: {...counts...} }
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
      // ignore non-JSON body
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
