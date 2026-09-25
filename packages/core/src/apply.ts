import { type Diagram, type Class, type Association, type Generalization, type NaryAssociation, type Attribute, type Method, type Position, DiagramSchema, ClassSchema, AssociationSchema, GeneralizationSchema, RealizationSchema, DependencySchema, NaryAssociationSchema, AttributeSchema, MethodSchema, AggregationKindSchema } from './ir.js';
import { type Delta, type ClassDelta, type MemberDelta, type AssociationDelta, type GeneralizationDelta, type RealizationDelta, type DependencyDelta, type NaryAssociationDelta, type BatchDelta, DeltaSchema } from './delta.js';
import { z } from 'zod';

/**
 * Unión discriminada de todos los posibles errores de aplicación de deltas.
 * Cada error transporta datos estructurados para un manejo preciso.
 */
export type ApplyError =
  | { kind: 'DuplicateClassError'; className: string; classId?: string }
  | { kind: 'ClassNotFoundError'; classId: string }
  | { kind: 'AssociationNotFoundError'; associationId: string }
  | { kind: 'InvalidMultiplicityError'; multiplicity: string }
  | { kind: 'InvalidOperationError'; reason: string }
  | { kind: 'MemberNotFoundError'; memberId: string; classId: string }
  | { kind: 'DuplicateMemberError'; memberName: string; classId: string }
  | { kind: 'DuplicateGeneralizationError'; subClassId: string; superClassId: string }
  | { kind: 'GeneralizationNotFoundError'; generalizationId: string }
  | { kind: 'GeneralizationCycleError'; subClassId: string; superClassId: string }
  | { kind: 'DuplicateRealizationError'; clientClassId: string; supplierInterfaceId: string }
  | { kind: 'RealizationNotFoundError'; realizationId: string }
  | { kind: 'RealizationTargetNotInterfaceError'; supplierClassId: string }
  | { kind: 'DuplicateDependencyError'; clientClassId: string; supplierClassId: string }
  | { kind: 'DependencyNotFoundError'; dependencyId: string }
  | { kind: 'NaryAssociationNotFoundError'; naryAssociationId: string }
  | { kind: 'NaryAssociationMinEndsError'; count: number }
  | { kind: 'DuplicateNaryMemberError'; classId: string }
  | { kind: 'BatchError'; error: ApplyError; failedDeltaIndex: number };

/**
 * Predicado de tipo (guard) para ApplyError.
 */
export function isApplyError(value: unknown): value is ApplyError {
  return (
    typeof value === 'object' &&
    value !== null &&
    'kind' in value &&
    typeof (value as Record<string, unknown>).kind === 'string'
  );
}

/**
 * Tipo de resultado para applyDelta — unión discriminada de éxito o error.
 */
export type ApplyResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: ApplyError };

/**
 * Crea un resultado exitoso.
 */
function ok<T>(value: T): ApplyResult<T> {
  return { ok: true, value };
}

/**
 * Crea un resultado con error.
 */
function err(error: ApplyError): ApplyResult<never> {
  return { ok: false, error };
}

/**
 * Clona profundamente un diagrama para asegurar inmutabilidad.
 */
function cloneDiagram(diagram: Diagram): Diagram {
  return DiagramSchema.parse(JSON.parse(JSON.stringify(diagram)));
}

/**
 * Busca una clase por su ID en el diagrama.
 */
function findClass(diagram: Diagram, classId: string): Class | undefined {
  return diagram.classes.find(c => c.id === classId);
}

/**
 * Busca una clase por su nombre en el diagrama.
 */
function findClassByName(diagram: Diagram, name: string): Class | undefined {
  return diagram.classes.find(c => c.name === name);
}

/**
 * Busca una asociación por su ID en el diagrama.
 */
function findAssociation(diagram: Diagram, associationId: string): Association | undefined {
  return diagram.associations.find(a => a.id === associationId);
}

/**
 * Verifica si ya existe una clase con ese nombre (excluyendo un ID de clase específico).
 */
function isDuplicateClassName(diagram: Diagram, name: string, excludeClassId?: string): boolean {
  return diagram.classes.some(c => c.name === name && c.id !== excludeClassId);
}

/**
 * Verifica si ya existe un miembro con ese nombre en una clase (excluyendo un ID de miembro específico).
 */
function isDuplicateMemberName(
  classObj: Class,
  name: string,
  excludeMemberId?: string
): boolean {
  return (
    classObj.attributes.some(a => a.name === name && a.id !== excludeMemberId) ||
    classObj.methods.some(m => m.name === name && m.id !== excludeMemberId)
  );
}

/**
 * Elimina todas las asociaciones conectadas a una clase (eliminación en cascada).
 */
function cascadeDeleteAssociations(diagram: Diagram, classId: string): Diagram {
  return {
    ...diagram,
    associations: diagram.associations.filter(
      a => a.sourceClassId !== classId && a.targetClassId !== classId
    ),
  };
}

/**
 * Elimina todas las aristas de generalización conectadas a una clase, ya sea en el rol
 * de subClase o superClase (eliminación en cascada, editor:R Generalization).
 */
function cascadeDeleteGeneralizations(diagram: Diagram, classId: string): Diagram {
  return {
    ...diagram,
    generalizations: diagram.generalizations.filter(
      g => g.subClassId !== classId && g.superClassId !== classId
    ),
  };
}

