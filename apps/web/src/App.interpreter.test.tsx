import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

import { buildYDocFromDiagram, encodeYDoc, projectYDocToDiagram, type Delta, type Diagram } from '@app/core';

import { App } from './App';
import { bytesToBase64 } from './api/base64';
import { describeDelta } from './interpreter/DeltaPreviewModal';

/**
 * Task 7.6 — web delta-preview modal (interpreter:R2/R3):
 * a pending AI delta is shown before it is applied; Confirm applies it
 * visibly through the canonical delta path, Reject discards it, and a
 * scoped edit is accepted right after a refusal.
 */

function makeFixture(): Diagram {
  const customerId = crypto.randomUUID();
  return {
    id: '11111111-2222-4333-8444-555555555555',
    name: 'Shop',
    classes: [
      { id: customerId, name: 'Customer', position: { x: 10, y: 20 }, attributes: [], methods: [] },
    ],
    associations: [],
  };
}

function addClassDelta(diagramId: string): Delta {
  return {
    id: crypto.randomUUID(),
    diagramId,
    timestamp: '2026-08-31T12:00:00.000Z',
    kind: 'class',
    op: 'create',
    classId: crypto.randomUUID(),
    name: 'Product',
    position: { x: 120, y: 80 },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

function resourceOf(diagram: Diagram, version: number): Record<string, unknown> {
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

interface FetchRoute {
  interpretQueue: Array<{ status: number; body: unknown }>;
  deltaId: string;
}

/** Stubs fetch: GET/PUT diagram + ordered interpret responses + confirm/reject. */
function stubFetch(diagram: Diagram, route: FetchRoute): { confirms: number; rejects: number } {
  const counters = { confirms: 0, rejects: 0 };
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (method === 'PUT' && url.endsWith(`/diagrams/${diagram.id}`)) {
        return Promise.resolve(jsonResponse(resourceOf(diagram, 4)));
      }
      if (method === 'GET' && url.endsWith(`/diagrams/${diagram.id}`)) {
        return Promise.resolve(jsonResponse(resourceOf(diagram, 3)));
      }
      if (method === 'POST' && url.endsWith('/interpret')) {
        const next = route.interpretQueue.shift();
        if (next === undefined) {
          return Promise.reject(new Error('no interpret response queued'));
        }
        return Promise.resolve(jsonResponse(next.body, next.status));
      }
      if (method === 'POST' && url.includes(`/deltas/${route.deltaId}/confirm`)) {
        counters.confirms += 1;
        return Promise.resolve(jsonResponse({ status: 'confirmed', delta: addClassDelta(diagram.id), diagramId: diagram.id }));
      }
      if (method === 'POST' && url.includes(`/deltas/${route.deltaId}/reject`)) {
        counters.rejects += 1;
        return Promise.resolve(jsonResponse({ status: 'rejected' }));
      }
      return Promise.reject(new Error(`unexpected fetch ${method} ${url}`));
    }),
  );
  return counters;
}

async function renderReadyAppAndSubmit(diagram: Diagram, doc: Y.Doc, text: string): Promise<void> {
  window.location.hash = `#/d/${diagram.id}`;
  render(<App doc={doc} />);
  expect(await screen.findByText('Customer')).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Natural language command'), { target: { value: text } });
  fireEvent.click(screen.getByText('Send'));
}

afterEach(() => {
  vi.unstubAllGlobals();
  window.location.hash = '';
});

describe('describeDelta (task 7.6)', () => {
  it('renders human-readable summaries for class, member and batch deltas', () => {
    expect(
      describeDelta({
        id: crypto.randomUUID(),
        diagramId: makeFixture().id,
        timestamp: '2026-08-31T12:00:00.000Z',
        kind: 'class',
        op: 'create',
        classId: crypto.randomUUID(),
        name: 'Product',
        position: { x: 1, y: 2 },
      }),
    ).toBe('Add class "Product"');

    expect(
      describeDelta({
        id: crypto.randomUUID(),
        diagramId: makeFixture().id,
        timestamp: '2026-08-31T12:00:00.000Z',
        kind: 'member',
        op: 'addAttribute',
        classId: crypto.randomUUID(),
        memberId: crypto.randomUUID(),
        name: 'name',
        type: 'string',
      }),
    ).toBe('Add attribute "name: string"');

    const batch: Delta = {
      id: crypto.randomUUID(),
      diagramId: makeFixture().id,
      timestamp: '2026-08-31T12:00:00.000Z',
      kind: 'batch',
      deltas: [],
    };
    expect(describeDelta(batch)).toBe('Apply 0 changes: ');
  });
});

