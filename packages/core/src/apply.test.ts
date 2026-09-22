import { describe, expect, it } from 'vitest';
import {
  type Diagram,
  type Class,
  type Association,
  DiagramSchema,
  ClassSchema,
  AssociationSchema,
} from './ir.js';
import { applyDelta } from './apply.js';
import { v4 as uuidv4 } from 'uuid';

// Helper to create a valid diagram
function createDiagram(overrides: Partial<Diagram> = {}): Diagram {
  const base: Diagram = {
    id: uuidv4(),
    name: 'Test Diagram',
    classes: [],
    associations: [],
    generalizations: [],
    realizations: [],
    dependencies: [],
    naryAssociations: [],
  };
  return DiagramSchema.parse({ ...base, ...overrides });
}

// Helper to create a valid class
function createClass(overrides: Partial<Class> = {}): Class {
  const base: Class = {
    id: uuidv4(),
    name: 'TestClass',
    position: { x: 100, y: 100 },
    attributes: [],
    methods: [],
  };
  return ClassSchema.parse({ ...base, ...overrides });
}

// Helper to create a valid association
function createAssociation(sourceClassId: string, targetClassId: string, overrides: Partial<Association> = {}): Association {
  const base: Association = {
    id: uuidv4(),
    sourceClassId,
    targetClassId,
    sourceMultiplicity: '1',
    targetMultiplicity: '0..*',
    directed: true,
  };
  return AssociationSchema.parse({ ...base, ...overrides });
}

describe('applyDelta — Duplicate Class Rejection (editor:R1, task 3.1)', () => {
  it('REJECTS a class create delta when a class with the same name already exists', () => {
    const existingClassId = uuidv4();
    const existingClass = createClass({ id: existingClassId, name: 'Order', position: { x: 100, y: 100 } });
    const state = createDiagram({ classes: [existingClass] });

    const duplicateDelta = {
      id: uuidv4(),
      diagramId: state.id,
      timestamp: new Date().toISOString(),
      kind: 'class' as const,
      op: 'create' as const,
      classId: uuidv4(),
      name: 'Order', // Same name!
      position: { x: 300, y: 200 },
    };

    const result = applyDelta(state, duplicateDelta);

    // Should be an error result (Err type)
    expect(result).toEqual(expect.objectContaining({
      ok: false,
      error: expect.objectContaining({
        kind: 'DuplicateClassError',
        className: 'Order',
      }),
    }));

    // Original state must be unchanged (immutability)
    expect(state.classes).toHaveLength(1);
    expect(state.classes[0].name).toBe('Order');
  });

  it('REJECTS a class rename delta when the new name already exists on another class', () => {
    const classAId = uuidv4();
    const classBId = uuidv4();
    const classA = createClass({ id: classAId, name: 'Customer', position: { x: 100, y: 100 } });
    const classB = createClass({ id: classBId, name: 'Order', position: { x: 300, y: 200 } });
    const state = createDiagram({ classes: [classA, classB] });

    const renameDelta = {
      id: uuidv4(),
      diagramId: state.id,
      timestamp: new Date().toISOString(),
      kind: 'class' as const,
      op: 'rename' as const,
      classId: classAId,
      newName: 'Order', // Trying to rename Customer to Order (already exists)
    };

    const result = applyDelta(state, renameDelta);

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      error: expect.objectContaining({
        kind: 'DuplicateClassError',
        className: 'Order',
      }),
    }));

    // Original state must be unchanged
    expect(state.classes).toHaveLength(2);
    expect(state.classes.find(c => c.id === classAId)?.name).toBe('Customer');
  });
});

describe('applyDelta — Delete Class Cascade (editor:R2, task 3.3)', () => {
  it('DELETES a class and REMOVES all its associations (cascade)', () => {
    const customerId = uuidv4();
    const orderId = uuidv4();
    const customer = createClass({ id: customerId, name: 'Customer', position: { x: 100, y: 100 } });
    const order = createClass({ id: orderId, name: 'Order', position: { x: 300, y: 200 } });
    const association = createAssociation(customerId, orderId);

    const state = createDiagram({
      classes: [customer, order],
      associations: [association],
    });

    const deleteDelta = {
      id: uuidv4(),
      diagramId: state.id,
      timestamp: new Date().toISOString(),
      kind: 'class' as const,
      op: 'delete' as const,
      classId: customerId,
    };

    const result = applyDelta(state, deleteDelta);

    expect(result.ok).toBe(true);
    if (result.ok) {
      const newState = result.value;
      // Class should be removed
      expect(newState.classes).toHaveLength(1);
      expect(newState.classes[0].id).toBe(orderId);
      // Association should be cascade-deleted
      expect(newState.associations).toHaveLength(0);
    }

    // Original state must be unchanged (immutability)
    expect(state.classes).toHaveLength(2);
    expect(state.associations).toHaveLength(1);
  });

  it('REMOVES associations where the deleted class is the TARGET', () => {
    const customerId = uuidv4();
    const orderId = uuidv4();
    const customer = createClass({ id: customerId, name: 'Customer', position: { x: 100, y: 100 } });
    const order = createClass({ id: orderId, name: 'Order', position: { x: 300, y: 200 } });
    const association = createAssociation(customerId, orderId);

    const state = createDiagram({
      classes: [customer, order],
      associations: [association],
    });

    const deleteDelta = {
      id: uuidv4(),
      diagramId: state.id,
      timestamp: new Date().toISOString(),
      kind: 'class' as const,
      op: 'delete' as const,
      classId: orderId, // Delete target class
    };

    const result = applyDelta(state, deleteDelta);

    expect(result.ok).toBe(true);
    if (result.ok) {
      const newState = result.value;
      expect(newState.classes).toHaveLength(1);
      expect(newState.classes[0].id).toBe(customerId);
      expect(newState.associations).toHaveLength(0);
    }
  });

  it('REMOVES ONLY associations connected to the deleted class, leaving others intact', () => {
    const customerId = uuidv4();
    const orderId = uuidv4();
    const productId = uuidv4();
    const customer = createClass({ id: customerId, name: 'Customer', position: { x: 100, y: 100 } });
    const order = createClass({ id: orderId, name: 'Order', position: { x: 300, y: 200 } });
    const product = createClass({ id: productId, name: 'Product', position: { x: 500, y: 100 } });
    const assoc1 = createAssociation(customerId, orderId);
    const assoc2 = createAssociation(orderId, productId);

    const state = createDiagram({
      classes: [customer, order, product],
      associations: [assoc1, assoc2],
    });

    const deleteDelta = {
      id: uuidv4(),
      diagramId: state.id,
      timestamp: new Date().toISOString(),
      kind: 'class' as const,
      op: 'delete' as const,
      classId: orderId,
    };

    const result = applyDelta(state, deleteDelta);

    expect(result.ok).toBe(true);
    if (result.ok) {
      const newState = result.value;
      expect(newState.classes).toHaveLength(2);
      expect(newState.associations).toHaveLength(0); // Both associations connected to Order are gone
    }
  });
});

describe('applyDelta — Atomic Batch Semantics (task 3.4)', () => {
  it('REJECTS entire batch if ONE operation is invalid — state completely unchanged', () => {
    const existingClassId = uuidv4();
    const existingClass = createClass({ id: existingClassId, name: 'Order', position: { x: 100, y: 100 } });
    const state = createDiagram({ classes: [existingClass] });

    const batchDelta = {
      id: uuidv4(),
      diagramId: state.id,
      timestamp: new Date().toISOString(),
      kind: 'batch' as const,
      deltas: [
        {
          id: uuidv4(),
          diagramId: state.id,
          timestamp: new Date().toISOString(),
          kind: 'class' as const,
          op: 'create' as const,
          classId: uuidv4(),
          name: 'ValidClass',
          position: { x: 300, y: 200 },
        },
        {
          id: uuidv4(),
          diagramId: state.id,
          timestamp: new Date().toISOString(),
          kind: 'class' as const,
          op: 'create' as const,
          classId: uuidv4(),
          name: 'Order', // DUPLICATE - should cause entire batch to fail
          position: { x: 500, y: 300 },
        },
      ],
    };

    const result = applyDelta(state, batchDelta);

    // Batch errors wrap the inner error with BatchError
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('BatchError');
      expect(result.error.failedDeltaIndex).toBe(1);
      expect(result.error.error.kind).toBe('DuplicateClassError');
      expect(result.error.error.className).toBe('Order');
    }

    // CRITICAL: Original state must be COMPLETELY unchanged (all-or-nothing)
    expect(state.classes).toHaveLength(1);
    expect(state.classes[0].name).toBe('Order');
  });

  it('REJECTS batch with invalid class reference — state completely unchanged', () => {
    const existingClassId = uuidv4();
    const existingClass = createClass({ id: existingClassId, name: 'Order', position: { x: 100, y: 100 } });
    const state = createDiagram({ classes: [existingClass] });

    const batchDelta = {
      id: uuidv4(),
      diagramId: state.id,
      timestamp: new Date().toISOString(),
      kind: 'batch' as const,
      deltas: [
        {
          id: uuidv4(),
          diagramId: state.id,
          timestamp: new Date().toISOString(),
          kind: 'class' as const,
          op: 'create' as const,
          classId: uuidv4(),
          name: 'ValidClass',
          position: { x: 300, y: 200 },
        },
        {
          id: uuidv4(),
          diagramId: state.id,
          timestamp: new Date().toISOString(),
          kind: 'member' as const,
          op: 'addAttribute' as const,
          classId: uuidv4(), // Non-existent class ID
          memberId: uuidv4(),
          name: 'testAttr',
          type: 'String',
        },
      ],
    };

    const result = applyDelta(state, batchDelta);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('BatchError');
      expect(result.error.failedDeltaIndex).toBe(1);
      expect(result.error.error.kind).toBe('ClassNotFoundError');
    }

    // CRITICAL: Original state must be COMPLETELY unchanged
    expect(state.classes).toHaveLength(1);
    expect(state.classes[0].name).toBe('Order');
  });
});

