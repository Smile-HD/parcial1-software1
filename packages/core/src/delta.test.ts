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

  it('includes all six delta kinds in the generated schema', () => {
    const schema = deltaJsonSchema as Record<string, unknown>;
    // The discriminated union should produce a oneOf/anyOf with all variants
    const variants = (schema.oneOf ?? schema.anyOf) as Array<Record<string, unknown>>;
    expect(Array.isArray(variants)).toBe(true);
    const kinds = variants.map(v => v.properties?.kind?.const).filter(Boolean);
    // Unit 12.2 adds `realization` — expected union growth (12a half; dependency lands in 12b).
    expect(kinds.sort()).toEqual(['association', 'batch', 'class', 'generalization', 'member', 'realization']);
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

describe('Delta Schema — Association aggregationEnd (UML 2.5.1 explicit end ownership)', () => {
  it('association create delta accepts optional aggregationEnd', () => {
    const delta = {
      id: crypto.randomUUID(),
      diagramId: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      kind: 'association' as const,
      op: 'create' as const,
      associationId: crypto.randomUUID(),
      sourceClassId: crypto.randomUUID(),
      targetClassId: crypto.randomUUID(),
      sourceMultiplicity: '1',
      targetMultiplicity: '0..*',
      directed: true,
      aggregation: 'composite' as const,
      aggregationEnd: 'target' as const,
    };
    const result = DeltaSchema.safeParse(delta);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.aggregationEnd).toBe('target');
    }
  });

  it('association create delta has aggregationEnd undefined when absent (IR schema applies default)', () => {
    const delta = {
      id: crypto.randomUUID(),
      diagramId: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      kind: 'association' as const,
      op: 'create' as const,
      associationId: crypto.randomUUID(),
      sourceClassId: crypto.randomUUID(),
      targetClassId: crypto.randomUUID(),
      sourceMultiplicity: '1',
      targetMultiplicity: '0..*',
      directed: true,
      aggregation: 'composite' as const,
    };
    const result = DeltaSchema.safeParse(delta);
    expect(result.success).toBe(true);
    if (result.success) {
      // Delta schema doesn't default - IR schema applies default 'source' when parsing
      expect(result.data.aggregationEnd).toBeUndefined();
    }
  });

  it('association updateMultiplicity delta accepts optional aggregationEnd', () => {
    const delta = {
      id: crypto.randomUUID(),
      diagramId: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      kind: 'association' as const,
      op: 'updateMultiplicity' as const,
      associationId: crypto.randomUUID(),
      aggregation: 'shared' as const,
      aggregationEnd: 'target' as const,
    };
    const result = DeltaSchema.safeParse(delta);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.aggregationEnd).toBe('target');
    }
  });

  it('REJECTS invalid aggregationEnd value in association delta', () => {
    const delta = {
      id: crypto.randomUUID(),
      diagramId: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      kind: 'association' as const,
      op: 'create' as const,
      associationId: crypto.randomUUID(),
      sourceClassId: crypto.randomUUID(),
      targetClassId: crypto.randomUUID(),
      sourceMultiplicity: '1',
      targetMultiplicity: '0..*',
      directed: true,
      aggregation: 'composite' as const,
      aggregationEnd: 'invalid',
    };
    const result = DeltaSchema.safeParse(delta);
    expect(result.success).toBe(false);
  });
});

describe('Delta Schema — Generalization kind (unit 11.1)', () => {
  it('validates a generalization create delta through the union', () => {
    const delta = {
      id: crypto.randomUUID(),
      diagramId: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      kind: 'generalization' as const,
      op: 'create' as const,
      generalizationId: crypto.randomUUID(),
      subClassId: crypto.randomUUID(),
      superClassId: crypto.randomUUID(),
    };
    const result = DeltaSchema.safeParse(delta);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.kind).toBe('generalization');
      expect(result.data.op).toBe('create');
    }
  });

  it('validates a generalization delete delta through the union', () => {
    const delta = {
      id: crypto.randomUUID(),
      diagramId: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      kind: 'generalization' as const,
      op: 'delete' as const,
      generalizationId: crypto.randomUUID(),
    };
    const result = DeltaSchema.safeParse(delta);
    expect(result.success).toBe(true);
  });

  it('REJECTS unknown ops for generalization deltas (only create|delete)', () => {
    const delta = {
      id: crypto.randomUUID(),
      diagramId: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      kind: 'generalization' as const,
      op: 'update',
      generalizationId: crypto.randomUUID(),
    };
    expect(DeltaSchema.safeParse(delta).success).toBe(false);
  });

  it('REJECTS a generalization create missing an end', () => {
    const delta = {
      id: crypto.randomUUID(),
      diagramId: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      kind: 'generalization' as const,
      op: 'create' as const,
      generalizationId: crypto.randomUUID(),
      subClassId: crypto.randomUUID(),
    };
    expect(DeltaSchema.safeParse(delta).success).toBe(false);
  });

  it('batch delta accepts generalization inner deltas', () => {
    const base = {
      id: crypto.randomUUID(),
      diagramId: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
    };
    const batch = {
      ...base,
      kind: 'batch' as const,
      deltas: [
        { ...base, kind: 'generalization' as const, op: 'create' as const, generalizationId: crypto.randomUUID(), subClassId: crypto.randomUUID(), superClassId: crypto.randomUUID() },
        { ...base, kind: 'generalization' as const, op: 'delete' as const, generalizationId: crypto.randomUUID() },
      ],
    };
    const result = DeltaSchema.safeParse(batch);
    expect(result.success).toBe(true);
  });
});

