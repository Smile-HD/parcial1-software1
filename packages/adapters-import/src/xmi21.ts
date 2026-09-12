import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { randomUUID } from 'crypto';
import { gridLayout } from './xmi21-layout.js';
import type { Delta, BatchDelta, ClassDelta, MemberDelta, AssociationDelta, GeneralizationDelta, RealizationDelta, DependencyDelta, NaryAssociationDelta } from '@app/core';

export type XmiModel = {
  classes: Array<{
    id: string;
    name: string;
    kind: 'class' | 'interface';
    isAbstract: boolean;
    attributes: Array<{ name: string; type: string; visibility: string; isStatic: boolean; isDerived: boolean; multiplicity?: string }>;
    methods: Array<{ name: string; returnType: string; visibility: string; isStatic: boolean; parameters?: Array<{ name: string; type: string }> }>;
  }>;
  associations: Array<{
    id: string;
    source: string;
    target: string;
    aggregation: 'none' | 'shared' | 'composite';
    aggregationEnd: 'source' | 'target';
    name?: string;
    sourceRole?: string;
    targetRole?: string;
    sourceMultiplicity?: string;
    targetMultiplicity?: string;
  }>;
  generalizations: Array<{
    id: string;
    subClassId: string;
    superClassId: string;
  }>;
  realizations: Array<{
    id: string;
    clientId: string;
    supplierId: string;
  }>;
  dependencies: Array<{
    id: string;
    clientId: string;
    supplierId: string;
  }>;
  naryAssociations: Array<{
    id: string;
    memberEnds: Array<{ classId: string; multiplicity?: string; role?: string }>;
    name?: string;
  }>;
};

const VERSION_PATTERN = /^2\.1/i;

