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
  type InterfaceModel,
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
      // 14c additive: Dockerfile / docker-compose.yml / README.md are the zip
      // extras (maintainer decision 2026-09-07) — still backend-only, no client.
      const isBackend =
        file.path.startsWith('src/main/java/') ||
        file.path.startsWith('src/main/resources/') ||
        file.path === 'pom.xml' ||
        file.path === 'mvnw' ||
        file.path === 'mvnw.cmd' ||
        file.path === '.mvn/wrapper/maven-wrapper.properties' ||
        file.path === 'Dockerfile' ||
        file.path === 'docker-compose.yml' ||
        file.path === 'README.md';
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

describe('robust identifier normalization during generation', () => {
  it('normalizes informal class and attribute names (e.g. spaces, Phone number)', () => {
    const d = diagram([
      cls(ID.product, 'Customer Order', [
        attr(ID.attrName, 'Phone number', 'String'),
        attr(ID.attrPrice, 'total amount', 'Double'),
      ]),
    ]);

    const result = generate(d, { outputRoot: ROOT });
    const entity = entityOf(result.files, 'CustomerOrder');
    expect(entity).toBeDefined();
    expect(entity.className).toBe('CustomerOrder');
    expect(entity.fields.find((f) => f.name === 'phoneNumber')).toBeDefined();
    expect(entity.fields.find((f) => f.name === 'totalAmount')).toBeDefined();

    const normalizerWarnings = result.warnings.filter((w) => w.code === 'normalized-identifier');
    expect(normalizerWarnings.length).toBeGreaterThanOrEqual(3);
  });

  it('normalizes accents, leading digits and reserved words on attributes', () => {
    const d = diagram([
      cls(ID.product, 'Información', [
        attr(ID.attrName, 'año de inicio', 'Integer'),
        attr(ID.attrPrice, '123code', 'String'),
        attr('44444444-4444-4444-8444-444444444445', 'class', 'String'),
      ]),
    ]);

    const result = generate(d, { outputRoot: ROOT });
    const entity = entityOf(result.files, 'Informacion');
    expect(entity).toBeDefined();
    expect(entity.className).toBe('Informacion');
    expect(entity.fields.find((f) => f.name === 'anoDeInicio')).toBeDefined();
    expect(entity.fields.find((f) => f.name === '_123code')).toBeDefined();
    expect(entity.fields.find((f) => f.name === '_class')).toBeDefined();
  });

  it('disambiguates duplicate field names resulting from normalization', () => {
    const d = diagram([
      cls(ID.product, 'Contact', [
        attr(ID.attrName, 'Phone number', 'String'),
        attr(ID.attrPrice, 'phone_number', 'String'),
      ]),
    ]);

    const result = generate(d, { outputRoot: ROOT });
    const entity = entityOf(result.files, 'Contact');
    expect(entity.fields.some((f) => f.name === 'phoneNumber')).toBe(true);
    expect(entity.fields.some((f) => f.name === 'phoneNumber2')).toBe(true);
    expect(result.warnings.some((w) => w.code === 'duplicate-identifier-disambiguated')).toBe(true);
  });

  it('still rejects path traversal attempts in attributes', () => {
    const d = diagram([
      cls(ID.product, 'ValidClass', [
        attr(ID.attrName, '../../secret.txt', 'String'),
      ]),
    ]);

    expect(() => generate(d, { outputRoot: ROOT })).toThrow(NameSanitizerError);
  });

  it('maps explicit id attribute to synthetic JPA primary key without duplicate field', () => {
    const d = diagram([
      cls(ID.product, 'Category', [
        attr(ID.attrName, 'id', 'String'),
        attr(ID.attrPrice, 'name', 'String'),
      ]),
    ]);

    const result = generate(d, { outputRoot: ROOT });
    const entity = entityOf(result.files, 'Category');
    expect(entity.fields.find((f) => f.name === 'id')).toBeUndefined();
    expect(entity.fields.find((f) => f.name === 'name')).toBeDefined();
    expect(result.warnings.some((w) => w.code === 'id-attribute-primary-key')).toBe(true);
  });
});

