import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { Diagram, Class, Attribute, Method, Association, Generalization, Realization, Dependency, NaryAssociation, Delta, BatchDelta } from '@app/core';

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

  const root = parsed?.['UML:Model'] || parsed?.Model || parsed;
  if (!root) throw new Error('XMI parse error: no UML:Model root');

  const version = root['@_xmi:version'] || root['@_version'] || '';
  if (!VERSION_PATTERN.test(version)) {
    throw new Error(`Unsupported XMI version: ${version || 'unknown'}; supported: 2.1`);
  }

  const model: XmiModel = {
    classes: [],
    associations: [],
    generalizations: [],
    realizations: [],
    dependencies: [],
    naryAssociations: [],
  };

  const elements = root['UML:Class'] || [];
  const attrs = root['UML:Attribute'] || [];
  const ops = root['UML:Operation'] || [];
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

  return model;
}

function xmiToDeltaBatch(model: XmiModel, diagramId: string): BatchDelta {
  const deltas: Delta[] = [];

  // Classes
  model.classes.forEach(c => {
    deltas.push({
      kind: 'class',
      op: 'create',
      classId: c.id,
      name: c.name,
      classKind: c.kind,
      isAbstract: c.isAbstract,
      x: 0,
      y: 0,
    });
    c.attributes.forEach(attr => {
      deltas.push({
        kind: 'member',
        op: 'create',
        classId: c.id,
        memberId: randomUUID(),
        memberType: 'attribute',
        name: attr.name,
        type: attr.type,
        visibility: attr.visibility,
        isStatic: attr.isStatic,
        isDerived: attr.isDerived,
        multiplicity: attr.multiplicity,
      });
    });
    c.methods.forEach(method => {
      deltas.push({
        kind: 'member',
        op: 'create',
        classId: c.id,
        memberId: randomUUID(),
        memberType: 'method',
        name: method.name,
        returnType: method.returnType,
        visibility: method.visibility,
        isStatic: method.isStatic,
        parameters: method.parameters,
      });
    });
  });

  // Associations
  model.associations.forEach(a => {
    deltas.push({
      kind: 'association',
      op: 'create',
      associationId: a.id,
      sourceClassId: a.source,
      targetClassId: a.target,
      name: a.name,
      sourceRole: a.sourceRole,
      targetRole: a.targetRole,
      sourceMultiplicity: a.sourceMultiplicity,
      targetMultiplicity: a.targetMultiplicity,
      aggregation: a.aggregation,
      aggregationEnd: a.aggregationEnd,
    });
  });

  // Generalizations
  model.generalizations.forEach(g => {
    deltas.push({
      kind: 'generalization',
      op: 'create',
      generalizationId: g.id,
      subClassId: g.subClassId,
      superClassId: g.superClassId,
    });
  });

  // Realizations
  model.realizations.forEach(r => {
    deltas.push({
      kind: 'realization',
      op: 'create',
      realizationId: r.id,
      clientClassId: r.clientId,
      supplierInterfaceId: r.supplierId,
    });
  });

  // Dependencies
  model.dependencies.forEach(d => {
    deltas.push({
      kind: 'dependency',
      op: 'create',
      dependencyId: d.id,
      clientClassId: d.clientId,
      supplierClassId: d.supplierId,
    });
  });

  // N-ary
  model.naryAssociations.forEach(n => {
    deltas.push({
      kind: 'naryAssociation',
      op: 'create',
      naryAssociationId: n.id,
      memberEnds: n.memberEnds,
      name: n.name,
    });
  });

  return {
    kind: 'batch',
    diagramId,
    deltas,
  };
}

export { parseXmiDocument, xmiToDeltaBatch };