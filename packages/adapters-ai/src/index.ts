/**
 * @app/adapters-ai — LLM adapters for the text interpreter (PR 7, task 7.3).
 *
 * - `FakeLlm` — deterministic pattern matcher used by tests and offline dev
 *   (zero network). Understands the bounded command vocabulary and refuses
 *   whole-design generation requests (interpreter:R3).
 * - `OpenAiLlm` — OpenAI-compatible chat-completions adapter with JSON
 *   structured output. The returned delta is ALWAYS Zod-validated by the
 *   caller (interpreter:R1) — the model's text never touches the model.
 */
import {
  DeltaSchema,
  type AssociationDelta,
  type ClassDelta,
  type Diagram,
  type Delta,
  type LlmPort,
  type LlmResult,
  type MemberDelta,
  AggregationKindSchema,
} from '@app/core';

export const PACKAGE_NAME = '@app/adapters-ai' as const;

export * from './stt.js';

// ── shared helpers ─────────────────────────────────────────────────────────

function classIdByName(diagram: Diagram, name: string): string | null {
  const target = name.toLowerCase();
  const found = diagram.classes.find((cls) => cls.name.toLowerCase() === target);
  return found?.id ?? null;
}

function nextPosition(diagram: Diagram): { x: number; y: number } {
  const n = diagram.classes.length;
  return { x: 80 + n * 40, y: 80 + n * 40 };
}

function deltaBase(diagram: Diagram): { id: string; diagramId: string; timestamp: string } {
  return {
    id: crypto.randomUUID(),
    diagramId: diagram.id,
    timestamp: new Date().toISOString(),
  };
}

const WHOLE_DESIGN_REQUEST = /\b(generate|genera|generá|dise[ñn]a|dise[ñn]o)\b[\s\S]*\b(design|dise[ñn]o|full|completo|complete|system|sistema|library|biblioteca)\b/i;

// ── FakeLlm ────────────────────────────────────────────────────────────────

/**
 * Deterministic interpreter for the bounded command vocabulary. Pattern-based
 * on purpose: tests (7.1/7.2/7.5) and offline dev run with zero network.
 */