// ---------- unit 14c: UML 2.5.1 semantic mappings (task 14.5) ----------

const ID2 = {
  order: '11111111-1111-4111-8111-111111111111',
  line: '22222222-2222-4222-8222-222222222222',
  item: '33333333-3333-4333-8333-333333333333',
  product: '44444444-4444-4444-8444-444444444444',
  sellable: '55555555-5555-5555-8555-555555555555',
  payment: '66666666-6666-4666-8666-666666666666',
  customer: '77777777-7777-4777-8777-777777777777',
  attr: '88888888-8888-4888-8888-888888888888',
  assoc: '99999999-9999-4999-8999-999999999999',
  gen: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  real: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  nary: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
} as const;

/** Raw diagram builder accepting the full v2 IR shape (schemas apply defaults). */
function v2Diagram(parts: Record<string, unknown>): Diagram {
  return DiagramSchema.parse({
    id: ID2.order,
    name: 'V2 Diagram',
    classes: [],
    associations: [],
    ...parts,
  });
}

function v2Cls(id: string, name: string, extra: Record<string, unknown> = {}) {
  return { id, name, position: { x: 0, y: 0 }, attributes: [], methods: [], ...extra };
}
function v2Attr(name: string, type: string, extra: Record<string, unknown> = {}) {
  return { id: ID2.attr, name, type, ...extra };
}

describe('composition vs shared aggregation (14.5)', () => {
  it('composition puts cascade=ALL + orphanRemoval on the container-side collection', () => {
    const d = v2Diagram({
      classes: [v2Cls(ID2.order, 'Order'), v2Cls(ID2.line, 'OrderLine')],
      associations: [
        {
          id: ID2.assoc,
          sourceClassId: ID2.order,
          targetClassId: ID2.line,
          sourceMultiplicity: '1',
          targetMultiplicity: '0..*',
          directed: false,
          aggregation: 'composite',
          aggregationEnd: 'source',
        },
      ],
    });
    const result = generate(d, { outputRoot: ROOT });
    const order = entityOf(result.files, 'Order');
    const line = entityOf(result.files, 'OrderLine');
    const collection = order.relationships.find((r) => r.kind === 'OneToMany');
    expect(collection?.cascade).toBe(true);
    expect(collection?.orphanRemoval).toBe(true);
    // The child's owning ManyToOne does NOT cascade (container side owns lifecycle).
    expect(line.relationships.find((r) => r.kind === 'ManyToOne')?.cascade).toBe(false);
  });

  it('shared aggregation stays a plain association — documented decision, no cascade', () => {
    const d = v2Diagram({
      classes: [v2Cls(ID2.order, 'Order'), v2Cls(ID2.line, 'OrderLine')],
      associations: [
        {
          id: ID2.assoc,
          sourceClassId: ID2.order,
          targetClassId: ID2.line,
          sourceMultiplicity: '1',
          targetMultiplicity: '0..*',
          directed: false,
          aggregation: 'shared',
          aggregationEnd: 'source',
        },
      ],
    });
    const order = entityOf(generate(d, { outputRoot: ROOT }).files, 'Order');
    const collection = order.relationships.find((r) => r.kind === 'OneToMany');
    expect(collection?.cascade).toBe(false);
    expect(collection?.orphanRemoval).toBe(false);
  });
});

