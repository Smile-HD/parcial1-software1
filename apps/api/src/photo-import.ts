/**
 * Rutas de trabajos de importación de fotos (PR 16, tareas 16.3 + 16.4).
 *
 * POST /diagrams/:id/photo — acepta una imagen codificada en base64, la valida
 * (bytes mágicos + límite de tamaño según photo:R4), crea un trabajo asíncrono vía jobs.ts,
 * y retorna { jobId } inmediatamente (202). El trabajo ejecuta VisionPort.extract
 * en segundo plano.
 *
 * GET /diagrams/:id/photo/:jobId — retorna el estado del trabajo. Al completarse con éxito,
 * el resultado incluye el BatchDelta extraído (o una advertencia si hay cero elementos,
 * nunca fabricados — photo:R3).
 *
 * VisionPort se inyecta a través de AppOptions (FakeVision en pruebas).
 */
import type { FastifyInstance } from 'fastify';
import type { VisionPort } from '@app/core';
import { BatchDeltaSchema } from '@app/core';
import { loadDiagramById, DiagramNotFoundError } from './index.js';
import { jobRegistry } from './jobs.js';

// ── Constantes de validación (reflejadas de apps/web photoValidation.ts) ───
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
const SUPPORTED_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

const MAGIC_BYTES: Record<string, number[]> = {
  'image/png': [0x89, 0x50, 0x4e, 0x47],
  'image/jpeg': [0xff, 0xd8, 0xff],
  'image/gif': [0x47, 0x49, 0x46, 0x38],
  'image/webp': [0x52, 0x49, 0x46, 0x46],
};

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46];

function matchesMagic(bytes: Uint8Array, magic: number[]): boolean {
  if (bytes.length < magic.length) return false;
  for (let i = 0; i < magic.length; i++) {
    if (bytes[i] !== magic[i]) return false;
  }
  return true;
}

/**
 * Detecta el tipo MIME a partir de los bytes mágicos. Retorna la cadena MIME o null.
 */
function detectMime(bytes: Uint8Array): string | null {
  for (const [mime, magic] of Object.entries(MAGIC_BYTES)) {
    if (matchesMagic(bytes, magic)) return mime;
  }
  return null;
}

