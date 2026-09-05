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
