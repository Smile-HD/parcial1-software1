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
  type LlmPort,
  type SttPort,
  type VisionPort,
  buildYDocFromDiagram,
  projectYDocToDiagram,
  encodeYDoc,
  loadYDocFromUpdate,
  validateYDocProjection,
} from '@app/core';
import { FakeLlm, OpenAiLlm, FakeStt, WhisperStt, RetryRepairingLlmPort, FakeVision, OpenAiVision } from '@app/adapters-ai';
import { LlmUnavailableError, PendingDeltaStore, interpretCommand } from './interpreter.js';
import { registerXmiImportRoutes } from './xmi-import.js';
import { registerXmiExportRoutes } from './xmi-export.js';
import { registerPhotoImportRoutes } from './photo-import.js';
import { pathToFileURL } from 'node:url';
import { generate, createHandlebarsRenderer, DEFAULT_TEMPLATES_DIR, type GeneratedFile } from '@app/codegen';
import { jobRegistry } from './jobs.js';
import * as yazl from 'yazl';

// Load apps/api/.env when present so the OpenAI-compatible provider config
// (OPENAI_API_KEY / OPENAI_BASE_URL / LLM_MODEL / WHISPER_MODEL) and
// DATABASE_URL survive restarts without shell setup. Missing file is fine —
// env vars can still come from the shell.
try {
  process.loadEnvFile();
} catch {
  // No .env in the current directory — rely on the process environment.
}

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5433/ai_uml';

const pool = new Pool({ connectionString: DATABASE_URL, max: 10 });

/** Test/bootstrap hook: closes the module-scoped pool. */
export async function closePool(): Promise<void> {
  await pool.end();
}

/** Exported for tests that need to insert corrupt rows. */
export { pool };

// Interpreter LLM wiring: an injected llm (tests) wins over env config
// (OpenAI-compatible when OPENAI_API_KEY is set), with the deterministic
// FakeLlm as the offline default so dev/demo never require network.
export interface AppOptions {
  logger?: boolean;
  llm?: LlmPort;
  stt?: SttPort;
  vision?: VisionPort;
}

export const pendingDeltas = new PendingDeltaStore();

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

/** Thrown by loadDiagramById when the diagram id has no row in the DB.
 *  Distinct from corruption errors thrown by loadDiagramFromRow so handlers
 *  can return 404 instead of 500. */
export class DiagramNotFoundError extends Error {
  override readonly name = 'DiagramNotFoundError';
  constructor(id: string) {
    super(`Diagram not found: ${id}`);
  }
}

// Helper: load diagram by id (returns row and diagram)
export async function loadDiagramById(id: string): Promise<{ row: any; diagram: Diagram; version: number }> {
  const result = await pool.query(
    'SELECT id, name, doc, yjs_state, version, created_at, updated_at FROM diagrams WHERE id = $1',
    [id]
  );
  if (result.rows.length === 0) {
    throw new DiagramNotFoundError(id);
  }
  const row = result.rows[0];
  const { diagram, version } = await loadDiagramFromRow({
    id: row.id,
    name: row.name,
    doc: row.doc,
    yjs_state: row.yjs_state,
    version: row.version,
  });
  return { row, diagram, version };
}

// Helper: build a zip from GeneratedFile entries
function buildZipFromFiles(files: GeneratedFile[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    for (const file of files) {
      zip.addBuffer(Buffer.from(file.content, 'utf8'), file.path);
    }
    zip.end();
    const chunks: Buffer[] = [];
    zip.outputStream.on('data', (chunk) => chunks.push(chunk));
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    zip.outputStream.on('error', reject);
  });
}

// Background generation job
async function runGeneration(jobId: string, diagramId: string): Promise<void> {
  try {
    jobRegistry.setRunning(jobId);
    const { diagram } = await loadDiagramById(diagramId);
    const outputRoot = process.cwd() + '/generated'; // dummy root for containment check
    const render = createHandlebarsRenderer(DEFAULT_TEMPLATES_DIR);
    const result = generate(diagram, { outputRoot, basePackage: 'com.example.generated', render });
    const zipBuffer = await buildZipFromFiles(result.files);
    jobRegistry.setSucceeded(jobId, zipBuffer);
  } catch (error) {
    jobRegistry.setFailed(jobId, error instanceof Error ? error.message : 'Generation failed');
  }
}

/** Reads `OPENAI_LLM_MAX_ATTEMPTS` (default 2, clamp 3) for the retry+repair wrapper. */
function readMaxAttemptsFromEnv(): number {
  const raw = process.env.OPENAI_LLM_MAX_ATTEMPTS;
  if (raw === undefined || raw === '') return 2;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 2;
  if (n < 1) return 1;
  if (n > 3) return 3;
  return Math.floor(n);
}

