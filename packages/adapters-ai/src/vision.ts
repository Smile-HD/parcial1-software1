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

import { repairModelIdentifiers, UUID_RE, RFC3339_RE } from './repair.js';

// ── Helpers de limpieza, normalización y reparación de salida ───────────────

/**
 * Limpia y aísla la carga JSON descartando bloques de código markdown
 * o preámbulos/postámbulos conversacionales.
 */
export function cleanAndExtractJson(text: string): string {
  let cleaned = text.trim();
  // Extrae el bloque de código markdown si está presente (```json ... ``` o ``` ... ```)
  const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenceMatch?.[1]) {
    cleaned = fenceMatch[1].trim();
  }
  // Encuentra el objeto JSON delimitado por el primer '{' y último '}'
  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace >= firstBrace) {
    cleaned = cleaned.slice(firstBrace, lastBrace + 1);
  }
  return cleaned;
}

/**
 * Normaliza la carga cruda del lote:
 * - Asegura campos base de lote (kind: 'batch', id, diagramId, timestamp, deltas)
 * - Mapea nombres de clase utilizados como extremos de relaciones/miembros a sus IDs reales
 * - Asigna coordenadas de lienzo razonables por defecto si faltan
 * - Regenera IDs malformados a UUIDs válidos mediante repairModelIdentifiers
 */
export function normalizeBatchPayload(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null) return raw;
  const obj = raw as Record<string, unknown>;

  // Si la carga no tiene forma de lote ni deltas, se preserva para que la compuerta de esquema falle
  if (!Array.isArray(obj.deltas) && obj.kind !== 'batch') {
    return raw;
  }

  const batchId = typeof obj.id === 'string' && UUID_RE.test(obj.id) ? obj.id : crypto.randomUUID();
  const diagramId =
    typeof obj.diagramId === 'string' && UUID_RE.test(obj.diagramId) ? obj.diagramId : crypto.randomUUID();
  const timestamp =
    typeof obj.timestamp === 'string' && RFC3339_RE.test(obj.timestamp)
      ? obj.timestamp
      : new Date().toISOString();

  const rawDeltas = Array.isArray(obj.deltas) ? obj.deltas : [];

  // 1. Identifica todas las clases para crear un mapa de nombres a IDs
  const nameToId = new Map<string, string>();
  let classIndex = 0;
  for (const item of rawDeltas) {
    if (typeof item === 'object' && item !== null) {
      const d = item as Record<string, unknown>;
      if (d.kind === 'class' && d.op === 'create') {
        const classId =
          typeof d.classId === 'string' && d.classId.trim().length > 0
            ? d.classId
            : typeof d.name === 'string' && d.name.trim().length > 0
            ? d.name
            : `class_${classIndex + 1}`;
        d.classId = classId;
        if (typeof d.name === 'string') {
          nameToId.set(d.name.toLowerCase().trim(), classId);
          nameToId.set(d.name.trim(), classId);
        }
        nameToId.set(classId.toLowerCase().trim(), classId);
        nameToId.set(classId.trim(), classId);
        classIndex++;
      }
    }
  }

  // 2. Resuelve referencias y asegura posiciones para cada delta
  let placedCount = 0;
  const normalizedDeltas = rawDeltas.map((item) => {
    if (typeof item !== 'object' || item === null) return item;
    const d = { ...(item as Record<string, unknown>) };

    d.id = typeof d.id === 'string' && UUID_RE.test(d.id) ? d.id : crypto.randomUUID();
    d.diagramId = diagramId;
    d.timestamp =
      typeof d.timestamp === 'string' && RFC3339_RE.test(d.timestamp) ? d.timestamp : timestamp;

    const resolveId = (idCandidate: unknown): unknown => {
      if (typeof idCandidate !== 'string') return idCandidate;
      const key = idCandidate.trim();
      return nameToId.get(key.toLowerCase()) ?? nameToId.get(key) ?? idCandidate;
    };

    if (d.kind === 'class' && d.op === 'create') {
      const pos = d.position as Record<string, unknown> | undefined;
      if (
        !pos ||
        typeof pos !== 'object' ||
        typeof pos.x !== 'number' ||
        !Number.isFinite(pos.x) ||
        typeof pos.y !== 'number' ||
        !Number.isFinite(pos.y)
      ) {
        d.position = {
          x: 100 + (placedCount % 3) * 280,
          y: 100 + Math.floor(placedCount / 3) * 220,
        };
      }
      placedCount++;
    } else if (d.kind === 'member') {
      if (d.classId) d.classId = resolveId(d.classId);
    } else if (d.kind === 'association') {
      if (d.sourceClassId) d.sourceClassId = resolveId(d.sourceClassId);
      if (d.targetClassId) d.targetClassId = resolveId(d.targetClassId);
    } else if (d.kind === 'generalization') {
      if (d.subClassId) d.subClassId = resolveId(d.subClassId);
      if (d.superClassId) d.superClassId = resolveId(d.superClassId);
    } else if (d.kind === 'realization') {
      if (d.clientClassId) d.clientClassId = resolveId(d.clientClassId);
      if (d.supplierInterfaceId) d.supplierInterfaceId = resolveId(d.supplierInterfaceId);
    } else if (d.kind === 'dependency') {
      if (d.clientClassId) d.clientClassId = resolveId(d.clientClassId);
      if (d.supplierClassId) d.supplierClassId = resolveId(d.supplierClassId);
    } else if (d.kind === 'naryAssociation' && Array.isArray(d.memberEnds)) {
      d.memberEnds = (d.memberEnds as Record<string, unknown>[]).map((end) => ({
        ...end,
        classId: resolveId(end.classId),
      }));
    }

    return d;
  });

  const normalizedBatch = {
    kind: 'batch',
    id: batchId,
    diagramId,
    timestamp,
    deltas: normalizedDeltas,
  };

  return repairModelIdentifiers(normalizedBatch);
}

