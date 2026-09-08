import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  buildYDocFromDiagram,
  projectYDocToDiagram,
  encodeYDoc,
  applyUpdateToYDoc,
  loadYDocFromUpdate,
  validateYDocProjection,
} from './ydoc.js';
import { DiagramSchema, type Diagram } from './ir.js';
import { applyDelta } from './apply.js';

/**
 * Creates a valid test diagram with classes, attributes, methods, associations, and positions.
 */
function createTestDiagram(): Diagram {
  return DiagramSchema.parse({
    id: '550e8400-e29b-41d4-a716-446655440000',
    name: 'Test Diagram',
    classes: [
      {
        id: '550e8400-e29b-41d4-a716-446655440001',
        name: 'User',
        position: { x: 100, y: 200 },
        attributes: [
          { id: '550e8400-e29b-41d4-a716-446655440002', name: 'id', type: 'UUID' },
          { id: '550e8400-e29b-41d4-a716-446655440003', name: 'email', type: 'string' },
        ],
        methods: [
          {
            id: '550e8400-e29b-41d4-a716-446655440004',
            name: 'login',
            returnType: 'boolean',
            parameters: [{ name: 'password', type: 'string' }],
          },
        ],
      },
      {
        id: '550e8400-e29b-41d4-a716-446655440005',
        name: 'Order',
        position: { x: 300, y: 200 },
        attributes: [
          { id: '550e8400-e29b-41d4-a716-446655440006', name: 'id', type: 'UUID' },
          { id: '550e8400-e29b-41d4-a716-446655440007', name: 'total', type: 'number' },
        ],
        methods: [],
      },
    ],
    associations: [
      {
        id: '550e8400-e29b-41d4-a716-446655440008',
        sourceClassId: '550e8400-e29b-41d4-a716-446655440001',
        targetClassId: '550e8400-e29b-41d4-a716-446655440005',
        sourceMultiplicity: '1',
        targetMultiplicity: '0..*',
        directed: true,
      },
    ],
  });
}

