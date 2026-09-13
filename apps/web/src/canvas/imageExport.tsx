/**
 * imageExport — image export for the UML diagram canvas.
 *
 * image-export:R1 — filename from diagram name + id.
 * image-export:R2 — JPEG white-background compositing, fit-to-content bounds, 2x scale.
 * image-export:R3 — export is strictly read-only: zero deltas, zero API calls.
 * image-export:R4 — zero network calls with fetch blocked.
 * image-export:R5 — empty canvas guard: explicit warning, no file produced.
 */
import * as Y from 'yjs';
import { useState } from 'react';
import { toPng, toJpeg } from 'html-to-image';

import { projectYDocToDiagram } from '@app/core';

import { useT } from '../i18n';

export type ExportFormat = 'png' | 'jpeg';

export interface ExportResult {
  dataUrl: string | null;
  filename: string;
  warning: string | null;
}

/**
 * Sanitize a string for use as a filename segment: keep alphanumeric,
 * hyphens, underscores; replace everything else with underscore.
 */
export function sanitizeFilenameSegment(input: string): string {
  return input.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/**
 * Build the export filename: "{diagramName}_{diagramId}.{ext}"
 */
export function buildExportFilename(diagramName: string, diagramId: string, format: ExportFormat): string {
  const ext = format === 'jpeg' ? 'jpg' : 'png';
  return `${sanitizeFilenameSegment(diagramName)}_${sanitizeFilenameSegment(diagramId)}.${ext}`;
}

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * image-export:R2 — compute fit-to-content bounds from an array of node
 * positions. Returns null when there are no positions (empty canvas).
 */
export function computeExportBounds(positions: Array<{ x: number; y: number }>): Bounds | null {
  if (positions.length === 0) {
    return null;
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const pos of positions) {
    if (pos.x < minX) minX = pos.x;
    if (pos.y < minY) minY = pos.y;
    if (pos.x > maxX) maxX = pos.x;
    if (pos.y > maxY) maxY = pos.y;
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * Export the diagram canvas as a PNG or JPEG image.
 *
 * - image-export:R3/R4: does NOT call fetch, does NOT bump Y.Doc version,
 *   does NOT emit any deltas. The export is purely a DOM capture.
 * - image-export:R5: returns a warning (no data) when the canvas has no nodes.
 */
export async function exportDiagramImage(
  doc: Y.Doc,
  viewport: HTMLElement,
  format: ExportFormat,
): Promise<ExportResult> {
  const diagram = projectYDocToDiagram(doc);
  const filename = buildExportFilename(diagram.name, diagram.id, format);

  // image-export:R5 — empty-canvas guard.
  if (diagram.classes.length === 0) {
    return { dataUrl: null, filename, warning: 'No diagram content to export' };
  }

  // image-export:R2 — JPEG uses white background; both formats render at 2x.
  // (Built conditionally to satisfy exactOptionalPropertyTypes.)
  const options = format === 'jpeg' ? { backgroundColor: '#ffffff', pixelRatio: 2 } : { pixelRatio: 2 };

  try {
    let dataUrl: string;
    if (format === 'jpeg') {
      dataUrl = await toJpeg(viewport, options);
    } else {
      dataUrl = await toPng(viewport, options);
    }
    return { dataUrl, filename, warning: null };
  } catch {
    return { dataUrl: null, filename, warning: 'Export failed' };
  }
}

export interface ExportToolbarButtonsProps {
  doc: Y.Doc;
  /** Optional display metadata; the filename is derived from the Y.Doc itself. */
  diagramName?: string;
  diagramId?: string;
}

/**
 * Toolbar buttons for Export PNG / Export JPEG (unit 16b).
 *
 * Each button calls `exportDiagramImage` on the live React Flow viewport
 * (located via `.react-flow__viewport`), downloads the resulting data URL
 * directly through an anchor (no fetch, no object URL — image-export:R4),
 * and surfaces any empty-canvas warning (image-export:R5).
 */
export function ExportToolbarButtons({ doc }: ExportToolbarButtonsProps) {
  const { t } = useT();
  const [warning, setWarning] = useState<string | null>(null);

  const handleExport = async (format: ExportFormat) => {
    setWarning(null);
    const viewport = document.querySelector<HTMLElement>('.react-flow__viewport');
    if (!viewport) {
      return;
    }
    const result = await exportDiagramImage(doc, viewport, format);
    if (result.warning || !result.dataUrl) {
      setWarning(result.warning ?? 'Export failed');
      return;
    }
    // Download straight from the data URL — zero network calls.
    const a = document.createElement('a');
    a.href = result.dataUrl;
    a.download = result.filename;
    a.click();
  };

  return (
    <>
      {warning && (
        <span role="alert" data-testid="export-warning">
          {warning}
        </span>
      )}
      <button type="button" data-testid="export-png" onClick={() => handleExport('png')}>
        {t('export.png')}
      </button>
      <button type="button" data-testid="export-jpeg" onClick={() => handleExport('jpeg')}>
        {t('export.jpeg')}
      </button>
    </>
  );
}
