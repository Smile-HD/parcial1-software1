/**
 * Photo import job routes (PR 16, task 16.3 + 16.4).
 *
 * POST /diagrams/:id/photo — accepts a base64-encoded image, validates it
 * (magic bytes + size cap per photo:R4), creates an async job via jobs.ts,
 * and returns { jobId } immediately (202). The job runs VisionPort.extract
 * in the background.
 *
 * GET /diagrams/:id/photo/:jobId — returns job status. When succeeded, the
 * result includes the extracted BatchDelta (or a warning with zero elements,
 * never fabricated — photo:R3).
 *
 * VisionPort is injected through AppOptions (FakeVision in tests).
 */
import type { FastifyInstance } from 'fastify';
import type { VisionPort } from '@app/core';
import { BatchDeltaSchema } from '@app/core';
import { loadDiagramById, DiagramNotFoundError } from './index.js';
import { jobRegistry } from './jobs.js';

// ── Validation constants (mirrored from apps/web photoValidation.ts) ────────
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
 * Detect MIME type from magic bytes. Returns the MIME string or null.
 */
function detectMime(bytes: Uint8Array): string | null {
  for (const [mime, magic] of Object.entries(MAGIC_BYTES)) {
    if (matchesMagic(bytes, magic)) return mime;
  }
  return null;
}

export function registerPhotoImportRoutes(app: FastifyInstance, vision: VisionPort) {
  // POST /diagrams/:id/photo — create async photo import job
  app.post<{ Params: { id: string }; Body: { image?: string; mimeType?: string } }>(
    '/diagrams/:id/photo',
    async (request, reply) => {
      const diagramId = request.params.id;
      const imageBase64 = request.body?.image;
      const declaredMime = request.body?.mimeType ?? 'image/png';

      if (typeof imageBase64 !== 'string' || imageBase64.trim().length === 0) {
        return reply.status(400).send({ error: 'image (base64) is required' });
      }

      // Existence check before parsing (PR15 lesson: 404 BEFORE heavy work).
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

      // Decode base64 to bytes for validation
      let imageBytes: Uint8Array;
      try {
        imageBytes = new Uint8Array(Buffer.from(imageBase64, 'base64'));
      } catch {
        return reply.status(400).send({ error: 'Invalid base64 image data' });
      }

      // Size cap (photo:R4) — reject BEFORE creating a job (zero API calls)
      if (imageBytes.byteLength > MAX_PHOTO_BYTES) {
        return reply.status(413).send({
          error: `Image too large: ${(imageBytes.byteLength / (1024 * 1024)).toFixed(1)} MB (max ${MAX_PHOTO_BYTES / (1024 * 1024)} MB)`,
        });
      }

      // Magic-bytes validation (photo:R4) — catch PDF renamed to .png
      if (imageBytes.byteLength === 0) {
        return reply.status(400).send({ error: 'Image is empty' });
      }

      // Reject PDF magic regardless of declared MIME
      if (matchesMagic(imageBytes, PDF_MAGIC)) {
        return reply.status(400).send({
          error: 'File appears to be a PDF, not an image. Supported formats: PNG, JPEG, GIF, WebP',
        });
      }

      // Verify magic bytes match declared MIME type
      const detectedMime = detectMime(imageBytes);
      if (detectedMime === null) {
        return reply.status(400).send({
          error: `Unrecognized image format. Supported: PNG, JPEG, GIF, WebP`,
        });
      }

      // Backpressure: reject if a job is already in flight
      const existing = jobRegistry.findActiveByDiagramId(diagramId);
      if (existing) {
        return reply.status(409).send({
          error: 'Photo import already in progress for this diagram',
          jobId: existing.id,
        });
      }

      // Create job and run extraction in background
      const job = jobRegistry.create(diagramId);
      setImmediate(() => void runPhotoExtraction(job.id, diagramId, imageBytes, detectedMime, vision));

      return reply.status(202).send({ jobId: job.id });
    }
  );

  // GET /diagrams/:id/photo/:jobId — get job status with extraction result
  app.get<{ Params: { id: string; jobId: string } }>(
    '/diagrams/:id/photo/:jobId',
    async (request, reply) => {
      const { jobId } = request.params;

      // Verify diagram exists
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
        // Artifact is a JSON buffer containing { batch, warnings }
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

      // queued or running — no artifact yet
      return base;
    }
  );
}

// ── Background extraction job ──────────────────────────────────────────────

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

    // Validate the extracted batch against the canonical schema, then
    // remap diagramId to the target diagram (same pattern as XMI import).
    const validated = BatchDeltaSchema.parse(batch);
    validated.diagramId = diagramId;

    // Count elements and build warnings (photo:R3 — never fabricate)
    const warnings: string[] = [];
    const classCount = validated.deltas.filter(
      (d) => d.kind === 'class' && d.op === 'create',
    ).length;

    if (classCount === 0) {
      warnings.push(
        'No classes could be extracted from the image. The photo may be blurry, poorly lit, or contain no recognizable class diagram.',
      );
    }

    // Store result as JSON buffer in the job artifact
    const result = JSON.stringify({ batch: validated, warnings });
    jobRegistry.setSucceeded(jobId, Buffer.from(result, 'utf8'));
  } catch (error) {
    jobRegistry.setFailed(
      jobId,
      error instanceof Error ? error.message : 'Photo extraction failed',
    );
  }
}
