/**
 * PhotoReviewModal — revisa las clases extraídas de una importación de fotos antes
 * de aplicarlas al Y.Doc (photo:R2: revisión humana obligatoria).
 *
 * Cada clase puede ser renombrada o descartada. La acción de aprobación aplica el
 * BatchDelta filtrado; cancelar descarta todo. Las extracciones con cero elementos
 * muestran una advertencia y deshabilitan la aprobación (photo:R3).
 */
import type { Delta } from '@app/core';

export interface ReviewableClass {
  /** Id de clase estable del delta de extracción. */
  classId: string;
  /** Nombre para mostrar editable (puede ser corregido por el usuario). */
  name: string;
  /** El delta completo de creación de clase (transporta posición, etc.). */
  delta: Delta;
  /** Indica si esta clase fue descartada por el usuario. */
  dropped: boolean;
}

export interface PhotoReviewModalProps {
  /** Todas las clases extraídas del lote. */
  classes: ReviewableClass[];
  /** Advertencias de la extracción (p. ej. cero elementos). */
  warnings: string[];
  /** Callback con el lote filtrado (elementos descartados eliminados). */
  onApprove: () => void;
  /** Callback para descartar todo. */
  onCancel: () => void;
  /** Callback para actualizar un nombre de clase in situ. */
  onRename: (classId: string, newName: string) => void;
  /** Callback para alternar el estado descartado de una clase. */
  onDrop: (classId: string) => void;
}

export function PhotoReviewModal({
  classes,
  warnings,
  onApprove,
  onCancel,
  onRename,
  onDrop,
}: PhotoReviewModalProps) {
  const visible = classes.filter((c) => !c.dropped);
  const hasElements = visible.length > 0;

  return (
    <div className="photo-review" role="dialog" aria-label="Photo review">
      <h2>Review extracted classes</h2>
      {warnings.length > 0 && (
        <div role="alert" className="photo-review__warnings">
          {warnings.map((w, i) => (
            <p key={i}>{w}</p>
          ))}
        </div>
      )}
      <ul className="photo-review__list">
        {classes.map((cls) =>
          cls.dropped ? null : (
            <li key={cls.classId} className="photo-review__item">
              <span className="photo-review__class-name">{cls.name}</span>
              <input
                type="text"
                value={cls.name}
                onChange={(e) => onRename(cls.classId, e.target.value)}
                aria-label={`Rename ${cls.name}`}
              />
              <button
                type="button"
                onClick={() => onDrop(cls.classId)}
                aria-label={`Drop ${cls.name}`}
              >
                Drop
              </button>
            </li>
          ),
        )}
      </ul>
      <div className="photo-review__actions">
        <button
          type="button"
          onClick={onCancel}
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => onApprove(/* filteredBatch — construido por el padre */)}
          disabled={!hasElements}
          aria-label="Approve"
        >
          Approve
        </button>
      </div>
    </div>
  );
}
