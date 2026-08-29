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