describe('ydoc codec', () => {
  it('builds a Y.Doc from a diagram and projects back losslessly', () => {
    const original = createTestDiagram();
    const doc = buildYDocFromDiagram(original);
    const projected = projectYDocToDiagram(doc);

    expect(projected.id).toBe(original.id);
    expect(projected.name).toBe(original.name);
    expect(projected.classes).toHaveLength(original.classes.length);
    expect(projected.associations).toHaveLength(original.associations.length);

    // Check class details
    for (const origClass of original.classes) {
      const projClass = projected.classes.find(c => c.id === origClass.id);
      expect(projClass).toBeDefined();
      expect(projClass!.name).toBe(origClass.name);
      expect(projClass!.position).toEqual(origClass.position);
      expect(projClass!.attributes).toEqual(origClass.attributes);
      expect(projClass!.methods).toEqual(origClass.methods);
    }

    // Check association details
    for (const origAssoc of original.associations) {
      const projAssoc = projected.associations.find(a => a.id === origAssoc.id);
      expect(projAssoc).toBeDefined();
      expect(projAssoc!.sourceClassId).toBe(origAssoc.sourceClassId);
      expect(projAssoc!.targetClassId).toBe(origAssoc.targetClassId);
      expect(projAssoc!.sourceMultiplicity).toBe(origAssoc.sourceMultiplicity);
      expect(projAssoc!.targetMultiplicity).toBe(origAssoc.targetMultiplicity);
      expect(projAssoc!.directed).toBe(origAssoc.directed);
    }
  });

  it('encodes a Y.Doc to update bytes and loads it back', () => {
    const original = createTestDiagram();
    const doc = buildYDocFromDiagram(original);
    const update = encodeYDoc(doc);

    expect(update).toBeInstanceOf(Uint8Array);
    expect(update.length).toBeGreaterThan(0);

    // Load into a fresh doc
    const loadedDoc = loadYDocFromUpdate(update);
    const projected = projectYDocToDiagram(loadedDoc);

    expect(projected.id).toBe(original.id);
    expect(projected.name).toBe(original.name);
    expect(projected.classes).toHaveLength(original.classes.length);
    expect(projected.associations).toHaveLength(original.associations.length);
  });

  it('applies update bytes to an existing Y.Doc', () => {
    const original = createTestDiagram();
    const doc = buildYDocFromDiagram(original);
    const update = encodeYDoc(doc);

    const targetDoc = new Y.Doc();
    applyUpdateToYDoc(targetDoc, update);
    const projected = projectYDocToDiagram(targetDoc);

    expect(projected.id).toBe(original.id);
    expect(projected.name).toBe(original.name);
  });

  it('validateYDocProjection returns ok for valid doc', () => {
    const original = createTestDiagram();
    const doc = buildYDocFromDiagram(original);
    const result = validateYDocProjection(doc);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.diagram.id).toBe(original.id);
    }
  });

  it('validateYDocProjection returns error for corrupted doc structure', () => {
    const doc = new Y.Doc();
    const yClasses = doc.getMap('classes');
    // Put invalid data - missing required fields
    const yClass = new Y.Map();
    yClass.set('id', 'not-a-uuid'); // invalid uuid
    yClass.set('name', ''); // empty name
    yClasses.set('bad-class', yClass);

    const result = validateYDocProjection(doc);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(Error);
    }
  });

  it('handles all multiplicity values correctly', () => {
    const diagram = DiagramSchema.parse({
      id: '550e8400-e29b-41d4-a716-446655440000',
      name: 'Multiplicity Test',
      classes: [
        { id: '550e8400-e29b-41d4-a716-446655440001', name: 'A', position: { x: 0, y: 0 }, attributes: [], methods: [] },
        { id: '550e8400-e29b-41d4-a716-446655440002', name: 'B', position: { x: 100, y: 0 }, attributes: [], methods: [] },
        { id: '550e8400-e29b-41d4-a716-446655440003', name: 'C', position: { x: 200, y: 0 }, attributes: [], methods: [] },
        { id: '550e8400-e29b-41d4-a716-446655440004', name: 'D', position: { x: 300, y: 0 }, attributes: [], methods: [] },
      ],
      associations: [
        { id: '550e8400-e29b-41d4-a716-446655440005', sourceClassId: '550e8400-e29b-41d4-a716-446655440001', targetClassId: '550e8400-e29b-41d4-a716-446655440002', sourceMultiplicity: '1', targetMultiplicity: '1', directed: true },
        { id: '550e8400-e29b-41d4-a716-446655440006', sourceClassId: '550e8400-e29b-41d4-a716-446655440001', targetClassId: '550e8400-e29b-41d4-a716-446655440003', sourceMultiplicity: '0..1', targetMultiplicity: '1..*', directed: true },
        { id: '550e8400-e29b-41d4-a716-446655440007', sourceClassId: '550e8400-e29b-41d4-a716-446655440001', targetClassId: '550e8400-e29b-41d4-a716-446655440004', sourceMultiplicity: '1..*', targetMultiplicity: '0..*', directed: false },
      ],
    });

    const doc = buildYDocFromDiagram(diagram);
    const update = encodeYDoc(doc);
    const loadedDoc = loadYDocFromUpdate(update);
    const projected = projectYDocToDiagram(loadedDoc);

    expect(projected.associations).toHaveLength(3);
    const mults = projected.associations.map(a => `${a.sourceMultiplicity}|${a.targetMultiplicity}`).sort();
    expect(mults).toEqual(['0..1|1..*', '1..*|0..*', '1|1']);
  });

  it('handles empty arrays for attributes and methods', () => {
    const diagram = DiagramSchema.parse({
      id: '550e8400-e29b-41d4-a716-446655440000',
      name: 'Empty Members',
      classes: [
        { id: '550e8400-e29b-41d4-a716-446655440001', name: 'EmptyClass', position: { x: 0, y: 0 }, attributes: [], methods: [] },
      ],
      associations: [],
    });

    const doc = buildYDocFromDiagram(diagram);
    const update = encodeYDoc(doc);
    const loadedDoc = loadYDocFromUpdate(update);
    const projected = projectYDocToDiagram(loadedDoc);

    expect(projected.classes[0].attributes).toEqual([]);
    expect(projected.classes[0].methods).toEqual([]);
  });

  it('loadYDocFromUpdate throws on corrupt blob', () => {
    const corruptUpdate = new Uint8Array([0xff, 0xfe, 0xfd, 0xfc]); // Not a valid Yjs update
    expect(() => loadYDocFromUpdate(corruptUpdate)).toThrow();
  });

  it('applyUpdateToYDoc throws on corrupt blob', () => {
    const doc = new Y.Doc();
    const corruptUpdate = new Uint8Array([0xff, 0xfe, 0xfd, 0xfc]);
    expect(() => applyUpdateToYDoc(doc, corruptUpdate)).toThrow();
  });
});

