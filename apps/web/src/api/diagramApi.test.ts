import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Diagram } from '@app/core';

import { createDiagram, DiagramApiError, loadDiagram, saveDiagram } from './diagramApi';

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function makeDiagram(): Diagram {
  const customerId = crypto.randomUUID();
  const orderId = crypto.randomUUID();
  return {
    id: crypto.randomUUID(),
    name: 'Shop',
    classes: [
      { id: customerId, name: 'Customer', position: { x: 0, y: 0 }, attributes: [], methods: [] },
      { id: orderId, name: 'Order', position: { x: 300, y: 0 }, attributes: [], methods: [] },
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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('diagramApi', () => {
  it('createDiagram POSTs {name, diagram} to /diagrams and parses the resource', async () => {
    const diagram = makeDiagram();
    const resource = { id: diagram.id, name: 'Shop', diagram, version: 1, createdAt: 't', updatedAt: 't' };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(resource, 201));
    vi.stubGlobal('fetch', fetchMock);

    const result = await createDiagram('Shop', diagram);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://localhost:3000/diagrams');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ name: 'Shop', diagram });
    expect(result).toEqual(resource);
  });

  it('loadDiagram GETs /diagrams/:id and parses the resource', async () => {
    const diagram = makeDiagram();
    const resource = { id: diagram.id, name: 'Shop', diagram, version: 4, createdAt: 't', updatedAt: 't' };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(resource, 200));
    vi.stubGlobal('fetch', fetchMock);

    const result = await loadDiagram(diagram.id);

    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toBe(`http://localhost:3000/diagrams/${diagram.id}`);
    expect(result.version).toBe(4);
    expect(result.diagram).toEqual(diagram);
  });

  it('saveDiagram PUTs {name, diagram, version} and returns the bumped version', async () => {
    const diagram = makeDiagram();
    const resource = { id: diagram.id, name: 'Shop', diagram, version: 5, createdAt: 't', updatedAt: 't' };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(resource, 200));
    vi.stubGlobal('fetch', fetchMock);

    const result = await saveDiagram(diagram.id, 'Shop', diagram, 4);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`http://localhost:3000/diagrams/${diagram.id}`);
    expect(init.method).toBe('PUT');
    expect(JSON.parse(String(init.body))).toEqual({ name: 'Shop', diagram, version: 4 });
    expect(result.version).toBe(5);
  });

  it('maps a 409 conflict response to DiagramApiError carrying currentVersion', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(
        { error: 'Version conflict: diagram was modified by another request', currentVersion: 7 },
        409,
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const error = await saveDiagram(crypto.randomUUID(), 'Shop', makeDiagram(), 4).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(DiagramApiError);
    expect((error as DiagramApiError).status).toBe(409);
    expect((error as DiagramApiError).currentVersion).toBe(7);
  });

  it('maps non-OK responses to DiagramApiError with the server message', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: 'Diagram not found' }, 404));
    vi.stubGlobal('fetch', fetchMock);

    const error = await loadDiagram(crypto.randomUUID()).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DiagramApiError);
    expect((error as DiagramApiError).status).toBe(404);
    expect((error as DiagramApiError).message).toBe('Diagram not found');
  });
});
