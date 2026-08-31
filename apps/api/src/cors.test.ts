/**
 * CORS wiring test — the web editor is a separate origin (Vite :5173 in dev)
 * and must be able to call this API cross-origin. Exercises the REAL buildApp
 * (index.test.ts builds its own instance).
 */
import { afterAll, describe, expect, it } from 'vitest';

import { buildApp, closePool } from './index.js';

describe('CORS (browser cross-origin access)', () => {
  afterAll(async () => {
    await closePool();
  });

  it('answers the preflight with CORS headers for the requesting origin', async () => {
    const app = buildApp({ logger: false });

    const res = await app.inject({
      method: 'OPTIONS',
      url: '/diagrams/11111111-2222-4333-8444-555555555555',
      headers: {
        origin: 'http://localhost:5173',
        // PUT is the save path (editor:R5) and is NOT in @fastify/cors's
        // default allow-list — this assertion guards that regression.
        'access-control-request-method': 'PUT',
        'access-control-request-headers': 'content-type',
      },
    });

    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(String(res.headers['access-control-allow-methods'])).toContain('PUT');

    await app.close();
  });

  it('reflects the origin on actual responses so the browser accepts the body', async () => {
    const app = buildApp({ logger: false });

    const res = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'http://localhost:5173' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');

    await app.close();
  });
});
