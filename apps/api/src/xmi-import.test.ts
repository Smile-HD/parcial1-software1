/**
 * API route tests for POST /diagrams/:id/import/xmi (PR 15 — XMI import).
 *
 * These exercise the REAL route over REAL HTTP (Fastify inject) against the
 * REAL database, feeding genuine Enterprise Architect fixtures from
 * packages/adapters-import/test/fixtures. The key regression guard (issue
 * #284): the batch delivered over HTTP must pass BatchDeltaSchema.parse AND
 * apply through the real engine (applyDelta) onto the persisted diagram.
 *
 * Database note: like generate.test.ts / voice.test.ts, this file uses the
 * default DATABASE_URL from ./index.js (the `ai_uml` dev DB) because it only
 * inserts rows with unique ids and deletes exactly those rows again — it never
 * wipes. ai_uml_test is NOT safe here: index.test.ts runs in a parallel
 * worker and wipes the whole diagrams table between its tests, which would
 * delete this suite's rows mid-flight.
 */
import { describe, expect, it, beforeAll, afterAll, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { BatchDeltaSchema, DiagramSchema, applyDelta, type BatchDelta, type Diagram } from '@app/core';
import { buildApp, closePool, pool } from './index.js';

const FIXTURES = new URL('../../../packages/adapters-import/test/fixtures/', import.meta.url);
const eaRealExport = readFileSync(new URL('ea-real-export.xmi', FIXTURES), 'utf8');
const badVersionXmi = readFileSync(new URL('bad-version.xmi', FIXTURES), 'utf8');
const malformedXmi = readFileSync(new URL('malformed.xmi', FIXTURES), 'utf8');

const app = buildApp({ logger: false });

/** Diagram ids created by the running test; cleaned up exactly after each test. */
let createdIds: string[] = [];

/** Create an empty diagram through the real persistence API. */
async function createEmptyDiagram(): Promise<Diagram> {
  const diagram: Diagram = DiagramSchema.parse({
    id: randomUUID(),
    name: 'XMI Import Target',
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

function importXmi(diagramId: string, xmi: string) {
  return app.inject({
    method: 'POST',
    url: `/diagrams/${diagramId}/import/xmi`,
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ xmi }),
  });
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

describe('API route: POST /diagrams/:id/import/xmi (PR 15)', () => {
  it('registers the route at the exact method and path the web client calls (apps/web/src/api/xmiApi.ts)', () => {
    // xmiApi.ts builds `${API_BASE_URL}/diagrams/${diagramId}/import/xmi` and
    // sends POST with Content-Type: application/json and body { xmi: string }.
    // Anchor the server registration to that same contract so neither side
    // can move the endpoint without failing this test.
    expect(app.hasRoute({ method: 'POST', url: '/diagrams/:id/import/xmi' })).toBe(true);
    expect(app.hasRoute({ method: 'GET', url: '/diagrams/:id/import/xmi' })).toBe(false);
  });

  it('accepts a real Enterprise Architect XMI 2.1 export and returns deltaId + BatchSchema-valid batch + summary', async () => {
    const diagram = await createEmptyDiagram();

    const res = await importXmi(diagram.id, eaRealExport);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { deltaId: string; batch: BatchDelta; summary: Record<string, number> };

    // Success contract declared by the client (xmiApi.ts): deltaId + batch + summary.
    expect(body.deltaId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.batch).toBeDefined();

    // The batch delivered over the wire is schema-valid as-is (this parse is
    // the #284 contract guard: HTTP round-trip must not corrupt the batch).
    const parsed = BatchDeltaSchema.parse(body.batch);
    expect(parsed.id).toBe(body.deltaId);
    expect(parsed.diagramId).toBe(diagram.id);
    expect(parsed.kind).toBe('batch');
    expect(parsed.deltas.length).toBeGreaterThan(0);

    // Summary counts match the real fixture (documented adapter contract:
    // 3 classes, 3 associations incl. self-loop, 1 generalization).
    expect(body.summary).toEqual({
      classes: 3,
      associations: 3,
      generalizations: 1,
      realizations: 0,
      dependencies: 0,
      naryAssociations: 0,
    });
  });

  it('imported batch applies through the REAL engine onto the persisted diagram, and the server does not mutate it (#284 regression guard)', async () => {
    const diagram = await createEmptyDiagram();

    const res = await importXmi(diagram.id, eaRealExport);
    expect(res.statusCode).toBe(200);
    const { batch } = res.json() as { batch: BatchDelta };

    // The route is read-only: the persisted diagram is untouched by a
    // successful import (xmiApi.ts documents this: "the server does NOT
    // mutate the diagram").
    const after = await app.inject({ method: 'GET', url: `/diagrams/${diagram.id}` });
    expect(after.statusCode).toBe(200);
    const persisted = after.json() as { diagram: Diagram; version: number };
    expect(persisted.version).toBe(1);
    expect(persisted.diagram.classes).toHaveLength(0);

    // Apply the HTTP-delivered batch to the HTTP-loaded diagram with the real
    // engine — the exact path the web client runs after import.
    const applyResult = applyDelta(persisted.diagram, BatchDeltaSchema.parse(batch));
    expect(applyResult.ok).toBe(true);
    if (!applyResult.ok) return;

    const applied = applyResult.value;
    expect(applied.classes).toHaveLength(3);
    expect(applied.associations).toHaveLength(3);
    expect(applied.generalizations).toHaveLength(1);

    // Primitive-type resolution and visibility normalization survived HTTP:
    // Producto has exactly 3 attributes typed string/int/String, all private.
    const producto = applied.classes.find((c) => c.name === 'Producto')!;
    expect(producto).toBeDefined();
    expect(producto.attributes.map((a) => a.name)).toEqual(['Descripcion', 'id', 'Nombre']);
    expect(producto.attributes.map((a) => a.type)).toEqual(['string', 'int', 'String']);
    expect(producto.attributes.every((a) => a.visibility === '-')).toBe(true);

    // Composition orientation: diamond sits on the Producto (source) end.
    const composite = applied.associations.find((a) => a.aggregation === 'composite')!;
    const class1 = applied.classes.find((c) => c.name === 'Class1')!;
    expect(composite.sourceClassId).toBe(producto.id);
    expect(composite.targetClassId).toBe(class1.id);

    // Grid layout owns positions: every class placed, no overlaps (xmi:R3).
    const positions = applied.classes.map((c) => `${c.position.x},${c.position.y}`);
    expect(new Set(positions).size).toBe(positions.length);
  });

  it('returns 400 with a machine-readable error for malformed XML and writes no state', async () => {
    const diagram = await createEmptyDiagram();

    const res = await importXmi(diagram.id, malformedXmi);
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: string };
    expect(typeof body.error).toBe('string');
    expect(body.error).toMatch(/XMI parse error/);

    // No state written: the stored diagram is untouched.
    const after = await app.inject({ method: 'GET', url: `/diagrams/${diagram.id}` });
    const persisted = after.json() as { diagram: Diagram; version: number };
    expect(persisted.version).toBe(1);
    expect(persisted.diagram.classes).toHaveLength(0);
  });

  it('returns 400 naming the supported version for an unsupported XMI version (adapter contract)', async () => {
    const diagram = await createEmptyDiagram();

    const res = await importXmi(diagram.id, badVersionXmi);
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: string };
    expect(body.error).toMatch(/Unsupported XMI version/);
    expect(body.error).toMatch(/supported: 2\.1/);
  });

  it('returns 404 with the declared error body for a non-existent diagram id', async () => {
    const missingId = randomUUID();

    const res = await importXmi(missingId, eaRealExport);
    expect(res.statusCode).toBe(404);
    const body = res.json() as { error: string };
    expect(body.error).toBe('Diagram not found');
  });

  it('responds (no hang) when the payload parses but yields a schema-invalid batch; current behavior is a plain 500', async () => {
    // Reachable over HTTP: an <UML:Attribute> without @name parses to an
    // empty-string attribute name, which MemberDeltaSchema rejects (min 1),
    // so the route's BatchDeltaSchema.parse throws a ZodError. The contract
    // we pin here is "the request terminates with a JSON error status and
    // writes no state" — NOT a specific status code (see report: 4xx would be
    // a better contract for input-caused failures, deliberately not changed
    // in this pass).
    const diagram = await createEmptyDiagram();
    const unnamedAttributeXmi = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<UML:Model xmi:version="2.1" xmlns:xmi="http://schema.omg.org/spec/XMI/2.1">',
      '  <UML:Class name="Holder" id="CLS_1">',
      '    <UML:Attribute type="int"/>',
      '  </UML:Class>',
      '</UML:Model>',
    ].join('\n');

    const res = await importXmi(diagram.id, unnamedAttributeXmi);
    // inject() resolving at all proves the handler did not hang.
    expect(res.statusCode).toBe(500);

    // No state written.
    const after = await app.inject({ method: 'GET', url: `/diagrams/${diagram.id}` });
    const persisted = after.json() as { diagram: Diagram; version: number };
    expect(persisted.version).toBe(1);
    expect(persisted.diagram.classes).toHaveLength(0);
  });
});
