import { describe, it, expect } from 'vitest';
import { parseXmiDocument, xmiToDeltaBatch } from '../src/xmi21.js';
import { readFileSync } from 'fs';
import { join } from 'path';
import { BatchDeltaSchema, applyDelta, DiagramSchema } from '@app/core';

const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures', name), 'utf-8');

// Valid UUID constant for test diagramId (must pass .uuid() validation)
const TEST_DIAGRAM_ID = '00000000-0000-4000-8000-000000000000';

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
    expect(model.classes).toHaveLength(4);
    expect(model.classes[0].name).toBe('Order');
    expect(model.classes[2].kind).toBe('interface');
    expect(model.classes[2].isAbstract).toBe(true);
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

describe('XMI 2.1 real EA 6.5 export (uml:Model / packagedElement layout)', () => {
  const realFixture = () => fixture('ea-real-export.xmi');
  const classIdOf = (model: ReturnType<typeof parseXmiDocument>, name: string) =>
    model.classes.find(c => c.name === name)!.id;

  it('parses the 3 model classes from nested packagedElement traversal (15.3)', () => {
    const model = parseXmiDocument(realFixture());
    expect(model.classes.map(c => c.name)).toEqual(['Class1', 'Orden', 'Producto']);
    // All are plain classes, none abstract, in the real export
    for (const c of model.classes) {
      expect(c.kind).toBe('class');
      expect(c.isAbstract).toBe(false);
    }
  });

  it('imports Producto feature attributes only, with primitive type names resolved from xmi:Extension/primitivetypes', () => {
    const model = parseXmiDocument(realFixture());
    const producto = model.classes.find(c => c.name === 'Producto')!;
    // Exactly 3 features: the 4th ownedAttribute is an association end (has an
    // `association` attribute) and must NOT leak in as a class attribute.
    expect(producto.attributes).toHaveLength(3);
    expect(producto.attributes.map(a => a.name)).toEqual(['Descripcion', 'id', 'Nombre']);
    expect(producto.attributes.map(a => a.type)).toEqual(['string', 'int', 'String']);
    for (const a of producto.attributes) {
      expect(a.visibility).toBe('private');
    }
    // Other classes carry no attributes and no methods in this export
    expect(model.classes.find(c => c.name === 'Class1')!.attributes).toHaveLength(0);
    expect(model.classes.find(c => c.name === 'Orden')!.attributes).toHaveLength(0);
    expect(model.classes.find(c => c.name === 'Producto')!.methods).toHaveLength(0);
  });

  it('imports generalization declared as a child of the subclass (Class1 -> Orden)', () => {
    const model = parseXmiDocument(realFixture());
    expect(model.generalizations).toHaveLength(1);
    expect(model.generalizations[0].subClassId).toBe(classIdOf(model, 'Class1'));
    expect(model.generalizations[0].superClassId).toBe(classIdOf(model, 'Orden'));
  });

  it('imports Producto->Class1 composition with Producto as owner (diamond at source end, parity with hand-made ea-sample: source=whole, target=part, aggregationEnd=source; matches EA connector ea_type=Aggregation subtype=Strong source=Producto target=Class1)', () => {
    const model = parseXmiDocument(realFixture());
    const compositions = model.associations.filter(a => a.aggregation === 'composite');
    expect(compositions).toHaveLength(1);
    const comp = compositions[0];
    expect(comp.source).toBe(classIdOf(model, 'Producto'));
    expect(comp.target).toBe(classIdOf(model, 'Class1'));
    expect(comp.aggregationEnd).toBe('source');
  });

  it('imports plain association Producto—Orden with empty default names/multiplicities (PR13d parity)', () => {
    const model = parseXmiDocument(realFixture());
    const plain = model.associations.filter(a => a.aggregation === 'none');
    expect(plain).toHaveLength(2); // Producto—Orden and the Orden self-loop
    const productoOrden = plain.find(a =>
      (a.source === classIdOf(model, 'Producto') && a.target === classIdOf(model, 'Orden')) ||
      (a.source === classIdOf(model, 'Orden') && a.target === classIdOf(model, 'Producto'))
    );
    expect(productoOrden).toBeDefined();
    expect(productoOrden!.name).toBeUndefined();
    expect(productoOrden!.sourceMultiplicity).toBeUndefined();
    expect(productoOrden!.targetMultiplicity).toBeUndefined();
  });

  it('imports self-association on Orden (both member ends reference the same class)', () => {
    const model = parseXmiDocument(realFixture());
    const selfLoop = model.associations.filter(a => a.source === a.target);
    expect(selfLoop).toHaveLength(1);
    expect(selfLoop[0].source).toBe(classIdOf(model, 'Orden'));
    expect(model.associations).toHaveLength(3);
  });

  it('skips uml:Package and uml:PrimitiveType as elements; xmi:Extension does not leak into the IR (15.4, xmi:R2)', () => {
    const model = parseXmiDocument(realFixture());
    // Package1 and EAJava primitives must not appear as classes
    expect(model.classes.find(c => c.name === 'Package1')).toBeUndefined();
    expect(model.classes.find(c => c.name === 'EA_PrimitiveTypes_Package')).toBeUndefined();
    expect(model.classes.find(c => c.name === 'string')).toBeUndefined();
    expect(model.realizations).toHaveLength(0);
    expect(model.dependencies).toHaveLength(0);
    expect(model.naryAssociations).toHaveLength(0);
  });

  it('real export: batch passes BatchDeltaSchema.parse AND applies via real engine applyDelta (contract)', () => {
    const model = parseXmiDocument(realFixture());
    const batch = xmiToDeltaBatch(model, TEST_DIAGRAM_ID);

    // 1. Schema contract: every emitted delta must parse (incl. '-' visibility
    //    normalization for EA's 'private' and no undefined strict-mode keys)
    const parseResult = BatchDeltaSchema.safeParse(batch);
    expect(parseResult.success).toBe(true);

    // 2. Engine contract: batch applies atomically to an empty diagram
    const emptyDiagram = DiagramSchema.parse({
      id: TEST_DIAGRAM_ID,
      name: 'Real EA Export',
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
      const diagram = applyResult.value;
      expect(diagram.classes).toHaveLength(3);
      expect(diagram.associations).toHaveLength(3);
      expect(diagram.generalizations).toHaveLength(1);

      const producto = diagram.classes.find(c => c.name === 'Producto')!;
      // No association-end leakage after real apply: exactly 3 attributes
      expect(producto.attributes).toHaveLength(3);
      expect(producto.attributes.map(a => a.type)).toEqual(['string', 'int', 'String']);
      expect(producto.attributes.every(a => a.visibility === '-')).toBe(true);

      // Composition survived apply with Producto as the diamond (source) end
      const comp = diagram.associations.find(a => a.aggregation === 'composite')!;
      expect(comp).toBeDefined();
      const cls1 = diagram.classes.find(c => c.name === 'Class1')!;
      expect([comp.sourceClassId, comp.targetClassId]).toEqual([producto.id, cls1.id]);
      expect(comp.aggregationEnd).toBe('source');

      // Self-loop survived apply
      const orden = diagram.classes.find(c => c.name === 'Orden')!;
      expect(diagram.associations.some(a => a.sourceClassId === orden.id && a.targetClassId === orden.id)).toBe(true);

      // Grid layout contract: every class positioned, no overlaps (xmi:R3)
      const positions = diagram.classes.map(c => `${c.position.x},${c.position.y}`);
      expect(new Set(positions).size).toBe(positions.length);
    }
  });
});

describe('XMI 2.1 real EA 6.5 export #2 (interfaces, realizations, operations, association classes, n-ary)', () => {
  const f2 = () => fixture('ea-real-export2.xmi');
  const classOf = (model: ReturnType<typeof parseXmiDocument>, name: string) =>
    model.classes.find(c => c.name === name)!;

  it('parses the 9 model classifiers from the packagedElement tree, wiring uml:Interface to the interface kind with isAbstract from the uml attribute', () => {
    const model = parseXmiDocument(f2());
    // Class1, Class2, Class3, Class4, Class5 (AssociationClass box — dual
    // mapping, see its test), Orden, Producto, Interface1, jhola
    expect(model.classes.map(c => c.name)).toEqual([
      'Class1', 'Class2', 'Class3', 'Class4', 'Class5', 'Orden', 'Producto', 'Interface1', 'jhola',
    ]);
    expect(model.classes.filter(c => c.kind === 'interface').map(c => c.name)).toEqual(['Interface1', 'jhola']);
    expect(classOf(model, 'Interface1').isAbstract).toBe(true);
    expect(classOf(model, 'jhola').isAbstract).toBe(true);
    for (const n of ['Class1', 'Class2', 'Class3', 'Class4', 'Orden', 'Producto']) {
      expect(classOf(model, n).kind).toBe('class');
      expect(classOf(model, n).isAbstract).toBe(false);
    }
  });

  it('imports ownedOperation as methods: Producto.getid(hola: int): void and Producto.getProduct(): void (return ownedParameter is the returnType, not a parameter; EAJava_* idrefs resolved via primitivetypes lookup)', () => {
    const model = parseXmiDocument(f2());
    const producto = classOf(model, 'Producto');
    // Still exactly the 3 feature attributes — operations are methods, and the
    // mirrored association end stays excluded.
    expect(producto.attributes.map(a => a.name)).toEqual(['Descripcion', 'id', 'Nombre']);
    expect(producto.methods.map(m => m.name)).toEqual(['getid', 'getProduct']);

    const getid = producto.methods[0];
    expect(getid.returnType).toBe('void');
    expect(getid.visibility).toBe('public');
    expect(getid.parameters).toEqual([{ name: 'hola', type: 'int' }]);

    const getProduct = producto.methods[1];
    expect(getProduct.returnType).toBe('void');
    expect(getProduct.parameters).toEqual([]);
  });

  it('imports interface operations (jhola.carajo(): void)', () => {
    const model = parseXmiDocument(f2());
    const jhola = classOf(model, 'jhola');
    expect(jhola.methods).toHaveLength(1);
    expect(jhola.methods[0].name).toBe('carajo');
    expect(jhola.methods[0].returnType).toBe('void');
    expect(jhola.methods[0].parameters).toEqual([]);
  });

  it('imports top-level uml:Realization as Class2 realizes Interface1 (client/supplier attributes; supplier resolves to an interface classifier)', () => {
    const model = parseXmiDocument(f2());
    expect(model.realizations).toHaveLength(1);
    expect(model.realizations[0].clientId).toBe(classOf(model, 'Class2').id);
    expect(model.realizations[0].supplierId).toBe(classOf(model, 'Interface1').id);
    expect(classOf(model, 'Interface1').kind).toBe('interface');
  });

  it('routes a 3-memberEnd uml:Association to naryAssociations (Class2—Class4—Class3, per-end multiplicity 0..1 from lowerValue/upperValue)', () => {
    const model = parseXmiDocument(f2());
    expect(model.naryAssociations).toHaveLength(1);
    const nary = model.naryAssociations[0];
    const memberNames = nary.memberEnds
      .map(e => model.classes.find(c => c.id === e.classId)?.name);
    expect([...memberNames].sort()).toEqual(['Class2', 'Class3', 'Class4']);
    const endWithMult = nary.memberEnds.find(e => e.multiplicity !== undefined);
    expect(endWithMult?.multiplicity).toBe('0..1');
  });

  it('imports uml:AssociationClass Class5 as BOTH a classifier box and its Orden<->Class3 connector (SUPERSEDES round-2 "association only" simplification: fixture 3 shows another association references the AssociationClass id as an end TYPE, so a box-only-drop would silently dangle)', () => {
    const model = parseXmiDocument(f2());
    // AssociationClass is a hybrid: it is imported as a class box...
    const class5 = model.classes.find(c => c.name === 'Class5');
    expect(class5).toBeDefined();
    expect(class5!.kind).toBe('class');
    // ...AND as the binary association its memberEnds describe (Orden<->Class3).
    const ordenId = classOf(model, 'Orden').id;
    const class3Id = classOf(model, 'Class3').id;
    const asClassAssoc = model.associations.find(a =>
      (a.source === ordenId && a.target === class3Id) || (a.source === class3Id && a.target === ordenId));
    expect(asClassAssoc).toBeDefined();
    expect(asClassAssoc!.aggregation).toBe('none');
    expect(asClassAssoc!.name).toBe('Class5');
    expect(asClassAssoc!.associationClassId).toBe(class5!.id);
  });

  it('skips the dangling memberEnd-less uml:Association and the uml:TemplateBinding child without leaking IR entries (xmi:R2)', () => {
    const model = parseXmiDocument(f2());
    // Associations in the file: Producto◆Class1, Orden self-loop, Producto—Orden, Class5 assoc-class.
    // The empty EAID_91901837 association must not appear.
    expect(model.associations).toHaveLength(4);
    // TemplateBinding (Class2 ⇢ jhola) is not a dependency: no dependencies in the uml side.
    expect(model.dependencies).toHaveLength(0);
    expect(model.generalizations).toHaveLength(1); // Class1 -> Orden, unchanged from fixture 1
  });

  it('fixture2: batch passes BatchDeltaSchema.parse AND applies via real engine applyDelta with interfaces, realization, methods and n-ary all applied (contract)', () => {
    const model = parseXmiDocument(f2());
    const batch = xmiToDeltaBatch(model, TEST_DIAGRAM_ID);

    const parseResult = BatchDeltaSchema.safeParse(batch);
    expect(parseResult.success).toBe(true);

    const emptyDiagram = DiagramSchema.parse({
      id: TEST_DIAGRAM_ID,
      name: 'Real EA Export 2',
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
      const diagram = applyResult.value;
      expect(diagram.classes).toHaveLength(9); // 8 + Class5 AssociationClass box (dual mapping)
      expect(diagram.associations).toHaveLength(4);
      expect(diagram.generalizations).toHaveLength(1);
      expect(diagram.realizations).toHaveLength(1);
      expect(diagram.naryAssociations).toHaveLength(1);

      // Interfaces survived apply with the engine's interface kind
      const iface = diagram.classes.find(c => c.name === 'Interface1')!;
      expect(iface.kind).toBe('interface');
      expect(iface.isAbstract).toBe(true);
      const jhola = diagram.classes.find(c => c.name === 'jhola')!;
      expect(jhola.kind).toBe('interface');
      expect(jhola.methods).toHaveLength(1);
      expect(jhola.methods[0].name).toBe('carajo');
      // Method visibility normalized to the UML symbol on the applied model
      expect(jhola.methods[0].visibility).toBe('+');

      // Producto methods applied: getid carries its int parameter, return is the returnType
      const producto = diagram.classes.find(c => c.name === 'Producto')!;
      expect(producto.attributes).toHaveLength(3);
      expect(producto.methods.map(m => m.name)).toEqual(['getid', 'getProduct']);
      expect(producto.methods[0].parameters).toEqual([{ name: 'hola', type: 'int' }]);
      expect(producto.methods[0].returnType).toBe('void');

      // Realization applied: Class2 realizes Interface1 (engine verified the supplier is an interface)
      const class2 = diagram.classes.find(c => c.name === 'Class2')!;
      const real = diagram.realizations[0];
      expect([real.clientClassId, real.supplierInterfaceId]).toEqual([class2.id, iface.id]);

      // N-ary applied with the 0..1 per-end multiplicity preserved
      const nary = diagram.naryAssociations[0];
      const naryClassNames = nary.memberEnds
        .map(e => diagram.classes.find(c => c.id === e.classId)?.name)
        .sort();
      expect(naryClassNames).toEqual(['Class2', 'Class3', 'Class4']);
      expect(nary.memberEnds.map(e => e.multiplicity)).toContain('0..1');

      // AssociationClass connector applied: Orden—Class3 exists as a real link
      const orden = diagram.classes.find(c => c.name === 'Orden')!;
      const class3 = diagram.classes.find(c => c.name === 'Class3')!;
      expect(diagram.associations.some(a =>
        (a.sourceClassId === orden.id && a.targetClassId === class3.id) ||
        (a.sourceClassId === class3.id && a.targetClassId === orden.id))).toBe(true);

      // Grid layout contract holds for 8 nodes: all positioned, no overlaps
      const positions = diagram.classes.map(c => `${c.position.x},${c.position.y}`);
      expect(new Set(positions).size).toBe(positions.length);
    }
  });
});

describe('XMI 2.1 real EA 6.5 export #3 (dependencies, AssociationClass dual mapping, shared aggregation, end multiplicities)', () => {
  const f3 = () => fixture('ea-real-export3.xmi');
  const cls3 = (model: ReturnType<typeof parseXmiDocument>, name: string) =>
    model.classes.find(c => c.name === name)!;
  const emptyDiagram = (name: string) => DiagramSchema.parse({
    id: TEST_DIAGRAM_ID,
    name,
    classes: [],
    associations: [],
    generalizations: [],
    realizations: [],
    dependencies: [],
    naryAssociations: [],
  });

  it('parses the 11 classifiers in document order including the Class5 AssociationClass box (dual mapping: it is BOTH a class and a connector)', () => {
    const model = parseXmiDocument(f3());
    expect(model.classes.map(c => c.name)).toEqual([
      'Class1', 'Class2', 'Class3', 'Class4', 'Class5', 'Class6', 'Orden', 'Producto',
      'Interface1', 'Interface2', 'jhola',
    ]);
    expect(cls3(model, 'Class5').kind).toBe('class');
    expect(cls3(model, 'Class5').isAbstract).toBe(false);
    // Class5's memberEnds also survive as the Orden—Class3 connector
    const asConnector = model.associations.find(a => a.id === 'EAID_D368CFB2_9A61_40eb_A7D5_75369BA17450');
    expect(asConnector).toBeDefined();
    expect(asConnector!.name).toBe('Class5');
  });

  it('imports top-level uml:Dependency (client=dependent/source, supplier=depended-on/target, engine delta semantics) for Class2->Orden and Interface2->Class2, interface client allowed by the engine', () => {
    const model = parseXmiDocument(f3());
    expect(model.dependencies).toHaveLength(2);
    const byPair = model.dependencies.map(d => [
      model.classes.find(c => c.id === d.clientId)?.name,
      model.classes.find(c => c.id === d.supplierId)?.name,
    ]);
    // EAID_B80581B1: client Class2 -> supplier Orden (uml side line 19; the
    // ignored xmi:Extension connector confirms ea_type=Dependency Source->Destination)
    expect(byPair).toContainEqual(['Class2', 'Orden']);
    // EAID_EBD9C81F: client Interface2 -> supplier Class2 (uml side line 108)
    expect(byPair).toContainEqual(['Interface2', 'Class2']);
  });

  it('imports shared aggregation as shared (NOT composite, NOT none): diamond end types Producto so Producto owns, Class6 is the part', () => {
    const model = parseXmiDocument(f3());
    const shared = model.associations.filter(a => a.aggregation === 'shared');
    expect(shared).toHaveLength(1);
    expect(shared[0].source).toBe(cls3(model, 'Producto').id);
    expect(shared[0].target).toBe(cls3(model, 'Class6').id);
    expect(shared[0].aggregationEnd).toBe('source');
    // The composite from fixture 1 coexists and stays distinguishable
    const composite = model.associations.filter(a => a.aggregation === 'composite');
    expect(composite).toHaveLength(1);
    expect(composite[0].target).toBe(cls3(model, 'Class1').id);
    // and emitted deltas carry both kinds through to the schema layer
    const batch = xmiToDeltaBatch(model, TEST_DIAGRAM_ID);
    const aggDeltas = batch.deltas.filter(d => d.kind === 'association');
    expect(aggDeltas.filter(d => d.aggregation === 'shared')).toHaveLength(1);
    expect(aggDeltas.filter(d => d.aggregation === 'composite')).toHaveLength(1);
    expect(aggDeltas.filter(d => d.aggregation === 'none').length).toBeGreaterThan(0);
  });

  it('derives binary association-end multiplicities incl. LiteralUnlimitedNatural value=-1 as * (hola: Class5 end "1", Class6 end "0..*")', () => {
    const model = parseXmiDocument(f3());
    const hola = model.associations.find(a => a.name === 'hola')!;
    expect(hola.source).toBe(cls3(model, 'Class5').id); // first memberEnd (dst, 1/1 LiteralInteger)
    expect(hola.target).toBe(cls3(model, 'Class6').id); // second memberEnd (src, 0/-1 LiteralUnlimitedNatural)
    expect(hola.sourceMultiplicity).toBe('1');
    expect(hola.targetMultiplicity).toBe('0..*');

    // The batch delta must carry the multiplicities AND resolve the Class5
    // end to the AssociationClass box (this association silently vanished
    // while the box was dropped)
    const batch = xmiToDeltaBatch(model, TEST_DIAGRAM_ID);
    const holaDelta = batch.deltas.find(d => d.kind === 'association' && d.name === 'hola');
    expect(holaDelta).toBeDefined();
    expect(holaDelta!.sourceMultiplicity).toBe('1');
    expect(holaDelta!.targetMultiplicity).toBe('0..*');
  });

  it('skips the zero-memberEnd uml:Association (EAID_91901837) gracefully: no model entry, no delta, no crash', () => {
    const model = parseXmiDocument(f3());
    expect(model.associations.map(a => a.id)).not.toContain('EAID_91901837_6F7F_44b8_8A84_2ACEA32AA011');
    // exactly the six connectors with resolvable ends
    expect(model.associations).toHaveLength(6);
    const batch = xmiToDeltaBatch(model, TEST_DIAGRAM_ID);
    expect(batch.deltas.filter(d => d.kind === 'association')).toHaveLength(6);
  });

  it('operations keep in-parameters and void return through the engine Method shape (params ARE representable in @app/core and must survive apply)', () => {
    const model = parseXmiDocument(f3());
    const producto = cls3(model, 'Producto');
    expect(producto.attributes).toHaveLength(3); // both mirrored ends (dst14CC99, dst1D9ED5) stay excluded
    expect(producto.methods).toHaveLength(2);
    const getid = producto.methods.find(m => m.name === 'getid')!;
    expect(getid.parameters).toEqual([{ name: 'hola', type: 'int' }]);
    expect(getid.returnType).toBe('void');
    const getProduct = producto.methods.find(m => m.name === 'getProduct')!;
    expect(getProduct.parameters).toEqual([]);
    expect(getProduct.returnType).toBe('void');
  });

  it('n-ary keeps mixed per-end evidence: explicit 0..1 end plus defaults, and the emitter fills unspecified ends with the engine-required "1"', () => {
    const model = parseXmiDocument(f3());
    expect(model.naryAssociations).toHaveLength(1);
    const nary = model.naryAssociations[0];
    const endByClass = new Map(nary.memberEnds.map(e => [cls3(model, model.classes.find(c => c.id === e.classId)!.name).name, e.multiplicity]));
    expect([...endByClass.keys()].sort()).toEqual(['Class2', 'Class3', 'Class4']);
    expect(endByClass.get('Class3')).toBe('0..1');
    expect(endByClass.get('Class2')).toBeUndefined(); // no lowerValue/upperValue in the file
    expect(endByClass.get('Class4')).toBeUndefined();

    const batch = xmiToDeltaBatch(model, TEST_DIAGRAM_ID);
    const naryDelta = batch.deltas.find(d => d.kind === 'naryAssociation')!;
    expect(naryDelta.memberEnds).toHaveLength(3);
    const appliedMults = naryDelta.memberEnds!.map(e => e.multiplicity).sort();
    expect(appliedMults).toEqual(['0..1', '1', '1']); // unspecified ends default to '1' (engine requires a value)
  });

  it('fixture3 FULL contract: BatchDeltaSchema.parse + real applyDelta for dependencies, AssociationClass box+connector, shared, hola multiplicities, n-ary, no overlaps', () => {
    const model = parseXmiDocument(f3());
    const batch = xmiToDeltaBatch(model, TEST_DIAGRAM_ID);

    const parseResult = BatchDeltaSchema.safeParse(batch);
    expect(parseResult.success).toBe(true);

    const applyResult = applyDelta(emptyDiagram('Real EA Export 3'), batch);
    expect(applyResult.ok).toBe(true);

    if (applyResult.ok) {
      const diagram = applyResult.value;
      expect(diagram.classes).toHaveLength(11);
      expect(diagram.associations).toHaveLength(6);
      expect(diagram.generalizations).toHaveLength(1);
      expect(diagram.realizations).toHaveLength(1);
      expect(diagram.dependencies).toHaveLength(2);
      expect(diagram.naryAssociations).toHaveLength(1);

      const class5 = diagram.classes.find(c => c.name === 'Class5')!;
      const class6 = diagram.classes.find(c => c.name === 'Class6')!;
      const class2 = diagram.classes.find(c => c.name === 'Class2')!;
      const orden = diagram.classes.find(c => c.name === 'Orden')!;
      const interface2 = diagram.classes.find(c => c.name === 'Interface2')!;
      expect(interface2.kind).toBe('interface');

      // Engine accepted an INTERFACE as a dependency client (no kind gate on
      // dependency ends — unlike RealizationTargetNotInterfaceError):
      // Class2->Orden and Interface2->Class2 applied with correct directions.
      expect(diagram.dependencies.some(d => d.clientClassId === class2.id && d.supplierClassId === orden.id)).toBe(true);
      expect(diagram.dependencies.some(d => d.clientClassId === interface2.id && d.supplierClassId === class2.id)).toBe(true);

      // No IR name collision: "Class5" exists as a class box AND as a
      // distinct association label; both applied.
      const hola = diagram.associations.find(a => a.name === 'hola')!;
      expect(hola.sourceClassId).toBe(class5.id);
      expect(hola.targetClassId).toBe(class6.id);
      expect(hola.sourceMultiplicity).toBe('1');
      expect(hola.targetMultiplicity).toBe('0..*');
      const assocClassConnector = diagram.associations.find(a => a.name === 'Class5')!;
      expect(assocClassConnector).toBeDefined();

      // Shared aggregation applied as 'shared', distinct from the composite
      const shared = diagram.associations.find(a => a.aggregation === 'shared')!;
      const producto = diagram.classes.find(c => c.name === 'Producto')!;
      expect(shared.aggregationEnd).toBe('source');
      expect([shared.sourceClassId, shared.targetClassId]).toEqual([producto.id, class6.id]);
      expect(diagram.associations.some(a => a.aggregation === 'composite')).toBe(true);

      // Params survived the real apply (engine MethodSchema carries them)
      expect(producto.methods.find(m => m.name === 'getid')!.parameters).toEqual([{ name: 'hola', type: 'int' }]);

      // Grid layout: 11 unique positions
      const positions = diagram.classes.map(c => `${c.position.x},${c.position.y}`);
      expect(new Set(positions).size).toBe(positions.length);
    }
  });
});

describe('XMI 2.1 real EA 6.5 export #4 (multi-return policy, abstract real-layout class, templateBinding, out params, superset regression)', () => {
  const f4 = () => fixture('ea-real-export4.xmi');
  const cls4 = (model: ReturnType<typeof parseXmiDocument>, name: string) =>
    model.classes.find(c => c.name === name)!;

  it('RED: multiple direction="return" ownedParameters resolve by POLICY not by document last-wins (name="return" wins; else FIRST return wins; extra returns never promoted to parameters)', () => {
    // Synthetic inline XMI 2.1 (same packagedElement layout as EA exports):
    // test4.xml itself orders [hola:float, return:short], where last-wins
    // coincides with the named-wins answer, so both adversarial orderings are
    // exercised here.
    // POLICY (documented in xmi21.ts): UML allows at most one return; EA can
    // write two (user model mistake). The parameter NAMED "return" wins; with
    // no "return"-named parameter, the FIRST direction="return" parameter
    // wins; any additional return-direction parameters are dropped entirely.
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<xmi:XMI xmi:version="2.1" xmlns:uml="http://schema.omg.org/spec/UML/2.1" xmlns:xmi="http://schema.omg.org/spec/XMI/2.1">
  <uml:Model xmi:type="uml:Model" name="M">
    <packagedElement xmi:type="uml:Class" xmi:id="C1" name="Widget">
      <ownedOperation xmi:id="OP1" name="namedWinsEvenWhenFirst" visibility="public">
        <ownedParameter xmi:id="P1" name="return" direction="return" type="T_short"/>
        <ownedParameter xmi:id="P2" name="hola" direction="return" type="T_float"/>
      </ownedOperation>
      <ownedOperation xmi:id="OP2" name="firstReturnWhenNoneNamed" visibility="public">
        <ownedParameter xmi:id="P3" name="alpha" direction="return" type="T_float"/>
        <ownedParameter xmi:id="P4" name="beta" direction="return" type="T_short"/>
      </ownedOperation>
    </packagedElement>
  </uml:Model>
  <xmi:Extension extender="Enterprise Architect">
    <primitivetypes>
      <packagedElement xmi:type="uml:Package" xmi:id="TP" name="P">
        <packagedElement xmi:type="uml:PrimitiveType" xmi:id="T_short" name="short"/>
        <packagedElement xmi:type="uml:PrimitiveType" xmi:id="T_float" name="float"/>
      </packagedElement>
    </primitivetypes>
  </xmi:Extension>
</xmi:XMI>`;
    const model = parseXmiDocument(xml);
    const widget = model.classes[0];
    expect(widget.methods.map(m => m.name)).toEqual(['namedWinsEvenWhenFirst', 'firstReturnWhenNoneNamed']);
    expect(widget.methods[0].returnType).toBe('short'); // NOT float (last-wins would give float)
    expect(widget.methods[1].returnType).toBe('float'); // NOT short (last-wins would give short)
    // Return-direction parameters are never promoted into the parameter list
    expect(widget.methods[0].parameters).toEqual([]);
    expect(widget.methods[1].parameters).toEqual([]);
  });

  // ---- Characterization tests: expected to pass on the current build; they
  // pin real-export evidence for behavior the implementation already has.

  it('CHARACTERIZATION: test4 Orden.test() carries TWO return params; name="return" types as short, the stray hola:float is dropped and never becomes an in-parameter (float/short resolve from this file\'s primitivetypes block)', () => {
    const model = parseXmiDocument(f4());
    const orden = cls4(model, 'Orden');
    expect(orden.methods).toHaveLength(1);
    const test = orden.methods[0];
    expect(test.name).toBe('test');
    expect(test.returnType).toBe('short');
    expect(test.parameters).toEqual([]);
    // 'float' must not sneak in as a parameter type
    expect(JSON.stringify(test.parameters)).not.toContain('float');
  });

  it('CHARACTERIZATION: Producto isAbstract="true" in a real export — first real-path evidence of the sanctioned class-update mechanism: model flag, emitted update delta, and applied model all agree while its composition/shared/plain associations still apply', () => {
    const model = parseXmiDocument(f4());
    expect(cls4(model, 'Producto').isAbstract).toBe(true);

    const batch = xmiToDeltaBatch(model, TEST_DIAGRAM_ID);
    const productoUuid = (batch.deltas.find(d => d.kind === 'class' && d.op === 'create' && d.name === 'Producto')! as { classId: string }).classId;
    const updateDelta = batch.deltas.find(d => d.kind === 'class' && d.op === 'update' && d.classId === productoUuid);
    expect(updateDelta).toBeDefined();
    expect((updateDelta as { isAbstract?: boolean }).isAbstract).toBe(true);
    // Producto, Interface1, Interface2, jhola are the four abstract classifiers
    expect(batch.deltas.filter(d => d.kind === 'class' && d.op === 'update')).toHaveLength(4);

    const applyResult = applyDelta(DiagramSchema.parse({
      id: TEST_DIAGRAM_ID, name: 'F4 abstract Producto', classes: [], associations: [],
      generalizations: [], realizations: [], dependencies: [], naryAssociations: [],
    }), batch);
    expect(applyResult.ok).toBe(true);
    if (applyResult.ok) {
      const applied = applyResult.value.classes.find(c => c.name === 'Producto')!;
      expect(applied.isAbstract).toBe(true);
      // associations touching an abstract class apply without engine objection
      expect(applyResult.value.associations.some(a => a.sourceClassId === applied.id || a.targetClassId === applied.id)).toBe(true);
    }
  });

  it('CHARACTERIZATION: uml:TemplateBinding child of Class2 is skipped gracefully — no delta, Class2 and jhola still import', () => {
    const model = parseXmiDocument(f4());
    expect(cls4(model, 'Class2')).toBeDefined();
    expect(cls4(model, 'jhola')).toBeDefined();
    // TemplateBinding is not any modeled relation
    expect(model.dependencies.map(d => d.id)).not.toContain('EAID_7CFB86D5_5EA9_4dc1_8801_604351C5D059');
    expect(model.generalizations.map(g => g.id)).not.toContain('EAID_7CFB86D5_5EA9_4dc1_8801_604351C5D059');
    const batch = xmiToDeltaBatch(model, TEST_DIAGRAM_ID);
    // only the two real uml:Dependency edges exist as dependency deltas
    expect(batch.deltas.filter(d => d.kind === 'dependency')).toHaveLength(2);
    expect(batch.deltas.filter(d => d.kind === 'generalization')).toHaveLength(1);
  });

  it('CHARACTERIZATION: direction="out" parameter on jhola.carajo imports as a regular parameter — @app/core MethodSchema.parameters is {name,type} only, so PARAM DIRECTION IS IR-UNREPRESENTABLE and is dropped (no invented IR fields)', () => {
    const model = parseXmiDocument(f4());
    const jhola = cls4(model, 'jhola');
    expect(jhola.methods).toHaveLength(1);
    const carajo = jhola.methods[0];
    expect(carajo.returnType).toBe('void');
    // out params are carried exactly like in params (hola:int); the 'out'
    // direction itself has no IR vocabulary (MethodSchema has no direction).
    expect(carajo.parameters).toEqual([{ name: 'hola', type: 'int' }]);

    const batch = xmiToDeltaBatch(model, TEST_DIAGRAM_ID);
    const methodDelta = batch.deltas.find(d => d.kind === 'member' && d.op === 'addMethod' && d.name === 'carajo');
    expect(methodDelta).toBeDefined();
    expect((methodDelta as { parameters?: unknown }).parameters).toEqual([{ name: 'hola', type: 'int' }]);
  });

  it('fixture4 FULL contract (test3 superset regression): 11 classifiers incl. abstract Producto, 6 associations, n-ary, 2 deps, realization, hola multiplicities with Class5-as-type end, shared, self-loop, zero-end skip, all applied with unique positions', () => {
    const model = parseXmiDocument(f4());
    const batch = xmiToDeltaBatch(model, TEST_DIAGRAM_ID);

    const parseResult = BatchDeltaSchema.safeParse(batch);
    expect(parseResult.success).toBe(true);

    const applyResult = applyDelta(DiagramSchema.parse({
      id: TEST_DIAGRAM_ID, name: 'Real EA Export 4', classes: [], associations: [],
      generalizations: [], realizations: [], dependencies: [], naryAssociations: [],
    }), batch);
    expect(applyResult.ok).toBe(true);

    if (applyResult.ok) {
      const d = applyResult.value;
      // classifier inventory identical to fixture 3 plus no new boxes
      expect(d.classes.map(c => c.name).sort()).toEqual([
        'Class1', 'Class2', 'Class3', 'Class4', 'Class5', 'Class6', 'Interface1', 'Interface2', 'Orden', 'Producto', 'jhola',
      ]);
      expect(d.classes).toHaveLength(11);
      expect(d.associations).toHaveLength(6);
      expect(d.generalizations).toHaveLength(1);
      expect(d.realizations).toHaveLength(1);
      expect(d.dependencies).toHaveLength(2);
      expect(d.naryAssociations).toHaveLength(1);

      const producto = d.classes.find(c => c.name === 'Producto')!;
      const class5 = d.classes.find(c => c.name === 'Class5')!;
      const class6 = d.classes.find(c => c.name === 'Class6')!;
      const class2 = d.classes.find(c => c.name === 'Class2')!;
      const orden = d.classes.find(c => c.name === 'Orden')!;
      const interface2 = d.classes.find(c => c.name === 'Interface2')!;

      // test3 carry-overs
      expect(d.dependencies.some(x => x.clientClassId === class2.id && x.supplierClassId === orden.id)).toBe(true);
      expect(d.dependencies.some(x => x.clientClassId === interface2.id && x.supplierClassId === class2.id)).toBe(true);
      const hola = d.associations.find(a => a.name === 'hola')!;
      expect([hola.sourceClassId, hola.targetClassId]).toEqual([class5.id, class6.id]);
      expect(hola.sourceMultiplicity).toBe('1');
      expect(hola.targetMultiplicity).toBe('0..*');
      const shared = d.associations.find(a => a.aggregation === 'shared')!;
      expect([shared.sourceClassId, shared.targetClassId]).toEqual([producto.id, class6.id]);
      expect(d.associations.some(a => a.sourceClassId === orden.id && a.targetClassId === orden.id)).toBe(true);
      expect(d.naryAssociations[0].memberEnds.map(e => e.multiplicity).sort()).toEqual(['0..1', '1', '1']);
      // zero-end association absent from the IR (applied ids are remapped
      // UUIDs, so the XMI-id guard belongs at the model layer) + exactly 6
      expect(model.associations.map(a => a.id)).not.toContain('EAID_91901837_6F7F_44b8_8A84_2ACEA32AA011');

      // new fixture-4 evidence applied end-to-end
      expect(producto.isAbstract).toBe(true);
      expect(producto.attributes).toHaveLength(3);
      expect(producto.methods.map(m => m.name).sort()).toEqual(['getProduct', 'getid']);
      expect(orden.methods.find(m => m.name === 'test')!.returnType).toBe('short');
      expect(d.classes.find(c => c.name === 'jhola')!.methods.find(m => m.name === 'carajo')!.parameters).toEqual([{ name: 'hola', type: 'int' }]);

      // grid layout: 11 unique positions
      const positions = d.classes.map(c => `${c.position.x},${c.position.y}`);
      expect(new Set(positions).size).toBe(positions.length);
    }
  });
});

describe('XMI 2.1 real EA 6.5 export #5 (static members, derived attribute, protected visibility, attribute bounds, abstract operation) — CHARACTERIZATION', () => {
  const f5 = () => fixture('ea-real-export5.xmi');
  const cls5 = (model: ReturnType<typeof parseXmiDocument>, name: string) =>
    model.classes.find(c => c.name === name)!;
  const emptyDiagram5 = () => DiagramSchema.parse({
    id: TEST_DIAGRAM_ID, name: 'F5', classes: [], associations: [],
    generalizations: [], realizations: [], dependencies: [], naryAssociations: [],
  });

  it('CHARACTERIZATION: Contador imports with a static protected attribute whose attribute bounds are 3..7 (odd literal bounds must not crash; they surface as multiplicity "3..7")', () => {
    const model = parseXmiDocument(f5());
    const contador = cls5(model, 'Contador');
    const instancias = contador.attributes.find(a => a.name === 'instancias')!;
    expect(instancias.isStatic).toBe(true);
    expect(instancias.visibility).toBe('protected');
    expect(instancias.multiplicity).toBe('3..7');
    expect(instancias.type).toBe('int');
    // second static attribute (private)
    const otra = contador.attributes.find(a => a.name === 'otrainstancia')!;
    expect(otra.isStatic).toBe(true);
    expect(otra.visibility).toBe('private');
    // derived attribute flag survives
    const derivada = contador.attributes.find(a => a.name === 'derivada')!;
    expect(derivada.isDerived).toBe(true);
    expect(derivada.isStatic).toBe(false);
  });

  it('CHARACTERIZATION: first static operation (getINstancia, exact casing) imports as a method; an ABSTRACT operation (abasta) imports as a regular method because member-level isAbstract is IR-unrepresentable (MethodSchema/MemberDeltaSchema have no isAbstract field)', () => {
    const model = parseXmiDocument(f5());
    const contador = cls5(model, 'Contador');
    expect(contador.methods.map(m => m.name)).toEqual(['abasta', 'getINstancia']);
    const getInstancia = contador.methods.find(m => m.name === 'getINstancia')!;
    expect(getInstancia.isStatic).toBe(true);
    expect(getInstancia.returnType).toBe('void');
    const abasta = contador.methods.find(m => m.name === 'abasta')!;
    expect(abasta.isStatic).toBe(false); // abstract flag is dropped, never promoted to static
    expect(abasta.returnType).toBe('void');
    // and there is no isAbstract concept on the method record at all
    expect('isAbstract' in abasta).toBe(false);
  });

  it('CHARACTERIZATION: static/derived/protected flags and the 3..7 bounds survive through BatchDeltaSchema.parse AND the real applied model (create-delta level)', () => {
    const model = parseXmiDocument(f5());
    const batch = xmiToDeltaBatch(model, TEST_DIAGRAM_ID);
    expect(BatchDeltaSchema.safeParse(batch).success).toBe(true);
    const applyResult = applyDelta(emptyDiagram5(), batch);
    expect(applyResult.ok).toBe(true);
    if (applyResult.ok) {
      const contador = applyResult.value.classes.find(c => c.name === 'Contador')!;
      // attributes carry UML symbols and flags on the applied model
      const inst = contador.attributes.find(a => a.name === 'instancias')!;
      expect(inst.visibility).toBe('#');
      expect(inst.isStatic).toBe(true);
      expect(inst.multiplicity).toBe('3..7');
      const deriv = contador.attributes.find(a => a.name === 'derivada')!;
      expect(deriv.isDerived).toBe(true);
      expect(deriv.visibility).toBe('-');
      // first static METHOD in a real export reaches the applied model as static
      const getInstancia = contador.methods.find(m => m.name === 'getINstancia')!;
      expect(getInstancia.isStatic).toBe(true);
      // abstract op came through as an ordinary (non-static) void method
      const abasta = contador.methods.find(m => m.name === 'abasta')!;
      expect(abasta.isStatic).toBe(false);
      expect(abasta.returnType).toBe('void');
      // whole-file contract integrity for the test4 superset + Contador
      expect(applyResult.value.classes).toHaveLength(12);
      expect(applyResult.value.associations).toHaveLength(6);
      expect(applyResult.value.dependencies).toHaveLength(2);
      expect(applyResult.value.naryAssociations).toHaveLength(1);
      expect(applyResult.value.realizations).toHaveLength(1);
      expect(applyResult.value.generalizations).toHaveLength(1);
      // Producto abstract (from fixture 4) still applies
      expect(applyResult.value.classes.find(c => c.name === 'Producto')!.isAbstract).toBe(true);
    }
  });
});

describe('XMI 2.1 real EA 6.5 export #6 (duplicate class name across sibling packages — closest-representation policy)', () => {
  const f6 = () => fixture('ea-real-export6.xmi');

  it('EVIDENCE-FIRST: recursive descent finds BOTH Orden classes under Package2/PackageA and Package2/PackageB with distinct xmi:ids', () => {
    const model = parseXmiDocument(f6());
    expect(model.classes).toHaveLength(2);
    expect(model.classes.map(c => c.id).every(id => id.startsWith('EAID_'))).toBe(true);
    // two distinct ids, both originally named Orden (pre-policy bare names would collide)
    expect(new Set(model.classes.map(c => c.id)).size).toBe(2);
  });

  it('disambiguates colliding class names with the minimal package path so the batch is NOT rejected (user directive: never crash/reject the whole batch; import the closest other thing)', () => {
    const model = parseXmiDocument(f6());
    const batch = xmiToDeltaBatch(model, TEST_DIAGRAM_ID);

    // 1. schema-valid
    expect(BatchDeltaSchema.safeParse(batch).success).toBe(true);

    // 2. THE KEY ASSERTION: real applyDelta must succeed. Before the fix this
    //    returned BatchError{DuplicateClassError, failedDeltaIndex:1} because
    //    apply gates on class NAME (apply.ts:94 isDuplicateClassName), so the
    //    two bare "Orden" creates collided and the whole batch was rejected.
    const applyResult = applyDelta(DiagramSchema.parse({
      id: TEST_DIAGRAM_ID, name: 'F6', classes: [], associations: [],
      generalizations: [], realizations: [], dependencies: [], naryAssociations: [],
    }), batch);
    expect(applyResult.ok).toBe(true);

    if (applyResult.ok) {
      expect(applyResult.value.classes).toHaveLength(2);
      const names = applyResult.value.classes.map(c => c.name);
      // distinct, qualified by the disambiguating package segment (minimal path)
      expect(new Set(names).size).toBe(2);
      expect(names).toContain('PackageA::Orden');
      expect(names).toContain('PackageB::Orden');
      // distinct ids preserved (identity never merged)
      const ids = applyResult.value.classes.map(c => c.id);
      expect(new Set(ids).size).toBe(2);
    }
  });

  it('non-colliding exports keep bare names untouched (policy applies only on an actual collision)', () => {
    // fixture 1 has Orden/Producto/Class1 with no duplicates — must be unchanged
    const model = parseXmiDocument(fixture('ea-real-export.xmi'));
    expect(model.classes.map(c => c.name)).toEqual(['Class1', 'Orden', 'Producto']);
    // and the multi-package-but-unique fixture 5 keeps its bare Contador
    const m5 = parseXmiDocument(fixture('ea-real-export5.xmi'));
    expect(m5.classes.map(c => c.name)).toContain('Contador');
    expect(m5.classes.map(c => c.name)).not.toContain('Package1::Contador');
  });
});

describe('xmiToDeltaBatch', () => {
  it('converts model to batch delta (15.3)', () => {
    const xml = fixture('ea-sample.xmi');
    const model = parseXmiDocument(xml);
    const batch = xmiToDeltaBatch(model, TEST_DIAGRAM_ID);
    expect(batch.kind).toBe('batch');
    expect(batch.diagramId).toBe(TEST_DIAGRAM_ID);
    expect(batch.deltas.length).toBeGreaterThan(5);
    // Semantic adaptation: abstract marking now travels as a follow-up class
    // `update` delta (engine unit 12.4), so the create count is asserted on
    // op=create; total class-kind deltas for this fixture are 5 (4 creates + 1 update).
    const classDeltas = batch.deltas.filter(d => d.kind === 'class' && d.op === 'create');
    expect(classDeltas.length).toBe(4);
    const classUpdateDeltas = batch.deltas.filter(d => d.kind === 'class' && d.op === 'update');
    expect(classUpdateDeltas).toHaveLength(1);
    const attrDeltas = batch.deltas.filter(d => d.kind === 'member' && d.op === 'addAttribute');
    expect(attrDeltas.length).toBe(4);
    const methodDeltas = batch.deltas.filter(d => d.kind === 'member' && d.op === 'addMethod');
    expect(methodDeltas.length).toBe(2);
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

  it('emits schema-valid batch that applies atomically to empty diagram (contract test)', () => {
    const xml = fixture('ea-sample.xmi');
    const model = parseXmiDocument(xml);
    const batch = xmiToDeltaBatch(model, TEST_DIAGRAM_ID);

    // 1. Batch must pass schema validation
    const parseResult = BatchDeltaSchema.safeParse(batch);
    expect(parseResult.success).toBe(true);

    // 2. Apply to empty diagram must succeed
    const emptyDiagram = DiagramSchema.parse({
      id: TEST_DIAGRAM_ID,
      name: 'Test',
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
      const diagram = applyResult.value;
      // At least 2 classes imported
      expect(diagram.classes.length).toBeGreaterThanOrEqual(2);

      // Every class has a position
      for (const cls of diagram.classes) {
        expect(cls.position).toBeDefined();
        expect(typeof cls.position.x).toBe('number');
        expect(typeof cls.position.y).toBe('number');
      }

      // No two class positions are equal (overlap guard for xmi:R3)
      const positions = diagram.classes.map(c => `${c.position.x},${c.position.y}`);
      const uniquePositions = new Set(positions);
      expect(uniquePositions.size).toBe(positions.length);
    }
  });

  describe('Importación flexible de contenedores XMI 2.1 (soporte para exportaciones de paquetes de EA)', () => {
    it('soporta <uml:Package> como contenedor raíz bajo <xmi:XMI>', () => {
      const xml = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<xmi:XMI xmi:version="2.1" xmlns:uml="http://schema.omg.org/spec/UML/2.1" xmlns:xmi="http://schema.omg.org/spec/XMI/2.1">',
        '  <uml:Package xmi:type="uml:Package" xmi:id="EAPK_001" name="ModeloClases">',
        '    <packagedElement xmi:type="uml:Class" xmi:id="EAID_CLS1" name="Usuario"/>',
        '    <packagedElement xmi:type="uml:Class" xmi:id="EAID_CLS2" name="Rol"/>',
        '  </uml:Package>',
        '</xmi:XMI>',
      ].join('\n');

      const model = parseXmiDocument(xml);
      expect(model.classes.map(c => c.name).sort()).toEqual(['Rol', 'Usuario']);
    });

    it('soporta múltiples contenedores <uml:Package> o <uml:Model> como arreglo', () => {
      const xml = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<xmi:XMI xmi:version="2.1" xmlns:uml="http://schema.omg.org/spec/UML/2.1" xmlns:xmi="http://schema.omg.org/spec/XMI/2.1">',
        '  <uml:Package xmi:type="uml:Package" xmi:id="EAPK_001" name="ModuloA">',
        '    <packagedElement xmi:type="uml:Class" xmi:id="EAID_CLS1" name="Servicio"/>',
        '  </uml:Package>',
        '  <uml:Package xmi:type="uml:Package" xmi:id="EAPK_002" name="ModuloB">',
        '    <packagedElement xmi:type="uml:Class" xmi:id="EAID_CLS2" name="Repositorio"/>',
        '  </uml:Package>',
        '</xmi:XMI>',
      ].join('\n');

      const model = parseXmiDocument(xml);
      expect(model.classes.map(c => c.name).sort()).toEqual(['Repositorio', 'Servicio']);
    });

    it('soporta xsi:type="uml:Class" y tipos sin prefijo xmi:type="Class"', () => {
      const xml = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<xmi:XMI xmi:version="2.1" xmlns:uml="http://schema.omg.org/spec/UML/2.1" xmlns:xmi="http://schema.omg.org/spec/XMI/2.1" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">',
        '  <uml:Model xmi:type="uml:Model" xmi:id="MOD_1" name="Model">',
        '    <packagedElement xsi:type="uml:Class" xmi:id="C1" name="EntidadA"/>',
        '    <packagedElement xmi:type="Class" xmi:id="C2" name="EntidadB"/>',
        '  </uml:Model>',
        '</xmi:XMI>',
      ].join('\n');

      const model = parseXmiDocument(xml);
      expect(model.classes.map(c => c.name).sort()).toEqual(['EntidadA', 'EntidadB']);
    });

    it('soporta elementos dentro de <ownedMember> y etiquetas directas <uml:Class>', () => {
      const xml = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<xmi:XMI xmi:version="2.1" xmlns:uml="http://schema.omg.org/spec/UML/2.1" xmlns:xmi="http://schema.omg.org/spec/XMI/2.1">',
        '  <uml:Package xmi:type="uml:Package" xmi:id="PKG_1" name="RootPkg">',
        '    <ownedMember xmi:type="uml:Class" xmi:id="C1" name="Producto"/>',
        '    <uml:Class xmi:id="C2" name="Factura"/>',
        '  </uml:Package>',
        '</xmi:XMI>',
      ].join('\n');

      const model = parseXmiDocument(xml);
      expect(model.classes.map(c => c.name).sort()).toEqual(['Factura', 'Producto']);
    });

    it('promueve el destino de una realización a interfaz para evitar RealizationTargetNotInterfaceError en el lote', () => {
      const xml = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<xmi:XMI xmi:version="2.1" xmlns:uml="http://schema.omg.org/spec/UML/2.1" xmlns:xmi="http://schema.omg.org/spec/XMI/2.1">',
        '  <uml:Package xmi:type="uml:Package" xmi:id="PKG_1" name="RootPkg">',
        '    <packagedElement xmi:type="uml:Class" xmi:id="C1" name="ServicioImp"/>',
        '    <packagedElement xmi:type="uml:Class" xmi:id="C2" name="ServicioInterface"/>',
        '    <packagedElement xmi:type="uml:Realization" xmi:id="R1" client="C1" supplier="C2"/>',
        '  </uml:Package>',
        '</xmi:XMI>',
      ].join('\n');

      const model = parseXmiDocument(xml);
      const batch = xmiToDeltaBatch(model, TEST_DIAGRAM_ID);
      const emptyDiagram = DiagramSchema.parse({
        id: TEST_DIAGRAM_ID,
        name: 'Target',
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
        const iface = result.value.classes.find(c => c.name === 'ServicioInterface')!;
        expect(iface.kind).toBe('interface');
        expect(result.value.realizations).toHaveLength(1);
      }
    });

    it('diferencia asociaciones múltiples sin nombre entre el mismo par para evitar DuplicateAssociationError', () => {
      const xml = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<xmi:XMI xmi:version="2.1" xmlns:uml="http://schema.omg.org/spec/UML/2.1" xmlns:xmi="http://schema.omg.org/spec/XMI/2.1">',
        '  <uml:Package xmi:type="uml:Package" xmi:id="PKG_1" name="RootPkg">',
        '    <packagedElement xmi:type="uml:Class" xmi:id="C1" name="Cliente"/>',
        '    <packagedElement xmi:type="uml:Class" xmi:id="C2" name="Pedido"/>',
        '    <packagedElement xmi:type="uml:Association" xmi:id="A1">',
        '      <memberEnd xmi:idref="E1"/><memberEnd xmi:idref="E2"/>',
        '      <ownedEnd xmi:id="E1"><type xmi:idref="C1"/></ownedEnd>',
        '      <ownedEnd xmi:id="E2"><type xmi:idref="C2"/></ownedEnd>',
        '    </packagedElement>',
        '    <packagedElement xmi:type="uml:Association" xmi:id="A2">',
        '      <memberEnd xmi:idref="E3"/><memberEnd xmi:idref="E4"/>',
        '      <ownedEnd xmi:id="E3"><type xmi:idref="C1"/></ownedEnd>',
        '      <ownedEnd xmi:id="E4"><type xmi:idref="C2"/></ownedEnd>',
        '    </packagedElement>',
        '  </uml:Package>',
        '</xmi:XMI>',
      ].join('\n');

      const model = parseXmiDocument(xml);
      const batch = xmiToDeltaBatch(model, TEST_DIAGRAM_ID);
      const emptyDiagram = DiagramSchema.parse({
        id: TEST_DIAGRAM_ID,
        name: 'Target',
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
        expect(result.value.associations).toHaveLength(2);
      }
    });
  });
});