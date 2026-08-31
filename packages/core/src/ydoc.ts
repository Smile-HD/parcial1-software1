import * as Y from 'yjs';
import { type Diagram, type Class, type Association, DiagramSchema, ClassSchema, AssociationSchema } from './ir.js';
import { z } from 'zod';

/**
 * Yjs type names used in the Y.Doc for the diagram.
 */
const Y_DOC_TYPES = {
  classes: 'classes',
  associations: 'associations',
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
  const yMeta = doc.getMap(Y_DOC_TYPES.meta);

  // Set diagram metadata
  yMeta.set('id', diagram.id);
  yMeta.set('name', diagram.name);

  // Add classes
  for (const cls of diagram.classes) {
    const yClass = new Y.Map();
    yClass.set('id', cls.id);
    yClass.set('name', cls.name);
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
    yAssociations.set(assoc.id, yAssoc);
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
  const yMeta = doc.getMap(Y_DOC_TYPES.meta);

  const id = yMeta.get('id') as string;
  const name = yMeta.get('name') as string;

  const classes: Class[] = [];
  yClasses.forEach((yClass) => {
    if (!(yClass instanceof Y.Map)) return;

    const classId = yClass.get('id') as string;
    const className = yClass.get('name') as string;
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
    }));
  });

  const associations: Association[] = [];
  yAssociations.forEach((yAssoc) => {
    if (!(yAssoc instanceof Y.Map)) return;

    associations.push(AssociationSchema.parse({
      id: yAssoc.get('id') as string,
      sourceClassId: yAssoc.get('sourceClassId') as string,
      targetClassId: yAssoc.get('targetClassId') as string,
      sourceMultiplicity: yAssoc.get('sourceMultiplicity') as Association['sourceMultiplicity'],
      targetMultiplicity: yAssoc.get('targetMultiplicity') as Association['targetMultiplicity'],
      directed: yAssoc.get('directed') as boolean,
    }));
  });

  return DiagramSchema.parse({
    id,
    name,
    classes,
    associations,
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