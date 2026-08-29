import { type Diagram, type Class, type Association, type Attribute, type Method, type Position, DiagramSchema, ClassSchema, AssociationSchema } from './ir.js';
import { type Delta, type ClassDelta, type MemberDelta, type AssociationDelta, type BatchDelta, DeltaSchema } from './delta.js';
import { z } from 'zod';

/**
 * Discriminated union of all possible apply errors.
 * Each error carries structured data for precise handling.
 */
export type ApplyError =
  | { kind: 'DuplicateClassError'; className: string; classId?: string }
  | { kind: 'ClassNotFoundError'; classId: string }
  | { kind: 'AssociationNotFoundError'; associationId: string }
  | { kind: 'InvalidMultiplicityError'; multiplicity: string }
  | { kind: 'InvalidOperationError'; reason: string }
  | { kind: 'SelfAssociationError'; classId: string }
  | { kind: 'MemberNotFoundError'; memberId: string; classId: string }
  | { kind: 'DuplicateMemberError'; memberName: string; classId: string }
  | { kind: 'BatchError'; error: ApplyError; failedDeltaIndex: number };

/**
 * Type guard for ApplyError
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
 * Result type for applyDelta - discriminated union of success or error.
 */
export type ApplyResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: ApplyError };

/**
 * Creates a success result.
 */
function ok<T>(value: T): ApplyResult<T> {
  return { ok: true, value };
}

/**
 * Creates an error result.
 */
function err(error: ApplyError): ApplyResult<never> {
  return { ok: false, error };
}

/**
 * Deep clones a diagram to ensure immutability.
 */
function cloneDiagram(diagram: Diagram): Diagram {
  return DiagramSchema.parse(JSON.parse(JSON.stringify(diagram)));
}

/**
 * Finds a class by ID in the diagram.
 */
function findClass(diagram: Diagram, classId: string): Class | undefined {
  return diagram.classes.find(c => c.id === classId);
}

/**
 * Finds a class by name in the diagram.
 */
function findClassByName(diagram: Diagram, name: string): Class | undefined {
  return diagram.classes.find(c => c.name === name);
}

/**
 * Finds an association by ID in the diagram.
 */
function findAssociation(diagram: Diagram, associationId: string): Association | undefined {
  return diagram.associations.find(a => a.id === associationId);
}

/**
 * Checks if a class name already exists (excluding a specific class ID).
 */
function isDuplicateClassName(diagram: Diagram, name: string, excludeClassId?: string): boolean {
  return diagram.classes.some(c => c.name === name && c.id !== excludeClassId);
}

/**
 * Checks if a member name already exists in a class (excluding a specific member ID).
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
 * Removes all associations connected to a class (cascade delete).
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
 * Applies a single class delta.
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

    case 'delete': {
      const classIndex = diagram.classes.findIndex(c => c.id === delta.classId);
      if (classIndex === -1) {
        return err({ kind: 'ClassNotFoundError', classId: delta.classId });
      }
      // Remove the class
      const updatedClasses = diagram.classes.filter(c => c.id !== delta.classId);
      // Cascade delete associations
      let updatedDiagram = { ...diagram, classes: updatedClasses };
      updatedDiagram = cascadeDeleteAssociations(updatedDiagram, delta.classId);
      return ok(updatedDiagram);
    }

    default: {
      const _exhaustive: never = delta.op;
      return err({ kind: 'InvalidOperationError', reason: `Unknown class op: ${_exhaustive}` });
    }
  }
}

/**
 * Applies a single member delta.
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
      const newAttribute = { id: delta.memberId, name: delta.name, type: delta.type };
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
      updatedAttributes[attrIndex] = { ...updatedAttributes[attrIndex], name: delta.name, type: delta.type };
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
      const newMethod = {
        id: delta.memberId,
        name: delta.name,
        returnType: delta.returnType,
        parameters: delta.parameters,
      };
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
      updatedMethods[methodIndex] = {
        ...updatedMethods[methodIndex],
        name: delta.name,
        returnType: delta.returnType,
        parameters: delta.parameters,
      };
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
 * Applies a single association delta.
 */