export class FakeLlm implements LlmPort {
  async interpret(utterance: string, _deltaJsonSchema: object, currentIr: Diagram): Promise<LlmResult> {
    if (WHOLE_DESIGN_REQUEST.test(utterance)) {
      return {
        kind: 'refused',
        reason: 'I edit an existing model on explicit instruction; I do not generate whole designs.',
      };
    }

    // Unit 9 — UML adornment heuristics from the utterance (optional).
    const visibility = /\bprivate\b/i.test(utterance)
      ? ('-' as const)
      : /\bprotected\b/i.test(utterance)
        ? ('#' as const)
        : /\bpackage\b/i.test(utterance)
          ? ('~' as const)
          : undefined;
    const isStatic = /\bstatic\b/i.test(utterance) || undefined;
    const isDerived = /\bderived\b/i.test(utterance) || undefined;
    const adornments = {
      ...(visibility !== undefined ? { visibility } : {}),
      ...(isStatic !== undefined ? { isStatic } : {}),
      ...(isDerived !== undefined ? { isDerived } : {}),
    };

    const refused = (reason: string): LlmResult => ({ kind: 'refused', reason });

    // 4 (evaluated FIRST). add attribute to an EXISTING class. Checked before
    // the create-class pattern so "add attribute x: int to the class Customer"
    // is not misread as a class creation (offline demo fix, unit 9).
    const addAttribute = /\b(?:add|agrega|agregá|añade)\b[\s\S]*?\b(?:attribute|atributo)\s+([A-Za-z_]\w*)\s*(?::|\bof type\b|\bde tipo\b)\s*([A-Za-z_][\w.]*)\s+(?:to|a|en)\s+(?:(?:the|la|el)\s+)?(?:class\s+|clase\s+)?([A-Za-z_]\w*)/i.exec(utterance);
    if (addAttribute) {
      const classId = classIdByName(currentIr, addAttribute[3]!);
      if (classId === null) return refused(`Unknown class "${addAttribute[3]}"`);
      const delta: MemberDelta = {
        kind: 'member',
        op: 'addAttribute',
        ...deltaBase(currentIr),
        classId,
        memberId: crypto.randomUUID(),
        name: addAttribute[1]!,
        type: addAttribute[2]!,
        ...adornments,
      };
      return { kind: 'delta', value: delta };
    }

    // 1. create class [+ optional "with attribute name: type"]
    const createClass = /\b(?:add|create|crea|agregá|agrega|añade)\b[\s\S]*?\bclass(?:es)?\s+([A-Za-z_]\w*)/i.exec(utterance);
    if (createClass) {
      const name = createClass[1]!;
      const position = nextPosition(currentIr);
      const create: ClassDelta = {
        kind: 'class',
        op: 'create',
        ...deltaBase(currentIr),
        classId: crypto.randomUUID(),
        name,
        position,
      };
      const attribute = /\b(?:with|con)\s+(?:an?\s+)?(?:attribute|atributo)\s+([A-Za-z_]\w*)\s*(?::|\bof type\b|\bde tipo\b)\s*([A-Za-z_][\w.]*)/i.exec(utterance);
      if (attribute) {
        const addAttribute: MemberDelta = {
          kind: 'member',
          op: 'addAttribute',
          ...deltaBase(currentIr),
          classId: create.classId,
          memberId: crypto.randomUUID(),
          name: attribute[1]!,
          type: attribute[2]!,
          ...adornments,
        };
        const batch: Delta = { kind: 'batch', deltas: [create, addAttribute] };
        return { kind: 'delta', value: batch };
      }
      return { kind: 'delta', value: create };
    }

    // 2. rename class
    const rename = /\b(?:rename|renombra|renombrá)\b[\s\S]*?\b(?:class\s+|clase\s+)?([A-Za-z_]\w*)\s+(?:to|a)\s+([A-Za-z_]\w*)/i.exec(utterance);
    if (rename) {
      const classId = classIdByName(currentIr, rename[1]!);
      if (classId === null) return refused(`Unknown class "${rename[1]}"`);
      const delta: ClassDelta = {
        kind: 'class',
        op: 'rename',
        ...deltaBase(currentIr),
        classId,
        newName: rename[2]!,
      };
      return { kind: 'delta', value: delta };
    }

    // 3. delete class
    const deleteClass = /\b(?:delete|remove|elimina|eliminá|borra|borrá)\b[\s\S]*?\b(?:class|clase)\s+([A-Za-z_]\w*)/i.exec(utterance);
    if (deleteClass) {
      const classId = classIdByName(currentIr, deleteClass[1]!);
      if (classId === null) return refused(`Unknown class "${deleteClass[1]}"`);
      const delta: ClassDelta = { kind: 'class', op: 'delete', ...deltaBase(currentIr), classId };
      return { kind: 'delta', value: delta };
    }

    // 5. remove attribute / method
    const removeMember = /\b(?:remove|delete|elimina|eliminá|borra|borrá)\b[\s\S]*?\b(?:attribute|atributo|method|m[ée]todo)\s+([A-Za-z_]\w*)\s+(?:from|de)\s+(?:class\s+|clase\s+)?([A-Za-z_]\w*)/i.exec(utterance);
    if (removeMember) {
      const classId = classIdByName(currentIr, removeMember[2]!);
      if (classId === null) return refused(`Unknown class "${removeMember[2]}"`);
      const cls = currentIr.classes.find((c) => c.id === classId)!;
      const memberName = removeMember[1]!.toLowerCase();
      const attr = cls.attributes.find((a) => a.name.toLowerCase() === memberName);
      const delta: MemberDelta = attr
        ? { kind: 'member', op: 'deleteAttribute', ...deltaBase(currentIr), classId, memberId: attr.id }
        : { kind: 'member', op: 'deleteMethod', ...deltaBase(currentIr), classId, memberId: cls.methods.find((m) => m.name.toLowerCase() === memberName)?.id ?? '' };
      if (delta.memberId === '') return refused(`Unknown member "${removeMember[1]}" in class "${removeMember[2]}"`);
      return { kind: 'delta', value: delta };
    }

    // 6. add method
    const addMethod = /\b(?:add|agrega|agregá|añade)\b[\s\S]*?\b(?:method|m[ée]todo)\s+([A-Za-z_]\w*)\s*(?::|\breturning\b|\bque retorna\b|\bdevuelve\b)\s*([A-Za-z_][\w.]*)?\s+(?:to|a)\s+(?:class\s+|clase\s+)?([A-Za-z_]\w*)/i.exec(utterance);
    if (addMethod) {
      const classId = classIdByName(currentIr, addMethod[3]!);
      if (classId === null) return refused(`Unknown class "${addMethod[3]}"`);
      const delta: MemberDelta = {
        kind: 'member',
        op: 'addMethod',
        ...deltaBase(currentIr),
        classId,
        memberId: crypto.randomUUID(),
        name: addMethod[1]!,
        returnType: addMethod[2] ?? 'void',
        parameters: [],
      };
      return { kind: 'delta', value: delta };
    }

    // 7. named association with roles: "association X Y named Z role A role B"
    // Must be checked BEFORE the generic association pattern
    const namedAssociation = /\b(?:association|link|asocia(?:ci[óo]n)?)\b[\s\S]*?\b([A-Za-z_]\w*)\s+(?:(?:with|con|y|and)\s+)?([A-Za-z_]\w*)\s+(?:named|called|llama(?:da)?)\s+([A-Za-z_]\w*)(?:(?:\s+(?:role|rol)\s+([A-Za-z_]\w*))?(?:\s+(?:role|rol)\s+([A-Za-z_]\w*))?)?/i.exec(utterance);
    if (namedAssociation) {
      const sourceClassId = classIdByName(currentIr, namedAssociation[1]!);
      const targetClassId = classIdByName(currentIr, namedAssociation[2]!);
      if (sourceClassId === null) return refused(`Unknown class "${namedAssociation[1]}"`);
      if (targetClassId === null) return refused(`Unknown class "${namedAssociation[2]}"`);
      const delta: AssociationDelta = {
        kind: 'association',
        op: 'create',
        ...deltaBase(currentIr),
        associationId: crypto.randomUUID(),
        sourceClassId,
        targetClassId,
        sourceMultiplicity: '1',
        targetMultiplicity: '1',
        directed: false,
        name: namedAssociation[3]!,
        sourceRole: namedAssociation[4] || undefined,
        targetRole: namedAssociation[5] || undefined,
      };
      return { kind: 'delta', value: delta };
    }

    // 8. association between two classes (plain)
    const association = /\b(?:link|conecta|conectá|asocia|asociá|asociaci[óo]n|association)\b[\s\S]*?\b([A-Za-z_]\w*)\s+(?:with|con|y|and)\s+([A-Za-z_]\w*)/i.exec(utterance);
    if (association) {
      const sourceClassId = classIdByName(currentIr, association[1]!);
      const targetClassId = classIdByName(currentIr, association[2]!);
      if (sourceClassId === null) return refused(`Unknown class "${association[1]}"`);
      if (targetClassId === null) return refused(`Unknown class "${association[2]}"`);
      const delta: AssociationDelta = {
        kind: 'association',
        op: 'create',
        ...deltaBase(currentIr),
        associationId: crypto.randomUUID(),
        sourceClassId,
        targetClassId,
        sourceMultiplicity: '1',
        targetMultiplicity: '1',
        directed: false,
        aggregation: 'none',
      };
      return { kind: 'delta', value: delta };
    }

    // 9. composition: "X is composed of Y" or "X composes Y" — X is the whole (container), Y is the part
    const composition = /\b([A-Za-z_]\w*)\s+(?:is\s+)?(?:composed\s+of|composes|compone)\s+([A-Za-z_]\w*)/i.exec(utterance);
    if (composition) {
      const sourceClassId = classIdByName(currentIr, composition[1]!); // whole/container
      const targetClassId = classIdByName(currentIr, composition[2]!); // part
      if (sourceClassId === null) return refused(`Unknown class "${composition[1]}"`);
      if (targetClassId === null) return refused(`Unknown class "${composition[2]}"`);
      const delta: AssociationDelta = {
        kind: 'association',
        op: 'create',
        ...deltaBase(currentIr),
        associationId: crypto.randomUUID(),
        sourceClassId,
        targetClassId,
        sourceMultiplicity: '1',
        targetMultiplicity: '0..*',
        directed: false,
        aggregation: 'composite',
        aggregationEnd: 'source', // whole is at source end
      };
      return { kind: 'delta', value: delta };
    }

    // 9b. reversed composition phrasing: "X is part of Y" or "X belongs to Y" — Y is the whole, X is the part
    const partOf = /\b([A-Za-z_]\w*)\s+(?:is\s+)?(?:part\s+of|belongs\s+to)\s+([A-Za-z_]\w*)/i.exec(utterance);
    if (partOf) {
      const partClassId = classIdByName(currentIr, partOf[1]!); // part
      const wholeClassId = classIdByName(currentIr, partOf[2]!); // whole/container
      if (partClassId === null) return refused(`Unknown class "${partOf[1]}"`);
      if (wholeClassId === null) return refused(`Unknown class "${partOf[2]}"`);
      // Determine which end is the whole and set aggregationEnd accordingly
      const delta: AssociationDelta = {
        kind: 'association',
        op: 'create',
        ...deltaBase(currentIr),
        associationId: crypto.randomUUID(),
        sourceClassId: partClassId,
        targetClassId: wholeClassId,
        sourceMultiplicity: '0..*',
        targetMultiplicity: '1',
        directed: false,
        aggregation: 'composite',
        aggregationEnd: 'target', // whole is at target end
      };
      return { kind: 'delta', value: delta };
    }

    // 10. shared aggregation: "aggregation between X and Y" or "X has a Y" (shared)
    const sharedAgg = /\b(?:aggregation|shared)\b[\s\S]*?\b(?:between\s+)?([A-Za-z_]\w*)\s+(?:and|with|y)\s+([A-Za-z_]\w*)/i.exec(utterance);
    if (sharedAgg) {
      const sourceClassId = classIdByName(currentIr, sharedAgg[1]!);
      const targetClassId = classIdByName(currentIr, sharedAgg[2]!);
      if (sourceClassId === null) return refused(`Unknown class "${sharedAgg[1]}"`);
      if (targetClassId === null) return refused(`Unknown class "${sharedAgg[2]}"`);
      const delta: AssociationDelta = {
        kind: 'association',
        op: 'create',
        ...deltaBase(currentIr),
        associationId: crypto.randomUUID(),
        sourceClassId,
        targetClassId,
        sourceMultiplicity: '1',
        targetMultiplicity: '0..*',
        directed: false,
        aggregation: 'shared',
        aggregationEnd: 'source', // default to source for shared
      };
      return { kind: 'delta', value: delta };
    }

    return refused('Unsupported command.');
  }
}

