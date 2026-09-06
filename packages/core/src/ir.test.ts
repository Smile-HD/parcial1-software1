import { describe, expect, it } from 'vitest';
import { AssociationSchema, AttributeSchema, ClassSchema, DiagramSchema, GeneralizationSchema, MethodSchema, MultiplicitySchema, NaryAssociationSchema, NaryMemberEndSchema, RealizationSchema } from './ir.js';

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

describe('IR Schema — Generalization collection (unit 11.1)', () => {
  it('GeneralizationSchema accepts { id, subClassId, superClassId }', () => {
    const parsed = GeneralizationSchema.parse({
      id: crypto.randomUUID(),
      subClassId: crypto.randomUUID(),
      superClassId: crypto.randomUUID(),
    });
    expect(parsed.id).toBeDefined();
    expect(parsed.subClassId).toBeDefined();
    expect(parsed.superClassId).toBeDefined();
  });

  it('GeneralizationSchema rejects non-uuid ids and missing ends', () => {
    expect(GeneralizationSchema.safeParse({ id: 'nope', subClassId: crypto.randomUUID(), superClassId: crypto.randomUUID() }).success).toBe(false);
    expect(GeneralizationSchema.safeParse({ id: crypto.randomUUID(), subClassId: crypto.randomUUID() }).success).toBe(false);
    expect(GeneralizationSchema.safeParse({ id: crypto.randomUUID(), superClassId: crypto.randomUUID() }).success).toBe(false);
  });

  it('DiagramSchema accepts a generalizations collection', () => {
    const subId = crypto.randomUUID();
    const superId = crypto.randomUUID();
    const genId = crypto.randomUUID();
    const parsed = DiagramSchema.parse({
      id: crypto.randomUUID(),
      name: 'Inheritance',
      classes: [
        { id: subId, name: 'Product', position: { x: 0, y: 0 }, attributes: [], methods: [] },
        { id: superId, name: 'Item', position: { x: 100, y: 0 }, attributes: [], methods: [] },
      ],
      associations: [],
      generalizations: [{ id: genId, subClassId: subId, superClassId: superId }],
    });
    expect(parsed.generalizations).toHaveLength(1);
    expect(parsed.generalizations[0]).toMatchObject({ id: genId, subClassId: subId, superClassId: superId });
  });

  it('backward compat: diagrams WITHOUT generalizations still validate and default to []', () => {
    const parsed = DiagramSchema.parse({
      id: crypto.randomUUID(),
      name: 'Legacy',
      classes: [],
      associations: [],
    });
    expect(parsed.generalizations).toEqual([]);
  });
});

describe('IR Schema — Class kind + isAbstract (unit 12.1, editor:R Interfaces)', () => {
  it('classes default to kind "class" and isAbstract false when fields absent (backward compat)', () => {
    const parsed = ClassSchema.parse({
      id: crypto.randomUUID(),
      name: 'Order',
      position: { x: 0, y: 0 },
      attributes: [],
      methods: [],
    });
    expect(parsed.kind).toBe('class');
    expect(parsed.isAbstract).toBe(false);
  });

  it('accepts kind "interface" and explicit isAbstract true', () => {
    const iface = ClassSchema.parse({
      id: crypto.randomUUID(),
      name: 'Repository',
      position: { x: 0, y: 0 },
      attributes: [],
      methods: [],
      kind: 'interface',
    });
    expect(iface.kind).toBe('interface');

    const abstractCls = ClassSchema.parse({
      id: crypto.randomUUID(),
      name: 'Shape',
      position: { x: 0, y: 0 },
      attributes: [],
      methods: [],
      isAbstract: true,
    });
    expect(abstractCls.kind).toBe('class');
    expect(abstractCls.isAbstract).toBe(true);
  });

  it('REJECTS invalid kind values (only class|interface)', () => {
    expect(ClassSchema.safeParse({
      id: crypto.randomUUID(), name: 'X', position: { x: 0, y: 0 }, attributes: [], methods: [], kind: 'abstract',
    }).success).toBe(false);
    expect(ClassSchema.safeParse({
      id: crypto.randomUUID(), name: 'X', position: { x: 0, y: 0 }, attributes: [], methods: [], kind: 'enum',
    }).success).toBe(false);
  });

  it('REJECTS non-boolean isAbstract', () => {
    expect(ClassSchema.safeParse({
      id: crypto.randomUUID(), name: 'X', position: { x: 0, y: 0 }, attributes: [], methods: [], isAbstract: 'yes',
    }).success).toBe(false);
  });
});