/** Builds the Fastify app (routes registered, not listening). Exported for smoke tests. */
export function buildApp(options?: AppOptions): FastifyInstance {
  const app = Fastify({ logger: options?.logger ?? true });
  // Wiring (interpreter-llm-resilience, R2/R5): the production LLM path —
  // any OpenAiLlm picked via env or a direct injection that IS an OpenAiLlm
  // instance — is wrapped in RetryRepairingLlmPort so a Zod-invalid model
  // output is recovered with a repair prompt rather than surfaced as a
  // generic schema error to the user. Test-injected LlmPort instances that
  // are NOT OpenAiLlm (e.g. FakeLlm in offline tests) are left untouched
  // (R2: FakeLlm must keep its deterministic behaviour).
  const baseLlm: LlmPort = options?.llm ?? OpenAiLlm.fromEnv() ?? new FakeLlm();
  const llm: LlmPort = baseLlm instanceof OpenAiLlm
    ? new RetryRepairingLlmPort(baseLlm, { maxAttempts: readMaxAttemptsFromEnv() })
    : baseLlm;
  // Voice (PR 8): injected stt (tests) wins over env config (Whisper when an
  // API key is present), with the deterministic FakeStt as offline default.
  const stt: SttPort = options?.stt ?? WhisperStt.fromEnv() ?? new FakeStt();
  // Vision (PR 16): injected vision (tests) wins over env config, with
  // FakeVision as offline default.
  const vision: VisionPort = options?.vision ?? OpenAiVision.fromEnv() ?? new FakeVision();

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

  // POST /diagrams/:id/interpret — natural language → refusal | pending delta.
  // interpreter:R1 — schema-invalid LLM output → 422, model untouched.
  // interpreter:R3/R4 — refusals carry the supported command categories.
  app.post<{ Params: { id: string }; Body: { text?: string } }>(
    '/diagrams/:id/interpret',
    async (request, reply) => {
      const { id } = request.params;
      const text = request.body?.text;
      if (typeof text !== 'string' || text.trim().length === 0) {
        return reply.status(400).send({ error: 'text is required' });
      }

      const result = await pool.query(
        'SELECT id, name, doc, yjs_state, version, created_at, updated_at FROM diagrams WHERE id = $1',
        [id],
      );
      if (result.rows.length === 0) {
        return reply.status(404).send({ error: 'Diagram not found' });
      }
      const row = result.rows[0];

      let currentIr: Diagram;
      try {
        currentIr = (
          await loadDiagramFromRow({
            id: row.id,
            name: row.name,
            doc: row.doc,
            yjs_state: row.yjs_state,
            version: row.version,
          })
        ).diagram;
      } catch (error) {
        return reply.status(500).send({ error: error instanceof Error ? error.message : 'Diagram load failed' });
      }

      try {
        const outcome = await interpretCommand(text, llm, currentIr, pendingDeltas);
        if (outcome.status === 'error') {
          return reply.status(422).send({ status: 'error', error: outcome.message });
        }
        return reply.send(outcome);
      } catch (error) {
        if (error instanceof LlmUnavailableError) {
          return reply.status(502).send({ error: `LLM unavailable: ${error.message}` });
        }
        throw error;
      }
    }
  );

  // POST /deltas/:id/confirm — releases the pending delta to the confirming
  // client, which applies it to its Y.Doc and propagates via collab
  // (interpreter:R2 — the API itself never mutates the diagram here).
  app.post<{ Params: { id: string } }>('/deltas/:id/confirm', async (request, reply) => {
    const pending = pendingDeltas.take(request.params.id);
    if (!pending) {
      return reply.status(404).send({ error: 'Unknown or already used delta id' });
    }
    return { status: 'confirmed', delta: pending.delta, diagramId: pending.diagramId };
  });

  // POST /deltas/:id/reject — discards the pending delta, model unchanged.
  app.post<{ Params: { id: string } }>('/deltas/:id/reject', async (request, reply) => {
    const pending = pendingDeltas.take(request.params.id);
    if (!pending) {
      return reply.status(404).send({ error: 'Unknown or already used delta id' });
    }
    return { status: 'rejected' };
  });

  registerXmiImportRoutes(app);
  registerXmiExportRoutes(app);
  // PR 16: photo import routes — VisionPort injected for testability.
  registerPhotoImportRoutes(app, vision);

  // POST /diagrams/:id/voice — speech → transcript → SAME interpret pipeline.
  // voice:R1 — transcription via an existing STT API; an outage is an explicit
  // 502 that directs the user to the text command input fallback.
  // voice:R2 — the transcript re-enters interpretCommand: shared pending
  // store, same confirm gate, no privileged path.
  app.post<{ Params: { id: string }; Body: { audio?: string; mimeType?: string } }>(
    '/diagrams/:id/voice',
    async (request, reply) => {
      const { id } = request.params;
      const audioBase64 = request.body?.audio;
      if (typeof audioBase64 !== 'string' || audioBase64.trim().length === 0) {
        return reply.status(400).send({ error: 'audio (base64) is required' });
      }

      const result = await pool.query(
        'SELECT id, name, doc, yjs_state, version, created_at, updated_at FROM diagrams WHERE id = $1',
        [id],
      );
      if (result.rows.length === 0) {
        return reply.status(404).send({ error: 'Diagram not found' });
      }
      const row = result.rows[0];

      let currentIr: Diagram;
      try {
        currentIr = (
          await loadDiagramFromRow({
            id: row.id,
            name: row.name,
            doc: row.doc,
            yjs_state: row.yjs_state,
            version: row.version,
          })
        ).diagram;
      } catch (error) {
        return reply.status(500).send({ error: error instanceof Error ? error.message : 'Diagram load failed' });
      }

      let transcript: string;
      try {
        const audio = new Uint8Array(Buffer.from(audioBase64, 'base64'));
        transcript = await stt.transcribe(audio, request.body?.mimeType ?? 'audio/webm');
      } catch (error) {
        const cause = error instanceof Error ? error.message : 'unknown error';
        return reply.status(502).send({
          error: `Speech-to-text unavailable: ${cause}. Use the text command input instead.`,
        });
      }

      try {
        const outcome = await interpretCommand(transcript, llm, currentIr, pendingDeltas);
        if (outcome.status === 'error') {
          return reply.status(422).send({ transcript, status: 'error', message: outcome.message });
        }
        return reply.send({ transcript, ...outcome });
      } catch (error) {
        if (error instanceof LlmUnavailableError) {
          return reply.status(502).send({ error: `LLM unavailable: ${error.message}` });
        }
        throw error;
      }
    }
  );

  // ---- Unit 14d: generate-over-HTTP job API ----

  // POST /diagrams/:id/generate — kick off async generation, return jobId.
  // 404 if the diagram id has no row; 500 if the row exists but the blob
  // is corrupt. 409 if a job is already in flight for the same diagram
  // (backpressure: prevent N concurrent generations of the same model).
  app.post<{ Params: { id: string } }>(
    '/diagrams/:id/generate',
    async (request, reply) => {
      const { id } = request.params;
      try {
        await loadDiagramById(id); // validates existence + blob integrity
      } catch (error) {
        if (error instanceof DiagramNotFoundError) {
          return reply.status(404).send({ error: 'Diagram not found' });
        }
        return reply
          .status(500)
          .send({ error: error instanceof Error ? error.message : 'Diagram load failed' });
      }
      // Backpressure: dedup by diagramId. A queued/running job for the
      // same diagram blocks new jobs (return 409 with the existing id).
      const existing = jobRegistry.findActiveByDiagramId(id);
      if (existing) {
        return reply.status(409).send({
          error: 'Job already in progress for this diagram',
          jobId: existing.id,
        });
      }
      const job = jobRegistry.create(id);
      // Run generation in background (do not await)
      setImmediate(() => void runGeneration(job.id, id));
      return reply.status(202).send({ jobId: job.id });
    }
  );

  // GET /jobs/:id — get job status
  app.get<{ Params: { id: string } }>(
    '/jobs/:id',
    async (request, reply) => {
      const job = jobRegistry.get(request.params.id);
      if (!job) {
        return reply.status(404).send({ error: 'Job not found' });
      }
      return {
        id: job.id,
        status: job.status,
        diagramId: job.diagramId,
        createdAt: job.createdAt.toISOString(),
        updatedAt: job.updatedAt.toISOString(),
        error: job.error ?? null,
        artifactReady: job.status === 'succeeded',
      };
    }
  );

  // GET /jobs/:id/artifact — download the generated zip
  app.get<{ Params: { id: string } }>(
    '/jobs/:id/artifact',
    async (request, reply) => {
      const job = jobRegistry.get(request.params.id);
      if (!job) {
        return reply.status(404).send({ error: 'Job not found' });
      }
      if (job.status === 'failed') {
        return reply.status(500).send({ error: `Generation failed: ${job.error ?? 'unknown error'}` });
      }
      if (job.status !== 'succeeded' || !job.artifact) {
        return reply.status(409).send({ error: 'Artifact not ready yet' });
      }
      // Defense in depth: UUIDs are already safe, but sanitize the
      // filename before it lands in a Content-Disposition header.
      const safeName = String(job.diagramId).replace(/[^a-zA-Z0-9-]/g, '_');
      return reply
        .header('Content-Type', 'application/zip')
        .header('Content-Disposition', `attachment; filename="generated-${safeName}.zip"`)
        .send(job.artifact);
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