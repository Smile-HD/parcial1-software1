import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify from 'fastify';
import { Pool } from 'pg';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import {
  DiagramSchema,
  type Diagram,
  buildYDocFromDiagram,
  encodeYDoc,
  loadYDocFromUpdate,
  validateYDocProjection,
} from '@app/core';
import * as Y from 'yjs';

// Test database setup
const TEST_DATABASE_URL = 'postgres://postgres:postgres@localhost:5433/ai_uml';
const pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 5 });

let app: Awaited<ReturnType<typeof Fastify>>;

// JSON Schema for Fastify (converted from Zod)
const DiagramJsonSchema = z.toJSONSchema(DiagramSchema, { target: 'jsonSchema-2020-12', $refStrategy: 'none' });

const CreateDiagramBodyJsonSchema = {
  type: 'object',
  required: ['name', 'diagram'],
  properties: {
    name: { type: 'string', minLength: 1 },
    diagram: DiagramJsonSchema,
  },
  additionalProperties: false,
} as const;

const UpdateDiagramBodyJsonSchema = {
  type: 'object',
  required: ['diagram', 'version'],
  properties: {
    name: { type: 'string', minLength: 1 },
    diagram: DiagramJsonSchema,
    version: { type: 'integer', minimum: 1 },
  },
  additionalProperties: false,
} as const;