// ── OpenAiLlm ──────────────────────────────────────────────────────────────

export interface OpenAiLlmConfig {
  apiKey: string;
  /** Default: https://api.openai.com/v1 — override for compatible gateways. */
  baseUrl?: string | undefined;
  /** Default: gpt-4o-mini (cheap tier is enough for delta interpretation). */
  model?: string | undefined;
}

/**
 * OpenAI-compatible adapter (task 7.3). Uses JSON-object structured output
 * and instructs the model with the delta JSON Schema; the CALLER still
 * Zod-validates every returned delta (interpreter:R1), so a malformed model
 * response can never reach the canonical model.
 */
export class OpenAiLlm implements LlmPort {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;

  constructor(config: OpenAiLlmConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl ?? 'https://api.openai.com/v1';
    this.model = config.model ?? 'gpt-4o-mini';
  }

  static fromEnv(): OpenAiLlm | null {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return null;
    return new OpenAiLlm({
      apiKey,
      baseUrl: process.env.OPENAI_BASE_URL,
      model: process.env.LLM_MODEL,
    });
  }

  async interpret(utterance: string, _deltaJsonSchema: object, currentIr: Diagram): Promise<LlmResult> {
    const system = [
      'You translate UML class-diagram EDIT commands into structured deltas.',
      'You are an interpreter of user intent, NOT a design generator: refuse any request to invent a complete design, explaining that you edit an existing model on explicit instruction.',
      'Respond ONLY with a JSON object: {"action":"apply","delta":<delta>} or {"action":"refuse","reason":"..."}',
      '',
      'BASE FIELDS (required on EVERY delta and on EVERY inner batch item): "id":"<new uuid>","diagramId":"<currentIr.id>","timestamp":"<RFC3339 UTC like 2026-08-31T12:00:00.000Z>"',
      '',
      'Shapes (use EXACTLY these field names; pick by command):',
      'CLASS CREATE: {"kind":"class","op":"create", ...base, "classId":"<new uuid or placeholder>","name":"<ClassName>","position":{"x":120,"y":80}}',
      'CLASS RENAME: {"kind":"class","op":"rename", ...base, "classId":"<existing class uuid>","newName":"<NewName>"}',
      'CLASS REPOSITION: {"kind":"class","op":"reposition", ...base, "classId":"<existing class uuid>","newPosition":{"x":<number>,"y":<number>}}',
      'CLASS DELETE: {"kind":"class","op":"delete", ...base, "classId":"<existing class uuid>"}',
      'ADD ATTRIBUTE: {"kind":"member","op":"addAttribute", ...base, "classId":"<existing class uuid or placeholder>","memberId":"<new uuid>","name":"<attrName>","type":"<attrType>" [, "visibility":"+"|"-"|"#"|"~"] [, "isStatic":true] [, "isDerived":true] [, "multiplicity":"0..*"]}',
      'EDIT ATTRIBUTE: {"kind":"member","op":"editAttribute", ...base, "classId":"<existing class uuid>","memberId":"<existing attribute uuid>","name":"<newName>","type":"<newType>" [, visibility/isStatic/isDerived/multiplicity]}',
      'DELETE ATTRIBUTE: {"kind":"member","op":"deleteAttribute", ...base, "classId":"<existing class uuid>","memberId":"<existing attribute uuid>"}',
      'ADD METHOD: {"kind":"member","op":"addMethod", ...base, "classId":"<existing class uuid or placeholder>","memberId":"<new uuid>","name":"<methodName>","returnType":"<type>","parameters":[] [, "visibility":"+"|"-"|"#"|"~"] [, "isStatic":true]}',
      'EDIT METHOD: {"kind":"member","op":"editMethod", ...base, "classId":"<existing class uuid>","memberId":"<existing method uuid>","name":"<newName>","returnType":"<newReturnType>","parameters":[] [, visibility/isStatic]}',
      'DELETE METHOD: {"kind":"member","op":"deleteMethod", ...base, "classId":"<existing class uuid>","memberId":"<existing method uuid>"}',
'ASSOCIATION CREATE: {"kind":"association","op":"create", ...base, "associationId":"<new uuid>","sourceClassId":"<existing or placeholder>","targetClassId":"<existing or placeholder>","sourceMultiplicity":"1","targetMultiplicity":"1","directed":false [, "aggregation":"none"|"shared"|"composite"] [, "aggregationEnd":"source"|"target"] [, "name":"<assocName>"] [, "sourceRole":"<role>"] [, "targetRole":"<role>"]}',
      'ASSOCIATION UPDATE MULTIPLICITY: {"kind":"association","op":"updateMultiplicity", ...base, "associationId":"<existing association uuid>","newSourceMultiplicity":"1"|"0..1"|"1..*"|"0..*","newTargetMultiplicity":"1"|"0..1"|"1..*"|"0..*" [, "aggregation":"none"|"shared"|"composite"] [, "aggregationEnd":"source"|"target"] [, "name":"<assocName>"] [, "sourceRole":"<role>"] [, "targetRole":"<role>"]}',
      'ASSOCIATION DELETE: {"kind":"association","op":"delete", ...base, "associationId":"<existing association uuid>"}',
      '',
      'AGGREGATION END GUIDANCE:',
      '- The `aggregationEnd` field ("source" or "target") explicitly declares which END of the association owns the aggregation diamond (UML 2.5.1).',
      '- It is INDEPENDENT of drawing direction (source/target class order) and multiplicities.',
      '- When the user names the WHOLE/OWNER class ("Order is composed of OrderLines", "Order aggregates OrderLine", "OrderLine is part of Order", "OrderLine belongs to Order"), set `aggregationEnd` to the END THAT HOLDS THE WHOLE CLASS.',
      '- Example: "Order is composed of OrderLine" → whole=Order. If Order is sourceClassId, set aggregationEnd="source". If Order is targetClassId, set aggregationEnd="target".',
      '- Example: "OrderLine is part of Order" → whole=Order. Set aggregationEnd to the end where Order resides.',
      '- Default is "source" if omitted (backward compat).',
      '',
      'HARD RULES:',
      '- Every uuid you output MUST be hex-only (0-9a-f) UUID v4.',
      '- diagramId is copied EXACTLY from currentIr.id.',
      '- Valid multiplicities: *, 0, integers, m..n, m..* (UML 2.5.1).',
      '- For a class you CREATE inside this response, do NOT invent a real uuid: use a PLACEHOLDER like NEW_CLASS_1 (NEW_CLASS_2 for the second, etc.) in the create AND in every other delta that references it (attributes, methods, associations). The system assigns real ids consistently.',
      '- Classes that ALREADY exist in the current diagram must be referenced by their EXACT uuid from the IR.',
      '- Never invent fields outside the shapes. Never nest class arrays.',
      `Current diagram (IR): ${JSON.stringify(currentIr)}`,
    ].join('\n');

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: utterance },
        ],
      }),
    });

    if (!response.ok) {
      throw new Error(`LLM request failed with status ${response.status}`);
    }

    const payload = (await response.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      throw new Error('LLM response had no message content');
    }

    let parsed: { action?: string; reason?: string; delta?: unknown };
    try {
      parsed = JSON.parse(content) as typeof parsed;
    } catch {
      throw new Error('LLM returned non-JSON content');
    }

    if (parsed.action === 'refuse') {
      return { kind: 'refused', reason: parsed.reason ?? 'Refused.' };
    }
    if (parsed.action === 'apply' && parsed.delta !== undefined) {
      // Repair known provider quirks (e.g. Groq gpt-oss hallucinating
      // non-hex UUID characters) BEFORE validation: ids this tool generates
      // anyway are regenerated when malformed. The caller's Zod gate
      // (interpreter:R1) still validates the FULL delta afterwards.
      const repaired = repairModelIdentifiers(parsed.delta);
      // Schema-shape check happens here as a first gate; the caller still
      // runs DeltaSchema.safeParse (interpreter:R1 is enforced there).
      const check = DeltaSchema.safeParse(repaired);
      if (!check.success) {
        return { kind: 'delta', value: repaired };
      }
      return { kind: 'delta', value: check.data };
    }
    throw new Error('LLM returned an unexpected action');
  }
}

