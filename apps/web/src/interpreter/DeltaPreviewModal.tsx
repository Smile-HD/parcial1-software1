/**
 * Modal de vista previa de delta (tarea 7.6, interpreter:R2).
 *
 * El delta pendiente retornado por el intérprete se muestra ANTES de ser
 * aplicado: Confirm lo libera a través de la ruta canónica de deltas, Reject
 * lo descarta y deja el modelo sin cambios. Las líneas de resumen se
 * renderizan desde el propio objeto delta (nunca desde la locución original).
 */
import type { Delta } from '@app/core';

/** Una línea legible por humanos por cada kind/op de delta. */
export function describeDelta(delta: Delta): string {
  switch (delta.kind) {
    case 'class':
      switch (delta.op) {
        case 'create':
          return `Add class "${delta.name ?? '?'}"`;
        case 'rename':
          return `Rename class to "${delta.newName ?? '?'}"`;
        case 'reposition':
          return `Move class to (${delta.newPosition?.x ?? '?'}, ${delta.newPosition?.y ?? '?'})`;
        case 'delete':
          return 'Delete class';
      }
      break;
    case 'member':
      switch (delta.op) {
        case 'addAttribute':
          return `Add attribute "${delta.name ?? '?'}: ${delta.type ?? '?'}"`;
        case 'editAttribute':
          return `Edit attribute to "${delta.name ?? '?'}: ${delta.type ?? '?'}"`;
        case 'deleteAttribute':
          return 'Delete attribute';
        case 'addMethod':
          return `Add method "${delta.name ?? '?'}" returning "${delta.returnType ?? '?'}"`;
        case 'editMethod':
          return `Edit method to "${delta.name ?? '?'}" returning "${delta.returnType ?? '?'}"`;
        case 'deleteMethod':
          return 'Delete method';
      }
      break;
    case 'association':
      switch (delta.op) {
        case 'create':
          return 'Add association';
        case 'updateMultiplicity':
          return `Update multiplicities to "${delta.newSourceMultiplicity ?? '?'}" / "${delta.newTargetMultiplicity ?? '?'}"`;
        case 'delete':
          return 'Delete association';
      }
      break;
    case 'batch':
      return `Apply ${delta.deltas.length} changes: ${delta.deltas.map((inner) => describeDelta(inner)).join('; ')}`;
  }
}

export interface DeltaPreviewModalProps {
  delta: Delta;
  onConfirm: () => void;
  onReject: () => void;
}

/**
 * El modal se desmonta mientras una solicitud de confirmación/rechazo está en curso
 * (la aplicación traslada primero el intérprete a su fase `thinking`), por lo que los
 * botones no necesitan un estado deshabilitado por ocupado independiente.
 */
export function DeltaPreviewModal({ delta, onConfirm, onReject }: DeltaPreviewModalProps) {
  return (
    <div className="delta-preview" role="dialog" aria-label="AI change preview">
      <h2>AI proposes this change</h2>
      <p className="delta-preview__summary">{describeDelta(delta)}</p>
      <div className="delta-preview__actions">
        <button type="button" onClick={onConfirm}>
          Confirm
        </button>
        <button type="button" onClick={onReject}>
          Reject
        </button>
      </div>
    </div>
  );
}