/**
 * Elimina todas las aristas de realización conectadas a una clase, ya sea en el rol
 * de cliente o interfaz proveedora (eliminación en cascada, editor:R Interfaces — unidad 12.2).
 */
function cascadeDeleteRealizations(diagram: Diagram, classId: string): Diagram {
  return {
    ...diagram,
    realizations: diagram.realizations.filter(
      r => r.clientClassId !== classId && r.supplierInterfaceId !== classId
    ),
  };
}

/**
 * Elimina todas las aristas de dependencia conectadas a una clase, ya sea en el rol
 * de cliente o proveedor (eliminación en cascada, editor:R Interfaces — unidad 12.2, 12b).
 */
function cascadeDeleteDependencies(diagram: Diagram, classId: string): Diagram {
  return {
    ...diagram,
    dependencies: diagram.dependencies.filter(
      d => d.clientClassId !== classId && d.supplierClassId !== classId
    ),
  };
}

/**
 * Poda una clase eliminada de los extremos miembros de cada asociación n-aria
 * (eliminación en cascada, editor:R N-ary — unidad 13.1). Una asociación n-aria
 * que quede con menos de tres extremos ya no es n-aria y se elimina por completo.
 * Las asociaciones que no contienen la clase se preservan sin cambios por referencia.
 */
function cascadeDeleteNaryAssociations(diagram: Diagram, classId: string): Diagram {
  const updated: NaryAssociation[] = [];
  for (const nary of diagram.naryAssociations ?? []) {
    const keptEnds = nary.memberEnds.filter(e => e.classId !== classId);
    if (keptEnds.length === nary.memberEnds.length) {
      updated.push(nary); // la clase no es miembro — dejar el objeto intacto
      continue;
    }
    if (keptEnds.length >= 3) {
      updated.push({ ...nary, memberEnds: keptEnds });
    }
    // < 3 extremos tras la poda: la asociación n-aria completa se elimina.
  }
  return { ...diagram, naryAssociations: updated };
}

/**
 * Verificación de ciclos para aristas de generalización (invariante de mayor riesgo, unidad 11.2).
 *
 * Las aristas apuntan subClase → superClase. Añadir `sub → super` cierra un ciclo si y solo si
 * `sub` es alcanzable desde `super` navegando aristas existentes sub→super
 * (es decir, super ya es descendiente de sub), o sub === super (auto-bucle).
 * El recorrido de ancestros cubre herencia múltiple (los DAGs de diamante siguen siendo válidos).
 */
function wouldCreateGeneralizationCycle(
  diagram: Diagram,
  subClassId: string,
  superClassId: string,
): boolean {
  if (subClassId === superClassId) return true;
  const visited = new Set<string>();
  const stack: string[] = [superClassId];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current === subClassId) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const gen of diagram.generalizations) {
      if (gen.subClassId === current) {
        stack.push(gen.superClassId);
      }
    }
  }
  return false;
}

/**
 * Aplica un único delta de clase.
 */
function applyClassDelta(diagram: Diagram, delta: ClassDelta): ApplyResult<Diagram> {
  switch (delta.op) {
    case 'create': {
      if (!delta.name || !delta.position) {
        return err({ kind: 'InvalidOperationError', reason: 'Class create requires name and position' });
      }
      if (isDuplicateClassName(diagram, delta.name)) {
        return err({ kind: 'DuplicateClassError', className: delta.name, classId: delta.classId });
      }
      const newClass = ClassSchema.parse({
        id: delta.classId,
        name: delta.name,
        position: delta.position,
        attributes: [],
        methods: [],
        // Unidad 12.1: tipo de clasificador opcional en create (por defecto 'class').
        ...(delta.classKind !== undefined ? { kind: delta.classKind } : {}),
      });
      return ok({ ...diagram, classes: [...diagram.classes, newClass] });
    }

    case 'rename': {
      if (!delta.newName) {
        return err({ kind: 'InvalidOperationError', reason: 'Class rename requires newName' });
      }
      const classIndex = diagram.classes.findIndex(c => c.id === delta.classId);
      if (classIndex === -1) {
        return err({ kind: 'ClassNotFoundError', classId: delta.classId });
      }
      if (isDuplicateClassName(diagram, delta.newName, delta.classId)) {
        return err({ kind: 'DuplicateClassError', className: delta.newName, classId: delta.classId });
      }
      const updatedClasses = [...diagram.classes];
      updatedClasses[classIndex] = { ...updatedClasses[classIndex], name: delta.newName };
      return ok({ ...diagram, classes: updatedClasses });
    }

    case 'reposition': {
      if (!delta.newPosition) {
        return err({ kind: 'InvalidOperationError', reason: 'Class reposition requires newPosition' });
      }
      const classIndex = diagram.classes.findIndex(c => c.id === delta.classId);
      if (classIndex === -1) {
        return err({ kind: 'ClassNotFoundError', classId: delta.classId });
      }
      const updatedClasses = [...diagram.classes];
      updatedClasses[classIndex] = { ...updatedClasses[classIndex], position: delta.newPosition };
      return ok({ ...diagram, classes: updatedClasses });
    }

    case 'update': {
      // Unidad 12.1/12.4 — alternar tipo de clasificador y/o marcado abstracto.
      // El filtro de esquema ya exige al menos un campo transportador.
      if (delta.classKind === undefined && delta.isAbstract === undefined) {
        return err({ kind: 'InvalidOperationError', reason: 'Class update requires classKind or isAbstract' });
      }
      const classIndex = diagram.classes.findIndex(c => c.id === delta.classId);
      if (classIndex === -1) {
        return err({ kind: 'ClassNotFoundError', classId: delta.classId });
      }
      const updatedClasses = [...diagram.classes];
      updatedClasses[classIndex] = ClassSchema.parse({
        ...updatedClasses[classIndex],
        ...(delta.classKind !== undefined ? { kind: delta.classKind } : {}),
        ...(delta.isAbstract !== undefined ? { isAbstract: delta.isAbstract } : {}),
      });
      return ok({ ...diagram, classes: updatedClasses });
    }

    case 'delete': {
      const classIndex = diagram.classes.findIndex(c => c.id === delta.classId);
      if (classIndex === -1) {
        return err({ kind: 'ClassNotFoundError', classId: delta.classId });
      }
      // Eliminar la clase
      const updatedClasses = diagram.classes.filter(c => c.id !== delta.classId);
      // Eliminación en cascada de asociaciones, generalizaciones, realizaciones,
      // dependencias y asociaciones n-arias
      let updatedDiagram = { ...diagram, classes: updatedClasses };
      updatedDiagram = cascadeDeleteAssociations(updatedDiagram, delta.classId);
      updatedDiagram = cascadeDeleteGeneralizations(updatedDiagram, delta.classId);
      updatedDiagram = cascadeDeleteRealizations(updatedDiagram, delta.classId);
      updatedDiagram = cascadeDeleteDependencies(updatedDiagram, delta.classId);
      updatedDiagram = cascadeDeleteNaryAssociations(updatedDiagram, delta.classId);
      return ok(updatedDiagram);
    }

    default: {
      const _exhaustive: never = delta.op;
      return err({ kind: 'InvalidOperationError', reason: `Unknown class op: ${_exhaustive}` });
    }
  }
}