describe('ydoc codec — Association aggregationEnd round-trip', () => {
  it('buildYDocFromDiagram → projectYDocToDiagram preserves aggregationEnd', () => {
    const diagram = DiagramSchema.parse({
      id: '550e8400-e29b-41d4-a716-446655440000',
      name: 'AggregationEnd Test',
      classes: [
        { id: '550e8400-e29b-41d4-a716-446655440001', name: 'Order', position: { x: 0, y: 0 }, attributes: [], methods: [] },
        { id: '550e8400-e29b-41d4-a716-446655440002', name: 'OrderLine', position: { x: 300, y: 0 }, attributes: [], methods: [] },
      ],
      associations: [
        {
          id: '550e8400-e29b-41d4-a716-446655440003',
          sourceClassId: '550e8400-e29b-41d4-a716-446655440001',
          targetClassId: '550e8400-e29b-41d4-a716-446655440002',
          sourceMultiplicity: '1',
          targetMultiplicity: '0..*',
          directed: false,
          aggregation: 'composite',
          aggregationEnd: 'target',
        },
        {
          id: '550e8400-e29b-41d4-a716-446655440004',
          sourceClassId: '550e8400-e29b-41d4-a716-446655440001',
          targetClassId: '550e8400-e29b-41d4-a716-446655440002',
          sourceMultiplicity: '1',
          targetMultiplicity: '0..*',
          directed: false,
          aggregation: 'shared',
          aggregationEnd: 'source',
        },
      ],
    });

    const doc = buildYDocFromDiagram(diagram);
    const projected = projectYDocToDiagram(doc);

    expect(projected.associations).toHaveLength(2);
    const compositeAssoc = projected.associations.find(a => a.aggregation === 'composite')!;
    expect(compositeAssoc.aggregationEnd).toBe('target');
    const sharedAssoc = projected.associations.find(a => a.aggregation === 'shared')!;
    expect(sharedAssoc.aggregationEnd).toBe('source');
  });

  it('round-trip through encode/load preserves aggregationEnd', () => {
    const diagram = DiagramSchema.parse({
      id: '550e8400-e29b-41d4-a716-446655440000',
      name: 'AggregationEnd Test',
      classes: [
        { id: '550e8400-e29b-41d4-a716-446655440001', name: 'Order', position: { x: 0, y: 0 }, attributes: [], methods: [] },
        { id: '550e8400-e29b-41d4-a716-446655440002', name: 'OrderLine', position: { x: 300, y: 0 }, attributes: [], methods: [] },
      ],
      associations: [
        {
          id: '550e8400-e29b-41d4-a716-446655440003',
          sourceClassId: '550e8400-e29b-41d4-a716-446655440001',
          targetClassId: '550e8400-e29b-41d4-a716-446655440002',
          sourceMultiplicity: '1',
          targetMultiplicity: '0..*',
          directed: false,
          aggregation: 'composite',
          aggregationEnd: 'target',
        },
      ],
    });

    const doc = buildYDocFromDiagram(diagram);
    const update = encodeYDoc(doc);
    const loadedDoc = loadYDocFromUpdate(update);
    const projected = projectYDocToDiagram(loadedDoc);

    expect(projected.associations).toHaveLength(1);
    expect(projected.associations[0].aggregationEnd).toBe('target');
  });

  it('associations without aggregationEnd in Y.Doc get IR default "source" on projection', () => {
    // Simulate old Y.Doc without aggregationEnd field
    const doc = new Y.Doc();
    const yClasses = doc.getMap('classes');
    const yAssociations = doc.getMap('associations');
    const yMeta = doc.getMap('meta');

    yMeta.set('id', '550e8400-e29b-41d4-a716-446655440000');
    yMeta.set('name', 'Old Diagram');

    const yClass1 = new Y.Map();
    yClass1.set('id', '550e8400-e29b-41d4-a716-446655440001');
    yClass1.set('name', 'Order');
    yClass1.set('position', new Y.Map([['x', 0], ['y', 0]]));
    yClass1.set('attributes', new Y.Array());
    yClass1.set('methods', new Y.Array());
    yClasses.set('550e8400-e29b-41d4-a716-446655440001', yClass1);

    const yClass2 = new Y.Map();
    yClass2.set('id', '550e8400-e29b-41d4-a716-446655440002');
    yClass2.set('name', 'OrderLine');
    yClass2.set('position', new Y.Map([['x', 300], ['y', 0]]));
    yClass2.set('attributes', new Y.Array());
    yClass2.set('methods', new Y.Array());
    yClasses.set('550e8400-e29b-41d4-a716-446655440002', yClass2);

    const yAssoc = new Y.Map();
    yAssoc.set('id', '550e8400-e29b-41d4-a716-446655440003');
    yAssoc.set('sourceClassId', '550e8400-e29b-41d4-a716-446655440001');
    yAssoc.set('targetClassId', '550e8400-e29b-41d4-a716-446655440002');
    yAssoc.set('sourceMultiplicity', '1');
    yAssoc.set('targetMultiplicity', '0..*');
    yAssoc.set('directed', false);
    yAssoc.set('aggregation', 'composite');
    // aggregationEnd NOT SET (old doc)
    yAssociations.set('550e8400-e29b-41d4-a716-446655440003', yAssoc);

    const projected = projectYDocToDiagram(doc);
    expect(projected.associations).toHaveLength(1);
    expect(projected.associations[0].aggregationEnd).toBe('source'); // IR default
  });
});

