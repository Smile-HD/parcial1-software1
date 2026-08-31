/**
 * Delta-preview modal (task 7.6, interpreter:R2).
 *
 * The pending delta returned by the interpreter is shown BEFORE it is
 * applied: Confirm releases it through the canonical delta path, Reject
 * discards it and leaves the model untouched. The summary lines are
 * rendered from the delta object itself (never from the raw utterance).
 */
import type { Delta } from '@app/core';

/** One human-readable line per delta kind/op. */
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
 * The modal unmounts while a confirm/reject request is in flight (the App
 * moves the interpreter to its `thinking` phase first), so the buttons need
 * no separate busy-disabled state.
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
