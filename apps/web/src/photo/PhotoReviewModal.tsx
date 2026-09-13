/**
 * PhotoReviewModal — review extracted classes from a photo import before
 * applying them to the Y.Doc (photo:R2: mandatory human review).
 *
 * Each class can be renamed or dropped. The approve action applies the
 * filtered BatchDelta; cancel discards everything. Zero-element extractions
 * show a warning and disable approve (photo:R3).
 */
import type { Delta } from '@app/core';

export interface ReviewableClass {
  /** Stable class id from the extraction delta. */
  classId: string;
  /** Editable display name (may be corrected by the user). */
  name: string;
  /** The full class-create delta (carries position, etc.). */
  delta: Delta;
  /** Whether this class has been dropped by the user. */
  dropped: boolean;
}

export interface PhotoReviewModalProps {
  /** All extracted classes from the batch. */
  classes: ReviewableClass[];
  /** Warnings from the extraction (e.g. zero-element). */
  warnings: string[];
  /** Callback with the filtered batch (dropped elements removed). */
  onApprove: () => void;
  /** Callback to discard everything. */
  onCancel: () => void;
  /** Callback to update a class name in-place. */
  onRename: (classId: string, newName: string) => void;
  /** Callback to toggle the dropped state of a class. */
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
          onClick={() => onApprove(/* filteredBatch — built by parent */)}
          disabled={!hasElements}
          aria-label="Approve"
        >
          Approve
        </button>
      </div>
    </div>
  );
}
