/**
 * API route tests for GET /diagrams/:id/export/xmi (PR 15b — XMI export).
 *
 * Mirrors the import route test pattern (xmi-import.test.ts): real HTTP over
 * Fastify inject against the real database. Export is strictly read-only and
 * idempotent — no diagram mutation, no confirm gate.
 */
import { describe, expect, it, beforeAll, afterAll, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { DiagramSchema, type Diagram } from '@app/core';
import { buildApp, closePool, pool } from './index.js';

const app = buildApp({ logger: false });

let createdIds: string[] = [];

async function createEmptyDiagram(): Promise<Diagram> {
  const diagram: Diagram = DiagramSchema.parse({
    id: randomUUID(),
    name: 'XMI Export Source',
    classes: [],
    associations: [],
    generalizations: [],
    realizations: [],
    dependencies: [],
    naryAssociations: [],
  });
  const res = await app.inject({
    method: 'POST',
    url: '/diagrams',
    payload: { name: diagram.name, diagram },
  });
  expect(res.statusCode).toBe(201);
  createdIds.push(diagram.id);
  return diagram;
}

beforeAll(async () => {
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await closePool();
});

afterEach(async () => {
  if (createdIds.length > 0) {
    await pool.query('DELETE FROM diagrams WHERE id = ANY($1)', [createdIds]);
    createdIds = [];
  }
});

describe('API route: GET /diagrams/:id/export/xmi (PR 15b)', () => {
  it('registers the route at the exact method and path', () => {
    expect(app.hasRoute({ method: 'GET', url: '/diagrams/:id/export/xmi' })).toBe(true);
  });

  it('returns 404 with the declared error body for a non-existent diagram id', async () => {
    const missingId = randomUUID();
    const res = await app.inject({ method: 'GET', url: `/diagrams/${missingId}/export/xmi` });
    expect(res.statusCode).toBe(404);
    const body = res.json() as { error: string };
    expect(body.error).toBe('Diagram not found');
  });

  it('returns valid XMI 2.1 content for an empty diagram', async () => {
    const diagram = await createEmptyDiagram();
    const res = await app.inject({ method: 'GET', url: `/diagrams/${diagram.id}/export/xmi` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/xml');
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.headers['content-disposition']).toContain('.xmi');

    const xmi = res.payload;
    expect(xmi).toContain('<?xml');
    expect(xmi).toContain('xmi:XMI');
    expect(xmi).toContain('uml:Model');
  });

  it('export is strictly read-only: the diagram version and contents are unchanged after export', async () => {
    const diagram = await createEmptyDiagram();

    // Export
    const exportRes = await app.inject({ method: 'GET', url: `/diagrams/${diagram.id}/export/xmi` });
    expect(exportRes.statusCode).toBe(200);

    // Verify diagram unchanged
    const getRes = await app.inject({ method: 'GET', url: `/diagrams/${diagram.id}` });
    expect(getRes.statusCode).toBe(200);
    const persisted = getRes.json() as { diagram: Diagram; version: number };
    expect(persisted.version).toBe(1);
    expect(persisted.diagram.classes).toHaveLength(0);
  });

  it('export is idempotent: two successive exports produce the same XMI', async () => {
    const diagram = await createEmptyDiagram();
    const res1 = await app.inject({ method: 'GET', url: `/diagrams/${diagram.id}/export/xmi` });
    const res2 = await app.inject({ method: 'GET', url: `/diagrams/${diagram.id}/export/xmi` });
    expect(res1.statusCode).toBe(200);
    expect(res2.statusCode).toBe(200);
    expect(res1.payload).toBe(res2.payload);
  });

  it('Content-Disposition filename is derived from the diagram name', async () => {
    const diagram: Diagram = DiagramSchema.parse({
      id: randomUUID(),
      name: 'My Test Diagram',
      classes: [],
      associations: [],
      generalizations: [],
      realizations: [],
      dependencies: [],
      naryAssociations: [],
    });
    const res = await app.inject({
      method: 'POST',
      url: '/diagrams',
      payload: { name: diagram.name, diagram },
    });
    expect(res.statusCode).toBe(201);
    createdIds.push(diagram.id);

    const exportRes = await app.inject({ method: 'GET', url: `/diagrams/${diagram.id}/export/xmi` });
    expect(exportRes.statusCode).toBe(200);
    expect(exportRes.headers['content-disposition']).toContain('My_Test_Diagram.xmi');
  });
});
