import { describe, expect, it } from 'vitest';
import { AssociationSchema, AttributeSchema, MethodSchema, MultiplicitySchema } from './ir.js';

describe('IR Schema — Multiplicity Validation (editor:R4)', () => {
  it('accepts valid multiplicities: 1, 0..1, 1..*, 0..*', () => {
    const valid = ['1', '0..1', '1..*', '0..*'] as const;
    for (const m of valid) {
      const result = AssociationSchema.shape.sourceMultiplicity.safeParse(m);
      expect(result.success).toBe(true);
      expect(MultiplicitySchema.safeParse(m).success).toBe(true);
    }
  });

  it('accepts UML 2.5.1 arbitrary multiplicities: star, zero, integers, ranges (R4 MODIFIED 2026-08-31)', () => {
    const valid = ['*', '0', '2', '3..7', '1..3', '5', '0..2', '1..*', '2..*', 'm..n'.length > 0 ? '10..20' : '10..20'] as const;
    for (const m of valid) {
      const result = MultiplicitySchema.safeParse(m);
      expect(result.success).toBe(true);
    }
  });

  it('REJECTS non-numeric garbage multiplicities (abc, 1..abc, 1.., ..2, empty)', () => {
    const invalid = ['abc', '1..abc', '1..', '..2', '', 'a..b', '3..7x', '-1', '1..-2'] as const;
    for (const m of invalid) {
      const result = MultiplicitySchema.safeParse(m);
      expect(result.success).toBe(false);
    }
  });
});

describe('IR Schema — Member adornments (unit 9.1, UML 2.5.1 compliance)', () => {
  it('attributes default to public, non-static, non-derived, no multiplicity (backward compat: fields absent)', () => {
    const parsed = AttributeSchema.parse({ id: crypto.randomUUID(), name: 'price', type: 'number' });
    expect(parsed.visibility).toBe('+');
    expect(parsed.isStatic).toBe(false);
    expect(parsed.isDerived).toBe(false);
    expect(parsed.multiplicity).toBeUndefined();
  });

  it('attributes accept explicit visibility (+,-,#,~), static, derived and multiplicity', () => {
    const parsed = AttributeSchema.parse({
      id: crypto.randomUUID(),
      name: 'total',
      type: 'number',
      visibility: '-',
      isStatic: true,
      isDerived: true,
      multiplicity: '0..*',
    });
    expect(parsed.visibility).toBe('-');
    expect(parsed.isStatic).toBe(true);
    expect(parsed.isDerived).toBe(true);
    expect(parsed.multiplicity).toBe('0..*');
  });

  it('methods default to public, non-static; accept visibility and static', () => {
    const parsed = MethodSchema.parse({ id: crypto.randomUUID(), name: 'count', returnType: 'int', parameters: [] });
    expect(parsed.visibility).toBe('+');
    expect(parsed.isStatic).toBe(false);

    const privateStatic = MethodSchema.parse({
      id: crypto.randomUUID(),
      name: 'helper',
      returnType: 'void',
      parameters: [],
      visibility: '#',
      isStatic: true,
    });
    expect(privateStatic.visibility).toBe('#');
    expect(privateStatic.isStatic).toBe(true);
  });

  it('rejects invalid visibility values', () => {
    expect(AttributeSchema.safeParse({ id: crypto.randomUUID(), name: 'x', type: 'int', visibility: 'private' }).success).toBe(false);
    expect(MethodSchema.safeParse({ id: crypto.randomUUID(), name: 'm', returnType: 'void', parameters: [], visibility: '*' }).success).toBe(false);
  });

  it('rejects invalid attribute multiplicity garbage but accepts UML forms', () => {
    expect(AttributeSchema.safeParse({ id: crypto.randomUUID(), name: 'x', type: 'int', multiplicity: 'garbage!!' }).success).toBe(false);
    expect(AttributeSchema.safeParse({ id: crypto.randomUUID(), name: 'x', type: 'int', multiplicity: '*' }).success).toBe(true);
  });
});

