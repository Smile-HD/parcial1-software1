/**
 * imageExport — exportación de imágenes para el lienzo de diagrama UML.
 *
 * image-export:R1 — nombre de archivo a partir del nombre del diagrama + id.
 * image-export:R2 — composición de fondo blanco en JPEG, límites ajustados al contenido, escala 2x.
 * image-export:R3 — la exportación es estrictamente de solo lectura: cero deltas, cero llamadas a API.
 * image-export:R4 — cero llamadas de red con fetch bloqueado.
 * image-export:R5 — protección contra lienzo vacío: advertencia explícita, ningún archivo producido.
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
 * Sanitiza una cadena para su uso como segmento de nombre de archivo: conserva caracteres alfanuméricos,
 * guiones y guiones bajos; reemplaza todo lo demás con un guion bajo.
 */
export function sanitizeFilenameSegment(input: string): string {
  return input.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/**
 * Construye el nombre de archivo de exportación: "{diagramName}_{diagramId}.{ext}"
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
 * image-export:R2 — calcula los límites ajustados al contenido a partir de un arreglo de
 * posiciones de nodo. Retorna null cuando no hay posiciones (lienzo vacío).
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
 * Exporta el lienzo del diagrama como una imagen PNG o JPEG.
 *
 * - image-export:R3/R4: NO llama a fetch, NO incrementa la versión de Y.Doc,
 *   NO emite ningún delta. La exportación es puramente una captura del DOM.
 * - image-export:R5: retorna una advertencia (sin datos) cuando el lienzo no tiene nodos.
 */
export async function exportDiagramImage(
  doc: Y.Doc,
  viewport: HTMLElement,
  format: ExportFormat,
): Promise<ExportResult> {
  const diagram = projectYDocToDiagram(doc);
  const filename = buildExportFilename(diagram.name, diagram.id, format);

  // image-export:R5 — protección contra lienzo vacío.
  if (diagram.classes.length === 0) {
    return { dataUrl: null, filename, warning: 'No diagram content to export' };
  }

  // image-export:R2 — JPEG usa fondo blanco; ambos formatos renderizan a 2x.
  // (Construido condicionalmente para satisfacer exactOptionalPropertyTypes.)
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
  /** Metadatos de visualización opcionales; el nombre de archivo se deriva del propio Y.Doc. */
  diagramName?: string;
  diagramId?: string;
}

/**
 * Botones de la barra de herramientas para Export PNG / Export JPEG (unidad 16b).
 *
 * Cada botón llama a `exportDiagramImage` en el viewport activo de React Flow
 * (ubicado mediante `.react-flow__viewport`), descarga la URL de datos resultante
 * directamente a través de un hipervínculo (sin fetch, sin object URL — image-export:R4),
 * y muestra cualquier advertencia de lienzo vacío (image-export:R5).
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
    // Descargar directo de la URL de datos — cero llamadas de red.
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