describe('ydoc codec — Generalization round-trip (unit 11.1)', () => {
  function diagramWithGeneralization(): Diagram {
    return DiagramSchema.parse({
      id: '550e8400-e29b-41d4-a716-446655440000',
      name: 'Inheritance Test',
      classes: [
        { id: '550e8400-e29b-41d4-a716-446655440001', name: 'Item', position: { x: 0, y: 0 }, attributes: [], methods: [] },
        { id: '550e8400-e29b-41d4-a716-446655440002', name: 'Product', position: { x: 300, y: 0 }, attributes: [], methods: [] },
      ],
      associations: [],
      generalizations: [
        {
          id: '550e8400-e29b-41d4-a716-446655440003',
          subClassId: '550e8400-e29b-41d4-a716-446655440002',
          superClassId: '550e8400-e29b-41d4-a716-446655440001',
        },
      ],
    });
  }

  it('buildYDocFromDiagram → projectYDocToDiagram preserves generalizations losslessly', () => {
    const original = diagramWithGeneralization();
    const doc = buildYDocFromDiagram(original);
    const projected = projectYDocToDiagram(doc);

    expect(projected.generalizations).toHaveLength(1);
    expect(projected.generalizations[0]).toEqual(original.generalizations[0]);
  });

  it('round-trip through encode/load preserves generalizations (blob-authoritative path)', () => {
    const original = diagramWithGeneralization();
    const doc = buildYDocFromDiagram(original);
    const update = encodeYDoc(doc);
    const loadedDoc = loadYDocFromUpdate(update);
    const projected = projectYDocToDiagram(loadedDoc);

    expect(projected.generalizations).toHaveLength(1);
    expect(projected.generalizations[0]!.subClassId).toBe('550e8400-e29b-41d4-a716-446655440002');
    expect(projected.generalizations[0]!.superClassId).toBe('550e8400-e29b-41d4-a716-446655440001');
  });

  it('backward compat: old Y.Doc without a generalizations map projects to empty collection', () => {
    // Simulate a pre-unit-11 doc: only classes/associations/meta maps exist.
    const doc = new Y.Doc();
    const yClasses = doc.getMap('classes');
    const yMeta = doc.getMap('meta');
    yMeta.set('id', '550e8400-e29b-41d4-a716-446655440000');
    yMeta.set('name', 'Old Diagram');
    const yClass1 = new Y.Map();
    yClass1.set('id', '550e8400-e29b-41d4-a716-446655440001');
    yClass1.set('name', 'Item');
    yClass1.set('position', new Y.Map([['x', 0], ['y', 0]]));
    yClass1.set('attributes', new Y.Array());
    yClass1.set('methods', new Y.Array());
    yClasses.set('550e8400-e29b-41d4-a716-446655440001', yClass1);

    const projected = projectYDocToDiagram(doc);
    expect(projected.generalizations).toEqual([]);
  });
});

