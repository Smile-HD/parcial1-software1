/**
 * API route tests for photo import (PR 16 backend slice — tasks 16.1-16.5).
 *
 * Exercises POST /diagrams/:id/photo and GET /diagrams/:id/photo/:jobId
 * over REAL HTTP (Fastify inject) against the REAL database.
 * FakeVision is injected for zero-network deterministic tests.
 */
import { describe, expect, it, beforeAll, afterAll, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { BatchDeltaSchema, DiagramSchema, type BatchDelta, type Diagram } from '@app/core';
import { FakeVision } from '@app/adapters-ai';
import { buildApp, closePool, pool } from './index.js';
import { jobRegistry } from './jobs.js';
import type { FastifyInstance } from 'fastify';

// ── Fixtures ────────────────────────────────────────────────────────────────

/** Minimal valid 1×1 PNG — 8-byte header + 12-byte IDAT + 12-byte IEND = 67 bytes. */
const TINY_PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG magic
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, // IHDR chunk
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
  0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41, // IDAT chunk
  0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
  0x00, 0x00, 0x02, 0x00, 0x01, 0xe2, 0x21, 0xbc,
  0x33, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, // IEND chunk
  0x44, 0xae, 0x42, 0x60, 0x82,
]);

/** PDF magic bytes for testing rejection. */
const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);

const TINY_PNG_BASE64 = Buffer.from(TINY_PNG).toString('base64');
const PDF_BASE64 = Buffer.from(PDF_BYTES).toString('base64');

// ── Test setup ──────────────────────────────────────────────────────────────

let app: FastifyInstance;
let createdIds: string[] = [];

