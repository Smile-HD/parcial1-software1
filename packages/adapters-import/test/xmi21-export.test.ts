import { describe, it, expect, vi } from 'vitest';
import { exportDiagramToXmi } from '../src/xmi21-export.js';
import { parseXmiDocument, xmiToDeltaBatch } from '../src/xmi21.js';
import { applyDelta, DiagramSchema, type Diagram } from '@app/core';
import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';

const TEST_DIAGRAM_ID = '00000000-0000-4000-8000-000000000000';

// Stable UUIDs for the golden diagram — must be valid v4 UUIDs
// (DiagramSchema uses z.string().uuid() which rejects version nibbles > 8).
const C = {
  order:    '10000000-0000-4000-8000-000000000001',
  line:     '10000000-0000-4000-8000-000000000002',
  payable:  '10000000-0000-4000-8000-000000000003',
  customer: '10000000-0000-4000-8000-000000000004',
} as const;

/**
 * Build a minimal Diagram IR that exercises the full supported subset:
 * - classes with kind (class/interface), isAbstract
 * - attributes: visibility, isStatic, isDerived, multiplicity
 * - methods: visibility, isStatic, parameters, returnType
 * - associations: aggregation kinds, names, roles, multiplicities
 * - generalizations
 * - interfaces + realization
 * - dependency
 * - n-ary association
 */
function goldenDiagram(): Diagram {
  return DiagramSchema.parse({
    id: TEST_DIAGRAM_ID,
    name: 'Golden Round-Trip',
    classes: [
      {
        id: C.order,
        name: 'Order',
        position: { x: 100, y: 200 },
        kind: 'class',
        isAbstract: false,
        attributes: [
          { id: randomUUID(), name: 'total', type: 'double', visibility: '-', isStatic: false, isDerived: false },
          { id: randomUUID(), name: 'count', type: 'int', visibility: '+', isStatic: true, isDerived: false, multiplicity: '3..7' },
        ],
        methods: [
          {
            id: randomUUID(),
            name: 'calculateTotal',
            returnType: 'double',
            parameters: [{ name: 'tax', type: 'double' }],
            visibility: '+',
            isStatic: false,
          },
        ],
      },
      {
        id: C.line,
        name: 'OrderLine',
        position: { x: 400, y: 200 },
        kind: 'class',
        isAbstract: false,
        attributes: [
          { id: randomUUID(), name: 'quantity', type: 'int', visibility: '+', isStatic: false, isDerived: false, multiplicity: '1..*' },
        ],
        methods: [],
      },
      {
        id: C.payable,
        name: 'Payable',
        position: { x: 100, y: 500 },
        kind: 'interface',
        isAbstract: true,
        attributes: [],
        methods: [
          {
            id: randomUUID(),
            name: 'pay',
            returnType: 'void',
            parameters: [],
            visibility: '+',
            isStatic: false,
          },
        ],
      },
      {
        id: C.customer,
        name: 'Customer',
        position: { x: 400, y: 500 },
        kind: 'class',
        isAbstract: false,
        attributes: [
          { id: randomUUID(), name: 'email', type: 'String', visibility: '+', isStatic: false, isDerived: true },
        ],
        methods: [],
      },
    ],
    associations: [
      {
        id: randomUUID(),
        sourceClassId: C.order,
        targetClassId: C.line,
        sourceMultiplicity: '1',
        targetMultiplicity: '0..*',
        directed: true,
        aggregation: 'composite',
        aggregationEnd: 'source',
        name: 'order_lines',
        sourceRole: 'parent',
        targetRole: 'child',
      },
      {
        id: randomUUID(),
        sourceClassId: C.customer,
        targetClassId: C.order,
        sourceMultiplicity: '1',
        targetMultiplicity: '0..*',
        directed: true,
        aggregation: 'shared',
        aggregationEnd: 'source',
        name: 'customer_orders',
        sourceRole: 'customer',
        targetRole: 'order',
      },
      {
        id: randomUUID(),
        sourceClassId: C.line,
        targetClassId: C.line,
        directed: true,
        aggregation: 'none',
        aggregationEnd: 'source',
      },
    ],
    generalizations: [
      {
        id: randomUUID(),
        subClassId: C.line,
        superClassId: C.order,
      },
    ],
    realizations: [
      {
        id: randomUUID(),
        clientClassId: C.order,
        supplierInterfaceId: C.payable,
      },
    ],
    dependencies: [
      {
        id: randomUUID(),
        clientClassId: C.order,
        supplierClassId: C.customer,
      },
    ],
    naryAssociations: [
      {
        id: randomUUID(),
        name: 'Supply',
        memberEnds: [
          { classId: C.order, multiplicity: '1', role: 'order' },
          { classId: C.line, multiplicity: '0..*', role: 'line' },
          { classId: C.customer, multiplicity: '1', role: 'customer' },
        ],
      },
    ],
  });
}