describe('ydoc codec — Class kind/isAbstract + realizations round-trip (unit 12.1/12.6)', () => {
  function diagramWithInterfaceAndRealization(): Diagram {
    return DiagramSchema.parse({
      id: '550e8400-e29b-41d4-a716-446655440000',
      name: 'Interface Test',
      classes: [
        { id: '550e8400-e29b-41d4-a716-446655440001', name: 'Order', position: { x: 0, y: 0 }, attributes: [], methods: [] },
        { id: '550e8400-e29b-41d4-a716-446655440002', name: 'Repository', position: { x: 300, y: 0 }, attributes: [], methods: [], kind: 'interface' },
        { id: '550e8400-e29b-41d4-a716-446655440003', name: 'Shape', position: { x: 600, y: 0 }, attributes: [], methods: [], isAbstract: true },
      ],
      associations: [],
      realizations: [
        { id: '550e8400-e29b-41d4-a716-446655440004', clientClassId: '550e8400-e29b-41d4-a716-446655440001', supplierInterfaceId: '550e8400-e29b-41d4-a716-446655440002' },
      ],
    });
  }

  it('buildYDocFromDiagram → projectYDocToDiagram preserves kind, isAbstract and realizations losslessly', () => {
    const original = diagramWithInterfaceAndRealization();
    const doc = buildYDocFromDiagram(original);
    const projected = projectYDocToDiagram(doc);

    const iface = projected.classes.find((c) => c.name === 'Repository')!;
    expect(iface.kind).toBe('interface');
    const abstract = projected.classes.find((c) => c.name === 'Shape')!;
    expect(abstract.isAbstract).toBe(true);
    expect(abstract.kind).toBe('class');
    const plain = projected.classes.find((c) => c.name === 'Order')!;
    expect(plain.kind).toBe('class');
    expect(plain.isAbstract).toBe(false);

    expect(projected.realizations).toHaveLength(1);
    expect(projected.realizations[0]).toEqual(original.realizations[0]);
  });

  it('round-trip through encode/load preserves kind, isAbstract and realizations (blob-authoritative path)', () => {
    const original = diagramWithInterfaceAndRealization();
    const doc = buildYDocFromDiagram(original);
    const update = encodeYDoc(doc);
    const loadedDoc = loadYDocFromUpdate(update);
    const projected = projectYDocToDiagram(loadedDoc);

    expect(projected.realizations).toHaveLength(1);
    expect(projected.realizations[0]!.clientClassId).toBe('550e8400-e29b-41d4-a716-446655440001');
    expect(projected.realizations[0]!.supplierInterfaceId).toBe('550e8400-e29b-41d4-a716-446655440002');
    expect(projected.classes.find((c) => c.name === 'Repository')!.kind).toBe('interface');
    expect(projected.classes.find((c) => c.name === 'Shape')!.isAbstract).toBe(true);
  });

  it('backward compat: old Y.Doc without kind/isAbstract fields or realizations map projects IR defaults', () => {
    // Simulate a pre-unit-12 doc: class maps lack kind/isAbstract, no realizations map.
    const doc = new Y.Doc();
    const yClasses = doc.getMap('classes');
    const yMeta = doc.getMap('meta');
    yMeta.set('id', '550e8400-e29b-41d4-a716-446655440000');
    yMeta.set('name', 'Old Diagram');
    const yClass1 = new Y.Map();
    yClass1.set('id', '550e8400-e29b-41d4-a716-446655440001');
    yClass1.set('name', 'Order');
    yClass1.set('position', new Y.Map([['x', 0], ['y', 0]]));
    yClass1.set('attributes', new Y.Array());
    yClass1.set('methods', new Y.Array());
    // kind / isAbstract deliberately absent (pre-unit-12 writer)
    yClasses.set('550e8400-e29b-41d4-a716-446655440001', yClass1);

    const projected = projectYDocToDiagram(doc);
    expect(projected.classes[0]!.kind).toBe('class');
    expect(projected.classes[0]!.isAbstract).toBe(false);
    expect(projected.realizations).toEqual([]);
  });
});

