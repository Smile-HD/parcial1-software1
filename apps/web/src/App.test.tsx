import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

import { buildYDocFromDiagram, DiagramSchema, encodeYDoc, projectYDocToDiagram, type Delta, type Diagram } from '@app/core';

import {
  App,
  createEmptyDiagram,
  diagramIdFromHash,
  hydrateDiagramIntoDoc,
  saveDiagramFromDoc,
} from './App';
import { applyDeltaToYDoc } from './canvas/applyDeltaToYDoc';
import { PresenceBar } from './canvas/PresenceBar';
import { bytesToBase64, base64ToBytes } from './api/base64';

/**
 * editor:R5 — load/save wiring: a saved diagram reloaded in a new session is
 * structurally equivalent to the saved one (classes, members, associations,
 * multiplicities and positions included). Load failure shows an explicit
 * error and never a partially loaded canvas.
 *
 * 6b — the saved state is the CLIENT's Yjs blob (clock-preserving save), the
 * app retries saves on 409, and presence renders connected users.
 */
function makeFixture(): Diagram {
  const customerId = crypto.randomUUID();
  const orderId = crypto.randomUUID();
  return {
    id: '11111111-2222-4333-8444-555555555555',
    name: 'Shop',
    classes: [
      {
        id: customerId,
        name: 'Customer',
        position: { x: 10, y: 20 },
        attributes: [{ id: crypto.randomUUID(), name: 'name', type: 'string', visibility: '+', isStatic: false, isDerived: false }],
        methods: [{ id: crypto.randomUUID(), name: 'getName', returnType: 'string', parameters: [], visibility: '+', isStatic: false }],
      },
      {
        id: orderId,
        name: 'Order',
        position: { x: 300, y: 40 },
        attributes: [],
        methods: [],
      },
    ],
    associations: [
      {
        id: crypto.randomUUID(),
        sourceClassId: customerId,
        targetClassId: orderId,
        sourceMultiplicity: '1',
        targetMultiplicity: '0..*',
        directed: false,
      },
    ],
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function resourceOf(diagram: Diagram, version: number): Record<string, unknown> {
  // Mirror the real API: every resource carries the authoritative blob.
  return {
    id: diagram.id,
    name: diagram.name,
    diagram,
    yjsState: bytesToBase64(encodeYDoc(buildYDocFromDiagram(diagram))),
    version,
    createdAt: 't',
    updatedAt: 't',
  };
}

/** Hydrates a doc from a diagram by building its blob (fixture helper). */
function hydrateFromDiagram(doc: Y.Doc, diagram: Diagram): Y.Doc {
  return hydrateDiagramIntoDoc(doc, bytesToBase64(encodeYDoc(buildYDocFromDiagram(diagram))));
}

beforeEach(() => {
  window.location.hash = '';
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('App helpers', () => {
  it('parses the diagram id from the URL hash', () => {
    expect(diagramIdFromHash('#/d/abc-123')).toBe('abc-123');
    expect(diagramIdFromHash('#/other/xyz')).toBeNull();
    expect(diagramIdFromHash('')).toBeNull();
  });

  it('creates an empty diagram with the given id', () => {
    const id = crypto.randomUUID();
    expect(createEmptyDiagram(id)).toEqual({ id, name: 'Untitled', classes: [], associations: [], generalizations: [], realizations: [], dependencies: [] });
  });

  it('hydrates a Y.Doc from the stored blob so its projection is structurally equal to the saved diagram', () => {
    const diagram = makeFixture();
    const doc = new Y.Doc();

    hydrateDiagramIntoDoc(doc, bytesToBase64(encodeYDoc(buildYDocFromDiagram(diagram))));

    expect(projectYDocToDiagram(doc)).toEqual(DiagramSchema.parse(diagram));
  });
});

describe('App save handler (blob-preserving, 409-retry)', () => {
  it('saves the projected diagram WITH the client blob and returns the new version', async () => {
    const diagram = makeFixture();
    const doc = hydrateFromDiagram(new Y.Doc(), diagram);
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(resourceOf(diagram, 9)));
    vi.stubGlobal('fetch', fetchMock);

    const outcome = await saveDiagramFromDoc(doc, 8);

    expect(outcome).toEqual({ ok: true, version: 9 });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`http://localhost:3000/diagrams/${diagram.id}`);
    expect(init.method).toBe('PUT');
    const body = JSON.parse(String(init.body)) as { name: string; diagram: Diagram; version: number; yjsState: string };
    expect(body.name).toBe(diagram.name);
    expect(body.diagram).toEqual(DiagramSchema.parse(diagram));
    expect(body.version).toBe(8);
    // The blob must decode into a doc that projects to the same diagram.
    const blobDoc = new Y.Doc();
    Y.applyUpdate(blobDoc, base64ToBytes(body.yjsState));
    expect(projectYDocToDiagram(blobDoc)).toEqual(DiagramSchema.parse(diagram));
  });

  it('retries with currentVersion from a 409 and succeeds (collab bumped the version)', async () => {
    const diagram = makeFixture();
    const doc = hydrateFromDiagram(new Y.Doc(), diagram);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: 'Version conflict', currentVersion: 5 }, 409))
      .mockResolvedValueOnce(jsonResponse(resourceOf(diagram, 6)));
    vi.stubGlobal('fetch', fetchMock);

    const outcome = await saveDiagramFromDoc(doc, 4);

    expect(outcome).toEqual({ ok: true, version: 6 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, secondInit] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(JSON.parse(String(secondInit.body)).version).toBe(5);
  });

  it('gives up after exhausting attempts with a conflict outcome', async () => {
    const diagram = makeFixture();
    const doc = hydrateFromDiagram(new Y.Doc(), diagram);
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: 'Version conflict', currentVersion: 99 }, 409));
    vi.stubGlobal('fetch', fetchMock);

    const outcome = await saveDiagramFromDoc(doc, 4);

    expect(outcome.ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('maps a network failure to a failed outcome with status 0', async () => {
    const doc = hydrateFromDiagram(new Y.Doc(), makeFixture());
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('network down')));

    const outcome = await saveDiagramFromDoc(doc, 1);

    expect(outcome).toEqual({ ok: false, status: 0, message: 'Failed to connect to the API' });
  });
});

