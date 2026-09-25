/**
 * @app/adapters-ai — Adaptadores LLM para el intérprete de texto (PR 7, tarea 7.3).
 *
 * - `FakeLlm` — comparador de patrones determinista usado por pruebas y desarrollo
 *   offline (sin red). Entiende el vocabulario acotado de comandos y rechaza
 *   solicitudes de generación de diseño completo (interpreter:R3).
 * - `OpenAiLlm` — adaptador de chat-completions compatible con OpenAI con salida
 *   estructurada en JSON. El delta retornado SIEMPRE es validado por Zod por el
 *   invocador (interpreter:R1) — el texto del modelo nunca toca el metamodelo directamente.
 */
import {
  DeltaSchema,
  type AssociationDelta,
  type ClassDelta,
  type Dependency,
  type DependencyDelta,
  type Diagram,
  type Delta,
  type Generalization,
  type GeneralizationDelta,
  type MemberDelta,
  type NaryAssociationDelta,
  type RealizationDelta,
  type LlmPort,
  type LlmResult,
  AggregationKindSchema,
} from '@app/core';

export const PACKAGE_NAME = '@app/adapters-ai' as const;

export * from './stt.js';
export * from './retry-repairing-llm.js';
export * from './vision.js';
export * from './repair.js';
import { repairModelIdentifiers } from './repair.js';

// ── helpers compartidos ────────────────────────────────────────────────────

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
 * Intérprete determinista para el vocabulario acotado de comandos. Basado en patrones
 * a propósito: las pruebas (7.1/7.2/7.5) y el desarrollo offline se ejecutan sin red.
 */
