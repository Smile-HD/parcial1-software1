/**
 * PR 5 — collab-server integration tests.
 * Real PostgreSQL (compose stack), real WebSocket transport, in-memory Y.Doc clients.
 * Covers tasks 5.1-5.5: per-diagram rooms, blob-authoritative persistence binding,
 * realtime R1-R4, and the api+collab LAN smoke with accurate presence.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { WebSocket as WS } from 'ws';
import { WebsocketProvider } from 'y-websocket';
import { Pool } from 'pg';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { v7 as uuidv7 } from 'uuid';
import {
  buildYDocFromDiagram,
  DiagramSchema,
  encodeYDoc,
  loadYDocFromUpdate,
  projectYDocToDiagram,
  type Diagram,
} from '@app/core';
import { startCollabServer, type CollabServer } from './index.js';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5433/ai_uml_test';
const pool = new Pool({ connectionString: DATABASE_URL, max: 5 });

let server: CollabServer;
let apiPort: number | undefined;
let apiClose: (() => Promise<void>) | undefined;
const clients: ClientHandle[] = [];

// ---------- helpers ----------

interface ClientHandle {
  ydoc: Y.Doc;
  provider: WebsocketProvider;
  synced: Promise<void>;
  userName: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function connectClient(roomDiagramId: string, userName: string): ClientHandle {
  const ydoc = new Y.Doc();
  const provider = new WebsocketProvider(
    `ws://127.0.0.1:${server.port}`,
    `diagrams/${roomDiagramId}`,
    ydoc,
    { WebSocketPolyfill: WS as unknown as typeof WebSocket, disableBc: true },
  );
  provider.awareness.setLocalStateField('user', { name: userName });
  const synced = new Promise<void>((resolve) => {
    provider.on('sync', (isSynced: boolean) => {
      if (isSynced) resolve();
    });
  });
  const handle: ClientHandle = { ydoc, provider, synced, userName };
  clients.push(handle);
  return handle;
}

function presenceNames(provider: WebsocketProvider): string[] {
  const names: string[] = [];
  provider.awareness.getStates().forEach((state) => {
    const user = (state as { user?: { name?: string } }).user;
    if (user?.name) names.push(user.name);
  });
  return names.sort();
}

function diagramOf(client: ClientHandle): Diagram {
  return projectYDocToDiagram(client.ydoc);
}

function classMap(client: ClientHandle, classId: string): Y.Map<unknown> {
  const yClass = client.ydoc.getMap('classes').get(classId);
  if (!(yClass instanceof Y.Map)) throw new Error(`class ${classId} not found in Y.Doc`);
  return yClass;
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timeout after ${timeoutMs}ms: ${label}`);
    }
    await sleep(50);
  }
}

function makeDiagram(): Diagram {
  const classA = {
    id: uuidv7(),
    name: 'User',
    position: { x: 100, y: 200 },
    attributes: [{ id: uuidv7(), name: 'id', type: 'UUID' }],
    methods: [],
  };
  const classB = {
    id: uuidv7(),
    name: 'Order',
    position: { x: 300, y: 200 },
    attributes: [],
    methods: [],
  };
  return DiagramSchema.parse({
    id: uuidv7(),
    name: 'Collab Test',
    classes: [classA, classB],
    associations: [
      {
        id: uuidv7(),
        sourceClassId: classA.id,
        targetClassId: classB.id,
        sourceMultiplicity: '1',
        targetMultiplicity: '0..*',
        directed: true,
      },
    ],
  });
}

async function insertDiagramRow(diagram: Diagram, name = 'Collab Test'): Promise<void> {
  const yDoc = buildYDocFromDiagram(diagram);
  const state = Buffer.from(encodeYDoc(yDoc));
  await pool.query(
    'INSERT INTO diagrams (id, name, doc, yjs_state, version) VALUES ($1, $2, $3, $4, 1)',
    [diagram.id, name, JSON.stringify(diagram), state],
  );
}

async function ensureSchema(): Promise<void> {
  const { rows } = await pool.query(`SELECT to_regclass('public.diagrams') AS reg`);
  if (rows[0]?.reg) return;
  // Fresh database: apply the same migration file the API uses (no duplicated DDL).
  const here = fileURLToPath(new URL('.', import.meta.url));
  const sql = readFileSync(join(here, '..', '..', 'api', 'migrations', '0001_diagrams.sql'), 'utf-8');
  await pool.query(sql);
}

// ---------- lifecycle ----------

beforeAll(async () => {
  await ensureSchema();
  // The API module (@app/api) reads process.env.DATABASE_URL at import time.
  // Pin it to the SAME isolated test DB this suite uses BEFORE the dynamic
  // import, so the API-under-test and the collab server share one database —
  // otherwise the API silently talks to the dev DB and cross-writer tests 404.
  process.env.DATABASE_URL = DATABASE_URL;
  // Smoke target: the real API over real HTTP, built by @app/api (not re-implemented here).
  const { buildApp } = await import('@app/api');
  const apiApp = buildApp({ logger: false });
  await apiApp.listen({ port: 0, host: '127.0.0.1' });
  const address = apiApp.server.address();
  if (address && typeof address === 'object') apiPort = address.port;
  apiClose = () => apiApp.close();

  server = await startCollabServer({ port: 0, databaseUrl: DATABASE_URL });
}, 30_000);

afterAll(async () => {
  await server.close();
  if (apiClose) await apiClose();
  const { closePool } = await import('@app/api');
  await closePool();
  await pool.end();
});

beforeEach(async () => {
  await pool.query('DELETE FROM diagrams');
});

afterEach(async () => {
  for (const client of clients) client.provider.destroy();
  clients.length = 0;
  await sleep(150); // let server-side close events flush rooms
  await server.idle();
  await pool.query('DELETE FROM diagrams');
});

// ---------- tests ----------

describe('collab-server transport (PR 5)', () => {
  it('suite loads with a running server and api (5.1)', async () => {
    expect(server.port).toBeGreaterThan(0);
    expect(apiPort).toBeDefined();
  });

  it('live second client sees a committed change within 2s (realtime:R1)', async () => {
    const diagram = makeDiagram();
    await insertDiagramRow(diagram);
    const alice = connectClient(diagram.id, 'Alice');
    await alice.synced;
    const bob = connectClient(diagram.id, 'Bob');
    await bob.synced;

    classMap(alice, diagram.classes[0].id).set('name', 'Customer');

    await waitFor(
      () => diagramOf(bob).classes.some((c) => c.name === 'Customer'),
      'bob sees renamed class',
    );
  }, 15_000);

  it('late joiner receives the full current model (realtime:R1)', async () => {
    const diagram = makeDiagram();
    await insertDiagramRow(diagram);
    const alice = connectClient(diagram.id, 'Alice');
    await alice.synced;

    classMap(alice, diagram.classes[0].id).set('name', 'Customer');
    await waitFor(
      () => diagramOf(alice).classes.some((c) => c.name === 'Customer'),
      'alice applied rename locally',
    );

    // Bob joins AFTER the edit: the room must hand him the complete model.
    const bob = connectClient(diagram.id, 'Bob');
    await bob.synced;
    await waitFor(
      () => diagramOf(bob).classes.some((c) => c.name === 'Customer'),
      'late joiner sees full model',
    );
    expect(diagramOf(bob).classes).toHaveLength(2);
    expect(diagramOf(bob).associations).toHaveLength(1);
  }, 15_000);

  it('debounced persistence writes doc + yjs_state + version in one shot (5.2)', async () => {
    const diagram = makeDiagram();
    await insertDiagramRow(diagram);
    const alice = connectClient(diagram.id, 'Alice');
    await alice.synced;

    classMap(alice, diagram.classes[0].id).set('name', 'Customer');
    await server.waitUntilScheduled();
    await server.idle();

    const { rows } = await pool.query(
      'SELECT version, doc, yjs_state FROM diagrams WHERE id = $1',
      [diagram.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].version).toBe(2); // 1 (created) -> 2 (collab write)

    const storedDoc = rows[0].doc as Diagram;
    expect(storedDoc.classes.some((c) => c.name === 'Customer')).toBe(true);

    // Blob decodes and projects to the same content (single source of truth).
    const blobDoc = projectYDocToDiagram(loadYDocFromUpdate(new Uint8Array(rows[0].yjs_state)));
    expect(blobDoc.classes.some((c) => c.name === 'Customer')).toBe(true);
  }, 15_000);

  it('room survives a server restart from the blob; read-only open does not bump version (5.2)', async () => {
    const diagram = makeDiagram();
    await insertDiagramRow(diagram);
    const alice = connectClient(diagram.id, 'Alice');
    await alice.synced;

    const yPosition = classMap(alice, diagram.classes[0].id).get('position') as Y.Map<unknown>;
    yPosition.set('x', 999);
    yPosition.set('y', 888);
    await server.waitUntilScheduled();
    await server.idle();

    const { rows: before } = await pool.query('SELECT version FROM diagrams WHERE id = $1', [diagram.id]);
    expect(before[0].version).toBe(2);

    await server.close();
    server = await startCollabServer({ port: 0, databaseUrl: DATABASE_URL });

    const bob = connectClient(diagram.id, 'Bob');
    await bob.synced;
    await waitFor(
      () => diagramOf(bob).classes.some((c) => c.position.x === 999 && c.position.y === 888),
      'position survived restart',
    );

    await server.idle();
    const { rows: after } = await pool.query('SELECT version FROM diagrams WHERE id = $1', [diagram.id]);
    expect(after[0].version).toBe(2); // opening a room must NOT bump the version
  }, 25_000);

  it('presence appears on join and clears on leave (realtime:R2)', async () => {
    const diagram = makeDiagram();
    await insertDiagramRow(diagram);
    const alice = connectClient(diagram.id, 'Alice');
    await alice.synced;
    const bob = connectClient(diagram.id, 'Bob');
    await bob.synced;

    await waitFor(
      () => JSON.stringify(presenceNames(bob.provider)) === JSON.stringify(['Alice', 'Bob']),
      'bob sees both users',
    );

    alice.provider.destroy();
    await waitFor(
      () => JSON.stringify(presenceNames(bob.provider)) === JSON.stringify(['Bob']),
      'alice presence cleared after leave',
    );
  }, 15_000);

  it('concurrent same-attribute edits converge schema-valid (realtime:R3)', async () => {
    const diagram = makeDiagram();
    await insertDiagramRow(diagram);
    const alice = connectClient(diagram.id, 'Alice');
    const bob = connectClient(diagram.id, 'Bob');
    await alice.synced;
    await bob.synced;

    // Both rename the SAME class name field at the same time.
    classMap(alice, diagram.classes[0].id).set('name', 'AlphaX');
    classMap(bob, diagram.classes[0].id).set('name', 'BetaY');

    await waitFor(
      () => JSON.stringify(diagramOf(alice)) === JSON.stringify(diagramOf(bob)),
      'docs converge',
    );
    const parsed = DiagramSchema.safeParse(diagramOf(alice));
    expect(parsed.success).toBe(true);
    const winner = diagramOf(alice).classes.find((c) => c.id === diagram.classes[0].id);
    expect(['AlphaX', 'BetaY']).toContain(winner?.name);
  }, 15_000);

  it('concurrent edits to different classes both survive (realtime:R3)', async () => {
    const diagram = makeDiagram();
    await insertDiagramRow(diagram);
    const alice = connectClient(diagram.id, 'Alice');
    const bob = connectClient(diagram.id, 'Bob');
    await alice.synced;
    await bob.synced;

    classMap(alice, diagram.classes[0].id).set('name', 'AAA');
    classMap(bob, diagram.classes[1].id).set('name', 'BBB');

    await waitFor(
      () => JSON.stringify(diagramOf(alice)) === JSON.stringify(diagramOf(bob)),
      'docs converge',
    );
    const names = diagramOf(alice).classes.map((c) => c.name);
    expect(names).toContain('AAA');
    expect(names).toContain('BBB');
  }, 15_000);

  it('reconnect after a 10s drop converges to the persisted state (realtime:R4)', async () => {
    const diagram = makeDiagram();
    await insertDiagramRow(diagram);
    const alice = connectClient(diagram.id, 'Alice');
    await alice.synced;

    classMap(alice, diagram.classes[0].id).set('name', 'Persisted');
    await server.idle();

    alice.provider.destroy();
    await sleep(10_000); // spec: transient 10s drop

    const reconnected = connectClient(diagram.id, 'Alice2');
    await reconnected.synced;
    await waitFor(
      () => diagramOf(reconnected).classes.some((c) => c.name === 'Persisted'),
      'state survived the drop',
    );
  }, 30_000);

  it('9.7 adornments + ranged multiplicity survive collab and converge schema-valid (realtime:R3, editor:R5)', async () => {
    const diagram = makeDiagram();
    await insertDiagramRow(diagram);
    const alice = connectClient(diagram.id, 'Alice');
    const bob = connectClient(diagram.id, 'Bob');
    await alice.synced;
    await bob.synced;

    // Alice edits member adornments; Bob edits the association multiplicity.
    const yAttr = classMap(alice, diagram.classes[0].id)
      .get('attributes') as Y.Array<Y.Map<unknown>>;
    const attr0 = yAttr.get(0);
    if (!(attr0 instanceof Y.Map)) throw new Error('attribute 0 not found');
    attr0.set('visibility', '-');
    attr0.set('isStatic', true);
    attr0.set('isDerived', true);
    attr0.set('multiplicity', '1..4');

    const yAssoc = alice.ydoc.getMap('associations').get(diagram.associations[0].id);
    if (!(yAssoc instanceof Y.Map)) throw new Error('association not found');
    yAssoc.set('sourceMultiplicity', '3..7');

    await waitFor(
      () => JSON.stringify(diagramOf(alice)) === JSON.stringify(diagramOf(bob)),
      'docs converge',
    );
    const parsed = DiagramSchema.safeParse(diagramOf(alice));
    expect(parsed.success).toBe(true);

    // Both sides see every Unit 9 field after convergence.
    const bobAttr0 = (classMap(bob, diagram.classes[0].id)
      .get('attributes') as Y.Array<Y.Map<unknown>>).get(0);
    expect(bobAttr0).toBeInstanceOf(Y.Map);
    expect(bobAttr0.get('visibility')).toBe('-');
    expect(bobAttr0.get('isStatic')).toBe(true);
    expect(bobAttr0.get('isDerived')).toBe(true);
    expect(bobAttr0.get('multiplicity')).toBe('1..4');
    const bobAssoc = bob.ydoc.getMap('associations').get(diagram.associations[0].id) as Y.Map<unknown>;
    expect(bobAssoc.get('sourceMultiplicity')).toBe('3..7');
  }, 15_000);

  it('11.6 generalization edges survive collab and converge schema-valid (realtime:R3, editor:R5)', async () => {
    const diagram = makeDiagram();
    await insertDiagramRow(diagram);
    const alice = connectClient(diagram.id, 'Alice');
    const bob = connectClient(diagram.id, 'Bob');
    await alice.synced;
    await bob.synced;

    // Alice adds a generalization edge (Product role: Order → User) to her doc.
    const genId = uuidv7();
    const yGen = new Y.Map();
    yGen.set('id', genId);
    yGen.set('subClassId', diagram.classes[1]!.id);
    yGen.set('superClassId', diagram.classes[0]!.id);
    alice.ydoc.getMap('generalizations').set(genId, yGen);

    await waitFor(
      () => JSON.stringify(diagramOf(alice)) === JSON.stringify(diagramOf(bob)),
      'generalization converges',
    );
    const parsed = DiagramSchema.safeParse(diagramOf(alice));
    expect(parsed.success).toBe(true);

    // Bob sees the edge with both endpoints intact.
    const bobGens = diagramOf(bob).generalizations;
    expect(bobGens).toHaveLength(1);
    expect(bobGens[0]).toMatchObject({
      id: genId,
      subClassId: diagram.classes[1]!.id,
      superClassId: diagram.classes[0]!.id,
    });
  }, 15_000);

  it('12.6 kind/isAbstract + realization edges survive collab and converge schema-valid (realtime:R3, editor:R5)', async () => {
    const diagram = makeDiagram();
    await insertDiagramRow(diagram);
    const alice = connectClient(diagram.id, 'Alice');
    const bob = connectClient(diagram.id, 'Bob');
    await alice.synced;
    await bob.synced;

    // Alice promotes Order to interface, marks User abstract, and adds a realization.
    classMap(alice, diagram.classes[1]!.id).set('kind', 'interface');
    classMap(alice, diagram.classes[0]!.id).set('isAbstract', true);

    const realId = uuidv7();
    const yReal = new Y.Map();
    yReal.set('id', realId);
    yReal.set('clientClassId', diagram.classes[0]!.id);
    yReal.set('supplierInterfaceId', diagram.classes[1]!.id);
    alice.ydoc.getMap('realizations').set(realId, yReal);

    await waitFor(
      () => JSON.stringify(diagramOf(alice)) === JSON.stringify(diagramOf(bob)),
      'realization converges',
    );
    const parsed = DiagramSchema.safeParse(diagramOf(alice));
    expect(parsed.success).toBe(true);

    // Bob sees the classifier kind, the abstract flag and the edge.
    const bobDiagram = diagramOf(bob);
    expect(bobDiagram.classes.find((c) => c.id === diagram.classes[1]!.id)!.kind).toBe('interface');
    expect(bobDiagram.classes.find((c) => c.id === diagram.classes[0]!.id)!.isAbstract).toBe(true);
    expect(bobDiagram.realizations).toHaveLength(1);
    expect(bobDiagram.realizations[0]).toMatchObject({
      id: realId,
      clientClassId: diagram.classes[0]!.id,
      supplierInterfaceId: diagram.classes[1]!.id,
    });
  }, 15_000);

  it('12.6 dependency edges survive collab and converge schema-valid (realtime:R3, editor:R5 — 12b half)', async () => {
    const diagram = makeDiagram();
    await insertDiagramRow(diagram);
    const alice = connectClient(diagram.id, 'Alice');
    const bob = connectClient(diagram.id, 'Bob');
    await alice.synced;
    await bob.synced;

    // Alice adds a dependency edge (User → Order, both plain classes) to her doc.
    const depId = uuidv7();
    const yDep = new Y.Map();
    yDep.set('id', depId);
    yDep.set('clientClassId', diagram.classes[0]!.id);
    yDep.set('supplierClassId', diagram.classes[1]!.id);
    alice.ydoc.getMap('dependencies').set(depId, yDep);

    await waitFor(
      () => JSON.stringify(diagramOf(alice)) === JSON.stringify(diagramOf(bob)),
      'dependency converges',
    );
    const parsed = DiagramSchema.safeParse(diagramOf(alice));
    expect(parsed.success).toBe(true);

    // Bob sees the edge with both endpoints intact.
    const bobDeps = diagramOf(bob).dependencies;
    expect(bobDeps).toHaveLength(1);
    expect(bobDeps[0]).toMatchObject({
      id: depId,
      clientClassId: diagram.classes[0]!.id,
      supplierClassId: diagram.classes[1]!.id,
    });
  }, 15_000);

  it('13.5 n-ary associations survive collab and converge schema-valid; binary associations untouched (realtime:R3, editor:R5)', async () => {
    // Three classes + one BINARY association: the n-ary must never touch it.
    const classA = { id: uuidv7(), name: 'Supplier', position: { x: 0, y: 0 }, attributes: [], methods: [] };
    const classB = { id: uuidv7(), name: 'Part', position: { x: 300, y: 0 }, attributes: [], methods: [] };
    const classC = { id: uuidv7(), name: 'Project', position: { x: 150, y: 300 }, attributes: [], methods: [] };
    const binaryId = uuidv7();
    const diagram = DiagramSchema.parse({
      id: uuidv7(),
      name: 'Nary Collab',
      classes: [classA, classB, classC],
      associations: [
        {
          id: binaryId,
          sourceClassId: classA.id,
          targetClassId: classB.id,
          sourceMultiplicity: '1',
          targetMultiplicity: '0..*',
          directed: true,
        },
      ],
    });
    await insertDiagramRow(diagram);
    const alice = connectClient(diagram.id, 'Alice');
    const bob = connectClient(diagram.id, 'Bob');
    await alice.synced;
    await bob.synced;

    // Alice adds a ternary association (central diamond) over the three classes.
    const naryId = uuidv7();
    const yNary = new Y.Map();
    yNary.set('id', naryId);
    yNary.set('name', 'supply');
    const yEnds = new Y.Array();
    const ends: readonly [string, string, string | null][] = [
      [classA.id, '1', 'supplier'],
      [classB.id, '0..*', null],
      [classC.id, '*', null],
    ];
    for (const [classId, multiplicity, role] of ends) {
      const yEnd = new Y.Map();
      yEnd.set('classId', classId);
      yEnd.set('multiplicity', multiplicity);
      if (role !== null) yEnd.set('role', role);
      yEnds.push([yEnd]);
    }
    yNary.set('memberEnds', yEnds);
    alice.ydoc.getMap('naryAssociations').set(naryId, yNary);

    await waitFor(
      () => JSON.stringify(diagramOf(alice)) === JSON.stringify(diagramOf(bob)),
      'n-ary converges',
    );
    const parsed = DiagramSchema.safeParse(diagramOf(alice));
    expect(parsed.success).toBe(true);

    // Bob sees the n-ary with all three ends, multiplicities and the role.
    const bobNary = diagramOf(bob).naryAssociations;
    expect(bobNary).toHaveLength(1);
    expect(bobNary[0]!.id).toBe(naryId);
    expect(bobNary[0]!.name).toBe('supply');
    expect(bobNary[0]!.memberEnds).toEqual([
      { classId: classA.id, multiplicity: '1', role: 'supplier' },
      { classId: classB.id, multiplicity: '0..*' },
      { classId: classC.id, multiplicity: '*' },
    ]);

    // The binary association survived the n-ary round completely untouched.
    expect(diagramOf(bob).associations).toHaveLength(1);
    expect(diagramOf(bob).associations[0]!.id).toBe(binaryId);
    expect(diagramOf(bob).associations[0]!.sourceClassId).toBe(classA.id);
  }, 15_000);

  it('API PUT and collab debounce do not corrupt each other (5.2, two writers)', async () => {
    const diagram = makeDiagram();
    await insertDiagramRow(diagram);
    const alice = connectClient(diagram.id, 'Alice');
    await alice.synced;

    // Collab edit -> debounced write bumps version 1 -> 2.
    classMap(alice, diagram.classes[1].id).set('name', 'RenamedByCollab');
    await server.waitUntilScheduled();
    await server.idle();

    // API PUT with a stale version must 409...
    const apiDiagramP2 = DiagramSchema.parse({
      ...diagram,
      classes: diagram.classes.map((c) => (c.id === diagram.classes[0].id ? { ...c, name: 'RenamedByApi' } : c)),
    });
    const stale = await fetch(`http://127.0.0.1:${apiPort}/diagrams/${diagram.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ diagram: apiDiagramP2, version: 1 }),
    });
    expect(stale.status).toBe(409);

    // ...and with the current version must succeed.
    const fresh = await fetch(`http://127.0.0.1:${apiPort}/diagrams/${diagram.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ diagram: apiDiagramP2, version: 2 }),
    });
    expect(fresh.status).toBe(200);
    const putBody = (await fresh.json()) as { version: number; diagram: Diagram };
    expect(putBody.version).toBe(3);

    const get = await fetch(`http://127.0.0.1:${apiPort}/diagrams/${diagram.id}`);
    const getBody = (await get.json()) as { diagram: Diagram };
    expect(getBody.diagram.classes.some((c) => c.name === 'RenamedByApi')).toBe(true);

    // The live room's in-memory state wins on its next flush (design invariant).
    alice.provider.destroy();
    await server.idle();
    const lateJoiner = connectClient(diagram.id, 'Late');
    await lateJoiner.synced;
    await waitFor(
      () => diagramOf(lateJoiner).classes.some((c) => c.name === 'RenamedByCollab'),
      'room state won after flush',
    );
  }, 20_000);

  it('smoke: api + collab-server on LAN with an accurate presence list (5.5)', async () => {
    // Create the diagram over real HTTP (LAN-shaped, not inject).
    const diagram = makeDiagram();
    const created = await fetch(`http://127.0.0.1:${apiPort}/diagrams`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Smoke Diagram', diagram }),
    });
    expect(created.status).toBe(201);
    const body = (await created.json()) as { id: string };

    const alice = connectClient(body.id, 'Alice');
    await alice.synced;
    const bob = connectClient(body.id, 'Bob');
    await bob.synced;

    await waitFor(
      () => JSON.stringify(presenceNames(alice.provider)) === JSON.stringify(['Alice', 'Bob']),
      'alice sees exactly Alice and Bob',
    );

    const carol = connectClient(body.id, 'Carol');
    await carol.synced;

    // Late joiner gets the full model...
    await waitFor(
      () => diagramOf(carol).classes.length === 2 && diagramOf(carol).associations.length === 1,
      'carol receives full model',
    );
    // ...and the presence list is exactly the three connected users, no ghosts.
    await waitFor(
      () => JSON.stringify(presenceNames(bob.provider)) === JSON.stringify(['Alice', 'Bob', 'Carol']),
      'presence list is accurate',
    );
  }, 20_000);
});