/** Coerce a fast-xml-parser child (single object, array, or missing) to an array. */
function toArray<T>(value: T | T[] | undefined): T[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * Normalize UML visibility: XMI 2.1 exports use the semantic words
 * ("private", "public", "protected", "package"); the engine schema uses the
 * UML 2.5.1 symbols ('-', '+', '#', '~'). Symbols pass through unchanged so
 * the hand-made UML-1.x-style layout keeps working.
 */
function normalizeVisibility(visibility: string | undefined): '+' | '-' | '#' | '~' {
  switch (visibility) {
    case 'private': return '-';
    case 'protected': return '#';
    case 'package': return '~';
    case 'public': return '+';
    case '+': case '-': case '#': case '~': return visibility;
    default: return '+';
  }
}

/**
 * Disambiguate classifier names that collide across packages (fixture 6
 * evidence: EA allows `PackageA::Orden` and `PackageB::Orden`, and the engine
 * gates class creation on NAME — apply.ts isDuplicateClassName — so two bare
 * duplicates make the engine REJECT THE WHOLE BATCH atomically).
 *
 * Policy (user directive: "do not crash and never reject the whole batch —
 * import it as the closest other thing"): only names in an actual collision
 * group are renamed, qualifying with the MINIMAL tail of the package chain
 * that makes them unique (PackageA::Orden / PackageB::Orden — matching the
 * user's example; the common root segment Package2 is not needed). If the
 * full chain still collides (identical paths — EA shouldn't emit it, but we
 * never reject), a numeric suffix keeps every name unique. Non-colliding
 * exports keep bare names: all previous fixtures are untouched.
 */
function disambiguateClassifierNames(model: XmiModel, chains: string[][]): void {
  const groups = new Map<string, number[]>();
  model.classes.forEach((c, i) => {
    const idxs = groups.get(c.name);
    if (idxs) idxs.push(i); else groups.set(c.name, [i]);
  });

  for (const [name, idxs] of groups) {
    if (idxs.length < 2) continue;
    const maxDepth = Math.max(0, ...idxs.map(i => (chains[i] ?? []).length));
    let resolved: string[] | undefined;
    for (let depth = 1; depth <= maxDepth + 1; depth++) {
      const qualified = idxs.map(i => {
        const chain = chains[i] ?? [];
        const suffix = chain.slice(Math.max(0, chain.length - depth));
        return suffix.length ? `${suffix.join('::')}::${name}` : name;
      });
      if (new Set(qualified).size === idxs.length) {
        resolved = qualified;
        break;
      }
    }
    if (!resolved) {
      // Full chain still collides: keep the deepest qualification and append
      // numeric suffixes so the batch applies (closest-representation wins
      // over rejection).
      const base = idxs.map(i => {
        const chain = chains[i] ?? [];
        return chain.length ? `${chain.join('::')}::${name}` : name;
      });
      resolved = base.map((n, k) => (k === 0 ? n : `${n} (${k + 1})`));
    }
    idxs.forEach((classIdx, k) => {
      model.classes[classIdx]!.name = resolved![k]!;
    });
  }
}

function parseXmiDocument(xml: string): XmiModel {
  const validation = XMLValidator.validate(xml, { allowBooleanAttributes: false });
  if (validation !== true) {
    throw new Error(`XMI parse error: ${(validation as { err: { msg: string } }).err.msg}`);
  }
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
  let parsed: any;
  try {
    parsed = parser.parse(xml);
  } catch (e) {
    throw new Error('XMI parse error: malformed XML');
  }

  const model: XmiModel = {
    classes: [],
    associations: [],
    generalizations: [],
    realizations: [],
    dependencies: [],
    naryAssociations: [],
  };

  // Layout detection: real XMI 2.1 wraps everything in <xmi:XMI> and stores
  // model content as <uml:Model>/<packagedElement>; the hand-made EA-style
  // fixture uses <UML:Model> with direct UML:Class children. Support BOTH.
  const xmiRoot = parsed?.['xmi:XMI'];
  const legacyRoot = xmiRoot ? undefined : (parsed?.['UML:Model'] || parsed?.Model || parsed);
  if (!xmiRoot && !legacyRoot) throw new Error('XMI parse error: no UML:Model root');

  const versionSource = xmiRoot ?? legacyRoot;
  const version = versionSource['@_xmi:version'] || versionSource['@_version'] || '';
  if (!VERSION_PATTERN.test(version)) {
    throw new Error(`Unsupported XMI version: ${version || 'unknown'}; supported: 2.1`);
  }

  if (xmiRoot) {
    parseRealXmi21(xmiRoot, model);
    return model;
  }

  const root = legacyRoot;
  const elements = root['UML:Class'] || [];
  const assocs = root['UML:Association'] || [];
  const gens = root['UML:Generalization'] || [];
  const reals = root['UML:Realization'] || [];
  const deps = root['UML:Dependency'] || [];

  // Classes
  (Array.isArray(elements) ? elements : [elements]).forEach((el: any) => {
    const name = el['@_name'] || 'Unnamed';
    const id = el['@_id'] || randomUUID();
    const kind = el['@_kind'] === 'interface' ? 'interface' : 'class';
    const isAbstract = el['@_isAbstract'] === 'true';
    const classAttrs: any[] = [];
    const classMethods: any[] = [];

    (Array.isArray(el['UML:Attribute']) ? el['UML:Attribute'] : el['UML:Attribute'] ? [el['UML:Attribute']] : []).forEach((a: any) => {
      const visibility = a['@_visibility'] || '+';
      const isStatic = a['@_isStatic'] === 'true';
      const isDerived = a['@_isDerived'] === 'true';
      const mult = a['@_multiplicity'] || undefined;
      classAttrs.push({
        name: a['@_name'] || '',
        type: a['@_type'] || 'String',
        visibility,
        isStatic,
        isDerived,
        multiplicity: mult,
      });
    });

    (Array.isArray(el['UML:Operation']) ? el['UML:Operation'] : el['UML:Operation'] ? [el['UML:Operation']] : []).forEach((m: any) => {
      const visibility = m['@_visibility'] || '+';
      const isStatic = m['@_isStatic'] === 'true';
      const params = (Array.isArray(m['UML:Parameter']) ? m['UML:Parameter'] : m['UML:Parameter'] ? [m['UML:Parameter']] : []).map((p: any) => ({
        name: p['@_name'] || '',
        type: p['@_type'] || 'String',
      }));
      classMethods.push({
        name: m['@_name'] || '',
        returnType: m['@_type'] || 'void',
        visibility,
        isStatic,
        parameters: params,
      });
    });

    model.classes.push({ id, name, kind, isAbstract, attributes: classAttrs, methods: classMethods });
  });

  // Associations
  (Array.isArray(assocs) ? assocs : [assocs]).forEach((a: any) => {
    const id = a['@_id'] || randomUUID();
    const name = a['@_name'] || undefined;
    const ends = a['UML:AssociationEnd'] || [];
    const endList = Array.isArray(ends) ? ends : [ends];
    if (endList.length < 2) return;
    const source = endList[0]['@_class'] || '';
    const target = endList[1]['@_class'] || '';
    const agg = endList[0]['@_aggregation'] || endList[1]['@_aggregation'] || 'none';
    const aggregation = agg === 'composite' ? 'composite' : agg === 'shared' ? 'shared' : 'none';
    const aggregationEnd = endList[0]['@_aggregation'] ? 'source' : 'target';
    const sourceMultiplicity = endList[0]['@_multiplicity'] || undefined;
    const targetMultiplicity = endList[1]['@_multiplicity'] || undefined;
    const sourceRole = endList[0]['@_role'] || undefined;
    const targetRole = endList[1]['@_role'] || undefined;
    model.associations.push({
      id,
      source,
      target,
      aggregation,
      aggregationEnd,
      name,
      sourceRole,
      targetRole,
      sourceMultiplicity,
      targetMultiplicity,
    });
  });

  // Generalizations
  (Array.isArray(gens) ? gens : [gens]).forEach((g: any) => {
    const id = g['@_id'] || randomUUID();
    const sub = g['@_child'] || '';
    const sup = g['@_parent'] || '';
    if (sub && sup) model.generalizations.push({ id, subClassId: sub, superClassId: sup });
  });

  // Realizations
  (Array.isArray(reals) ? reals : [reals]).forEach((r: any) => {
    const id = r['@_id'] || randomUUID();
    const client = r['@_client'] || '';
    const supplier = r['@_supplier'] || '';
    if (client && supplier) model.realizations.push({ id, clientId: client, supplierId: supplier });
  });

  // Dependencies
  (Array.isArray(deps) ? deps : [deps]).forEach((d: any) => {
    const id = d['@_id'] || randomUUID();
    const client = d['@_client'] || '';
    const supplier = d['@_supplier'] || '';
    if (client && supplier) model.dependencies.push({ id, clientId: client, supplierId: supplier });
  });

  // N-ary (if present)
  const naries = root['UML:NaryAssociation'] || [];
  (Array.isArray(naries) ? naries : [naries]).forEach((n: any) => {
    const id = n['@_id'] || randomUUID();
    const name = n['@_name'] || undefined;
    const ends = n['UML:AssociationEnd'] || [];
    const endList = Array.isArray(ends) ? ends : [ends];
    if (endList.length < 3) return;
    const memberEnds = endList.map((e: any) => ({
      classId: e['@_class'] || '',
      multiplicity: e['@_multiplicity'] || undefined,
      role: e['@_role'] || undefined,
    }));
    if (memberEnds.every(m => m.classId)) {
      model.naryAssociations.push({ id, memberEnds, name });
    }
  });

  // Same never-reject policy for the hand-made layout; no package chains are
  // known here, so an actual collision (none exists in any fixture) would
  // fall through to the numeric-suffix guard rather than be rejected.
  disambiguateClassifierNames(model, model.classes.map(() => []));

  return model;
}

/**
 * Parse a REAL XMI 2.1 document (Enterprise Architect 6.5 layout):
 * <xmi:XMI> → <uml:Model> → <packagedElement xmi:type="uml:Class|uml:Package|uml:Association">
 * with arbitrary package nesting. Element kind comes from the `xmi:type`
 * attribute, never from the tag name.
 *
 * Strictness rules (spec xmi:R2 / 15.4 / 15.5):
 * - Nothing from <xmi:Extension> leaks into the IR. The ONLY permitted use is
 *   the <primitivetypes> subtree as an id→name lookup table (to resolve
 *   `xmi:idref="EAJava_string"` into type "string").
 * - EA diagram geometry is ignored: grid layout owns positions downstream.
 */
function parseRealXmi21(xmiRoot: any, model: XmiModel): void {
  const umlModel = xmiRoot?.['uml:Model'];

  // ---- Pass 1: recursive package descent. Collect class/interface,
  // association and realization raw nodes in document order; uml:Package is
  // transparent (recurse through), uml:PrimitiveType is skipped as an element.
  // uml:AssociationClass is imported with a DUAL MAPPING (round-3 policy,
  // evidence-driven): as a classifier BOX (class node) AND as the connector
  // its memberEnds describe. Round 2 dropped the box, but fixture 3 proves
  // real models reference the AssociationClass id as an association-end TYPE
  // (association "hola" types Class5), and a missing box would make those
  // ends dangle and silently vanish at delta-emit time.
  const classNodes: any[] = [];
  // Package ancestry per class node (index-aligned with classNodes), used by
  // the collision-disambiguation policy below.
  const classNodeChains: string[][] = [];
  const associationNodes: any[] = [];
  const realizationNodes: any[] = [];
  const dependencyNodes: any[] = [];

  const walkPackaged = (container: any, chain: string[]) => {
    for (const el of toArray(container?.['packagedElement'])) {
      const type = el['@_xmi:type'];
      if (type === 'uml:Package') {
        walkPackaged(el, [...chain, el['@_name'] || '']);
      } else if (type === 'uml:Class' || type === 'uml:Interface') {
        classNodes.push(el);
        classNodeChains.push(chain);
      } else if (type === 'uml:Association' || type === 'uml:AssociationClass') {
        associationNodes.push(el);
        if (type === 'uml:AssociationClass') {
          // Dual mapping: the same node is also a class box (see comment).
          classNodes.push(el);
          classNodeChains.push(chain);
        }
      } else if (type === 'uml:Realization') {
        realizationNodes.push(el);
      } else if (type === 'uml:Dependency') {
        dependencyNodes.push(el);
      }
      // uml:PrimitiveType (index-only), uml:Abstraction and any other
      // xmi:type is skipped as an element (unknown xmi:Extension-style
      // content is tolerated, never imported).
    }
  };
  walkPackaged(umlModel, []);

  // ---- id→name index (classes from the model + primitives from
  // xmi:Extension/primitivetypes ONLY) used to resolve `<type xmi:idref>`.
  const nameIndex = new Map<string, string>();
  for (const c of classNodes) {
    if (c['@_xmi:id'] && c['@_name']) nameIndex.set(c['@_xmi:id'], c['@_name']);
  }
  const indexPrimitiveTypes = (container: any) => {
    for (const el of toArray(container?.['packagedElement'])) {
      if (el['@_xmi:id'] && el['@_name']) nameIndex.set(el['@_xmi:id'], el['@_name']);
      indexPrimitiveTypes(el); // nested primitive-type packages
    }
  };
  indexPrimitiveTypes(xmiRoot?.['xmi:Extension']?.['primitivetypes']);

  const resolveType = (idref: string | undefined): string | undefined =>
    idref ? (nameIndex.get(idref) ?? idref) : undefined;

  // ---- Pass 2: build classes (features + child generalizations) and a
  // global property index (association-owned `ownedEnd`s and class-mirrored
  // `ownedAttribute`s are the SAME UML Properties, addressable by xmi:id).
  type EndProp = { type: string | undefined; aggregation: string | undefined; lower: string | undefined; upper: string | undefined; name: string | undefined };
  const propertyIndex = new Map<string, EndProp>();
  const memberEndRefs = new Set<string>();
  const readProp = (el: any): EndProp => ({
    type: el?.['type']?.['@_xmi:idref'],
    aggregation: el?.['@_aggregation'],
    lower: el?.['lowerValue']?.['@_value'],
    upper: el?.['upperValue']?.['@_value'],
    name: el?.['@_name'],
  });

  for (const assoc of associationNodes) {
    for (const end of toArray(assoc['ownedEnd'])) {
      if (end['@_xmi:id']) propertyIndex.set(end['@_xmi:id'], readProp(end));
    }
    for (const me of toArray(assoc['memberEnd'])) {
      const ref = me?.['@_xmi:idref'];
      if (ref) memberEndRefs.add(ref);
    }
  }

  for (const el of classNodes) {
    const id = el['@_xmi:id'] || randomUUID();
    const classAttrs: XmiModel['classes'][number]['attributes'] = [];
    const classMethods: XmiModel['classes'][number]['methods'] = [];

    for (const attr of toArray(el['ownedAttribute'])) {
      const attrId = attr['@_xmi:id'];
      // Register EVERY end property (mirrored association ends included) in
      // the index so associations can resolve them later.
      if (attrId) propertyIndex.set(attrId, readProp(attr));

      // Association end vs feature attribute: an ownedAttribute that declares
      // an `association` owner (or whose id is referenced by some Association's
      // memberEnd) is a relation end, NOT a feature — never import it as an
      // attribute (avoids Producto leaking a 4th phantom attribute).
      const isRelationEnd = Boolean(attr['@_association']) || Boolean(attrId && memberEndRefs.has(attrId));
      if (isRelationEnd) continue;

      // XMI 2.1 stores the feature type as a child reference, not an attribute.
      const typeId = resolveType(attr['type']?.['@_xmi:idref']);
      // lower/upper LiteralIntegers → UML multiplicity string (1/1 → "1").
      const lower = attr['lowerValue']?.['@_value'];
      const upper = attr['upperValue']?.['@_value'];
      let multiplicity: string | undefined;
      if (lower !== undefined || upper !== undefined) {
        const l = lower ?? '1';
        const u = upper ?? '1';
        multiplicity = (l === u && l !== '-1') ? l : `${l === '-1' ? '*' : l}..${u === '-1' ? '*' : u}`;
      }

      classAttrs.push({
        name: attr['@_name'] || '',
        type: typeId || attr['@_type'] || 'String',
        visibility: attr['@_visibility'] || '+',
        isStatic: attr['@_isStatic'] === 'true',
        isDerived: attr['@_isDerived'] === 'true',
        ...(multiplicity !== undefined ? { multiplicity } : {}),
      });
    }

    // ownedOperation → methods. In EA 6.5 exports each operation's parameters
    // are `ownedParameter` children whose type is an ATTRIBUTE idref
    // (type="EAJava_int"), and the return "parameter" (direction="return")
    // is the returnType — it must never leak into the parameter list.
    //
    // MULTI-RETURN POLICY (test4 evidence: Orden.test() declares TWO
    // direction="return" parameters, which UML forbids — a user model mistake
    // EA persists anyway): the parameter NAMED "return" wins as returnType;
    // if none is named "return", the FIRST direction="return" parameter wins;
    // every additional return-direction parameter is ignored (never promoted
    // to an in-parameter).
    for (const op of toArray(el['ownedOperation'])) {
      let namedReturnType: string | undefined;
      let firstReturnType: string | undefined;
      const parameters: Array<{ name: string; type: string }> = [];
      for (const p of toArray(op['ownedParameter'])) {
        // The type idref sits on the @_type attribute here (not a <type> child).
        const resolved = resolveType(p['@_type']);
        if (p['@_direction'] === 'return') {
          if (p['@_name'] === 'return') {
            if (namedReturnType === undefined && resolved) namedReturnType = resolved;
          } else if (firstReturnType === undefined && resolved) {
            firstReturnType = resolved;
          }
          continue;
        }
        if (p['@_name'] && resolved) {
          parameters.push({ name: p['@_name'], type: resolved });
        }
      }
      const returnType = namedReturnType ?? firstReturnType ?? 'void';
      classMethods.push({
        name: op['@_name'] || '',
        returnType,
        visibility: op['@_visibility'] || '+',
        isStatic: op['@_isStatic'] === 'true',
        parameters,
      });
    }

    model.classes.push({
      id,
      name: el['@_name'] || 'Unnamed',
      // Engine kind is carried by xmi:type, never by the tag name.
      kind: el['@_xmi:type'] === 'uml:Interface' ? 'interface' : 'class',
      isAbstract: el['@_isAbstract'] === 'true',
      attributes: classAttrs,
      methods: classMethods,
    });

    // Generalization is a CHILD of the subclass in XMI 2.1:
    // <generalization xmi:type="uml:Generalization" general="SUPER_ID"/>
    // inside the subclass. So: subClassId = this class, superClassId = @general.
    for (const g of toArray(el['generalization'])) {
      const sup = g['@_general'];
      if (sup) {
        model.generalizations.push({ id: g['@_xmi:id'] || randomUUID(), subClassId: id, superClassId: sup });
      }
    }
  }

  // ---- Pass 3: associations. Resolve each memberEnd idref through the
  // property index; derive the connected pair and aggregation kind.
  //
  // Composition ownership decision (documented for parity with the hand-made
  // ea-sample fixture): in EA 6.5 exports, the end property carrying
  // aggregation="composite|shared" has a `type` idref pointing to the WHOLE
  // (the end where the diamond sits) — e.g. connector EAID_E31D9ED5 is
  // ea_type=Aggregation/subtype=Strong with source=Producto/target=Class1 and
  // its composite end types Producto. We emit source=whole, target=part and
  // aggregationEnd='source', exactly how the hand-made fixture encodes
  // Order◆—OrderLine (source carries the composite marker).
  const multiplicityOf = (e: EndProp): string | undefined => {
    if (e.lower === undefined && e.upper === undefined) return undefined;
    const l = e.lower ?? '1';
    const u = e.upper ?? '1';
    return (l === u && l !== '-1') ? l : `${l === '-1' ? '*' : l}..${u === '-1' ? '*' : u}`;
  };

  for (const assoc of associationNodes) {
    const id = assoc['@_xmi:id'] || randomUUID();
    const refs = toArray(assoc['memberEnd']).map((me: any) => me?.['@_xmi:idref']).filter(Boolean);
    const ends = refs.map((r: string) => propertyIndex.get(r)).filter(Boolean) as EndProp[];
    const typedEnds = ends.filter(e => e.type);
    if (typedEnds.length < 2) continue; // dangling memberEnd-less association: skip, never invent

    // ---- N-ary routing: an association with 3+ distinct typed member ends is
    // a genuine UML n-ary association (e.g. EAID_56CC2820 binding Class2,
    // Class4 and Class3). Emitting it as a binary source/target would silently
    // drop the middle ends, so it goes to naryAssociations instead. Duplicate
    // class ids within one association are collapsed (engine forbids them).
    if (typedEnds.length >= 3) {
      const seen = new Set<string>();
      const memberEnds: XmiModel['naryAssociations'][number]['memberEnds'] = [];
      for (const e of typedEnds) {
        const classId = e.type!;
        if (seen.has(classId)) continue;
        seen.add(classId);
        const multiplicity = multiplicityOf(e);
        memberEnds.push({
          classId,
          ...(multiplicity !== undefined ? { multiplicity } : {}),
          ...(e.name ? { role: e.name } : {}),
        });
      }
      if (memberEnds.length >= 3) {
        model.naryAssociations.push({
          id,
          memberEnds,
          ...(assoc['@_name'] ? { name: assoc['@_name'] } : {}),
        });
      }
      continue;
    }

    // First/last memberEnd in document order anchor the emitted direction for
    // plain (non-aggregated) associations.
    const firstEnd = typedEnds[0];
    const lastEnd = typedEnds[typedEnds.length - 1];
    if (!firstEnd || !lastEnd || !firstEnd.type || !lastEnd.type) continue;

    let aggregation: 'none' | 'shared' | 'composite' = 'none';
    let diamondEnd: EndProp | undefined;
    for (const e of typedEnds) {
      if (e.aggregation === 'composite' || e.aggregation === 'shared') {
        aggregation = e.aggregation;
        diamondEnd = e;
        break;
      }
    }

    let source: string;
    let target: string;
    const aggregationEnd: 'source' = 'source';
    if (diamondEnd && diamondEnd.type && typedEnds.length === 2) {
      const whole = diamondEnd.type;
      const part = typedEnds.find(e => e.type !== whole)?.type ?? whole; // self-composition falls back to same class
      source = whole;
      target = part;
    } else {
      source = firstEnd.type;
      target = lastEnd.type;
    }

    // Ends in real EA exports often carry no name/multiplicity: those fields
    // stay omitted so the batch uses the PR13d empty defaults (optional).
    const sourceMultiplicity = multiplicityOf(firstEnd);
    const targetMultiplicity = multiplicityOf(lastEnd);
    model.associations.push({
      id,
      source,
      target,
      aggregation,
      aggregationEnd,
      ...(assoc['@_name'] ? { name: assoc['@_name'] } : {}),
      ...(firstEnd.name ? { sourceRole: firstEnd.name } : {}),
      ...(lastEnd.name ? { targetRole: lastEnd.name } : {}),
      ...(sourceMultiplicity !== undefined ? { sourceMultiplicity } : {}),
      ...(targetMultiplicity !== undefined ? { targetMultiplicity } : {}),
    });
  }

  // ---- Realizations (uml:Realization as a top-level packagedElement):
  // client realizes supplier, where supplier is the interface. The emit step
  // resolves both through the classifier id map and skips unresolvable ends.
  for (const r of realizationNodes) {
    const client = r['@_client'];
    const supplier = r['@_supplier'];
    if (client && supplier) {
      model.realizations.push({ id: r['@_xmi:id'] || randomUUID(), clientId: client, supplierId: supplier });
    }
  }

  // ---- Dependencies (uml:Dependency as a top-level packagedElement):
  // client depends-on supplier. Unlike a realization, the engine allows the
  // supplier (and client) to be ANY classifier, interface included (the
  // RealizationTargetNotInterface gate does not apply to dependencies).
  // Direction matches the hand-made UML:Dependency path and the engine's
  // clientClassId -> supplierClassId delta semantics.
  for (const dep of dependencyNodes) {
    const client = dep['@_client'];
    const supplier = dep['@_supplier'];
    if (client && supplier) {
      model.dependencies.push({ id: dep['@_xmi:id'] || randomUUID(), clientId: client, supplierId: supplier });
    }
  }

  // ---- Collision disambiguation (fixture 6): model.classes and
  // classNodeChains are index-aligned (both built by iterating classNodes in
  // document order), so each classifier carries its own package ancestry.
  // Only genuinely colliding names are qualified; everything else stays bare.
  disambiguateClassifierNames(model, classNodeChains);
}

function xmiToDeltaBatch(model: XmiModel, diagramId: string): BatchDelta {
  // Build XMI-id → UUID remap for all classes
  const classIdMap = new Map<string, string>();
  for (const c of model.classes) {
    classIdMap.set(c.id, randomUUID());
  }

  // Build positioned classes for grid layout
  const positioned = model.classes.map(c => ({ id: c.id, x: 0, y: 0 }));
  gridLayout(positioned, 150);
  const positionMap = new Map<string, { x: number; y: number }>();
  for (const p of positioned) {
    positionMap.set(p.id, { x: p.x, y: p.y });
  }

  const now = new Date().toISOString();
  const deltas: Delta[] = [];

  // Classes
  for (const c of model.classes) {
    const uuid = classIdMap.get(c.id)!;
    const pos = positionMap.get(c.id)!;
    deltas.push({
      kind: 'class',
      id: randomUUID(),
      diagramId,
      timestamp: now,
      op: 'create',
      classId: uuid,
      name: c.name,
      classKind: c.kind,
      isAbstract: c.isAbstract,
      position: { x: pos.x, y: pos.y },
    } as ClassDelta);

    // The engine's create op deliberately does not persist isAbstract (unit
    // 12.4: abstract marking travels on a class `update` delta). Emit the
    // follow-up so imported interfaces/abstract classes keep the flag on the
    // applied diagram instead of silently reverting to false.
    if (c.isAbstract) {
      deltas.push({
        kind: 'class',
        id: randomUUID(),
        diagramId,
        timestamp: now,
        op: 'update',
        classId: uuid,
        isAbstract: true,
      } as ClassDelta);
    }

    // Attributes
    for (const attr of c.attributes) {
      deltas.push({
        kind: 'member',
        id: randomUUID(),
        diagramId,
        timestamp: now,
        op: 'addAttribute',
        classId: uuid,
        memberId: randomUUID(),
        name: attr.name,
        type: attr.type,
        visibility: normalizeVisibility(attr.visibility),
        ...(attr.isStatic !== undefined ? { isStatic: attr.isStatic } : {}),
        ...(attr.isDerived !== undefined ? { isDerived: attr.isDerived } : {}),
        ...(attr.multiplicity !== undefined ? { multiplicity: attr.multiplicity } : {}),
      } as MemberDelta);
    }

    // Methods
    for (const method of c.methods) {
      deltas.push({
        kind: 'member',
        id: randomUUID(),
        diagramId,
        timestamp: now,
        op: 'addMethod',
        classId: uuid,
        memberId: randomUUID(),
        name: method.name,
        returnType: method.returnType,
        parameters: method.parameters,
        visibility: normalizeVisibility(method.visibility),
        ...(method.isStatic !== undefined ? { isStatic: method.isStatic } : {}),
      } as MemberDelta);
    }
  }

  // Associations
  for (const a of model.associations) {
    const sourceUuid = classIdMap.get(a.source);
    const targetUuid = classIdMap.get(a.target);
    if (!sourceUuid || !targetUuid) continue;
    deltas.push({
      kind: 'association',
      id: randomUUID(),
      diagramId,
      timestamp: now,
      op: 'create',
      associationId: randomUUID(),
      sourceClassId: sourceUuid,
      targetClassId: targetUuid,
      // Optional carriers are only emitted when defined: real EA exports have
      // unnamed, multiplicity-less association ends and AssociationDeltaSchema
      // is .strict() (PR13d: create multiplicities are optional).
      ...(a.name !== undefined ? { name: a.name } : {}),
      ...(a.sourceRole !== undefined ? { sourceRole: a.sourceRole } : {}),
      ...(a.targetRole !== undefined ? { targetRole: a.targetRole } : {}),
      ...(a.sourceMultiplicity !== undefined ? { sourceMultiplicity: a.sourceMultiplicity } : {}),
      ...(a.targetMultiplicity !== undefined ? { targetMultiplicity: a.targetMultiplicity } : {}),
      aggregation: a.aggregation,
      aggregationEnd: a.aggregationEnd,
      directed: true,
    } as AssociationDelta);
  }

  // Generalizations
  for (const g of model.generalizations) {
    const subUuid = classIdMap.get(g.subClassId);
    const superUuid = classIdMap.get(g.superClassId);
    if (!subUuid || !superUuid) continue;
    deltas.push({
      kind: 'generalization',
      id: randomUUID(),
      diagramId,
      timestamp: now,
      op: 'create',
      generalizationId: randomUUID(),
      subClassId: subUuid,
      superClassId: superUuid,
    } as GeneralizationDelta);
  }

  // Realizations
  for (const r of model.realizations) {
    const clientUuid = classIdMap.get(r.clientId);
    const supplierUuid = classIdMap.get(r.supplierId);
    if (!clientUuid || !supplierUuid) continue;
    deltas.push({
      kind: 'realization',
      id: randomUUID(),
      diagramId,
      timestamp: now,
      op: 'create',
      realizationId: randomUUID(),
      clientClassId: clientUuid,
      supplierInterfaceId: supplierUuid,
    } as RealizationDelta);
  }

  // Dependencies
  for (const d of model.dependencies) {
    const clientUuid = classIdMap.get(d.clientId);
    const supplierUuid = classIdMap.get(d.supplierId);
    if (!clientUuid || !supplierUuid) continue;
    deltas.push({
      kind: 'dependency',
      id: randomUUID(),
      diagramId,
      timestamp: now,
      op: 'create',
      dependencyId: randomUUID(),
      clientClassId: clientUuid,
      supplierClassId: supplierUuid,
    } as DependencyDelta);
  }

  // N-ary
  for (const n of model.naryAssociations) {
    const memberEnds = n.memberEnds
      .map(end => {
        const classUuid = classIdMap.get(end.classId);
        if (!classUuid) return null;
        return {
          classId: classUuid,
          multiplicity: end.multiplicity ?? '1',
          ...(end.role !== undefined ? { role: end.role } : {}),
        };
      })
      .filter((end): end is { classId: string; multiplicity: string; role?: string } => end !== null);

    if (memberEnds.length >= 3) {
      deltas.push({
        kind: 'naryAssociation',
        id: randomUUID(),
        diagramId,
        timestamp: now,
        op: 'create',
        naryAssociationId: randomUUID(),
        memberEnds,
        ...(n.name !== undefined ? { name: n.name } : {}),
      } as NaryAssociationDelta);
    }
  }

  return {
    kind: 'batch',
    id: randomUUID(),
    diagramId,
    timestamp: now,
    deltas,
  } as BatchDelta;
}

export { parseXmiDocument, xmiToDeltaBatch };