// ── Model-output repair (provider quirk normalization) ─────────────────────

/** UUID fields the MODEL is allowed to invent; malformed values are regenerated. */
const REPAIRABLE_ID_FIELDS = new Set(['id', 'classId', 'memberId', 'associationId', 'sourceClassId', 'targetClassId']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RFC3339_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Deep-walks a model-produced delta and regenerates malformed ids/timestamps.
 * Every occurrence of the SAME invalid id string maps to the SAME generated
 * UUID (memoized), so model placeholders like "NEW_CLASS_1" stay coherent
 * across batch items (create + attribute + association reference the same
 * class). `diagramId` is deliberately NOT repairable — it must match the
 * current IR, and a mismatch is a real error the Zod gate must catch.
 */
export function repairModelIdentifiers(value: unknown, memo: Map<string, string> = new Map()): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => repairModelIdentifiers(item, memo));
  }
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (typeof val === 'string' && REPAIRABLE_ID_FIELDS.has(key) && !UUID_RE.test(val)) {
      const existing = memo.get(val);
      out[key] = existing ?? crypto.randomUUID();
      if (existing === undefined) {
        memo.set(val, out[key] as string);
      }
      continue;
    }
    if (typeof val === 'string' && key === 'timestamp' && !RFC3339_RE.test(val)) {
      out[key] = new Date().toISOString();
      continue;
    }
    out[key] = repairModelIdentifiers(val, memo);
  }
  return out;
}
