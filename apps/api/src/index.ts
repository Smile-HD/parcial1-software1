/**
 * @app/api — Fastify REST API for diagram persistence.
 * POST /diagrams, GET /diagrams/:id, PUT /diagrams/:id
 * PostgreSQL 16 via pg Pool, uuidv7 IDs, optimistic concurrency (version).
 */

import Fastify from 'fastify';
import { Pool } from 'pg';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import {
  type Diagram,
  DiagramSchema,
  buildYDocFromDiagram,
  projectYDocToDiagram,
  encodeYDoc,
  loadYDocFromUpdate,
  validateYDocProjection,
} from '@app/core';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5433/ai_uml';

const pool = new Pool({ connectionString: DATABASE_URL, max: 10 });

// Request/Response schemas
const CreateDiagramBodySchema = z.object({
  name: z.string().min(1),
  diagram: DiagramSchema,
}).strict();

const UpdateDiagramBodySchema = z.object({
  name: z.string().min(1).optional(),
  diagram: DiagramSchema,
  version: z.number().int().positive(),
}).strict();

const DiagramResponseSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  diagram: DiagramSchema,
  version: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

// Helper: map DB row to response
function mapRowToResponse(row: {
  id: string;
  name: string;
  doc: Diagram;
  version: number;
  created_at: Date;
  updated_at: Date;
}) {
  return {
    id: row.id,
    name: row.name,
    diagram: row.doc,
    version: row.version,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

// Build Y.Doc from validated diagram, encode to blob, return both
function preparePersistence(diagram: Diagram): { doc: Diagram; yjsState: Buffer; version: number } {
  const yDoc = buildYDocFromDiagram(diagram);
  const update = encodeYDoc(yDoc);
  const yjsState = Buffer.from(update);
  // Validate projection round-trip
  const validation = validateYDocProjection(yDoc);
  if (!validation.ok) {
    throw new Error('Y.Doc projection validation failed after build');
  }
  // Use the validated projection as the stored doc (ensures consistency)
  return { doc: validation.diagram, yjsState, version: 1 };
}

// Load diagram from DB row, with self-healing
async function loadDiagramFromRow(row: {
  id: string;
  name: string;
  doc: unknown;
  yjs_state: Buffer;
  version: number;
}): Promise<{ diagram: Diagram; yjsState: Buffer; version: number }> {
  // Try to load Y.Doc from blob (authoritative)
  let yDoc: Y.Doc;
  try {
    yDoc = loadYDocFromUpdate(new Uint8Array(row.yjs_state));
  } catch {
    throw new Error('Corrupt yjs_state blob: cannot decode Y.Doc');
  }

  // Validate projection from blob
  const validation = validateYDocProjection(yDoc);
  if (validation.ok) {
    // Blob is good, return blob-derived diagram
    return { diagram: validation.diagram, yjsState: row.yjs_state, version: row.version };
  }

  // Blob projection failed Zod validation — try stored doc as fallback
  try {
    const storedDoc = DiagramSchema.parse(row.doc);
    // Rebuild Y.Doc from stored doc and verify it encodes to same blob
    const rebuiltYDoc = buildYDocFromDiagram(storedDoc);
    const rebuiltUpdate = encodeYDoc(rebuiltYDoc);
    if (Buffer.compare(Buffer.from(rebuiltUpdate), row.yjs_state) !== 0) {
      // Blob and doc diverge — blob is authoritative per design, but it's corrupt
      throw new Error('yjs_state blob corrupt and does not match stored doc');
    }
    // Self-heal: doc was valid, blob encodes correctly but projection failed (shouldn't happen)
    // Return doc-derived diagram
    return { diagram: storedDoc, yjsState: row.yjs_state, version: row.version };
  } catch {
    // Both blob and doc are invalid — explicit load error per editor:R5
    throw new Error('Diagram load failed: corrupt yjs_state blob and invalid stored doc');
  }
}

async function startServer() {
  const app = Fastify({ logger: true });

  // Health check
  app.get('/health', async () => ({ status: 'ok' }));

  // POST /diagrams — create new diagram
  app.post<{ Body: z.infer<typeof CreateDiagramBodySchema> }>(
    '/diagrams',
    { schema: { body: CreateDiagramBodySchema, response: { 201: DiagramResponseSchema } } },
    async (request, reply) => {
      const { name, diagram: diagramData } = request.body;

      // Validate diagram ID matches body (or generate if missing)
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

  // GET /diagrams/:id — load diagram with self-healing
  app.get<{ Params: { id: string } }>(
    '/diagrams/:id',
    { schema: { response: { 200: DiagramResponseSchema, 404: z.object({ error: z.string() }) } } },
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
        // Explicit load error, no partial diagram (editor:R5)
        return reply.status(500).send({ error: error instanceof Error ? error.message : 'Diagram load failed' });
      }
    }
  );

  // PUT /diagrams/:id — update with optimistic concurrency
  app.put<{ Params: { id: string }; Body: z.infer<typeof UpdateDiagramBodySchema> }>(
    '/diagrams/:id',
    { schema: { body: UpdateDiagramBodySchema, response: { 200: DiagramResponseSchema, 404: z.object({ error: z.string() }), 409: z.object({ error: z.string(), currentVersion: z.number() }) } } },
    async (request, reply) => {
      const { id } = request.params;
      const { name, diagram: diagramData, version: expectedVersion } = request.body;

      // Validate diagram ID matches URL
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
          // Check if diagram exists (to distinguish 404 from 409)
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

  // Graceful shutdown
  const shutdown = async () => {
    console.log('Shutting down...');
    await app.close();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  const port = Number(process.env.PORT) || 3000;
  await app.listen({ port, host: '0.0.0.0' });
  console.log(`API server listening on http://0.0.0.0:${port}`);
}

// Yjs namespace for type reference
import * as Y from 'yjs';

startServer().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});