/**
 * Aplica un único delta de miembro (atributo o método).
 */
function applyMemberDelta(diagram: Diagram, delta: MemberDelta): ApplyResult<Diagram> {
  const classIndex = diagram.classes.findIndex(c => c.id === delta.classId);
  if (classIndex === -1) {
    return err({ kind: 'ClassNotFoundError', classId: delta.classId });
  }
  const classObj = diagram.classes[classIndex];

  switch (delta.op) {
    case 'addAttribute': {
      if (!delta.name || !delta.type) {
        return err({ kind: 'InvalidOperationError', reason: 'Add attribute requires name and type' });
      }
      if (isDuplicateMemberName(classObj, delta.name)) {
        return err({ kind: 'DuplicateMemberError', memberName: delta.name, classId: delta.classId });
      }
      const newAttribute = AttributeSchema.parse({
        id: delta.memberId,
        name: delta.name,
        type: delta.type,
        ...(delta.visibility !== undefined ? { visibility: delta.visibility } : {}),
        ...(delta.isStatic !== undefined ? { isStatic: delta.isStatic } : {}),
        ...(delta.isDerived !== undefined ? { isDerived: delta.isDerived } : {}),
        ...(delta.multiplicity !== undefined ? { multiplicity: delta.multiplicity } : {}),
      });
      const updatedClass = {
        ...classObj,
        attributes: [...classObj.attributes, newAttribute],
      };
      const updatedClasses = [...diagram.classes];
      updatedClasses[classIndex] = updatedClass;
      return ok({ ...diagram, classes: updatedClasses });
    }

    case 'editAttribute': {
      if (!delta.name || !delta.type) {
        return err({ kind: 'InvalidOperationError', reason: 'Edit attribute requires name and type' });
      }
      const attrIndex = classObj.attributes.findIndex(a => a.id === delta.memberId);
      if (attrIndex === -1) {
        return err({ kind: 'MemberNotFoundError', memberId: delta.memberId, classId: delta.classId });
      }
      if (isDuplicateMemberName(classObj, delta.name, delta.memberId)) {
        return err({ kind: 'DuplicateMemberError', memberName: delta.name, classId: delta.classId });
      }
      const updatedAttributes = [...classObj.attributes];
      updatedAttributes[attrIndex] = AttributeSchema.parse({
        ...updatedAttributes[attrIndex],
        name: delta.name,
        type: delta.type,
        ...(delta.visibility !== undefined ? { visibility: delta.visibility } : {}),
        ...(delta.isStatic !== undefined ? { isStatic: delta.isStatic } : {}),
        ...(delta.isDerived !== undefined ? { isDerived: delta.isDerived } : {}),
        ...(delta.multiplicity !== undefined ? { multiplicity: delta.multiplicity } : {}),
      });
      const updatedClass = { ...classObj, attributes: updatedAttributes };
      const updatedClasses = [...diagram.classes];
      updatedClasses[classIndex] = updatedClass;
      return ok({ ...diagram, classes: updatedClasses });
    }

    case 'deleteAttribute': {
      const attrIndex = classObj.attributes.findIndex(a => a.id === delta.memberId);
      if (attrIndex === -1) {
        return err({ kind: 'MemberNotFoundError', memberId: delta.memberId, classId: delta.classId });
      }
      const updatedAttributes = classObj.attributes.filter(a => a.id !== delta.memberId);
      const updatedClass = { ...classObj, attributes: updatedAttributes };
      const updatedClasses = [...diagram.classes];
      updatedClasses[classIndex] = updatedClass;
      return ok({ ...diagram, classes: updatedClasses });
    }

    case 'addMethod': {
      if (!delta.name || !delta.returnType || delta.parameters === undefined) {
        return err({ kind: 'InvalidOperationError', reason: 'Add method requires name, returnType, and parameters' });
      }
      if (isDuplicateMemberName(classObj, delta.name)) {
        return err({ kind: 'DuplicateMemberError', memberName: delta.name, classId: delta.classId });
      }
      const newMethod = MethodSchema.parse({
        id: delta.memberId,
        name: delta.name,
        returnType: delta.returnType,
        parameters: delta.parameters,
        ...(delta.visibility !== undefined ? { visibility: delta.visibility } : {}),
        ...(delta.isStatic !== undefined ? { isStatic: delta.isStatic } : {}),
      });
      const updatedClass = {
        ...classObj,
        methods: [...classObj.methods, newMethod],
      };
      const updatedClasses = [...diagram.classes];
      updatedClasses[classIndex] = updatedClass;
      return ok({ ...diagram, classes: updatedClasses });
    }

    case 'editMethod': {
      if (!delta.name || !delta.returnType || delta.parameters === undefined) {
        return err({ kind: 'InvalidOperationError', reason: 'Edit method requires name, returnType, and parameters' });
      }
      const methodIndex = classObj.methods.findIndex(m => m.id === delta.memberId);
      if (methodIndex === -1) {
        return err({ kind: 'MemberNotFoundError', memberId: delta.memberId, classId: delta.classId });
      }
      if (isDuplicateMemberName(classObj, delta.name, delta.memberId)) {
        return err({ kind: 'DuplicateMemberError', memberName: delta.name, classId: delta.classId });
      }
      const updatedMethods = [...classObj.methods];
      updatedMethods[methodIndex] = MethodSchema.parse({
        ...updatedMethods[methodIndex],
        name: delta.name,
        returnType: delta.returnType,
        parameters: delta.parameters,
        ...(delta.visibility !== undefined ? { visibility: delta.visibility } : {}),
        ...(delta.isStatic !== undefined ? { isStatic: delta.isStatic } : {}),
      });
      const updatedClass = { ...classObj, methods: updatedMethods };
      const updatedClasses = [...diagram.classes];
      updatedClasses[classIndex] = updatedClass;
      return ok({ ...diagram, classes: updatedClasses });
    }

    case 'deleteMethod': {
      const methodIndex = classObj.methods.findIndex(m => m.id === delta.memberId);
      if (methodIndex === -1) {
        return err({ kind: 'MemberNotFoundError', memberId: delta.memberId, classId: delta.classId });
      }
      const updatedMethods = classObj.methods.filter(m => m.id !== delta.memberId);
      const updatedClass = { ...classObj, methods: updatedMethods };
      const updatedClasses = [...diagram.classes];
      updatedClasses[classIndex] = updatedClass;
      return ok({ ...diagram, classes: updatedClasses });
    }

    default: {
      const _exhaustive: never = delta.op;
      return err({ kind: 'InvalidOperationError', reason: `Unknown member op: ${_exhaustive}` });
    }
  }
}