describe('Delta Schema — Realization kind (unit 12.2)', () => {
  it('validates a realization create delta through the union', () => {
    const delta = {
      id: crypto.randomUUID(),
      diagramId: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      kind: 'realization' as const,
      op: 'create' as const,
      realizationId: crypto.randomUUID(),
      clientClassId: crypto.randomUUID(),
      supplierInterfaceId: crypto.randomUUID(),
    };
    const result = DeltaSchema.safeParse(delta);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.kind).toBe('realization');
      expect(result.data.op).toBe('create');
    }
  });

  it('validates a realization delete delta through the union', () => {
    const delta = {
      id: crypto.randomUUID(),
      diagramId: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      kind: 'realization' as const,
      op: 'delete' as const,
      realizationId: crypto.randomUUID(),
    };
    expect(DeltaSchema.safeParse(delta).success).toBe(true);
  });

  it('REJECTS unknown ops for realization deltas (only create|delete)', () => {
    const delta = {
      id: crypto.randomUUID(),
      diagramId: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      kind: 'realization' as const,
      op: 'update',
      realizationId: crypto.randomUUID(),
    };
    expect(DeltaSchema.safeParse(delta).success).toBe(false);
  });

  it('REJECTS a realization create missing an end (schema gate, like generalization)', () => {
    const missingSupplier = {
      id: crypto.randomUUID(),
      diagramId: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      kind: 'realization' as const,
      op: 'create' as const,
      realizationId: crypto.randomUUID(),
      clientClassId: crypto.randomUUID(),
    };
    expect(DeltaSchema.safeParse(missingSupplier).success).toBe(false);

    const missingClient = {
      id: crypto.randomUUID(),
      diagramId: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      kind: 'realization' as const,
      op: 'create' as const,
      realizationId: crypto.randomUUID(),
      supplierInterfaceId: crypto.randomUUID(),
    };
    expect(DeltaSchema.safeParse(missingClient).success).toBe(false);
  });

  it('batch delta accepts realization inner deltas', () => {
    const base = {
      id: crypto.randomUUID(),
      diagramId: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
    };
    const batch = {
      ...base,
      kind: 'batch' as const,
      deltas: [
        { ...base, kind: 'realization' as const, op: 'create' as const, realizationId: crypto.randomUUID(), clientClassId: crypto.randomUUID(), supplierInterfaceId: crypto.randomUUID() },
        { ...base, kind: 'realization' as const, op: 'delete' as const, realizationId: crypto.randomUUID() },
      ],
    };
    expect(DeltaSchema.safeParse(batch).success).toBe(true);
  });
});

describe('Delta Schema — Class kind/isAbstract carriers (unit 12.1/12.4)', () => {
  it('class create delta accepts an optional classKind "interface"', () => {
    const delta = {
      id: crypto.randomUUID(),
      diagramId: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      kind: 'class' as const,
      op: 'create' as const,
      classId: crypto.randomUUID(),
      name: 'Repository',
      position: { x: 0, y: 0 },
      classKind: 'interface' as const,
    };
    const result = DeltaSchema.safeParse(delta);
    expect(result.success).toBe(true);
  });

  it('class create delta REJECTS an invalid classKind', () => {
    const delta = {
      id: crypto.randomUUID(),
      diagramId: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      kind: 'class' as const,
      op: 'create' as const,
      classId: crypto.randomUUID(),
      name: 'X',
      position: { x: 0, y: 0 },
      classKind: 'enum',
    };
    expect(DeltaSchema.safeParse(delta).success).toBe(false);
  });

  it('class update delta carries isAbstract and/or classKind', () => {
    const base = {
      id: crypto.randomUUID(),
      diagramId: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      kind: 'class' as const,
      op: 'update' as const,
      classId: crypto.randomUUID(),
    };
    expect(DeltaSchema.safeParse({ ...base, isAbstract: true }).success).toBe(true);
    expect(DeltaSchema.safeParse({ ...base, classKind: 'interface' }).success).toBe(true);
    expect(DeltaSchema.safeParse({ ...base, isAbstract: false, classKind: 'class' }).success).toBe(true);
  });

  it('class update delta with NO fields to change is REJECTED (schema gate)', () => {
    const delta = {
      id: crypto.randomUUID(),
      diagramId: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      kind: 'class' as const,
      op: 'update' as const,
      classId: crypto.randomUUID(),
    };
    expect(DeltaSchema.safeParse(delta).success).toBe(false);
  });
});