describe('ydoc codec — Dependency round-trip (unit 12.2/12.6 — 12b half)', () => {
  function diagramWithDependency(): Diagram {
    return DiagramSchema.parse({
      id: '550e8400-e29b-41d4-a716-446655440000',
      name: 'Dependency Test',
      classes: [
        { id: '550e8400-e29b-41d4-a716-446655440001', name: 'Order', position: { x: 0, y: 0 }, attributes: [], methods: [] },
        { id: '550e8400-e29b-41d4-a716-446655440002', name: 'Service', position: { x: 300, y: 0 }, attributes: [], methods: [] },
      ],
      associations: [],
      dependencies: [
        { id: '550e8400-e29b-41d4-a716-446655440003', clientClassId: '550e8400-e29b-41d4-a716-446655440001', supplierClassId: '550e8400-e29b-41d4-a716-446655440002' },
      ],
    });
  }

  it('buildYDocFromDiagram → projectYDocToDiagram preserves dependencies losslessly', () => {
    const original = diagramWithDependency();
    const doc = buildYDocFromDiagram(original);
    const projected = projectYDocToDiagram(doc);

    expect(projected.dependencies).toHaveLength(1);
    expect(projected.dependencies[0]).toEqual(original.dependencies[0]);
  });

  it('round-trip through encode/load preserves dependencies (blob-authoritative path)', () => {
    const original = diagramWithDependency();
    const doc = buildYDocFromDiagram(original);
    const update = encodeYDoc(doc);
    const loadedDoc = loadYDocFromUpdate(update);
    const projected = projectYDocToDiagram(loadedDoc);

    expect(projected.dependencies).toHaveLength(1);
    expect(projected.dependencies[0]!.clientClassId).toBe('550e8400-e29b-41d4-a716-446655440001');
    expect(projected.dependencies[0]!.supplierClassId).toBe('550e8400-e29b-41d4-a716-446655440002');
  });

  it('backward compat: old Y.Doc without a dependencies map projects to an empty collection', () => {
    // Simulate a pre-unit-12b doc: no dependencies map at all.
    const doc = new Y.Doc();
    const yClasses = doc.getMap('classes');
    const yMeta = doc.getMap('meta');
    yMeta.set('id', '550e8400-e29b-41d4-a716-446655440000');
    yMeta.set('name', 'Old Diagram');
    const yClass1 = new Y.Map();
    yClass1.set('id', '550e8400-e29b-41d4-a716-446655440001');
    yClass1.set('name', 'Order');
    yClass1.set('position', new Y.Map([['x', 0], ['y', 0]]));
    yClass1.set('attributes', new Y.Array());
    yClass1.set('methods', new Y.Array());
    yClasses.set('550e8400-e29b-41d4-a716-446655440001', yClass1);

    const projected = projectYDocToDiagram(doc);
    expect(projected.dependencies).toEqual([]);
  });
});
describe('ydoc codec — NaryAssociation round-trip (unit 13.1/13.5)', () => {
  function diagramWithNary(): Diagram {
    return DiagramSchema.parse({
      id: '550e8400-e29b-41d4-a716-446655440000',
      name: 'Nary Test',
      classes: [
        { id: '550e8400-e29b-41d4-a716-446655440001', name: 'Supplier', position: { x: 0, y: 0 }, attributes: [], methods: [] },
        { id: '550e8400-e29b-41d4-a716-446655440002', name: 'Part', position: { x: 300, y: 0 }, attributes: [], methods: [] },
        { id: '550e8400-e29b-41d4-a716-446655440003', name: 'Project', position: { x: 150, y: 300 }, attributes: [], methods: [] },
      ],
      associations: [],
      naryAssociations: [
        {
          id: '550e8400-e29b-41d4-a716-446655440004',
          name: 'supply',
          memberEnds: [
            { classId: '550e8400-e29b-41d4-a716-446655440001', multiplicity: '1', role: 'supplier' },
            { classId: '550e8400-e29b-41d4-a716-446655440002', multiplicity: '0..*' },
            { classId: '550e8400-e29b-41d4-a716-446655440003', multiplicity: '1..*' },
          ],
        },
      ],
    });
  }

  it('buildYDocFromDiagram → projectYDocToDiagram preserves naryAssociations losslessly (memberEnds order, roles, name)', () => {
    const original = diagramWithNary();
    const doc = buildYDocFromDiagram(original);
    const projected = projectYDocToDiagram(doc);

    expect(projected.naryAssociations).toHaveLength(1);
    expect(projected.naryAssociations[0]).toEqual(original.naryAssociations[0]);
  });

  it('round-trip through encode/load preserves naryAssociations (blob-authoritative path)', () => {
    const original = diagramWithNary();
    const doc = buildYDocFromDiagram(original);
    const update = encodeYDoc(doc);
    const loadedDoc = loadYDocFromUpdate(update);
    const projected = projectYDocToDiagram(loadedDoc);

    expect(projected.naryAssociations).toHaveLength(1);
    const nary = projected.naryAssociations[0]!;
    expect(nary.name).toBe('supply');
    expect(nary.memberEnds.map((e) => e.classId)).toEqual([
      '550e8400-e29b-41d4-a716-446655440001',
      '550e8400-e29b-41d4-a716-446655440002',
      '550e8400-e29b-41d4-a716-446655440003',
    ]);
    expect(nary.memberEnds[0]).toMatchObject({ multiplicity: '1', role: 'supplier' });
    expect(nary.memberEnds[1]!.role).toBeUndefined();
  });

  it('backward compat: old Y.Doc without an naryAssociations map projects to an empty collection', () => {
    // Simulate a pre-unit-13 doc: no naryAssociations map at all.
    const doc = new Y.Doc();
    const yClasses = doc.getMap('classes');
    const yMeta = doc.getMap('meta');
    yMeta.set('id', '550e8400-e29b-41d4-a716-446655440000');
    yMeta.set('name', 'Old Diagram');
    const yClass1 = new Y.Map();
    yClass1.set('id', '550e8400-e29b-41d4-a716-446655440001');
    yClass1.set('name', 'Supplier');
    yClass1.set('position', new Y.Map([['x', 0], ['y', 0]]));
    yClass1.set('attributes', new Y.Array());
    yClass1.set('methods', new Y.Array());
    yClasses.set('550e8400-e29b-41d4-a716-446655440001', yClass1);

    const projected = projectYDocToDiagram(doc);
    expect(projected.naryAssociations).toEqual([]);
  });
});

