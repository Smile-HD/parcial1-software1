/**
 * @app/api — API REST Fastify para persistencia de diagramas.
 * POST /diagrams, GET /diagrams/:id, PUT /diagrams/:id
 * PostgreSQL 16 vía pg Pool, IDs uuidv7, concurrencia optimista (version).
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

// Carga apps/api/.env cuando está presente para que la configuración del proveedor
// compatible con OpenAI (OPENAI_API_KEY / OPENAI_BASE_URL / LLM_MODEL / WHISPER_MODEL)
// y DATABASE_URL sobrevivan a los reinicios sin configuración de terminal. Si falta el
// archivo no hay problema — las variables de entorno aún pueden provenir del entorno del proceso.
try {
  process.loadEnvFile();
} catch {
  // No hay .env en el directorio actual — se confía en el entorno del proceso.
}

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5433/ai_uml';

const pool = new Pool({ connectionString: DATABASE_URL, max: 10 });

/** Hook para pruebas/arranque: cierra el pool con alcance de módulo. */
export async function closePool(): Promise<void> {
  await pool.end();
}

/** Exportado para pruebas que necesitan insertar filas corruptas. */
export { pool };

// Conexión del LLM del intérprete: un llm inyectado (pruebas) prevalece sobre la
// configuración de entorno (compatible con OpenAI cuando OPENAI_API_KEY está definida),
// con el FakeLlm determinista como valor por defecto offline para que el desarrollo/demo no requieran red.
export interface AppOptions {
  logger?: boolean;
  llm?: LlmPort;
  stt?: SttPort;
  vision?: VisionPort;
}

export const pendingDeltas = new PendingDeltaStore();

// Esquemas de Request/Response.
// `yjsState` (actualización de Yjs en base64) es el estado persistido autoritativo: los
// clientes conectados al servidor de colaboración comparten los relojes de Yjs del blob,
// por lo que la API debe almacenar el propio blob del cliente en lugar de reconstruir
// uno a partir de la proyección JSON (un blob reconstruido reinicia relojes y fusionarlo
// mediante CRDT contra documentos vivos de clientes duplica miembros de Y.Array). Ver unidad 6b / diseño D4.
// NOTA: declarado como cadenas simples — AjV de Fastify no conoce el formato `base64`;
// la validez de base64 se aplica en preparePersistence (400 si es inválido).
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

// El compilador AjV de Fastify requiere JSON Schema puro — los objetos Zod no pueden
// pasarse directamente. Se convierten una sola vez al cargar el módulo; los manejadores
// aún validan mediante los esquemas Zod.
// target 'draft-7': la instancia por defecto de AjV en Fastify no registra el dialecto 2020-12.
const CreateDiagramBodyJsonSchema = z.toJSONSchema(CreateDiagramBodySchema, { target: 'draft-7' });
const UpdateDiagramBodyJsonSchema = z.toJSONSchema(UpdateDiagramBodySchema, { target: 'draft-7' });
const DiagramResponseJsonSchema = z.toJSONSchema(DiagramResponseSchema, { target: 'draft-7' });
const ErrorResponseJsonSchema = z.toJSONSchema(ErrorResponseSchema, { target: 'draft-7' });
const ConflictResponseJsonSchema = z.toJSONSchema(ConflictResponseSchema, { target: 'draft-7' });

// Helper: mapea una fila de BD a la respuesta
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

// Construye el estado de persistencia para un diagrama. Cuando el cliente provee su
// propio blob de Yjs (los clientes conectados a colaboración lo hacen), el blob es autoritativo:
// decodificar, validar su proyección y persistirlo TAL CUAL para que los relojes de cada cliente
// conectado sigan convergiendo (unidad 6b). Sin un blob, reconstruir uno a partir de la
// proyección JSON validada (invocadores legados o solo de API).
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
  // Valida el viaje de ida y vuelta de la proyección
  const validation = validateYDocProjection(yDoc);
  if (!validation.ok) {
    throw new Error('Y.Doc projection validation failed after build');
  }
  // Usa la proyección validada como documento almacenado (asegura consistencia)
  return { doc: validation.diagram, yjsState, version: 1 };
}

