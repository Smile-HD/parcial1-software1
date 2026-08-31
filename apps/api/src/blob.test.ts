/**
 * Blob-preserving persistence (work unit 6b, design D4 "yjs_state is
 * authoritative").
 *
 * The hazard these tests pin down: when a collab-connected client saves, the
 * API must store the CLIENT's own Yjs blob. Rebuilding a blob from the JSON
 * projection resets Yjs clocks, and merging that rebuilt blob into a live
 * client doc duplicates Y.Array members (attributes/methods/parameters).
 */
import { afterAll, describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import {
  buildYDocFromDiagram,
  encodeYDoc,
  loadYDocFromUpdate,
  projectYDocToDiagram,
  validateYDocProjection,
  type Diagram,
} from '@app/core';

import { buildApp, closePool } from './index.js';

function makeDiagram(): Diagram {
  const customerId = crypto.randomUUID();
  const orderId = crypto.randomUUID();
  return {
    id: crypto.randomUUID(),
    name: 'Blob Test',
    classes: [
      {
        id: customerId,
        name: 'Customer',
        position: { x: 0, y: 0 },
        attributes: [
          { id: crypto.randomUUID(), name: 'name', type: 'string' },
          { id: crypto.randomUUID(), name: 'email', type: 'string' },
        ],
        methods: [{ id: crypto.randomUUID(), name: 'getId', returnType: 'string', parameters: [] }],
      },
      { id: orderId, name: 'Order', position: { x: 300, y: 0 }, attributes: [], methods: [] },
    ],
    associations: [],
  };
}

function toBase64(update: Uint8Array): string {
  return Buffer.from(update).toString('base64');
}

function fromBase64(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, 'base64'));
}

describe('blob-preserving persistence (6b)', () => {
  const app = buildApp({ logger: false });

  afterAll(async () => {
    await app.close();
    await closePool();
  });

  it('returns the stored blob unchanged on GET (client clocks converge)', async () => {
    const diagram = makeDiagram();
    const blob = encodeYDoc(buildYDocFromDiagram(diagram));

    const created = await app.inject({
      method: 'POST',
      url: '/diagrams',
      payload: { name: diagram.name, diagram, yjsState: toBase64(blob) },
    });
    expect(created.statusCode).toBe(201);

    const body = created.json() as { yjsState: string; diagram: Diagram };
    expect(fromBase64(body.yjsState)).toEqual(blob);

    const loaded = await app.inject({ method: 'GET', url: `/diagrams/${diagram.id}` });
    expect(loaded.statusCode).toBe(200);
    const loadedBody = loaded.json() as { yjsState: string };
    expect(fromBase64(loadedBody.yjsState)).toEqual(blob);
  });

  it('a client-saved blob extends (never resets) clocks, so merges do not duplicate array members', async () => {
    const diagram = makeDiagram();
    const blob1 = encodeYDoc(buildYDocFromDiagram(diagram));

    const created = await app.inject({
      method: 'POST',
      url: '/diagrams',
      payload: { name: diagram.name, diagram, yjsState: toBase64(blob1) },
    });
    expect(created.statusCode).toBe(201);

    // "Client" doc 1: hydrated from blob1, then edited in place (clocks extend).
    const clientDoc = loadYDocFromUpdate(blob1);
    const yClasses = clientDoc.getMap('classes');
    const customer = diagram.classes[0]!;
    const yCustomer = yClasses.get(customer.id) as Y.Map<unknown>;
    yCustomer.set('name', 'Client');

    // A SECOND client hydrated from blob1 and merged with client 1 must not
    // duplicate members (this is the exact merge a live room performs).
    const blob2 = Y.encodeStateAsUpdate(clientDoc);
    const secondClientDoc = loadYDocFromUpdate(blob1);
    Y.applyUpdate(secondClientDoc, blob2);
    const merged = validateYDocProjection(secondClientDoc);
    expect(merged.ok).toBe(true);
    expect(merged.ok && merged.diagram.classes[0]!.attributes).toHaveLength(2);
    expect(merged.ok && merged.diagram.classes[0]!.methods).toHaveLength(1);

    // Save via API with the client's own blob: the stored blob must be blob2
    // (clocks preserved), and hydrating a fresh doc from the GET response
    // merges cleanly against the live client doc.
    const saved = await app.inject({
      method: 'PUT',
      url: `/diagrams/${diagram.id}`,
      payload: { diagram, yjsState: toBase64(blob2), version: 1 },
    });
    expect(saved.statusCode).toBe(200);

    const loaded = await app.inject({ method: 'GET', url: `/diagrams/${diagram.id}` });
    const storedBlob = fromBase64((loaded.json() as { yjsState: string }).yjsState);
    expect(storedBlob).toEqual(blob2);

    // The killer assertion: a doc hydrated from blob1 (pre-save client that
    // has not received the edit yet) merges with the stored blob without
    // duplicating any array member.
    const laggedDoc = loadYDocFromUpdate(blob1);
    Y.applyUpdate(laggedDoc, storedBlob);
    const laggedProjection = projectYDocToDiagram(laggedDoc);
    const refreshed = validateYDocProjection(laggedDoc);
    expect(refreshed.ok).toBe(true);
    expect(refreshed.ok && refreshed.diagram.classes[0]!.attributes).toHaveLength(2);
    expect(refreshed.ok && refreshed.diagram.classes[0]!.methods).toHaveLength(1);
    expect(laggedProjection.classes[0]!.name).toBe('Client');
  });

  it('rejects a corrupt client blob with 400 and stores nothing', async () => {
    const diagram = makeDiagram();

    const created = await app.inject({
      method: 'POST',
      url: '/diagrams',
      payload: { name: diagram.name, diagram },
    });
    expect(created.statusCode).toBe(201);

    const corrupt = toBase64(new Uint8Array([1, 2, 3, 4, 5]));
    const saved = await app.inject({
      method: 'PUT',
      url: `/diagrams/${diagram.id}`,
      payload: { diagram, yjsState: corrupt, version: 1 },
    });
    expect(saved.statusCode).toBe(400);
    expect((saved.json() as { error: string }).error).toContain('Invalid yjsState');
  });
});