describe('generalization → single-table inheritance (14.5)', () => {
  it('marks the root, sets extendsClass on the subclass and never redeclares inherited fields', () => {
    const d = v2Diagram({
      classes: [
        v2Cls(ID2.item, 'Item', { attributes: [v2Attr('label', 'String')] }),
        v2Cls(ID2.product, 'Product', { attributes: [v2Attr('price', 'BigDecimal')] }),
      ],
      generalizations: [{ id: ID2.gen, subClassId: ID2.product, superClassId: ID2.item }],
    });
    const result = generate(d, { outputRoot: ROOT });
    const item = entityOf(result.files, 'Item');
    const product = entityOf(result.files, 'Product');
    expect(item.inheritanceRoot).toBe(true);
    expect(item.extendsClass).toBeNull();
    expect(product.extendsClass).toBe('Item');
    expect(product.inheritanceRoot).toBe(false);
    // Inherited fields must NOT be redeclared on the subclass.
    expect(product.fields.map((f) => f.name)).toEqual(['price']);
    expect(item.fields.map((f) => f.name)).toEqual(['label']);
  });

  it('warns and skips a generalization whose superclass is an interface', () => {
    const d = v2Diagram({
      classes: [
        v2Cls(ID2.sellable, 'Sellable', { kind: 'interface' }),
        v2Cls(ID2.product, 'Product'),
      ],
      generalizations: [{ id: ID2.gen, subClassId: ID2.product, superClassId: ID2.sellable }],
    });
    const result = generate(d, { outputRoot: ROOT });
    expect(result.warnings.some((w) => w.code === 'generalization-to-interface')).toBe(true);
    expect(entityOf(result.files, 'Product').extendsClass).toBeNull();
  });

  it('warns when an abstract class is an inheritance root needing a table', () => {
    const d = v2Diagram({
      classes: [
        v2Cls(ID2.item, 'Item', { isAbstract: true }),
        v2Cls(ID2.product, 'Product'),
      ],
      generalizations: [{ id: ID2.gen, subClassId: ID2.product, superClassId: ID2.item }],
    });
    const result = generate(d, { outputRoot: ROOT });
    expect(result.warnings.some((w) => w.code === 'abstract-inheritance-root-table')).toBe(true);
    expect(entityOf(result.files, 'Item').isAbstract).toBe(true);
    expect(entityOf(result.files, 'Item').inheritanceRoot).toBe(true);
  });
});

describe('interfaces and realizations (14.5)', () => {
  it('emits a plain interface file and NO entity/repository/controller/service for it', () => {
    const d = v2Diagram({
      classes: [
        v2Cls(ID2.sellable, 'Sellable', {
          kind: 'interface',
          methods: [
            { id: ID2.real, name: 'getPrice', returnType: 'BigDecimal', parameters: [] },
          ],
        }),
      ],
    });
    const paths = generate(d, { outputRoot: ROOT }).files.map((f) => f.path);
    const pkgPath = PKG.replace(/\./g, '/');
    expect(paths).toContain(`src/main/java/${pkgPath}/Sellable.java`);
    expect(paths.some((p) => p.includes('SellableRepository'))).toBe(false);
    expect(paths.some((p) => p.includes('SellableController'))).toBe(false);
    expect(paths.some((p) => p.includes('SellableService'))).toBe(false);
    const iface = generate(d, { outputRoot: ROOT }).files.find(
      (f) => f.path === `src/main/java/${pkgPath}/Sellable.java`,
    );
    expect(iface?.template).toBe('interface');
    expect((iface?.model as InterfaceModel).methods[0].returnType).toBe('BigDecimal');
  });

  it('realizing classes get an implements clause; attributes on interfaces warn', () => {
    const d = v2Diagram({
      classes: [
        v2Cls(ID2.sellable, 'Sellable', {
          kind: 'interface',
          attributes: [v2Attr('taxRate', 'BigDecimal')],
        }),
        v2Cls(ID2.product, 'Product'),
      ],
      realizations: [{ id: ID2.real, clientClassId: ID2.product, supplierInterfaceId: ID2.sellable }],
    });
    const result = generate(d, { outputRoot: ROOT });
    expect(entityOf(result.files, 'Product').implementsInterfaces).toEqual(['Sellable']);
    expect(result.warnings.some((w) => w.code === 'interface-attribute-skipped')).toBe(true);
  });

  it('an association touching an interface endpoint is skipped with a warning (never silent)', () => {
    const d = v2Diagram({
      classes: [v2Cls(ID2.sellable, 'Sellable', { kind: 'interface' }), v2Cls(ID2.product, 'Product')],
      associations: [
        {
          id: ID2.assoc,
          sourceClassId: ID2.product,
          targetClassId: ID2.sellable,
          sourceMultiplicity: '1',
          targetMultiplicity: '0..*',
          directed: false,
        },
      ],
    });
    const result = generate(d, { outputRoot: ROOT });
    expect(result.warnings.some((w) => w.code === 'interface-endpoint-skipped')).toBe(true);
    expect(entityOf(result.files, 'Product').relationships).toHaveLength(0);
  });
});