function applyAssociationDelta(diagram: Diagram, delta: AssociationDelta): ApplyResult<Diagram> {
  switch (delta.op) {
    case 'create': {
      if (!delta.sourceClassId || !delta.targetClassId || !delta.sourceMultiplicity || !delta.targetMultiplicity || delta.directed === undefined) {
        return err({ kind: 'InvalidOperationError', reason: 'Association create requires sourceClassId, targetClassId, sourceMultiplicity, targetMultiplicity, and directed' });
      }
      if (delta.sourceClassId === delta.targetClassId) {
        return err({ kind: 'SelfAssociationError', classId: delta.sourceClassId });
      }
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
      });
      return ok({ ...diagram, associations: [...diagram.associations, newAssociation] });
    }

    case 'updateMultiplicity': {
      if (!delta.newSourceMultiplicity && !delta.newTargetMultiplicity) {
        return err({ kind: 'InvalidOperationError', reason: 'Update multiplicity requires at least one new multiplicity' });
      }
      const assocIndex = diagram.associations.findIndex(a => a.id === delta.associationId);
      if (assocIndex === -1) {
        return err({ kind: 'AssociationNotFoundError', associationId: delta.associationId });
      }
      const updatedAssociations = [...diagram.associations];
      updatedAssociations[assocIndex] = {
        ...updatedAssociations[assocIndex],
        sourceMultiplicity: delta.newSourceMultiplicity ?? updatedAssociations[assocIndex].sourceMultiplicity,
        targetMultiplicity: delta.newTargetMultiplicity ?? updatedAssociations[assocIndex].targetMultiplicity,
      };
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
 * Applies a batch delta atomically (all-or-nothing).
 * Validates all deltas first, then applies them sequentially on a cloned state.
 * If any delta fails, the original state is returned unchanged.
 */
function applyBatchDelta(diagram: Diagram, batchDelta: BatchDelta): ApplyResult<Diagram> {
  // First, validate all deltas in the batch against the original state
  // This ensures atomicity - we don't apply partial changes
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
      default: {
        const _exhaustive: never = delta.kind;
        result = err({ kind: 'InvalidOperationError', reason: `Unknown delta kind: ${_exhaustive}` });
      }
    }

    if (!result.ok) {
      // Wrap the error with batch context
      return err({ kind: 'BatchError', error: result.error, failedDeltaIndex: i });
    }

    workingDiagram = result.value;
  }

  return ok(workingDiagram);
}

/**
 * Pure function that applies a delta to a diagram state.
 * 
 * @param state - The current diagram state (never mutated)
 * @param delta - The delta to apply
 * @returns A new diagram state if successful, or an error if the delta is invalid
 * 
 * Invariants:
 * - NEVER mutates the input state
 * - Returns a NEW state on success (immutable style)
 * - Rejects invalid operations with typed errors (discriminated union)
 * - Atomic batch semantics: one invalid delta ⇒ nothing applied
 * - Duplicate class names are rejected (editor:R1)
 * - Delete class cascades to associations (editor:R2)
 */
export function applyDelta(state: Diagram, delta: Delta): ApplyResult<Diagram> {
  // Validate input state
  const validatedState = DiagramSchema.parse(state);
  // Validate delta
  const validatedDelta = DeltaSchema.parse(delta);

  // Ensure diagram IDs match
  if (validatedDelta.diagramId !== validatedState.id) {
    return err({ kind: 'InvalidOperationError', reason: 'Delta diagramId does not match state diagramId' });
  }

  // Clone the state to ensure immutability
  const clonedState = cloneDiagram(validatedState);

  switch (validatedDelta.kind) {
    case 'class':
      return applyClassDelta(clonedState, validatedDelta);
    case 'member':
      return applyMemberDelta(clonedState, validatedDelta);
    case 'association':
      return applyAssociationDelta(clonedState, validatedDelta);
    case 'batch':
      return applyBatchDelta(clonedState, validatedDelta);
    default: {
      const _exhaustive: never = validatedDelta.kind;
      return err({ kind: 'InvalidOperationError', reason: `Unknown delta kind: ${_exhaustive}` });
    }
  }
}