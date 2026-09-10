import { describe, it, expect } from 'vitest';
import { parseXmiDocument, xmiToDeltaBatch } from '../src/xmi21.js';
import { readFileSync } from 'fs';
import { join } from 'path';

const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures', name), 'utf-8');

describe('XMI 2.1 Parser', () => {
  it('rejects unsupported XMI version (15.1)', () => {
    const xml = fixture('bad-version.xmi');
    expect(() => parseXmiDocument(xml)).toThrow('Unsupported XMI version');
  });

  it('handles malformed XML (15.2)', () => {
    const xml = fixture('malformed.xmi');
    expect(() => parseXmiDocument(xml)).toThrow('XMI parse error');
  });

  it('parses real EA sample (15.3, 15.4, 15.7)', () => {
    const xml = fixture('ea-sample.xmi');
    const model = parseXmiDocument(xml);
    expect(model.classes).toHaveLength(2);
    expect(model.classes[0].name).toBe('Order');
    expect(model.classes[0].attributes).toHaveLength(2);
    expect(model.classes[0].methods).toHaveLength(1);
    expect(model.associations).toHaveLength(1);
    expect(model.associations[0].aggregation).toBe('composite');
    expect(model.generalizations).toHaveLength(1);
    expect(model.realizations).toHaveLength(1);
    expect(model.dependencies).toHaveLength(1);
    expect(model.naryAssociations).toHaveLength(1);
    expect(model.naryAssociations[0].memberEnds).toHaveLength(3);
  });

  it('ignores EA proprietary blocks without failure (15.4)', () => {
    const xml = fixture('ea-sample.xmi');
    const model = parseXmiDocument(xml);
    // Should not throw and should produce valid model
    expect(model.classes.length).toBeGreaterThan(0);
  });
});

describe('xmiToDeltaBatch', () => {
  it('converts model to batch delta (15.3)', () => {
    const xml = fixture('ea-sample.xmi');
    const model = parseXmiDocument(xml);
    const batch = xmiToDeltaBatch(model, 'diag-123');
    expect(batch.kind).toBe('batch');
    expect(batch.diagramId).toBe('diag-123');
    expect(batch.deltas.length).toBeGreaterThan(5);
    const classDeltas = batch.deltas.filter(d => d.kind === 'class');
    expect(classDeltas.length).toBe(2);
    const attrDeltas = batch.deltas.filter(d => d.kind === 'member' && d.memberType === 'attribute');
    expect(attrDeltas.length).toBe(3);
    const methodDeltas = batch.deltas.filter(d => d.kind === 'member' && d.memberType === 'method');
    expect(methodDeltas.length).toBe(1);
    const assocDeltas = batch.deltas.filter(d => d.kind === 'association');
    expect(assocDeltas.length).toBe(1);
    const genDeltas = batch.deltas.filter(d => d.kind === 'generalization');
    expect(genDeltas.length).toBe(1);
    const realDeltas = batch.deltas.filter(d => d.kind === 'realization');
    expect(realDeltas.length).toBe(1);
    const depDeltas = batch.deltas.filter(d => d.kind === 'dependency');
    expect(depDeltas.length).toBe(1);
    const naryDeltas = batch.deltas.filter(d => d.kind === 'naryAssociation');
    expect(naryDeltas.length).toBe(1);
  });
});