export class FakeLlm implements LlmPort {
  async interpret(utterance: string, _deltaJsonSchema: object, currentIr: Diagram): Promise<LlmResult> {
    if (WHOLE_DESIGN_REQUEST.test(utterance)) {
      return {
        kind: 'refused',
        reason: 'I edit an existing model on explicit instruction; I do not generate whole designs.',
      };
    }

    // Unidad 9 — Heurísticas de adornos UML a partir de la elocución (opcional).
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

    // 4 (evaluado PRIMERO). agregar atributo a una clase EXISTENTE. Verificado antes
    // del patrón create-class para que "add attribute x: int to the class Customer"
    // no se interprete erróneamente como creación de clase (arreglo demo offline, unidad 9).
    const addAttribute = /\b(?:add|agrega|agregá|añade)\b[\s\S]*?\b(?:attribute|atributo)\s+([A-Za-z_ñÑáéíóúÁÉÍÓÚ][\wñÑáéíóúÁÉÍÓÚ]*)(?:\s*(?::|\bof type\b|\bde tipo\b)\s*([A-Za-z_][\w.]*))?\s+(?:to|a|en)\s+(?:(?:the|la|el)\s+)?(?:class\s+|clase\s+)?([A-Za-z_ñÑáéíóúÁÉÍÓÚ][\wñÑáéíóúÁÉÍÓÚ]*)/i.exec(utterance);
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
        type: addAttribute[2] ?? 'string',
        ...adornments,
      };
      return { kind: 'delta', value: delta };
    }

    // 0 (evaluado PRIMERO entre las creaciones). crear interfaz: "create interface X"
    // — una interfaz es una clase con kind 'interface' (unidad 12.5, mitad 12a).
    const createInterface = /\b(?:create|add|make|new|crea)\b[\s\S]*?\b(?:interface|interfaz)\s+([A-Za-z_ñÑáéíóúÁÉÍÓÚ][\wñÑáéíóúÁÉÍÓÚ]*)/i.exec(utterance);
    if (createInterface) {
      const name = createInterface[1]!;
      const position = nextPosition(currentIr);
      const delta: ClassDelta = {
        kind: 'class',
        op: 'create',
        ...deltaBase(currentIr),
        classId: crypto.randomUUID(),
        name,
        position,
        classKind: 'interface',
      };
      return { kind: 'delta', value: delta };
    }

    // 1. crear clase / diagrama [+ opcional "con atributos a, b y c"]
    const createClass = /\b(?:add|create|crea|agregá|agrega|añade)\b[\s\S]*?\b(?:class(?:es)?|clase|diagrama)\s+([A-Za-z_ñÑáéíóúÁÉÍÓÚ][\wñÑáéíóúÁÉÍÓÚ]*)/i.exec(utterance);
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

      const attrTail = /\b(?:with|con)\s+(?:an?\s+)?(?:attributes?|atributos?)\s+([\s\S]+)$/i.exec(utterance);
      if (attrTail) {
        const rawList = attrTail[1]!;
        const items = rawList
          .split(/\s*,\s*|\s+(?:and|y)\s+/i)
          .map((s) => s.trim())
          .filter((s) => s.length > 0);

        const memberDeltas: MemberDelta[] = [];
        for (const item of items) {
          const typedMatch = /^([A-Za-z_ñÑáéíóúÁÉÍÓÚ][\wñÑáéíóúÁÉÍÓÚ]*)\s*(?::|\bof type\b|\bde tipo\b)\s*([A-Za-z_][\w.]*)$/i.exec(item);
          if (typedMatch) {
            memberDeltas.push({
              kind: 'member',
              op: 'addAttribute',
              ...deltaBase(currentIr),
              classId: create.classId,
              memberId: crypto.randomUUID(),
              name: typedMatch[1]!,
              type: typedMatch[2]!,
              ...adornments,
            });
          } else {
            const bareMatch = /^([A-Za-z_ñÑáéíóúÁÉÍÓÚ][\wñÑáéíóúÁÉÍÓÚ]*)/i.exec(item);
            if (bareMatch) {
              memberDeltas.push({
                kind: 'member',
                op: 'addAttribute',
                ...deltaBase(currentIr),
                classId: create.classId,
                memberId: crypto.randomUUID(),
                name: bareMatch[1]!,
                type: 'string', // Tipo estándar por defecto cuando se omite
                ...adornments,
              });
            }
          }
        }

        if (memberDeltas.length > 0) {
          const batch: Delta = {
            kind: 'batch',
            ...deltaBase(currentIr),
            deltas: [create, ...memberDeltas],
          };
          return { kind: 'delta', value: batch };
        }
      }
      return { kind: 'delta', value: create };
    }

    // 2. renombrar clase
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

    // 2b. eliminar todas las clases
    const deleteAll = /\b(?:delete|remove|elimina|eliminá|borra|borrá)\b[\s\S]*?\b(?:all\s+classes|todas\s+las\s+clases|all\s+the\s+classes|todas\s+las\s+tablas)\b/i.exec(utterance);
    if (deleteAll) {
      if (currentIr.classes.length === 0) {
        return refused('No classes to delete');
      }
      const batch: BatchDelta = {
        kind: 'batch',
        ...deltaBase(currentIr),
        deltas: currentIr.classes.map((cls) => ({
          kind: 'class',
          op: 'delete',
          ...deltaBase(currentIr),
          classId: cls.id,
        })),
      };
      return { kind: 'delta', value: batch };
    }

    // 3. eliminar clase
    const deleteClass = /\b(?:delete|remove|elimina|eliminá|borra|borrá)\b[\s\S]*?\b(?:class|clase)\s+([A-Za-z_]\w*)/i.exec(utterance);
    if (deleteClass) {
      const classId = classIdByName(currentIr, deleteClass[1]!);
      if (classId === null) return refused(`Unknown class "${deleteClass[1]}"`);
      const delta: ClassDelta = { kind: 'class', op: 'delete', ...deltaBase(currentIr), classId };
      return { kind: 'delta', value: delta };
    }

    // 5. eliminar atributo / método
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

    // 6. agregar método
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

    // 6b. Asociación N-ARIA (unidad 13.4): "ternary association between Supplier,
    // Part and Project" / "n-ary association between A, B, C and D" /
    // "asociación ternaria entre A, B y C". Evaluada ANTES de los patrones de asociación
    // binaria (7/8): sin esto, el patrón binario genérico interpretaría erróneamente
    // la cola de la lista de miembros ("Part and Project") como una asociación de dos extremos.
    // El motor aplica los invariantes de >=3 / duplicados / existencia; el intérprete
    // resuelve nombres y rechaza de antemano clases desconocidas o menos de tres miembros.
    const naryAssociation = /\b(?:(?:ternary|ternaria|n-ary|nary)\b[\s\S]*?\b(?:association|asociaci[óo]n)\b|(?:association|asociaci[óo]n)\b[\s\S]*?\b(?:ternary|ternaria|n-ary|nary)\b)[\s\S]*?\b(?:between|entre)\s+([A-Za-z_]\w*(?:(?:\s*,\s*|\s+(?:and|y)\s+)[A-Za-z_]\w*)+)/i.exec(utterance);
    if (naryAssociation) {
      const names = naryAssociation[1]!
        .split(/\s*,\s*|\s+(?:and|y)\s+/i)
        .map((name) => name.trim())
        .filter((name) => name.length > 0);
      if (names.length < 3) {
        return refused('An n-ary association needs at least three member classes.');
      }
      const memberEnds: { classId: string; multiplicity: string }[] = [];
      for (const name of names) {
        const classId = classIdByName(currentIr, name);
        if (classId === null) return refused(`Unknown class "${name}"`);
        memberEnds.push({ classId, multiplicity: '1' });
      }
      const delta: NaryAssociationDelta = {
        kind: 'naryAssociation',
        op: 'create',
        ...deltaBase(currentIr),
        naryAssociationId: crypto.randomUUID(),
        memberEnds,
      };
      return { kind: 'delta', value: delta };
    }

    // 6c. Asociación con CLASE DE ASOCIACIÓN:
    // "association class Enrollment between Student and Course" / "clase de asociacion Matricula entre Alumno y Curso"
    const assocClassPattern = /\b(?:association\s+class|clase\s+de\s+asociaci[óo]n)\s+([A-Za-z_]\w*)\s+(?:between|entre)\s+([A-Za-z_]\w*)\s+(?:and|y|con|with)\s+([A-Za-z_]\w*)/i.exec(utterance);
    if (assocClassPattern) {
      const assocClassName = assocClassPattern[1]!;
      const srcName = assocClassPattern[2]!;
      const tgtName = assocClassPattern[3]!;
      const sourceClassId = classIdByName(currentIr, srcName);
      const targetClassId = classIdByName(currentIr, tgtName);
      if (sourceClassId === null) return refused(`Unknown class "${srcName}"`);
      if (targetClassId === null) return refused(`Unknown class "${tgtName}"`);

      let assocClassId = classIdByName(currentIr, assocClassName);
      let createClassDelta: ClassDelta | undefined;
      if (assocClassId === null) {
        assocClassId = crypto.randomUUID();
        createClassDelta = {
          kind: 'class',
          op: 'create',
          ...deltaBase(currentIr),
          classId: assocClassId,
          name: assocClassName,
          position: nextPosition(currentIr),
        };
      }

      const assocDelta: AssociationDelta = {
        kind: 'association',
        op: 'create',
        ...deltaBase(currentIr),
        associationId: crypto.randomUUID(),
        sourceClassId,
        targetClassId,
        sourceMultiplicity: '1',
        targetMultiplicity: '1',
        directed: false,
        associationClassId: assocClassId,
      };

      if (createClassDelta) {
        return {
          kind: 'delta',
          value: {
            kind: 'batch',
            ...deltaBase(currentIr),
            deltas: [createClassDelta, assocDelta],
          },
        };
      }
      return { kind: 'delta', value: assocDelta };
    }

    // 6d. Vincular clase existente a asociación como clase de asociación:
    // "link class Grade to association between Student and Course"
    const linkAssocClassPattern = /\b(?:link|connect|conecta|conectá|asocia|asociá)\s+(?:class\s+|clase\s+)?([A-Za-z_]\w*)\s+(?:to\s+(?:association\s+between|asociaci[óo]n\s+entre)|a\s+(?:la\s+)?asociaci[óo]n\s+entre)\s+([A-Za-z_]\w*)\s+(?:and|y|con|with)\s+([A-Za-z_]\w*)/i.exec(utterance);
    if (linkAssocClassPattern) {
      const className = linkAssocClassPattern[1]!;
      const srcName = linkAssocClassPattern[2]!;
      const tgtName = linkAssocClassPattern[3]!;
      const classId = classIdByName(currentIr, className);
      const srcId = classIdByName(currentIr, srcName);
      const tgtId = classIdByName(currentIr, tgtName);
      if (classId === null) return refused(`Unknown class "${className}"`);
      if (srcId === null) return refused(`Unknown class "${srcName}"`);
      if (tgtId === null) return refused(`Unknown class "${tgtName}"`);

      const existingAssoc = currentIr.associations.find(
        (a) =>
          (a.sourceClassId === srcId && a.targetClassId === tgtId) ||
          (a.sourceClassId === tgtId && a.targetClassId === srcId),
      );
      if (!existingAssoc) {
        return refused(`No association found between "${srcName}" and "${tgtName}".`);
      }

      const delta: AssociationDelta = {
        kind: 'association',
        op: 'updateMultiplicity',
        ...deltaBase(currentIr),
        associationId: existingAssoc.id,
        newAssociationClassId: classId,
      };
      return { kind: 'delta', value: delta };
    }

    // 7. asociación nombrada con roles: "association X Y named Z role A role B"
    // Debe verificarse ANTES del patrón genérico de asociación
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

    // 8. asociación entre dos clases (simple)
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

    // 9. composición: "X is composed of Y" o "X composes Y" — X es el todo (contenedor), Y es la parte
    const composition = /\b([A-Za-z_]\w*)\s+(?:is\s+)?(?:composed\s+of|composes|compone)\s+([A-Za-z_]\w*)/i.exec(utterance);
    if (composition) {
      const sourceClassId = classIdByName(currentIr, composition[1]!); // todo/contenedor
      const targetClassId = classIdByName(currentIr, composition[2]!); // parte
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
        aggregationEnd: 'source', // el todo está en el extremo origen (source)
      };
      return { kind: 'delta', value: delta };
    }

    // 9b. fraseo inverso de composición: "X is part of Y" o "X belongs to Y" — Y es el todo, X es la parte
    const partOf = /\b([A-Za-z_]\w*)\s+(?:is\s+)?(?:part\s+of|belongs\s+to)\s+([A-Za-z_]\w*)/i.exec(utterance);
    if (partOf) {
      const partClassId = classIdByName(currentIr, partOf[1]!); // parte
      const wholeClassId = classIdByName(currentIr, partOf[2]!); // todo/contenedor
      if (partClassId === null) return refused(`Unknown class "${partOf[1]}"`);
      if (wholeClassId === null) return refused(`Unknown class "${partOf[2]}"`);
      // Determina cuál extremo es el todo y establece aggregationEnd en consecuencia
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
        aggregationEnd: 'target', // el todo está en el extremo destino (target)
      };
      return { kind: 'delta', value: delta };
    }

    // 10. agregación compartida: "aggregation between X and Y" o "X has a Y" (compartida)
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
        aggregationEnd: 'source', // por defecto origen para agregación compartida
      };
      return { kind: 'delta', value: delta };
    }

    // 11. ELIMINACIÓN de generalización (verificado ANTES de create para que las negaciones tengan prioridad):
    // "X does not inherit from Y", "remove inheritance from X",
    // "remove inheritance between X and Y".
    const existingGens: readonly Generalization[] = currentIr.generalizations ?? [];
    const notInherit = /\b([A-Za-z_]\w*)\s+does\s+not\s+inherit\s+from\s+([A-Za-z_]\w*)/i.exec(utterance);
    const removeInheritance = /\b(?:remove|delete|elimina|eliminá|borra|borrá)\b[\s\S]*?\binheritance\b[\s\S]*?\b(?:from|between|de|entre)\s+([A-Za-z_]\w*)(?:\s+(?:and|y|con)\s+([A-Za-z_]\w*))?/i.exec(utterance);
    const deleteMatch = notInherit ?? (removeInheritance ? [removeInheritance[0], removeInheritance[1]!, removeInheritance[2]] : null);
    if (deleteMatch) {
      const subClassId = classIdByName(currentIr, deleteMatch[1]!);
      if (subClassId === null) return refused(`Unknown class "${deleteMatch[1]}"`);
      let edge: Generalization | undefined;
      if (deleteMatch[2]) {
        const superClassId = classIdByName(currentIr, deleteMatch[2]);
        if (superClassId === null) return refused(`Unknown class "${deleteMatch[2]}"`);
        edge = existingGens.find((g) => g.subClassId === subClassId && g.superClassId === superClassId);
      } else {
        edge = existingGens.find((g) => g.subClassId === subClassId);
      }
      if (edge === undefined) {
        return refused(`No inheritance found for class "${deleteMatch[1]}".`);
      }
      const delta: GeneralizationDelta = {
        kind: 'generalization',
        op: 'delete',
        ...deltaBase(currentIr),
        generalizationId: edge.id,
      };
      return { kind: 'delta', value: delta };
    }

    // 12. CREACIÓN de generalización: "X is a kind of Y", "X inherits from Y",
    // "X is a subclass of Y" — X es subClass, Y es superClass.
    const generalization = /\b([A-Za-z_]\w*)\s+(?:is\s+)?(?:a\s+kind\s+of|inherits\s+from|a\s+subclass\s+of)\s+([A-Za-z_]\w*)/i.exec(utterance);
    if (generalization) {
      const subClassId = classIdByName(currentIr, generalization[1]!);
      const superClassId = classIdByName(currentIr, generalization[2]!);
      if (subClassId === null) return refused(`Unknown class "${generalization[1]}"`);
      if (superClassId === null) return refused(`Unknown class "${generalization[2]}"`);
      const delta: GeneralizationDelta = {
        kind: 'generalization',
        op: 'create',
        ...deltaBase(currentIr),
        generalizationId: crypto.randomUUID(),
        subClassId,
        superClassId,
      };
      return { kind: 'delta', value: delta };
    }

    // 13. CREACIÓN de realización (unidad 12.5, mitad 12a): "X realizes Y" /
    // "X implements Y" — X es la clase cliente, Y la interfaz proveedora.
    // El motor aplica el invariante de destino de interfaz al aplicar el delta.
    const realization = /\b([A-Za-z_]\w*)\s+(?:realizes|realiza|implements|implementa)\s+([A-Za-z_]\w*)/i.exec(utterance);
    if (realization) {
      const clientClassId = classIdByName(currentIr, realization[1]!);
      const supplierInterfaceId = classIdByName(currentIr, realization[2]!);
      if (clientClassId === null) return refused(`Unknown class "${realization[1]}"`);
      if (supplierInterfaceId === null) return refused(`Unknown class "${realization[2]}"`);
      const delta: RealizationDelta = {
        kind: 'realization',
        op: 'create',
        ...deltaBase(currentIr),
        realizationId: crypto.randomUUID(),
        clientClassId,
        supplierInterfaceId,
      };
      return { kind: 'delta', value: delta };
    }

    // 13b. ELIMINACIÓN de dependencia (unidad 12.5, mitad 12b; verificada ANTES de create
    // para que las negaciones tengan prioridad, imitando a la generalización):
    // "X does not depend on Y", "remove dependency between X and Y", "remove dependency from X".
    const existingDeps: readonly Dependency[] = currentIr.dependencies ?? [];
    const notDepend = /\b([A-Za-z_]\w*)\s+does\s+not\s+depend\s+on\s+([A-Za-z_]\w*)/i.exec(utterance);
    const removeDependency = /\b(?:remove|delete|elimina|eliminá|borra|borrá)\b[\s\S]*?\bdependen(?:cy|cia)\b[\s\S]*?\b(?:between|from|de|entre)\s+([A-Za-z_]\w*)(?:\s+(?:and|y|con)\s+([A-Za-z_]\w*))?/i.exec(utterance);
    const depDeleteMatch = notDepend ?? (removeDependency ? [removeDependency[0], removeDependency[1]!, removeDependency[2]] : null);
    if (depDeleteMatch) {
      const clientClassId = classIdByName(currentIr, depDeleteMatch[1]!);
      if (clientClassId === null) return refused(`Unknown class "${depDeleteMatch[1]}"`);
      let edge: Dependency | undefined;
      if (depDeleteMatch[2]) {
        const supplierClassId = classIdByName(currentIr, depDeleteMatch[2]);
        if (supplierClassId === null) return refused(`Unknown class "${depDeleteMatch[2]}"`);
        edge = existingDeps.find((d) => d.clientClassId === clientClassId && d.supplierClassId === supplierClassId);
      } else {
        edge = existingDeps.find((d) => d.clientClassId === clientClassId);
      }
      if (edge === undefined) {
        return refused(`No dependency found for class "${depDeleteMatch[1]}".`);
      }
      const delta: DependencyDelta = {
        kind: 'dependency',
        op: 'delete',
        ...deltaBase(currentIr),
        dependencyId: edge.id,
      };
      return { kind: 'delta', value: delta };
    }

    // 13c. CREACIÓN de dependencia (unidad 12.5, mitad 12b): "X depends on Y" /
    // "X uses Y" — X es el cliente, Y el proveedor (CUALQUIER clase o interfaz;
    // sin requerimiento de interfaz como destino, a diferencia de la realización).
    const dependency = /\b([A-Za-z_]\w*)\s+(?:depends\s+on|depende\s+de|uses|utiliza|usa)\s+([A-Za-z_]\w*)/i.exec(utterance);
    if (dependency) {
      const clientClassId = classIdByName(currentIr, dependency[1]!);
      const supplierClassId = classIdByName(currentIr, dependency[2]!);
      if (clientClassId === null) return refused(`Unknown class "${dependency[1]}"`);
      if (supplierClassId === null) return refused(`Unknown class "${dependency[2]}"`);
      const delta: DependencyDelta = {
        kind: 'dependency',
        op: 'create',
        ...deltaBase(currentIr),
        dependencyId: crypto.randomUUID(),
        clientClassId,
        supplierClassId,
      };
      return { kind: 'delta', value: delta };
    }

    // 14. marcado abstracto (unidad 12.5, mitad 12a): "make X abstract" /
    // "mark X abstract" — delta de actualización de clase que incluye isAbstract.
    const makeAbstract = /\b(?:make|mark)\s+(?:the\s+)?(?:class\s+|clase\s+)?([A-Za-z_]\w*)\s+abstract/i.exec(utterance);
    if (makeAbstract) {
      const classId = classIdByName(currentIr, makeAbstract[1]!);
      if (classId === null) return refused(`Unknown class "${makeAbstract[1]}"`);
      const delta: ClassDelta = {
        kind: 'class',
        op: 'update',
        ...deltaBase(currentIr),
        classId,
        isAbstract: true,
      };
      return { kind: 'delta', value: delta };
    }

    return refused('Unsupported command.');
  }
}

