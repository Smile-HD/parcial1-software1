/**
 * Vision adapters (PR 16, task 16.2) — unit tests.
 *
 * photo:R1 — extraction JSON schema validated; prose rejected.
 * - FakeVision: deterministic, zero-network, golden fixture.
 * - OpenAiVision: real multimodal adapter (env-configured).
 */
import { describe, expect, it, vi, afterEach } from 'vitest';

import { FakeVision, VisionExtractionError, OpenAiVision } from './vision.js';
import { BatchDeltaSchema, type BatchDelta } from '@app/core';

// No static fixture — FakeVision generates valid UUIDs at construction time.

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_BASE_URL;
  delete process.env.VISION_MODEL;
});

describe('FakeVision', () => {
  it('returns a deterministic golden extraction (3 classes)', async () => {
    const vision = new FakeVision();
    const result = await vision.extract(new Uint8Array([0x89]), 'image/png');
    expect(result.kind).toBe('batch');
    if (result.kind !== 'batch') return;
    // FakeVision returns 3 classes by default
    expect(result.deltas.length).toBeGreaterThanOrEqual(3);
    const classes = result.deltas.filter((d) => d.kind === 'class' && d.op === 'create');
    expect(classes.length).toBe(3);
  });

  it('returns extraction that validates against BatchDeltaSchema', async () => {
    const vision = new FakeVision();
    const result = await vision.extract(new Uint8Array([0x89]), 'image/png');
    const parsed = BatchDeltaSchema.parse(result);
    expect(parsed.kind).toBe('batch');
  });

  it('forces zero-element mode when configured', async () => {
    const vision = new FakeVision({ zeroElements: true });
    const result = await vision.extract(new Uint8Array([0x89]), 'image/png');
    expect(result.kind).toBe('batch');
    if (result.kind !== 'batch') return;
    expect(result.deltas).toHaveLength(0);
  });

  it('throws VisionExtractionError when configured for forced-invalid', async () => {
    const vision = new FakeVision({ forceInvalid: true });
    await expect(vision.extract(new Uint8Array([0x89]), 'image/png')).rejects.toThrow(VisionExtractionError);
  });

  it('returns the same fixture on every call (deterministic)', async () => {
    const vision = new FakeVision();
    const r1 = await vision.extract(new Uint8Array([0x89]), 'image/png');
    const r2 = await vision.extract(new Uint8Array([0x89]), 'image/png');
    expect(r1).toEqual(r2);
  });
});

describe('OpenAiVision', () => {
  it('fromEnv returns null without an API key', () => {
    expect(OpenAiVision.fromEnv()).toBeNull();
  });

  it('fromEnv builds an adapter from OPENAI_API_KEY', () => {
    process.env.OPENAI_API_KEY = 'test-key';
    expect(OpenAiVision.fromEnv()).not.toBeNull();
  });

  it('posts image to /chat/completions with vision model and returns parsed extraction', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    const mockBatch: BatchDelta = {
      kind: 'batch',
      id: crypto.randomUUID(),
      diagramId: crypto.randomUUID(),
      timestamp: '2026-01-01T00:00:00.000Z',
      deltas: [
        {
          kind: 'class',
          op: 'create',
          id: crypto.randomUUID(),
          diagramId: crypto.randomUUID(),
          timestamp: '2026-01-01T00:00:00.000Z',
          classId: crypto.randomUUID(),
          name: 'Extracted',
          position: { x: 0, y: 0 },
        },
      ],
    };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(mockBatch) } }] }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const vision = OpenAiVision.fromEnv()!;
    const result = await vision.extract(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), 'image/png');

    expect(result.kind).toBe('batch');
    if (result.kind !== 'batch') return;
    expect(result.deltas).toHaveLength(1);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer test-key');

    const body = JSON.parse(init.body as string) as { model: string; messages: unknown[] };
    expect(body.model).toBe('gpt-4o-mini');
    expect(body.messages).toHaveLength(2);
    const userMsg = body.messages[1] as { role: string; content: unknown[] };
    expect(userMsg.role).toBe('user');
    // User message should be an array with text + image
    expect(Array.isArray(userMsg.content)).toBe(true);
  });

  it('throws VisionExtractionError on non-OK responses', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('rate limited', { status: 429 })));
    const vision = OpenAiVision.fromEnv()!;
    await expect(vision.extract(new Uint8Array([0x89]), 'image/png')).rejects.toThrow(VisionExtractionError);
  });

  it('throws VisionExtractionError when response is not a valid batch schema', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: 'Here is the class diagram description: ...' } }] }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const vision = OpenAiVision.fromEnv()!;
    await expect(vision.extract(new Uint8Array([0x89]), 'image/png')).rejects.toThrow(VisionExtractionError);
  });

  it('throws VisionExtractionError on network failure', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    const vision = OpenAiVision.fromEnv()!;
    await expect(vision.extract(new Uint8Array([0x89]), 'image/png')).rejects.toThrow(VisionExtractionError);
  });
});
