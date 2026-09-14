/**
 * GenerateSpringButton — control de la barra de herramientas que interactúa con la API de trabajos PR 14a/14d.
 *
 * Flujo de clic:
 *   1. POST /diagrams/:id/generate -> jobId
 *   2. Consulta periódica GET /jobs/:id cada 1s hasta que el estado sea 'succeeded' o 'failed'
 *   3. En caso de éxito: descarga el zip mediante GET /jobs/:id/artifact y dispara
 *      la descarga en el navegador.
 *
 * El botón se deshabilita mientras un trabajo está en curso, muestra el estado
 * actual como etiqueta y refleja cualquier mensaje de error retornado por la API.
 *
 * Deliberadamente NO muta el diagrama — codegen es un consumidor de
 * solo lectura del modelo canónico.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { useT } from '../i18n';
import {
  DiagramApiError,
} from '../api/diagramApi';
import {
  downloadArtifact,
  getJob,
  startGeneration,
  triggerBrowserDownload,
  type JobInfo,
} from '../api/codegenApi';

export interface GenerateSpringButtonProps {
  /** Id del diagrama desde el hash de la URL. Null mientras se carga. */
  diagramId: string | null;
  /** Deshabilitado cuando el editor no está listo o el diagrama aún no se guardó. */
  disabled?: boolean;
}

type LocalState =
  | { phase: 'idle' }
  | { phase: 'queued'; jobId: string }
  | { phase: 'running'; jobId: string }
  | { phase: 'succeeded'; jobId: string }
  | { phase: 'failed'; message: string };

const POLL_INTERVAL_MS = 1000;

export function GenerateSpringButton({ diagramId, disabled = false }: GenerateSpringButtonProps): JSX.Element {
  const { t: tr } = useT();
  const [state, setState] = useState<LocalState>({ phase: 'idle' });
  // Protección contra actualizaciones de estado tras el desmontaje y sondeos superpuestos.
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

  const pollUntilDone = useCallback(async (jobId: string): Promise<void> => {
    const tick = async (): Promise<void> => {
      if (!mountedRef.current) {
        return;
      }
      let info: JobInfo;
      try {
        info = await getJob(jobId);
      } catch (error) {
        const message =
          error instanceof DiagramApiError ? error.message : tr('codegen.pollFailed');
        if (mountedRef.current) {
          setState({ phase: 'failed', message });
        }
        return;
      }
      if (!mountedRef.current) {
        return;
      }
      if (info.status === 'succeeded') {
        setState({ phase: 'succeeded', jobId });
        return;
      }
      if (info.status === 'failed') {
        setState({ phase: 'failed', message: info.error ?? tr('codegen.unknownError') });
        return;
      }
      if (info.status === 'running') {
        setState({ phase: 'running', jobId });
      } else {
        setState({ phase: 'queued', jobId });
      }
      pollTimerRef.current = setTimeout(() => {
        void tick();
      }, POLL_INTERVAL_MS);
    };
    await tick();
  }, [tr]);

  const handleClick = useCallback(async (): Promise<void> => {
    if (diagramId === null) {
      return;
    }
    setState({ phase: 'queued', jobId: '' });
    let jobId: string;
    try {
      jobId = await startGeneration(diagramId);
    } catch (error) {
      const message =
        error instanceof DiagramApiError ? error.message : tr('codegen.startFailed');
      if (mountedRef.current) {
        setState({ phase: 'failed', message });
      }
      return;
    }
    if (!mountedRef.current) {
      return;
    }
    setState({ phase: 'queued', jobId });
    await pollUntilDone(jobId);
  }, [diagramId, pollUntilDone, tr]);

  // Cuando el trabajo tiene éxito, iniciar la descarga. En un Effect, no en el
  // manejador de clic, para que el usuario vea el estado de éxito antes de que se abra el diálogo.
  useEffect(() => {
    if (state.phase !== 'succeeded' || diagramId === null) {
      return;
    }
    let cancelled = false;
    downloadArtifact(state.jobId, diagramId)
      .then(({ blob, filename }) => {
        if (cancelled) {
          return;
        }
        triggerBrowserDownload(blob, filename);
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return;
        }
        const message =
          error instanceof DiagramApiError ? error.message : tr('codegen.downloadFailed');
        setState({ phase: 'failed', message });
      });
    return () => {
      cancelled = true;
    };
  }, [state, diagramId, tr]);

  const isBusy = state.phase === 'queued' || state.phase === 'running';
  const buttonLabel =
    state.phase === 'queued'
      ? tr('codegen.queued')
      : state.phase === 'running'
      ? tr('codegen.running')
      : state.phase === 'succeeded'
      ? tr('codegen.succeeded')
      : tr('codegen.button');

  return (
    <span className="codegen-control">
      <button
        type="button"
        onClick={() => {
          void handleClick();
        }}
        disabled={disabled || diagramId === null || isBusy}
        aria-label={tr('codegen.ariaLabel')}
      >
        {buttonLabel}
      </button>
      {state.phase === 'failed' && (
        <span role="alert" className="codegen-error">
          {state.message}
        </span>
      )}
    </span>
  );
}