// Carga el diagrama desde la fila de BD, con auto-recuperación (self-healing)
async function loadDiagramFromRow(row: {
  id: string;
  name: string;
  doc: unknown;
  yjs_state: Buffer;
  version: number;
}): Promise<{ diagram: Diagram; yjsState: Buffer; version: number }> {
  // Intenta cargar Y.Doc desde el blob (autoritativo)
  let yDoc: Y.Doc;
  try {
    yDoc = loadYDocFromUpdate(new Uint8Array(row.yjs_state));
  } catch {
    throw new Error('Corrupt yjs_state blob: cannot decode Y.Doc');
  }

  // Valida la proyección desde el blob
  const validation = validateYDocProjection(yDoc);
  if (validation.ok) {
    // El blob es correcto, retorna el diagrama derivado del blob
    return { diagram: validation.diagram, yjsState: row.yjs_state, version: row.version };
  }

  // La proyección del blob falló la validación Zod — prueba el documento almacenado como respaldo
  try {
    const storedDoc = DiagramSchema.parse(row.doc);
    // Reconstruye Y.Doc desde el doc almacenado y verifica que codifique al mismo blob
    const rebuiltYDoc = buildYDocFromDiagram(storedDoc);
    const rebuiltUpdate = encodeYDoc(rebuiltYDoc);
    if (Buffer.compare(Buffer.from(rebuiltUpdate), row.yjs_state) !== 0) {
      // El blob y el doc difieren — el blob es autoritativo por diseño, pero está corrupto
      throw new Error('yjs_state blob corrupt and does not match stored doc');
    }
    // Auto-recuperación: el doc era válido, el blob codifica correctamente pero la proyección falló (no debería ocurrir)
    // Retorna el diagrama derivado del doc
    return { diagram: storedDoc, yjsState: row.yjs_state, version: row.version };
  } catch {
    // Tanto el blob como el doc son inválidos — error explícito de carga según editor:R5
    throw new Error('Diagram load failed: corrupt yjs_state blob and invalid stored doc');
  }
}

/** Lanzado por loadDiagramById cuando el id de diagrama no tiene fila en la BD.
 *  Distinto de errores de corrupción lanzados por loadDiagramFromRow para que los
 *  manejadores puedan retornar 404 en lugar de 500. */
export class DiagramNotFoundError extends Error {
  override readonly name = 'DiagramNotFoundError';
  constructor(id: string) {
    super(`Diagram not found: ${id}`);
  }
}

// Helper: carga diagrama por id (retorna fila y diagrama)
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

// Helper: construye un zip a partir de entradas GeneratedFile
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

// Trabajo de generación en segundo plano
async function runGeneration(jobId: string, diagramId: string): Promise<void> {
  try {
    jobRegistry.setRunning(jobId);
    const { diagram } = await loadDiagramById(diagramId);
    const outputRoot = process.cwd() + '/generated'; // raíz simulada para verificación de contención
    const render = createHandlebarsRenderer(DEFAULT_TEMPLATES_DIR);
    const result = generate(diagram, { outputRoot, basePackage: 'com.example.generated', render });
    const zipBuffer = await buildZipFromFiles(result.files);
    jobRegistry.setSucceeded(jobId, zipBuffer);
  } catch (error) {
    jobRegistry.setFailed(jobId, error instanceof Error ? error.message : 'Generation failed');
  }
}

/** Lee `OPENAI_LLM_MAX_ATTEMPTS` (por defecto 2, acotado a 3) para el envoltorio de reintento+reparación. */
function readMaxAttemptsFromEnv(): number {
  const raw = process.env.OPENAI_LLM_MAX_ATTEMPTS;
  if (raw === undefined || raw === '') return 2;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 2;
  if (n < 1) return 1;
  if (n > 3) return 3;
  return Math.floor(n);
}