describe('applyDelta — Basic Operations (task 3.2)', () => {
  it('CREATES a new class successfully', () => {
    const state = createDiagram();
    const newClassId = uuidv4();

    const createDelta = {
      id: uuidv4(),
      diagramId: state.id,
      timestamp: new Date().toISOString(),
      kind: 'class' as const,
      op: 'create' as const,
      classId: newClassId,
      name: 'Customer',
      position: { x: 100, y: 100 },
    };

    const result = applyDelta(state, createDelta);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.classes).toHaveLength(1);
      expect(result.value.classes[0].id).toBe(newClassId);
      expect(result.value.classes[0].name).toBe('Customer');
    }
    // Original unchanged
    expect(state.classes).toHaveLength(0);
  });

  it('RENAMES a class successfully', () => {
    const existingClassId = uuidv4();
    const existingClass = createClass({ id: existingClassId, name: 'Customer', position: { x: 100, y: 100 } });
    const state = createDiagram({ classes: [existingClass] });

    const renameDelta = {
      id: uuidv4(),
      diagramId: state.id,
      timestamp: new Date().toISOString(),
      kind: 'class' as const,
      op: 'rename' as const,
      classId: existingClassId,
      newName: 'Client',
    };

    const result = applyDelta(state, renameDelta);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.classes[0].name).toBe('Client');
    }
    // Original unchanged
    expect(state.classes[0].name).toBe('Customer');
  });

  it('REPOSITIONS a class successfully', () => {
    const existingClassId = uuidv4();
    const existingClass = createClass({ id: existingClassId, name: 'Customer', position: { x: 100, y: 100 } });
    const state = createDiagram({ classes: [existingClass] });

    const repositionDelta = {
      id: uuidv4(),
      diagramId: state.id,
      timestamp: new Date().toISOString(),
      kind: 'class' as const,
      op: 'reposition' as const,
      classId: existingClassId,
      newPosition: { x: 500, y: 500 },
    };

    const result = applyDelta(state, repositionDelta);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.classes[0].position).toEqual({ x: 500, y: 500 });
    }
    // Original unchanged
    expect(state.classes[0].position).toEqual({ x: 100, y: 100 });
  });

  it('DELETES a class successfully (no associations)', () => {
    const existingClassId = uuidv4();
    const existingClass = createClass({ id: existingClassId, name: 'Customer', position: { x: 100, y: 100 } });
    const state = createDiagram({ classes: [existingClass] });

    const deleteDelta = {
      id: uuidv4(),
      diagramId: state.id,
      timestamp: new Date().toISOString(),
      kind: 'class' as const,
      op: 'delete' as const,
      classId: existingClassId,
    };

    const result = applyDelta(state, deleteDelta);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.classes).toHaveLength(0);
    }
    // Original unchanged
    expect(state.classes).toHaveLength(1);
  });

  it('CREATES an association successfully', () => {
    const customerId = uuidv4();
    const orderId = uuidv4();
    const customer = createClass({ id: customerId, name: 'Customer', position: { x: 100, y: 100 } });
    const order = createClass({ id: orderId, name: 'Order', position: { x: 300, y: 200 } });
    const state = createDiagram({ classes: [customer, order] });

    const createAssocDelta = {
      id: uuidv4(),
      diagramId: state.id,
      timestamp: new Date().toISOString(),
      kind: 'association' as const,
      op: 'create' as const,
      associationId: uuidv4(),
      sourceClassId: customerId,
      targetClassId: orderId,
      sourceMultiplicity: '1' as const,
      targetMultiplicity: '0..*' as const,
      directed: true,
    };

    const result = applyDelta(state, createAssocDelta);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.associations).toHaveLength(1);
      expect(result.value.associations[0].sourceClassId).toBe(customerId);
      expect(result.value.associations[0].targetClassId).toBe(orderId);
    }
    // Original unchanged
    expect(state.associations).toHaveLength(0);
  });

  it('DELETES an association successfully', () => {
    const customerId = uuidv4();
    const orderId = uuidv4();
    const customer = createClass({ id: customerId, name: 'Customer', position: { x: 100, y: 100 } });
    const order = createClass({ id: orderId, name: 'Order', position: { x: 300, y: 200 } });
    const association = createAssociation(customerId, orderId);
    const state = createDiagram({ classes: [customer, order], associations: [association] });

    const deleteAssocDelta = {
      id: uuidv4(),
      diagramId: state.id,
      timestamp: new Date().toISOString(),
      kind: 'association' as const,
      op: 'delete' as const,
      associationId: association.id,
    };

    const result = applyDelta(state, deleteAssocDelta);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.associations).toHaveLength(0);
    }
    // Original unchanged
    expect(state.associations).toHaveLength(1);
  });

  it('UPDATES association meta (aggregation/name/roles) via updateMultiplicity (unit 10.4)', () => {
    const customerId = uuidv4();
    const orderId = uuidv4();
    const customer = createClass({ id: customerId, name: 'Customer', position: { x: 100, y: 100 } });
    const order = createClass({ id: orderId, name: 'Order', position: { x: 300, y: 200 } });
    const association = createAssociation(customerId, orderId);
    const state = createDiagram({ classes: [customer, order], associations: [association] });

    const metaDelta = {
      id: uuidv4(),
      diagramId: state.id,
      timestamp: new Date().toISOString(),
      kind: 'association' as const,
      op: 'updateMultiplicity' as const,
      associationId: association.id,
      aggregation: 'composite' as const,
      name: 'contains',
      sourceRole: 'owner',
      targetRole: 'part',
    };

    const result = applyDelta(state, metaDelta);

    expect(result.ok).toBe(true);
    if (result.ok) {
      const assoc = result.value.associations[0]!;
      expect(assoc.aggregation).toBe('composite');
      expect(assoc.name).toBe('contains');
      expect(assoc.sourceRole).toBe('owner');
      expect(assoc.targetRole).toBe('part');
    }
  });

  it('ADDS an attribute successfully', () => {
    const existingClassId = uuidv4();
    const existingClass = createClass({ id: existingClassId, name: 'Customer', position: { x: 100, y: 100 } });
    const state = createDiagram({ classes: [existingClass] });

    const addAttrDelta = {
      id: uuidv4(),
      diagramId: state.id,
      timestamp: new Date().toISOString(),
      kind: 'member' as const,
      op: 'addAttribute' as const,
      classId: existingClassId,
      memberId: uuidv4(),
      name: 'email',
      type: 'String',
    };

    const result = applyDelta(state, addAttrDelta);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.classes[0].attributes).toHaveLength(1);
      expect(result.value.classes[0].attributes[0].name).toBe('email');
    }
    // Original unchanged
    expect(state.classes[0].attributes).toHaveLength(0);
  });

  it('ADDS a method successfully', () => {
    const existingClassId = uuidv4();
    const existingClass = createClass({ id: existingClassId, name: 'Customer', position: { x: 100, y: 100 } });
    const state = createDiagram({ classes: [existingClass] });

    const addMethodDelta = {
      id: uuidv4(),
      diagramId: state.id,
      timestamp: new Date().toISOString(),
      kind: 'member' as const,
      op: 'addMethod' as const,
      classId: existingClassId,
      memberId: uuidv4(),
      name: 'getEmail',
      returnType: 'String',
      parameters: [],
    };

    const result = applyDelta(state, addMethodDelta);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.classes[0].methods).toHaveLength(1);
      expect(result.value.classes[0].methods[0].name).toBe('getEmail');
    }
    // Original unchanged
    expect(state.classes[0].methods).toHaveLength(0);
  });
});
describe('recursive (self) associations', () => {
  it('applies an association create with source === target (recursive association, e.g. Product is-component-of Product)', () => {
    const state = createDiagram({
      classes: [createClass({ name: 'Product' })],
    });
    const productId = state.classes[0].id;

    const selfAssocDelta = {
      id: uuidv4(),
      diagramId: state.id,
      timestamp: new Date().toISOString(),
      kind: 'association' as const,
      op: 'create' as const,
      associationId: uuidv4(),
      sourceClassId: productId,
      targetClassId: productId,
      sourceMultiplicity: '1' as const,
      targetMultiplicity: '0..*' as const,
      directed: false,
    };

    const result = applyDelta(state, selfAssocDelta);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.associations).toHaveLength(1);
      expect(result.value.associations[0].sourceClassId).toBe(productId);
      expect(result.value.associations[0].targetClassId).toBe(productId);
    }
    // Original unchanged
    expect(state.associations).toHaveLength(0);
  });
});

