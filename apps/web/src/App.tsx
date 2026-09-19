/**
 * App — posee el Y.Doc canónico y el ciclo de vida de carga/guardado/colaboración.
 *
 * editor:R5 — el id del diagrama reside en el hash de la URL (`#/d/<uuid>`); la carga y
 * el guardado hacen un round-trip a través de la API y una sesión recargada es estructuralmente
 * equivalente a la guardada. Un fallo de carga renderiza un error explícito y
 * nunca un lienzo parcialmente cargado.
 *
 * tiempo real (unidad de trabajo 6b) — una vez cargado, el mismo Y.Doc se vincula al
 * servidor de colaboración (`WebsocketProvider`, sala = diagrams/<diagramId>, diseño D4).
 * El transporte no es una segunda fuente de verdad: la sala del servidor se inicializa
 * a partir del mismo blob persistido del que se hidrató el cliente, por lo que
 * los relojes coinciden y las fusiones en vivo convergen. Los guardados transportan el propio blob
 * del cliente (guardado preservando blob) y reintentan ante conflictos de versión generados por las
 * escrituras con debounce de colaboración.
 */
import { useEffect, useRef, useState } from 'react';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';

import { applyUpdateToYDoc, encodeYDoc, projectYDocToDiagram, type Diagram } from '@app/core';

import {
  DiagramApiError,
  confirmDelta,
  createDiagram,
  interpretCommand,
  loadDiagram,
  rejectDelta,
  saveDiagram,
  type DiagramResource,
  type InterpretResponse,
} from './api/diagramApi';
import { base64ToBytes, bytesToBase64 } from './api/base64';
import { transcribeAudio } from './api/voiceApi';
import { applyDeltaToYDoc } from './canvas/applyDeltaToYDoc';
import { createBrowserVoiceRecorder, type VoiceRecorder } from './voice/recorder';
import { DiagramCanvas } from './canvas/DiagramCanvas';
import { CanvasErrorBoundary } from './canvas/CanvasErrorBoundary';
import { DeltaPreviewModal } from './interpreter/DeltaPreviewModal';
import { PresenceBar } from './canvas/PresenceBar';
import { LanguageToggle, t, useT } from './i18n';
import { GenerateSpringButton } from './codegen/GenerateSpringButton';
import { ExportToolbarButtons } from './canvas/imageExport';
import { ImportXmiButton } from './xmi/ImportXmiButton';
import { ExportXmiButton } from './xmi/ExportXmiButton';
import { ImportPhotoButton } from './photo/ImportPhotoButton';
import './canvas/canvas.css';

const DIAGRAM_NAME = 'Untitled';
const COLLAB_URL: string = import.meta.env.VITE_COLLAB_URL ?? 'ws://localhost:1234';
/** Reintentos de guardado cuando el debounce de colaboración incrementó la versión durante el guardado (6b.2). */
const SAVE_MAX_ATTEMPTS = 3;

export interface AppProps {
  /** Y.Doc canónico inyectable (pruebas). Si se omite, se crea un doc nuevo. */
  doc?: Y.Doc;
  /**
   * URL base del servidor de colaboración. `null` deshabilita el proveedor (pruebas / offline).
   * Por defecto: VITE_COLLAB_URL, o ws://localhost:1234; deshabilitado bajo vitest.
   */
  collabUrl?: string | null;
  /** Grabador de voz inyectable (pruebas). Por defecto: MediaRecorder del navegador. */
  voiceRecorder?: VoiceRecorder;
}

/** Extrae el id del diagrama del hash de la URL (`#/d/<uuid>`) o null. */
export function diagramIdFromHash(hash: string): string | null {
  const match = /^#\/d\/(.+)$/.exec(hash);
  return match?.[1] ?? null;
}

/** Diagrama vacío utilizado cuando la aplicación crea una sesión totalmente nueva. */
export function createEmptyDiagram(id: string): Diagram {
  return { id, name: DIAGRAM_NAME, classes: [], associations: [], generalizations: [], realizations: [], dependencies: [], naryAssociations: [] };
}

