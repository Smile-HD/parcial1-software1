/**
 * App — owns the canonical Y.Doc and the load/save/collab lifecycle.
 *
 * editor:R5 — the diagram id lives in the URL hash (`#/d/<uuid>`); load and
 * save round-trip through the API and a reloaded session is structurally
 * equivalent to the saved one. Load failure renders an explicit error and
 * never a partially loaded canvas.
 *
 * realtime (work unit 6b) — once loaded, the same Y.Doc is bound to the
 * collab server (`WebsocketProvider`, room = diagrams/<diagramId>, design D4).
 * The transport is not a second source of truth: the server room is
 * bootstrapped from the same persisted blob the client hydrated from, so
 * clocks match and live merges converge. Saves carry the client's own blob
 * (blob-preserving save) and retry on version conflicts raised by the collab
 * debounce writes.
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
import { DeltaPreviewModal } from './interpreter/DeltaPreviewModal';
import { PresenceBar } from './canvas/PresenceBar';
import { LanguageToggle, t, useT } from './i18n';

const DIAGRAM_NAME = 'Untitled';
const COLLAB_URL: string = import.meta.env.VITE_COLLAB_URL ?? 'ws://localhost:1234';
/** Save retries when the collab debounce bumped the version mid-save (6b.2). */
const SAVE_MAX_ATTEMPTS = 3;

export interface AppProps {
  /** Injectable canonical Y.Doc (tests). When omitted a fresh doc is created. */
  doc?: Y.Doc;
  /**
   * Collab server base URL. `null` disables the provider (tests / offline).
   * Default: VITE_COLLAB_URL, or ws://localhost:1234; disabled under vitest.
   */
  collabUrl?: string | null;
  /** Injectable voice recorder (tests). Default: browser MediaRecorder. */
  voiceRecorder?: VoiceRecorder;
}

/** Extracts the diagram id from the URL hash (`#/d/<uuid>`) or null. */
export function diagramIdFromHash(hash: string): string | null {
  const match = /^#\/d\/(.+)$/.exec(hash);
  return match?.[1] ?? null;
}

/** Empty diagram used when the app creates a brand-new session. */
export function createEmptyDiagram(id: string): Diagram {
  return { id, name: DIAGRAM_NAME, classes: [], associations: [], generalizations: [], realizations: [], dependencies: [], naryAssociations: [] };
}

/**
 * Hydrates an existing Y.Doc in place from the authoritative stored blob.
 * editor:R5 — the hydrated doc is structurally equivalent to the saved
 * diagram, AND its Yjs clocks match the server's so live collab merges
 * converge without duplicating array members (6b.1).
 */
export function hydrateDiagramIntoDoc(doc: Y.Doc, yjsStateBase64: string): Y.Doc {
  return applyUpdateToYDoc(doc, base64ToBytes(yjsStateBase64));
}

/** Result of a save attempt from the App save handler. */
export type SaveOutcome =
  | { ok: true; version: number }
  | { ok: false; status: number; message: string; currentVersion?: number | undefined };

/**
 * Projects the Y.Doc and saves it through the API, carrying the client's own
 * Yjs blob. On a 409 (the collab debounce bumped the version mid-save) the
 * handler re-reads `currentVersion` from the response and retries, per the
 * design invariant. Kept as an exported function so it is testable without
 * the DOM.
 */
export async function saveDiagramFromDoc(
  doc: Y.Doc,
  expectedVersion: number,
  maxAttempts: number = SAVE_MAX_ATTEMPTS,
): Promise<SaveOutcome> {
  let version = expectedVersion;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    // Re-project every attempt: the doc may have changed between retries.
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
  // Vitest environments stay hermetic: no provider unless a test opts in.
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

  // Voice recorder (PR 8). Created lazily; null when the browser offers no
  // MediaRecorder (tests / unsupported browsers) — the button hides then.
  const recorderRef = useRef<VoiceRecorder | null>(null);
  if (recorderRef.current === null && voiceRecorder === undefined) {
    recorderRef.current = createBrowserVoiceRecorder();
  }
  const activeRecorder: VoiceRecorder | null = voiceRecorder ?? recorderRef.current;

  // StrictMode (dev) runs effects twice per mount — the didInit guard keeps
  // create/load idempotent so a session never POSTs two diagrams.
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

    // First visit: create a persisted diagram and record its id in the URL
    // so a later reload round-trips through the API (editor:R5). No client
    // blob is sent — the API builds the authoritative one and we hydrate
    // from its response so clocks match the server from the first sync.
    const newId = crypto.randomUUID();
    createDiagram(DIAGRAM_NAME, createEmptyDiagram(newId))
      .then((resource) => {
        window.location.hash = `#/d/${resource.diagram.id}`;
        hydrate(resource);
      })
      .catch(fail);
  }, [doc]);

  // 6b.1 — bind the loaded Y.Doc to the collab server (room = diagrams/<id>).
  const resolvedCollabUrl = resolveCollabUrl(collabUrl);
  useEffect(() => {
    if (status !== 'ready' || roomId === null || resolvedCollabUrl === null) {
      return;
    }
    if (providerRef.current !== null) {
      return; // one provider per session
    }
    const provider = new WebsocketProvider(resolvedCollabUrl, `diagrams/${roomId}`, doc, {
      connect: true,
    });
    providerRef.current = provider;
    // setLocalStateField(fieldName, value) — the field name and value are
    // separate arguments; passing an object as the field name silently
    // produces an empty awareness state (found via the 6b.3 integration test).
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

  // Interpreter (task 7.6) — natural language in, previewed delta out.
  // Refusals/errors render explicitly; only Confirm mutates the model and it
  // goes through the SAME applyDeltaToYDoc path as canvas edits (interpreter:R2).
  // Plain Errors carry intentional messages too (e.g. the voice client's
  // server-provided fallback direction), so they surface as-is.
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
        // Already consumed server-side is as good as discarded for the client.
        setInterpreter({ phase: 'idle' });
        setSaveMessage(apiFailureMessage(error, t('interpreter.discardFailed')));
      });
  };

  // Voice input (PR 8, tasks 8.3/8.4). The transcript lands in the SAME
  // command input (visible + editable — voice:R3): the user can correct a
  // misheard name and hit Send, which re-enters the identical text pipeline
  // (voice:R2 — no privileged path).
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
      {/* unit 13e.8 — product name WITHOUT "AI", identical in both languages. */}
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
            <button type="button" onClick={handleSave}>
              {tr('toolbar.save')}
            </button>
            <span aria-live="polite">
              {saveStatus === 'saving' ? tr('toolbar.saving') : saveStatus === 'saved' ? tr('toolbar.saved') : saveMessage ?? ''}
            </span>
            <PresenceBar names={peers} />
            {/* unit 13e.9 — the EN/ES segmented control lives in the toolbar. */}
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
            <DiagramCanvas doc={doc} />
          </div>
        </>
      )}
    </main>
  );
}
