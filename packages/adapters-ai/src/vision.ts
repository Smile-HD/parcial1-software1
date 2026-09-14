/**
 * Adaptadores de visión (PR 16, tarea 16.2).
 *
 * photo:R1 — la extracción produce un JSON validado por esquema (BatchDelta) a partir
 * de una imagen. Las respuestas en prosa o fuera de esquema DEBEN ser rechazadas.
 *
 * - `FakeVision` — determinista, sin red: retorna un fixture de referencia (golden)
 *   (batch delta válido de 3 clases) o modos de invalidez forzada / cero elementos.
 * - `OpenAiVision` — adaptador multimodal compatible con OpenAI (gpt-4o-mini
 *   con entrada de imagen). El JSON retornado SIEMPRE es validado con Zod por el
 *   invocador (misma disciplina que OpenAiLlm / interpreter:R1).
 */
import type { VisionPort } from '@app/core';
import { BatchDeltaSchema, type BatchDelta } from '@app/core';

// ── Error ───────────────────────────────────────────────────────────────────

/** Se lanza cuando el proveedor de visión es inalcanzable o retorna una salida inválida. */
export class VisionExtractionError extends Error {
  constructor(message = 'Vision extraction failed') {
    super(message);
    this.name = 'VisionExtractionError';
  }
}

// ── FakeVision ──────────────────────────────────────────────────────────────

export interface FakeVisionOptions {
  /** Si es true, extract() lanza VisionExtractionError (servicio inalcanzable). */
  forceInvalid?: boolean;
  /** Si es true, extract() retorna un lote vacío (extracción con cero elementos). */
  zeroElements?: boolean;
}

/**
 * Fake determinista para pruebas y desarrollo sin conexión. Retorna un lote delta
 * de referencia de 3 clases por defecto; configurable para fallar o retornar cero elementos.
 */
export class FakeVision implements VisionPort {
  private readonly forceInvalid: boolean;
  private readonly zeroElements: boolean;
  private readonly fixture: BatchDelta;

  constructor(options: FakeVisionOptions = {}) {
    this.forceInvalid = options.forceInvalid ?? false;
    this.zeroElements = options.zeroElements ?? false;

    // Construye el fixture de referencia una sola vez con UUIDs válidos al instanciar.
    const batchId = crypto.randomUUID();
    const diagramId = crypto.randomUUID();
    const ts = '2026-01-01T00:00:00.000Z';
    this.fixture = {
      kind: 'batch',
      id: batchId,
      diagramId,
      timestamp: ts,
      deltas: this.zeroElements ? [] : [
        {
          kind: 'class', op: 'create',
          id: crypto.randomUUID(), diagramId, timestamp: ts,
          classId: crypto.randomUUID(), name: 'Customer', position: { x: 100, y: 100 },
        },
        {
          kind: 'class', op: 'create',
          id: crypto.randomUUID(), diagramId, timestamp: ts,
          classId: crypto.randomUUID(), name: 'Order', position: { x: 250, y: 100 },
        },
        {
          kind: 'class', op: 'create',
          id: crypto.randomUUID(), diagramId, timestamp: ts,
          classId: crypto.randomUUID(), name: 'Product', position: { x: 400, y: 100 },
        },
      ],
    };
  }

  async extract(_image: Uint8Array, _mimeType: string): Promise<BatchDelta> {
    if (this.forceInvalid) {
      throw new VisionExtractionError('Simulated vision failure');
    }
    return structuredClone(this.fixture);
  }
}

// ── OpenAiVision ────────────────────────────────────────────────────────────

export interface OpenAiVisionConfig {
  apiKey: string;
  /** Por defecto: https://api.openai.com/v1 — sobreescribir para gateways compatibles. */
  baseUrl?: string;
  /** Por defecto: gpt-4o-mini. */
  model?: string;
}

/**
 * Adaptador de visión multimodal compatible con OpenAI. Envía la imagen como
 * mensaje de usuario con la parte de contenido image_url y espera una respuesta JSON
 * analizable a un BatchDelta. El invocador DEBE validar el resultado con Zod
 * (misma disciplina que OpenAiLlm — photo:R1).
 */
export class OpenAiVision implements VisionPort {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;

  constructor(config: OpenAiVisionConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl ?? 'https://api.openai.com/v1';
    this.model = config.model ?? 'gpt-4o-mini';
  }

  static fromEnv(): OpenAiVision | null {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return null;
    return new OpenAiVision({
      apiKey,
      baseUrl: process.env.OPENAI_BASE_URL,
      model: process.env.VISION_MODEL,
    });
  }

  async extract(image: Uint8Array, mimeType: string): Promise<BatchDelta> {
    const dataUrl = `data:${mimeType};base64,${Buffer.from(image).toString('base64')}`;

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          response_format: { type: 'json_object' },
          messages: [
            {
              role: 'system',
              content: [
                'You extract UML class diagrams from photographs.',
                'Return ONLY a valid JSON object matching the BatchDelta schema:',
                '{"kind":"batch","id":"<uuid>","diagramId":"<uuid>","timestamp":"<RFC3339>","deltas":[...]}',
                'Each delta must be a class create with name and position.',
                'Do NOT return prose. Do NOT explain. Return ONLY the JSON.',
              ].join('\n'),
            },
            {
              role: 'user',
              content: [
                { type: 'text', text: 'Extract UML classes from this diagram photo.' },
                { type: 'image_url', image_url: { url: dataUrl } },
              ],
            },
          ],
        }),
      });
    } catch (error) {
      throw new VisionExtractionError(
        `Vision request failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }

    if (!response.ok) {
      throw new VisionExtractionError(`Vision request failed with status ${response.status}`);
    }

    const payload = (await response.json().catch(() => null)) as {
      choices?: { message?: { content?: string } }[];
    } | null;

    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      throw new VisionExtractionError('Vision response had no message content');
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new VisionExtractionError('Vision returned non-JSON content');
    }

    // Valida contra el esquema canónico BatchDelta (compuerta photo:R1)
    const result = BatchDeltaSchema.safeParse(parsed);
    if (!result.success) {
      throw new VisionExtractionError(
        `Vision response is not a valid extraction: ${result.error.issues.map((i) => i.message).join('; ')}`,
      );
    }

    return result.data;
  }
}
