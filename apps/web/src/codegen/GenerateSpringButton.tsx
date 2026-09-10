/**
 * GenerateSpringButton — toolbar control that drives the PR 14a/14d job API.
 *
 * Click flow:
 *   1. POST /diagrams/:id/generate -> jobId
 *   2. Poll GET /jobs/:id every 1s until status is 'succeeded' or 'failed'
 *   3. On success: download the zip via GET /jobs/:id/artifact and trigger
 *      a browser download.
 *
 * The button is disabled while a job is in flight, surfaces the current
 * status as a label, and shows any error message returned by the API.
 *
 * It deliberately does NOT mutate the diagram — codegen is a read-only
 * consumer of the canonical model.
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
  /** Diagram id from the URL hash. Null while loading. */
  diagramId: string | null;
  /** Disabled when the editor is not ready or the diagram isn't saved yet. */
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
  // Guard against state updates after unmount and overlapping polls.
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

  // When the job succeeds, kick off the download. Effect, not in the click
  // handler, so the user sees the success state before the dialog opens.
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