describe('ydoc codec — Edge label (name) round-trip (unit 13c)', () => {
  function diagramWithLabeledEdges(): Diagram {
    return DiagramSchema.parse({
      id: '550e8400-e29b-41d4-a716-446655440000',
      name: 'Edge Labels',
      classes: [
        { id: '550e8400-e29b-41d4-a716-446655440001', name: 'Order', position: { x: 0, y: 0 }, attributes: [], methods: [] },
        { id: '550e8400-e29b-41d4-a716-446655440002', name: 'ItemType', position: { x: 300, y: 0 }, attributes: [], methods: [] },
        { id: '550e8400-e29b-41d4-a716-446655440003', name: 'Repository', position: { x: 600, y: 0 }, attributes: [], methods: [], kind: 'interface' },
      ],
      associations: [],
      generalizations: [
        { id: '550e8400-e29b-41d4-a716-446655440004', subClassId: '550e8400-e29b-41d4-a716-446655440001', superClassId: '550e8400-e29b-41d4-a716-446655440002', name: 'inherits' },
      ],
      realizations: [
        { id: '550e8400-e29b-41d4-a716-446655440005', clientClassId: '550e8400-e29b-41d4-a716-446655440001', supplierInterfaceId: '550e8400-e29b-41d4-a716-446655440003', name: 'implements' },
      ],
      dependencies: [
        { id: '550e8400-e29b-41d4-a716-446655440006', clientClassId: '550e8400-e29b-41d4-a716-446655440001', supplierClassId: '550e8400-e29b-41d4-a716-446655440002', name: 'uses' },
      ],
    });
  }

  it('buildYDocFromDiagram → projectYDocToDiagram preserves names on generalization/realization/dependency', () => {
    const original = diagramWithLabeledEdges();
    const doc = buildYDocFromDiagram(original);
    const projected = projectYDocToDiagram(doc);

    expect(projected.generalizations[0]!.name).toBe('inherits');
    expect(projected.realizations[0]!.name).toBe('implements');
    expect(projected.dependencies[0]!.name).toBe('uses');
  });

  it('round-trip through encode/load preserves edge names (blob-authoritative path)', () => {
    const original = diagramWithLabeledEdges();
    const doc = buildYDocFromDiagram(original);
    const update = encodeYDoc(doc);
    const loadedDoc = loadYDocFromUpdate(update);
    const projected = projectYDocToDiagram(loadedDoc);

    expect(projected.generalizations[0]!.name).toBe('inherits');
    expect(projected.realizations[0]!.name).toBe('implements');
    expect(projected.dependencies[0]!.name).toBe('uses');
  });

  it('backward compat: edges without a name key project name undefined (no phantom field)', () => {
    const original = DiagramSchema.parse({
      id: '550e8400-e29b-41d4-a716-446655440000',
      name: 'No Labels',
      classes: [
        { id: '550e8400-e29b-41d4-a716-446655440001', name: 'Order', position: { x: 0, y: 0 }, attributes: [], methods: [] },
        { id: '550e8400-e29b-41d4-a716-446655440002', name: 'ItemType', position: { x: 300, y: 0 }, attributes: [], methods: [] },
      ],
      associations: [],
      generalizations: [{ id: '550e8400-e29b-41d4-a716-446655440003', subClassId: '550e8400-e29b-41d4-a716-446655440001', superClassId: '550e8400-e29b-41d4-a716-446655440002' }],
      dependencies: [{ id: '550e8400-e29b-41d4-a716-446655440004', clientClassId: '550e8400-e29b-41d4-a716-446655440001', supplierClassId: '550e8400-e29b-41d4-a716-446655440002' }],
    });

    const doc = buildYDocFromDiagram(original);
    const projected = projectYDocToDiagram(doc);

    expect(projected.generalizations[0]!.name).toBeUndefined();
    expect(projected.dependencies[0]!.name).toBeUndefined();
    // The projected object must deep-equal the original entry (no undefined-key drift).
    expect(projected.generalizations[0]).toEqual(original.generalizations[0]);
  });
});