const SYSTEM_PROMPT = [
  'You are an expert software architect and computer vision specialist extracting UML class diagrams from images.',
  'The image can be EITHER a hand-drawn diagram (whiteboard photo, sketch on paper, napkin, notebook doodle) OR a digital diagram exported from software (draw.io, StarUML, PlantUML, Enterprise Architect, Lucidchart, Miro).',
  '',
  'Your task is to accurately transcribe ALL UML diagram elements into a structured JSON object matching the BatchDelta schema.',
  '',
  '### Detection Guidelines:',
  '1. Hand-drawn sketches & Whiteboards:',
  '   - Read handwritten text carefully. Transcribe class names in PascalCase (e.g. "Customer", "Order", "Product").',
  '   - Interpret informal boxes as classes or interfaces (look for <<interface>> or <<abstract>> markers).',
  '   - Parse arrows and lines even if wavy: solid line with open triangle = generalization (inheritance); dashed line with triangle = realization; dashed line with arrow = dependency; solid line with diamond = aggregation/composition; simple line = association.',
  '2. Software-generated diagrams:',
  '   - Read 3-compartment boxes: top = class name, middle = attributes, bottom = methods.',
  '   - Interpret UML visibility markers: "+" = public, "-" = private, "#" = protected, "~" = package.',
  '   - Extract attribute types (e.g. "- id: Long", "+ name: String") and method signatures (e.g. "+ calculateTotal(tax: Double): Double").',
  '   - Extract multiplicities on association ends (e.g. "1", "0..1", "*", "1..*").',
  '',
  '### BatchDelta JSON Output Structure:',
  '{',
  '  "kind": "batch",',
  '  "id": "<uuid>",',
  '  "diagramId": "<uuid>",',
  '  "timestamp": "<RFC3339 datetime>",',
  '  "deltas": [',
  '    // For every class/interface:',
  '    { "kind": "class", "op": "create", "id": "<uuid>", "diagramId": "<uuid>", "timestamp": "<RFC3339>", "classId": "<uuid-or-name>", "name": "ClassName", "position": { "x": 100, "y": 100 }, "classKind": "class", "isAbstract": false },',
  '    // For every attribute:',
  '    { "kind": "member", "op": "addAttribute", "id": "<uuid>", "diagramId": "<uuid>", "timestamp": "<RFC3339>", "classId": "<classId>", "memberId": "<uuid>", "name": "attrName", "type": "String", "visibility": "+" },',
  '    // For every method:',
  '    { "kind": "member", "op": "addMethod", "id": "<uuid>", "diagramId": "<uuid>", "timestamp": "<RFC3339>", "classId": "<classId>", "memberId": "<uuid>", "name": "methodName", "returnType": "void", "parameters": [{ "name": "param1", "type": "String" }], "visibility": "+" },',
  '    // For associations:',
  '    { "kind": "association", "op": "create", "id": "<uuid>", "diagramId": "<uuid>", "timestamp": "<RFC3339>", "associationId": "<uuid>", "sourceClassId": "<classId>", "targetClassId": "<classId>", "sourceMultiplicity": "1", "targetMultiplicity": "*", "directed": true },',
  '    // For inheritance (subClass extends superClass):',
  '    { "kind": "generalization", "op": "create", "id": "<uuid>", "diagramId": "<uuid>", "timestamp": "<RFC3339>", "generalizationId": "<uuid>", "subClassId": "<subClassId>", "superClassId": "<superClassId>" },',
  '    // For interface implementation:',
  '    { "kind": "realization", "op": "create", "id": "<uuid>", "diagramId": "<uuid>", "timestamp": "<RFC3339>", "realizationId": "<uuid>", "clientClassId": "<classId>", "supplierInterfaceId": "<interfaceId>" },',
  '    // For dependencies:',
  '    { "kind": "dependency", "op": "create", "id": "<uuid>", "diagramId": "<uuid>", "timestamp": "<RFC3339>", "dependencyId": "<uuid>", "clientClassId": "<classId>", "supplierClassId": "<classId>" }',
  '  ]',
  '}',
  '',
  'CRITICAL: Return ONLY valid JSON. No conversational text, no markdown explanation, no prose.',
].join('\n');