/** Construye la aplicación Fastify (rutas registradas, sin escuchar). Exportado para pruebas de humo. */
export function buildApp(options?: AppOptions): FastifyInstance {
  const app = Fastify({ logger: options?.logger ?? true });
  // Cableado (interpreter-llm-resilience, R2/R5): la ruta de LLM de producción —
  // cualquier OpenAiLlm seleccionado por entorno o inyección directa que SEA una
  // instancia de OpenAiLlm — se envuelve en RetryRepairingLlmPort para que una salida
  // del modelo inválida según Zod se recupere con un prompt de reparación en lugar de exponerse
  // como un error genérico de esquema al usuario. Las instancias de LlmPort inyectadas en pruebas
  // que NO sean OpenAiLlm (ej. FakeLlm en pruebas offline) se dejan intactas
  // (R2: FakeLlm debe mantener su comportamiento determinista).
  const baseLlm: LlmPort = options?.llm ?? OpenAiLlm.fromEnv() ?? new FakeLlm();
  const llm: LlmPort = baseLlm instanceof OpenAiLlm
    ? new RetryRepairingLlmPort(baseLlm, { maxAttempts: readMaxAttemptsFromEnv() })
    : baseLlm;
  // Voz (PR 8): el stt inyectado (pruebas) prevalece sobre la configuración de entorno
  // (Whisper cuando hay una API key presente), con FakeStt determinista como valor por defecto offline.
  const stt: SttPort = options?.stt ?? WhisperStt.fromEnv() ?? new FakeStt();
  // Visión (PR 16): la visión inyectada (pruebas) prevalece sobre la configuración de entorno,
  // con FakeVision como valor por defecto offline.
  const vision: VisionPort = options?.vision ?? OpenAiVision.fromEnv() ?? new FakeVision();

  // CORS — el editor web (apps/web) es un origen separado en desarrollo (Vite :5173)
  // y llama a esta API cross-origin; sin estas cabeceras cada fetch del navegador
  // es bloqueado. `origin: true` refleja el origen de la petición (postura dev/LAN — el
  // cliente móvil en la unidad 14 también necesita orígenes LAN). `methods`
  // debe incluir PUT explícitamente: @fastify/cors usa GET,HEAD,POST por defecto,
  // lo que bloquearía silenciosamente cada guardado (editor:R5). Ajustar a una lista
  // permitida explícita de orígenes cuando se requiera despliegue en producción.
  void app.register(cors, { origin: true, methods: ['GET', 'HEAD', 'POST', 'PUT'] });

  // Comprobación de estado (health check)
  app.get('/health', async () => ({ status: 'ok' }));

  // POST /diagrams — crea un nuevo diagrama
  app.post<{ Body: z.infer<typeof CreateDiagramBodySchema> }>(
    '/diagrams',
    { schema: { body: CreateDiagramBodyJsonSchema, response: { 201: DiagramResponseJsonSchema } } },
    async (request, reply) => {
      const { name, diagram: diagramData } = request.body;

      // Valida que el ID del diagrama coincida con el cuerpo (o genera uno si falta)
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

  // GET /diagrams/:id — carga el diagrama con auto-recuperación (self-healing)
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
        // Error explícito de carga, sin diagrama parcial (editor:R5)
        return reply.status(500).send({ error: error instanceof Error ? error.message : 'Diagram load failed' });
      }
    }
  );

  // PUT /diagrams/:id — actualiza con concurrencia optimista
  app.put<{ Params: { id: string }; Body: z.infer<typeof UpdateDiagramBodySchema> }>(
    '/diagrams/:id',
    { schema: { body: UpdateDiagramBodyJsonSchema, response: { 200: DiagramResponseJsonSchema, 404: ErrorResponseJsonSchema, 409: ConflictResponseJsonSchema } } },
    async (request, reply) => {
      const { id } = request.params;
      const { name, diagram: diagramData, version: expectedVersion } = request.body;

      // Valida que el ID del diagrama coincida con la URL
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
          // Comprueba si el diagrama existe (para distinguir 404 de 409)
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

  // POST /diagrams/:id/interpret — lenguaje natural → rechazo | delta pendiente.
  // interpreter:R1 — salida LLM con esquema inválido → 422, metamodelo intacto.
  // interpreter:R3/R4 — los rechazos incluyen las categorías de comandos soportadas.
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

  // POST /deltas/:id/confirm — entrega el delta pendiente al cliente que confirma,
  // el cual lo aplica a su Y.Doc y lo propaga vía colaboración
  // (interpreter:R2 — la propia API nunca muta el diagrama aquí).
  app.post<{ Params: { id: string } }>('/deltas/:id/confirm', async (request, reply) => {
    const pending = pendingDeltas.take(request.params.id);
    if (!pending) {
      return reply.status(404).send({ error: 'Unknown or already used delta id' });
    }
    return { status: 'confirmed', delta: pending.delta, diagramId: pending.diagramId };
  });

  // POST /deltas/:id/reject — descarta el delta pendiente, metamodelo sin cambios.
  app.post<{ Params: { id: string } }>('/deltas/:id/reject', async (request, reply) => {
    const pending = pendingDeltas.take(request.params.id);
    if (!pending) {
      return reply.status(404).send({ error: 'Unknown or already used delta id' });
    }
    return { status: 'rejected' };
  });

  registerXmiImportRoutes(app);
  registerXmiExportRoutes(app);
  // PR 16: rutas de importación de fotos — VisionPort inyectado para pruebas.
  registerPhotoImportRoutes(app, vision);

  // POST /diagrams/:id/voice — voz → transcripción → MISMO flujo de interpretación.
  // voice:R1 — transcripción vía API STT existente; una interrupción es un 502
  // explícito que dirige al usuario al respaldo de entrada de comandos por texto.
  // voice:R2 — la transcripción reingresa a interpretCommand: almacén de pendientes
  // compartido, misma compuerta de confirmación, sin ruta privilegiada.
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

  // ---- Unidad 14d: API de trabajos generate-over-HTTP ----

  // POST /diagrams/:id/generate — inicia generación asíncrona, retorna jobId.
  // 404 si el id de diagrama no tiene fila; 500 si la fila existe pero el blob
  // está corrupto. 409 si ya hay un trabajo en curso para el mismo diagrama
  // (contrapresión: previene N generaciones concurrentes del mismo modelo).
  app.post<{ Params: { id: string } }>(
    '/diagrams/:id/generate',
    async (request, reply) => {
      const { id } = request.params;
      try {
        await loadDiagramById(id); // valida existencia + integridad del blob
      } catch (error) {
        if (error instanceof DiagramNotFoundError) {
          return reply.status(404).send({ error: 'Diagram not found' });
        }
        return reply
          .status(500)
          .send({ error: error instanceof Error ? error.message : 'Diagram load failed' });
      }
      // Contrapresión: deduplicar por diagramId. Un trabajo en cola o en ejecución para el
      // mismo diagrama bloquea nuevos trabajos (retorna 409 con el id existente).
      const existing = jobRegistry.findActiveByDiagramId(id);
      if (existing) {
        return reply.status(409).send({
          error: 'Job already in progress for this diagram',
          jobId: existing.id,
        });
      }
      const job = jobRegistry.create(id);
      // Ejecuta la generación en segundo plano (sin await)
      setImmediate(() => void runGeneration(job.id, id));
      return reply.status(202).send({ jobId: job.id });
    }
  );

  // GET /jobs/:id — obtiene el estado del trabajo
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

  // GET /jobs/:id/artifact — descarga el zip generado
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
      // Defensa en profundidad: los UUIDs ya son seguros, pero se sanea el
      // nombre de archivo antes de colocarlo en la cabecera Content-Disposition.
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

  // Cierre ordenado (graceful shutdown)
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