describe('App delta-preview modal (interpreter:R2)', () => {
  it('shows the pending delta, applies it visibly on Confirm, model untouched before', async () => {
    const diagram = makeFixture();
    const sessionDoc = new Y.Doc();
    const delta = addClassDelta(diagram.id);
    const counters = stubFetch(diagram, {
      deltaId: 'delta-1',
      interpretQueue: [{ status: 200, body: { status: 'pending', deltaId: 'delta-1', delta } }],
    });

    await renderReadyAppAndSubmit(diagram, sessionDoc, 'add a class Product');

    // Pending delta is previewed, NOT applied yet (interpreter:R2).
    expect(await screen.findByText('Add class "Product"')).toBeTruthy();
    expect(projectYDocToDiagram(sessionDoc).classes.map((c) => c.name)).toEqual(['Customer']);

    fireEvent.click(screen.getByText('Confirm'));

    // Applied visibly through the canonical delta path.
    expect(await screen.findByText('Product')).toBeTruthy();
    expect(projectYDocToDiagram(sessionDoc).classes.map((c) => c.name)).toEqual(['Customer', 'Product']);
    expect(counters.confirms).toBe(1);
    expect(screen.queryByText('Add class "Product"')).toBeNull();
  });

  it('discards the pending delta on Reject and leaves the model unchanged', async () => {
    const diagram = makeFixture();
    const sessionDoc = new Y.Doc();
    const delta = addClassDelta(diagram.id);
    const counters = stubFetch(diagram, {
      deltaId: 'delta-1',
      interpretQueue: [{ status: 200, body: { status: 'pending', deltaId: 'delta-1', delta } }],
    });

    await renderReadyAppAndSubmit(diagram, sessionDoc, 'add a class Product');
    expect(await screen.findByText('Add class "Product"')).toBeTruthy();

    fireEvent.click(screen.getByText('Reject'));

    await waitFor(() => expect(counters.rejects).toBe(1));
    expect(screen.queryByText('Add class "Product"')).toBeNull();
    expect(screen.queryByText('Product')).toBeNull();
    expect(projectYDocToDiagram(sessionDoc).classes.map((c) => c.name)).toEqual(['Customer']);
  });
});

describe('Refusal and error surfacing (interpreter:R3/R1)', () => {
  it('shows the refusal, then accepts a scoped edit right after it', async () => {
    const diagram = makeFixture();
    const sessionDoc = new Y.Doc();
    const delta = addClassDelta(diagram.id);
    const counters = stubFetch(diagram, {
      deltaId: 'delta-1',
      interpretQueue: [
        {
          status: 200,
          body: {
            status: 'refused',
            reason: 'I can only apply scoped edits, not whole designs.',
            supportedCategories: ['add/rename/delete class'],
          },
        },
        { status: 200, body: { status: 'pending', deltaId: 'delta-1', delta } },
      ],
    });

    await renderReadyAppAndSubmit(diagram, sessionDoc, 'generate me a full design for a library system');

    // Refusal is visible, model untouched.
    expect(await screen.findByText(/Refused: I can only apply scoped edits/)).toBeTruthy();
    expect(projectYDocToDiagram(sessionDoc).classes.map((c) => c.name)).toEqual(['Customer']);

    // Scoped edit right after the refusal goes pending → confirm applies it.
    fireEvent.change(screen.getByLabelText('Natural language command'), { target: { value: 'add a class Product' } });
    fireEvent.click(screen.getByText('Send'));
    expect(await screen.findByText('Add class "Product"')).toBeTruthy();
    fireEvent.click(screen.getByText('Confirm'));
    expect(await screen.findByText('Product')).toBeTruthy();
    expect(counters.confirms).toBe(1);
  });

  it('surfaces a 422 schema-invalid outcome as an explicit message with the model untouched', async () => {
    const diagram = makeFixture();
    const sessionDoc = new Y.Doc();
    stubFetch(diagram, {
      deltaId: 'delta-1',
      interpretQueue: [
        {
          status: 422,
          body: {
            status: 'error',
            error: 'The command could not be interpreted: the AI output did not match the delta schema.',
          },
        },
      ],
    });

    await renderReadyAppAndSubmit(diagram, sessionDoc, 'do something weird');

    expect(
      await screen.findByText(/the AI output did not match the delta schema/),
    ).toBeTruthy();
    expect(projectYDocToDiagram(sessionDoc).classes.map((c) => c.name)).toEqual(['Customer']);
    expect(screen.queryByText('Add class "Product"')).toBeNull();
  });
});
