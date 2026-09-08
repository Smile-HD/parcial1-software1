import { AssociationSchema, AttributeSchema, ClassSchema, DiagramSchema, type Diagram } from '@app/core';
import { describe, expect, it } from 'vitest';

import { NameSanitizerError } from './sanitize.js';
import {
  MULTIPLICITY_MAPPING,
  TYPE_MAPPING,
  classifyMultiplicity,
  generate,
  mapAttributeType,
  type EntityModel,
} from './generate.js';

/**
 * Unit 14a generator tests. Templates land in 14b, so these assert the
 * in-memory IR→file map (paths + mapping models + warnings), not rendered Java.
 */

const ROOT = '/tmp/job-abc123';
const PKG = 'com.example.generated';

const ID = {
  product: '11111111-1111-4111-8111-111111111111',
  customer: '22222222-2222-4222-8222-222222222222',
  order: '33333333-3333-4333-8333-333333333333',
  attrName: '44444444-4444-4444-8444-444444444444',
  attrPrice: '55555555-5555-5555-8555-555555555555',
  assoc: '66666666-6666-4666-8666-666666666666',
  missing: '77777777-7777-4777-8777-777777777777',
} as const;

function attr(id: string, name: string, type: string) {
  return AttributeSchema.parse({ id, name, type });
}
function cls(id: string, name: string, attributes: ReturnType<typeof attr>[] = []) {
  return ClassSchema.parse({
    id,
    name,
    position: { x: 0, y: 0 },
    attributes,
    methods: [],
  });
}
function diagram(classes: ReturnType<typeof cls>[], associations: unknown[] = []): Diagram {
  return DiagramSchema.parse({
    id: ID.product,
    name: 'Test Diagram',
    classes,
    associations: associations.map((a) => AssociationSchema.parse(a)),
  });
}
function entityOf(files: { path: string; model: unknown }[], className: string): EntityModel {
  const file = files.find(
    (f) => f.path === `src/main/java/${PKG.replace(/\./g, '/')}/${className}.java`,
  );
  if (!file) throw new Error(`no entity file for ${className}`);
  return file.model as EntityModel;
}

describe('type mapping table (codegen:R2)', () => {
  it('maps documented UML types to Java types', () => {
    expect(mapAttributeType('String').javaType).toBe('String');
    expect(mapAttributeType('BigDecimal').javaType).toBe('BigDecimal');
    expect(mapAttributeType('int').javaType).toBe('Integer');
    expect(TYPE_MAPPING['string']).toBe('String');
  });

  it('falls back to String and warns for an unmapped attribute type (14.3)', () => {
    const d = diagram([cls(ID.product, 'Product', [attr(ID.attrName, 'name', 'Unicorn')])]);
    const result = generate(d, { outputRoot: ROOT });

    const warning = result.warnings.find((w) => w.code === 'unmapped-type');
    expect(warning).toBeDefined();
    expect(warning?.message).toContain('Unicorn');
    expect(warning?.element).toBe('Product.name');

    const field = entityOf(result.files, 'Product').fields.find((f) => f.name === 'name');
    expect(field?.javaType).toBe('String');
    expect(field?.declaredType).toBe('Unicorn');
  });
});

describe('multiplicity mapping table (Relation Mapping)', () => {
  it('classifies endpoint multiplicities into cardinalities', () => {
    expect(classifyMultiplicity('1')).toBe('one');
    expect(classifyMultiplicity('0..1')).toBe('zeroOrOne');
    expect(classifyMultiplicity('0..*')).toBe('many');
    expect(classifyMultiplicity('1..*')).toBe('many');
    expect(classifyMultiplicity('3..7')).toBe('many');
    expect(classifyMultiplicity('*')).toBe('many');
  });

  it('documents the 1 <-> 0..* pair as OneToMany/ManyToOne', () => {
    expect(MULTIPLICITY_MAPPING['one:many']).toBe('OneToMany');
    expect(MULTIPLICITY_MAPPING['many:one']).toBe('ManyToOne');
    expect(MULTIPLICITY_MAPPING['many:many']).toBe('ManyToMany');
    expect(MULTIPLICITY_MAPPING['one:one']).toBe('OneToOne');
  });

  it('maps Customer 1 -- 0..* Order to a OneToMany on Customer and ManyToOne on Order', () => {
    const d = diagram(
      [cls(ID.customer, 'Customer'), cls(ID.order, 'Order')],
      [
        {
          id: ID.assoc,
          sourceClassId: ID.customer,
          targetClassId: ID.order,
          sourceMultiplicity: '1',
          targetMultiplicity: '0..*',
          directed: false,
        },
      ],
    );
    const result = generate(d, { outputRoot: ROOT });

    const customer = entityOf(result.files, 'Customer');
    const order = entityOf(result.files, 'Order');
    expect(customer.relationships.some((r) => r.kind === 'OneToMany' && r.targetEntity === 'Order')).toBe(true);
    expect(order.relationships.some((r) => r.kind === 'ManyToOne' && r.targetEntity === 'Customer')).toBe(true);
  });
});

