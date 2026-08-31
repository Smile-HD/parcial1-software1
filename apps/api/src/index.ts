/**
 * @app/api — Fastify REST API for diagram persistence.
 * POST /diagrams, GET /diagrams/:id, PUT /diagrams/:id
 * PostgreSQL 16 via pg Pool, uuidv7 IDs, optimistic concurrency (version).
 */

import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { Pool } from 'pg';
import { v7 as uuidv7 } from 'uuid';
import * as Y from 'yjs';
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
import { pathToFileURL } from 'node:url';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5433/ai_uml';

const pool = new Pool({ connectionString: DATABASE_URL, max: 10 });

/** Test/bootstrap hook: closes the module-scoped pool. */
export async function closePool(): Promise<void> {
  await pool.end();
}

// Request/Response schemas.
// `yjsState` (base64 Yjs update) is the authoritative persisted state: clients
// connected to the collab server share the blob's Yjs clocks, so the API must
// store the client's own blob instead of rebuilding one from the JSON
// projection (a rebuilt blob resets clocks and CRDT-merging it against live
// client docs duplicates Y.Array members). See work unit 6b / design D4.
// NOTE: declared as plain strings — Fastify's AjV does not know the `base64`
// format; base64 correctness is enforced in preparePersistence (400 on junk).
const CreateDiagramBodySchema = z.object({
  name: z.string().min(1),
  diagram: DiagramSchema,
  yjsState: z.string().min(1).optional(),
}).strict();

const UpdateDiagramBodySchema = z.object({
  name: z.string().min(1).optional(),
  diagram: DiagramSchema,
  version: z.number().int().positive(),
  yjsState: z.string().min(1).optional(),
}).strict();

const DiagramResponseSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  diagram: DiagramSchema,
  yjsState: z.string(),
  version: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const ErrorResponseSchema = z.object({ error: z.string() });
const ConflictResponseSchema = z.object({ error: z.string(), currentVersion: z.number() });

// Fastify's AjV compiler needs plain JSON Schema — Zod objects cannot be passed
// directly. Convert once at module load; handlers still parse via the Zod schemas.
// target 'draft-7': Fastify's default AjV instance does not register the 2020-12 dialect.
const CreateDiagramBodyJsonSchema = z.toJSONSchema(CreateDiagramBodySchema, { target: 'draft-7' });
const UpdateDiagramBodyJsonSchema = z.toJSONSchema(UpdateDiagramBodySchema, { target: 'draft-7' });
const DiagramResponseJsonSchema = z.toJSONSchema(DiagramResponseSchema, { target: 'draft-7' });
const ErrorResponseJsonSchema = z.toJSONSchema(ErrorResponseSchema, { target: 'draft-7' });
const ConflictResponseJsonSchema = z.toJSONSchema(ConflictResponseSchema, { target: 'draft-7' });

// Helper: map DB row to response
function mapRowToResponse(row: {
  id: string;
  name: string;
  doc: Diagram;
  yjs_state: Buffer;
  version: number;
  created_at: Date;
  updated_at: Date;
}) {
  return {
    id: row.id,
    name: row.name,
    diagram: row.doc,
    yjsState: row.yjs_state.toString('base64'),
    version: row.version,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

// Build persistence state for a diagram. When the client supplies its own
// Yjs blob (collab-connected clients do), the blob is authoritative: decode,
// validate its projection and persist it AS IS so every connected client's
// clocks keep converging (work unit 6b). Without a blob, rebuild one from the
// validated JSON projection (legacy/API-only callers).
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

function preparePersistence(
  diagram: Diagram,
  yjsStateBase64?: string,
): { doc: Diagram; yjsState: Buffer; version: number } {
  if (yjsStateBase64 !== undefined) {
    let update: Uint8Array;
    try {
      if (!BASE64_PATTERN.test(yjsStateBase64)) {
        throw new Error('not base64');
      }
      update = new Uint8Array(Buffer.from(yjsStateBase64, 'base64'));
      const decoded = validateYDocProjection(loadYDocFromUpdate(update));
      if (!decoded.ok) {
        throw new Error('projection failed schema validation');
      }
      return { doc: decoded.diagram, yjsState: Buffer.from(update), version: 1 };
    } catch (error) {
      const reason = error instanceof Error && error.message !== 'not base64' ? error.message : 'cannot decode Y.Doc';
      throw new Error(`Invalid yjsState blob: ${reason}`);
    }
  }

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

/** Builds the Fastify app (routes registered, not listening). Exported for smoke tests. */
export function buildApp(options?: { logger?: boolean }): FastifyInstance {
  const app = Fastify({ logger: options?.logger ?? true });

  // CORS — the web editor (apps/web) is a separate origin in dev (Vite :5173)
  // and calls this API cross-origin; without these headers every browser
  // fetch is blocked. `origin: true` reflects the request origin (dev/LAN
  // posture — mobile client in unit 14 needs LAN origins too). `methods`
  // must include PUT explicitly: @fastify/cors defaults to GET,HEAD,POST,
  // which silently blocks every save (editor:R5). Tighten to an explicit
  // allow-list of origins when a production deployment is requested.
  void app.register(cors, { origin: true, methods: ['GET', 'HEAD', 'POST', 'PUT'] });

  // Health check
  app.get('/health', async () => ({ status: 'ok' }));

  // POST /diagrams — create new diagram
  app.post<{ Body: z.infer<typeof CreateDiagramBodySchema> }>(
    '/diagrams',
    { schema: { body: CreateDiagramBodyJsonSchema, response: { 201: DiagramResponseJsonSchema } } },
    async (request, reply) => {
      const { name, diagram: diagramData } = request.body;

      // Validate diagram ID matches body (or generate if missing)
      const diagramId = diagramData.id ?? uuidv7();
      const validatedDiagram = DiagramSchema.parse({ ...diagramData, id: diagramId });

      let persisted: { doc: Diagram; yjsState: Buffer; version: number };
      try {
        persisted = preparePersistence(validatedDiagram, request.body.yjsState);
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('Invalid yjsState')) {
          return reply.status(400).send({ error: error.message });
        }
        throw error;
      }
      const { doc, yjsState, version } = persisted;

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
          yjs_state: row.yjs_state,
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
    { schema: { body: UpdateDiagramBodyJsonSchema, response: { 200: DiagramResponseJsonSchema, 404: ErrorResponseJsonSchema, 409: ConflictResponseJsonSchema } } },
    async (request, reply) => {
      const { id } = request.params;
      const { name, diagram: diagramData, version: expectedVersion } = request.body;

      // Validate diagram ID matches URL
      const validatedDiagram = DiagramSchema.parse({ ...diagramData, id });

      let persisted: { doc: Diagram; yjsState: Buffer; version: number };
      try {
        persisted = preparePersistence(validatedDiagram, request.body.yjsState);
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('Invalid yjsState')) {
          return reply.status(400).send({ error: error.message });
        }
        throw error;
      }
      const { doc, yjsState } = persisted;

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

  return app;
}

async function startServer() {
  const app = buildApp();

  // Graceful shutdown
  const shutdown = async () => {
    console.log('Shutting down...');
    await app.close();
    await closePool();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  const port = Number(process.env.PORT) || 3000;
  await app.listen({ port, host: '0.0.0.0' });
  console.log(`API server listening on http://0.0.0.0:${port}`);
}

const isDirectRun = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  startServer().catch(err => {
    console.error('Failed to start server:', err);
    process.exit(1);
  });
}
