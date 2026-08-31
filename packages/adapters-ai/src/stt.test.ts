/**
 * STT adapters (PR 8, task 8.1) — unit tests.
 *
 * voice:R1 — the system transcribes via an existing STT API (Whisper) and
 * MUST NOT implement its own acoustic model; transport failures surface as
 * SttUnavailableError. The fake makes API/web tests deterministic offline.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FakeStt, SttUnavailableError, WhisperStt } from './stt.js';

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_BASE_URL;
  delete process.env.WHISPER_MODEL;
});

describe('FakeStt', () => {
  it('returns the configured transcript', async () => {
    const stt = new FakeStt({ transcript: 'add a class Invoice' });
    expect(await stt.transcribe(new Uint8Array([1, 2, 3]), 'audio/webm')).toBe('add a class Invoice');
  });

  it('defaults to a deterministic demo transcript', async () => {
    const stt = new FakeStt();
    expect(await stt.transcribe(new Uint8Array([1]), 'audio/webm')).toBe('add a class Invoice');
  });

  it('throws the configured error (outage simulation)', async () => {
    const stt = new FakeStt({ error: new SttUnavailableError('service down') });
    await expect(stt.transcribe(new Uint8Array([1]), 'audio/webm')).rejects.toThrow(SttUnavailableError);
  });
});

describe('WhisperStt', () => {
  it('fromEnv returns null without an API key', () => {
    expect(WhisperStt.fromEnv()).toBeNull();
  });

  it('fromEnv builds an adapter from OPENAI_API_KEY', () => {
    process.env.OPENAI_API_KEY = 'test-key';
    expect(WhisperStt.fromEnv()).not.toBeNull();
  });

  it('posts multipart audio to /audio/transcriptions and returns the transcript', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ text: 'add a class Invoice' }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const stt = WhisperStt.fromEnv()!;
    const transcript = await stt.transcribe(new TextEncoder().encode('fake-audio'), 'audio/webm');

    expect(transcript).toBe('add a class Invoice');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/audio/transcriptions');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer test-key');
    const form = init.body as FormData;
    expect(form.get('model')).toBe('whisper-1');
    const file = form.get('file') as File;
    expect(file.name).toBe('audio.webm');
    expect(file.type).toBe('audio/webm');
  });

  it('throws SttUnavailableError when the STT service is unreachable (voice:R1)', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('network down')));

    const stt = WhisperStt.fromEnv()!;
    await expect(stt.transcribe(new Uint8Array([1]), 'audio/webm')).rejects.toThrow(SttUnavailableError);
  });

  it('throws SttUnavailableError on non-OK responses', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 503 })));

    const stt = WhisperStt.fromEnv()!;
    await expect(stt.transcribe(new Uint8Array([1]), 'audio/webm')).rejects.toThrow(SttUnavailableError);
  });
});
