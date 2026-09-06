/**
 * Bridge: apply a delta to the canonical Y.Doc (IR).
 *
 * 1. Project the Y.Doc → Diagram (read projection)
 * 2. applyDelta against the Diagram (pure engine)
 * 3. Write the mutated diagram back into the SAME Y.Doc instance
 *    (triggers Yjs observers so the canvas re-renders).
 *
 * editor:R1 — every mutation flows through applyDelta.
 */
import * as Y from 'yjs';

import {
  applyDelta,
  projectYDocToDiagram,
  type ApplyResult,
  type Association,
  type Class,
  type Delta,
  type Dependency,
  type Diagram,
  type Generalization,
  type NaryAssociation,
  type Realization,
} from '@app/core';

// ── Y.Doc key constants (mirrors core's Y_DOC_TYPES) ──────────────────────
const Y_CLASSES = 'classes';
const Y_ASSOCIATIONS = 'associations';
const Y_GENERALIZATIONS = 'generalizations';
const Y_REALIZATIONS = 'realizations';
const Y_DEPENDENCIES = 'dependencies';
const Y_NARY_ASSOCIATIONS = 'naryAssociations';
const Y_META = 'meta';

/**
 * Apply a delta to the Y.Doc in-place. Returns the same `ApplyResult`
 * as `applyDelta` — callers MUST check `isApplyError(result)` before using
 * `result.diagram`.
 */
export function applyDeltaToYDoc(doc: Y.Doc, delta: Delta): ApplyResult<Diagram> {
  const current = projectYDocToDiagram(doc);
  const result = applyDelta(current, delta);

  if (!result.ok) {
    return result;
  }

  writeDiagramToDoc(doc, result.value);
  return result;
}

// ── In-place Y.Doc writer (mutates the same doc instance) ─────────────────

function writeDiagramToDoc(doc: Y.Doc, diagram: Diagram): void {
  doc.transact(() => {
    const yClasses = doc.getMap(Y_CLASSES);
    const yAssociations = doc.getMap(Y_ASSOCIATIONS);
    const yGeneralizations = doc.getMap(Y_GENERALIZATIONS);
    const yRealizations = doc.getMap(Y_REALIZATIONS);
    const yDependencies = doc.getMap(Y_DEPENDENCIES);
    const yNaryAssociations = doc.getMap(Y_NARY_ASSOCIATIONS);
    const yMeta = doc.getMap(Y_META);

    yClasses.clear();
    yAssociations.clear();
    yGeneralizations.clear();
    yRealizations.clear();
    yDependencies.clear();
    yNaryAssociations.clear();

    yMeta.set('id', diagram.id);
    yMeta.set('name', diagram.name);

    for (const cls of diagram.classes) {
      yClasses.set(cls.id, buildYClass(cls));
    }

    for (const assoc of diagram.associations) {
      yAssociations.set(assoc.id, buildYAssociation(assoc));
    }

    for (const gen of diagram.generalizations ?? []) {
      yGeneralizations.set(gen.id, buildYGeneralization(gen));
    }

    for (const real of diagram.realizations ?? []) {
      yRealizations.set(real.id, buildYRealization(real));
    }

    for (const dep of diagram.dependencies ?? []) {
      yDependencies.set(dep.id, buildYDependency(dep));
    }

    for (const nary of diagram.naryAssociations ?? []) {
      yNaryAssociations.set(nary.id, buildYNaryAssociation(nary));
    }
  });
}

