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

    const refused = (reason: string): LlmResult => ({ kind: 'refused', reason });

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

    // 4. add attribute
    const addAttribute = /\b(?:add|agrega|agregá|añade)\b[\s\S]*?\b(?:attribute|atributo)\s+([A-Za-z_]\w*)\s*(?::|\bof type\b|\bde tipo\b)\s*([A-Za-z_][\w.]*)\s+(?:to|a|en)\s+(?:class\s+|clase\s+)?([A-Za-z_]\w*)/i.exec(utterance);
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
      };
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

    // 7. association between two classes
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

  async interpret(utterance: string, deltaJsonSchema: object, currentIr: Diagram): Promise<LlmResult> {
    const system = [
      'You interpret UML class-diagram EDIT commands and translate them into a single structured delta.',
      'You are an interpreter of user intent, NOT a design generator: refuse any request to invent a complete design, explaining that you edit an existing model on explicit instruction.',
      'Respond ONLY with a JSON object: {"action":"apply","delta":<delta>} or {"action":"refuse","reason":"..."}',
      'The delta must conform to this JSON Schema:',
      JSON.stringify(deltaJsonSchema),
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
      // Schema-shape check happens here as a first gate; the caller still
      // runs DeltaSchema.safeParse (interpreter:R1 is enforced there).
      const check = DeltaSchema.safeParse(parsed.delta);
      if (!check.success) {
        return { kind: 'delta', value: parsed.delta };
      }
      return { kind: 'delta', value: check.data };
    }
    throw new Error('LLM returned an unexpected action');
  }
}
