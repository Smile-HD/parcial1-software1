/**
 * ExportXmiButton — control de la barra de herramientas que gestiona la exportación XMI (PR 15b).
 *
 * Flujo de clic:
 *   1. Valida que exista un diagramId y que no haya una exportación en curso.
 *   2. Cambia el estado a 'exporting' y llama a GET /diagrams/:id/export/xmi.
 *   3. En caso de éxito, toma el Blob retornado y dispara la descarga en el navegador.
 *   4. Pasa a estado 'succeeded' y vuelve a 'idle' tras un breve retardo (2 segundos).
 *   5. En caso de error, muestra el mensaje con role="alert" accesible sin romper la interfaz.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { DiagramApiError } from '../api/diagramApi';
import { exportXmi } from '../api/xmiApi';
import { useT } from '../i18n';

export interface ExportXmiButtonProps {
  /** Id del diagrama desde la URL o el estado de la aplicación. Null mientras se carga. */
  diagramId: string | null;
  /** Deshabilitado cuando el editor no está listo o está bloqueado. */
  disabled?: boolean;
  /** Y.Doc opcional para consistencia de API. */
  doc?: import('yjs').Doc;
}

type LocalState =
  | { phase: 'idle' }
  | { phase: 'exporting' }
  | { phase: 'succeeded' }
  | { phase: 'failed'; message: string };

/**
 * Dispara la descarga del archivo en el navegador usando un elemento anchor temporal.
 */
function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export function ExportXmiButton({ diagramId, disabled = false }: ExportXmiButtonProps): JSX.Element {
  const { t: tr } = useT();
  const [state, setState] = useState<LocalState>({ phase: 'idle' });
  const mountedRef = useRef(true);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (resetTimerRef.current !== null) {
        clearTimeout(resetTimerRef.current);
      }
    };
  }, []);

  const handleExport = useCallback(async (): Promise<void> => {
    if (diagramId === null || state.phase === 'exporting') {
      return;
    }

    setState({ phase: 'exporting' });

    try {
      const blob = await exportXmi(diagramId);
      if (!mountedRef.current) return;

      const safeFilename = `${diagramId.replace(/[^a-zA-Z0-9_-]/g, '_')}.xmi`;
      triggerDownload(blob, safeFilename);

      setState({ phase: 'succeeded' });

      // Restablecer el estado a 'idle' después de 2 segundos
      resetTimerRef.current = setTimeout(() => {
        if (mountedRef.current) {
          setState({ phase: 'idle' });
        }
      }, 2000);
    } catch (error) {
      if (!mountedRef.current) return;
      const message =
        error instanceof DiagramApiError
          ? error.message
          : error instanceof Error
          ? error.message
          : tr('xmi.exportFailed');
      setState({ phase: 'failed', message });
    }
  }, [diagramId, state.phase, tr]);

  const isBusy = state.phase === 'exporting';
  const buttonLabel =
    state.phase === 'exporting'
      ? tr('xmi.exporting')
      : state.phase === 'succeeded'
      ? tr('xmi.exportSucceeded')
      : tr('xmi.exportButton');

  return (
    <span className="xmi-export-control">
      <button
        type="button"
        onClick={() => void handleExport()}
        disabled={disabled || diagramId === null || isBusy}
        aria-label={tr('xmi.exportAriaLabel')}
      >
        {buttonLabel}
      </button>
      {state.phase === 'failed' && (
        <span role="alert" className="xmi-error">
          {state.message}
        </span>
      )}
    </span>
  );
}
