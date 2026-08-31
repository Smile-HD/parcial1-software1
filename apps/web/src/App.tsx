/**
 * App — owns the canonical Y.Doc and the load/save lifecycle (editor:R5).
 *
 * The diagram id lives in the URL hash (`#/d/<uuid>`) so that a reload in a
 * new session round-trips through the API and must reproduce the saved model.
 * Load failure renders an explicit error and never a partially loaded canvas.
 */
import { useEffect, useRef, useState } from 'react';
import * as Y from 'yjs';

import {
  applyUpdateToYDoc,
  buildYDocFromDiagram,
  encodeYDoc,
  projectYDocToDiagram,
  type Diagram,
} from '@app/core';

import { DiagramApiError, createDiagram, loadDiagram, saveDiagram } from './api/diagramApi';
import { DiagramCanvas } from './canvas/DiagramCanvas';

const DIAGRAM_NAME = 'Untitled';

export interface AppProps {
  /**
   * Injectable canonical Y.Doc (tests). When omitted a fresh doc is created.
   */
  doc?: Y.Doc;
}

/** Extracts the diagram id from the URL hash (`#/d/<uuid>`) or null. */
export function diagramIdFromHash(hash: string): string | null {
  const match = /^#\/d\/(.+)$/.exec(hash);
  return match?.[1] ?? null;
}

/** Empty diagram used when the app creates a brand-new session. */
export function createEmptyDiagram(id: string): Diagram {
  return { id, name: DIAGRAM_NAME, classes: [], associations: [] };
}

/**
 * Hydrates an existing Y.Doc in place from a saved JSON IR diagram.
 * editor:R5 — the hydrated doc must be structurally equivalent to the
 * saved diagram (round-trip is lossless, positions included).
 */
export function hydrateDiagramIntoDoc(doc: Y.Doc, diagram: Diagram): Y.Doc {
  return applyUpdateToYDoc(doc, encodeYDoc(buildYDocFromDiagram(diagram)));
}

/** Result of a save attempt from the App save handler. */
export type SaveOutcome =
  | { ok: true; version: number }
  | { ok: false; status: number; message: string; currentVersion?: number | undefined };

/**
 * Projects the Y.Doc and saves it through the API. Kept as an exported
 * function so the round-trip is testable independently of the DOM.
 */
export async function saveDiagramFromDoc(doc: Y.Doc, expectedVersion: number): Promise<SaveOutcome> {
  const diagram = projectYDocToDiagram(doc);
  try {
    const resource = await saveDiagram(diagram.id, diagram.name, diagram, expectedVersion);
    return { ok: true, version: resource.version };
  } catch (error) {
    if (error instanceof DiagramApiError) {
      return {
        ok: false,
        status: error.status,
        message: error.message,
        currentVersion: error.currentVersion,
      };
    }
    return { ok: false, status: 0, message: 'Failed to connect to the API' };
  }
}

type LoadStatus = 'loading' | 'ready' | 'error';
type SaveStatus = 'idle' | 'saving' | 'saved' | 'failed';

export function App({ doc: injectedDoc }: AppProps = {}) {
  const docRef = useRef<Y.Doc | null>(null);
  if (docRef.current === null) {
    docRef.current = injectedDoc ?? new Y.Doc();
  }
  const doc = docRef.current;

  const [status, setStatus] = useState<LoadStatus>('loading');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [version, setVersion] = useState<number | null>(null);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  const [saveMessage, setSaveMessage] = useState<string | null>(null);

  // StrictMode (dev) runs effects twice per mount — the didInit guard keeps
  // create/load idempotent so a session never POSTs two diagrams.
  const didInit = useRef(false);

  useEffect(() => {
    if (didInit.current) {
      return;
    }
    didInit.current = true;

    const hydrate = (diagram: Diagram, loadedVersion: number): void => {
      hydrateDiagramIntoDoc(doc, diagram);
      setVersion(loadedVersion);
      setStatus('ready');
    };

    const fail = (error: unknown): void => {
      setErrorMessage(error instanceof DiagramApiError ? error.message : 'Failed to connect to the API');
      setStatus('error');
    };

    const existingId = diagramIdFromHash(window.location.hash);
    if (existingId !== null) {
      loadDiagram(existingId)
        .then((resource) => hydrate(resource.diagram, resource.version))
        .catch(fail);
      return;
    }

    // First visit: create a persisted diagram and record its id in the URL
    // so a later reload round-trips through the API (editor:R5).
    const newId = crypto.randomUUID();
    createDiagram(DIAGRAM_NAME, createEmptyDiagram(newId))
      .then((resource) => {
        window.location.hash = `#/d/${resource.diagram.id}`;
        hydrate(resource.diagram, resource.version);
      })
      .catch(fail);
  }, [doc]);

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

  return (
    <main style={{ display: 'flex', flexDirection: 'column', height: '100vh', margin: 0 }}>
      <h1>AI UML Design Tool</h1>
      {status === 'loading' && <p>Loading…</p>}
      {status === 'error' && (
        <div role="alert">
          <p>{errorMessage ?? 'Failed to load the diagram'}</p>
        </div>
      )}
      {status === 'ready' && (
        <>
          <div className="app-toolbar" style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            <button type="button" onClick={handleSave}>
              Save
            </button>
            <span aria-live="polite">
              {saveStatus === 'saving' ? 'Saving…' : saveStatus === 'saved' ? 'Saved' : saveMessage ?? ''}
            </span>
          </div>
          <div style={{ flex: 1, minHeight: 0 }}>
            <DiagramCanvas doc={doc} />
          </div>
        </>
      )}
    </main>
  );
}
