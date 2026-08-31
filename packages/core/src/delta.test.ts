import { describe, expect, it } from 'vitest';
import { DeltaSchema, deltaJsonSchema } from './delta.js';

describe('Delta Schema — JSON Schema Generation (design D3)', () => {
  it('generates valid JSON Schema from the Delta discriminated union via z.toJSONSchema', () => {
    // This proves z.toJSONSchema succeeds on the union (task 2.3)
    expect(deltaJsonSchema).toBeDefined();
    expect(typeof deltaJsonSchema).toBe('object');
    // Discriminated union produces oneOf at root level
    expect(deltaJsonSchema).toHaveProperty('oneOf');
    expect(Array.isArray((deltaJsonSchema as Record<string, unknown>).oneOf)).toBe(true);
  });

  it('includes all four delta kinds in the generated schema', () => {
    const schema = deltaJsonSchema as Record<string, unknown>;
    // The discriminated union should produce a oneOf/anyOf with all variants
    const variants = (schema.oneOf ?? schema.anyOf) as Array<Record<string, unknown>>;
    expect(Array.isArray(variants)).toBe(true);
    const kinds = variants.map(v => v.properties?.kind?.const).filter(Boolean);
    expect(kinds.sort()).toEqual(['association', 'batch', 'class', 'member']);
  });

  it('validates a valid class delta through the union', () => {
    const validClassDelta = {
      id: '0192f0c1-2345-7123-8abc-def012345678',
      diagramId: '0192f0c1-2345-7123-8abc-def012345679',
      timestamp: '2025-01-15T10:30:00.000Z',
      kind: 'class' as const,
      op: 'create' as const,
      classId: '0192f0c1-2345-7123-8abc-def01234567a',
      name: 'Customer',
      position: { x: 100, y: 200 },
    };
    const result = DeltaSchema.safeParse(validClassDelta);
    expect(result.success).toBe(true);
  });

  it('validates a valid member delta through the union', () => {
    const validMemberDelta = {
      id: '0192f0c1-2345-7123-8abc-def012345678',
      diagramId: '0192f0c1-2345-7123-8abc-def012345679',
      timestamp: '2025-01-15T10:30:00.000Z',
      kind: 'member' as const,
      op: 'addAttribute' as const,
      classId: '0192f0c1-2345-7123-8abc-def01234567a',
      memberId: '0192f0c1-2345-7123-8abc-def01234567b',
      name: 'email',
      type: 'String',
    };
    const result = DeltaSchema.safeParse(validMemberDelta);
    expect(result.success).toBe(true);
  });

  it('validates a valid association delta through the union', () => {
    const validAssociationDelta = {
      id: '0192f0c1-2345-7123-8abc-def012345678',
      diagramId: '0192f0c1-2345-7123-8abc-def012345679',
      timestamp: '2025-01-15T10:30:00.000Z',
      kind: 'association' as const,
      op: 'create' as const,
      associationId: '0192f0c1-2345-7123-8abc-def01234567c',
      sourceClassId: '0192f0c1-2345-7123-8abc-def01234567a',
      targetClassId: '0192f0c1-2345-7123-8abc-def01234567b',
      sourceMultiplicity: '1' as const,
      targetMultiplicity: '0..*' as const,
      directed: true,
    };
    const result = DeltaSchema.safeParse(validAssociationDelta);
    expect(result.success).toBe(true);
  });

  it('validates a valid batch delta through the union', () => {
    const validBatchDelta = {
      id: '0192f0c1-2345-7123-8abc-def012345678',
      diagramId: '0192f0c1-2345-7123-8abc-def012345679',
      timestamp: '2025-01-15T10:30:00.000Z',
      kind: 'batch' as const,
      deltas: [
        {
          id: '0192f0c1-2345-7123-8abc-def01234567a',
          diagramId: '0192f0c1-2345-7123-8abc-def012345679',
          timestamp: '2025-01-15T10:30:00.000Z',
          kind: 'class' as const,
          op: 'create' as const,
          classId: '0192f0c1-2345-7123-8abc-def01234567b',
          name: 'Order',
          position: { x: 300, y: 200 },
        },
      ],
    };
    const result = DeltaSchema.safeParse(validBatchDelta);
    expect(result.success).toBe(true);
  });

  it('accepts ranged multiplicity in association delta (editor:R4)', () => {
    const rangedAssociationDelta = {
      id: '0192f0c1-2345-7123-8abc-def012345678',
      diagramId: '0192f0c1-2345-7123-8abc-def012345679',
      timestamp: '2025-01-15T10:30:00.000Z',
      kind: 'association' as const,
      op: 'create' as const,
      associationId: '0192f0c1-2345-7123-8abc-def01234567c',
      sourceClassId: '0192f0c1-2345-7123-8abc-def01234567a',
      targetClassId: '0192f0c1-2345-7123-8abc-def01234567b',
      sourceMultiplicity: '3..7', // valid since editor:R4
      targetMultiplicity: '0..*',
      directed: true,
    };
    const result = DeltaSchema.safeParse(rangedAssociationDelta);
    expect(result.success).toBe(true);
  });

  it('rejects non-numeric garbage multiplicity in association delta', () => {
    const invalidAssociationDelta = {
      id: '0192f0c1-2345-7123-8abc-def012345678',
      diagramId: '0192f0c1-2345-7123-8abc-def012345679',
      timestamp: '2025-01-15T10:30:00.000Z',
      kind: 'association' as const,
      op: 'create' as const,
      associationId: '0192f0c1-2345-7123-8abc-def01234567c',
      sourceClassId: '0192f0c1-2345-7123-8abc-def01234567a',
      targetClassId: '0192f0c1-2345-7123-8abc-def01234567b',
      sourceMultiplicity: 'abc', // non-numeric garbage is still invalid
      targetMultiplicity: '0..*',
      directed: true,
    };
    const result = DeltaSchema.safeParse(invalidAssociationDelta);
    expect(result.success).toBe(false);
  });
});