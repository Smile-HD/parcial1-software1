/**
 * Adaptadores STT (PR 8, tarea 8.1).
 *
 * voice:R1 — la transcripción utiliza una API STT EXISTENTE (OpenAI Whisper); este
 * paquete no implementa ningún modelo acústico. Las fallas de transporte/configuración
 * se exponen como `SttUnavailableError` para que los invocadores puedan distinguir
 * "el usuario debe usar entrada de texto" de un rechazo de interpretación.
 *
 * - `FakeStt` — determinista, sin red: retorna una transcripción configurada
 *   (por defecto: la elocución canónica de demostración) o lanza un error configurado
 *   para probar rutas de caída fuera de línea.
 * - `WhisperStt` — adaptador de `/audio/transcriptions` compatible con OpenAI.
 */
import type { SttPort } from '@app/core';

/** Se lanza cuando el proveedor STT es inalcanzable o está mal configurado (voice:R1). */
export class SttUnavailableError extends Error {
  constructor(message = 'Speech-to-text service is unavailable') {
    super(message);
    this.name = 'SttUnavailableError';
  }
}

export interface FakeSttOptions {
  /** Transcripción retornada en cada llamada. Por defecto: elocución canónica de demo. */
  transcript?: string | undefined;
  /** Si se define, transcribe() rechaza con este error (simulación de interrupción de servicio). */
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
  /** Por defecto: https://api.openai.com/v1 — sobreescribir para gateways compatibles. */
  baseUrl?: string | undefined;
  /** Por defecto: whisper-1. */
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
