/**
 * STT adapters (PR 8, task 8.1).
 *
 * voice:R1 — transcription uses an EXISTING STT API (OpenAI Whisper); this
 * package implements no acoustic model. Transport/configuration failures are
 * surfaced as `SttUnavailableError` so callers can distinguish "the user
 * must use text input" from an interpretation refusal.
 *
 * - `FakeStt` — deterministic, zero-network: returns a configured transcript
 *   (default: the canonical demo utterance) or throws a configured error so
 *   outage paths are testable offline.
 * - `WhisperStt` — OpenAI-compatible `/audio/transcriptions` adapter.
 */
import type { SttPort } from '@app/core';

/** Raised when the STT provider is unreachable or misconfigured (voice:R1). */
export class SttUnavailableError extends Error {
  constructor(message = 'Speech-to-text service is unavailable') {
    super(message);
    this.name = 'SttUnavailableError';
  }
}

export interface FakeSttOptions {
  /** Transcript returned on every call. Default: canonical demo utterance. */
  transcript?: string | undefined;
  /** When set, transcribe() rejects with this error (outage simulation). */
  error?: Error | undefined;
}

export class FakeStt implements SttPort {
  private readonly transcript: string;
  private readonly error: Error | undefined;

  constructor(options: FakeSttOptions = {}) {
    this.transcript = options.transcript ?? 'add a class Invoice';
    this.error = options.error;
  }

  async transcribe(_audio: Uint8Array, _mimeType: string): Promise<string> {
    if (this.error) {
      throw this.error;
    }
    return this.transcript;
  }
}

export interface WhisperSttConfig {
  apiKey: string;
  /** Default: https://api.openai.com/v1 — override for compatible gateways. */
  baseUrl?: string | undefined;
  /** Default: whisper-1. */
  model?: string | undefined;
}

export class WhisperStt implements SttPort {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;

  constructor(config: WhisperSttConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl ?? 'https://api.openai.com/v1';
    this.model = config.model ?? 'whisper-1';
  }

  static fromEnv(): WhisperStt | null {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return null;
    return new WhisperStt({
      apiKey,
      baseUrl: process.env.OPENAI_BASE_URL,
      model: process.env.WHISPER_MODEL,
    });
  }

  async transcribe(audio: Uint8Array, mimeType: string): Promise<string> {
    const extension = mimeType.split('/')[1]?.split(';')[0] ?? 'webm';
    const form = new FormData();
    form.set('file', new File([new Uint8Array(audio)], `audio.${extension}`, { type: mimeType }));
    form.set('model', this.model);

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/audio/transcriptions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.apiKey}` },
        body: form,
      });
    } catch (error) {
      throw new SttUnavailableError(
        `Speech-to-text request failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }

    if (!response.ok) {
      throw new SttUnavailableError(`Speech-to-text request failed with status ${response.status}`);
    }

    const payload = (await response.json().catch(() => null)) as { text?: unknown } | null;
    if (payload === null || typeof payload.text !== 'string') {
      throw new SttUnavailableError('Speech-to-text response had no transcript');
    }
    return payload.text;
  }
}