/**
 * Aplica un único delta de asociación.
 */
function applyAssociationDelta(diagram: Diagram, delta: AssociationDelta): ApplyResult<Diagram> {
  switch (delta.op) {
    case 'create': {
      // Corrección unidad 13d C: multiplicidades son OPCIONALES — un extremo de asociación
      // puede iniciar sin especificar. Solo los extremos y el flag de dirección son requeridos.
      if (!delta.sourceClassId || !delta.targetClassId || delta.directed === undefined) {
        return err({ kind: 'InvalidOperationError', reason: 'Association create requires sourceClassId, targetClassId, and directed' });
      }
      // Las asociaciones recursivas (auto-asociaciones, source === target) son VÁLIDAS en UML.
      // Ambos extremos deben existir en el diagrama.
      if (!findClass(diagram, delta.sourceClassId)) {
        return err({ kind: 'ClassNotFoundError', classId: delta.sourceClassId });
      }
      if (!findClass(diagram, delta.targetClassId)) {
        return err({ kind: 'ClassNotFoundError', classId: delta.targetClassId });
      }
      const newAssociation = AssociationSchema.parse({
        id: delta.associationId,
        sourceClassId: delta.sourceClassId,
        targetClassId: delta.targetClassId,
        sourceMultiplicity: delta.sourceMultiplicity,
        targetMultiplicity: delta.targetMultiplicity,
        directed: delta.directed,
        aggregation: delta.aggregation,
        aggregationEnd: delta.aggregationEnd,
        name: delta.name,
        sourceRole: delta.sourceRole,
        targetRole: delta.targetRole,
        associationClassId: delta.associationClassId,
      });
      return ok({ ...diagram, associations: [...diagram.associations, newAssociation] });
    }

    case 'updateMultiplicity': {
      // Corrección unidad 13d C: los campos de multiplicidad son tri-estado — undefined
      // conserva el valor, un string lo establece, y NULL lo restablece a no especificado.
      if (
        delta.newSourceMultiplicity === undefined &&
        delta.newTargetMultiplicity === undefined &&
        delta.aggregation === undefined &&
        delta.aggregationEnd === undefined &&
        delta.name === undefined &&
        delta.sourceRole === undefined &&
        delta.targetRole === undefined &&
        delta.associationClassId === undefined &&
        delta.newAssociationClassId === undefined
      ) {
        return err({ kind: 'InvalidOperationError', reason: 'Update requires at least one new multiplicity or meta field' });
      }
      const assocIndex = diagram.associations.findIndex(a => a.id === delta.associationId);
      if (assocIndex === -1) {
        return err({ kind: 'AssociationNotFoundError', associationId: delta.associationId });
      }
      const updatedAssociations = [...diagram.associations];
      const updatedAssoc = {
        ...updatedAssociations[assocIndex],
        ...(delta.newSourceMultiplicity !== undefined ? { sourceMultiplicity: delta.newSourceMultiplicity ?? undefined } : {}),
        ...(delta.newTargetMultiplicity !== undefined ? { targetMultiplicity: delta.newTargetMultiplicity ?? undefined } : {}),
        ...(delta.aggregation !== undefined ? { aggregation: delta.aggregation } : {}),
        ...(delta.aggregationEnd !== undefined ? { aggregationEnd: delta.aggregationEnd } : {}),
        ...(delta.name !== undefined ? { name: delta.name || undefined } : {}),
        ...(delta.sourceRole !== undefined ? { sourceRole: delta.sourceRole || undefined } : {}),
        ...(delta.targetRole !== undefined ? { targetRole: delta.targetRole || undefined } : {}),
        ...(delta.associationClassId !== undefined ? { associationClassId: delta.associationClassId || undefined } : {}),
        ...(delta.newAssociationClassId !== undefined ? { associationClassId: delta.newAssociationClassId ?? undefined } : {}),
      };
      if (delta.newAssociationClassId === null || delta.associationClassId === null) {
        delete updatedAssoc.associationClassId;
      }
      updatedAssociations[assocIndex] = updatedAssoc;
      return ok({ ...diagram, associations: updatedAssociations });
    }

    case 'delete': {
      const assocIndex = diagram.associations.findIndex(a => a.id === delta.associationId);
      if (assocIndex === -1) {
        return err({ kind: 'AssociationNotFoundError', associationId: delta.associationId });
      }
      const updatedAssociations = diagram.associations.filter(a => a.id !== delta.associationId);
      return ok({ ...diagram, associations: updatedAssociations });
    }

    default: {
      const _exhaustive: never = delta.op;
      return err({ kind: 'InvalidOperationError', reason: `Unknown association op: ${_exhaustive}` });
    }
  }
}

