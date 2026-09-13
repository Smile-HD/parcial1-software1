/**
 * ImportPhotoButton — toolbar control for photo import (PR 16, task 16.3-WEB).
 *
 * Click flow:
 *   1. Open a file picker restricted to images
 *   2. Client-side validation (photo:R4) — zero API calls on invalid input
 *   3. Read file as base64 → POST /diagrams/:id/photo → 202 { jobId }
 *   4. Poll GET /diagrams/:id/photo/:jobId every 1s until succeeded/failed
 *   5. On success: render PhotoReviewModal (photo:R2) with extracted classes
 *   6. User edits/drops elements → approve applies the filtered BatchDelta
 *      to the Y.Doc via applyDeltaToYDoc
 *   7. Cancel discards — Y.Doc unchanged
 *
 * Mirrors the polling pattern from GenerateSpringButton and the guarded
 * apply pattern from ImportXmiButton (PR15 hang-bug lesson).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { BatchDeltaSchema, type BatchDelta, type Delta } from '@app/core';

import { DiagramApiError } from '../api/diagramApi';
import { applyDeltaToYDoc } from '../canvas/applyDeltaToYDoc';
import { useT } from '../i18n';
import {
  validatePhotoFile,
  validatePhotoBytes,
  processExtraction,
} from './photoValidation';
import { uploadPhoto, getPhotoJob } from './photoApi';
import { PhotoReviewModal, type ReviewableClass } from './PhotoReviewModal';

export interface ImportPhotoButtonProps {
  /** The Y.Doc the app owns (passed down from App). */
  doc: import('yjs').Doc;
  /** Diagram id from the URL hash. Null while loading. */
  diagramId: string | null;
  /** Disabled when the editor is not ready or the diagram isn't saved yet. */
  disabled?: boolean;
}

type LocalState =
  | { phase: 'idle' }
  | { phase: 'validating' }
  | { phase: 'uploading' }
  | { phase: 'polling'; jobId: string }
  | { phase: 'review'; classes: ReviewableClass[]; warnings: string[]; rawBatch: BatchDelta }
  | { phase: 'applying' }
  | { phase: 'succeeded' }
  | { phase: 'failed'; message: string };

const POLL_INTERVAL_MS = 1000;