describe('applyDelta — Association aggregationEnd (UML 2.5.1 explicit end ownership)', () => {
  it('creates association with explicit aggregationEnd "target" and stores it', () => {
    const customerId = uuidv4();
    const orderId = uuidv4();
    const customer = createClass({ id: customerId, name: 'Customer', position: { x: 100, y: 100 } });
    const order = createClass({ id: orderId, name: 'Order', position: { x: 300, y: 200 } });
    const state = createDiagram({ classes: [customer, order] });

    const createAssocDelta = {
      id: uuidv4(),
      diagramId: state.id,
      timestamp: new Date().toISOString(),
      kind: 'association' as const,
      op: 'create' as const,
      associationId: uuidv4(),
      sourceClassId: customerId,
      targetClassId: orderId,
      sourceMultiplicity: '1' as const,
      targetMultiplicity: '0..*' as const,
      directed: false,
      aggregation: 'composite' as const,
      aggregationEnd: 'target' as const,
    };

    const result = applyDelta(state, createAssocDelta);

    expect(result.ok).toBe(true);
    if (result.ok) {
      const assoc = result.value.associations[0];
      expect(assoc.aggregation).toBe('composite');
      expect(assoc.aggregationEnd).toBe('target');
    }
  });

  it('creates association without aggregationEnd and IR default "source" applies', () => {
    const customerId = uuidv4();
    const orderId = uuidv4();
    const customer = createClass({ id: customerId, name: 'Customer', position: { x: 100, y: 100 } });
    const order = createClass({ id: orderId, name: 'Order', position: { x: 300, y: 200 } });
    const state = createDiagram({ classes: [customer, order] });

    const createAssocDelta = {
      id: uuidv4(),
      diagramId: state.id,
      timestamp: new Date().toISOString(),
      kind: 'association' as const,
      op: 'create' as const,
      associationId: uuidv4(),
      sourceClassId: customerId,
      targetClassId: orderId,
      sourceMultiplicity: '1' as const,
      targetMultiplicity: '0..*' as const,
      directed: false,
      aggregation: 'composite' as const,
      // aggregationEnd omitted
    };

    const result = applyDelta(state, createAssocDelta);

    expect(result.ok).toBe(true);
    if (result.ok) {
      const assoc = result.value.associations[0];
      expect(assoc.aggregation).toBe('composite');
      expect(assoc.aggregationEnd).toBe('source'); // IR default
    }
  });

  it('updates association aggregationEnd via updateMultiplicity delta', () => {
    const customerId = uuidv4();
    const orderId = uuidv4();
    const customer = createClass({ id: customerId, name: 'Customer', position: { x: 100, y: 100 } });
    const order = createClass({ id: orderId, name: 'Order', position: { x: 300, y: 200 } });
    const association = createAssociation(customerId, orderId, { aggregation: 'shared', aggregationEnd: 'source' });
    const state = createDiagram({ classes: [customer, order], associations: [association] });

    const updateDelta = {
      id: uuidv4(),
      diagramId: state.id,
      timestamp: new Date().toISOString(),
      kind: 'association' as const,
      op: 'updateMultiplicity' as const,
      associationId: association.id,
      aggregationEnd: 'target' as const,
    };

    const result = applyDelta(state, updateDelta);

    expect(result.ok).toBe(true);
    if (result.ok) {
      const assoc = result.value.associations[0];
      expect(assoc.aggregation).toBe('shared');
      expect(assoc.aggregationEnd).toBe('target');
    }
  });

  it('old deltas without aggregationEnd field still apply with IR default', () => {
    const customerId = uuidv4();
    const orderId = uuidv4();
    const customer = createClass({ id: customerId, name: 'Customer', position: { x: 100, y: 100 } });
    const order = createClass({ id: orderId, name: 'Order', position: { x: 300, y: 200 } });
    const state = createDiagram({ classes: [customer, order] });

    // Simulate old delta without aggregationEnd field
    const oldCreateDelta = {
      id: uuidv4(),
      diagramId: state.id,
      timestamp: new Date().toISOString(),
      kind: 'association' as const,
      op: 'create' as const,
      associationId: uuidv4(),
      sourceClassId: customerId,
      targetClassId: orderId,
      sourceMultiplicity: '1' as const,
      targetMultiplicity: '0..*' as const,
      directed: false,
      aggregation: 'shared' as const,
      // No aggregationEnd field (old delta)
    };

    const result = applyDelta(state, oldCreateDelta);

    expect(result.ok).toBe(true);
    if (result.ok) {
      const assoc = result.value.associations[0];
      expect(assoc.aggregation).toBe('shared');
      expect(assoc.aggregationEnd).toBe('source'); // IR default applied
    }
  });
});

describe('applyDelta — Generalization invariants (unit 11.2, editor:R Generalization)', () => {
  function genDelta(state: Diagram, subClassId: string, superClassId: string, generalizationId = uuidv4()) {
    return {
      id: uuidv4(),
      diagramId: state.id,
      timestamp: new Date().toISOString(),
      kind: 'generalization' as const,
      op: 'create' as const,
      generalizationId,
      subClassId,
      superClassId,
    };
  }

  function deleteGenDelta(state: Diagram, generalizationId: string) {
    return {
      id: uuidv4(),
      diagramId: state.id,
      timestamp: new Date().toISOString(),
      kind: 'generalization' as const,
      op: 'delete' as const,
      generalizationId,
    };
  }

  it('CREATES a generalization edge between two existing classes', () => {
    const itemId = uuidv4();
    const productId = uuidv4();
    const item = createClass({ id: itemId, name: 'Item' });
    const product = createClass({ id: productId, name: 'Product' });
    const state = createDiagram({ classes: [item, product] });

    const result = applyDelta(state, genDelta(state, productId, itemId));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.generalizations).toHaveLength(1);
      expect(result.value.generalizations[0]).toMatchObject({ subClassId: productId, superClassId: itemId });
    }
    // Input state untouched (immutability)
    expect(state.generalizations).toHaveLength(0);
  });

  it('REJECTS create when the subClass does not exist; model unchanged', () => {
    const itemId = uuidv4();
    const item = createClass({ id: itemId, name: 'Item' });
    const state = createDiagram({ classes: [item] });

    const result = applyDelta(state, genDelta(state, uuidv4(), itemId));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('ClassNotFoundError');
    expect(state.generalizations).toHaveLength(0);
  });

  it('REJECTS create when the superClass does not exist; model unchanged', () => {
    const productId = uuidv4();
    const product = createClass({ id: productId, name: 'Product' });
    const state = createDiagram({ classes: [product] });

    const result = applyDelta(state, genDelta(state, productId, uuidv4()));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('ClassNotFoundError');
    expect(state.generalizations).toHaveLength(0);
  });

  it('REJECTS a duplicate edge (same subClassId + superClassId) even with a different id', () => {
    const itemId = uuidv4();
    const productId = uuidv4();
    const item = createClass({ id: itemId, name: 'Item' });
    const product = createClass({ id: productId, name: 'Product' });
    const existing = { id: uuidv4(), subClassId: productId, superClassId: itemId };
    const state = createDiagram({ classes: [item, product], generalizations: [existing] });

    const result = applyDelta(state, genDelta(state, productId, itemId));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('DuplicateGeneralizationError');
    expect(state.generalizations).toHaveLength(1);
  });

  it('allows the same pair in REVERSED direction as a distinct edge is NOT a duplicate (different sub/super)', () => {
    // Triangulation for the duplicate rule: (sub=A, super=B) vs (sub=B, super=A)
    // are different pairs — the second is rejected as a CYCLE, not as a duplicate.
    const itemId = uuidv4();
    const productId = uuidv4();
    const item = createClass({ id: itemId, name: 'Item' });
    const product = createClass({ id: productId, name: 'Product' });
    const existing = { id: uuidv4(), subClassId: productId, superClassId: itemId };
    const state = createDiagram({ classes: [item, product], generalizations: [existing] });

    const result = applyDelta(state, genDelta(state, itemId, productId));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('GeneralizationCycleError');
  });

  it('REJECTS a direct self-loop (A → A) as a cycle', () => {
    const aId = uuidv4();
    const a = createClass({ id: aId, name: 'A' });
    const state = createDiagram({ classes: [a] });

    const result = applyDelta(state, genDelta(state, aId, aId));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('GeneralizationCycleError');
    expect(state.generalizations).toHaveLength(0);
  });

  it('REJECTS a 2-cycle: given Product→Item, Item→Product is refused (editor:R Cycle scenario)', () => {
    const itemId = uuidv4();
    const productId = uuidv4();
    const item = createClass({ id: itemId, name: 'Item' });
    const product = createClass({ id: productId, name: 'Product' });
    const existing = { id: uuidv4(), subClassId: productId, superClassId: itemId };
    const state = createDiagram({ classes: [item, product], generalizations: [existing] });

    const result = applyDelta(state, genDelta(state, itemId, productId));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('GeneralizationCycleError');
    // Model unchanged
    expect(state.generalizations).toHaveLength(1);
    expect(state.generalizations[0]).toEqual(existing);
  });

  it('REJECTS a transitive 3-cycle: A→B, B→C, then C→A closes the loop', () => {
    const aId = uuidv4();
    const bId = uuidv4();
    const cId = uuidv4();
    const a = createClass({ id: aId, name: 'A' });
    const b = createClass({ id: bId, name: 'B' });
    const c = createClass({ id: cId, name: 'C' });
    const state = createDiagram({
      classes: [a, b, c],
      generalizations: [
        { id: uuidv4(), subClassId: aId, superClassId: bId },
        { id: uuidv4(), subClassId: bId, superClassId: cId },
      ],
    });

    const result = applyDelta(state, genDelta(state, cId, aId));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('GeneralizationCycleError');
    expect(state.generalizations).toHaveLength(2);
  });

  it('REJECTS a transitive 4-cycle (depth beyond 3): A→B→C→D, then D→A', () => {
    const aId = uuidv4();
    const bId = uuidv4();
    const cId = uuidv4();
    const dId = uuidv4();
    const state = createDiagram({
      classes: [
        createClass({ id: aId, name: 'A' }),
        createClass({ id: bId, name: 'B' }),
        createClass({ id: cId, name: 'C' }),
        createClass({ id: dId, name: 'D' }),
      ],
      generalizations: [
        { id: uuidv4(), subClassId: aId, superClassId: bId },
        { id: uuidv4(), subClassId: bId, superClassId: cId },
        { id: uuidv4(), subClassId: cId, superClassId: dId },
      ],
    });

    const result = applyDelta(state, genDelta(state, dId, aId));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('GeneralizationCycleError');
    expect(state.generalizations).toHaveLength(3);
  });

  it('ALLOWS a diamond DAG (multiple inheritance without a cycle)', () => {
    const aId = uuidv4();
    const bId = uuidv4();
    const cId = uuidv4();
    const dId = uuidv4();
    const state = createDiagram({
      classes: [
        createClass({ id: aId, name: 'A' }),
        createClass({ id: bId, name: 'B' }),
        createClass({ id: cId, name: 'C' }),
        createClass({ id: dId, name: 'D' }),
      ],
      generalizations: [
        { id: uuidv4(), subClassId: aId, superClassId: bId },
        { id: uuidv4(), subClassId: aId, superClassId: cId },
        { id: uuidv4(), subClassId: bId, superClassId: dId },
      ],
    });

    // C→D completes the diamond — no cycle, must be accepted.
    const result = applyDelta(state, genDelta(state, cId, dId));

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.generalizations).toHaveLength(4);
  });

  it('DELETES a generalization edge by id', () => {
    const itemId = uuidv4();
    const productId = uuidv4();
    const genId = uuidv4();
    const state = createDiagram({
      classes: [createClass({ id: itemId, name: 'Item' }), createClass({ id: productId, name: 'Product' })],
      generalizations: [{ id: genId, subClassId: productId, superClassId: itemId }],
    });

    const result = applyDelta(state, deleteGenDelta(state, genId));

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.generalizations).toHaveLength(0);
  });

  it('REJECTS delete of an unknown generalization', () => {
    const state = createDiagram({ classes: [createClass({ name: 'Item' })] });

    const result = applyDelta(state, deleteGenDelta(state, uuidv4()));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('GeneralizationNotFoundError');
  });

  it('delete-class CASCADES: removes edges where the class is the subClass AND the superClass', () => {
    const itemId = uuidv4();
    const productId = uuidv4();
    const specialId = uuidv4();
    const state = createDiagram({
      classes: [
        createClass({ id: itemId, name: 'Item' }),
        createClass({ id: productId, name: 'Product' }),
        createClass({ id: specialId, name: 'SpecialProduct' }),
      ],
      generalizations: [
        { id: uuidv4(), subClassId: productId, superClassId: itemId },   // Product → Item (super side)
        { id: uuidv4(), subClassId: specialId, superClassId: productId }, // Special → Product (sub side)
        { id: uuidv4(), subClassId: specialId, superClassId: itemId },    // untouched
      ],
    });

    const deleteProduct = {
      id: uuidv4(),
      diagramId: state.id,
      timestamp: new Date().toISOString(),
      kind: 'class' as const,
      op: 'delete' as const,
      classId: productId,
    };

    const result = applyDelta(state, deleteProduct);

    expect(result.ok).toBe(true);
    if (result.ok) {
      // Both edges touching Product are gone; the unrelated edge survives.
      expect(result.value.generalizations).toHaveLength(1);
      expect(result.value.generalizations[0]).toMatchObject({ subClassId: specialId, superClassId: itemId });
      // No dangling endpoint references remain
      const remainingClassIds = result.value.classes.map((c) => c.id);
      for (const gen of result.value.generalizations) {
        expect(remainingClassIds).toContain(gen.subClassId);
        expect(remainingClassIds).toContain(gen.superClassId);
      }
    }
  });

  it('batch: a cyclic generalization inside a batch rejects the WHOLE batch (atomicity)', () => {
    const itemId = uuidv4();
    const productId = uuidv4();
    const ghostId = uuidv4();
    const state = createDiagram({
      classes: [createClass({ id: itemId, name: 'Item' }), createClass({ id: productId, name: 'Product' })],
      generalizations: [{ id: uuidv4(), subClassId: productId, superClassId: itemId }],
    });

    const batch = {
      id: uuidv4(),
      diagramId: state.id,
      timestamp: new Date().toISOString(),
      kind: 'batch' as const,
      deltas: [
        genDelta(state, ghostId, itemId, uuidv4()), // valid-looking create... but ghost class missing
        genDelta(state, itemId, productId),          // would also be a cycle
      ],
    };

    const result = applyDelta(state, batch);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('BatchError');
      if (result.error.kind === 'BatchError') {
        expect(result.error.failedDeltaIndex).toBe(0);
        expect(result.error.error.kind).toBe('ClassNotFoundError');
      }
    }
    // Nothing applied
    expect(state.generalizations).toHaveLength(1);
  });
});