/** Create an empty diagram via the real persistence API. */
async function createEmptyDiagram(): Promise<Diagram> {
  const diagram: Diagram = DiagramSchema.parse({
    id: randomUUID(),
    name: 'Photo Import Target',
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
  app = buildApp({ logger: false, vision: new FakeVision() });
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

// ── Tests ───────────────────────────────────────────────────────────────────

describe('API route: photo import (PR 16 backend)', () => {
  it('registers both photo import routes', () => {
    expect(app.hasRoute({ method: 'POST', url: '/diagrams/:id/photo' })).toBe(true);
    expect(app.hasRoute({ method: 'GET', url: '/diagrams/:id/photo/:jobId' })).toBe(true);
  });

  it('POST valid tiny PNG → 202 {jobId}', async () => {
    const diagram = await createEmptyDiagram();
    const res = await app.inject({
      method: 'POST',
      url: `/diagrams/${diagram.id}/photo`,
      payload: { image: TINY_PNG_BASE64, mimeType: 'image/png' },
    });
    expect(res.statusCode).toBe(202);
    const body = res.json() as { jobId: string };
    expect(body.jobId).toBeDefined();
    expect(typeof body.jobId).toBe('string');
    expect(body.jobId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('GET status → completed with batch when extraction succeeds', async () => {
    const diagram = await createEmptyDiagram();
    const postRes = await app.inject({
      method: 'POST',
      url: `/diagrams/${diagram.id}/photo`,
      payload: { image: TINY_PNG_BASE64, mimeType: 'image/png' },
    });
    expect(postRes.statusCode).toBe(202);
    const { jobId } = postRes.json() as { jobId: string };

    // FakeVision is synchronous in the test env — job should be completed immediately.
    const getRes = await app.inject({
      method: 'GET',
      url: `/diagrams/${diagram.id}/photo/${jobId}`,
    });
    expect(getRes.statusCode).toBe(200);
    const body = getRes.json() as {
      status: string;
      batch?: BatchDelta;
      warnings?: string[];
    };
    expect(body.status).toBe('succeeded');
    expect(body.batch).toBeDefined();

    // The batch is schema-valid (photo:R1 — extraction must produce valid JSON).
    const parsed = BatchDeltaSchema.parse(body.batch);
    expect(parsed.kind).toBe('batch');
    expect(parsed.diagramId).toBe(diagram.id);
    expect(parsed.deltas.length).toBeGreaterThan(0);
  });

  it('zero-element extraction returns warning, never fabricated classes (photo:R3)', async () => {
    // Build a separate app with a zero-element FakeVision for this test.
    const zeroApp = buildApp({ logger: false, vision: new FakeVision({ zeroElements: true }) });
    await zeroApp.ready();

    const diagram = DiagramSchema.parse({
      id: randomUUID(),
      name: 'Zero Vision Target',
      classes: [],
      associations: [],
      generalizations: [],
      realizations: [],
      dependencies: [],
      naryAssociations: [],
    });
    const createRes = await zeroApp.inject({
      method: 'POST',
      url: '/diagrams',
      payload: { name: diagram.name, diagram },
    });
    expect(createRes.statusCode).toBe(201);
    createdIds.push(diagram.id);

    const postRes = await zeroApp.inject({
      method: 'POST',
      url: `/diagrams/${diagram.id}/photo`,
      payload: { image: TINY_PNG_BASE64, mimeType: 'image/png' },
    });
    expect(postRes.statusCode).toBe(202);
    const { jobId } = postRes.json() as { jobId: string };

    const getRes = await zeroApp.inject({
      method: 'GET',
      url: `/diagrams/${diagram.id}/photo/${jobId}`,
    });
    expect(getRes.statusCode).toBe(200);
    const body = getRes.json() as {
      status: string;
      batch?: BatchDelta;
      warnings?: string[];
    };
    expect(body.status).toBe('succeeded');
    expect(body.warnings).toBeDefined();
    expect(body.warnings!.length).toBeGreaterThan(0);
    expect(body.warnings![0]).toMatch(/No classes/);
    // Must NOT fabricate placeholder classes.
    expect(body.batch!.deltas).toHaveLength(0);

    await zeroApp.close();
  });

  it('404 for non-existent diagram', async () => {
    const missingId = randomUUID();
    const res = await app.inject({
      method: 'POST',
      url: `/diagrams/${missingId}/photo`,
      payload: { image: TINY_PNG_BASE64, mimeType: 'image/png' },
    });
    expect(res.statusCode).toBe(404);
    const body = res.json() as { error: string };
    expect(body.error).toBe('Diagram not found');
  });

  it('400 for empty body (no image field)', async () => {
    const diagram = await createEmptyDiagram();
    const res = await app.inject({
      method: 'POST',
      url: `/diagrams/${diagram.id}/photo`,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: string };
    expect(body.error).toMatch(/image/);
  });

  it('400 for empty string image', async () => {
    const diagram = await createEmptyDiagram();
    const res = await app.inject({
      method: 'POST',
      url: `/diagrams/${diagram.id}/photo`,
      payload: { image: '' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('400 for non-image base64 (PDF magic bytes)', async () => {
    const diagram = await createEmptyDiagram();
    const res = await app.inject({
      method: 'POST',
      url: `/diagrams/${diagram.id}/photo`,
      payload: { image: PDF_BASE64, mimeType: 'image/png' },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: string };
    expect(body.error).toMatch(/PDF/);
  });

  it('413 for oversized image', async () => {
    const diagram = await createEmptyDiagram();
    // 10 MB + 1 byte
    const oversized = Buffer.alloc(10 * 1024 * 1024 + 1, 0x00);
    // Prepend PNG magic so magic-bytes check passes after size check.
    oversized[0] = 0x89;
    oversized[1] = 0x50;
    oversized[2] = 0x4e;
    oversized[3] = 0x47;
    const res = await app.inject({
      method: 'POST',
      url: `/diagrams/${diagram.id}/photo`,
      payload: { image: oversized.toString('base64'), mimeType: 'image/png' },
    });
    expect(res.statusCode).toBe(413);
    const body = res.json() as { error: string };
    expect(body.error).toMatch(/too large/i);
  });

  it('409 when a job is already in flight for the same diagram (backpressure)', async () => {
    const diagram = await createEmptyDiagram();

    // Manually create a job in the registry that blocks the diagram.
    const blockingJob = jobRegistry.create(diagram.id);
    // Job is now in 'queued' state — findActiveByDiagramId will find it.

    try {
      const res = await app.inject({
        method: 'POST',
        url: `/diagrams/${diagram.id}/photo`,
        payload: { image: TINY_PNG_BASE64, mimeType: 'image/png' },
      });
      expect(res.statusCode).toBe(409);
      const body = res.json() as { error: string; jobId: string };
      expect(body.error).toMatch(/already in progress/i);
      expect(body.jobId).toBe(blockingJob.id);
    } finally {
      // Clean up the blocking job.
      jobRegistry.clear();
    }
  });

  // ── 16.5: Golden end-to-end extraction via FakeVision ──────────────────

  it('golden extraction: image bytes → FakeVision → job → schema-valid BatchDelta consumable by core', async () => {
    const diagram = await createEmptyDiagram();

    const postRes = await app.inject({
      method: 'POST',
      url: `/diagrams/${diagram.id}/photo`,
      payload: { image: TINY_PNG_BASE64, mimeType: 'image/png' },
    });
    expect(postRes.statusCode).toBe(202);
    const { jobId } = postRes.json() as { jobId: string };

    const getRes = await app.inject({
      method: 'GET',
      url: `/diagrams/${diagram.id}/photo/${jobId}`,
    });
    expect(getRes.statusCode).toBe(200);
    const body = getRes.json() as {
      status: string;
      batch?: BatchDelta;
      warnings?: string[];
    };
    expect(body.status).toBe('succeeded');
    expect(body.batch).toBeDefined();

    // CRITICAL: the batch must be parseable by the core BatchDeltaSchema.
    const parsed = BatchDeltaSchema.parse(body.batch);
    expect(parsed.kind).toBe('batch');
    expect(parsed.diagramId).toBe(diagram.id);
    expect(parsed.deltas.length).toBeGreaterThan(0);

    // Every delta is a class create — the FakeVision golden fixture.
    for (const delta of parsed.deltas) {
      expect(delta.kind).toBe('class');
      expect(delta.op).toBe('create');
    }

    // The extracted class names match the FakeVision fixture.
    const classNames = parsed.deltas
      .filter((d) => d.kind === 'class' && d.op === 'create')
      .map((d) => (d as any).name)
      .sort();
    expect(classNames).toEqual(['Customer', 'Order', 'Product']);
  });
});
