/**
 * ImportXmiButton — control de la barra de herramientas que gestiona la importación XMI de PR 15.
 *
 * Flujo de clic:
 *   1. Abre un selector de archivos restringido a .xmi
 *   2. Lee el archivo como texto
 *   3. POST a /diagrams/:id/import/xmi (la API retorna el delta de lote parseado + resumen)
 *   4. Aplica el delta de lote atómicamente al Y.Doc local mediante applyDeltaToYDoc
 *   5. Muestra un breve estado de éxito/fallo (el lienzo se vuelve a renderizar desde
 *      los observadores de Y.Doc — editor:R1)
 *
 * El botón NO llama a /save: los deltas importados residen únicamente en el doc local
 * hasta que el usuario presiona Guardar. Eso coincide con el invariante editor:R1
 * (el lienzo se vuelve a renderizar desde el modelo, nunca desde el estado local del adaptador) y
 * mantiene al usuario en control de cuándo la importación se vuelve persistente.
 */
import { useCallback, useRef, useState } from 'react';

import { DiagramApiError } from '../api/diagramApi';
import { importXmi, type XmiImportSummary } from '../api/xmiApi';
import { applyDeltaToYDoc } from '../canvas/applyDeltaToYDoc';
import { useT } from '../i18n';

export interface ImportXmiButtonProps {
  /** El Y.Doc que posee la aplicación (pasado desde App). */
  doc: import('yjs').Doc;
  /** Id del diagrama desde el hash de la URL. Null mientras se carga. */
  diagramId: string | null;
  /** Deshabilitado cuando el editor no está listo. */
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
      // Aplicar el delta de lote atómicamente (especificación 15.6: un lote de deltas atómico).
      // La barrera de esquema de core LANZA ante un lote mal formado (ZodError de
      // DeltaSchema.parse) en lugar de retornar un rechazo del motor, por lo que la
      // llamada debe estar protegida — de lo contrario, el rechazo escapa del manejador
      // asíncrono y el control queda bloqueado en 'importing' indefinidamente.
      let applied: ReturnType<typeof applyDeltaToYDoc>;
      try {
        applied = applyDeltaToYDoc(doc, result.batch);
      } catch {
        setState({
          phase: 'failed',
          message: tr('xmi.applyFailed', { applied: '0', kind: 'SchemaError' }),
        });
        return;
      }
      if (!applied.ok) {
        setState({
          phase: 'failed',
          message: tr('xmi.applyFailed', { applied: '0', kind: applied.error.kind }),
        });
        return;
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
          // Reiniciar el input para que seleccionar el mismo archivo dos veces continúe disparando el evento change.
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