/**
 * Aplica un delta de generalización individual (invariantes de la unidad 11.2):
 * - create: ambas clases deben existir; sin aristas duplicadas (mismo sub+super);
 *   sin ciclos (auto-bucle, ciclo de 2 elementos, o transitivo vía recorrido de ancestros).
 * - update: la arista debe existir; establece la etiqueta opcional (unidad 13c). Una
 *   cadena vacía la limpia (imita la semántica del nombre de asociación).
 * - delete: la arista debe existir.
 */
function applyGeneralizationDelta(diagram: Diagram, delta: GeneralizationDelta): ApplyResult<Diagram> {
  switch (delta.op) {
    case 'create': {
      if (!delta.subClassId || !delta.superClassId) {
        return err({ kind: 'InvalidOperationError', reason: 'Generalization create requires subClassId and superClassId' });
      }
      if (!findClass(diagram, delta.subClassId)) {
        return err({ kind: 'ClassNotFoundError', classId: delta.subClassId });
      }
      if (!findClass(diagram, delta.superClassId)) {
        return err({ kind: 'ClassNotFoundError', classId: delta.superClassId });
      }
      if (diagram.generalizations.some(g => g.subClassId === delta.subClassId && g.superClassId === delta.superClassId)) {
        return err({ kind: 'DuplicateGeneralizationError', subClassId: delta.subClassId, superClassId: delta.superClassId });
      }
      if (wouldCreateGeneralizationCycle(diagram, delta.subClassId, delta.superClassId)) {
        return err({ kind: 'GeneralizationCycleError', subClassId: delta.subClassId, superClassId: delta.superClassId });
      }
      const newGeneralization = GeneralizationSchema.parse({
        id: delta.generalizationId,
        subClassId: delta.subClassId,
        superClassId: delta.superClassId,
      });
      return ok({ ...diagram, generalizations: [...diagram.generalizations, newGeneralization] });
    }

    case 'update': {
      if (delta.name === undefined) {
        return err({ kind: 'InvalidOperationError', reason: 'Generalization update requires name' });
      }
      const genIndex = diagram.generalizations.findIndex(g => g.id === delta.generalizationId);
      if (genIndex === -1) {
        return err({ kind: 'GeneralizationNotFoundError', generalizationId: delta.generalizationId });
      }
      const updatedGeneralizations = [...diagram.generalizations];
      updatedGeneralizations[genIndex] = {
        ...updatedGeneralizations[genIndex],
        name: delta.name || undefined,
      };
      return ok({ ...diagram, generalizations: updatedGeneralizations });
    }

    case 'delete': {
      const genIndex = diagram.generalizations.findIndex(g => g.id === delta.generalizationId);
      if (genIndex === -1) {
        return err({ kind: 'GeneralizationNotFoundError', generalizationId: delta.generalizationId });
      }
      const updatedGeneralizations = diagram.generalizations.filter(g => g.id !== delta.generalizationId);
      return ok({ ...diagram, generalizations: updatedGeneralizations });
    }

    default: {
      const _exhaustive: never = delta.op;
      return err({ kind: 'InvalidOperationError', reason: `Unknown generalization op: ${_exhaustive}` });
    }
  }
}