describe('applyDelta — Realization invariants (unit 12.2, editor:R Interfaces)', () => {
  function realizationDelta(state: Diagram, clientClassId: string, supplierInterfaceId: string, realizationId = uuidv4()) {
    return {
      id: uuidv4(),
      diagramId: state.id,
      timestamp: new Date().toISOString(),
      kind: 'realization' as const,
      op: 'create' as const,
      realizationId,
      clientClassId,
      supplierInterfaceId,
    };
  }

  function deleteRealizationDelta(state: Diagram, realizationId: string) {
    return {
      id: uuidv4(),
      diagramId: state.id,
      timestamp: new Date().toISOString(),
      kind: 'realization' as const,
      op: 'delete' as const,
      realizationId,
    };
  }

  it('CREATES a realization edge from a class to an interface', () => {
    const orderId = uuidv4();
    const repoId = uuidv4();
    const state = createDiagram({
      classes: [
        createClass({ id: orderId, name: 'Order' }),
        createClass({ id: repoId, name: 'Repository', kind: 'interface' }),
      ],
    });

    const result = applyDelta(state, realizationDelta(state, orderId, repoId));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.realizations).toHaveLength(1);
      expect(result.value.realizations[0]).toMatchObject({ clientClassId: orderId, supplierInterfaceId: repoId });
    }
    // Input state untouched (immutability)
    expect(state.realizations).toHaveLength(0);
  });

  it('REJECTS create when the client class does not exist; model unchanged', () => {
    const repoId = uuidv4();
    const state = createDiagram({ classes: [createClass({ id: repoId, name: 'Repository', kind: 'interface' })] });

    const result = applyDelta(state, realizationDelta(state, uuidv4(), repoId));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('ClassNotFoundError');
    expect(state.realizations).toHaveLength(0);
  });

  it('REJECTS create when the supplier interface does not exist; model unchanged', () => {
    const orderId = uuidv4();
    const state = createDiagram({ classes: [createClass({ id: orderId, name: 'Order' })] });

    const result = applyDelta(state, realizationDelta(state, orderId, uuidv4()));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('ClassNotFoundError');
    expect(state.realizations).toHaveLength(0);
  });

  it('REJECTS a realization whose supplier is a PLAIN CLASS (interface-target invariant, editor:R scenario)', () => {
    const aId = uuidv4();
    const bId = uuidv4();
    const state = createDiagram({
      classes: [createClass({ id: aId, name: 'A' }), createClass({ id: bId, name: 'B' })],
    });

    const result = applyDelta(state, realizationDelta(state, aId, bId));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('RealizationTargetNotInterfaceError');
    // Model unchanged
    expect(state.realizations).toHaveLength(0);
  });

  it('REJECTS a realization whose supplier is an ABSTRACT CLASS (abstract ≠ interface)', () => {
    const clientId = uuidv4();
    const abstractId = uuidv4();
    const state = createDiagram({
      classes: [
        createClass({ id: clientId, name: 'Order' }),
        createClass({ id: abstractId, name: 'Shape', isAbstract: true }),
      ],
    });

    const result = applyDelta(state, realizationDelta(state, clientId, abstractId));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('RealizationTargetNotInterfaceError');
  });

  it('REJECTS a duplicate realization (same client + supplier) even with a different id', () => {
    const orderId = uuidv4();
    const repoId = uuidv4();
    const existing = { id: uuidv4(), clientClassId: orderId, supplierInterfaceId: repoId };
    const state = createDiagram({
      classes: [
        createClass({ id: orderId, name: 'Order' }),
        createClass({ id: repoId, name: 'Repository', kind: 'interface' }),
      ],
      realizations: [existing],
    });

    const result = applyDelta(state, realizationDelta(state, orderId, repoId));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('DuplicateRealizationError');
    expect(state.realizations).toHaveLength(1);
  });

  it('ALLOWS two different clients realizing the SAME interface (triangulates the duplicate rule)', () => {
    const repoId = uuidv4();
    const order1 = uuidv4();
    const order2 = uuidv4();
    const state = createDiagram({
      classes: [
        createClass({ id: order1, name: 'Order' }),
        createClass({ id: order2, name: 'Customer' }),
        createClass({ id: repoId, name: 'Repository', kind: 'interface' }),
      ],
      realizations: [{ id: uuidv4(), clientClassId: order1, supplierInterfaceId: repoId }],
    });

    const result = applyDelta(state, realizationDelta(state, order2, repoId));

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.realizations).toHaveLength(2);
  });

  it('DELETES a realization edge by id', () => {
    const orderId = uuidv4();
    const repoId = uuidv4();
    const realId = uuidv4();
    const state = createDiagram({
      classes: [
        createClass({ id: orderId, name: 'Order' }),
        createClass({ id: repoId, name: 'Repository', kind: 'interface' }),
      ],
      realizations: [{ id: realId, clientClassId: orderId, supplierInterfaceId: repoId }],
    });

    const result = applyDelta(state, deleteRealizationDelta(state, realId));

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.realizations).toHaveLength(0);
  });

  it('REJECTS delete of an unknown realization', () => {
    const state = createDiagram({ classes: [createClass({ name: 'Item' })] });

    const result = applyDelta(state, deleteRealizationDelta(state, uuidv4()));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('RealizationNotFoundError');
  });

  it('delete-class CASCADES: removes realizations where the class is client AND where the interface is supplier', () => {
    const orderId = uuidv4();
    const customerId = uuidv4();
    const repoId = uuidv4();
    // Edges are seeded directly through the IR (not the engine) so the cascade
    // can be proven for BOTH roles, including a class sitting in the supplier
    // seat (a shape the engine itself would never create).
    const validState = createDiagram({
      classes: [
        createClass({ id: orderId, name: 'Order' }),
        createClass({ id: customerId, name: 'Customer' }),
        createClass({ id: repoId, name: 'Repository', kind: 'interface' }),
      ],
      realizations: [
        { id: uuidv4(), clientClassId: orderId, supplierInterfaceId: repoId },      // Order is client
        { id: uuidv4(), clientClassId: customerId, supplierInterfaceId: repoId },   // unrelated to Order
        { id: uuidv4(), clientClassId: customerId, supplierInterfaceId: orderId },  // Order as supplier (legacy-shaped, cascade must still clean)
      ],
    });

    const deleteOrder = {
      id: uuidv4(),
      diagramId: validState.id,
      timestamp: new Date().toISOString(),
      kind: 'class' as const,
      op: 'delete' as const,
      classId: orderId,
    };

    const result = applyDelta(validState, deleteOrder);

    expect(result.ok).toBe(true);
    if (result.ok) {
      // Only the edge not touching Order survives.
      expect(result.value.realizations).toHaveLength(1);
      expect(result.value.realizations[0]).toMatchObject({ clientClassId: customerId, supplierInterfaceId: repoId });
      // No dangling endpoint references remain
      const remainingClassIds = result.value.classes.map((c) => c.id);
      for (const real of result.value.realizations) {
        expect(remainingClassIds).toContain(real.clientClassId);
        expect(remainingClassIds).toContain(real.supplierInterfaceId);
      }
    }
  });

  it('batch: a realization to a non-interface inside a batch rejects the WHOLE batch (atomicity)', () => {
    const orderId = uuidv4();
    const plainId = uuidv4();
    const state = createDiagram({
      classes: [createClass({ id: orderId, name: 'Order' }), createClass({ id: plainId, name: 'NotAnInterface' })],
    });

    const batch = {
      id: uuidv4(),
      diagramId: state.id,
      timestamp: new Date().toISOString(),
      kind: 'batch' as const,
      deltas: [
        realizationDelta(state, orderId, plainId), // supplier is a plain class → invalid
        {
          id: uuidv4(),
          diagramId: state.id,
          timestamp: new Date().toISOString(),
          kind: 'class' as const,
          op: 'rename' as const,
          classId: orderId,
          newName: 'RenamedOrder',
        },
      ],
    };

    const result = applyDelta(state, batch);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('BatchError');
      if (result.error.kind === 'BatchError') {
        expect(result.error.failedDeltaIndex).toBe(0);
        expect(result.error.error.kind).toBe('RealizationTargetNotInterfaceError');
      }
    }
    // Nothing applied — rename did not leak
    expect(state.realizations).toHaveLength(0);
    expect(state.classes[0]!.name).toBe('Order');
  });
});

