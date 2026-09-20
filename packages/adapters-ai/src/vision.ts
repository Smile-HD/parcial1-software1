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

  // 1. Identifica y de-duplica clases para crear un mapa de nombres a IDs
  const nameToId = new Map<string, string>();
  const seenClassNames = new Map<string, string>(); // lowercase name -> classId
  const validClassIds = new Set<string>();
  const deduplicatedClassDeltas: Record<string, unknown>[] = [];

  let classIndex = 0;
  for (const item of rawDeltas) {
    if (typeof item === 'object' && item !== null) {
      const d = { ...(item as Record<string, unknown>) };
      if (d.kind === 'class' && d.op === 'create') {
        const rawName = typeof d.name === 'string' ? d.name.trim() : '';
        const normName = rawName.toLowerCase();

        // Si ya vimos una clase con este mismo nombre en el lote, unificamos al primer classId
        if (normName && seenClassNames.has(normName)) {
          const existingId = seenClassNames.get(normName)!;
          if (typeof d.classId === 'string') {
            nameToId.set(d.classId.toLowerCase().trim(), existingId);
            nameToId.set(d.classId.trim(), existingId);
          }
          continue; // descartar la clase duplicada en el lote
        }

        const classId =
          typeof d.classId === 'string' && d.classId.trim().length > 0
            ? d.classId
            : rawName.length > 0
            ? rawName
            : `class_${classIndex + 1}`;
        d.classId = classId;

        if (rawName) {
          seenClassNames.set(normName, classId);
          nameToId.set(normName, classId);
          nameToId.set(rawName, classId);
        }
        nameToId.set(classId.toLowerCase().trim(), classId);
        nameToId.set(classId.trim(), classId);
        validClassIds.add(classId);
        deduplicatedClassDeltas.push(d);
        classIndex++;
      }
    }
  }

  // 2. Resuelve referencias a IDs conocidos con coincidencia flexible (prefijos, mayúsculas, plurales)
  const resolveId = (idCandidate: unknown): string | undefined => {
    if (typeof idCandidate !== 'string') return undefined;
    const raw = idCandidate.trim();
    if (!raw) return undefined;

    // Coincidencia directa o minúsculas
    const direct = nameToId.get(raw.toLowerCase()) ?? nameToId.get(raw);
    if (direct && (validClassIds.size === 0 || validClassIds.has(direct))) {
      return direct;
    }

    // Limpieza de prefijos comunes y signos de puntuación ("class User", "cls_User", "<<interface>> User", etc.)
    const cleanKey = raw
      .replace(/^(?:class_|cls_|class\s+|interface\s+|<<interface>>\s*|<<abstract>>\s*)/i, '')
      .replace(/[:"']/g, '')
      .trim()
      .toLowerCase();

    const cleanMatch = nameToId.get(cleanKey);
    if (cleanMatch && (validClassIds.size === 0 || validClassIds.has(cleanMatch))) {
      return cleanMatch;
    }

    // Normalización de plurales en español e inglés ("clientes" -> "cliente", "orders" -> "order")
    if (cleanKey.endsWith('es') && cleanKey.length > 3) {
      const singular = cleanKey.slice(0, -2);
      const m = nameToId.get(singular);
      if (m && (validClassIds.size === 0 || validClassIds.has(m))) return m;
    }
    if (cleanKey.endsWith('s') && cleanKey.length > 2) {
      const singular = cleanKey.slice(0, -1);
      const m = nameToId.get(singular);
      if (m && (validClassIds.size === 0 || validClassIds.has(m))) return m;
    }

    // Coincidencia por prefijo único si la longitud es suficiente (ej: "facturacion" -> "factura")
    if (cleanKey.length >= 3) {
      const matches: string[] = [];
      for (const [normName, cid] of seenClassNames.entries()) {
        if (normName === cleanKey || normName.startsWith(cleanKey) || cleanKey.startsWith(normName)) {
          if (!matches.includes(cid)) matches.push(cid);
        }
      }
      if (matches.length === 1) {
        return matches[0];
      }
    }

    if (validClassIds.size === 0) return raw;
    return validClassIds.has(raw) ? raw : undefined;
  };

  const multRegex = /^\*|^\d+$|^\d+\.\.\d+$|^\d+\.\.\*$/;
  const cleanMultiplicity = (val: unknown): string | undefined => {
    if (typeof val !== 'string') return undefined;
    let s = val.trim();
    if (!s) return undefined;
    // Normalizar N, n, M, m a comodín UML *
    s = s.replace(/\b[nNmM]\b/g, '*');
    s = s.replace(/\.\.[nNmM]/g, '..*');
    s = s.replace(/[nNmM]\.\./g, '*..');
    return multRegex.test(s) ? s : undefined;
  };

  let placedCount = 0;
  const normalizedClassDeltas = deduplicatedClassDeltas.map((d) => {
    d.id = typeof d.id === 'string' && UUID_RE.test(d.id) ? d.id : crypto.randomUUID();
    d.diagramId = diagramId;
    d.timestamp =
      typeof d.timestamp === 'string' && RFC3339_RE.test(d.timestamp) ? d.timestamp : timestamp;

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
    return d;
  });

  const memberDeltas: Record<string, unknown>[] = [];
  const generalizationDeltas: Record<string, unknown>[] = [];
  const realizationDeltas: Record<string, unknown>[] = [];
  const associationDeltas: Record<string, unknown>[] = [];
  const dependencyDeltas: Record<string, unknown>[] = [];
  const naryAssociationDeltas: Record<string, unknown>[] = [];
  const otherDeltas: Record<string, unknown>[] = [];

  for (const item of rawDeltas) {
    if (typeof item !== 'object' || item === null) continue;
    const d = { ...(item as Record<string, unknown>) };
    if (d.kind === 'class' && d.op === 'create') {
      continue; // ya procesadas y ordenadas arriba
    }

    d.id = typeof d.id === 'string' && UUID_RE.test(d.id) ? d.id : crypto.randomUUID();
    d.diagramId = diagramId;
    d.timestamp =
      typeof d.timestamp === 'string' && RFC3339_RE.test(d.timestamp) ? d.timestamp : timestamp;

    if (d.kind === 'member') {
      const resolvedClassId = resolveId(d.classId);
      if (resolvedClassId) {
        d.classId = resolvedClassId;
        memberDeltas.push(d);
      }
    } else if (d.kind === 'generalization') {
      const rawSub = d.subClassId ?? d.sub ?? d.child ?? d.source ?? d.sourceClassId;
      const rawSup = d.superClassId ?? d.super ?? d.parent ?? d.target ?? d.targetClassId;
      const sub = resolveId(rawSub);
      const sup = resolveId(rawSup);
      if (sub && sup && sub !== sup) {
        const cleanGen: Record<string, unknown> = {
          kind: 'generalization',
          op: 'create',
          id: d.id,
          diagramId: d.diagramId,
          timestamp: d.timestamp,
          generalizationId: typeof d.generalizationId === 'string' && UUID_RE.test(d.generalizationId)
            ? d.generalizationId
            : crypto.randomUUID(),
          subClassId: sub,
          superClassId: sup,
        };
        if (typeof d.name === 'string' && d.name.trim()) cleanGen.name = d.name.trim();
        generalizationDeltas.push(cleanGen);
      }
    } else if (d.kind === 'realization') {
      const rawClient = d.clientClassId ?? d.client ?? d.source ?? d.sourceClassId;
      const rawSupplier = d.supplierInterfaceId ?? d.supplier ?? d.interface ?? d.target ?? d.targetClassId;
      const client = resolveId(rawClient);
      const supplier = resolveId(rawSupplier);
      if (client && supplier) {
        const cleanReal: Record<string, unknown> = {
          kind: 'realization',
          op: 'create',
          id: d.id,
          diagramId: d.diagramId,
          timestamp: d.timestamp,
          realizationId: typeof d.realizationId === 'string' && UUID_RE.test(d.realizationId)
            ? d.realizationId
            : crypto.randomUUID(),
          clientClassId: client,
          supplierInterfaceId: supplier,
        };
        if (typeof d.name === 'string' && d.name.trim()) cleanReal.name = d.name.trim();
        realizationDeltas.push(cleanReal);
      }
    } else if (d.kind === 'association' || d.kind === 'composition' || d.kind === 'aggregation') {
      const rawSrc = d.sourceClassId ?? d.sourceId ?? d.source ?? d.from ?? d.clientClassId ?? d.client;
      const rawTgt = d.targetClassId ?? d.targetId ?? d.target ?? d.to ?? d.supplierClassId ?? d.supplier;
      const src = resolveId(rawSrc);
      const tgt = resolveId(rawTgt);
      if (src && tgt) {
        // Normalización de agregación y composición (reconoce sinónimos de LLM)
        const rawAgg = String(
          d.aggregation ??
          (d.kind === 'composition' ? 'composite' : d.kind === 'aggregation' ? 'shared' : ''),
        ).toLowerCase();

        let aggKind: 'none' | 'shared' | 'composite' = 'none';
        if (rawAgg === 'composite' || rawAgg === 'composition') {
          aggKind = 'composite';
        } else if (rawAgg === 'shared' || rawAgg === 'aggregation') {
          aggKind = 'shared';
        }

        const cleanAssoc: Record<string, unknown> = {
          kind: 'association',
          op: 'create',
          id: d.id,
          diagramId: d.diagramId,
          timestamp: d.timestamp,
          associationId: typeof d.associationId === 'string' && UUID_RE.test(d.associationId)
            ? d.associationId
            : crypto.randomUUID(),
          sourceClassId: src,
          targetClassId: tgt,
          directed: typeof d.directed === 'boolean' ? d.directed : true,
          aggregation: aggKind,
        };

        if (aggKind !== 'none') {
          cleanAssoc.aggregationEnd = d.aggregationEnd === 'target' ? 'target' : 'source';
        }

        const sm = cleanMultiplicity(d.sourceMultiplicity);
        if (sm) cleanAssoc.sourceMultiplicity = sm;
        const tm = cleanMultiplicity(d.targetMultiplicity);
        if (tm) cleanAssoc.targetMultiplicity = tm;

        if (typeof d.name === 'string' && d.name.trim()) cleanAssoc.name = d.name.trim();
        if (typeof d.sourceRole === 'string' && d.sourceRole.trim()) cleanAssoc.sourceRole = d.sourceRole.trim();
        if (typeof d.targetRole === 'string' && d.targetRole.trim()) cleanAssoc.targetRole = d.targetRole.trim();

        associationDeltas.push(cleanAssoc);
      }
    } else if (d.kind === 'dependency') {
      const rawClient = d.clientClassId ?? d.client ?? d.source ?? d.sourceClassId;
      const rawSupplier = d.supplierClassId ?? d.supplier ?? d.target ?? d.targetClassId;
      const client = resolveId(rawClient);
      const supplier = resolveId(rawSupplier);
      if (client && supplier) {
        const cleanDep: Record<string, unknown> = {
          kind: 'dependency',
          op: 'create',
          id: d.id,
          diagramId: d.diagramId,
          timestamp: d.timestamp,
          dependencyId: typeof d.dependencyId === 'string' && UUID_RE.test(d.dependencyId)
            ? d.dependencyId
            : crypto.randomUUID(),
          clientClassId: client,
          supplierClassId: supplier,
        };
        if (typeof d.name === 'string' && d.name.trim()) cleanDep.name = d.name.trim();
        dependencyDeltas.push(cleanDep);
      }
    } else if (d.kind === 'naryAssociation' && Array.isArray(d.memberEnds)) {
      const seenEnds = new Set<string>();
      const survivingEnds = (d.memberEnds as Record<string, unknown>[])
        .map((end) => {
          const cid = resolveId(end.classId);
          if (!cid || seenEnds.has(cid)) return null;
          seenEnds.add(cid);
          const mult = cleanMultiplicity(end.multiplicity) ?? '1';
          const role = typeof end.role === 'string' && end.role.trim() ? end.role.trim() : undefined;
          return {
            classId: cid,
            multiplicity: mult,
            ...(role ? { role } : {}),
          };
        })
        .filter((end): end is { classId: string; multiplicity: string; role?: string } => end !== null);
      if (survivingEnds.length >= 3) {
        d.memberEnds = survivingEnds;
        d.naryAssociationId = typeof d.naryAssociationId === 'string' && UUID_RE.test(d.naryAssociationId)
          ? d.naryAssociationId
          : crypto.randomUUID();
        if (typeof d.name === 'string' && d.name.trim()) d.name = d.name.trim();
        naryAssociationDeltas.push(d);
      }
    } else {
      otherDeltas.push(d);
    }
  }

  // Detección y colapso heurístico de rombos ternarios/n-arios:
  // CUIDADO CRÍTICO: SOLO colapsar clases cuyo nombre indique explícitamente que son un rombo o ternario
  // (ej. "diamond", "rombo", "ternario", "nary", "hub"). JAMÁS colapsar clases de dominio normales (Order, User, etc.)
  const classesWithMembers = new Set(memberDeltas.map((m) => m.classId as string));
  const candidateHubIndices: number[] = [];

  for (let i = 0; i < normalizedClassDeltas.length; i++) {
    const clsDelta = normalizedClassDeltas[i];
    const cid = clsDelta.classId as string;
    const name = String(clsDelta.name ?? '').toLowerCase();
    const hasMembers = classesWithMembers.has(cid);
    if (hasMembers) continue;

    // Solo candidatos con nombre explícito de rombo/ternario/nodo conector
    const isExplicitDiamond =
      name.includes('diamond') ||
      name.includes('rombo') ||
      name.includes('ternari') ||
      name.includes('nary') ||
      name.startsWith('hub') ||
      name === '';

    if (!isExplicitDiamond) continue;

    const connectedAssocs = associationDeltas.filter(
      (a) => a.sourceClassId === cid || a.targetClassId === cid,
    );

    if (connectedAssocs.length >= 2) {
      candidateHubIndices.push(i);
    }
  }

  // Convertir los hubs candidatos en naryAssociation y remover la clase y asociaciones binarias
  for (const hubIdx of candidateHubIndices.reverse()) {
    const hub = normalizedClassDeltas[hubIdx];
    const hubId = hub.classId as string;
    const hubAssocs = associationDeltas.filter(
      (a) => a.sourceClassId === hubId || a.targetClassId === hubId,
    );

    const seenClasses = new Set<string>();
    const memberEnds: { classId: string; multiplicity: string; role?: string }[] = [];

    for (const a of hubAssocs) {
      const isHubSource = a.sourceClassId === hubId;
      const targetCid = (isHubSource ? a.targetClassId : a.sourceClassId) as string;
      if (!targetCid || seenClasses.has(targetCid)) continue;
      seenClasses.add(targetCid);

      const mult = (isHubSource ? a.targetMultiplicity : a.sourceMultiplicity) as string | undefined;
      const role = (isHubSource ? a.targetRole : a.sourceRole) as string | undefined;
      const cleanMult = cleanMultiplicity(mult) ?? '1';

      memberEnds.push({
        classId: targetCid,
        multiplicity: cleanMult,
        ...(typeof role === 'string' && role.trim() ? { role: role.trim() } : {}),
      });
    }

    if (memberEnds.length >= 3) {
      normalizedClassDeltas.splice(hubIdx, 1);
      // Remover asociaciones binarias que conectaban con el hub
      for (let j = associationDeltas.length - 1; j >= 0; j--) {
        if (associationDeltas[j].sourceClassId === hubId || associationDeltas[j].targetClassId === hubId) {
          associationDeltas.splice(j, 1);
        }
      }
      naryAssociationDeltas.push({
        kind: 'naryAssociation',
        op: 'create',
        id: crypto.randomUUID(),
        diagramId,
        timestamp,
        naryAssociationId: crypto.randomUUID(),
        name: String(hub.name ?? '').replace(/diamond/gi, '').trim() || undefined,
        memberEnds,
      });
    }
  }

  // Orden topológico estricto para applyBatchDelta:
  // 1. Clases (para que existan en workingDiagram)
  // 2. Miembros (atributos y métodos que pertenecen a las clases)
  // 3. Generalizaciones
  // 4. Realizaciones
  // 5. Asociaciones
  // 6. Dependencias
  // 7. Asociaciones N-arias
  // 8. Otros deltas
  const normalizedDeltas = [
    ...normalizedClassDeltas,
    ...memberDeltas,
    ...generalizationDeltas,
    ...realizationDeltas,
    ...associationDeltas,
    ...dependencyDeltas,
    ...naryAssociationDeltas,
    ...otherDeltas,
  ];

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
  '   - Parse arrows and lines even if wavy or hand-drawn.',
  '2. Software-generated diagrams:',
  '   - Read 3-compartment boxes: top = class name, middle = attributes, bottom = methods.',
  '   - Interpret UML visibility markers: "+" = public, "-" = private, "#" = protected, "~" = package.',
  '   - Extract attribute types (e.g. "- id: Long", "+ name: String") and method signatures (e.g. "+ calculateTotal(tax: Double): Double").',
  '   - Extract multiplicities on association ends (e.g. "1", "0..1", "*", "1..*"). Standardize "N", "n", "M", "m" to "*".',
  '3. Exhaustive Connector Scanning (CRITICAL):',
  '   - Scan and trace EVERY line or arrow connecting boxes in the diagram. Do NOT omit any connection.',
  '   - Even simple plain lines without arrowheads or text represent binary associations between classes.',
  '4. Distinguishing Triangles vs Diamonds (CRITICAL - DO NOT CONFUSE):',
  '   - TRIANGLE AT ARROW TIP (3 vertices, closed hollow triangle pointing to parent):',
  '     * Solid line with hollow triangle: Generalization / Inheritance (`generalization`). "subClassId" is the child, "superClassId" is the parent. NEVER has multiplicities or aggregation.',
  '     * Dashed line with hollow triangle: Realization / Implementation (`realization`). "clientClassId" is the class, "supplierInterfaceId" is the interface. NEVER has multiplicities.',
  '     * Dashed line with open stick arrow: Dependency (`dependency`).',
  '   - DIAMOND AT CLASS END (4 vertices, lozenge attached directly to a class box):',
  '     * Hollow / white diamond at container class: Aggregation (`kind: "association"`, `"aggregation": "shared"`, `"aggregationEnd": "source"`).',
  '     * Filled / black diamond at container class: Composition (`kind: "association"`, `"aggregation": "composite"`, `"aggregationEnd": "source"`).',
  '     * Note: Aggregations and compositions are BINARY associations connecting exactly two classes, and CAN have multiplicities on ends.',
  '   - CENTRAL FLOATING DIAMOND (4 vertices, floating independently in the middle with 3+ lines to different classes):',
  '     * This is a Ternary or N-ary association (`kind: "naryAssociation"`).',
  '     * DO NOT create a class for the central diamond. Emit a delta with kind: "naryAssociation" and "memberEnds".',
  '5. Relationship Texts, Names & Roles:',
  '   - Extract labels or text along/above lines into "name" (e.g. "facturas", "productos", "registra", "subordinados", "manages").',
  '   - Extract role names placed at ends into "sourceRole" and "targetRole" (e.g. "jefe", "subordinados", "cliente", "compras").',
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
  '    // For standard associations:',
  '    { "kind": "association", "op": "create", "id": "<uuid>", "diagramId": "<uuid>", "timestamp": "<RFC3339>", "associationId": "<uuid>", "sourceClassId": "<classId>", "targetClassId": "<classId>", "name": "relationName", "sourceRole": "srcRole", "targetRole": "tgtRole", "sourceMultiplicity": "1", "targetMultiplicity": "*", "directed": true, "aggregation": "none" },',
  '    // For aggregation (hollow diamond at container):',
  '    { "kind": "association", "op": "create", "id": "<uuid>", "diagramId": "<uuid>", "timestamp": "<RFC3339>", "associationId": "<uuid>", "sourceClassId": "<containerClassId>", "targetClassId": "<partClassId>", "aggregation": "shared", "aggregationEnd": "source", "sourceMultiplicity": "1", "targetMultiplicity": "0..*" },',
  '    // For composition (solid diamond at container):',
  '    { "kind": "association", "op": "create", "id": "<uuid>", "diagramId": "<uuid>", "timestamp": "<RFC3339>", "associationId": "<uuid>", "sourceClassId": "<containerClassId>", "targetClassId": "<partClassId>", "aggregation": "composite", "aggregationEnd": "source", "sourceMultiplicity": "1", "targetMultiplicity": "1..*" },',
  '    // For inheritance (subClass extends superClass with closed triangle):',
  '    { "kind": "generalization", "op": "create", "id": "<uuid>", "diagramId": "<uuid>", "timestamp": "<RFC3339>", "generalizationId": "<uuid>", "subClassId": "<subClassId>", "superClassId": "<superClassId>", "name": "optionalLabel" },',
  '    // For interface implementation (dashed line with closed triangle):',
  '    { "kind": "realization", "op": "create", "id": "<uuid>", "diagramId": "<uuid>", "timestamp": "<RFC3339>", "realizationId": "<uuid>", "clientClassId": "<classId>", "supplierInterfaceId": "<interfaceId>", "name": "optionalLabel" },',
  '    // For dependencies (dashed line with arrow):',
  '    { "kind": "dependency", "op": "create", "id": "<uuid>", "diagramId": "<uuid>", "timestamp": "<RFC3339>", "dependencyId": "<uuid>", "clientClassId": "<classId>", "supplierClassId": "<classId>", "name": "optionalLabel" },',
  '    // For ternary or n-ary associations (central floating diamond connecting 3+ classes):',
  '    { "kind": "naryAssociation", "op": "create", "id": "<uuid>", "diagramId": "<uuid>", "timestamp": "<RFC3339>", "naryAssociationId": "<uuid>", "name": "TernaryAssocName", "memberEnds": [ { "classId": "<class1>", "multiplicity": "1", "role": "role1" }, { "classId": "<class2>", "multiplicity": "0..*", "role": "role2" }, { "classId": "<class3>", "multiplicity": "1", "role": "role3" } ] }',
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
    this.apiKey = config.apiKey.trim();
    this.baseUrl = (config.baseUrl ?? 'https://api.openai.com/v1').trim().replace(/[,/]+$/, '');
    this.model = config.model ?? 'gpt-4o-mini';
    this.maxAttempts = config.maxAttempts ?? 2;
  }

  static fromEnv(): OpenAiVision | null {
    const apiKey = process.env.VISION_API_KEY || process.env.OPENAI_API_KEY;
    if (!apiKey) return null;
    return new OpenAiVision({
      apiKey,
      baseUrl: process.env.VISION_BASE_URL || process.env.OPENAI_BASE_URL,
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
    const targetUrl = `${this.baseUrl}/chat/completions`;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      let response: Response;
      try {
        response = await fetch(targetUrl, {
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
          `Vision request failed (${targetUrl}): ${error instanceof Error ? error.message : 'unknown error'}`,
        );
      }

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        throw new VisionExtractionError(
          `Vision request failed (${targetUrl}) with status ${response.status}${errorText ? `: ${errorText.slice(0, 300)}` : ''}`,
        );
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