describe('association with a missing endpoint (codegen:R3, 14.3)', () => {
  it('is skipped with a warning and generation still completes', () => {
    const d = diagram(
      [cls(ID.customer, 'Customer'), cls(ID.order, 'Order')],
      [
        {
          id: ID.assoc,
          sourceClassId: ID.customer,
          targetClassId: ID.missing, // not present in the model
          sourceMultiplicity: '1',
          targetMultiplicity: '0..*',
          directed: false,
        },
      ],
    );
    const result = generate(d, { outputRoot: ROOT });

    const warning = result.warnings.find((w) => w.code === 'missing-endpoint');
    expect(warning).toBeDefined();
    expect(warning?.message).toContain(ID.missing);

    // Generation completed: both real classes still produced entities, and the
    // dangling association contributed no relationship to either side.
    expect(entityOf(result.files, 'Customer').relationships).toHaveLength(0);
    expect(entityOf(result.files, 'Order').relationships).toHaveLength(0);
    expect(result.files.some((f) => f.path.endsWith('/Order.java'))).toBe(true);
  });
});

describe('backend-only output (codegen:R1, 14.4)', () => {
  const FRONTEND = /(^|\/)(node_modules|frontend|dist|build|public)\//;
  const FRONTEND_EXT = /\.(tsx?|jsx?|vue|svelte|css|html)$/;

  it('emits only backend sources, resources and the build file for a 3-class diagram', () => {
    const d = diagram([
      cls(ID.product, 'Product', [attr(ID.attrName, 'name', 'String')]),
      cls(ID.customer, 'Customer'),
      cls(ID.order, 'Order'),
    ]);
    const result = generate(d, { outputRoot: ROOT });

    expect(result.files.length).toBeGreaterThan(0);
    for (const file of result.files) {
      // 14b additive: the Maven wrapper assets are backend BUILD files at the
      // project root (design decision 10) — allowed alongside sources/resources/pom.
      const isBackend =
        file.path.startsWith('src/main/java/') ||
        file.path.startsWith('src/main/resources/') ||
        file.path === 'pom.xml' ||
        file.path === 'mvnw' ||
        file.path === 'mvnw.cmd' ||
        file.path === '.mvn/wrapper/maven-wrapper.properties';
      expect(isBackend).toBe(true);
      expect(['source', 'resource', 'build']).toContain(file.kind);
      expect(file.path).not.toMatch(FRONTEND);
      expect(file.path).not.toMatch(FRONTEND_EXT);
    }

    // The three required backend categories are all present.
    expect(result.files.some((f) => f.kind === 'source')).toBe(true);
    expect(result.files.some((f) => f.kind === 'resource')).toBe(true);
    expect(result.files.some((f) => f.kind === 'build')).toBe(true);
  });
});

describe('name sanitizer wired into generation (codegen threat row 1)', () => {
  it('rejects a traversal class name and produces no files', () => {
    const d = diagram([cls(ID.product, '../../pom.xml')]);
    expect(() => generate(d, { outputRoot: ROOT })).toThrow(NameSanitizerError);
  });

  it('rejects a reserved-word class name', () => {
    const d = diagram([cls(ID.product, 'class')]);
    expect(() => generate(d, { outputRoot: ROOT })).toThrow(NameSanitizerError);
  });
});
