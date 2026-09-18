/**
 * ImportPhotoButton — control de la barra de herramientas para importación de fotos (PR 16, tarea 16.3-WEB).
 *
 * Flujo de clic:
 *   1. Abre un selector de archivos restringido a imágenes
 *   2. Validación del lado del cliente (photo:R4) — cero llamadas a la API ante entradas inválidas
 *   3. Lee el archivo como base64 → POST /diagrams/:id/photo → 202 { jobId }
 *   4. Consulta periódica GET /diagrams/:id/photo/:jobId cada 1s hasta succeeded/failed
 *   5. En caso de éxito: renderiza PhotoReviewModal (photo:R2) con las clases extraídas
 *   6. El usuario edita/descarta elementos → aprobar aplica el BatchDelta filtrado
 *      al Y.Doc mediante applyDeltaToYDoc
 *   7. Cancelar descarta — Y.Doc sin cambios
 *
 * Refleja el patrón de sondeo de GenerateSpringButton y el patrón de aplicación
 * protegida de ImportXmiButton (lección del error de bloqueo en PR15).
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
  /** El Y.Doc que posee la aplicación (pasado desde App). */
  doc: import('yjs').Doc;
  /** Id del diagrama desde el hash de la URL. Null mientras se carga. */
  diagramId: string | null;
  /** Deshabilitado cuando el editor no está listo o el diagrama aún no se guardó. */
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

  // Consultar hasta que el trabajo se complete o falle (refleja el patrón de GenerateSpringButton).
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
          // Procesar extracción — advertir ante cero elementos (photo:R3).
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
          const classes: ReviewableClass[] = classDeltas.map((d: Delta) => {
            const classId = (d as { classId: string }).classId;
            const attrCount = processed.batch.deltas.filter(
              (sub: Delta) =>
                sub.kind === 'member' &&
                sub.op === 'addAttribute' &&
                (sub as { classId?: string }).classId === classId,
            ).length;
            const methodCount = processed.batch.deltas.filter(
              (sub: Delta) =>
                sub.kind === 'member' &&
                sub.op === 'addMethod' &&
                (sub as { classId?: string }).classId === classId,
            ).length;

            return {
              classId,
              name: (d as { name: string }).name ?? '?',
              delta: d,
              dropped: false,
              details: { attributesCount: attrCount, methodsCount: methodCount },
            };
          });
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

        // Todavía en cola o ejecutándose — programar siguiente consulta.
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

      // Fase 1: Validación del lado del cliente (photo:R4) — cero llamadas a la API si es inválido.
      setState({ phase: 'validating' });
      const fileError = validatePhotoFile(file);
      if (fileError !== null) {
        setState({ phase: 'failed', message: fileError.message });
        return;
      }

      // Fase 2: Leer primeros bytes para validación de firmas mágicas.
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

      // Fase 3: Convertir a base64 y subir.
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

  // Limpiar temporizador de sondeo al desmontar.
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

    // Construir el lote filtrado: eliminar elementos descartados, aplicar ediciones de nombres.
    const visible = state.classes.filter((c) => !c.dropped);
    const visibleIds = new Set(visible.map((c) => c.classId));
    const nameMap = new Map(state.classes.map((c) => [c.classId, c.name]));

    const filteredDeltas = state.rawBatch.deltas
      .map((d) => {
        if (d.kind === 'class' && d.op === 'create') {
          const classId = (d as { classId: string }).classId;
          const editedName = nameMap.get(classId);
          if (editedName !== undefined && editedName !== (d as { name: string }).name) {
            return { ...d, name: editedName };
          }
        }
        return d;
      })
      .filter((d) => {
        if (d.kind === 'class' && d.op === 'create') {
          return visibleIds.has((d as { classId: string }).classId);
        }
        if (d.kind === 'member') {
          return visibleIds.has((d as { classId: string }).classId);
        }
        if (d.kind === 'association') {
          const assoc = d as { sourceClassId?: string; targetClassId?: string };
          return Boolean(
            assoc.sourceClassId &&
            assoc.targetClassId &&
            visibleIds.has(assoc.sourceClassId) &&
            visibleIds.has(assoc.targetClassId),
          );
        }
        if (d.kind === 'generalization') {
          const gen = d as { subClassId?: string; superClassId?: string };
          return Boolean(
            gen.subClassId &&
            gen.superClassId &&
            visibleIds.has(gen.subClassId) &&
            visibleIds.has(gen.superClassId),
          );
        }
        if (d.kind === 'realization') {
          const real = d as { clientClassId?: string; supplierInterfaceId?: string };
          return Boolean(
            real.clientClassId &&
            real.supplierInterfaceId &&
            visibleIds.has(real.clientClassId) &&
            visibleIds.has(real.supplierInterfaceId),
          );
        }
        if (d.kind === 'dependency') {
          const dep = d as { clientClassId?: string; supplierClassId?: string };
          return Boolean(
            dep.clientClassId &&
            dep.supplierClassId &&
            visibleIds.has(dep.clientClassId) &&
            visibleIds.has(dep.supplierClassId),
          );
        }
        if (d.kind === 'naryAssociation') {
          const nary = d as { memberEnds?: { classId: string }[] };
          if (!Array.isArray(nary.memberEnds)) return false;
          const survivingEnds = nary.memberEnds.filter((e) => visibleIds.has(e.classId));
          return survivingEnds.length >= 3;
        }
        return true;
      });

    const filteredBatch: BatchDelta = {
      ...state.rawBatch,
      deltas: filteredDeltas as BatchDelta['deltas'],
    };

    // Validar con BatchDeltaSchema antes de aplicar (lección del error de bloqueo en PR15).
    let validated: BatchDelta;
    try {
      validated = BatchDeltaSchema.parse(filteredBatch);
    } catch {
      setState({ phase: 'failed', message: tr('photo.applySchemaError') });
      return;
    }

    setState({ phase: 'applying' });

    // Aplicar a través de la ruta canónica — protegido contra errores de esquema/aplicación.
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
