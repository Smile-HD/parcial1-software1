/**
 * Vision adapters (PR 16, task 16.2).
 *
 * photo:R1 — extraction produces schema-validated JSON (BatchDelta) from
 * an image. Prose or non-schema responses MUST be rejected.
 *
 * - `FakeVision` — deterministic, zero-network: returns a golden fixture
 *   (valid 3-class batch delta) or forced-invalid / zero-element modes.
 * - `OpenAiVision` — OpenAI-compatible multimodal adapter (gpt-4o-mini
 *   with image input). The returned JSON is ALWAYS Zod-validated by the
 *   caller (same discipline as OpenAiLlm / interpreter:R1).
 */
import type { VisionPort } from '@app/core';
import { BatchDeltaSchema, type BatchDelta } from '@app/core';

// ── Error ───────────────────────────────────────────────────────────────────

/** Raised when the vision provider is unreachable or returns invalid output. */
export class VisionExtractionError extends Error {
  constructor(message = 'Vision extraction failed') {
    super(message);
    this.name = 'VisionExtractionError';
  }
}

// ── FakeVision ──────────────────────────────────────────────────────────────

export interface FakeVisionOptions {
  /** When true, extract() throws VisionExtractionError (unreachable service). */
  forceInvalid?: boolean;
  /** When true, extract() returns an empty batch (zero-element extraction). */
  zeroElements?: boolean;
}

/**
 * Deterministic fake for tests and offline dev. Returns a golden 3-class
 * batch delta by default; configurable to fail or return zero elements.
 */
export class FakeVision implements VisionPort {
  private readonly forceInvalid: boolean;
  private readonly zeroElements: boolean;
  private readonly fixture: BatchDelta;

  constructor(options: FakeVisionOptions = {}) {
    this.forceInvalid = options.forceInvalid ?? false;
    this.zeroElements = options.zeroElements ?? false;

    // Build the golden fixture once with valid UUIDs at construction time.
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
  /** Default: https://api.openai.com/v1 — override for compatible gateways. */
  baseUrl?: string;
  /** Default: gpt-4o-mini. */
  model?: string;
}

/**
 * OpenAI-compatible multimodal vision adapter. Sends the image as a
 * user message with image_url content part and expects a JSON response
 * that parses into a BatchDelta. Caller MUST Zod-validate the result
 * (same discipline as OpenAiLlm — photo:R1).
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

    // Validate against the canonical BatchDelta schema (photo:R1 gate)
    const result = BatchDeltaSchema.safeParse(parsed);
    if (!result.success) {
      throw new VisionExtractionError(
        `Vision response is not a valid extraction: ${result.error.issues.map((i) => i.message).join('; ')}`,
      );
    }

    return result.data;
  }
}