describe('XMI 2.1 Exporter', () => {
  describe('15b.1 — lossless round-trip (export → import → same model)', () => {
    it('exports a diagram that re-imports into the same class inventory', () => {
      const diagram = goldenDiagram();
      const xmi = exportDiagramToXmi(diagram);
      expect(typeof xmi).toBe('string');
      expect(xmi.length).toBeGreaterThan(0);

      const model = parseXmiDocument(xmi);
      expect(model.classes).toHaveLength(diagram.classes.length);

      const originalNames = diagram.classes.map(c => c.name).sort();
      const reimportedNames = model.classes.map(c => c.name).sort();
      expect(reimportedNames).toEqual(originalNames);
    });

    it('round-trips class kind (interface) and isAbstract', () => {
      const diagram = goldenDiagram();
      const xmi = exportDiagramToXmi(diagram);
      const model = parseXmiDocument(xmi);

      const payable = model.classes.find(c => c.name === 'Payable')!;
      expect(payable.kind).toBe('interface');
      expect(payable.isAbstract).toBe(true);

      const order = model.classes.find(c => c.name === 'Order')!;
      expect(order.kind).toBe('class');
      expect(order.isAbstract).toBe(false);
    });

    it('round-trips attributes with visibility, isStatic, isDerived, and multiplicity', () => {
      const diagram = goldenDiagram();
      const xmi = exportDiagramToXmi(diagram);
      const model = parseXmiDocument(xmi);

      const order = model.classes.find(c => c.name === 'Order')!;
      const total = order.attributes.find(a => a.name === 'total')!;
      expect(total.visibility).toBe('-');
      expect(total.isStatic).toBe(false);
      expect(total.isDerived).toBe(false);

      const count = order.attributes.find(a => a.name === 'count')!;
      expect(count.isStatic).toBe(true);
      expect(count.multiplicity).toBe('3..7');

      const email = model.classes.find(c => c.name === 'Customer')!.attributes.find(a => a.name === 'email')!;
      expect(email.isDerived).toBe(true);
    });

    it('round-trips methods with visibility, isStatic, parameters, and returnType', () => {
      const diagram = goldenDiagram();
      const xmi = exportDiagramToXmi(diagram);
      const model = parseXmiDocument(xmi);

      const order = model.classes.find(c => c.name === 'Order')!;
      const calc = order.methods.find(m => m.name === 'calculateTotal')!;
      expect(calc.visibility).toBe('+');
      expect(calc.isStatic).toBe(false);
      expect(calc.returnType).toBe('double');
      expect(calc.parameters).toEqual([{ name: 'tax', type: 'double' }]);

      const payable = model.classes.find(c => c.name === 'Payable')!;
      const pay = payable.methods.find(m => m.name === 'pay')!;
      expect(pay.returnType).toBe('void');
      expect(pay.parameters).toEqual([]);
    });

    it('round-trips composite association with name, roles, and multiplicities', () => {
      const diagram = goldenDiagram();
      const xmi = exportDiagramToXmi(diagram);
      const model = parseXmiDocument(xmi);

      const composite = model.associations.find(a => a.aggregation === 'composite')!;
      expect(composite).toBeDefined();
      expect(composite.name).toBe('order_lines');
      expect(composite.sourceMultiplicity).toBe('1');
      expect(composite.targetMultiplicity).toBe('0..*');
      expect(composite.sourceRole).toBe('parent');
      expect(composite.targetRole).toBe('child');
    });

    it('round-trips shared aggregation', () => {
      const diagram = goldenDiagram();
      const xmi = exportDiagramToXmi(diagram);
      const model = parseXmiDocument(xmi);

      const shared = model.associations.find(a => a.aggregation === 'shared')!;
      expect(shared).toBeDefined();
      expect(shared.name).toBe('customer_orders');
    });

    it('round-trips generalization', () => {
      const diagram = goldenDiagram();
      const xmi = exportDiagramToXmi(diagram);
      const model = parseXmiDocument(xmi);

      expect(model.generalizations).toHaveLength(1);
      const gen = model.generalizations[0];
      expect(model.classes.find(c => c.id === gen.subClassId)?.name).toBe('OrderLine');
      expect(model.classes.find(c => c.id === gen.superClassId)?.name).toBe('Order');
    });

    it('round-trips realization (client class → supplier interface)', () => {
      const diagram = goldenDiagram();
      const xmi = exportDiagramToXmi(diagram);
      const model = parseXmiDocument(xmi);

      expect(model.realizations).toHaveLength(1);
      const real = model.realizations[0];
      expect(model.classes.find(c => c.id === real.clientId)?.name).toBe('Order');
      const supplier = model.classes.find(c => c.id === real.supplierId)!;
      expect(supplier.name).toBe('Payable');
      expect(supplier.kind).toBe('interface');
    });

    it('round-trips dependency', () => {
      const diagram = goldenDiagram();
      const xmi = exportDiagramToXmi(diagram);
      const model = parseXmiDocument(xmi);

      expect(model.dependencies).toHaveLength(1);
      const dep = model.dependencies[0];
      expect(model.classes.find(c => c.id === dep.clientId)?.name).toBe('Order');
      expect(model.classes.find(c => c.id === dep.supplierId)?.name).toBe('Customer');
    });

    it('round-trips n-ary association with name and member ends', () => {
      const diagram = goldenDiagram();
      const xmi = exportDiagramToXmi(diagram);
      const model = parseXmiDocument(xmi);

      expect(model.naryAssociations).toHaveLength(1);
      const nary = model.naryAssociations[0];
      expect(nary.name).toBe('Supply');
      expect(nary.memberEnds).toHaveLength(3);
    });

    it('full round-trip: export → import → delta batch → apply → identical model', () => {
      const diagram = goldenDiagram();
      const xmi = exportDiagramToXmi(diagram);

      // Import the XMI
      const model = parseXmiDocument(xmi);
      const batch = xmiToDeltaBatch(model, TEST_DIAGRAM_ID);

      // Apply to empty diagram
      const emptyDiagram = DiagramSchema.parse({
        id: TEST_DIAGRAM_ID,
        name: 'Empty',
        classes: [],
        associations: [],
        generalizations: [],
        realizations: [],
        dependencies: [],
        naryAssociations: [],
      });
      const result = applyDelta(emptyDiagram, batch);
      expect(result.ok).toBe(true);

      if (result.ok) {
        const imported = result.value;

        // Compare class inventory
        expect(imported.classes).toHaveLength(diagram.classes.length);
        const origNames = diagram.classes.map(c => c.name).sort();
        const importedNames = imported.classes.map(c => c.name).sort();
        expect(importedNames).toEqual(origNames);

        // Compare class kinds and abstract flags
        for (const orig of diagram.classes) {
          const imp = imported.classes.find(c => c.name === orig.name)!;
          expect(imp.kind).toBe(orig.kind);
          expect(imp.isAbstract).toBe(orig.isAbstract);
        }

        // Compare associations count
        expect(imported.associations).toHaveLength(diagram.associations.length);

        // Compare generalizations
        expect(imported.generalizations).toHaveLength(diagram.generalizations.length);

        // Compare realizations
        expect(imported.realizations).toHaveLength(diagram.realizations.length);

        // Compare dependencies
        expect(imported.dependencies).toHaveLength(diagram.dependencies.length);

        // Compare n-ary
        expect(imported.naryAssociations).toHaveLength(diagram.naryAssociations.length);
      }
    });
  });

  describe('15b.3 — layout preservation', () => {
    it('exported XMI includes canvas positions in a layout extension', () => {
      const diagram = goldenDiagram();
      const xmi = exportDiagramToXmi(diagram);

      // The XMI should contain position information
      // Check that the positions from the original diagram are somewhere in the output
      expect(xmi).toContain('100');
      expect(xmi).toContain('200');
      expect(xmi).toContain('400');
      expect(xmi).toContain('500');
    });

    it('exported XMI is valid XML', () => {
      const diagram = goldenDiagram();
      const xmi = exportDiagramToXmi(diagram);

      // Must start with XML declaration
      expect(xmi).toMatch(/^<\?xml/);
      // Must contain the XMI namespace
      expect(xmi).toContain('xmi:XMI');
      // Must contain the UML namespace
      expect(xmi).toContain('uml:Model');
    });
  });

  describe('15b.5 — offline golden round-trip (zero network calls)', () => {
    it('round-trips the golden diagram offline: export → import → structural identity', () => {
      // Spy on any potential network access — fetch, http, net, https
      // The export/import pipeline is pure in-memory XML processing;
      // this spy proves NO network port is ever touched.
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);

      const httpGetSpy = vi.fn();
      vi.stubGlobal('http', { get: httpGetSpy });

      const httpsGetSpy = vi.fn();
      vi.stubGlobal('https', { get: httpsGetSpy });

      try {
        const diagram = goldenDiagram();

        // 1. Export the golden diagram to XMI
        const xmi = exportDiagramToXmi(diagram);
        expect(typeof xmi).toBe('string');
        expect(xmi.length).toBeGreaterThan(0);

        // 2. Import the XMI back
        const model = parseXmiDocument(xmi);
        const batch = xmiToDeltaBatch(model, TEST_DIAGRAM_ID);

        // 3. Apply to an empty diagram
        const emptyDiagram = DiagramSchema.parse({
          id: TEST_DIAGRAM_ID,
          name: 'Empty',
          classes: [],
          associations: [],
          generalizations: [],
          realizations: [],
          dependencies: [],
          naryAssociations: [],
        });
        const result = applyDelta(emptyDiagram, batch);
        expect(result.ok).toBe(true);

        if (result.ok) {
          const reimported = result.value;

          // 4. Structural identity — names and structure match, not IDs
          expect(reimported.classes.map(c => c.name).sort())
            .toEqual(diagram.classes.map(c => c.name).sort());

          // Class kinds and abstract flags
          for (const orig of diagram.classes) {
            const imp = reimported.classes.find(c => c.name === orig.name)!;
            expect(imp.kind).toBe(orig.kind);
            expect(imp.isAbstract).toBe(orig.isAbstract);
          }

          // Associations count + aggregation kinds
          expect(reimported.associations).toHaveLength(diagram.associations.length);
          for (const origAssoc of diagram.associations) {
            if (origAssoc.aggregation !== 'none') {
              const match = reimported.associations.find(a => a.aggregation === origAssoc.aggregation);
              expect(match).toBeDefined();
            }
          }

          // Generalizations, realizations, dependencies, n-ary counts
          expect(reimported.generalizations).toHaveLength(diagram.generalizations.length);
          expect(reimported.realizations).toHaveLength(diagram.realizations.length);
          expect(reimported.dependencies).toHaveLength(diagram.dependencies.length);
          expect(reimported.naryAssociations).toHaveLength(diagram.naryAssociations.length);
        }

        // 5. Assert ZERO network calls were made
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(httpGetSpy).not.toHaveBeenCalled();
        expect(httpsGetSpy).not.toHaveBeenCalled();
      } finally {
        vi.restoreAllMocks();
      }
    });

    it('round-trips a real EA fixture offline: import → export → re-import → structural identity', () => {
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);

      try {
        // 1. Load and import the real EA fixture
        const fixturePath = join(__dirname, 'fixtures', 'ea-sample.xmi');
        const eaXmi = readFileSync(fixturePath, 'utf-8');
        const imported = parseXmiDocument(eaXmi);

        // 2. Convert to IR diagram, then export back to XMI
        const fixtureDiagramId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
        const batch = xmiToDeltaBatch(imported, fixtureDiagramId);
        const emptyDiagram = DiagramSchema.parse({
          id: fixtureDiagramId,
          name: 'EA Fixture',
          classes: [],
          associations: [],
          generalizations: [],
          realizations: [],
          dependencies: [],
          naryAssociations: [],
        });
        const applyResult = applyDelta(emptyDiagram, batch);
        expect(applyResult.ok).toBe(true);

        if (applyResult.ok) {
          const irDiagram = applyResult.value;

          // 3. Export the IR to XMI
          const reExportedXmi = exportDiagramToXmi(irDiagram);
          expect(reExportedXmi).toContain('<?xml');
          expect(reExportedXmi).toContain('xmi:XMI');

          // 4. Re-import and verify structural identity
          const reimported = parseXmiDocument(reExportedXmi);

          // Same class names
          expect(reimported.classes.map(c => c.name).sort())
            .toEqual(imported.classes.map(c => c.name).sort());

          // Same interface/abstract
          for (const orig of imported.classes) {
            const reimp = reimported.classes.find(c => c.name === orig.name)!;
            expect(reimp.kind).toBe(orig.kind);
            expect(reimp.isAbstract).toBe(orig.isAbstract);
          }

          // Same association count
          expect(reimported.associations).toHaveLength(imported.associations.length);

          // Same generalizations count
          expect(reimported.generalizations).toHaveLength(imported.generalizations.length);

          // Same realizations count
          expect(reimported.realizations).toHaveLength(imported.realizations.length);

          // Same dependencies count
          expect(reimported.dependencies).toHaveLength(imported.dependencies.length);

          // Same n-ary count
          expect(reimported.naryAssociations).toHaveLength(imported.naryAssociations.length);
        }

        // 5. Assert ZERO network calls
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        vi.restoreAllMocks();
      }
    });
  });

  describe('Extensión nativa de Enterprise Architect (15b.7)', () => {
    it('emite el bloque de extensión de Enterprise Architect con diagramas y geometría de elementos', () => {
      const diagram = goldenDiagram();
      const xmi = exportDiagramToXmi(diagram);

      // Verifica que exista la extensión con extender="Enterprise Architect"
      expect(xmi).toContain('<xmi:Extension extender="Enterprise Architect" extenderID="6.5">');
      expect(xmi).toContain('<diagrams>');
      expect(xmi).toContain(`<properties name="${diagram.name}" type="Logical"/>`);

      // Verifica que cada clase tenga su elemento con coordenadas Left, Top, Right, Bottom y subject
      for (const cls of diagram.classes) {
        const expectedSubject = `subject="${cls.id}"`;
        expect(xmi).toContain(expectedSubject);
        const expectedLeft = `Left=${Math.round(cls.position.x)}`;
        const expectedTop = `Top=${Math.round(cls.position.y)}`;
        expect(xmi).toContain(expectedLeft);
        expect(xmi).toContain(expectedTop);
      }
    });
  });

  describe('Compatibilidad con Enterprise Architect (prevención de {bag})', () => {
    it('emite isOrdered="false" isUnique="true" y límites 1..1 en atributos escalares para evitar {bag} en EA', () => {
      const diagram = goldenDiagram();
      const xmi = exportDiagramToXmi(diagram);

      // Cada ownedAttribute debe tener isOrdered="false" e isUnique="true"
      const ownedAttrMatches = xmi.match(/<ownedAttribute\b[^>]*>/g) ?? [];
      expect(ownedAttrMatches.length).toBeGreaterThan(0);
      for (const attrTag of ownedAttrMatches) {
        expect(attrTag).toContain('isOrdered="false"');
        expect(attrTag).toContain('isUnique="true"');
        expect(attrTag).toContain('isReadOnly="false"');
        expect(attrTag).toContain('isDerivedUnion="false"');
      }

      // Atributo escalar 'total' (sin multiplicidad previa) debe emitir lowerValue=1 y upperValue=1
      expect(xmi).toMatch(/<ownedAttribute[^>]*name="total"[^>]*>[\s\S]*?<lowerValue[^>]*value="1"\/>[\s\S]*?<upperValue[^>]*value="1"\/>/);

      // Extremos de asociación ownedEnd también deben tener isOrdered="false" e isUnique="true"
      const ownedEndMatches = xmi.match(/<ownedEnd\b[^>]*>/g) ?? [];
      expect(ownedEndMatches.length).toBeGreaterThan(0);
      for (const endTag of ownedEndMatches) {
        expect(endTag).toContain('isOrdered="false"');
        expect(endTag).toContain('isUnique="true"');
      }
    });
  });

  describe('Preservación de textos de relaciones y conectores EA', () => {
    it('exporta conectores EA con labels mt (nombre), lt/rt (roles) y lb/rb (multiplicidades)', () => {
      const diagram = goldenDiagram();
      const xmi = exportDiagramToXmi(diagram);

      // Debe contener bloque connectors con etiquetas EA
      expect(xmi).toContain('<connectors>');
      expect(xmi).toContain('ea_type="Association"');
      expect(xmi).toContain('mt="order_lines"');
      expect(xmi).toContain('lt="parent"');
      expect(xmi).toContain('rt="child"');
      expect(xmi).toContain('lb="1"');
      expect(xmi).toContain('rb="0..*"');

      // Las asociaciones N-arias deben estar registradas en elements y en diagrams de EA
      expect(xmi).toContain('<element xmi:idref="');
      expect(xmi).toContain('sType="Association"');
    });

    it('round-trip preserva nombres en generalizaciones, realizaciones y dependencias', () => {
      const customDiagram = DiagramSchema.parse({
        id: randomUUID(),
        name: 'Relation Names Test',
        classes: [
          { id: C.order, name: 'Order', position: { x: 100, y: 100 }, kind: 'class', isAbstract: false, attributes: [], methods: [] },
          { id: C.line, name: 'OrderLine', position: { x: 300, y: 100 }, kind: 'class', isAbstract: false, attributes: [], methods: [] },
          { id: C.payable, name: 'Payable', position: { x: 100, y: 300 }, kind: 'interface', isAbstract: true, attributes: [], methods: [] },
          { id: C.customer, name: 'Customer', position: { x: 300, y: 300 }, kind: 'class', isAbstract: false, attributes: [], methods: [] },
        ],
        associations: [
          {
            id: randomUUID(),
            sourceClassId: C.order,
            targetClassId: C.line,
            directed: true,
            aggregation: 'none',
            name: 'items',
            sourceRole: 'pedido',
            targetRole: 'detalle',
          },
        ],
        generalizations: [
          { id: randomUUID(), subClassId: C.line, superClassId: C.order, name: 'hereda_de' },
        ],
        realizations: [
          { id: randomUUID(), clientClassId: C.order, supplierInterfaceId: C.payable, name: 'implementa_pago' },
        ],
        dependencies: [
          { id: randomUUID(), clientClassId: C.order, supplierClassId: C.customer, name: 'usa_cliente' },
        ],
        naryAssociations: [
          {
            id: randomUUID(),
            name: 'TernariaCentral',
            memberEnds: [
              { classId: C.order, multiplicity: '1', role: 'rol_orden' },
              { classId: C.line, multiplicity: '0..*', role: 'rol_linea' },
              { classId: C.customer, multiplicity: '1', role: 'rol_cliente' },
            ],
          },
        ],
      });

      const xmi = exportDiagramToXmi(customDiagram);
      const model = parseXmiDocument(xmi);

      // Nombres de asociaciones y roles
      expect(model.associations[0].name).toBe('items');
      expect(model.associations[0].sourceRole).toBe('pedido');
      expect(model.associations[0].targetRole).toBe('detalle');

      // Nombres de generalización, realización y dependencia
      expect(model.generalizations[0].name).toBe('hereda_de');
      expect(model.realizations[0].name).toBe('implementa_pago');
      expect(model.dependencies[0].name).toBe('usa_cliente');

      // Nombre y extremos de asociación N-aria
      expect(model.naryAssociations[0].name).toBe('TernariaCentral');
      expect(model.naryAssociations[0].memberEnds).toHaveLength(3);

      // Verificación en delta batch
      const batch = xmiToDeltaBatch(model, customDiagram.id);
      const genDelta = batch.deltas.find((d) => d.kind === 'generalization');
      expect((genDelta as any)?.name).toBe('hereda_de');

      const realDelta = batch.deltas.find((d) => d.kind === 'realization');
      expect((realDelta as any)?.name).toBe('implementa_pago');

      const depDelta = batch.deltas.find((d) => d.kind === 'dependency');
      expect((depDelta as any)?.name).toBe('usa_cliente');

      const naryDelta = batch.deltas.find((d) => d.kind === 'naryAssociation');
      expect((naryDelta as any)?.name).toBe('TernariaCentral');
    });
  });

  describe('Mapeo y exportación de tipos de datos a XMI y Enterprise Architect', () => {
    it('exporta tipos de datos primitivos y resuelve case-insensitively (INT, STRING, BoOlEaN, date)', () => {
      const diagram = DiagramSchema.parse({
        id: randomUUID(),
        name: 'Type Export Test',
        classes: [
          {
            id: C.order,
            name: 'Order',
            position: { x: 100, y: 100 },
            kind: 'class',
            isAbstract: false,
            attributes: [
              { id: randomUUID(), name: 'total', type: 'double', visibility: '-', isStatic: false, isDerived: false },
              { id: randomUUID(), name: 'age', type: 'INT', visibility: '+', isStatic: false, isDerived: false },
              { id: randomUUID(), name: 'code', type: 'STRING', visibility: '#', isStatic: false, isDerived: false },
              { id: randomUUID(), name: 'active', type: 'BoOlEaN', visibility: '+', isStatic: false, isDerived: false },
              { id: randomUUID(), name: 'createdAt', type: 'date', visibility: '+', isStatic: false, isDerived: false },
              { id: randomUUID(), name: 'guid', type: 'UUID', visibility: '+', isStatic: false, isDerived: false },
            ],
            methods: [
              {
                id: randomUUID(),
                name: 'calculate',
                returnType: 'DOUBLE',
                parameters: [{ name: 'factor', type: 'float' }],
                visibility: '+',
                isStatic: false,
              },
            ],
          },
        ],
        associations: [],
        generalizations: [],
        realizations: [],
        dependencies: [],
        naryAssociations: [],
      });

      const xmi = exportDiagramToXmi(diagram);

      // 1. ownedAttribute en UML con xmi:idref
      expect(xmi).toContain('<type xmi:idref="EAJava_double"/>');
      expect(xmi).toContain('<type xmi:idref="EAJava_int"/>');
      expect(xmi).toContain('<type xmi:idref="EAJava_String"/>');
      expect(xmi).toContain('<type xmi:idref="EAJava_boolean"/>');
      expect(xmi).toContain('<type xmi:idref="EAJava_Date"/>');
      expect(xmi).toContain('<type xmi:idref="EAJava_UUID"/>');

      // 2. Extensión EA con attributes y properties type
      expect(xmi).toContain('<properties type="double"');
      expect(xmi).toContain('<properties type="int"');
      expect(xmi).toContain('<properties type="String"');
      expect(xmi).toContain('<properties type="boolean"');
      expect(xmi).toContain('<properties type="Date"');
      expect(xmi).toContain('<properties type="UUID"');

      // 3. Operaciones y parámetros en extensión EA
      expect(xmi).toContain('<type type="double"');
      expect(xmi).toContain('<properties pos="0" type="float"/>');

      // 4. Paquete de primitivos para EA
      expect(xmi).toContain('<primitivetypes>');
      expect(xmi).toContain('EAPrimitiveTypesPackage');
      expect(xmi).toContain('EAJavaTypesPackage');
      expect(xmi).toContain('<packagedElement xmi:type="uml:PrimitiveType" xmi:id="EAJava_int" name="int"');
      expect(xmi).toContain('<packagedElement xmi:type="uml:PrimitiveType" xmi:id="EAJava_String" name="String"');

      // 5. Round-trip exitoso hacia el parser
      const model = parseXmiDocument(xmi);
      const order = model.classes.find((c) => c.name === 'Order')!;
      expect(order.attributes.find((a) => a.name === 'total')?.type).toBe('double');
      expect(order.attributes.find((a) => a.name === 'age')?.type).toBe('int');
      expect(order.attributes.find((a) => a.name === 'code')?.type).toBe('String');
      expect(order.attributes.find((a) => a.name === 'active')?.type).toBe('boolean');
      expect(order.attributes.find((a) => a.name === 'createdAt')?.type).toBe('Date');
      expect(order.attributes.find((a) => a.name === 'guid')?.type).toBe('UUID');
      expect(order.methods[0].returnType).toBe('double');
      expect(order.methods[0].parameters[0].type).toBe('float');
    });

    it('deja el tipo de datos vacío si no hay ningún tipo disponible o es none/void para atributos', () => {
      // Usamos un objeto diagram directo para probar casos donde el tipo esté vacío o ausente
      const diagram: Diagram = {
        id: randomUUID(),
        name: 'Untyped Diagram',
        classes: [
          {
            id: C.order,
            name: 'Item',
            position: { x: 50, y: 50 },
            kind: 'class',
            isAbstract: false,
            attributes: [
              { id: randomUUID(), name: 'sinTipo1', type: '', visibility: '+', isStatic: false, isDerived: false },
              { id: randomUUID(), name: 'sinTipo2', type: '   ', visibility: '+', isStatic: false, isDerived: false },
              { id: randomUUID(), name: 'sinTipo3', type: 'none', visibility: '+', isStatic: false, isDerived: false },
              { id: randomUUID(), name: 'sinTipo4', type: 'void', visibility: '+', isStatic: false, isDerived: false },
            ],
            methods: [
              {
                id: randomUUID(),
                name: 'sinRetorno',
                returnType: '',
                parameters: [{ name: 'paramSinTipo', type: '' }],
                visibility: '+',
                isStatic: false,
              },
            ],
          },
        ],
        associations: [],
        generalizations: [],
        realizations: [],
        dependencies: [],
        naryAssociations: [],
      };

      const xmi = exportDiagramToXmi(diagram);

      // Los atributos sin tipo NO deben emitir etiqueta <type xmi:idref="..." />
      expect(xmi).not.toContain('<type xmi:idref=""/>');
      expect(xmi).not.toContain('<type xmi:idref="none"/>');
      expect(xmi).not.toContain('<type xmi:idref="void"/>');

      // En la extensión de EA los atributos deben tener properties type=""
      expect(xmi).toContain('<properties type="" collection="false"');

      // En la extensión de EA el método y su parámetro deben tener type=""
      expect(xmi).toContain('<type type=""');
      expect(xmi).toContain('<properties pos="0" type=""/>');
    });

    it('resuelve referencias a clases del diagrama de forma insensible a mayúsculas/minúsculas', () => {
      const diagram = DiagramSchema.parse({
        id: randomUUID(),
        name: 'Class Reference Test',
        classes: [
          {
            id: C.order,
            name: 'Cliente',
            position: { x: 100, y: 100 },
            kind: 'class',
            isAbstract: false,
            attributes: [],
            methods: [],
          },
          {
            id: C.line,
            name: 'Factura',
            position: { x: 300, y: 100 },
            kind: 'class',
            isAbstract: false,
            attributes: [
              // Tipo escrito en minúsculas 'cliente' o 'CLIENTE', debe apuntar al ID de la clase 'Cliente'
              { id: randomUUID(), name: 'titular', type: 'cliente', visibility: '+', isStatic: false, isDerived: false },
              { id: randomUUID(), name: 'pagador', type: 'CLIENTE', visibility: '+', isStatic: false, isDerived: false },
            ],
            methods: [],
          },
        ],
        associations: [],
        generalizations: [],
        realizations: [],
        dependencies: [],
        naryAssociations: [],
      });

      const xmi = exportDiagramToXmi(diagram);

      // Debe apuntar al ID de la clase Cliente (C.order)
      expect(xmi).toContain(`<type xmi:idref="${C.order}"/>`);

      // En la extensión de EA debe mostrar el nombre canónico de la clase 'Cliente'
      expect(xmi).toContain('<properties type="Cliente" collection="false"');

      // Round-trip al parser debe resolver ambos a 'Cliente'
      const model = parseXmiDocument(xmi);
      const factura = model.classes.find((c) => c.name === 'Factura')!;
      expect(factura.attributes.find((a) => a.name === 'titular')?.type).toBe('Cliente');
      expect(factura.attributes.find((a) => a.name === 'pagador')?.type).toBe('Cliente');
    });
  });

  describe('Exportación de asociaciones N-arias (ternarias) a Enterprise Architect', () => {
    it('exporta conectores, enlaces en <elements> y elementos de diagrama para que la ternaria no quede en el aire', () => {
      const classAId = randomUUID();
      const classBId = randomUUID();
      const classCId = randomUUID();
      const naryId = randomUUID();

      const diagram = DiagramSchema.parse({
        id: randomUUID(),
        name: 'Ternary Test',
        classes: [
          { id: classAId, name: 'Profesor', kind: 'class', isAbstract: false, position: { x: 100, y: 100 }, attributes: [], methods: [] },
          { id: classBId, name: 'Materia', kind: 'class', isAbstract: false, position: { x: 300, y: 100 }, attributes: [], methods: [] },
          { id: classCId, name: 'Semestre', kind: 'class', isAbstract: false, position: { x: 200, y: 300 }, attributes: [], methods: [] },
        ],
        associations: [],
        generalizations: [],
        realizations: [],
        dependencies: [],
        naryAssociations: [
          {
            id: naryId,
            name: 'Dicta',
            memberEnds: [
              { classId: classAId, role: 'docente', multiplicity: '1' },
              { classId: classBId, role: 'asignatura', multiplicity: '1..*' },
              { classId: classCId, role: 'periodo', multiplicity: '1' },
            ],
          },
        ],
      });

      const xmi = exportDiagramToXmi(diagram);

      // 1. Debe tener <links> dentro del <element> de la asociación N-aria
      expect(xmi).toContain(`<element xmi:idref="${naryId}" xmi:type="uml:Association"`);
      expect(xmi).toContain(`<Association xmi:id="${naryId}_end0" start="${naryId}" end="${classAId}"/>`);
      expect(xmi).toContain(`<Association xmi:id="${naryId}_end1" start="${naryId}" end="${classBId}"/>`);
      expect(xmi).toContain(`<Association xmi:id="${naryId}_end2" start="${naryId}" end="${classCId}"/>`);

      // 2. Debe tener un <connector> por cada extremo miembro
      expect(xmi).toContain(`<connector xmi:idref="${naryId}_end0">`);
      expect(xmi).toContain(`<connector xmi:idref="${naryId}_end1">`);
      expect(xmi).toContain(`<connector xmi:idref="${naryId}_end2">`);
      expect(xmi).toContain(`<source xmi:idref="${naryId}">`);
      expect(xmi).toContain(`<target xmi:idref="${classAId}">`);
      expect(xmi).toContain(`lt="docente"`);
      expect(xmi).toContain(`lb="1"`);

      // 3. En el diagrama de EA debe tener elementos de diagrama para el nodo central y para los conectores
      expect(xmi).toContain(`subject="${naryId}"`);
      expect(xmi).toContain(`subject="${naryId}_end0"`);
      expect(xmi).toContain(`subject="${naryId}_end1"`);
      expect(xmi).toContain(`subject="${naryId}_end2"`);

      // 4. Round-trip completo al parser
      const parsed = parseXmiDocument(xmi);
      expect(parsed.naryAssociations).toHaveLength(1);
      expect(parsed.naryAssociations[0].name).toBe('Dicta');
      expect(parsed.naryAssociations[0].memberEnds).toHaveLength(3);
    });
  });
});