describe('abstract classes, visibility and attribute multiplicity (14.5)', () => {
  it('abstract class becomes an abstract entity WITHOUT repository/controller/service', () => {
    const d = v2Diagram({ classes: [v2Cls(ID2.payment, 'Payment', { isAbstract: true })] });
    const result = generate(d, { outputRoot: ROOT });
    const payment = entityOf(result.files, 'Payment');
    expect(payment.isAbstract).toBe(true);
    const paths = result.files.map((f) => f.path);
    // 17 spec fix: abstract types cannot back a REST CRUD surface — entity only.
    expect(paths.some((p) => p.endsWith('PaymentRepository.java'))).toBe(false);
    expect(paths.some((p) => p.endsWith('PaymentController.java'))).toBe(false);
    expect(paths.some((p) => p.endsWith('PaymentService.java'))).toBe(false);
    expect(result.warnings.some((w) => w.code === 'abstract-class-no-crud')).toBe(true);
  });

  it('maps member visibility -/# to private/protected field modifiers', () => {
    const d = v2Diagram({
      classes: [
        v2Cls(ID2.product, 'Product', {
          attributes: [
            v2Attr('secret', 'String', { visibility: '-' }),
            v2Attr('family', 'String', { visibility: '#' }),
            v2Attr('open', 'String', { visibility: '+' }),
          ],
        }),
      ],
    });
    const fields = entityOf(generate(d, { outputRoot: ROOT }).files, 'Product').fields;
    expect(fields.find((f) => f.name === 'secret')?.fieldModifier).toBe('private');
    expect(fields.find((f) => f.name === 'family')?.fieldModifier).toBe('protected');
    expect(fields.find((f) => f.name === 'open')?.fieldModifier).toBe('private');
  });

  it('basic attribute with multiplicity >1 becomes a List collection field', () => {
    const d = v2Diagram({
      classes: [
        v2Cls(ID2.customer, 'Customer', {
          attributes: [v2Attr('nicknames', 'String', { multiplicity: '0..*' })],
        }),
      ],
    });
    const field = entityOf(generate(d, { outputRoot: ROOT }).files, 'Customer').fields[0];
    expect(field.isCollection).toBe(true);
    expect(field.javaType).toBe('String');
  });
});