/**
 * Aplica un delta de realización individual (invariantes de la unidad 12.2):
 * - create: ambos extremos deben existir; el PROVEEDOR (supplier) DEBE ser una interfaz
 *   (`kind === 'interface'` — realizar una clase común o abstracta es una
 *   violación de UML); sin aristas duplicadas (mismo cliente + proveedor).
 * - update: la arista debe existir; establece la etiqueta opcional (unidad 13c). Una
 *   cadena vacía la limpia (imita la semántica del nombre de asociación).
 * - delete: la arista debe existir.
 */
function applyRealizationDelta(diagram: Diagram, delta: RealizationDelta): ApplyResult<Diagram> {
  switch (delta.op) {
    case 'create': {
      if (!delta.clientClassId || !delta.supplierInterfaceId) {
        return err({ kind: 'InvalidOperationError', reason: 'Realization create requires clientClassId and supplierInterfaceId' });
      }
      if (!findClass(diagram, delta.clientClassId)) {
        return err({ kind: 'ClassNotFoundError', classId: delta.clientClassId });
      }
      const supplier = findClass(diagram, delta.supplierInterfaceId);
      if (!supplier) {
        return err({ kind: 'ClassNotFoundError', classId: delta.supplierInterfaceId });
      }
      // Invariante de destino de interfaz (editor:R Interfaces, escenario "Realization
      // to non-interface rejected"): las clases abstractas NO son interfaces.
      if (supplier.kind !== 'interface') {
        return err({ kind: 'RealizationTargetNotInterfaceError', supplierClassId: supplier.id });
      }
      if (diagram.realizations.some(r => r.clientClassId === delta.clientClassId && r.supplierInterfaceId === delta.supplierInterfaceId)) {
        return err({ kind: 'DuplicateRealizationError', clientClassId: delta.clientClassId, supplierInterfaceId: delta.supplierInterfaceId });
      }
      const newRealization = RealizationSchema.parse({
        id: delta.realizationId,
        clientClassId: delta.clientClassId,
        supplierInterfaceId: delta.supplierInterfaceId,
      });
      return ok({ ...diagram, realizations: [...diagram.realizations, newRealization] });
    }

    case 'update': {
      if (delta.name === undefined) {
        return err({ kind: 'InvalidOperationError', reason: 'Realization update requires name' });
      }
      const realIndex = diagram.realizations.findIndex(r => r.id === delta.realizationId);
      if (realIndex === -1) {
        return err({ kind: 'RealizationNotFoundError', realizationId: delta.realizationId });
      }
      const updatedRealizations = [...diagram.realizations];
      updatedRealizations[realIndex] = {
        ...updatedRealizations[realIndex],
        name: delta.name || undefined,
      };
      return ok({ ...diagram, realizations: updatedRealizations });
    }

    case 'delete': {
      const realIndex = diagram.realizations.findIndex(r => r.id === delta.realizationId);
      if (realIndex === -1) {
        return err({ kind: 'RealizationNotFoundError', realizationId: delta.realizationId });
      }
      const updatedRealizations = diagram.realizations.filter(r => r.id !== delta.realizationId);
      return ok({ ...diagram, realizations: updatedRealizations });
    }

    default: {
      const _exhaustive: never = delta.op;
      return err({ kind: 'InvalidOperationError', reason: `Unknown realization op: ${_exhaustive}` });
    }
  }
}

/**
 * Aplica un delta de dependencia individual (invariantes de la unidad 12.2, mitad 12b):
 * - create: ambos extremos deben existir; sin aristas duplicadas (mismo cliente +
 *   proveedor). A diferencia de la realización, el proveedor puede ser CUALQUIER clase o
 *   interfaz — NO existe requisito de destino de interfaz ni multiplicidad.
 * - update: la arista debe existir; establece la etiqueta opcional (unidad 13c). Una
 *   cadena vacía la limpia (imita la semántica del nombre de asociación).
 * - delete: la arista debe existir.
 */
