import * as Y from 'yjs';
import { type Diagram, type Class, type Association, type Generalization, type Realization, type Dependency, type Method, DiagramSchema, ClassSchema, AssociationSchema, GeneralizationSchema, RealizationSchema, DependencySchema } from './ir.js';
import { z } from 'zod';

/**
 * Yjs type names used in the Y.Doc for the diagram.
 */
const Y_DOC_TYPES = {
  classes: 'classes',
  associations: 'associations',
  generalizations: 'generalizations',
  realizations: 'realizations',
  dependencies: 'dependencies',
  meta: 'meta',
} as const;

/**
 * Builds a Y.Doc from a validated Diagram IR.
 * The Y.Doc structure:
 * - yMap<Class> at 'classes' key (classId -> Y.Map of class fields)
 * - yMap<Association> at 'associations' key (assocId -> Y.Map of association fields)
 * - yMap at 'meta' key for diagram-level metadata (id, name)
 */
export function buildYDocFromDiagram(diagram: Diagram): Y.Doc {
  const doc = new Y.Doc();
  const yClasses = doc.getMap(Y_DOC_TYPES.classes);
  const yAssociations = doc.getMap(Y_DOC_TYPES.associations);
  const yGeneralizations = doc.getMap(Y_DOC_TYPES.generalizations);
  const yRealizations = doc.getMap(Y_DOC_TYPES.realizations);
  const yDependencies = doc.getMap(Y_DOC_TYPES.dependencies);
  const yMeta = doc.getMap(Y_DOC_TYPES.meta);

  // Set diagram metadata
  yMeta.set('id', diagram.id);
  yMeta.set('name', diagram.name);

  // Add classes
  for (const cls of diagram.classes) {
    const yClass = new Y.Map();
    yClass.set('id', cls.id);
    yClass.set('name', cls.name);
    // Unit 12.1: classifier kind + abstract marking round-trip through the blob.
    yClass.set('kind', cls.kind ?? 'class');
    yClass.set('isAbstract', cls.isAbstract ?? false);
    yClass.set('position', new Y.Map([
      ['x', cls.position.x],
      ['y', cls.position.y],
    ]));

    // Attributes as Y.Array of Y.Maps
    const yAttributes = new Y.Array();
    for (const attr of cls.attributes) {
      const yAttr = new Y.Map();
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

    // Methods as Y.Array of Y.Maps
    const yMethods = new Y.Array();
    for (const method of cls.methods) {
      const yMethod = new Y.Map();
      yMethod.set('id', method.id);
      yMethod.set('name', method.name);
      yMethod.set('returnType', method.returnType);
      yMethod.set('visibility', method.visibility ?? '+');
      yMethod.set('isStatic', method.isStatic ?? false);
      const yParams = new Y.Array();
      for (const param of method.parameters) {
        const yParam = new Y.Map();
        yParam.set('name', param.name);
        yParam.set('type', param.type);
        yParams.push([yParam]);
      }
      yMethod.set('parameters', yParams);
      yMethods.push([yMethod]);
    }
    yClass.set('methods', yMethods);

    yClasses.set(cls.id, yClass);
  }

  // Add associations
  for (const assoc of diagram.associations) {
    const yAssoc = new Y.Map();
    yAssoc.set('id', assoc.id);
    yAssoc.set('sourceClassId', assoc.sourceClassId);
    yAssoc.set('targetClassId', assoc.targetClassId);
    yAssoc.set('sourceMultiplicity', assoc.sourceMultiplicity);
    yAssoc.set('targetMultiplicity', assoc.targetMultiplicity);
    yAssoc.set('directed', assoc.directed);
    yAssoc.set('aggregation', assoc.aggregation);
    yAssoc.set('aggregationEnd', assoc.aggregationEnd);
    if (assoc.name !== undefined) yAssoc.set('name', assoc.name);
    if (assoc.sourceRole !== undefined) yAssoc.set('sourceRole', assoc.sourceRole);
    if (assoc.targetRole !== undefined) yAssoc.set('targetRole', assoc.targetRole);
    yAssociations.set(assoc.id, yAssoc);
  }

  // Add generalizations (unit 11 — blob-preserving, same shape as associations)
  for (const gen of diagram.generalizations ?? []) {
    const yGen = new Y.Map();
    yGen.set('id', gen.id);
    yGen.set('subClassId', gen.subClassId);
    yGen.set('superClassId', gen.superClassId);
    yGeneralizations.set(gen.id, yGen);
  }

  // Add realizations (unit 12 — blob-preserving, same shape as generalizations)
  for (const real of diagram.realizations ?? []) {
    const yReal = new Y.Map();
    yReal.set('id', real.id);
    yReal.set('clientClassId', real.clientClassId);
    yReal.set('supplierInterfaceId', real.supplierInterfaceId);
    yRealizations.set(real.id, yReal);
  }

  // Add dependencies (unit 12b — blob-preserving, same shape as realizations)
  for (const dep of diagram.dependencies ?? []) {
    const yDep = new Y.Map();
    yDep.set('id', dep.id);
    yDep.set('clientClassId', dep.clientClassId);
    yDep.set('supplierClassId', dep.supplierClassId);
    yDependencies.set(dep.id, yDep);
  }

  return doc;
}

/**
 * Projects a Y.Doc back to a Diagram IR JSON.
 * This is the read-time projection used for API responses.
 */
export function projectYDocToDiagram(doc: Y.Doc): Diagram {
  const yClasses = doc.getMap(Y_DOC_TYPES.classes);
  const yAssociations = doc.getMap(Y_DOC_TYPES.associations);
  const yGeneralizations = doc.getMap(Y_DOC_TYPES.generalizations);
  const yRealizations = doc.getMap(Y_DOC_TYPES.realizations);
  const yDependencies = doc.getMap(Y_DOC_TYPES.dependencies);
  const yMeta = doc.getMap(Y_DOC_TYPES.meta);

  const id = yMeta.get('id') as string;
  const name = yMeta.get('name') as string;

  const classes: Class[] = [];
  yClasses.forEach((yClass) => {
    if (!(yClass instanceof Y.Map)) return;

    const classId = yClass.get('id') as string;
    const className = yClass.get('name') as string;
    // Unit 12.1: absent on pre-unit-12 docs → IR defaults (class/false).
    const kind = yClass.get('kind') as Class['kind'] | undefined;
    const isAbstract = yClass.get('isAbstract') as boolean | undefined;
    const yPosition = yClass.get('position') as Y.Map<unknown> | undefined;
    const position = yPosition
      ? { x: (yPosition.get('x') as number) ?? 0, y: (yPosition.get('y') as number) ?? 0 }
      : { x: 0, y: 0 };

    const attributes: Class['attributes'] = [];
    const yAttributes = yClass.get('attributes') as Y.Array<Y.Map<unknown>> | undefined;
    if (yAttributes) {
      yAttributes.forEach((yAttr) => {
        if (yAttr instanceof Y.Map) {
          const multiplicity = yAttr.get('multiplicity') as string | undefined;
          attributes.push({
            id: yAttr.get('id') as string,
            name: yAttr.get('name') as string,
            type: yAttr.get('type') as string,
            visibility: (yAttr.get('visibility') as '+') ?? '+',
            isStatic: (yAttr.get('isStatic') as boolean) ?? false,
            isDerived: (yAttr.get('isDerived') as boolean) ?? false,
            ...(multiplicity !== undefined ? { multiplicity } : {}),
          });
        }
      });
    }

    const methods: Class['methods'] = [];
    const yMethods = yClass.get('methods') as Y.Array<Y.Map<unknown>> | undefined;
    if (yMethods) {
      yMethods.forEach((yMethod) => {
        if (yMethod instanceof Y.Map) {
          const parameters: Method['parameters'] = [];
          const yParams = yMethod.get('parameters') as Y.Array<Y.Map<unknown>> | undefined;
          if (yParams) {
            yParams.forEach((yParam) => {
              if (yParam instanceof Y.Map) {
                parameters.push({
                  name: yParam.get('name') as string,
                  type: yParam.get('type') as string,
                });
              }
            });
          }
          methods.push({
            id: yMethod.get('id') as string,
            name: yMethod.get('name') as string,
            returnType: yMethod.get('returnType') as string,
            parameters,
            visibility: (yMethod.get('visibility') as '+') ?? '+',
            isStatic: (yMethod.get('isStatic') as boolean) ?? false,
          });
        }
      });
    }

    classes.push(ClassSchema.parse({
      id: classId,
      name: className,
      position,
      attributes,
      methods,
      ...(kind !== undefined ? { kind } : {}),
      ...(isAbstract !== undefined ? { isAbstract } : {}),
    }));
  });

  const associations: Association[] = [];
  yAssociations.forEach((yAssoc) => {
    if (!(yAssoc instanceof Y.Map)) return;

    const aggregation = yAssoc.get('aggregation') as Association['aggregation'] | undefined;
    const aggregationEnd = yAssoc.get('aggregationEnd') as Association['aggregationEnd'] | undefined;
    const name = yAssoc.get('name') as string | undefined;
    const sourceRole = yAssoc.get('sourceRole') as string | undefined;
    const targetRole = yAssoc.get('targetRole') as string | undefined;

    associations.push(AssociationSchema.parse({
      id: yAssoc.get('id') as string,
      sourceClassId: yAssoc.get('sourceClassId') as string,
      targetClassId: yAssoc.get('targetClassId') as string,
      sourceMultiplicity: yAssoc.get('sourceMultiplicity') as Association['sourceMultiplicity'],
      targetMultiplicity: yAssoc.get('targetMultiplicity') as Association['targetMultiplicity'],
      directed: yAssoc.get('directed') as boolean,
      aggregation,
      aggregationEnd,
      ...(name !== undefined ? { name } : {}),
      ...(sourceRole !== undefined ? { sourceRole } : {}),
      ...(targetRole !== undefined ? { targetRole } : {}),
    }));
  });

  const generalizations: Generalization[] = [];
  yGeneralizations.forEach((yGen) => {
    if (!(yGen instanceof Y.Map)) return;

    generalizations.push(GeneralizationSchema.parse({
      id: yGen.get('id') as string,
      subClassId: yGen.get('subClassId') as string,
      superClassId: yGen.get('superClassId') as string,
    }));
  });

  const realizations: Realization[] = [];
  yRealizations.forEach((yReal) => {
    if (!(yReal instanceof Y.Map)) return;

    realizations.push(RealizationSchema.parse({
      id: yReal.get('id') as string,
      clientClassId: yReal.get('clientClassId') as string,
      supplierInterfaceId: yReal.get('supplierInterfaceId') as string,
    }));
  });

  const dependencies: Dependency[] = [];
  yDependencies.forEach((yDep) => {
    if (!(yDep instanceof Y.Map)) return;

    dependencies.push(DependencySchema.parse({
      id: yDep.get('id') as string,
      clientClassId: yDep.get('clientClassId') as string,
      supplierClassId: yDep.get('supplierClassId') as string,
    }));
  });

  return DiagramSchema.parse({
    id,
    name,
    classes,
    associations,
    generalizations,
    realizations,
    dependencies,
  });
}

/**
 * Encodes a Y.Doc to a Uint8Array update blob using Y.encodeStateAsUpdate.
 * This blob is the authoritative persistence format (design invariant).
 */
export function encodeYDoc(doc: Y.Doc): Uint8Array {
  return Y.encodeStateAsUpdate(doc);
}

/**
 * Applies a Yjs update blob (Uint8Array) into a Y.Doc.
 * Returns the modified Y.Doc (same instance).
 * Throws if the update cannot be applied (corrupt blob).
 */
export function applyUpdateToYDoc(doc: Y.Doc, update: Uint8Array): Y.Doc {
  Y.applyUpdate(doc, update);
  return doc;
}

/**
 * Creates a fresh Y.Doc and applies an update blob to it.
 * Convenience function for loading from persistence.
 * Throws if the update cannot be applied (corrupt blob).
 */
export function loadYDocFromUpdate(update: Uint8Array): Y.Doc {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, update);
  return doc;
}

/**
 * Validates that a Y.Doc can be projected to a valid Diagram.
 * Used for self-healing check: if projection fails Zod validation,
 * the stored doc jsonb is out of sync and must be regenerated from blob.
 */
export function validateYDocProjection(doc: Y.Doc): { ok: true; diagram: Diagram } | { ok: false; error: z.ZodError } {
  try {
    const diagram = projectYDocToDiagram(doc);
    return { ok: true, diagram };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return { ok: false, error };
    }
    throw error;
  }
}