describe('applyDelta — Class update op: kind + isAbstract (unit 12.1/12.4)', () => {
  function updateDelta(state: Diagram, classId: string, fields: { classKind?: 'class' | 'interface'; isAbstract?: boolean }) {
    return {
      id: uuidv4(),
      diagramId: state.id,
      timestamp: new Date().toISOString(),
      kind: 'class' as const,
      op: 'update' as const,
      classId,
      ...fields,
    };
  }

  it('update sets isAbstract true on an existing class', () => {
    const shapeId = uuidv4();
    const state = createDiagram({ classes: [createClass({ id: shapeId, name: 'Shape' })] });

    const result = applyDelta(state, updateDelta(state, shapeId, { isAbstract: true }));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.classes[0]!.isAbstract).toBe(true);
      expect(result.value.classes[0]!.kind).toBe('class');
    }
  });

  it('update promotes a class to kind interface and back', () => {
    const repoId = uuidv4();
    const state = createDiagram({ classes: [createClass({ id: repoId, name: 'Repository' })] });

    const promoted = applyDelta(state, updateDelta(state, repoId, { classKind: 'interface' }));
    expect(promoted.ok).toBe(true);
    if (promoted.ok) expect(promoted.value.classes[0]!.kind).toBe('interface');

    const demoted = applyDelta(promoted.value, updateDelta(promoted.value, repoId, { classKind: 'class' }));
    expect(demoted.ok).toBe(true);
    if (demoted.ok) expect(demoted.value.classes[0]!.kind).toBe('class');
  });

  it('update REJECTS when the class does not exist', () => {
    const state = createDiagram({ classes: [] });

    const result = applyDelta(state, updateDelta(state, uuidv4(), { isAbstract: true }));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('ClassNotFoundError');
  });

  it('class create delta with classKind "interface" creates an interface node', () => {
    const state = createDiagram({ classes: [] });
    const newId = uuidv4();

    const result = applyDelta(state, {
      id: uuidv4(),
      diagramId: state.id,
      timestamp: new Date().toISOString(),
      kind: 'class' as const,
      op: 'create' as const,
      classId: newId,
      name: 'Repository',
      position: { x: 0, y: 0 },
      classKind: 'interface' as const,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.classes[0]!.kind).toBe('interface');
      expect(result.value.classes[0]!.isAbstract).toBe(false);
    }
  });

  it('class create delta WITHOUT classKind keeps the backward-compatible default kind "class"', () => {
    const state = createDiagram({ classes: [] });

    const result = applyDelta(state, {
      id: uuidv4(),
      diagramId: state.id,
      timestamp: new Date().toISOString(),
      kind: 'class' as const,
      op: 'create' as const,
      classId: uuidv4(),
      name: 'Legacy',
      position: { x: 0, y: 0 },
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.classes[0]!.kind).toBe('class');
  });
});

describe('applyDelta — Dependency invariants (unit 12.2 — 12b half, editor:R Interfaces)', () => {
  function dependencyDelta(state: Diagram, clientClassId: string, supplierClassId: string, dependencyId = uuidv4()) {
    return {
      id: uuidv4(),
      diagramId: state.id,
      timestamp: new Date().toISOString(),
      kind: 'dependency' as const,
      op: 'create' as const,
      dependencyId,
      clientClassId,
      supplierClassId,
    };
  }

  function deleteDependencyDelta(state: Diagram, dependencyId: string) {
    return {
      id: uuidv4(),
      diagramId: state.id,
      timestamp: new Date().toISOString(),
      kind: 'dependency' as const,
      op: 'delete' as const,
      dependencyId,
    };
  }

  it('CREATES a dependency edge between two PLAIN classes (supplier may be any classifier — unlike realization)', () => {
    const orderId = uuidv4();
    const serviceId = uuidv4();
    const state = createDiagram({
      classes: [
        createClass({ id: orderId, name: 'Order' }),
        createClass({ id: serviceId, name: 'Service' }),
      ],
    });

    const result = applyDelta(state, dependencyDelta(state, orderId, serviceId));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.dependencies).toHaveLength(1);
      expect(result.value.dependencies[0]).toMatchObject({ clientClassId: orderId, supplierClassId: serviceId });
    }
    // Input state untouched (immutability)
    expect(state.dependencies).toHaveLength(0);
  });

  it('CREATES a dependency whose supplier is an INTERFACE (any classifier allowed)', () => {
    const clientId = uuidv4();
    const repoId = uuidv4();
    const state = createDiagram({
      classes: [
        createClass({ id: clientId, name: 'Order' }),
        createClass({ id: repoId, name: 'Repository', kind: 'interface' }),
      ],
    });

    const result = applyDelta(state, dependencyDelta(state, clientId, repoId));

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.dependencies).toHaveLength(1);
  });

  it('REJECTS create when the client class does not exist; model unchanged', () => {
    const serviceId = uuidv4();
    const state = createDiagram({ classes: [createClass({ id: serviceId, name: 'Service' })] });

    const result = applyDelta(state, dependencyDelta(state, uuidv4(), serviceId));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('ClassNotFoundError');
    expect(state.dependencies).toHaveLength(0);
  });

  it('REJECTS create when the supplier class does not exist; model unchanged', () => {
    const orderId = uuidv4();
    const state = createDiagram({ classes: [createClass({ id: orderId, name: 'Order' })] });

    const result = applyDelta(state, dependencyDelta(state, orderId, uuidv4()));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('ClassNotFoundError');
    expect(state.dependencies).toHaveLength(0);
  });

  it('REJECTS a duplicate dependency (same client + supplier) even with a different id', () => {
    const orderId = uuidv4();
    const serviceId = uuidv4();
    const existing = { id: uuidv4(), clientClassId: orderId, supplierClassId: serviceId };
    const state = createDiagram({
      classes: [
        createClass({ id: orderId, name: 'Order' }),
        createClass({ id: serviceId, name: 'Service' }),
      ],
      dependencies: [existing],
    });

    const result = applyDelta(state, dependencyDelta(state, orderId, serviceId));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('DuplicateDependencyError');
    expect(state.dependencies).toHaveLength(1);
  });

  it('ALLOWS the same client depending on TWO different suppliers (triangulates the duplicate rule)', () => {
    const orderId = uuidv4();
    const serviceA = uuidv4();
    const serviceB = uuidv4();
    const state = createDiagram({
      classes: [
        createClass({ id: orderId, name: 'Order' }),
        createClass({ id: serviceA, name: 'ServiceA' }),
        createClass({ id: serviceB, name: 'ServiceB' }),
      ],
      dependencies: [{ id: uuidv4(), clientClassId: orderId, supplierClassId: serviceA }],
    });

    const result = applyDelta(state, dependencyDelta(state, orderId, serviceB));

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.dependencies).toHaveLength(2);
  });

  it('ALLOWS two different clients depending on the SAME supplier', () => {
    const supplierId = uuidv4();
    const order1 = uuidv4();
    const order2 = uuidv4();
    const state = createDiagram({
      classes: [
        createClass({ id: order1, name: 'Order' }),
        createClass({ id: order2, name: 'Customer' }),
        createClass({ id: supplierId, name: 'Service' }),
      ],
      dependencies: [{ id: uuidv4(), clientClassId: order1, supplierClassId: supplierId }],
    });

    const result = applyDelta(state, dependencyDelta(state, order2, supplierId));

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.dependencies).toHaveLength(2);
  });

  it('DELETES a dependency edge by id', () => {
    const orderId = uuidv4();
    const serviceId = uuidv4();
    const depId = uuidv4();
    const state = createDiagram({
      classes: [
        createClass({ id: orderId, name: 'Order' }),
        createClass({ id: serviceId, name: 'Service' }),
      ],
      dependencies: [{ id: depId, clientClassId: orderId, supplierClassId: serviceId }],
    });

    const result = applyDelta(state, deleteDependencyDelta(state, depId));

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.dependencies).toHaveLength(0);
  });

  it('REJECTS delete of an unknown dependency', () => {
    const state = createDiagram({ classes: [createClass({ name: 'Item' })] });

    const result = applyDelta(state, deleteDependencyDelta(state, uuidv4()));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('DependencyNotFoundError');
  });

  it('delete-class CASCADES: removes dependencies where the class is client AND where it is supplier', () => {
    const orderId = uuidv4();
    const customerId = uuidv4();
    const serviceId = uuidv4();
    // Edges are seeded directly through the IR (not the engine) so the cascade
    // can be proven for BOTH roles.
    const validState = createDiagram({
      classes: [
        createClass({ id: orderId, name: 'Order' }),
        createClass({ id: customerId, name: 'Customer' }),
        createClass({ id: serviceId, name: 'Service' }),
      ],
      dependencies: [
        { id: uuidv4(), clientClassId: orderId, supplierClassId: serviceId },    // Order is client
        { id: uuidv4(), clientClassId: customerId, supplierClassId: serviceId }, // unrelated to Order
        { id: uuidv4(), clientClassId: customerId, supplierClassId: orderId },   // Order as supplier
      ],
    });

    const deleteOrder = {
      id: uuidv4(),
      diagramId: validState.id,
      timestamp: new Date().toISOString(),
      kind: 'class' as const,
      op: 'delete' as const,
      classId: orderId,
    };

    const result = applyDelta(validState, deleteOrder);

    expect(result.ok).toBe(true);
    if (result.ok) {
      // Only the edge not touching Order survives.
      expect(result.value.dependencies).toHaveLength(1);
      expect(result.value.dependencies[0]).toMatchObject({ clientClassId: customerId, supplierClassId: serviceId });
      // No dangling endpoint references remain
      const remainingClassIds = result.value.classes.map((c) => c.id);
      for (const dep of result.value.dependencies) {
        expect(remainingClassIds).toContain(dep.clientClassId);
        expect(remainingClassIds).toContain(dep.supplierClassId);
      }
    }
  });

  it('batch: a dependency with a missing end inside a batch rejects the WHOLE batch (atomicity)', () => {
    const orderId = uuidv4();
    const missingId = uuidv4();
    const state = createDiagram({ classes: [createClass({ id: orderId, name: 'Order' })] });

    const batch = {
      id: uuidv4(),
      diagramId: state.id,
      timestamp: new Date().toISOString(),
      kind: 'batch' as const,
      deltas: [
        dependencyDelta(state, orderId, missingId), // supplier does not exist → invalid
        {
          id: uuidv4(),
          diagramId: state.id,
          timestamp: new Date().toISOString(),
          kind: 'class' as const,
          op: 'rename' as const,
          classId: orderId,
          newName: 'RenamedOrder',
        },
      ],
    };

    const result = applyDelta(state, batch);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('BatchError');
      if (result.error.kind === 'BatchError') {
        expect(result.error.failedDeltaIndex).toBe(0);
        expect(result.error.error.kind).toBe('ClassNotFoundError');
      }
    }
    // Nothing applied — rename did not leak
    expect(state.dependencies).toHaveLength(0);
    expect(state.classes[0]!.name).toBe('Order');
  });
});