// ── OpenAiVision ────────────────────────────────────────────────────────────

export interface OpenAiVisionConfig {
  apiKey: string;
  /** Por defecto: https://api.openai.com/v1 — sobreescribir para gateways compatibles. */
  baseUrl?: string | undefined;
  /** Por defecto: gpt-4o-mini. */
  model?: string | undefined;
  /** Intentos máximos en caso de error de esquema (por defecto 2). */
  maxAttempts?: number | undefined;
}

/**
 * Adaptador de visión multimodal compatible con OpenAI. Envía la imagen como
 * mensaje de usuario con la parte de contenido image_url y espera una respuesta JSON
 * analizable a un BatchDelta. Incluye canal de limpieza, resolución de referencias,
 * normalización de UUIDs y reintento con autorrecuperación.
 */
export class OpenAiVision implements VisionPort {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly maxAttempts: number;

  constructor(config: OpenAiVisionConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl ?? 'https://api.openai.com/v1';
    this.model = config.model ?? 'gpt-4o-mini';
    this.maxAttempts = config.maxAttempts ?? 2;
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

    const messages: { role: string; content: unknown }[] = [
      {
        role: 'system',
        content: SYSTEM_PROMPT,
      },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'Extract all UML classes, members, and relationships from this diagram image.',
          },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      },
    ];

    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
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
            messages,
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
        const cleaned = cleanAndExtractJson(content);
        parsed = JSON.parse(cleaned);
      } catch {
        lastError = new VisionExtractionError('Vision returned non-JSON content');
        if (attempt < this.maxAttempts) {
          messages.push(
            { role: 'assistant', content },
            {
              role: 'user',
              content:
                'Your previous response was not valid JSON. Return ONLY a valid JSON object matching the BatchDelta schema.',
            },
          );
          continue;
        }
        throw lastError;
      }

      // Normaliza identificadores, referencias de nombres y coordenadas
      const normalized = normalizeBatchPayload(parsed);

      // Valida contra el esquema canónico BatchDelta (compuerta photo:R1)
      const result = BatchDeltaSchema.safeParse(normalized);
      if (result.success) {
        return result.data;
      }

      const issuesDigest = result.error.issues
        .map((i) => `${i.path.length > 0 ? i.path.join('.') : '/'}: ${i.message}`)
        .join('; ');
      lastError = new VisionExtractionError(`Vision response is not a valid extraction: ${issuesDigest}`);

      if (attempt < this.maxAttempts) {
        messages.push(
          { role: 'assistant', content },
          {
            role: 'user',
            content: `Your previous extraction had schema validation issues: ${issuesDigest}. Return ONLY the corrected JSON object matching the BatchDelta schema.`,
          },
        );
        continue;
      }
    }

    throw lastError ?? new VisionExtractionError('Vision extraction failed');
  }
}