function applyDependencyDelta(diagram: Diagram, delta: DependencyDelta): ApplyResult<Diagram> {
  switch (delta.op) {
    case 'create': {
      if (!delta.clientClassId || !delta.supplierClassId) {
        return err({ kind: 'InvalidOperationError', reason: 'Dependency create requires clientClassId and supplierClassId' });
      }
      if (!findClass(diagram, delta.clientClassId)) {
        return err({ kind: 'ClassNotFoundError', classId: delta.clientClassId });
      }
      if (!findClass(diagram, delta.supplierClassId)) {
        return err({ kind: 'ClassNotFoundError', classId: delta.supplierClassId });
      }
      if (diagram.dependencies.some(d => d.clientClassId === delta.clientClassId && d.supplierClassId === delta.supplierClassId)) {
        return err({ kind: 'DuplicateDependencyError', clientClassId: delta.clientClassId, supplierClassId: delta.supplierClassId });
      }
      const newDependency = DependencySchema.parse({
        id: delta.dependencyId,
        clientClassId: delta.clientClassId,
        supplierClassId: delta.supplierClassId,
      });
      return ok({ ...diagram, dependencies: [...diagram.dependencies, newDependency] });
    }

    case 'update': {
      if (delta.name === undefined) {
        return err({ kind: 'InvalidOperationError', reason: 'Dependency update requires name' });
      }
      const depIndex = diagram.dependencies.findIndex(d => d.id === delta.dependencyId);
      if (depIndex === -1) {
        return err({ kind: 'DependencyNotFoundError', dependencyId: delta.dependencyId });
      }
      const updatedDependencies = [...diagram.dependencies];
      updatedDependencies[depIndex] = {
        ...updatedDependencies[depIndex],
        name: delta.name || undefined,
      };
      return ok({ ...diagram, dependencies: updatedDependencies });
    }

    case 'delete': {
      const depIndex = diagram.dependencies.findIndex(d => d.id === delta.dependencyId);
      if (depIndex === -1) {
        return err({ kind: 'DependencyNotFoundError', dependencyId: delta.dependencyId });
      }
      const updatedDependencies = diagram.dependencies.filter(d => d.id !== delta.dependencyId);
      return ok({ ...diagram, dependencies: updatedDependencies });
    }

    default: {
      const _exhaustive: never = delta.op;
      return err({ kind: 'InvalidOperationError', reason: `Unknown dependency op: ${_exhaustive}` });
    }
  }
}

/**
 * Aplica un delta de asociación n-aria individual (invariantes de la unidad 13.1,
 * editor:R N-ary):
 * - create: al menos TRES extremos miembros; sin classId duplicado dentro de una
 *   misma asociación; cada clase miembro debe existir. Reside en su PROPIA
 *   colección `naryAssociations` — la ruta de asociaciones binarias nunca
 *   se altera (decisión de diseño D13).
 * - update (corrección A de la unidad 13d): la asociación debe existir; transporta
 *   un `name` opcional y/o un reemplazo opcional de `memberEnds`. Cuando se proveen
 *   memberEnds, se re-validan los MISMOS invariantes que en create (existencia,
 *   ≥3 extremos, sin duplicados) para que una edición nunca produzca una n-aria degenerada
 *   o colgante. Un nombre vacío la limpia (imita la semántica de etiquetas de aristas).
 * - delete: la asociación debe existir.
 */
function applyNaryAssociationDelta(diagram: Diagram, delta: NaryAssociationDelta): ApplyResult<Diagram> {
  switch (delta.op) {
    case 'create': {
      if (!delta.memberEnds || delta.memberEnds.length === 0) {
        return err({ kind: 'InvalidOperationError', reason: 'NaryAssociation create requires memberEnds' });
      }
      if (delta.memberEnds.length < 3) {
        return err({ kind: 'NaryAssociationMinEndsError', count: delta.memberEnds.length });
      }
      const seen = new Set<string>();
      for (const end of delta.memberEnds) {
        if (seen.has(end.classId)) {
          return err({ kind: 'DuplicateNaryMemberError', classId: end.classId });
        }
        seen.add(end.classId);
      }
      for (const end of delta.memberEnds) {
        if (!findClass(diagram, end.classId)) {
          return err({ kind: 'ClassNotFoundError', classId: end.classId });
        }
      }
      const newNary = NaryAssociationSchema.parse({
        id: delta.naryAssociationId,
        memberEnds: delta.memberEnds,
        name: delta.name,
      });
      return ok({ ...diagram, naryAssociations: [...(diagram.naryAssociations ?? []), newNary] });
    }

    case 'update': {
      // La compuerta de esquema ya requiere al menos un elemento; esta guarda del motor
      // lo refleja defensivamente (el mismo patrón que en la actualización de clases).
      if (delta.name === undefined && delta.memberEnds === undefined) {
        return err({ kind: 'InvalidOperationError', reason: 'NaryAssociation update requires name or memberEnds' });
      }
      const naryIndex = (diagram.naryAssociations ?? []).findIndex(n => n.id === delta.naryAssociationId);
      if (naryIndex === -1) {
        return err({ kind: 'NaryAssociationNotFoundError', naryAssociationId: delta.naryAssociationId });
      }
      const existing = (diagram.naryAssociations ?? [])[naryIndex]!;
      let memberEnds = existing.memberEnds;
      if (delta.memberEnds !== undefined) {
        // Re-valida los MISMOS invariantes que create en los extremos de reemplazo.
        if (delta.memberEnds.length < 3) {
          return err({ kind: 'NaryAssociationMinEndsError', count: delta.memberEnds.length });
        }
        const seen = new Set<string>();
        for (const end of delta.memberEnds) {
          if (seen.has(end.classId)) {
            return err({ kind: 'DuplicateNaryMemberError', classId: end.classId });
          }
          seen.add(end.classId);
        }
        for (const end of delta.memberEnds) {
          if (!findClass(diagram, end.classId)) {
            return err({ kind: 'ClassNotFoundError', classId: end.classId });
          }
        }
        memberEnds = delta.memberEnds;
      }
      const updatedNary = NaryAssociationSchema.parse({
        ...existing,
        memberEnds,
        ...(delta.name !== undefined ? { name: delta.name || undefined } : {}),
      });
      const updatedNaryAssociations = [...(diagram.naryAssociations ?? [])];
      updatedNaryAssociations[naryIndex] = updatedNary;
      return ok({ ...diagram, naryAssociations: updatedNaryAssociations });
    }

    case 'delete': {
      const naryIndex = (diagram.naryAssociations ?? []).findIndex(n => n.id === delta.naryAssociationId);
      if (naryIndex === -1) {
        return err({ kind: 'NaryAssociationNotFoundError', naryAssociationId: delta.naryAssociationId });
      }
      const updatedNaryAssociations = diagram.naryAssociations.filter(n => n.id !== delta.naryAssociationId);
      return ok({ ...diagram, naryAssociations: updatedNaryAssociations });
    }

    default: {
      const _exhaustive: never = delta.op;
      return err({ kind: 'InvalidOperationError', reason: `Unknown naryAssociation op: ${_exhaustive}` });
    }
  }
}

