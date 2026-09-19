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
import { useEffect, useState } from 'react';
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

export interface DynamicExportBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * image-export:R2 — Calcula límites dinámicos ajustados al contenido del diagrama.
 * Encuadra todas las clases con sus dimensiones estimadas o leídas del DOM
 * más un margen de resguardo (padding = 40px) para evitar exportar lienzos vacíos.
 */
export function computeDynamicDiagramBounds(
  classes: Array<{ id: string; position: { x: number; y: number } }>,
  viewport?: HTMLElement | null,
  padding = 40,
): DynamicExportBounds | null {
  if (classes.length === 0) {
    return null;
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const cls of classes) {
    let nodeWidth = 220;
    let nodeHeight = 140;

    if (viewport) {
      const nodeEl = viewport.querySelector<HTMLElement>(`.react-flow__node[data-id="${cls.id}"]`);
      if (nodeEl && nodeEl.offsetWidth > 0 && nodeEl.offsetHeight > 0) {
        nodeWidth = nodeEl.offsetWidth;
        nodeHeight = nodeEl.offsetHeight;
      }
    }

    const x1 = cls.position.x;
    const y1 = cls.position.y;
    const x2 = cls.position.x + nodeWidth;
    const y2 = cls.position.y + nodeHeight;

    if (x1 < minX) minX = x1;
    if (y1 < minY) minY = y1;
    if (x2 > maxX) maxX = x2;
    if (y2 > maxY) maxY = y2;
  }

  const left = Math.round(minX - padding);
  const top = Math.round(minY - padding);
  const width = Math.round(maxX - minX + padding * 2);
  const height = Math.round(maxY - minY + padding * 2);

  return {
    x: left,
    y: top,
    width: Math.max(width, 200),
    height: Math.max(height, 150),
  };
}

/**
 * Exporta el lienzo del diagrama como una imagen PNG o JPEG con encuadre dinámico.
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

  const bounds = computeDynamicDiagramBounds(diagram.classes, viewport, 40);

  // image-export:R2 — JPEG usa fondo blanco; ambos formatos renderizan a 2x y encuadran el contenido dinámicamente.
  const options: Record<string, unknown> = {
    pixelRatio: 2,
    ...(format === 'jpeg' ? { backgroundColor: '#ffffff' } : { backgroundColor: undefined }),
  };

  if (bounds) {
    options.width = bounds.width;
    options.height = bounds.height;
    options.style = {
      transform: `translate(${-bounds.x}px, ${-bounds.y}px) scale(1)`,
      width: `${bounds.width}px`,
      height: `${bounds.height}px`,
    };
    options.filter = (node: HTMLElement) => {
      // Excluir elementos decorativos de fondo o guías de página de la exportación
      if (node.classList?.contains('diagram-canvas-boundary')) return false;
      return true;
    };
  }

  try {
    let dataUrl: string;
    if (format === 'jpeg') {
      dataUrl = await toJpeg(viewport, options as any);
    } else {
      dataUrl = await toPng(viewport, options as any);
    }
    return {
      dataUrl,
      filename,
      warning: null,
      width: bounds ? bounds.width * 2 : undefined,
      height: bounds ? bounds.height * 2 : undefined,
    };
  } catch {
    return { dataUrl: null, filename, warning: 'Export failed' };
  }
}

export interface ExportPreviewState {
  dataUrl: string;
  filename: string;
  format: ExportFormat;
  width?: number;
  height?: number;
}

interface ExportPreviewModalProps {
  preview: ExportPreviewState;
  onDownload: () => void;
  onClose: () => void;
}

/**
 * Modal de vista previa para la imagen exportada antes de descargarla.
 */
export function ExportPreviewModal({ preview, onDownload, onClose }: ExportPreviewModalProps) {
  const { t } = useT();

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  return (
    <div className="modal-backdrop" data-testid="export-preview-modal" onClick={onClose}>
      <div
        className="modal-dialog export-preview-dialog"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="export-preview-title"
      >
        <div className="modal-dialog__header">
          <h2 id="export-preview-title" className="modal-dialog__title">
            {t('export.previewTitle')}
          </h2>
          <button
            type="button"
            className="modal-dialog__close"
            onClick={onClose}
            aria-label={t('export.closeAria')}
            data-testid="export-preview-close"
          >
            ×
          </button>
        </div>

        <div className="modal-dialog__body">
          <p className="export-preview__subtitle">{t('export.previewSubtitle')}</p>

          <div className="export-preview__viewport">
            <img
              src={preview.dataUrl}
              alt={preview.filename}
              className="export-preview__img"
              data-testid="export-preview-image"
            />
          </div>

          <div className="export-preview__meta">
            <div className="export-preview__meta-item">
              <span className="export-preview__meta-label">{t('export.format')}:</span>
              <span className="export-preview__badge">{preview.format.toUpperCase()}</span>
            </div>
            {preview.width && preview.height && (
              <div className="export-preview__meta-item">
                <span className="export-preview__meta-label">{t('export.dimensions')}:</span>
                <span className="export-preview__badge">
                  {preview.width} × {preview.height} px
                </span>
              </div>
            )}
            <div className="export-preview__meta-item">
              <span className="export-preview__meta-filename">{preview.filename}</span>
            </div>
          </div>
        </div>

        <div className="modal-dialog__footer">
          <button
            type="button"
            className="modal-button modal-button--secondary"
            onClick={onClose}
            data-testid="export-preview-cancel"
          >
            {t('export.cancel')}
          </button>
          <button
            type="button"
            className="modal-button modal-button--primary"
            onClick={onDownload}
            data-testid="export-preview-download"
          >
            {t('export.download')}
          </button>
        </div>
      </div>
    </div>
  );
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
 * Abre un cuadro de diálogo con la vista previa del contenido renderizado y encuadrado
 * de forma dinámica según la posición de los elementos, permitiendo confirmar la descarga.
 */
export function ExportToolbarButtons({ doc }: ExportToolbarButtonsProps) {
  const { t } = useT();
  const [warning, setWarning] = useState<string | null>(null);
  const [preview, setPreview] = useState<ExportPreviewState | null>(null);
  const [isExporting, setIsExporting] = useState(false);

  const handleExport = async (format: ExportFormat) => {
    setWarning(null);
    const viewport = document.querySelector<HTMLElement>('.react-flow__viewport');
    if (!viewport) {
      return;
    }
    setIsExporting(true);
    try {
      const result = await exportDiagramImage(doc, viewport, format);
      if (result.warning || !result.dataUrl) {
        setWarning(result.warning ?? 'Export failed');
        return;
      }
      setPreview({
        dataUrl: result.dataUrl,
        filename: result.filename,
        format,
        width: result.width,
        height: result.height,
      });
    } finally {
      setIsExporting(false);
    }
  };

  const handleDownload = () => {
    if (!preview) return;
    const a = document.createElement('a');
    a.href = preview.dataUrl;
    a.download = preview.filename;
    a.click();
    setPreview(null);
  };

  return (
    <>
      {warning && (
        <span role="alert" data-testid="export-warning">
          {warning}
        </span>
      )}
      <button
        type="button"
        data-testid="export-png"
        disabled={isExporting}
        onClick={() => handleExport('png')}
      >
        {t('export.png')}
      </button>
      <button
        type="button"
        data-testid="export-jpeg"
        disabled={isExporting}
        onClick={() => handleExport('jpeg')}
      >
        {t('export.jpeg')}
      </button>

      {preview && (
        <ExportPreviewModal
          preview={preview}
          onDownload={handleDownload}
          onClose={() => setPreview(null)}
        />
      )}
    </>
  );
}
