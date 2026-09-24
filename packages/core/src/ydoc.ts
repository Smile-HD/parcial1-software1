import * as Y from 'yjs';
import { type Diagram, type Class, type Association, type Generalization, type Realization, type Dependency, type NaryAssociation, type Method, DiagramSchema, ClassSchema, AssociationSchema, GeneralizationSchema, RealizationSchema, DependencySchema, NaryAssociationSchema } from './ir.js';
import { z } from 'zod';

/**
 * Nombres de tipos Yjs utilizados en el Y.Doc para el diagrama.
 */
const Y_DOC_TYPES = {
  classes: 'classes',
  associations: 'associations',
  generalizations: 'generalizations',
  realizations: 'realizations',
  dependencies: 'dependencies',
  naryAssociations: 'naryAssociations',
  meta: 'meta',
} as const;

/**
 * Construye un Y.Doc a partir de un IR Diagram validado.
 * Estructura del Y.Doc:
 * - yMap<Class> en la clave 'classes' (classId -> Y.Map de campos de la clase)
 * - yMap<Association> en la clave 'associations' (assocId -> Y.Map de campos de la asociación)
 * - yMap en la clave 'meta' para metadatos a nivel de diagrama (id, name)
 */
export function buildYDocFromDiagram(diagram: Diagram): Y.Doc {
  const doc = new Y.Doc();
  const yClasses = doc.getMap(Y_DOC_TYPES.classes);
  const yAssociations = doc.getMap(Y_DOC_TYPES.associations);
  const yGeneralizations = doc.getMap(Y_DOC_TYPES.generalizations);
  const yRealizations = doc.getMap(Y_DOC_TYPES.realizations);
  const yDependencies = doc.getMap(Y_DOC_TYPES.dependencies);
  const yNaryAssociations = doc.getMap(Y_DOC_TYPES.naryAssociations);
  const yMeta = doc.getMap(Y_DOC_TYPES.meta);

  // Establecer metadatos del diagrama
  yMeta.set('id', diagram.id);
  yMeta.set('name', diagram.name);

  // Agregar clases
  for (const cls of diagram.classes) {
    const yClass = new Y.Map();
    yClass.set('id', cls.id);
    yClass.set('name', cls.name);
    // Unidad 12.1: tipo de clasificador + marcado abstracto se conservan en el blob.
    yClass.set('kind', cls.kind ?? 'class');
    yClass.set('isAbstract', cls.isAbstract ?? false);
    yClass.set('position', new Y.Map([
      ['x', cls.position.x],
      ['y', cls.position.y],
    ]));

    // Atributos como Y.Array de Y.Maps
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

    // Métodos como Y.Array de Y.Maps
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

  // Agregar asociaciones
  for (const assoc of diagram.associations) {
    const yAssoc = new Y.Map();
    yAssoc.set('id', assoc.id);
    yAssoc.set('sourceClassId', assoc.sourceClassId);
    yAssoc.set('targetClassId', assoc.targetClassId);
    // Corrección unidad 13d C: multiplicidades opcionales — un extremo sin especificar
    // NO almacena clave (la ausencia es la señal; nunca un '1' fantasma).
    if (assoc.sourceMultiplicity !== undefined) yAssoc.set('sourceMultiplicity', assoc.sourceMultiplicity);
    if (assoc.targetMultiplicity !== undefined) yAssoc.set('targetMultiplicity', assoc.targetMultiplicity);
    yAssoc.set('directed', assoc.directed);
    yAssoc.set('aggregation', assoc.aggregation);
    yAssoc.set('aggregationEnd', assoc.aggregationEnd);
    if (assoc.name !== undefined) yAssoc.set('name', assoc.name);
    if (assoc.sourceRole !== undefined) yAssoc.set('sourceRole', assoc.sourceRole);
    if (assoc.targetRole !== undefined) yAssoc.set('targetRole', assoc.targetRole);
    if (assoc.associationClassId !== undefined) yAssoc.set('associationClassId', assoc.associationClassId);
    yAssociations.set(assoc.id, yAssoc);
  }

  // Agregar generalizaciones (unidad 11 — preserva blob, misma forma que asociaciones;
  // unidad 13c incluye el nombre opcional de etiqueta)
  for (const gen of diagram.generalizations ?? []) {
    const yGen = new Y.Map();
    yGen.set('id', gen.id);
    yGen.set('subClassId', gen.subClassId);
    yGen.set('superClassId', gen.superClassId);
    if (gen.name !== undefined) yGen.set('name', gen.name);
    yGeneralizations.set(gen.id, yGen);
  }

  // Agregar realizaciones (unidad 12 — preserva blob, misma forma que generalizaciones;
  // unidad 13c incluye el nombre opcional de etiqueta)
  for (const real of diagram.realizations ?? []) {
    const yReal = new Y.Map();
    yReal.set('id', real.id);
    yReal.set('clientClassId', real.clientClassId);
    yReal.set('supplierInterfaceId', real.supplierInterfaceId);
    if (real.name !== undefined) yReal.set('name', real.name);
    yRealizations.set(real.id, yReal);
  }

  // Agregar dependencias (unidad 12b — preserva blob, misma forma que realizaciones;
  // unidad 13c incluye el nombre opcional de etiqueta)
  for (const dep of diagram.dependencies ?? []) {
    const yDep = new Y.Map();
    yDep.set('id', dep.id);
    yDep.set('clientClassId', dep.clientClassId);
    yDep.set('supplierClassId', dep.supplierClassId);
    if (dep.name !== undefined) yDep.set('name', dep.name);
    yDependencies.set(dep.id, yDep);
  }

  // Agregar asociaciones n-arias (unidad 13 — preserva blob; memberEnds es un
  // Y.Array ordenado de Y.Maps para que la multiplicidad/rol sobrevivan el viaje)
  for (const nary of diagram.naryAssociations ?? []) {
    const yNary = new Y.Map();
    yNary.set('id', nary.id);
    if (nary.name !== undefined) yNary.set('name', nary.name);
    const yEnds = new Y.Array();
    for (const end of nary.memberEnds) {
      const yEnd = new Y.Map();
      yEnd.set('classId', end.classId);
      yEnd.set('multiplicity', end.multiplicity);
      if (end.role !== undefined) yEnd.set('role', end.role);
      yEnds.push([yEnd]);
    }
    yNary.set('memberEnds', yEnds);
    yNaryAssociations.set(nary.id, yNary);
  }

  return doc;
}

/**
 * Proyecta un Y.Doc nuevamente a JSON del IR Diagram.
 * Es la proyección en tiempo de lectura utilizada para las respuestas de la API.
 */
export function projectYDocToDiagram(doc: Y.Doc): Diagram {
  const yClasses = doc.getMap(Y_DOC_TYPES.classes);
  const yAssociations = doc.getMap(Y_DOC_TYPES.associations);
  const yGeneralizations = doc.getMap(Y_DOC_TYPES.generalizations);
  const yRealizations = doc.getMap(Y_DOC_TYPES.realizations);
  const yDependencies = doc.getMap(Y_DOC_TYPES.dependencies);
  const yNaryAssociations = doc.getMap(Y_DOC_TYPES.naryAssociations);
  const yMeta = doc.getMap(Y_DOC_TYPES.meta);

  const id = yMeta.get('id') as string;
  const name = yMeta.get('name') as string;

  const classes: Class[] = [];
  yClasses.forEach((yClass) => {
    if (!(yClass instanceof Y.Map)) return;

    const classId = yClass.get('id') as string;
    const className = yClass.get('name') as string;
    // Unidad 12.1: ausente en documentos anteriores a unidad 12 → valores por defecto (class/false).
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
    // Corrección unidad 13d C: claves ausentes se proyectan a extremos INDEFINIDOS
    // (no especificado ≠ '1'); claves presentes hacen viaje de ida y vuelta exacto.
    const sourceMultiplicity = yAssoc.get('sourceMultiplicity') as Association['sourceMultiplicity'];
    const targetMultiplicity = yAssoc.get('targetMultiplicity') as Association['targetMultiplicity'];

    const associationClassId = yAssoc.get('associationClassId') as string | undefined;

    associations.push(AssociationSchema.parse({
      id: yAssoc.get('id') as string,
      sourceClassId: yAssoc.get('sourceClassId') as string,
      targetClassId: yAssoc.get('targetClassId') as string,
      ...(sourceMultiplicity !== undefined ? { sourceMultiplicity } : {}),
      ...(targetMultiplicity !== undefined ? { targetMultiplicity } : {}),
      directed: yAssoc.get('directed') as boolean,
      aggregation,
      aggregationEnd,
      ...(name !== undefined ? { name } : {}),
      ...(sourceRole !== undefined ? { sourceRole } : {}),
      ...(targetRole !== undefined ? { targetRole } : {}),
      ...(associationClassId !== undefined ? { associationClassId } : {}),
    }));
  });

  const generalizations: Generalization[] = [];
  yGeneralizations.forEach((yGen) => {
    if (!(yGen instanceof Y.Map)) return;

    // Unidad 13c: nombre de etiqueta opcional (ausente en docs anteriores → undefined).
    const name = yGen.get('name') as string | undefined;
    generalizations.push(GeneralizationSchema.parse({
      id: yGen.get('id') as string,
      subClassId: yGen.get('subClassId') as string,
      superClassId: yGen.get('superClassId') as string,
      ...(name !== undefined ? { name } : {}),
    }));
  });

  const realizations: Realization[] = [];
  yRealizations.forEach((yReal) => {
    if (!(yReal instanceof Y.Map)) return;

    const name = yReal.get('name') as string | undefined;
    realizations.push(RealizationSchema.parse({
      id: yReal.get('id') as string,
      clientClassId: yReal.get('clientClassId') as string,
      supplierInterfaceId: yReal.get('supplierInterfaceId') as string,
      ...(name !== undefined ? { name } : {}),
    }));
  });

  const dependencies: Dependency[] = [];
  yDependencies.forEach((yDep) => {
    if (!(yDep instanceof Y.Map)) return;

    const name = yDep.get('name') as string | undefined;
    dependencies.push(DependencySchema.parse({
      id: yDep.get('id') as string,
      clientClassId: yDep.get('clientClassId') as string,
      supplierClassId: yDep.get('supplierClassId') as string,
      ...(name !== undefined ? { name } : {}),
    }));
  });

  const naryAssociations: NaryAssociation[] = [];
  yNaryAssociations.forEach((yNary) => {
    if (!(yNary instanceof Y.Map)) return;

    const name = yNary.get('name') as string | undefined;
    const memberEnds: NaryAssociation['memberEnds'] = [];
    const yEnds = yNary.get('memberEnds') as Y.Array<Y.Map<unknown>> | undefined;
    if (yEnds) {
      yEnds.forEach((yEnd) => {
        if (yEnd instanceof Y.Map) {
          const role = yEnd.get('role') as string | undefined;
          memberEnds.push({
            classId: yEnd.get('classId') as string,
            multiplicity: yEnd.get('multiplicity') as NaryAssociation['memberEnds'][number]['multiplicity'],
            ...(role !== undefined ? { role } : {}),
          });
        }
      });
    }

    naryAssociations.push(NaryAssociationSchema.parse({
      id: yNary.get('id') as string,
      memberEnds,
      ...(name !== undefined ? { name } : {}),
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
    naryAssociations,
  });
}

/**
 * Codifica un Y.Doc a un blob de actualización Uint8Array usando Y.encodeStateAsUpdate.
 * Este blob es el formato de persistencia autoritativo (invariante de diseño).
 */
export function encodeYDoc(doc: Y.Doc): Uint8Array {
  return Y.encodeStateAsUpdate(doc);
}

/**
 * Aplica un blob de actualización Yjs (Uint8Array) en un Y.Doc.
 * Retorna el Y.Doc modificado (misma instancia).
 * Lanza excepción si la actualización no se puede aplicar (blob corrupto).
 */
export function applyUpdateToYDoc(doc: Y.Doc, update: Uint8Array): Y.Doc {
  Y.applyUpdate(doc, update);
  return doc;
}

/**
 * Crea un Y.Doc limpio y le aplica un blob de actualización.
 * Función de utilidad para cargar desde la persistencia.
 * Lanza excepción si la actualización no se puede aplicar (blob corrupto).
 */
export function loadYDocFromUpdate(update: Uint8Array): Y.Doc {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, update);
  return doc;
}

/**
 * Valida que un Y.Doc se pueda proyectar a un Diagram válido.
 * Utilizado para verificación de auto-recuperación: si la proyección falla la validación Zod,
 * el doc jsonb almacenado está desfasado y debe regenerarse desde el blob.
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