/**
 * Aplica un delta por lotes (batch) de forma atómica (todo o nada).
 * Valida primero todos los deltas y luego los aplica secuencialmente sobre un estado clonado.
 * Si algún delta falla, se retorna el estado original sin modificaciones.
 */
function applyBatchDelta(diagram: Diagram, batchDelta: BatchDelta): ApplyResult<Diagram> {
  // Primero valida todos los deltas en el lote contra el estado original.
  // Esto asegura atomicidad: no aplicamos cambios parciales.
  let workingDiagram = cloneDiagram(diagram);

  for (let i = 0; i < batchDelta.deltas.length; i++) {
    const delta = batchDelta.deltas[i];
    let result: ApplyResult<Diagram>;

    switch (delta.kind) {
      case 'class':
        result = applyClassDelta(workingDiagram, delta);
        break;
      case 'member':
        result = applyMemberDelta(workingDiagram, delta);
        break;
      case 'association':
        result = applyAssociationDelta(workingDiagram, delta);
        break;
      case 'generalization':
        result = applyGeneralizationDelta(workingDiagram, delta);
        break;
      case 'realization':
        result = applyRealizationDelta(workingDiagram, delta);
        break;
      case 'dependency':
        result = applyDependencyDelta(workingDiagram, delta);
        break;
      case 'naryAssociation':
        result = applyNaryAssociationDelta(workingDiagram, delta);
        break;
      default: {
        const _exhaustive: never = delta.kind;
        result = err({ kind: 'InvalidOperationError', reason: `Unknown delta kind: ${_exhaustive}` });
      }
    }

    if (!result.ok) {
      // Si una operación 'delete' de relación o elemento falla con NotFoundError porque
      // ya fue eliminado en cascada por un borrado anterior dentro del mismo lote (batch),
      // se tolera como éxito idempotente.
      const isCascadePrunedDelete =
        delta.op === 'delete' &&
        (result.error.kind === 'NaryAssociationNotFoundError' ||
         result.error.kind === 'AssociationNotFoundError' ||
         result.error.kind === 'GeneralizationNotFoundError' ||
         result.error.kind === 'RealizationNotFoundError' ||
         result.error.kind === 'DependencyNotFoundError');

      if (isCascadePrunedDelete) {
        continue;
      }

      // Envuelve el error con el contexto del lote (batch)
      return err({ kind: 'BatchError', error: result.error, failedDeltaIndex: i });
    }

    workingDiagram = result.value;
  }

  return ok(workingDiagram);
}

/**
 * Función pura que aplica un delta al estado de un diagrama.
 * 
 * @param state - El estado actual del diagrama (nunca mutado)
 * @param delta - El delta a aplicar
 * @returns Un nuevo estado del diagrama en caso de éxito, o un error si el delta es inválido
 * 
 * Invariantes:
 * - NUNCA muta el estado de entrada
 * - Retorna un NUEVO estado en caso de éxito (estilo inmutable)
 * - Rechaza operaciones inválidas con errores tipados (unión discriminada)
 * - Semántica atómica de lotes: un delta inválido ⇒ no se aplica nada
 * - Se rechazan nombres de clase duplicados (editor:R1)
 * - Eliminar una clase se propaga en cascada a sus asociaciones (editor:R2)
 */
export function applyDelta(state: Diagram, delta: Delta): ApplyResult<Diagram> {
  // Valida el estado de entrada
  const validatedState = DiagramSchema.parse(state);
  // Valida el delta
  const validatedDelta = DeltaSchema.parse(delta);

  // Asegura que los IDs de diagrama coincidan
  if (validatedDelta.diagramId !== validatedState.id) {
    return err({ kind: 'InvalidOperationError', reason: 'Delta diagramId does not match state diagramId' });
  }

  // Clona el estado para garantizar inmutabilidad
  const clonedState = cloneDiagram(validatedState);

  switch (validatedDelta.kind) {
    case 'class':
      return applyClassDelta(clonedState, validatedDelta);
    case 'member':
      return applyMemberDelta(clonedState, validatedDelta);
    case 'association':
      return applyAssociationDelta(clonedState, validatedDelta);
    case 'generalization':
      return applyGeneralizationDelta(clonedState, validatedDelta);
    case 'realization':
      return applyRealizationDelta(clonedState, validatedDelta);
    case 'dependency':
      return applyDependencyDelta(clonedState, validatedDelta);
    case 'naryAssociation':
      return applyNaryAssociationDelta(clonedState, validatedDelta);
    case 'batch':
      return applyBatchDelta(clonedState, validatedDelta);
    default: {
      const _exhaustive: never = validatedDelta.kind;
      return err({ kind: 'InvalidOperationError', reason: `Unknown delta kind: ${_exhaustive}` });
    }
  }
}