/**
 * Hidrata un Y.Doc existente in situ a partir del blob almacenado autoritativo.
 * editor:R5 — el doc hidratado es estructuralmente equivalente al diagrama
 * guardado, Y sus relojes de Yjs coinciden con los del servidor para que las fusiones
 * en vivo converjan sin duplicar elementos de arreglos (6b.1).
 */
export function hydrateDiagramIntoDoc(doc: Y.Doc, yjsStateBase64: string): Y.Doc {
  return applyUpdateToYDoc(doc, base64ToBytes(yjsStateBase64));
}

/** Resultado de un intento de guardado desde el manejador de guardado de App. */
export type SaveOutcome =
  | { ok: true; version: number }
  | { ok: false; status: number; message: string; currentVersion?: number | undefined };

/**
 * Proyecta el Y.Doc y lo guarda a través de la API, transportando el propio blob
 * de Yjs del cliente. Ante un 409 (el debounce de colaboración incrementó la versión en medio
 * del guardado) el manejador vuelve a leer `currentVersion` de la respuesta y reintenta, según el
 * invariante de diseño. Se mantiene como función exportada para que sea testeable sin el DOM.
 */
export async function saveDiagramFromDoc(
  doc: Y.Doc,
  expectedVersion: number,
  maxAttempts: number = SAVE_MAX_ATTEMPTS,
): Promise<SaveOutcome> {
  let version = expectedVersion;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    // Reproyectar en cada intento: el doc puede haber cambiado entre reintentos.
    const diagram = projectYDocToDiagram(doc);
    const yjsState = bytesToBase64(encodeYDoc(doc));
    try {
      const resource = await saveDiagram(diagram.id, diagram.name, diagram, version, yjsState);
      return { ok: true, version: resource.version };
    } catch (error) {
      if (error instanceof DiagramApiError && error.status === 409 && error.currentVersion !== undefined) {
        version = error.currentVersion;
        continue;
      }
      if (error instanceof DiagramApiError) {
        return {
          ok: false,
          status: error.status,
          message: error.message,
          currentVersion: error.currentVersion,
        };
      }
      return { ok: false, status: 0, message: t('app.apiConnectFailed') };
    }
  }
  return {
    ok: false,
    status: 409,
    message: t('app.saveRetryExhausted'),
  };
}

type LoadStatus = 'loading' | 'ready' | 'error';
type SaveStatus = 'idle' | 'saving' | 'saved' | 'failed';
type InterpreterState =
  | { phase: 'idle' }
  | { phase: 'thinking' }
  | { phase: 'refused'; reason: string }
  | { phase: 'error'; message: string }
  | { phase: 'pending'; deltaId: string; delta: import('@app/core').Delta };

interface AwarenessUser {
  user?: { name?: string };
}

function resolveCollabUrl(collabUrl: AppProps['collabUrl']): string | null {
  if (collabUrl !== undefined) {
    return collabUrl;
  }
  // Los entornos de Vitest permanecen herméticos: sin proveedor a menos que una prueba lo solicite.
  if (import.meta.env.MODE === 'test') {
    return null;
  }
  return COLLAB_URL;
}