export function registerPhotoImportRoutes(app: FastifyInstance, vision: VisionPort) {
  // POST /diagrams/:id/photo — crea trabajo asíncrono de importación de foto
  app.post<{ Params: { id: string }; Body: { image?: string; mimeType?: string } }>(
    '/diagrams/:id/photo',
    { bodyLimit: 25 * 1024 * 1024 },
    async (request, reply) => {
      const diagramId = request.params.id;
      const imageBase64 = request.body?.image;
      const declaredMime = request.body?.mimeType ?? 'image/png';

      if (typeof imageBase64 !== 'string' || imageBase64.trim().length === 0) {
        return reply.status(400).send({ error: 'image (base64) is required' });
      }

      // Verificación de existencia antes del parseo (lección de PR15: 404 ANTES del trabajo pesado).
      try {
        await loadDiagramById(diagramId);
      } catch (error) {
        if (error instanceof DiagramNotFoundError) {
          return reply.status(404).send({ error: 'Diagram not found' });
        }
        return reply
          .status(500)
          .send({ error: error instanceof Error ? error.message : 'Diagram load failed' });
      }

      // Decodifica base64 a bytes para validación
      let imageBytes: Uint8Array;
      try {
        imageBytes = new Uint8Array(Buffer.from(imageBase64, 'base64'));
      } catch {
        return reply.status(400).send({ error: 'Invalid base64 image data' });
      }

      // Límite de tamaño (photo:R4) — rechazar ANTES de crear un trabajo (cero llamadas a API)
      if (imageBytes.byteLength > MAX_PHOTO_BYTES) {
        return reply.status(413).send({
          error: `Image too large: ${(imageBytes.byteLength / (1024 * 1024)).toFixed(1)} MB (max ${MAX_PHOTO_BYTES / (1024 * 1024)} MB)`,
        });
      }

      // Validación de bytes mágicos (photo:R4) — detectar PDF renombrado a .png
      if (imageBytes.byteLength === 0) {
        return reply.status(400).send({ error: 'Image is empty' });
      }

      // Rechazar magic bytes de PDF independientemente del MIME declarado
      if (matchesMagic(imageBytes, PDF_MAGIC)) {
        return reply.status(400).send({
          error: 'File appears to be a PDF, not an image. Supported formats: PNG, JPEG, GIF, WebP',
        });
      }

      // Verificar que los bytes mágicos coincidan con el tipo MIME declarado
      const detectedMime = detectMime(imageBytes);
      if (detectedMime === null) {
        return reply.status(400).send({
          error: `Unrecognized image format. Supported: PNG, JPEG, GIF, WebP`,
        });
      }

      // Contrapresión: rechazar si ya hay un trabajo en curso
      const existing = jobRegistry.findActiveByDiagramId(diagramId);
      if (existing) {
        return reply.status(409).send({
          error: 'Photo import already in progress for this diagram',
          jobId: existing.id,
        });
      }

      // Crea el trabajo y ejecuta la extracción en segundo plano
      const job = jobRegistry.create(diagramId);
      setImmediate(() => void runPhotoExtraction(job.id, diagramId, imageBytes, detectedMime, vision));

      return reply.status(202).send({ jobId: job.id });
    }
  );

  // GET /diagrams/:id/photo/:jobId — obtiene estado del trabajo con resultado de extracción
  app.get<{ Params: { id: string; jobId: string } }>(
    '/diagrams/:id/photo/:jobId',
    async (request, reply) => {
      const { jobId } = request.params;

      // Verifica que el diagrama exista
      try {
        await loadDiagramById(request.params.id);
      } catch (error) {
        if (error instanceof DiagramNotFoundError) {
          return reply.status(404).send({ error: 'Diagram not found' });
        }
        return reply
          .status(500)
          .send({ error: error instanceof Error ? error.message : 'Diagram load failed' });
      }

      const job = jobRegistry.get(jobId);
      if (!job) {
        return reply.status(404).send({ error: 'Job not found' });
      }
      if (job.diagramId !== request.params.id) {
        return reply.status(404).send({ error: 'Job not found' });
      }

      const base = {
        id: job.id,
        status: job.status,
        diagramId: job.diagramId,
        createdAt: job.createdAt.toISOString(),
        updatedAt: job.updatedAt.toISOString(),
      };

      if (job.status === 'failed') {
        return { ...base, error: job.error ?? 'Extraction failed' };
      }

      if (job.status === 'succeeded' && job.artifact) {
        // El artefacto es un búfer JSON que contiene { batch, warnings }
        try {
          const result = JSON.parse(job.artifact.toString('utf8')) as {
            batch: unknown;
            warnings: string[];
          };
          return {
            ...base,
            batch: result.batch,
            warnings: result.warnings,
          };
        } catch {
          return { ...base, error: 'Failed to parse extraction result' };
        }
      }

      // en cola o en ejecución — aún sin artefacto
      return base;
    }
  );
}

// ── Trabajo de extracción en segundo plano ────────────────────────────────

async function runPhotoExtraction(
  jobId: string,
  diagramId: string,
  imageBytes: Uint8Array,
  mimeType: string,
  vision: VisionPort,
): Promise<void> {
  try {
    jobRegistry.setRunning(jobId);

    const batch = await vision.extract(imageBytes, mimeType);

    // Valida el lote extraído contra el esquema canónico, luego
    // reasigna diagramId al diagrama de destino (mismo patrón que en importación XMI).
    const validated = BatchDeltaSchema.parse(batch);
    validated.diagramId = diagramId;

    // Cuenta elementos y construye advertencias (photo:R3 — nunca fabricar)
    const warnings: string[] = [];
    const classCount = validated.deltas.filter(
      (d) => d.kind === 'class' && d.op === 'create',
    ).length;

    if (classCount === 0) {
      warnings.push(
        'No classes could be extracted from the image. The photo may be blurry, poorly lit, or contain no recognizable class diagram.',
      );
    }

    // Almacena el resultado como búfer JSON en el artefacto del trabajo
    const result = JSON.stringify({ batch: validated, warnings });
    jobRegistry.setSucceeded(jobId, Buffer.from(result, 'utf8'));
  } catch (error) {
    jobRegistry.setFailed(
      jobId,
      error instanceof Error ? error.message : 'Photo extraction failed',
    );
  }
}