describe('IR Schema — Realization collection (unit 12.2)', () => {
  it('RealizationSchema accepts { id, clientClassId, supplierInterfaceId }', () => {
    const clientId = crypto.randomUUID();
    const supplierId = crypto.randomUUID();
    const parsed = RealizationSchema.parse({
      id: crypto.randomUUID(),
      clientClassId: clientId,
      supplierInterfaceId: supplierId,
    });
    expect(parsed.clientClassId).toBe(clientId);
    expect(parsed.supplierInterfaceId).toBe(supplierId);
  });

  it('RealizationSchema rejects non-uuid ids and missing ends', () => {
    expect(RealizationSchema.safeParse({ id: 'nope', clientClassId: crypto.randomUUID(), supplierInterfaceId: crypto.randomUUID() }).success).toBe(false);
    expect(RealizationSchema.safeParse({ id: crypto.randomUUID(), clientClassId: crypto.randomUUID() }).success).toBe(false);
    expect(RealizationSchema.safeParse({ id: crypto.randomUUID(), supplierInterfaceId: crypto.randomUUID() }).success).toBe(false);
  });

  it('DiagramSchema accepts a realizations collection', () => {
    const clientId = crypto.randomUUID();
    const ifaceId = crypto.randomUUID();
    const realId = crypto.randomUUID();
    const parsed = DiagramSchema.parse({
      id: crypto.randomUUID(),
      name: 'Realization',
      classes: [
        { id: clientId, name: 'Order', position: { x: 0, y: 0 }, attributes: [], methods: [] },
        { id: ifaceId, name: 'Repository', position: { x: 100, y: 0 }, attributes: [], methods: [], kind: 'interface' },
      ],
      associations: [],
      realizations: [{ id: realId, clientClassId: clientId, supplierInterfaceId: ifaceId }],
    });
    expect(parsed.realizations).toHaveLength(1);
    expect(parsed.realizations[0]).toMatchObject({ id: realId, clientClassId: clientId, supplierInterfaceId: ifaceId });
  });

  it('backward compat: diagrams WITHOUT realizations still validate and default to []', () => {
    const parsed = DiagramSchema.parse({
      id: crypto.randomUUID(),
      name: 'Legacy',
      classes: [],
      associations: [],
    });
    expect(parsed.realizations).toEqual([]);
  });
});

describe('IR Schema — NaryAssociation collection (unit 13.1, editor:R N-ary)', () => {
  it('NaryMemberEndSchema accepts { classId, multiplicity } and an optional role', () => {
    const classId = crypto.randomUUID();
    const parsed = NaryMemberEndSchema.parse({ classId, multiplicity: '1' });
    expect(parsed.classId).toBe(classId);
    expect(parsed.role).toBeUndefined();

    const withRole = NaryMemberEndSchema.parse({ classId, multiplicity: '0..*', role: 'supplier' });
    expect(withRole.role).toBe('supplier');
  });

  it('NaryMemberEndSchema rejects non-uuid classId and garbage multiplicity', () => {
    expect(NaryMemberEndSchema.safeParse({ classId: 'nope', multiplicity: '1' }).success).toBe(false);
    expect(NaryMemberEndSchema.safeParse({ classId: crypto.randomUUID(), multiplicity: 'abc' }).success).toBe(false);
    expect(NaryMemberEndSchema.safeParse({ multiplicity: '1' }).success).toBe(false);
  });

  it('NaryAssociationSchema accepts { id, memberEnds (>=3), name? }', () => {
    const ends = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    const parsed = NaryAssociationSchema.parse({
      id: crypto.randomUUID(),
      memberEnds: ends.map((classId, i) => ({
        classId,
        multiplicity: i === 0 ? '1' : i === 1 ? '0..*' : '*',
        ...(i === 0 ? { role: 'supplier' } : {}),
      })),
      name: 'supply',
    });
    expect(parsed.memberEnds).toHaveLength(3);
    expect(parsed.memberEnds[0]!.role).toBe('supplier');
    expect(parsed.name).toBe('supply');
  });

  it('NaryAssociationSchema REJECTS fewer than 3 member ends (IR integrity: n-ary means >=3)', () => {
    const two = [crypto.randomUUID(), crypto.randomUUID()];
    expect(NaryAssociationSchema.safeParse({
      id: crypto.randomUUID(),
      memberEnds: two.map((classId) => ({ classId, multiplicity: '1' })),
    }).success).toBe(false);
    expect(NaryAssociationSchema.safeParse({
      id: crypto.randomUUID(),
      memberEnds: [],
    }).success).toBe(false);
  });

  it('NaryAssociationSchema accepts 4+ ends (quaternary and beyond)', () => {
    const four = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    const parsed = NaryAssociationSchema.parse({
      id: crypto.randomUUID(),
      memberEnds: four.map((classId) => ({ classId, multiplicity: '1' })),
    });
    expect(parsed.memberEnds).toHaveLength(4);
    expect(parsed.name).toBeUndefined();
  });

  it('DiagramSchema accepts an naryAssociations collection', () => {
    const classIds = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    const naryId = crypto.randomUUID();
    const parsed = DiagramSchema.parse({
      id: crypto.randomUUID(),
      name: 'Nary',
      classes: classIds.map((id, i) => ({ id, name: `C${i}`, position: { x: i * 100, y: 0 }, attributes: [], methods: [] })),
      associations: [],
      naryAssociations: [
        { id: naryId, memberEnds: classIds.map((classId) => ({ classId, multiplicity: '1' })) },
      ],
    });
    expect(parsed.naryAssociations).toHaveLength(1);
    expect(parsed.naryAssociations[0]!.id).toBe(naryId);
  });

  it('backward compat: diagrams WITHOUT naryAssociations still validate and default to []', () => {
    const parsed = DiagramSchema.parse({
      id: crypto.randomUUID(),
      name: 'Legacy',
      classes: [],
      associations: [],
    });
    expect(parsed.naryAssociations).toEqual([]);
  });
});
