/**
 * Puente: aplica un delta al Y.Doc canonical (IR).
 *
 * 1. Proyecta el Y.Doc → Diagram (proyección de lectura)
 * 2. applyDelta contra el Diagram (motor puro)
 * 3. Escribe el diagrama mutado nuevamente en la MISMA instancia de Y.Doc
 *    (dispara los observadores de Yjs para que el lienzo se re-renderice).
 *
 * editor:R1 — cada mutación fluye a través de applyDelta.
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

// ── Constantes de clave de Y.Doc (refleja Y_DOC_TYPES de core) ──────────────────────
const Y_CLASSES = 'classes';
const Y_ASSOCIATIONS = 'associations';
const Y_GENERALIZATIONS = 'generalizations';
const Y_REALIZATIONS = 'realizations';
const Y_DEPENDENCIES = 'dependencies';
const Y_NARY_ASSOCIATIONS = 'naryAssociations';
const Y_META = 'meta';

/**
 * Aplica un delta al Y.Doc in situ. Retorna el mismo `ApplyResult`
 * que `applyDelta` — quienes llamen a esta función DEBEN verificar `isApplyError(result)` antes de usar
 * `result.diagram`.
 */
export function applyDeltaToYDoc(doc: Y.Doc, delta: Delta): ApplyResult<Diagram> {
  const current = projectYDocToDiagram(doc);
  const result = applyDelta(current, delta);

  if (!result.ok) {
    return result;
  }

  // Optimización de alta frecuencia: reposicionamiento in situ para streaming en vivo a 60/120 FPS
  // Muta atómicamente el mapa de posición de la clase sin recrear todo el documento Yjs.
  if (delta.kind === 'class' && delta.op === 'reposition') {
    doc.transact(() => {
      const yClasses = doc.getMap(Y_CLASSES);
      const yClass = yClasses.get(delta.classId);
      if (yClass instanceof Y.Map) {
        const yPos = yClass.get('position');
        if (yPos instanceof Y.Map) {
          yPos.set('x', delta.newPosition.x);
          yPos.set('y', delta.newPosition.y);
        } else {
          const newYPos = new Y.Map<number>();
          newYPos.set('x', delta.newPosition.x);
          newYPos.set('y', delta.newPosition.y);
          yClass.set('position', newYPos);
        }
      }
    });
    return result;
  }

  writeDiagramToDoc(doc, result.value);
  return result;
}

// ── Escritor de Y.Doc in situ (muta la misma instancia de doc) ─────────────────

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
  // Unidad 12.1: el tipo de clasificador + marca abstracta hacen round-trip a través del puente.
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
  // Unidad 13d corrección C: multiplicidades opcionales — un extremo sin especificar NO almacena
  // ninguna clave (ausencia ≠ '1'), reflejando el códec ydoc de core.
  if (assoc.sourceMultiplicity !== undefined) yAssoc.set('sourceMultiplicity', assoc.sourceMultiplicity);
  if (assoc.targetMultiplicity !== undefined) yAssoc.set('targetMultiplicity', assoc.targetMultiplicity);
  yAssoc.set('directed', assoc.directed);
  // Unidad 10: agregación/nombre/roles deben hacer round-trip a través del puente Y.Doc
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
  // Unidad 13c: la etiqueta opcional debe sobrevivir a la reescritura completa del puente;
  // de lo contrario, cualquier delta no relacionado descartaría silenciosamente los nombres de aristas.
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
  // memberEnds es un Y.Array ordenado de Y.Maps — misma forma que preserva
  // blobs que attributes/methods/parameters en el códec ydoc de core (unidad 13).
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