describe('applyDelta — N-ary association invariants (unit 13.1, editor:R N-ary)', () => {
  function naryDelta(state: Diagram, memberEnds: { classId: string; multiplicity: string; role?: string }[], naryAssociationId = uuidv4(), name?: string) {
    return {
      id: uuidv4(),
      diagramId: state.id,
      timestamp: new Date().toISOString(),
      kind: 'naryAssociation' as const,
      op: 'create' as const,
      naryAssociationId,
      memberEnds,
      ...(name !== undefined ? { name } : {}),
    };
  }

  function deleteNaryDelta(state: Diagram, naryAssociationId: string) {
    return {
      id: uuidv4(),
      diagramId: state.id,
      timestamp: new Date().toISOString(),
      kind: 'naryAssociation' as const,
      op: 'delete' as const,
      naryAssociationId,
    };
  }

  function shopState(extra: Partial<Diagram> = {}): Diagram {
    return createDiagram({
      classes: [
        createClass({ name: 'Supplier' }),
        createClass({ name: 'Part' }),
        createClass({ name: 'Project' }),
      ],
      ...extra,
    });
  }

  it('CREATES a ternary association over three existing classes with per-end multiplicities and roles', () => {
    const [supplier, part, project] = shopState().classes;
    const state = createDiagram({ classes: [supplier!, part!, project!] });
    const naryId = uuidv4();

    const result = applyDelta(state, naryDelta(state, [
      { classId: supplier!.id, multiplicity: '1', role: 'supplier' },
      { classId: part!.id, multiplicity: '0..*' },
      { classId: project!.id, multiplicity: '1' },
    ], naryId, 'supply'));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.naryAssociations).toHaveLength(1);
      expect(result.value.naryAssociations[0]).toMatchObject({
        id: naryId,
        name: 'supply',
        memberEnds: [
          { classId: supplier!.id, multiplicity: '1', role: 'supplier' },
          { classId: part!.id, multiplicity: '0..*' },
          { classId: project!.id, multiplicity: '1' },
        ],
      });
    }
    // Input state untouched (immutability)
    expect(state.naryAssociations).toHaveLength(0);
  });

  it('REJECTS create with fewer than 3 member ends (n-ary means >= 3); model unchanged', () => {
    const [supplier, part] = shopState().classes;
    const state = createDiagram({ classes: [supplier!, part!] });

    const result = applyDelta(state, naryDelta(state, [
      { classId: supplier!.id, multiplicity: '1' },
      { classId: part!.id, multiplicity: '1' },
    ]));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('NaryAssociationMinEndsError');
    expect(state.naryAssociations).toHaveLength(0);
  });

  it('REJECTS create when a member class does not exist; model unchanged', () => {
    const [supplier, part] = shopState().classes;
    const state = createDiagram({ classes: [supplier!, part!] });

    const result = applyDelta(state, naryDelta(state, [
      { classId: supplier!.id, multiplicity: '1' },
      { classId: part!.id, multiplicity: '1' },
      { classId: uuidv4(), multiplicity: '1' }, // ghost member
    ]));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('ClassNotFoundError');
    expect(state.naryAssociations).toHaveLength(0);
  });

  it('REJECTS duplicate classId within one association memberEnds; model unchanged', () => {
    const [supplier, part, project] = shopState().classes;
    const state = createDiagram({ classes: [supplier!, part!, project!] });

    const result = applyDelta(state, naryDelta(state, [
      { classId: supplier!.id, multiplicity: '1' },
      { classId: supplier!.id, multiplicity: '0..*' }, // duplicate member
      { classId: project!.id, multiplicity: '1' },
    ]));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('DuplicateNaryMemberError');
    expect(state.naryAssociations).toHaveLength(0);
  });

  it('ALLOWS the same class to appear in TWO different n-ary associations (triangulates the duplicate rule)', () => {
    const [supplier, part, project] = shopState().classes;
    const other = createClass({ name: 'Contract' });
    const state = createDiagram({
      classes: [supplier!, part!, project!, other],
      naryAssociations: [
        {
          id: uuidv4(),
          memberEnds: [
            { classId: supplier!.id, multiplicity: '1' },
            { classId: part!.id, multiplicity: '1' },
            { classId: project!.id, multiplicity: '1' },
          ],
        },
      ],
    });

    const result = applyDelta(state, naryDelta(state, [
      { classId: supplier!.id, multiplicity: '1' }, // supplier reused across associations — valid
      { classId: part!.id, multiplicity: '1' },
      { classId: other.id, multiplicity: '1' },
    ]));

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.naryAssociations).toHaveLength(2);
  });

  it('DELETES an n-ary association by id', () => {
    const [supplier, part, project] = shopState().classes;
    const naryId = uuidv4();
    const state = createDiagram({
      classes: [supplier!, part!, project!],
      naryAssociations: [
        {
          id: naryId,
          memberEnds: [
            { classId: supplier!.id, multiplicity: '1' },
            { classId: part!.id, multiplicity: '1' },
            { classId: project!.id, multiplicity: '1' },
          ],
        },
      ],
    });

    const result = applyDelta(state, deleteNaryDelta(state, naryId));

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.naryAssociations).toHaveLength(0);
  });

  it('REJECTS delete of an unknown n-ary association', () => {
    const state = shopState();

    const result = applyDelta(state, deleteNaryDelta(state, uuidv4()));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('NaryAssociationNotFoundError');
  });

  it('delete-class CASCADE prunes the member end; an n-ary left with <3 ends is DELETED (spec: Member deletion prunes the n-ary)', () => {
    const [supplier, part, project] = shopState().classes;
    const survivorId = uuidv4();
    const doomedId = uuidv4();
    const state = createDiagram({
      classes: [supplier!, part!, project!],
      naryAssociations: [
        {
          id: doomedId,
          memberEnds: [
            { classId: supplier!.id, multiplicity: '1' },
            { classId: part!.id, multiplicity: '0..*' },
            { classId: project!.id, multiplicity: '1' },
          ],
        },
        {
          id: survivorId,
          memberEnds: [
            { classId: supplier!.id, multiplicity: '1' },
            { classId: part!.id, multiplicity: '1' },
            { classId: project!.id, multiplicity: '1' },
          ],
        },
      ],
    });

    // Delete Project: BOTH ternaries drop to 2 ends → both are removed entirely.
    const result = applyDelta(state, {
      id: uuidv4(),
      diagramId: state.id,
      timestamp: new Date().toISOString(),
      kind: 'class' as const,
      op: 'delete' as const,
      classId: project!.id,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.naryAssociations).toHaveLength(0);
      expect(result.value.classes).toHaveLength(2);
    }
  });

  it('delete-class CASCADE prunes one end of a QUATERNARY association: it survives with exactly 3 ends', () => {
    const [supplier, part, project] = shopState().classes;
    const contract = createClass({ name: 'Contract' });
    const naryId = uuidv4();
    const state = createDiagram({
      classes: [supplier!, part!, project!, contract],
      naryAssociations: [
        {
          id: naryId,
          memberEnds: [
            { classId: supplier!.id, multiplicity: '1', role: 'supplier' },
            { classId: part!.id, multiplicity: '0..*' },
            { classId: project!.id, multiplicity: '1' },
            { classId: contract.id, multiplicity: '0..1' },
          ],
        },
      ],
    });

    const result = applyDelta(state, {
      id: uuidv4(),
      diagramId: state.id,
      timestamp: new Date().toISOString(),
      kind: 'class' as const,
      op: 'delete' as const,
      classId: contract.id,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.naryAssociations).toHaveLength(1);
      const ends = result.value.naryAssociations[0]!.memberEnds;
      expect(ends).toHaveLength(3);
      expect(ends.map((e) => e.classId)).not.toContain(contract.id);
      // Surviving ends keep their multiplicities and roles untouched.
      expect(ends[0]).toMatchObject({ classId: supplier!.id, multiplicity: '1', role: 'supplier' });
      expect(ends[1]).toMatchObject({ classId: part!.id, multiplicity: '0..*' });
    }
  });

  it('delete-class CASCADE leaves n-ary associations that do not contain the class untouched', () => {
    const [supplier, part, project] = shopState().classes;
    const unrelated = createClass({ name: 'Unrelated' });
    const keptId = uuidv4();
    const keptEnds = [
      { classId: supplier!.id, multiplicity: '1' },
      { classId: part!.id, multiplicity: '1' },
      { classId: project!.id, multiplicity: '1' },
    ];
    const state = createDiagram({
      classes: [supplier!, part!, project!, unrelated],
      naryAssociations: [{ id: keptId, memberEnds: keptEnds }],
    });

    const result = applyDelta(state, {
      id: uuidv4(),
      diagramId: state.id,
      timestamp: new Date().toISOString(),
      kind: 'class' as const,
      op: 'delete' as const,
      classId: unrelated.id,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.naryAssociations).toHaveLength(1);
      expect(result.value.naryAssociations[0]!.id).toBe(keptId);
      expect(result.value.naryAssociations[0]!.memberEnds).toEqual(keptEnds);
    }
  });

  it('BINARY ASSOCIATIONS ARE UNTOUCHED by n-ary create/delete (separate collection — design D13)', () => {
    const [supplier, part, project] = shopState().classes;
    const binary = createAssociation(supplier!.id, part!.id);
    const state = createDiagram({ classes: [supplier!, part!, project!], associations: [binary] });

    const created = applyDelta(state, naryDelta(state, [
      { classId: supplier!.id, multiplicity: '1' },
      { classId: part!.id, multiplicity: '1' },
      { classId: project!.id, multiplicity: '1' },
    ]));
    expect(created.ok).toBe(true);
    if (created.ok) {
      expect(created.value.associations).toEqual([binary]);
      expect(created.value.naryAssociations).toHaveLength(1);

      const deleted = applyDelta(created.value, deleteNaryDelta(created.value, created.value.naryAssociations[0]!.id));
      expect(deleted.ok).toBe(true);
      if (deleted.ok) expect(deleted.value.associations).toEqual([binary]);
    }
  });

  it('delete-class cascade handles binary AND n-ary edges together in one pass', () => {
    const [supplier, part, project] = shopState().classes;
    const binary = createAssociation(supplier!.id, part!.id);
    const ternaryId = uuidv4();
    const state = createDiagram({
      classes: [supplier!, part!, project!],
      associations: [binary],
      naryAssociations: [
        {
          id: ternaryId,
          memberEnds: [
            { classId: supplier!.id, multiplicity: '1' },
            { classId: part!.id, multiplicity: '1' },
            { classId: project!.id, multiplicity: '1' },
          ],
        },
      ],
    });

    const result = applyDelta(state, {
      id: uuidv4(),
      diagramId: state.id,
      timestamp: new Date().toISOString(),
      kind: 'class' as const,
      op: 'delete' as const,
      classId: part!.id,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      // Binary association cascaded away (existing behavior preserved)…
      expect(result.value.associations).toHaveLength(0);
      // …and the ternary dropped below 3 ends, so it is gone too.
      expect(result.value.naryAssociations).toHaveLength(0);
    }
  });

  it('batch: an n-ary create with a missing member inside a batch rejects the WHOLE batch (atomicity)', () => {
    const [supplier, part] = shopState().classes;
    const state = createDiagram({ classes: [supplier!, part!] });

    const batch = {
      id: uuidv4(),
      diagramId: state.id,
      timestamp: new Date().toISOString(),
      kind: 'batch' as const,
      deltas: [
        naryDelta(state, [
          { classId: supplier!.id, multiplicity: '1' },
          { classId: part!.id, multiplicity: '1' },
          { classId: uuidv4(), multiplicity: '1' }, // missing member → invalid
        ]),
        {
          id: uuidv4(),
          diagramId: state.id,
          timestamp: new Date().toISOString(),
          kind: 'class' as const,
          op: 'rename' as const,
          classId: supplier!.id,
          newName: 'RenamedSupplier',
        },
      ],
    };

    const result = applyDelta(state, batch);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('BatchError');
      if (result.error.kind === 'BatchError') {
        expect(result.error.failedDeltaIndex).toBe(0);
        expect(result.error.error.kind).toBe('ClassNotFoundError');
      }
    }
    // Nothing applied — rename did not leak
    expect(state.naryAssociations).toHaveLength(0);
    expect(state.classes[0]!.name).toBe('Supplier');
  });

  // ── unit 13d fix A: n-ary `update` delta (diamond editing) ───────────────
  function updateNaryDelta(
    state: Diagram,
    naryAssociationId: string,
    updates: {
      name?: string;
      memberEnds?: { classId: string; multiplicity: string; role?: string }[];
    },
  ) {
    return {
      id: uuidv4(),
      diagramId: state.id,
      timestamp: new Date().toISOString(),
      kind: 'naryAssociation' as const,
      op: 'update' as const,
      naryAssociationId,
      ...(updates.name !== undefined ? { name: updates.name } : {}),
      ...(updates.memberEnds !== undefined ? { memberEnds: updates.memberEnds } : {}),
    };
  }

  function ternaryState(): { state: Diagram; naryId: string; ids: [string, string, string] } {
    const [supplier, part, project] = shopState().classes;
    const naryId = uuidv4();
    const state = createDiagram({
      classes: [supplier!, part!, project!],
      naryAssociations: [
        {
          id: naryId,
          name: 'supply',
          memberEnds: [
            { classId: supplier!.id, multiplicity: '1', role: 'supplier' },
            { classId: part!.id, multiplicity: '0..*' },
            { classId: project!.id, multiplicity: '1' },
          ],
        },
      ],
    });
    return { state, naryId, ids: [supplier!.id, part!.id, project!.id] };
  }

  it('UPDATE sets the n-ary name; member ends untouched', () => {
    const { state, naryId, ids } = ternaryState();

    const result = applyDelta(state, updateNaryDelta(state, naryId, { name: 'delivers' }));

    expect(result.ok).toBe(true);
    if (result.ok) {
      const nary = result.value.naryAssociations[0]!;
      expect(nary.name).toBe('delivers');
      expect(nary.memberEnds).toEqual([
        { classId: ids[0], multiplicity: '1', role: 'supplier' },
        { classId: ids[1], multiplicity: '0..*' },
        { classId: ids[2], multiplicity: '1' },
      ]);
    }
    // Input state untouched (immutability)
    expect(state.naryAssociations[0]!.name).toBe('supply');
  });

  it('UPDATE with an empty name clears it (mirrors edge label semantics)', () => {
    const { state, naryId } = ternaryState();

    const result = applyDelta(state, updateNaryDelta(state, naryId, { name: '' }));

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.naryAssociations[0]!.name).toBeUndefined();
  });

  it('UPDATE replaces memberEnds — an end multiplicity edit round-trips', () => {
    const { state, naryId, ids } = ternaryState();

    const result = applyDelta(state, updateNaryDelta(state, naryId, {
      memberEnds: [
        { classId: ids[0], multiplicity: '*', role: 'supplier' },
        { classId: ids[1], multiplicity: '0..*' },
        { classId: ids[2], multiplicity: '1' },
      ],
    }));

    expect(result.ok).toBe(true);
    if (result.ok) {
      const ends = result.value.naryAssociations[0]!.memberEnds;
      expect(ends[0]).toMatchObject({ classId: ids[0], multiplicity: '*', role: 'supplier' });
      expect(ends[1]!.multiplicity).toBe('0..*');
      // Name survives an ends-only update.
      expect(result.value.naryAssociations[0]!.name).toBe('supply');
    }
  });

  it('UPDATE REJECTS fewer than 3 ends (same invariant as create); model unchanged', () => {
    const { state, naryId, ids } = ternaryState();

    const result = applyDelta(state, updateNaryDelta(state, naryId, {
      memberEnds: [
        { classId: ids[0], multiplicity: '1' },
        { classId: ids[1], multiplicity: '1' },
      ],
    }));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('NaryAssociationMinEndsError');
    expect(state.naryAssociations[0]!.memberEnds).toHaveLength(3);
  });

  it('UPDATE REJECTS an unknown member class; model unchanged', () => {
    const { state, naryId, ids } = ternaryState();

    const result = applyDelta(state, updateNaryDelta(state, naryId, {
      memberEnds: [
        { classId: ids[0], multiplicity: '1' },
        { classId: ids[1], multiplicity: '1' },
        { classId: uuidv4(), multiplicity: '1' }, // ghost member
      ],
    }));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('ClassNotFoundError');
    expect(state.naryAssociations[0]!.memberEnds[2]!.classId).toBe(ids[2]);
  });

  it('UPDATE REJECTS duplicate ends; model unchanged', () => {
    const { state, naryId, ids } = ternaryState();

    const result = applyDelta(state, updateNaryDelta(state, naryId, {
      memberEnds: [
        { classId: ids[0], multiplicity: '1' },
        { classId: ids[0], multiplicity: '0..*' }, // duplicate member
        { classId: ids[2], multiplicity: '1' },
      ],
    }));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('DuplicateNaryMemberError');
    expect(state.naryAssociations[0]!.memberEnds).toHaveLength(3);
  });

  it('UPDATE of an unknown n-ary association → NaryAssociationNotFoundError', () => {
    const { state, ids } = ternaryState();

    const result = applyDelta(state, updateNaryDelta(state, uuidv4(), {
      memberEnds: [
        { classId: ids[0], multiplicity: '1' },
        { classId: ids[1], multiplicity: '1' },
        { classId: ids[2], multiplicity: '1' },
      ],
    }));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('NaryAssociationNotFoundError');
  });

  it('UPDATE carrying name AND memberEnds applies both in one delta', () => {
    const { state, naryId, ids } = ternaryState();

    const result = applyDelta(state, updateNaryDelta(state, naryId, {
      name: 'renamed',
      memberEnds: [
        { classId: ids[0], multiplicity: '2' },
        { classId: ids[1], multiplicity: '1' },
        { classId: ids[2], multiplicity: '1' },
      ],
    }));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.naryAssociations[0]!.name).toBe('renamed');
      expect(result.value.naryAssociations[0]!.memberEnds[0]!.multiplicity).toBe('2');
    }
  });
});

