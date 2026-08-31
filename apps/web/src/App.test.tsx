import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

import { projectYDocToDiagram, type Delta, type Diagram } from '@app/core';

import {
  App,
  createEmptyDiagram,
  diagramIdFromHash,
  hydrateDiagramIntoDoc,
  saveDiagramFromDoc,
} from './App';
import { applyDeltaToYDoc } from './canvas/applyDeltaToYDoc';

/**
 * editor:R5 — load/save wiring: a saved diagram reloaded in a new session is
 * structurally equivalent to the saved one (classes, members, associations,
 * multiplicities and positions included). Load failure shows an explicit
 * error and never a partially loaded canvas.
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
        attributes: [{ id: crypto.randomUUID(), name: 'name', type: 'string' }],
        methods: [{ id: crypto.randomUUID(), name: 'getName', returnType: 'string', parameters: [] }],
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
  return { id: diagram.id, name: diagram.name, diagram, version, createdAt: 't', updatedAt: 't' };
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
    expect(createEmptyDiagram(id)).toEqual({ id, name: 'Untitled', classes: [], associations: [] });
  });

  it('hydrates a Y.Doc so its projection is structurally equal to the saved diagram', () => {
    const diagram = makeFixture();
    const doc = new Y.Doc();

    hydrateDiagramIntoDoc(doc, diagram);

    expect(projectYDocToDiagram(doc)).toEqual(diagram);
  });
});

describe('App save handler', () => {
  it('saves the projected diagram and returns the new version', async () => {
    const diagram = makeFixture();
    const doc = hydrateDiagramIntoDoc(new Y.Doc(), diagram);
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(resourceOf(diagram, 9)));
    vi.stubGlobal('fetch', fetchMock);

    const outcome = await saveDiagramFromDoc(doc, 8);

    expect(outcome).toEqual({ ok: true, version: 9 });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`http://localhost:3000/diagrams/${diagram.id}`);
    expect(init.method).toBe('PUT');
    expect(JSON.parse(String(init.body))).toEqual({ name: diagram.name, diagram, version: 8 });
  });

  it('maps a 409 conflict to a failed outcome carrying currentVersion', async () => {
    const diagram = makeFixture();
    const doc = hydrateDiagramIntoDoc(new Y.Doc(), diagram);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ error: 'Version conflict', currentVersion: 12 }, 409)),
    );

    const outcome = await saveDiagramFromDoc(doc, 8);

    expect(outcome).toEqual({ ok: false, status: 409, message: 'Version conflict', currentVersion: 12 });
  });

  it('maps a network failure to a failed outcome with status 0', async () => {
    const doc = hydrateDiagramIntoDoc(new Y.Doc(), makeFixture());
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('network down')));

    const outcome = await saveDiagramFromDoc(doc, 1);

    expect(outcome).toEqual({ ok: false, status: 0, message: 'Failed to connect to the API' });
  });
});

describe('App integration (editor:R5 round-trip)', () => {
  it('loads by hash id, mutates through a delta, saves, and a fresh-doc reload reproduces the saved state', async () => {
    const diagram = makeFixture();
    const diagramId = diagram.id;
    const sessionDoc = new Y.Doc();
    let savedBody: { name: string; diagram: Diagram; version: number } | null = null;

    // Server stub: GET returns current server state; PUT captures the body.
    vi.stubGlobal(
      'fetch',
      vi.fn((input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === 'PUT') {
          savedBody = JSON.parse(String(init.body)) as { name: string; diagram: Diagram; version: number };
          return Promise.resolve(jsonResponse({ ...resourceOf(savedBody.diagram, 4), id: diagramId }));
        }
        if (url.endsWith(`/diagrams/${diagramId}`)) {
          const current = savedBody?.diagram ?? diagram;
          return Promise.resolve(
            jsonResponse({ ...resourceOf(current, savedBody === null ? 3 : 4), id: diagramId }),
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

    // Save: PUT carries the projected diagram (with Product) and the loaded version.
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(savedBody).not.toBeNull());
    if (savedBody === null) {
      throw new Error('save never reached the API');
    }
    await waitFor(() => expect(screen.getByText('Saved')).toBeTruthy());
    const body = savedBody;
    expect(body.version).toBe(3);
    expect(body.diagram.classes.map((cls) => cls.name)).toEqual(['Customer', 'Order', 'Product']);
    firstSession.unmount();

    // New session: fresh Y.Doc hydrated with the captured PUT body.
    const freshDoc = new Y.Doc();
    const secondSession = render(<App doc={freshDoc} />);
    expect(await screen.findByText('Product')).toBeTruthy();
    expect(screen.getByText('Customer')).toBeTruthy();
    expect(screen.getByText('Order')).toBeTruthy();
    secondSession.unmount();

    // Structural equivalence: the reloaded projection equals the saved one,
    // including positions and multiplicities.
    const reloaded = projectYDocToDiagram(freshDoc);
    expect(reloaded).toEqual(body.diagram);
    expect(reloaded.classes.map((cls) => cls.position)).toEqual(
      body.diagram.classes.map((cls) => cls.position),
    );
    expect(reloaded.associations.map((a) => [a.sourceMultiplicity, a.targetMultiplicity])).toEqual(
      body.diagram.associations.map((a) => [a.sourceMultiplicity, a.targetMultiplicity]),
    );
  });

  it('creates a new diagram on first visit and records its id in the hash', async () => {
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
    const body = JSON.parse(String(init.body)) as { name: string; diagram: Diagram };
    expect(url).toBe('http://localhost:3000/diagrams');
    expect(body.name).toBe('Untitled');
    expect(body.diagram.name).toBe('Untitled');
    expect(body.diagram.classes).toEqual([]);
    expect(body.diagram.associations).toEqual([]);
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

  it('surfaces a version conflict on save with the server message', async () => {
    const diagram = makeFixture();
    vi.stubGlobal(
      'fetch',
      vi.fn((_input: string | URL | Request, init?: RequestInit) => {
        if (init?.method === 'PUT') {
          return Promise.resolve(
            jsonResponse({ error: 'Version conflict: diagram was modified by another request', currentVersion: 8 }, 409),
          );
        }
        return Promise.resolve(jsonResponse(resourceOf(diagram, 3)));
      }),
    );

    window.location.hash = `#/d/${diagram.id}`;
    render(<App />);

    expect(await screen.findByText('Customer')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.getByText(/Version conflict/)).toBeTruthy());
    expect(screen.getByText(/current version: 8/)).toBeTruthy();
  });
});