describe('ydoc codec — optional association multiplicities (unit 13d fix C)', () => {
  function diagramWithUnspecifiedAssoc(): Diagram {
    return DiagramSchema.parse({
      id: '550e8400-e29b-41d4-a716-446655440000',
      name: 'Empty Mults',
      classes: [
        { id: '550e8400-e29b-41d4-a716-446655440001', name: 'Order', position: { x: 0, y: 0 }, attributes: [], methods: [] },
        { id: '550e8400-e29b-41d4-a716-446655440002', name: 'Item', position: { x: 300, y: 0 }, attributes: [], methods: [] },
      ],
      associations: [
        { id: '550e8400-e29b-41d4-a716-446655440003', sourceClassId: '550e8400-e29b-41d4-a716-446655440001', targetClassId: '550e8400-e29b-41d4-a716-446655440002', directed: false, aggregation: 'composite' },
      ],
    });
  }

  it('buildYDocFromDiagram → projectYDocToDiagram keeps omitted multiplicities UNDEFINED (unspecified ≠ "1")', () => {
    const original = diagramWithUnspecifiedAssoc();
    const doc = buildYDocFromDiagram(original);
    const projected = projectYDocToDiagram(doc);

    const assoc = projected.associations[0]!;
    expect(assoc.sourceMultiplicity).toBeUndefined();
    expect(assoc.targetMultiplicity).toBeUndefined();
    expect(assoc.aggregation).toBe('composite');
    // No phantom '1' anywhere in the stored Y.Map.
    const yAssoc = doc.getMap('associations').get('550e8400-e29b-41d4-a716-446655440003') as Y.Map<unknown>;
    expect(yAssoc.has('sourceMultiplicity')).toBe(false);
    expect(yAssoc.has('targetMultiplicity')).toBe(false);
  });

  it('round-trip through encode/load preserves unspecified multiplicities (blob path)', () => {
    const original = diagramWithUnspecifiedAssoc();
    const doc = buildYDocFromDiagram(original);
    const loadedDoc = loadYDocFromUpdate(encodeYDoc(doc));
    const projected = projectYDocToDiagram(loadedDoc);

    expect(projected.associations[0]!.sourceMultiplicity).toBeUndefined();
    expect(projected.associations[0]!.targetMultiplicity).toBeUndefined();
  });

  it('backward compat: associations WITH multiplicities still round-trip exactly', () => {
    const original = DiagramSchema.parse({
      id: '550e8400-e29b-41d4-a716-446655440000',
      name: 'Full Mults',
      classes: [
        { id: '550e8400-e29b-41d4-a716-446655440001', name: 'Order', position: { x: 0, y: 0 }, attributes: [], methods: [] },
        { id: '550e8400-e29b-41d4-a716-446655440002', name: 'Item', position: { x: 300, y: 0 }, attributes: [], methods: [] },
      ],
      associations: [
        { id: '550e8400-e29b-41d4-a716-446655440003', sourceClassId: '550e8400-e29b-41d4-a716-446655440001', targetClassId: '550e8400-e29b-41d4-a716-446655440002', sourceMultiplicity: '1', targetMultiplicity: '0..*', directed: false },
      ],
    });
    const doc = buildYDocFromDiagram(original);
    const projected = projectYDocToDiagram(doc);

    expect(projected.associations[0]!.sourceMultiplicity).toBe('1');
    expect(projected.associations[0]!.targetMultiplicity).toBe('0..*');
  });
});

describe('ydoc codec — n-ary update round-trip (unit 13d fix A)', () => {
  it('an applied n-ary update (name + end multiplicities) survives build → project', () => {
    const original = DiagramSchema.parse({
      id: '550e8400-e29b-41d4-a716-446655440000',
      name: 'NaryUpdate',
      classes: [
        { id: '550e8400-e29b-41d4-a716-446655440001', name: 'Supplier', position: { x: 0, y: 0 }, attributes: [], methods: [] },
        { id: '550e8400-e29b-41d4-a716-446655440002', name: 'Part', position: { x: 300, y: 0 }, attributes: [], methods: [] },
        { id: '550e8400-e29b-41d4-a716-446655440003', name: 'Project', position: { x: 150, y: 300 }, attributes: [], methods: [] },
      ],
      associations: [],
      naryAssociations: [
        {
          id: '550e8400-e29b-41d4-a716-446655440004',
          name: 'supply',
          memberEnds: [
            { classId: '550e8400-e29b-41d4-a716-446655440001', multiplicity: '1', role: 'supplier' },
            { classId: '550e8400-e29b-41d4-a716-446655440002', multiplicity: '0..*' },
            { classId: '550e8400-e29b-41d4-a716-446655440003', multiplicity: '1' },
          ],
        },
      ],
    });

    const updated = applyDelta(original, {
      id: '550e8400-e29b-41d4-a716-446655440099',
      diagramId: original.id,
      timestamp: new Date().toISOString(),
      kind: 'naryAssociation' as const,
      op: 'update' as const,
      naryAssociationId: '550e8400-e29b-41d4-a716-446655440004',
      name: 'delivers',
      memberEnds: [
        { classId: '550e8400-e29b-41d4-a716-446655440001', multiplicity: '*', role: 'supplier' },
        { classId: '550e8400-e29b-41d4-a716-446655440002', multiplicity: '0..1' },
        { classId: '550e8400-e29b-41d4-a716-446655440003', multiplicity: '1' },
      ],
    });
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;

    const doc = buildYDocFromDiagram(updated.value);
    const projected = projectYDocToDiagram(doc);
    const nary = projected.naryAssociations[0]!;
    expect(nary.name).toBe('delivers');
    expect(nary.memberEnds[0]).toMatchObject({ multiplicity: '*', role: 'supplier' });
    expect(nary.memberEnds[1]!.multiplicity).toBe('0..1');
    expect(nary.memberEnds[2]!.multiplicity).toBe('1');
  });
});