describe('applyDelta — Edge label updates (unit 13c, unified edge editing)', () => {
  function edgeState(): Diagram {
    const orderId = uuidv4();
    const itemTypeId = uuidv4();
    const repoId = uuidv4();
    return createDiagram({
      classes: [
        createClass({ id: orderId, name: 'Order' }),
        createClass({ id: itemTypeId, name: 'ItemType' }),
        createClass({ id: repoId, name: 'Repository', kind: 'interface' }),
      ],
      generalizations: [{ id: uuidv4(), subClassId: orderId, superClassId: itemTypeId }],
      realizations: [{ id: uuidv4(), clientClassId: orderId, supplierInterfaceId: repoId }],
      dependencies: [{ id: uuidv4(), clientClassId: orderId, supplierClassId: itemTypeId }],
    });
  }

  function updateEdgeDelta(
    state: Diagram,
    kind: 'generalization' | 'realization' | 'dependency',
    idField: 'generalizationId' | 'realizationId' | 'dependencyId',
    edgeId: string,
    name: string,
  ) {
    return {
      id: uuidv4(),
      diagramId: state.id,
      timestamp: new Date().toISOString(),
      kind: kind as const,
      op: 'update' as const,
      [idField]: edgeId,
      name,
    };
  }

  it('UPDATES a generalization name; endpoints untouched; delete still works afterwards', () => {
    const state = edgeState();
    const gen = state.generalizations[0]!;

    const result = applyDelta(state, updateEdgeDelta(state, 'generalization', 'generalizationId', gen.id, 'inherits'));

    expect(result.ok).toBe(true);
    if (result.ok) {
      const updated = result.value.generalizations[0]!;
      expect(updated.name).toBe('inherits');
      expect(updated.subClassId).toBe(gen.subClassId);
      expect(updated.superClassId).toBe(gen.superClassId);
      // Input state untouched (immutability)
      expect(state.generalizations[0]!.name).toBeUndefined();

      // Delete still works on an edge that carries a name.
      const deleted = applyDelta(result.value, {
        id: uuidv4(),
        diagramId: result.value.id,
        timestamp: new Date().toISOString(),
        kind: 'generalization' as const,
        op: 'delete' as const,
        generalizationId: gen.id,
      });
      expect(deleted.ok).toBe(true);
      if (deleted.ok) expect(deleted.value.generalizations).toHaveLength(0);
    }
  });

  it('UPDATES a realization name', () => {
    const state = edgeState();
    const real = state.realizations[0]!;

    const result = applyDelta(state, updateEdgeDelta(state, 'realization', 'realizationId', real.id, 'implements'));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.realizations[0]!.name).toBe('implements');
      expect(result.value.realizations[0]!.clientClassId).toBe(real.clientClassId);
    }
  });

  it('UPDATES a dependency name', () => {
    const state = edgeState();
    const dep = state.dependencies[0]!;

    const result = applyDelta(state, updateEdgeDelta(state, 'dependency', 'dependencyId', dep.id, 'uses'));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.dependencies[0]!.name).toBe('uses');
      expect(result.value.dependencies[0]!.clientClassId).toBe(dep.clientClassId);
    }
  });

  it('an EMPTY name clears the label (back to undefined)', () => {
    const state = edgeState();
    const gen = state.generalizations[0]!;

    const named = applyDelta(state, updateEdgeDelta(state, 'generalization', 'generalizationId', gen.id, 'inherits'));
    expect(named.ok).toBe(true);
    if (named.ok) {
      const cleared = applyDelta(named.value, updateEdgeDelta(named.value, 'generalization', 'generalizationId', gen.id, ''));
      expect(cleared.ok).toBe(true);
      if (cleared.ok) expect(cleared.value.generalizations[0]!.name).toBeUndefined();
    }
  });

  it('REJECTS update of an unknown edge with the matching NotFound error; model unchanged', () => {
    const state = edgeState();

    const cases: {
      kind: 'generalization' | 'realization' | 'dependency';
      idField: 'generalizationId' | 'realizationId' | 'dependencyId';
      error: string;
    }[] = [
      { kind: 'generalization', idField: 'generalizationId', error: 'GeneralizationNotFoundError' },
      { kind: 'realization', idField: 'realizationId', error: 'RealizationNotFoundError' },
      { kind: 'dependency', idField: 'dependencyId', error: 'DependencyNotFoundError' },
    ];

    for (const { kind, idField, error } of cases) {
      const result = applyDelta(state, updateEdgeDelta(state, kind, idField, uuidv4(), 'ghost'));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe(error);
    }
    // Nothing leaked
    expect(state.generalizations[0]!.name).toBeUndefined();
    expect(state.realizations[0]!.name).toBeUndefined();
    expect(state.dependencies[0]!.name).toBeUndefined();
  });

  it('update on one edge kind does not touch the other collections', () => {
    const state = edgeState();
    const gen = state.generalizations[0]!;

    const result = applyDelta(state, updateEdgeDelta(state, 'generalization', 'generalizationId', gen.id, 'inherits'));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.realizations[0]!.name).toBeUndefined();
      expect(result.value.dependencies[0]!.name).toBeUndefined();
      expect(result.value.associations).toEqual(state.associations);
    }
  });
});