describe('n-ary association → intermediate join entity (14.5)', () => {
  it('generates a deterministic <SortedMembers>Link entity with @ManyToOne per member', () => {
    const d = v2Diagram({
      classes: [
        v2Cls(ID2.customer, 'Customer'),
        v2Cls(ID2.order, 'Order'),
        v2Cls(ID2.product, 'Product'),
      ],
      naryAssociations: [
        {
          id: ID2.nary,
          memberEnds: [
            { classId: ID2.order, multiplicity: '0..*' },
            { classId: ID2.product, multiplicity: '0..*' },
            { classId: ID2.customer, multiplicity: '0..*' },
          ],
        },
      ],
    });
    const result = generate(d, { outputRoot: ROOT });
    // Naming rule: sanitized member names sorted lexicographically + "Link".
    const join = entityOf(result.files, 'CustomerOrderProductLink');
    expect(join.relationships.map((r) => r.kind)).toEqual(['ManyToOne', 'ManyToOne', 'ManyToOne']);
    expect(join.relationships.map((r) => r.targetEntity).sort()).toEqual([
      'Customer',
      'Order',
      'Product',
    ]);
    const paths = result.files.map((f) => f.path);
    expect(paths.some((p) => p.endsWith('CustomerOrderProductLinkRepository.java'))).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it('warns and skips a join entity whose name collides with a class', () => {
    const d = v2Diagram({
      classes: [
        v2Cls(ID2.customer, 'Customer'),
        v2Cls(ID2.order, 'Order'),
        v2Cls(ID2.product, 'Product'),
        v2Cls(ID2.payment, 'CustomerOrderProductLink'),
      ],
      naryAssociations: [
        {
          id: ID2.nary,
          memberEnds: [
            { classId: ID2.customer, multiplicity: '0..*' },
            { classId: ID2.order, multiplicity: '0..*' },
            { classId: ID2.product, multiplicity: '0..*' },
          ],
        },
      ],
    });
    const result = generate(d, { outputRoot: ROOT });
    expect(result.warnings.some((w) => w.code === 'nary-join-name-collision')).toBe(true);
  });

  it('warns when an n-ary member is an interface (unmappable, never silent)', () => {
    const d = v2Diagram({
      classes: [
        v2Cls(ID2.customer, 'Customer'),
        v2Cls(ID2.order, 'Order'),
        v2Cls(ID2.sellable, 'Sellable', { kind: 'interface' }),
      ],
      naryAssociations: [
        {
          id: ID2.nary,
          memberEnds: [
            { classId: ID2.customer, multiplicity: '0..*' },
            { classId: ID2.order, multiplicity: '0..*' },
            { classId: ID2.sellable, multiplicity: '0..*' },
          ],
        },
      ],
    });
    const result = generate(d, { outputRoot: ROOT });
    expect(result.warnings.some((w) => w.code === 'nary-interface-member')).toBe(true);
  });
});

// ---------- unit 14c maintainer decisions: service layer + zip extras ----------

describe('thin service layer (maintainer decision 2026-09-07)', () => {
  it('emits one service per entity and none per interface', () => {
    const d = v2Diagram({
      classes: [v2Cls(ID2.product, 'Product'), v2Cls(ID2.sellable, 'Sellable', { kind: 'interface' })],
    });
    const files = generate(d, { outputRoot: ROOT }).files;
    const pkgPath = PKG.replace(/\./g, '/');
    const service = files.find((f) => f.path === `src/main/java/${pkgPath}/service/ProductService.java`);
    expect(service?.template).toBe('service');
    expect((service?.model as { className: string }).className).toBe('Product');
    expect(files.some((f) => f.path.includes('SellableService'))).toBe(false);
  });
});

describe('zip extras + production profile in the file map (14.6b + maintainer decision)', () => {
  it('plans application-prod.properties, Dockerfile, docker-compose.yml and README.md', () => {
    const d = v2Diagram({ classes: [v2Cls(ID2.product, 'Product')] });
    const files = generate(d, { outputRoot: ROOT }).files;
    const byPath = new Map(files.map((f) => [f.path, f]));
    expect(byPath.has('src/main/resources/application-prod.properties')).toBe(true);
    expect(byPath.get('Dockerfile')?.kind).toBe('build');
    expect(byPath.get('docker-compose.yml')?.kind).toBe('build');
    expect(byPath.get('README.md')?.kind).toBe('resource');
    expect(byPath.get('src/main/resources/application-prod.properties')?.kind).toBe('resource');
  });

  it('every new planned path still passes the output-root containment guard', () => {
    // A class name cannot escape: the sanitizer rejects it before any push.
    const d = v2Diagram({ classes: [v2Cls(ID2.product, '../escape')] });
    expect(() => generate(d, { outputRoot: ROOT })).toThrow(NameSanitizerError);
  });
});