export function App({ doc: injectedDoc, collabUrl, voiceRecorder }: AppProps = {}) {
  const { t: tr } = useT();
  const docRef = useRef<Y.Doc | null>(null);
  if (docRef.current === null) {
    docRef.current = injectedDoc ?? new Y.Doc();
  }
  const doc = docRef.current;

  const [status, setStatus] = useState<LoadStatus>('loading');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [version, setVersion] = useState<number | null>(null);
  const [roomId, setRoomId] = useState<string | null>(null);
  const [peers, setPeers] = useState<readonly string[]>([]);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [commandDraft, setCommandDraft] = useState('');
  const [interpreter, setInterpreter] = useState<InterpreterState>({ phase: 'idle' });
  const [recording, setRecording] = useState(false);

  // Grabador de voz (PR 8). Creado de forma perezosa; null cuando el navegador no ofrece
  // MediaRecorder (pruebas / navegadores no compatibles) — el botón se oculta en ese caso.
  const recorderRef = useRef<VoiceRecorder | null>(null);
  if (recorderRef.current === null && voiceRecorder === undefined) {
    recorderRef.current = createBrowserVoiceRecorder();
  }
  const activeRecorder: VoiceRecorder | null = voiceRecorder ?? recorderRef.current;

  // StrictMode (dev) ejecuta los efectos dos veces por montaje — la guarda didInit mantiene
  // create/load idempotente para que una sesión nunca haga POST de dos diagramas.
  const didInit = useRef(false);
  const userName = useRef(`User-${Math.random().toString(16).slice(2, 6)}`);
  const providerRef = useRef<WebsocketProvider | null>(null);

  useEffect(() => {
    if (didInit.current) {
      return;
    }
    didInit.current = true;
    const hydrate = (resource: DiagramResource): void => {
      hydrateDiagramIntoDoc(doc, resource.yjsState);
      setVersion(resource.version);
      setRoomId(resource.id);
      setStatus('ready');
    };

    const fail = (error: unknown): void => {
      setErrorMessage(error instanceof DiagramApiError ? error.message : t('app.apiConnectFailed'));
      setStatus('error');
    };

    const existingId = diagramIdFromHash(window.location.hash);
    if (existingId !== null) {
      loadDiagram(existingId)
        .then(hydrate)
        .catch(fail);
      return;
    }

    // Primera visita: crear un diagrama persistido y registrar su id en la URL
    // para que una recarga posterior complete el ciclo a través de la API (editor:R5). No se envía
    // ningún blob del cliente — la API construye el autoritativo y nos hidratamos
    // a partir de su respuesta para que los relojes coincidan con el servidor desde la primera sincronización.
    const newId = crypto.randomUUID();
    createDiagram(DIAGRAM_NAME, createEmptyDiagram(newId))
      .then((resource) => {
        window.location.hash = `#/d/${resource.diagram.id}`;
        hydrate(resource);
      })
      .catch(fail);
  }, [doc]);

  // 6b.1 — vincular el Y.Doc cargado al servidor de colaboración (sala = diagrams/<id>).
  const resolvedCollabUrl = resolveCollabUrl(collabUrl);
  useEffect(() => {
    if (status !== 'ready' || roomId === null || resolvedCollabUrl === null) {
      return;
    }
    if (providerRef.current !== null) {
      return; // un proveedor por sesión
    }
    const provider = new WebsocketProvider(resolvedCollabUrl, `diagrams/${roomId}`, doc, {
      connect: true,
    });
    providerRef.current = provider;
    // setLocalStateField(fieldName, value) — el nombre del campo y el valor son
    // argumentos separados; pasar un objeto como nombre de campo produce silenciosamente
    // un estado de awareness vacío (descubierto mediante la prueba de integración 6b.3).
    provider.awareness.setLocalStateField('user', { name: userName.current });

    const syncPresence = (): void => {
      const states = provider.awareness.getStates();
      const names = [...states.values()]
        .map((state) => (state as AwarenessUser).user?.name)
        .filter((name): name is string => typeof name === 'string');
      setPeers(names);
    };
    provider.awareness.on('change', syncPresence);
    syncPresence();

    return () => {
      provider.awareness.off('change', syncPresence);
      provider.destroy();
      providerRef.current = null;
    };
  }, [status, roomId, doc, resolvedCollabUrl]);

  const [copied, setCopied] = useState(false);
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current) {
        clearTimeout(copyTimeoutRef.current);
      }
    };
  }, []);

  const handleShareUrl = async (): Promise<void> => {
    const url = window.location.href;
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
      } else {
        const textarea = document.createElement('textarea');
        textarea.value = url;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
      }
      setCopied(true);
      if (copyTimeoutRef.current) {
        clearTimeout(copyTimeoutRef.current);
      }
      copyTimeoutRef.current = setTimeout(() => {
        setCopied(false);
      }, 2500);
    } catch {
      // Ignorar fallo de portapapeles
    }
  };

  const handleSave = (): void => {
    if (version === null || status !== 'ready') {
      return;
    }
    setSaveStatus('saving');
    setSaveMessage(null);
    void saveDiagramFromDoc(doc, version).then((outcome) => {
      if (outcome.ok) {
        setVersion(outcome.version);
        setSaveStatus('saved');
        setSaveMessage(null);
        return;
      }
      setSaveStatus('failed');
      setSaveMessage(
        outcome.status === 409 && outcome.currentVersion !== undefined
          ? `${outcome.message} (current version: ${outcome.currentVersion})`
          : outcome.message,
      );
    });
  };

  // Intérprete (tarea 7.6) — entrada en lenguaje natural, salida de delta previsualizado.
  // Los rechazos/errores se renderizan explícitamente; solo Confirm muta el modelo y lo
  // hace a través de la MISMA ruta applyDeltaToYDoc que las ediciones del lienzo (interpreter:R2).
  // Los errores comunes también transportan mensajes intencionales (p. ej. la indicación de
  // fallback provista por el servidor al cliente de voz), por lo que se exponen tal cual.
  const apiFailureMessage = (error: unknown, fallback: string): string =>
    error instanceof Error ? error.message : fallback;

  const handleSubmitCommand = (): void => {
    if (version === null || status !== 'ready' || roomId === null || interpreter.phase === 'thinking') {
      return;
    }
    const text = commandDraft.trim();
    if (text.length === 0) {
      return;
    }
    setInterpreter({ phase: 'thinking' });
    void interpretCommand(roomId, text)
      .then((outcome: InterpretResponse) => {
        if (outcome.status === 'pending') {
          setCommandDraft('');
          setInterpreter({ phase: 'pending', deltaId: outcome.deltaId, delta: outcome.delta });
          return;
        }
        if (outcome.status === 'refused') {
          setInterpreter({ phase: 'refused', reason: outcome.reason });
          return;
        }
        setInterpreter({ phase: 'error', message: outcome.message });
      })
      .catch((error: unknown) => {
        setInterpreter({ phase: 'error', message: apiFailureMessage(error, t('interpreter.reachFailed')) });
      });
  };

  const handleConfirmDelta = (): void => {
    if (interpreter.phase !== 'pending') {
      return;
    }
    const { deltaId } = interpreter;
    setInterpreter({ phase: 'thinking' });
    void confirmDelta(deltaId)
      .then((result) => {
        const applied = applyDeltaToYDoc(doc, result.delta);
        if (!applied.ok) {
          setInterpreter({ phase: 'error', message: t('interpreter.applyFailed', { kind: applied.error.kind }) });
          return;
        }
        setInterpreter({ phase: 'idle' });
      })
      .catch((error: unknown) => {
        setInterpreter({ phase: 'error', message: apiFailureMessage(error, t('interpreter.confirmFailed')) });
      });
  };

  const handleRejectDelta = (): void => {
    if (interpreter.phase !== 'pending') {
      return;
    }
    const { deltaId } = interpreter;
    setInterpreter({ phase: 'thinking' });
    void rejectDelta(deltaId)
      .then(() => {
        setInterpreter({ phase: 'idle' });
      })
      .catch((error: unknown) => {
        // Ya consumido en el servidor es equivalente a descartado para el cliente.
        setInterpreter({ phase: 'idle' });
        setSaveMessage(apiFailureMessage(error, t('interpreter.discardFailed')));
      });
  };

  // Entrada de voz (PR 8, tareas 8.3/8.4). La transcripción cae en el MISMO
  // input de comando (visible + editable — voice:R3): el usuario puede corregir un
  // nombre mal interpretado y presionar Enviar, reingresando al pipeline de texto idéntico
  // (voice:R2 — sin ruta privilegiada).
  const handleToggleRecord = (): void => {
    if (activeRecorder === null || status !== 'ready' || interpreter.phase === 'thinking') {
      return;
    }
    if (!recording) {
      setRecording(true);
      void activeRecorder
        .startRecording()
        .catch((error: unknown) => {
          setRecording(false);
          setInterpreter({ phase: 'error', message: apiFailureMessage(error, t('voice.micUnavailable')) });
        });
      return;
    }
    setRecording(false);
    void activeRecorder.stopRecording().then(
      ({ audio, mimeType }) => {
        if (version === null || roomId === null) {
          return;
        }
        setInterpreter({ phase: 'thinking' });
        void transcribeAudio(roomId, audio, mimeType)
          .then((response) => {
            setCommandDraft(response.transcript);
            if (response.status === 'pending') {
              setInterpreter({ phase: 'pending', deltaId: response.deltaId, delta: response.delta });
              return;
            }
            if (response.status === 'refused') {
              setInterpreter({ phase: 'refused', reason: response.reason });
              return;
            }
            setInterpreter({ phase: 'error', message: response.message });
          })
          .catch((error: unknown) => {
            setInterpreter({ phase: 'error', message: apiFailureMessage(error, t('voice.sttFailed')) });
          });
      },
      (error: unknown) => {
        setInterpreter({ phase: 'error', message: apiFailureMessage(error, t('voice.recordingFailed')) });
      },
    );
  };

  return (
    <main className="app-shell">
      {/* unidad 13e.8 — nombre de producto SIN "AI", idéntico en ambos idiomas. */}
      <h1 className="app-shell__title">{tr('app.title')}</h1>
      {status === 'loading' && <p>{tr('app.loading')}</p>}
      {status === 'error' && (
        <div role="alert">
          <p>{errorMessage ?? tr('app.loadError')}</p>
        </div>
      )}
      {status === 'ready' && (
        <>
          <div className="app-toolbar">
            <button
              type="button"
              onClick={handleShareUrl}
              data-testid="toolbar-share"
              className={copied ? 'toolbar-btn--copied' : ''}
              title={tr('toolbar.shareTitle')}
              aria-label={tr('toolbar.shareTitle')}
            >
              {copied ? `✓ ${tr('toolbar.copied')}` : tr('toolbar.share')}
            </button>
            {/* PR 14a/14d: iniciar la generación de código Spring Boot mediante la API de trabajos. */}
            <GenerateSpringButton diagramId={roomId} disabled={status !== 'ready'} />
            {/* PR 15: importar un archivo XMI 2.1 de Enterprise Architect. */}
            <ImportXmiButton doc={doc} diagramId={roomId} disabled={status !== 'ready'} />
            {/* PR 15b: exportar el diagrama como archivo XMI 2.1. */}
            <ExportXmiButton diagramId={roomId} disabled={status !== 'ready'} doc={doc} />
            {/* unidad 16b: exportación PNG/JPEG del lado del cliente — solo lectura, cero llamadas a la API. */}
            <ExportToolbarButtons doc={doc} />
            {/* PR 16c: importación de foto a UML. */}
            <ImportPhotoButton doc={doc} diagramId={roomId} disabled={status !== 'ready'} />
            <PresenceBar names={peers} />
            {/* unidad 13e.9 — el control segmentado EN/ES reside en la barra de herramientas. */}
            <LanguageToggle />
          </div>
          <div className="interpreter-bar">
            <input
              aria-label={tr('interpreter.ariaLabel')}
              value={commandDraft}
              onChange={(event) => setCommandDraft(event.target.value)}
              placeholder={tr('interpreter.placeholder')}
              disabled={interpreter.phase === 'thinking'}
            />
            <button type="button" onClick={handleSubmitCommand} disabled={interpreter.phase === 'thinking'}>
              {tr('interpreter.send')}
            </button>
            {activeRecorder !== null && (
              <button
                type="button"
                onClick={handleToggleRecord}
                disabled={interpreter.phase === 'thinking'}
                aria-label={recording ? tr('interpreter.stopAria') : tr('interpreter.recordAria')}
              >
                {recording ? tr('interpreter.stop') : tr('interpreter.record')}
              </button>
            )}
            {interpreter.phase === 'thinking' && <span aria-live="polite">{tr('interpreter.thinking')}</span>}
            {interpreter.phase === 'refused' && (
              <span role="alert" className="interpreter-refusal">
                {tr('interpreter.refused', { reason: interpreter.reason })}
              </span>
            )}
            {interpreter.phase === 'error' && (
              <span role="alert" className="interpreter-error">
                {interpreter.message}
              </span>
            )}
          </div>
          {interpreter.phase === 'pending' && (
            <DeltaPreviewModal
              delta={interpreter.delta}
              onConfirm={handleConfirmDelta}
              onReject={handleRejectDelta}
            />
          )}
          <div className="app-canvas">
            <CanvasErrorBoundary>
              <DiagramCanvas doc={doc} />
            </CanvasErrorBoundary>
          </div>
        </>
      )}
    </main>
  );
}