// ── OpenAiLlm ──────────────────────────────────────────────────────────────

export interface OpenAiLlmConfig {
  apiKey: string;
  /** Por defecto: https://api.openai.com/v1 — sobreescribir para gateways compatibles. */
  baseUrl?: string | undefined;
  /** Por defecto: gpt-4o-mini (el nivel económico es suficiente para interpretar deltas). */
  model?: string | undefined;
}

/**
 * Adaptador compatible con OpenAI (tarea 7.3). Utiliza salida estructurada en objeto JSON
 * e instruye al modelo con el JSON Schema de deltas; el INVOCADOR aún así valida con
 * Zod cada delta retornado (interpreter:R1), evitando que una respuesta malformada
 * del modelo alcance el metamodelo canónico.
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
       'CLASS CREATE: {"kind":"class","op":"create", ...base, "classId":"<new uuid or placeholder>","name":"<ClassName>","position":{"x":120,"y":80} [, "classKind":"class"|"interface"]}',
       'CLASS RENAME: {"kind":"class","op":"rename", ...base, "classId":"<existing class uuid>","newName":"<NewName>"}',
       'CLASS REPOSITION: {"kind":"class","op":"reposition", ...base, "classId":"<existing class uuid>","newPosition":{"x":<number>,"y":<number>}}',
       'CLASS DELETE: {"kind":"class","op":"delete", ...base, "classId":"<existing class uuid>"}',
       'CLASS UPDATE: {"kind":"class","op":"update", ...base, "classId":"<existing class uuid>" [, "classKind":"class"|"interface"] [, "isAbstract":true|false]} — at least one of classKind/isAbstract required',
      'ADD ATTRIBUTE: {"kind":"member","op":"addAttribute", ...base, "classId":"<existing class uuid or placeholder>","memberId":"<new uuid>","name":"<attrName>","type":"<attrType>" [, "visibility":"+"|"-"|"#"|"~"] [, "isStatic":true] [, "isDerived":true] [, "multiplicity":"0..*"]}',
      'EDIT ATTRIBUTE: {"kind":"member","op":"editAttribute", ...base, "classId":"<existing class uuid>","memberId":"<existing attribute uuid>","name":"<newName>","type":"<newType>" [, visibility/isStatic/isDerived/multiplicity]}',
      'DELETE ATTRIBUTE: {"kind":"member","op":"deleteAttribute", ...base, "classId":"<existing class uuid>","memberId":"<existing attribute uuid>"}',
      'ADD METHOD: {"kind":"member","op":"addMethod", ...base, "classId":"<existing class uuid or placeholder>","memberId":"<new uuid>","name":"<methodName>","returnType":"<type>","parameters":[] [, "visibility":"+"|"-"|"#"|"~"] [, "isStatic":true]}',
      'EDIT METHOD: {"kind":"member","op":"editMethod", ...base, "classId":"<existing class uuid>","memberId":"<existing method uuid>","name":"<newName>","returnType":"<newReturnType>","parameters":[] [, visibility/isStatic]}',
      'DELETE METHOD: {"kind":"member","op":"deleteMethod", ...base, "classId":"<existing class uuid>","memberId":"<existing method uuid>"}',
'ASSOCIATION CREATE: {"kind":"association","op":"create", ...base, "associationId":"<new uuid>","sourceClassId":"<existing or placeholder>","targetClassId":"<existing or placeholder>","sourceMultiplicity":"1","targetMultiplicity":"1","directed":false [, "aggregation":"none"|"shared"|"composite"] [, "aggregationEnd":"source"|"target"] [, "name":"<assocName>"] [, "sourceRole":"<role>"] [, "targetRole":"<role>"] [, "associationClassId":"<existing class uuid or placeholder>"]}',
       'ASSOCIATION UPDATE MULTIPLICITY: {"kind":"association","op":"updateMultiplicity", ...base, "associationId":"<existing association uuid>","newSourceMultiplicity":"1"|"0..1"|"1..*"|"0..*","newTargetMultiplicity":"1"|"0..1"|"1..*"|"0..*" [, "aggregation":"none"|"shared"|"composite"] [, "aggregationEnd":"source"|"target"] [, "name":"<assocName>"] [, "sourceRole":"<role>"] [, "targetRole":"<role>"] [, "newAssociationClassId":"<existing class uuid or placeholder>"]}',
       'ASSOCIATION DELETE: {"kind":"association","op":"delete", ...base, "associationId":"<existing association uuid>"}',
        'GENERALIZATION CREATE: {"kind":"generalization","op":"create", ...base, "generalizationId":"<new uuid>","subClassId":"<existing class uuid — the SUBCLASS>","superClassId":"<existing class uuid — the SUPERCLASS>"}',
        'GENERALIZATION DELETE: {"kind":"generalization","op":"delete", ...base, "generalizationId":"<existing generalization uuid from the IR>"}',
         'REALIZATION CREATE: {"kind":"realization","op":"create", ...base, "realizationId":"<new uuid>","clientClassId":"<existing class uuid — the REALIZING class>","supplierInterfaceId":"<existing INTERFACE uuid — kind must be interface>"}',
         'REALIZATION DELETE: {"kind":"realization","op":"delete", ...base, "realizationId":"<existing realization uuid from the IR>"}',
          'DEPENDENCY CREATE: {"kind":"dependency","op":"create", ...base, "dependencyId":"<new uuid>","clientClassId":"<existing class uuid — the DEPENDENT client>","supplierClassId":"<existing class uuid — the SUPPLIER (any class or interface)>"}',
          'DEPENDENCY DELETE: {"kind":"dependency","op":"delete", ...base, "dependencyId":"<existing dependency uuid from the IR>"}',
          'NARY ASSOCIATION CREATE: {"kind":"naryAssociation","op":"create", ...base, "naryAssociationId":"<new uuid>","memberEnds":[{"classId":"<existing class uuid>","multiplicity":"1" [, "role":"<endRole>"]}, ...AT LEAST THREE ENDS...] [, "name":"<assocName>"]}',
          'NARY ASSOCIATION DELETE: {"kind":"naryAssociation","op":"delete", ...base, "naryAssociationId":"<existing n-ary association uuid from the IR>"}',
        '',
        'GENERALIZATION GUIDANCE:',
        '- "X is a kind of Y", "X inherits from Y", "X is a subclass of Y" → X is the subClass, Y is the superClass.',
        '- The engine rejects cycles (A→B→A transitively), duplicate edges, and references to missing classes. Never emit a generalization that inverts an existing one.',
        '- "remove inheritance" / "X does not inherit from Y" → generalization delete using the EXACT generalizationId from currentIr.generalizations.',
        '',
        'INTERFACE / ABSTRACT / REALIZATION GUIDANCE (unit 12a):',
        '- "create interface X" → class create with "classKind":"interface". Interfaces are classifiers with kind === "interface" in the IR.',
        '- "make X abstract" / "mark X abstract" → class update with "isAbstract":true.',
        '- "X realizes Y" / "X implements Y" → realization create: X is clientClassId, Y is supplierInterfaceId.',
        '- The engine REJECTS a realization whose supplier is not kind === "interface" (abstract classes are not interfaces). Check currentIr.classes[].kind before emitting a realization.',
        '- Duplicate realizations (same client + supplier) are rejected.',
        '',
        'DEPENDENCY GUIDANCE (unit 12b):',
        '- "X depends on Y" / "X uses Y" → dependency create: X is clientClassId, Y is supplierClassId.',
        '- The supplier may be ANY class or interface (unlike realization, there is NO interface-target requirement). Dependencies carry NO multiplicity.',
        '- "remove dependency between X and Y" / "X does not depend on Y" → dependency delete using the EXACT dependencyId from currentIr.dependencies.',
        '- Duplicate dependencies (same client + supplier) are rejected.',
        '',
      'N-ARY ASSOCIATION GUIDANCE (unit 13):',
      '- "ternary association between A, B and C" / "n-ary association between A, B, C and D" → naryAssociation create with one memberEnd per class (in the order named), each carrying its own multiplicity (default "1") and optional role.',
      '- An n-ary association connects THREE OR MORE classes through a central diamond. A create with fewer than three member ends is REJECTED by the engine.',
      '- Every memberEnds[].classId must reference an EXISTING class uuid; duplicate classes within one association are rejected.',
      '- "remove n-ary association" / "delete ternary association" → naryAssociation delete using the EXACT naryAssociationId from currentIr.naryAssociations.',
      '- N-ary associations live in their OWN collection; they never touch the binary associations array.',
      '',
      'BATCH (multi-command) GUIDANCE (interpreter-llm-resilience R4):',
      '- When the user asks for SEVERAL operations in one utterance ("create classes Supplier, Part, Project" / "create class A and add attribute x: int to it"), wrap them in a SINGLE "kind":"batch" envelope — the editor applies them atomically. The interpreter NEVER splits a batch on the client side.',
      '- Shape: {"kind":"batch", ...base, "deltas":[<delta1>, <delta2>, ...]} where every sub-delta carries the full BASE FIELDS (id, diagramId, timestamp) plus its own kind-specific payload. ALL sub-deltas must validate against their respective DeltaSchema members; the engine rejects the whole batch if any sub-delta is invalid.',
      '- For a single n-ary association (or any single operation) emit the matching kind directly — do NOT wrap a single delta in a "kind":"batch" envelope. Batch is for COMBINING operations, not for wrapping a single one.',
      '- Cross-references INSIDE a batch (a class-create in slot 0 referenced by an attribute in slot 1 and an association in slot 2) MUST use a PLACEHOLDER (NEW_CLASS_1, NEW_CLASS_2, ...) consistently — the system regenerates coherent UUIDs for every occurrence of the same placeholder string.',
      '- Example: "create classes Supplier, Part, Project" →',
      '   {"kind":"batch", ...base, "deltas":[',
      '     {"kind":"class","op":"create", ...base, "classId":"NEW_CLASS_1","name":"Supplier","position":{"x":0,"y":0}},',
      '     {"kind":"class","op":"create", ...base, "classId":"NEW_CLASS_2","name":"Part","position":{"x":120,"y":0}},',
      '     {"kind":"class","op":"create", ...base, "classId":"NEW_CLASS_3","name":"Project","position":{"x":240,"y":0}}',
      '   ]}',
      '- Example: "create class A and add attribute x: int to it" →',
      '   {"kind":"batch", ...base, "deltas":[',
      '     {"kind":"class","op":"create", ...base, "classId":"NEW_CLASS_1","name":"A","position":{"x":0,"y":0}},',
      '     {"kind":"member","op":"addAttribute", ...base, "classId":"NEW_CLASS_1","memberId":"NEW_ATTR_1","name":"x","type":"int"}',
      '   ]}',
      '- Example: "borra todas las clases" / "delete all classes" → emit a "kind":"batch" containing a "kind":"class","op":"delete" for EACH class in currentIr.classes. The engine automatically cascades member and association deletions.',
      '- NEVER emit "kind":"composition" or "kind":"aggregation". In UML and our schema, compositions and aggregations are ALWAYS "kind":"association" with "aggregation":"composite" (for composition) or "aggregation":"shared" (for aggregation).',
      '',
      'AGGREGATION END GUIDANCE:',
      '- The `aggregationEnd` field ("source" or "target") explicitly declares which END of the association owns the aggregation diamond (UML 2.5.1).',
      '- It is INDEPENDENT of drawing direction (source/target class order) and multiplicities.',
      '- When the user names the WHOLE/OWNER class ("Order is composed of OrderLines", "Order aggregates OrderLine", "OrderLine is part of Order", "OrderLine belongs to Order"), set `aggregationEnd` to the END THAT HOLDS THE WHOLE CLASS.',
      '- Example: "Order is composed of OrderLine" → whole=Order. If Order is sourceClassId, set aggregationEnd="source". If Order is targetClassId, set aggregationEnd="target".',
      '- Example: "OrderLine is part of Order" → whole=Order. Set aggregationEnd to the end where Order resides.',
      '- Default is "source" if omitted (backward compat).',
      '',
      'FLEXIBLE INTENT & TYPE DEFAULTS:',
      '- If the user names attributes without specifying types (e.g. "crea un diagrama hola con atributos pepe y año", "crea clase Usuario con atributos nombre, email", "add attribute nickname to User"), default type to "string". Do NOT refuse or fail due to omitted attribute types.',
      '- Informal phrasings like "crea un diagrama X con atributos..." or "crea clase X con atributos A, B y C" mean create class X with those attributes (using default type "string" if unspecified). Combine them in a "kind":"batch" envelope.',
      '- REFUSAL OF VAGUE / GARBAGE PROMPTS: If the request lacks any actionable UML entities, classes, attributes or operations (e.g. "creame algo", "haz algo", "poner cosas", "asdfghjkl"), reply with {"action":"refuse","reason":"No valid UML entities or operations specified."}. Never invent arbitrary unrequested classes.',
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
      // Repara particularidades conocidas del proveedor (ej. Groq gpt-oss alucinando
      // caracteres UUID no hexadecimales) ANTES de la validación: los IDs que esta
      // herramienta genera de todos modos se regeneran cuando están malformados. La compuerta
      // Zod del invocador (interpreter:R1) aún valida el delta COMPLETO posteriormente.
      const repaired = repairModelIdentifiers(parsed.delta);
      // La comprobación de forma de esquema ocurre aquí como primera compuerta; el invocador
      // aún ejecuta DeltaSchema.safeParse (interpreter:R1 se aplica allí).
      const check = DeltaSchema.safeParse(repaired);
      if (!check.success) {
        return { kind: 'delta', value: repaired };
      }
      return { kind: 'delta', value: check.data };
    }
    throw new Error('LLM returned an unexpected action');
  }
}


