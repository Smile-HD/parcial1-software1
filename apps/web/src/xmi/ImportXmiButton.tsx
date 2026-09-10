/**
 * ImportXmiButton — toolbar control that drives the PR 15 XMI import.
 *
 * Click flow:
 *   1. Open a file picker restricted to .xmi
 *   2. Read the file as text
 *   3. POST to /diagrams/:id/import/xmi (api returns parsed deltas + summary)
 *   4. Apply every delta to the local Y.Doc in order via applyDeltaToYDoc
 *   5. Show a short success/failure status (the canvas re-renders from the
 *      Y.Doc observers — editor:R1)
 *
 * The button does NOT call /save: imported deltas live only in the local
 * doc until the user presses Save. That matches the editor:R1 invariant
 * (canvas re-renders from the model, never from adapter-local state) and
 * keeps the user in control of when the import becomes persistent.
 */
import { useCallback, useRef, useState } from 'react';

import { DiagramApiError } from '../api/diagramApi';
import { importXmi, type XmiImportSummary } from '../api/xmiApi';
import { applyDeltaToYDoc } from '../canvas/applyDeltaToYDoc';
import { useT } from '../i18n';

export interface ImportXmiButtonProps {
  /** The Y.Doc the app owns (passed down from App). */
  doc: import('yjs').Doc;
  /** Diagram id from the URL hash. Null while loading. */
  diagramId: string | null;
  /** Disabled when the editor is not ready. */
  disabled?: boolean;
}

type LocalState =
  | { phase: 'idle' }
  | { phase: 'reading' }
  | { phase: 'importing' }
  | { phase: 'succeeded'; summary: XmiImportSummary }
  | { phase: 'failed'; message: string };

export function ImportXmiButton({ doc, diagramId, disabled = false }: ImportXmiButtonProps): JSX.Element {
  const { t: tr } = useT();
  const [state, setState] = useState<LocalState>({ phase: 'idle' });
  const inputRef = useRef<HTMLInputElement | null>(null);

  const handlePick = useCallback((): void => {
    inputRef.current?.click();
  }, []);

  const handleFile = useCallback(
    async (file: File): Promise<void> => {
      if (diagramId === null) {
        return;
      }
      setState({ phase: 'reading' });
      let xmiText: string;
      try {
        xmiText = await file.text();
      } catch (error) {
        const message = error instanceof Error ? error.message : tr('xmi.readFailed');
        setState({ phase: 'failed', message });
        return;
      }
      setState({ phase: 'importing' });
      let result: Awaited<ReturnType<typeof importXmi>>;
      try {
        result = await importXmi(diagramId, xmiText);
      } catch (error) {
        const message =
          error instanceof DiagramApiError ? error.message : tr('xmi.requestFailed');
        setState({ phase: 'failed', message });
        return;
      }
      // Apply every delta in order. If any fails we stop and surface the
      // partial result so the user knows what was applied.
      let appliedCount = 0;
      for (const delta of result.deltas) {
        const applied = applyDeltaToYDoc(doc, delta);
        if (!applied.ok) {
          setState({
            phase: 'failed',
            message: tr('xmi.applyFailed', { applied: String(appliedCount), kind: applied.error.kind }),
          });
          return;
        }
        appliedCount += 1;
      }
      setState({ phase: 'succeeded', summary: result.summary });
    },
    [diagramId, doc, tr],
  );

  const isBusy = state.phase === 'reading' || state.phase === 'importing';
  const buttonLabel =
    state.phase === 'reading'
      ? tr('xmi.reading')
      : state.phase === 'importing'
      ? tr('xmi.importing')
      : state.phase === 'succeeded'
      ? tr('xmi.succeeded')
      : tr('xmi.button');

  return (
    <span className="xmi-import-control">
      <button
        type="button"
        onClick={handlePick}
        disabled={disabled || diagramId === null || isBusy}
        aria-label={tr('xmi.ariaLabel')}
      >
        {buttonLabel}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept=".xmi,application/xml,text/xml"
        style={{ display: 'none' }}
        onChange={(event) => {
          const file = event.target.files?.[0];
          // Reset the input so picking the same file twice still fires change.
          event.target.value = '';
          if (file) {
            void handleFile(file);
          }
        }}
      />
      {state.phase === 'failed' && (
        <span role="alert" className="xmi-error">
          {state.message}
        </span>
      )}
    </span>
  );
}