describe('applyDelta — optional association multiplicities (unit 13d fix C: comp/aggregation start unspecified)', () => {
  function pairState(): { state: Diagram; aId: string; bId: string } {
    const aId = uuidv4();
    const bId = uuidv4();
    const state = createDiagram({
      classes: [createClass({ id: aId, name: 'Order' }), createClass({ id: bId, name: 'Item' })],
    });
    return { state, aId, bId };
  }

  it('CREATES an association WITHOUT multiplicities — both ends stay unspecified (undefined, NOT "1")', () => {
    const { state, aId, bId } = pairState();

    const result = applyDelta(state, {
      id: uuidv4(),
      diagramId: state.id,
      timestamp: new Date().toISOString(),
      kind: 'association' as const,
      op: 'create' as const,
      associationId: uuidv4(),
      sourceClassId: aId,
      targetClassId: bId,
      directed: false,
      aggregation: 'composite',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      const assoc = result.value.associations[0]!;
      expect(assoc.sourceMultiplicity).toBeUndefined();
      expect(assoc.targetMultiplicity).toBeUndefined();
      expect(assoc.aggregation).toBe('composite');
    }
  });

  it('updateMultiplicity with NULL clears an end to unspecified; the other end is untouched', () => {
    const { state, aId, bId } = pairState();
    const associationId = uuidv4();
    const created = applyDelta(state, {
      id: uuidv4(),
      diagramId: state.id,
      timestamp: new Date().toISOString(),
      kind: 'association' as const,
      op: 'create' as const,
      associationId,
      sourceClassId: aId,
      targetClassId: bId,
      sourceMultiplicity: '1' as const,
      targetMultiplicity: '0..*' as const,
      directed: false,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const cleared = applyDelta(created.value, {
      id: uuidv4(),
      diagramId: state.id,
      timestamp: new Date().toISOString(),
      kind: 'association' as const,
      op: 'updateMultiplicity' as const,
      associationId,
      newSourceMultiplicity: null,
    });

    expect(cleared.ok).toBe(true);
    if (cleared.ok) {
      const assoc = cleared.value.associations[0]!;
      expect(assoc.sourceMultiplicity).toBeUndefined();
      expect(assoc.targetMultiplicity).toBe('0..*');
    }
  });

  it('updateMultiplicity carrying ONLY a null clear passes the at-least-one guard', () => {
    const { state, aId, bId } = pairState();
    const associationId = uuidv4();
    const created = applyDelta(state, {
      id: uuidv4(),
      diagramId: state.id,
      timestamp: new Date().toISOString(),
      kind: 'association' as const,
      op: 'create' as const,
      associationId,
      sourceClassId: aId,
      targetClassId: bId,
      sourceMultiplicity: '1' as const,
      targetMultiplicity: '1' as const,
      directed: false,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const cleared = applyDelta(created.value, {
      id: uuidv4(),
      diagramId: state.id,
      timestamp: new Date().toISOString(),
      kind: 'association' as const,
      op: 'updateMultiplicity' as const,
      associationId,
      newTargetMultiplicity: null,
    });

    expect(cleared.ok).toBe(true);
    if (cleared.ok) expect(cleared.value.associations[0]!.targetMultiplicity).toBeUndefined();
  });

  it('create still REJECTS missing endpoints/directed — optionality did not loosen the rest', () => {
    const { state, aId } = pairState();

    const result = applyDelta(state, {
      id: uuidv4(),
      diagramId: state.id,
      timestamp: new Date().toISOString(),
      kind: 'association' as const,
      op: 'create' as const,
      associationId: uuidv4(),
      sourceClassId: aId,
      // targetClassId missing, directed missing
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('InvalidOperationError');
  });

  it('backward compat: create WITH multiplicities still stores the exact values', () => {
    const { state, aId, bId } = pairState();

    const result = applyDelta(state, {
      id: uuidv4(),
      diagramId: state.id,
      timestamp: new Date().toISOString(),
      kind: 'association' as const,
      op: 'create' as const,
      associationId: uuidv4(),
      sourceClassId: aId,
      targetClassId: bId,
      sourceMultiplicity: '1' as const,
      targetMultiplicity: '0..*' as const,
      directed: true,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.associations[0]!.sourceMultiplicity).toBe('1');
      expect(result.value.associations[0]!.targetMultiplicity).toBe('0..*');
    }
  });

  it('allows batch delete of all classes and explicit naryAssociation delete without failing (idempotent cascade prune)', () => {
    const classA = createClass({ name: 'A' });
    const classB = createClass({ name: 'B' });
    const classC = createClass({ name: 'C' });
    const naryId = uuidv4();
    const state = createDiagram({
      classes: [classA, classB, classC],
      naryAssociations: [
        {
          id: naryId,
          name: 'Ternary',
          memberEnds: [
            { classId: classA.id, multiplicity: '1' },
            { classId: classB.id, multiplicity: '1' },
            { classId: classC.id, multiplicity: '1' },
          ],
        },
      ],
    });

    // Batch contains delete of all 3 classes AND an explicit delete of the n-ary association.
    // Deleting class A drops the n-ary to 2 ends, which cascade-deletes it.
    // The later explicit delete of naryAssociation must not fail with BatchError.
    const batchDelta = {
      id: uuidv4(),
      diagramId: state.id,
      timestamp: new Date().toISOString(),
      kind: 'batch' as const,
      deltas: [
        {
          id: uuidv4(),
          diagramId: state.id,
          timestamp: new Date().toISOString(),
          kind: 'class' as const,
          op: 'delete' as const,
          classId: classA.id,
        },
        {
          id: uuidv4(),
          diagramId: state.id,
          timestamp: new Date().toISOString(),
          kind: 'class' as const,
          op: 'delete' as const,
          classId: classB.id,
        },
        {
          id: uuidv4(),
          diagramId: state.id,
          timestamp: new Date().toISOString(),
          kind: 'class' as const,
          op: 'delete' as const,
          classId: classC.id,
        },
        {
          id: uuidv4(),
          diagramId: state.id,
          timestamp: new Date().toISOString(),
          kind: 'naryAssociation' as const,
          op: 'delete' as const,
          naryAssociationId: naryId,
        },
      ],
    };

    const result = applyDelta(state, batchDelta);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.classes).toHaveLength(0);
      expect(result.value.naryAssociations).toHaveLength(0);
    }
  });
});