describe('PresenceBar (6b.3)', () => {
  it('renders connected user names', () => {
    render(<PresenceBar names={['User-ab12', 'User-cd34']} />);
    expect(screen.getByText('User-ab12')).toBeTruthy();
    expect(screen.getByText('User-cd34')).toBeTruthy();
  });

  it('renders nothing when nobody is connected', () => {
    const { container } = render(<PresenceBar names={[]} />);
    expect(container.querySelector('.presence-bar')).toBeNull();
  });
});

describe('App integration (editor:R5 round-trip + 6b blobs)', () => {
  it('loads by hash id, mutates through a delta, saves with a blob, and a fresh-doc reload reproduces the saved state without duplication', async () => {
    const diagram = makeFixture();
    const diagramId = diagram.id;
    const sessionDoc = new Y.Doc();
    let savedBody: { name: string; diagram: Diagram; version: number; yjsState: string } | null = null;

    // Server stub: GET returns current server state; PUT captures the body.
    vi.stubGlobal(
      'fetch',
      vi.fn((input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === 'PUT') {
          savedBody = JSON.parse(String(init.body)) as { name: string; diagram: Diagram; version: number; yjsState: string };
          return Promise.resolve(
            jsonResponse({ ...resourceOf(savedBody.diagram, 4), id: diagramId, yjsState: savedBody.yjsState }),
          );
        }
        if (url.endsWith(`/diagrams/${diagramId}`)) {
          const current = savedBody?.yjsState ?? resourceOf(diagram, 3).yjsState as string;
          const currentDiagram = savedBody?.diagram ?? diagram;
          return Promise.resolve(
            jsonResponse({ ...resourceOf(currentDiagram, savedBody === null ? 3 : 4), id: diagramId, yjsState: current }),
          );
        }
        return Promise.reject(new Error(`unexpected fetch ${url}`));
      }),
    );

    window.location.hash = `#/d/${diagramId}`;
    const firstSession = render(<App doc={sessionDoc} />);

    // Loaded: canvas renders the fixture classes from the Y.Doc.
    expect(await screen.findByText('Customer')).toBeTruthy();
    expect(screen.getByText('Order')).toBeTruthy();

    // Mutate through the canonical delta path on the App-owned doc.
    const createProduct: Delta = {
      kind: 'class',
      op: 'create',
      id: crypto.randomUUID(),
      diagramId,
      timestamp: new Date().toISOString(),
      classId: crypto.randomUUID(),
      name: 'Product',
      position: { x: 600, y: 0 },
    };
    act(() => {
      const result = applyDeltaToYDoc(sessionDoc, createProduct);
      expect(result.ok).toBe(true);
    });
    expect(screen.getByText('Product')).toBeTruthy();

    // Save: PUT carries the projected diagram, the loaded version AND a blob.
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(savedBody).not.toBeNull());
    // TS control-flow analysis cannot see the assignment inside the fetch
    // stub's closure, so it narrows savedBody to `null` here — recover the
    // runtime-observed type explicitly.
    const saved = savedBody as { name: string; diagram: Diagram; version: number; yjsState: string } | null;
    if (saved === null) {
      throw new Error('save never reached the API');
    }
    await waitFor(() => expect(screen.getByText('Saved')).toBeTruthy());
    expect(saved.version).toBe(3);
    expect(saved.yjsState.length).toBeGreaterThan(0);
    expect(saved.diagram.classes.map((cls) => cls.name)).toEqual(['Customer', 'Order', 'Product']);
    firstSession.unmount();

    // New session: fresh Y.Doc hydrated with the stored blob (server truth).
    const freshDoc = new Y.Doc();
    const secondSession = render(<App doc={freshDoc} />);
    expect(await screen.findByText('Product')).toBeTruthy();
    expect(screen.getByText('Customer')).toBeTruthy();
    expect(screen.getByText('Order')).toBeTruthy();
    secondSession.unmount();

    // Structural equivalence: the reloaded projection equals the saved one,
    // including positions and multiplicities.
    const reloaded = projectYDocToDiagram(freshDoc);
    expect(reloaded).toEqual(saved.diagram);

    // 6b killer assertion: a LAGGED client doc (hydrated from the original
    // blob, pre-mutation) merged with the stored blob must NOT duplicate any
    // array member — clocks line up because the save is blob-preserving.
    const laggedDoc = hydrateDiagramIntoDoc(new Y.Doc(), resourceOf(diagram, 3).yjsState as string);
    Y.applyUpdate(laggedDoc, base64ToBytes(saved.yjsState));
    const laggedProjection = projectYDocToDiagram(laggedDoc);
    expect(laggedProjection.classes).toHaveLength(3);
    expect(laggedProjection.classes[0]!.attributes).toHaveLength(1);
    expect(laggedProjection.associations).toHaveLength(1);
  });

  it('creates a new diagram on first visit without sending a client blob', async () => {
    // The API echoes the created diagram back; mirror that here.
    const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { diagram: Diagram };
        return Promise.resolve(jsonResponse(resourceOf(body.diagram, 1)));
      }
      return Promise.reject(new Error(`unexpected fetch ${String(input)}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    expect(await screen.findByRole('button', { name: 'Add class' })).toBeTruthy();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.method).toBe('POST');
    // The App generates its own diagram id; assert shape + that the recorded
    // hash id is the one it POSTed and the API echoed.
    const body = JSON.parse(String(init.body)) as { name: string; diagram: Diagram; yjsState?: string };
    expect(url).toBe('http://localhost:3000/diagrams');
    expect(body.name).toBe('Untitled');
    expect(body.yjsState).toBeUndefined();
    expect(body.diagram.id).toMatch(/^[0-9a-f-]{36}$/);
    await waitFor(() => expect(window.location.hash).toBe(`#/d/${body.diagram.id}`));
  });

  it('renders an explicit error and no canvas when the load fails (editor:R5)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ error: 'Diagram not found' }, 404)));

    window.location.hash = `#/d/${crypto.randomUUID()}`;
    const { container } = render(<App />);

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(screen.getByRole('alert').textContent).toContain('Diagram not found');
    expect(container.querySelector('.react-flow')).toBeNull();
  });

  it('renders an explicit error when the API is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('network down')));

    window.location.hash = `#/d/${crypto.randomUUID()}`;
    const { container } = render(<App />);

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(screen.getByRole('alert').textContent).toContain('Failed to connect to the API');
    expect(container.querySelector('.react-flow')).toBeNull();
  });

  it('exhausts save retries on a persistent version conflict and surfaces the conflict', async () => {
    const diagram = makeFixture();
    const fetchMock = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        return Promise.resolve(
          jsonResponse({ error: 'Version conflict: diagram was modified by another request', currentVersion: 8 }, 409),
        );
      }
      return Promise.resolve(jsonResponse(resourceOf(diagram, 3)));
    });
    vi.stubGlobal('fetch', fetchMock);

    window.location.hash = `#/d/${diagram.id}`;
    render(<App />);

    expect(await screen.findByText('Customer')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    // Every attempt got a 409 (with a fresh currentVersion each time), so the
    // retry loop exhausts and the UI surfaces the exhausted-conflict message.
    await waitFor(() => expect(screen.getByText(/kept changing on the server/)).toBeTruthy());
    expect(fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'PUT')).toHaveLength(3);
  });
});