function buildYClass(cls: Class): Y.Map<unknown> {
  const yClass = new Y.Map<unknown>();

  yClass.set('id', cls.id);
  yClass.set('name', cls.name);
  // Unit 12.1: classifier kind + abstract marking round-trip through the bridge.
  yClass.set('kind', cls.kind ?? 'class');
  yClass.set('isAbstract', cls.isAbstract ?? false);

  const yPos = new Y.Map<number>();
  yPos.set('x', cls.position.x);
  yPos.set('y', cls.position.y);
  yClass.set('position', yPos);

  const yAttributes = new Y.Array<Y.Map<unknown>>();
  for (const attr of cls.attributes) {
    const yAttr = new Y.Map<unknown>();
    yAttr.set('id', attr.id);
    yAttr.set('name', attr.name);
    yAttr.set('type', attr.type);
    yAttr.set('visibility', attr.visibility ?? '+');
    yAttr.set('isStatic', attr.isStatic ?? false);
    yAttr.set('isDerived', attr.isDerived ?? false);
    if (attr.multiplicity !== undefined) {
      yAttr.set('multiplicity', attr.multiplicity);
    }
    yAttributes.push([yAttr]);
  }
  yClass.set('attributes', yAttributes);

  const yMethods = new Y.Array<Y.Map<unknown>>();
  for (const method of cls.methods) {
    const yMethod = new Y.Map<unknown>();
    yMethod.set('id', method.id);
    yMethod.set('name', method.name);
    yMethod.set('returnType', method.returnType);
    yMethod.set('visibility', method.visibility ?? '+');
    yMethod.set('isStatic', method.isStatic ?? false);

    const yParams = new Y.Array<Y.Map<unknown>>();
    for (const param of method.parameters) {
      const yParam = new Y.Map<unknown>();
      yParam.set('name', param.name);
      yParam.set('type', param.type);
      yParams.push([yParam]);
    }
    yMethod.set('parameters', yParams);
    yMethods.push([yMethod]);
  }
  yClass.set('methods', yMethods);

  return yClass;
}

function buildYAssociation(assoc: Association): Y.Map<unknown> {
  const yAssoc = new Y.Map<unknown>();
  yAssoc.set('id', assoc.id);
  yAssoc.set('sourceClassId', assoc.sourceClassId);
  yAssoc.set('targetClassId', assoc.targetClassId);
  yAssoc.set('sourceMultiplicity', assoc.sourceMultiplicity);
  yAssoc.set('targetMultiplicity', assoc.targetMultiplicity);
  yAssoc.set('directed', assoc.directed);
  // Unit 10: aggregation/name/roles must round-trip through the Y.Doc bridge
  yAssoc.set('aggregation', assoc.aggregation ?? 'none');
  yAssoc.set('aggregationEnd', assoc.aggregationEnd ?? 'source');
  if (assoc.name !== undefined) yAssoc.set('name', assoc.name);
  if (assoc.sourceRole !== undefined) yAssoc.set('sourceRole', assoc.sourceRole);
  if (assoc.targetRole !== undefined) yAssoc.set('targetRole', assoc.targetRole);
  return yAssoc;
}

function buildYGeneralization(gen: Generalization): Y.Map<unknown> {
  const yGen = new Y.Map<unknown>();
  yGen.set('id', gen.id);
  yGen.set('subClassId', gen.subClassId);
  yGen.set('superClassId', gen.superClassId);
  // Unit 13c: the optional label must survive the bridge's full rewrite,
  // otherwise any unrelated delta would silently drop edge names.
  if (gen.name !== undefined) yGen.set('name', gen.name);
  return yGen;
}

function buildYRealization(real: Realization): Y.Map<unknown> {
  const yReal = new Y.Map<unknown>();
  yReal.set('id', real.id);
  yReal.set('clientClassId', real.clientClassId);
  yReal.set('supplierInterfaceId', real.supplierInterfaceId);
  if (real.name !== undefined) yReal.set('name', real.name);
  return yReal;
}

function buildYDependency(dep: Dependency): Y.Map<unknown> {
  const yDep = new Y.Map<unknown>();
  yDep.set('id', dep.id);
  yDep.set('clientClassId', dep.clientClassId);
  yDep.set('supplierClassId', dep.supplierClassId);
  if (dep.name !== undefined) yDep.set('name', dep.name);
  return yDep;
}

function buildYNaryAssociation(nary: NaryAssociation): Y.Map<unknown> {
  const yNary = new Y.Map<unknown>();
  yNary.set('id', nary.id);
  if (nary.name !== undefined) yNary.set('name', nary.name);
  // memberEnds is an ordered Y.Array of Y.Maps — same blob-preserving
  // shape as attributes/methods/parameters in core's ydoc codec (unit 13).
  const yEnds = new Y.Array<Y.Map<unknown>>();
  for (const end of nary.memberEnds) {
    const yEnd = new Y.Map<unknown>();
    yEnd.set('classId', end.classId);
    yEnd.set('multiplicity', end.multiplicity);
    if (end.role !== undefined) yEnd.set('role', end.role);
    yEnds.push([yEnd]);
  }
  yNary.set('memberEnds', yEnds);
  return yNary;
}