const DiagramResponseJsonSchema = {
  type: 'object',
  required: ['id', 'name', 'diagram', 'version', 'createdAt', 'updatedAt'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    name: { type: 'string' },
    diagram: DiagramJsonSchema,
    version: { type: 'integer' },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
} as const;

const ErrorResponseJsonSchema = {
  type: 'object',
  required: ['error'],
  properties: {
    error: { type: 'string' },
  },
} as const;

const ConflictResponseJsonSchema = {
  type: 'object',
  required: ['error', 'currentVersion'],
  properties: {
    error: { type: 'string' },
    currentVersion: { type: 'integer' },
  },
} as const;

async function createTestApp() {
  const fastify = Fastify({ logger: false });
  
  // Health check
  fastify.get('/health', async () => ({ status: 'ok' }));

  function mapRowToResponse(row: any) {
    return {
      id: row.id,
      name: row.name,
      diagram: row.doc,
      version: row.version,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    };
  }

  function preparePersistence(diagram: Diagram) {
    const yDoc = buildYDocFromDiagram(diagram);
    const update = encodeYDoc(yDoc);
    const yjsState = Buffer.from(update);
    const validation = validateYDocProjection(yDoc);
    if (!validation.ok) {
      throw new Error('Y.Doc projection validation failed after build');
    }
    return { doc: validation.diagram, yjsState, version: 1 };
  }

  async function loadDiagramFromRow(row: any) {
    let yDoc: Y.Doc;
    try {
      yDoc = loadYDocFromUpdate(new Uint8Array(row.yjs_state));
    } catch {
      throw new Error('Corrupt yjs_state blob: cannot decode Y.Doc');
    }

    const validation = validateYDocProjection(yDoc);
    if (validation.ok) {
      return { diagram: validation.diagram, yjsState: row.yjs_state, version: row.version };
    }

    try {
      const storedDoc = DiagramSchema.parse(row.doc);
      const rebuiltYDoc = buildYDocFromDiagram(storedDoc);
      const rebuiltUpdate = encodeYDoc(rebuiltYDoc);
      if (Buffer.compare(Buffer.from(rebuiltUpdate), row.yjs_state) !== 0) {
        throw new Error('yjs_state blob corrupt and does not match stored doc');
      }
      return { diagram: storedDoc, yjsState: row.yjs_state, version: row.version };
    } catch {
      throw new Error('Diagram load failed: corrupt yjs_state blob and invalid stored doc');
    }
  }

  // POST /diagrams
  fastify.post<{ Body: any }>(
    '/diagrams',
    { schema: { body: CreateDiagramBodyJsonSchema, response: { 201: DiagramResponseJsonSchema } } },
    async (request, reply) => {
      const { name, diagram: diagramData } = request.body;
      const diagramId = diagramData.id ?? uuidv7();
      const validatedDiagram = DiagramSchema.parse({ ...diagramData, id: diagramId });

      const { doc, yjsState, version } = preparePersistence(validatedDiagram);

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await client.query(
          `INSERT INTO diagrams (id, name, doc, yjs_state, version)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id, name, doc, yjs_state, version, created_at, updated_at`,
          [diagramId, name, JSON.stringify(doc), yjsState, version]
        );
        await client.query('COMMIT');

        const row = result.rows[0];
        return reply.status(201).send(mapRowToResponse({
          ...row,
          doc: row.doc,
          yjs_state: row.yjs_state,
        }));
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    }
  );

  // GET /diagrams/:id
  fastify.get<{ Params: { id: string } }>(
    '/diagrams/:id',
    { schema: { response: { 200: DiagramResponseJsonSchema, 404: ErrorResponseJsonSchema } } },
    async (request, reply) => {
      const { id } = request.params;

      const result = await pool.query(
        'SELECT id, name, doc, yjs_state, version, created_at, updated_at FROM diagrams WHERE id = $1',
        [id]
      );

      if (result.rows.length === 0) {
        return reply.status(404).send({ error: 'Diagram not found' });
      }

      const row = result.rows[0];

      try {
        const { diagram, version } = await loadDiagramFromRow({
          id: row.id,
          name: row.name,
          doc: row.doc,
          yjs_state: row.yjs_state,
          version: row.version,
        });

        return reply.send(mapRowToResponse({
          id: row.id,
          name: row.name,
          doc: diagram,
          version,
          created_at: row.created_at,
          updated_at: row.updated_at,
        }));
      } catch (error) {
        return reply.status(500).send({ error: error instanceof Error ? error.message : 'Diagram load failed' });
      }
    }
  );

  // PUT /diagrams/:id
  fastify.put<{ Params: { id: string }; Body: any }>(
    '/diagrams/:id',
    { schema: { body: UpdateDiagramBodyJsonSchema, response: { 200: DiagramResponseJsonSchema, 404: ErrorResponseJsonSchema, 409: ConflictResponseJsonSchema } } },
    async (request, reply) => {
      const { id } = request.params;
      const { name, diagram: diagramData, version: expectedVersion } = request.body;

      const validatedDiagram = DiagramSchema.parse({ ...diagramData, id });

      const { doc, yjsState } = preparePersistence(validatedDiagram);

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await client.query(
          `UPDATE diagrams
           SET name = COALESCE($2, name),
               doc = $3,
               yjs_state = $4,
               version = version + 1,
               updated_at = now()
           WHERE id = $1 AND version = $5
           RETURNING id, name, doc, yjs_state, version, created_at, updated_at`,
          [id, name ?? null, JSON.stringify(doc), yjsState, expectedVersion]
        );
        await client.query('COMMIT');

        if (result.rows.length === 0) {
          const check = await client.query('SELECT version FROM diagrams WHERE id = $1', [id]);
          if (check.rows.length === 0) {
            return reply.status(404).send({ error: 'Diagram not found' });
          }
          return reply.status(409).send({
            error: 'Version conflict: diagram was modified by another request',
            currentVersion: check.rows[0].version,
          });
        }

        const row = result.rows[0];
        return reply.send(mapRowToResponse({
          ...row,
          doc: row.doc,
          yjs_state: row.yjs_state,
        }));
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    }
  );

  return fastify;
}

// Test diagram factory
function createCompleteTestDiagram(): Diagram {
  const classA = { id: uuidv7(), name: 'User', position: { x: 100, y: 200 }, attributes: [{ id: uuidv7(), name: 'id', type: 'UUID' }], methods: [] };
  const classB = { id: uuidv7(), name: 'Order', position: { x: 300, y: 200 }, attributes: [{ id: uuidv7(), name: 'id', type: 'UUID' }], methods: [] };
  
  return DiagramSchema.parse({
    id: uuidv7(),
    name: 'Test Diagram',
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

beforeAll(async () => {
  app = await createTestApp();
  await app.ready();
  
  // Clean up test data
  await pool.query('DELETE FROM diagrams');
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

beforeEach(async () => {
  await pool.query('DELETE FROM diagrams');
});

describe('API: Diagram CRUD', () => {
  it('POST /diagrams creates a diagram and returns 201', async () => {
    const diagram = createCompleteTestDiagram();
    
    const response = await app.inject({
      method: 'POST',
      url: '/diagrams',
      payload: { name: 'My Diagram', diagram },
    });

    console.log('POST response:', response.statusCode, response.body);
    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body);
    expect(body.id).toBe(diagram.id);
    expect(body.name).toBe('My Diagram');
    expect(body.diagram).toEqual(diagram);
    expect(body.version).toBe(1);
    expect(body.createdAt).toBeDefined();
    expect(body.updatedAt).toBeDefined();
  });

  it('GET /diagrams/:id returns the diagram with lossless round-trip', async () => {
    const diagram = createCompleteTestDiagram();
    
    // Create
    const createResponse = await app.inject({
      method: 'POST',
      url: '/diagrams',
      payload: { name: 'My Diagram', diagram },
    });
    expect(createResponse.statusCode).toBe(201);
    
    // Get
    const getResponse = await app.inject({
      method: 'GET',
      url: `/diagrams/${diagram.id}`,
    });
    
    expect(getResponse.statusCode).toBe(200);
    const body = JSON.parse(getResponse.body);
    
    // Verify lossless round-trip: classes, attributes, methods, associations, multiplicities, positions
    expect(body.id).toBe(diagram.id);
    expect(body.name).toBe('My Diagram');
    expect(body.diagram.id).toBe(diagram.id);
    expect(body.diagram.name).toBe(diagram.name);
    expect(body.diagram.classes).toHaveLength(2);
    expect(body.diagram.associations).toHaveLength(1);
    
    // Check class details
    const userClass = body.diagram.classes.find((c: any) => c.name === 'User');
    expect(userClass).toBeDefined();
    expect(userClass.position).toEqual({ x: 100, y: 200 });
    expect(userClass.attributes).toHaveLength(1);
    expect(userClass.attributes[0].name).toBe('id');
    expect(userClass.attributes[0].type).toBe('UUID');
    
    // Check association details
    const assoc = body.diagram.associations[0];
    expect(assoc.sourceMultiplicity).toBe('1');
    expect(assoc.targetMultiplicity).toBe('0..*');
    expect(assoc.directed).toBe(true);
    
    expect(body.version).toBe(1);
  });

  it('GET /diagrams/:id returns 404 for non-existent diagram', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/diagrams/${uuidv7()}`,
    });
    
    expect(response.statusCode).toBe(404);
    const body = JSON.parse(response.body);
    expect(body.error).toBe('Diagram not found');
  });

  it('PUT /diagrams/:id updates diagram with optimistic concurrency', async () => {
    const diagram = createCompleteTestDiagram();
    
    // Create
    const createResponse = await app.inject({
      method: 'POST',
      url: '/diagrams',
      payload: { name: 'Original', diagram },
    });
    expect(createResponse.statusCode).toBe(201);
    const created = JSON.parse(createResponse.body);
    expect(created.version).toBe(1);
    
    // Update with correct version
    const updatedDiagram = DiagramSchema.parse({
      ...diagram,
      name: 'Updated Diagram',
      classes: [
        ...diagram.classes,
        { id: uuidv7(), name: 'Product', position: { x: 500, y: 200 }, attributes: [], methods: [] },
      ],
    });
    
    const updateResponse = await app.inject({
      method: 'PUT',
      url: `/diagrams/${diagram.id}`,
      payload: { name: 'Updated', diagram: updatedDiagram, version: 1 },
    });
    
    expect(updateResponse.statusCode).toBe(200);
    const updated = JSON.parse(updateResponse.body);
    expect(updated.name).toBe('Updated');
    expect(updated.version).toBe(2);
    expect(updated.diagram.classes).toHaveLength(3);
    expect(updated.diagram.classes.find((c: any) => c.name === 'Product')).toBeDefined();
  });

  it('PUT /diagrams/:id returns 409 on stale version (optimistic concurrency)', async () => {
    const diagram = createCompleteTestDiagram();
    
    // Create
    const createResponse = await app.inject({
      method: 'POST',
      url: '/diagrams',
      payload: { name: 'Original', diagram },
    });
    expect(createResponse.statusCode).toBe(201);
    
    // First update (version 1 -> 2)
    const updatedDiagram1 = DiagramSchema.parse({
      ...diagram,
      name: 'Updated Once',
    });
    const update1Response = await app.inject({
      method: 'PUT',
      url: `/diagrams/${diagram.id}`,
      payload: { name: 'Updated Once', diagram: updatedDiagram1, version: 1 },
    });
    expect(update1Response.statusCode).toBe(200);
    const updated1 = JSON.parse(update1Response.body);
    expect(updated1.version).toBe(2);
    
    // Second update with stale version (should fail with 409)
    const updatedDiagram2 = DiagramSchema.parse({
      ...diagram,
      name: 'Updated Twice',
    });
    const update2Response = await app.inject({
      method: 'PUT',
      url: `/diagrams/${diagram.id}`,
      payload: { name: 'Updated Twice', diagram: updatedDiagram2, version: 1 }, // Stale version!
    });
    
    expect(update2Response.statusCode).toBe(409);
    const error = JSON.parse(update2Response.body);
    expect(error.error).toContain('Version conflict');
    expect(error.currentVersion).toBe(2);
  });

  it('PUT /diagrams/:id returns 404 for non-existent diagram', async () => {
    const diagram = createCompleteTestDiagram();
    
    const response = await app.inject({
      method: 'PUT',
      url: `/diagrams/${uuidv7()}`,
      payload: { diagram, version: 1 },
    });
    
    expect(response.statusCode).toBe(404);
    const body = JSON.parse(response.body);
    expect(body.error).toBe('Diagram not found');
  });
});

describe('API: Corrupt blob handling (editor:R5)', () => {
  it('RED: Corrupt yjs_state blob returns explicit error, NO partial diagram', async () => {
    // First create a valid diagram
    const diagram = createCompleteTestDiagram();
    const createResponse = await app.inject({
      method: 'POST',
      url: '/diagrams',
      payload: { name: 'Valid Diagram', diagram },
    });
    expect(createResponse.statusCode).toBe(201);
    const created = JSON.parse(createResponse.body);
    
    // Corrupt the yjs_state directly in the database
    await pool.query(
      'UPDATE diagrams SET yjs_state = $1 WHERE id = $2',
      [Buffer.from('corrupted-data-that-is-not-a-valid-yjs-update'), created.id]
    );
    
    // GET should return explicit error, no partial diagram
    const getResponse = await app.inject({
      method: 'GET',
      url: `/diagrams/${created.id}`,
    });
    
    expect(getResponse.statusCode).toBe(500);
    const body = JSON.parse(getResponse.body);
    expect(body.error).toBeDefined();
    expect(body.error).toContain('Corrupt yjs_state blob');
    // Verify NO diagram data is returned (no partial output)
    expect(body.diagram).toBeUndefined();
  });

  it('RED: Self-heal path - invalid doc jsonb with valid blob succeeds', async () => {
    // Create a valid diagram
    const diagram = createCompleteTestDiagram();
    const { buildYDocFromDiagram: buildYDoc, encodeYDoc: encYDoc, projectYDocToDiagram: projYDoc } = await import('@app/core');
    const yDoc = buildYDoc(diagram);
    const yjsState = Buffer.from(encYDoc(yDoc));
    const validDoc = projYDoc(yDoc);
    
    // Insert with invalid doc (missing required fields) but valid blob
    const invalidDoc = { id: diagram.id, name: 'Corrupt', classes: [], associations: [] }; // Missing required fields
    
    await pool.query(
      `INSERT INTO diagrams (id, name, doc, yjs_state, version) VALUES ($1, $2, $3, $4, $5)`,
      [diagram.id, 'Corrupt Doc', JSON.stringify(invalidDoc), yjsState, 1]
    );
    
    // GET should self-heal from blob and succeed
    const getResponse = await app.inject({
      method: 'GET',
      url: `/diagrams/${diagram.id}`,
    });
    
    expect(getResponse.statusCode).toBe(200);
    const body = JSON.parse(getResponse.body);
    expect(body.diagram).toBeDefined();
    expect(body.diagram.name).toBe(diagram.name);
    expect(body.diagram.classes).toHaveLength(2);
    expect(body.diagram.associations).toHaveLength(1);
  });

  it('All multiplicity values round-trip correctly', async () => {
    const classA = { id: uuidv7(), name: 'A', position: { x: 0, y: 0 }, attributes: [], methods: [] };
    const classB = { id: uuidv7(), name: 'B', position: { x: 100, y: 0 }, attributes: [], methods: [] };
    const classC = { id: uuidv7(), name: 'C', position: { x: 200, y: 0 }, attributes: [], methods: [] };
    const classD = { id: uuidv7(), name: 'D', position: { x: 300, y: 0 }, attributes: [], methods: [] };
    
    const diagram = DiagramSchema.parse({
      id: uuidv7(),
      name: 'Multiplicity Test',
      classes: [classA, classB, classC, classD],
      associations: [
        { id: uuidv7(), sourceClassId: classA.id, targetClassId: classB.id, sourceMultiplicity: '1', targetMultiplicity: '1', directed: true },
        { id: uuidv7(), sourceClassId: classA.id, targetClassId: classC.id, sourceMultiplicity: '0..1', targetMultiplicity: '1..*', directed: true },
        { id: uuidv7(), sourceClassId: classA.id, targetClassId: classD.id, sourceMultiplicity: '1..*', targetMultiplicity: '0..*', directed: false },
      ],
    });
    
    const createResponse = await app.inject({
      method: 'POST',
      url: '/diagrams',
      payload: { name: 'Multiplicity Test', diagram },
    });
    expect(createResponse.statusCode).toBe(201);
    
    const getResponse = await app.inject({
      method: 'GET',
      url: `/diagrams/${diagram.id}`,
    });
    
    expect(getResponse.statusCode).toBe(200);
    const body = JSON.parse(getResponse.body);
    const mults = body.diagram.associations.map((a: any) => `${a.sourceMultiplicity}|${a.targetMultiplicity}`).sort();
    expect(mults).toEqual(['0..1|1..*', '1..*|0..*', '1|1']);
  });
});