export function ImportPhotoButton({
  doc,
  diagramId,
  disabled = false,
}: ImportPhotoButtonProps) {
  const { t: tr } = useT();
  const [state, setState] = useState<LocalState>({ phase: 'idle' });
  const inputRef = useRef<HTMLInputElement | null>(null);
  const mountedRef = useRef(true);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (pollTimerRef.current !== null) {
        clearTimeout(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, []);

  const handlePick = useCallback((): void => {
    inputRef.current?.click();
  }, []);

  // Poll until the job completes or fails (mirrors GenerateSpringButton pattern).
  const pollUntilDone = useCallback(
    async (currentDiagramId: string, jobId: string): Promise<void> => {
      const tick = async (): Promise<void> => {
        if (!mountedRef.current) return;
        let result: Awaited<ReturnType<typeof getPhotoJob>>;
        try {
          result = await getPhotoJob(currentDiagramId, jobId);
        } catch (error) {
          const message =
            error instanceof DiagramApiError ? error.message : tr('photo.pollFailed');
          if (mountedRef.current) {
            setState({ phase: 'failed', message });
          }
          return;
        }
        if (!mountedRef.current) return;

        if (result.status === 'succeeded') {
          if (!result.batch) {
            setState({ phase: 'failed', message: tr('photo.noBatch') });
            return;
          }
          // Process extraction — warn on zero elements (photo:R3).
          const processed = processExtraction(result.batch);
          if (!processed.ok) {
            const allWarnings = [...(result.warnings ?? []), ...processed.warnings];
            if (mountedRef.current) {
              setState({ phase: 'failed', message: allWarnings.join('; ') || tr('photo.noBatch') });
            }
            return;
          }
          const classDeltas = processed.batch.deltas.filter(
            (d: Delta) => d.kind === 'class' && d.op === 'create',
          );
          const classes: ReviewableClass[] = classDeltas.map((d: Delta) => ({
            classId: (d as { classId: string }).classId,
            name: (d as { name: string }).name ?? '?',
            delta: d,
            dropped: false,
          }));
          const allWarnings = [...(result.warnings ?? []), ...processed.warnings];
          if (mountedRef.current) {
            setState({ phase: 'review', classes, warnings: allWarnings, rawBatch: processed.batch });
          }
          return;
        }

        if (result.status === 'failed') {
          const message = result.error ?? tr('photo.extractionFailed');
          if (mountedRef.current) {
            setState({ phase: 'failed', message });
          }
          return;
        }

        // Still queued or running — schedule next poll.
        if (mountedRef.current) {
          setState({ phase: 'polling', jobId });
        }
        pollTimerRef.current = setTimeout(() => {
          void tick();
        }, POLL_INTERVAL_MS);
      };
      await tick();
    },
    [tr],
  );

  const handleFile = useCallback(
    async (file: File): Promise<void> => {
      if (diagramId === null) return;

      // Phase 1: Client-side validation (photo:R4) — zero API calls on invalid.
      setState({ phase: 'validating' });
      const fileError = validatePhotoFile(file);
      if (fileError !== null) {
        setState({ phase: 'failed', message: fileError.message });
        return;
      }

      // Phase 2: Read first bytes for magic-byte validation.
      let firstBytes: Uint8Array;
      try {
        const ab = await file.slice(0, 8).arrayBuffer();
        firstBytes = new Uint8Array(ab);
      } catch (error) {
        const message = error instanceof Error ? error.message : tr('photo.readFailed');
        setState({ phase: 'failed', message });
        return;
      }
      const byteError = validatePhotoBytes(firstBytes, file.type);
      if (byteError !== null) {
        setState({ phase: 'failed', message: byteError.message });
        return;
      }

      // Phase 3: Convert to base64 and upload.
      setState({ phase: 'uploading' });
      let base64: string;
      try {
        const ab = await file.arrayBuffer();
        const bytes = new Uint8Array(ab);
        base64 = btoa(String.fromCharCode(...bytes));
      } catch (error) {
        const message = error instanceof Error ? error.message : tr('photo.readFailed');
        setState({ phase: 'failed', message });
        return;
      }

      let jobId: string;
      try {
        jobId = await uploadPhoto(diagramId, base64, file.type);
      } catch (error) {
        const message =
          error instanceof DiagramApiError ? error.message : tr('photo.uploadFailed');
        if (mountedRef.current) {
          setState({ phase: 'failed', message });
        }
        return;
      }

      if (!mountedRef.current) return;
      setState({ phase: 'polling', jobId });
      await pollUntilDone(diagramId, jobId);
    },
    [diagramId, tr, pollUntilDone],
  );

  // Cleanup poll timer on unmount.
  useEffect(() => {
    return () => {
      if (pollTimerRef.current !== null) {
        clearTimeout(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, []);

  const handleRename = useCallback((classId: string, newName: string): void => {
    setState((prev) => {
      if (prev.phase !== 'review') return prev;
      return {
        ...prev,
        classes: prev.classes.map((c) =>
          c.classId === classId ? { ...c, name: newName } : c,
        ),
      };
    });
  }, []);

  const handleDrop = useCallback((classId: string): void => {
    setState((prev) => {
      if (prev.phase !== 'review') return prev;
      return {
        ...prev,
        classes: prev.classes.map((c) =>
          c.classId === classId ? { ...c, dropped: true } : c,
        ),
      };
    });
  }, []);

  const handleApprove = useCallback((): void => {
    if (state.phase !== 'review') return;

    // Build the filtered batch: remove dropped elements, apply name edits.
    const visible = state.classes.filter((c) => !c.dropped);
    const nameMap = new Map(state.classes.map((c) => [c.classId, c.name]));

    const filteredDeltas = state.rawBatch.deltas.map((d) => {
      if (d.kind === 'class' && d.op === 'create') {
        const classId = (d as { classId: string }).classId;
        const editedName = nameMap.get(classId);
        if (editedName !== undefined && editedName !== (d as { name: string }).name) {
          return { ...d, name: editedName };
        }
      }
      return d;
    }).filter((d) => {
      if (d.kind === 'class' && d.op === 'create') {
        return visible.some((c) => c.classId === (d as { classId: string }).classId);
      }
      // Keep non-class deltas (associations etc.) if both endpoints survived.
      return true;
    });

    const filteredBatch: BatchDelta = {
      ...state.rawBatch,
      deltas: filteredDeltas as BatchDelta['deltas'],
    };

    // Validate with BatchDeltaSchema before applying (PR15 hang-bug lesson).
    let validated: BatchDelta;
    try {
      validated = BatchDeltaSchema.parse(filteredBatch);
    } catch {
      setState({ phase: 'failed', message: tr('photo.applySchemaError') });
      return;
    }

    setState({ phase: 'applying' });

    // Apply through the canonical path — guarded against schema/apply errors.
    let applied: ReturnType<typeof applyDeltaToYDoc>;
    try {
      applied = applyDeltaToYDoc(doc, validated);
    } catch {
      setState({ phase: 'failed', message: tr('photo.applySchemaError') });
      return;
    }
    if (!applied.ok) {
      setState({
        phase: 'failed',
        message: tr('photo.applyFailed', { kind: applied.error.kind }),
      });
      return;
    }

    setState({ phase: 'succeeded' });
  }, [state, doc, tr]);

  const handleCancel = useCallback((): void => {
    setState({ phase: 'idle' });
  }, []);

  const isBusy =
    state.phase === 'validating' ||
    state.phase === 'uploading' ||
    state.phase === 'polling' ||
    state.phase === 'applying';

  const buttonLabel =
    state.phase === 'validating'
      ? tr('photo.validating')
      : state.phase === 'uploading'
      ? tr('photo.uploading')
      : state.phase === 'polling'
      ? tr('photo.extracting')
      : state.phase === 'applying'
      ? tr('photo.applying')
      : state.phase === 'succeeded'
      ? tr('photo.succeeded')
      : tr('photo.button');

  return (
    <span className="photo-import-control">
      <button
        type="button"
        onClick={handlePick}
        disabled={disabled || diagramId === null || isBusy}
        aria-label={tr('photo.ariaLabel')}
      >
        {buttonLabel}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        style={{ display: 'none' }}
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) {
            void handleFile(file);
          }
        }}
      />
      {state.phase === 'failed' && (
        <span role="alert" className="photo-error">
          {state.message}
        </span>
      )}
      {state.phase === 'review' && (
        <PhotoReviewModal
          classes={state.classes}
          warnings={state.warnings}
          onApprove={handleApprove}
          onCancel={handleCancel}
          onRename={handleRename}
          onDrop={handleDrop}
        />
      )}
    </span>
  );
}
