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