describe('IR Schema — Association aggregation, name, roles (unit 10.1, 10.2)', () => {
  it('defaults aggregation to "none" when absent (backward compat)', () => {
    const parsed = AssociationSchema.parse({
      id: crypto.randomUUID(),
      sourceClassId: crypto.randomUUID(),
      targetClassId: crypto.randomUUID(),
      sourceMultiplicity: '1',
      targetMultiplicity: '0..*',
      directed: true,
    });
    expect(parsed.aggregation).toBe('none');
  });

  it('accepts aggregation enum: none, shared, composite', () => {
    for (const agg of ['none', 'shared', 'composite'] as const) {
      const parsed = AssociationSchema.parse({
        id: crypto.randomUUID(),
        sourceClassId: crypto.randomUUID(),
        targetClassId: crypto.randomUUID(),
        sourceMultiplicity: '1',
        targetMultiplicity: '0..*',
        directed: true,
        aggregation: agg,
      });
      expect(parsed.aggregation).toBe(agg);
    }
  });

  it('REJECTS invalid aggregation value', () => {
    const result = AssociationSchema.safeParse({
      id: crypto.randomUUID(),
      sourceClassId: crypto.randomUUID(),
      targetClassId: crypto.randomUUID(),
      sourceMultiplicity: '1',
      targetMultiplicity: '0..*',
      directed: true,
      aggregation: 'invalid',
    });
    expect(result.success).toBe(false);
  });

  it('accepts optional association name', () => {
    const parsed = AssociationSchema.parse({
      id: crypto.randomUUID(),
      sourceClassId: crypto.randomUUID(),
      targetClassId: crypto.randomUUID(),
      sourceMultiplicity: '1',
      targetMultiplicity: '0..*',
      directed: true,
      name: 'places',
    });
    expect(parsed.name).toBe('places');
  });

  it('accepts optional sourceRole and targetRole', () => {
    const parsed = AssociationSchema.parse({
      id: crypto.randomUUID(),
      sourceClassId: crypto.randomUUID(),
      targetClassId: crypto.randomUUID(),
      sourceMultiplicity: '1',
      targetMultiplicity: '0..*',
      directed: true,
      sourceRole: 'buyer',
      targetRole: 'order',
    });
    expect(parsed.sourceRole).toBe('buyer');
    expect(parsed.targetRole).toBe('order');
  });

  it('name, sourceRole, targetRole default to undefined when absent (backward compat)', () => {
    const parsed = AssociationSchema.parse({
      id: crypto.randomUUID(),
      sourceClassId: crypto.randomUUID(),
      targetClassId: crypto.randomUUID(),
      sourceMultiplicity: '1',
      targetMultiplicity: '0..*',
      directed: true,
    });
    expect(parsed.name).toBeUndefined();
    expect(parsed.sourceRole).toBeUndefined();
    expect(parsed.targetRole).toBeUndefined();
  });
});

describe('IR Schema — Association aggregationEnd (UML 2.5.1 explicit end ownership)', () => {
  it('defaults aggregationEnd to "source" when absent (backward compat)', () => {
    const parsed = AssociationSchema.parse({
      id: crypto.randomUUID(),
      sourceClassId: crypto.randomUUID(),
      targetClassId: crypto.randomUUID(),
      sourceMultiplicity: '1',
      targetMultiplicity: '0..*',
      directed: true,
      aggregation: 'composite',
    });
    expect(parsed.aggregationEnd).toBe('source');
  });

  it('accepts explicit aggregationEnd "target"', () => {
    const parsed = AssociationSchema.parse({
      id: crypto.randomUUID(),
      sourceClassId: crypto.randomUUID(),
      targetClassId: crypto.randomUUID(),
      sourceMultiplicity: '1',
      targetMultiplicity: '0..*',
      directed: true,
      aggregation: 'composite',
      aggregationEnd: 'target',
    });
    expect(parsed.aggregationEnd).toBe('target');
  });

  it('REJECTS invalid aggregationEnd value', () => {
    const result = AssociationSchema.safeParse({
      id: crypto.randomUUID(),
      sourceClassId: crypto.randomUUID(),
      targetClassId: crypto.randomUUID(),
      sourceMultiplicity: '1',
      targetMultiplicity: '0..*',
      directed: true,
      aggregation: 'composite',
      aggregationEnd: 'invalid',
    });
    expect(result.success).toBe(false);
  });

  it('aggregationEnd is present even when aggregation is "none" (field always exists)', () => {
    const parsed = AssociationSchema.parse({
      id: crypto.randomUUID(),
      sourceClassId: crypto.randomUUID(),
      targetClassId: crypto.randomUUID(),
      sourceMultiplicity: '1',
      targetMultiplicity: '0..*',
      directed: true,
      aggregation: 'none',
    });
    expect(parsed.aggregationEnd).toBe('source');
  });
});
