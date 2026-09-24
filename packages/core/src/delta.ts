import { z } from 'zod';
import { MultiplicitySchema, AggregationKindSchema } from './ir.js';

/**
 * Campos base compartidos por todos los tipos de deltas.
 */
const DeltaBase = z.object({
  id: z.string().uuid(),
  diagramId: z.string().uuid(),
  timestamp: z.string().datetime({ offset: true }),
});

/**
 * Operaciones a nivel de clase: create, rename, reposition, delete, update.
 * `classKind` (no `kind` — ese es el discriminador del delta) transporta el tipo
 * de clasificador UML en create y update (unidad 12.1/12.4); `isAbstract`
 * conmuta el marcado de clase abstracta. La operación `update` debe incluir al menos uno de ellos.
 */
export const ClassDeltaSchema = DeltaBase.extend({
  kind: z.literal('class'),
  op: z.enum(['create', 'rename', 'reposition', 'delete', 'update']),
  classId: z.string().uuid(),
  // Para create: name + position requeridos
  name: z.string().min(1).optional(),
  position: z.object({ x: z.number(), y: z.number() }).optional(),
  // Para rename: newName requerido
  newName: z.string().min(1).optional(),
  // Para reposition: newPosition requerida
  newPosition: z.object({ x: z.number(), y: z.number() }).optional(),
  // Unidad 12: tipo de clasificador + marcado abstracto (en create/update)
  classKind: z.enum(['class', 'interface']).optional(),
  isAbstract: z.boolean().optional(),
}).strict().superRefine((delta, ctx) => {
  if (delta.op === 'update' && delta.classKind === undefined && delta.isAbstract === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Class update requires at least one of classKind or isAbstract',
    });
  }
});
export type ClassDelta = z.infer<typeof ClassDeltaSchema>;

/**
 * Operaciones a nivel de miembro: adición, edición y eliminación de atributos o métodos.
 */
export const MemberDeltaSchema = DeltaBase.extend({
  kind: z.literal('member'),
  op: z.enum(['addAttribute', 'editAttribute', 'deleteAttribute', 'addMethod', 'editMethod', 'deleteMethod']),
  classId: z.string().uuid(),
  memberId: z.string().uuid(),
  // Para add/edit attribute
  name: z.string().min(1).optional(),
  type: z.string().min(1).optional(),
  // Para add/edit method
  returnType: z.string().min(1).optional(),
  parameters: z.array(z.object({ name: z.string().min(1), type: z.string().min(1) })).optional(),
  // Adornos UML (unidad 9 — opcionales para preservar deltas antiguos)
  visibility: z.enum(['+', '-', '#', '~']).optional(),
  isStatic: z.boolean().optional(),
  isDerived: z.boolean().optional(),
  multiplicity: z.string().optional(),
}).strict();
export type MemberDelta = z.infer<typeof MemberDeltaSchema>;

/**
 * Operaciones a nivel de asociación: create, updateMultiplicity, delete.
 * Agregación, nombre, roles y aggregationEnd son opcionales para retrocompatibilidad.
 * Corrección de unidad 13d C: en create las multiplicidades son opcionales (un extremo puede
 * iniciar sin especificar), y en update son anulables — `null` RESTABLECE el extremo
 * a no especificado, un string lo establece, y `undefined` lo conserva (tri-estado).
 */
export const AssociationDeltaSchema = DeltaBase.extend({
  kind: z.literal('association'),
  op: z.enum(['create', 'updateMultiplicity', 'delete']),
  associationId: z.string().uuid(),
  // Para create
  sourceClassId: z.string().uuid().optional(),
  targetClassId: z.string().uuid().optional(),
  sourceMultiplicity: MultiplicitySchema.optional(),
  targetMultiplicity: MultiplicitySchema.optional(),
  directed: z.boolean().optional(),
  // Unidad 10: agregación, nombre y roles opcionales en create
  aggregation: AggregationKindSchema.optional(),
  aggregationEnd: z.enum(['source', 'target']).optional(),
  name: z.string().optional(),
  sourceRole: z.string().optional(),
  targetRole: z.string().optional(),
  associationClassId: z.string().uuid().optional(),
  // Para updateMultiplicity (null = restablecer a no especificado)
  newSourceMultiplicity: MultiplicitySchema.nullable().optional(),
  newTargetMultiplicity: MultiplicitySchema.nullable().optional(),
  newAssociationClassId: z.string().uuid().nullable().optional(),
}).strict();
export type AssociationDelta = z.infer<typeof AssociationDeltaSchema>;

/**
 * Operaciones a nivel de generalización: create (subclase → superclase), update
 * (etiqueta editable — unidad 13c) y delete. Un `create` debe transportar ambos extremos
 * (filtro de esquema); un `update` debe transportar `name` (filtro de esquema). Las invariantes
 * del motor (ambas clases existen, sin duplicados, sin ciclos) son verificadas por applyDelta — unidad 11.2.
 */
export const GeneralizationDeltaSchema = DeltaBase.extend({
  kind: z.literal('generalization'),
  op: z.enum(['create', 'update', 'delete']),
  generalizationId: z.string().uuid(),
  // Para create: ambos extremos requeridos (verificado por el superRefine)
  subClassId: z.string().uuid().optional(),
  superClassId: z.string().uuid().optional(),
  // Para update: etiqueta opcional de arista (unidad 13c)
  name: z.string().optional(),
}).strict().superRefine((delta, ctx) => {
  if (delta.op === 'create' && (!delta.subClassId || !delta.superClassId)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Generalization create requires subClassId and superClassId',
    });
  }
  if (delta.op === 'update' && delta.name === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Generalization update requires name',
    });
  }
});
export type GeneralizationDelta = z.infer<typeof GeneralizationDeltaSchema>;

/**
 * Operaciones a nivel de realización: create (clase cliente → interfaz proveedora),
 * update (etiqueta editable — unidad 13c) y delete. Un `create` debe transportar ambos
 * extremos (filtro de esquema); un `update` debe transportar `name`. Las invariantes
 * del motor (ambos existen, proveedor es interfaz, sin duplicados) son verificadas por applyDelta — unidad 12.2.
 */
export const RealizationDeltaSchema = DeltaBase.extend({
  kind: z.literal('realization'),
  op: z.enum(['create', 'update', 'delete']),
  realizationId: z.string().uuid(),
  // Para create: ambos extremos requeridos (verificado por el superRefine)
  clientClassId: z.string().uuid().optional(),
  supplierInterfaceId: z.string().uuid().optional(),
  // Para update: etiqueta opcional de arista (unidad 13c)
  name: z.string().optional(),
}).strict().superRefine((delta, ctx) => {
  if (delta.op === 'create' && (!delta.clientClassId || !delta.supplierInterfaceId)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Realization create requires clientClassId and supplierInterfaceId',
    });
  }
  if (delta.op === 'update' && delta.name === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Realization update requires name',
    });
  }
});
export type RealizationDelta = z.infer<typeof RealizationDeltaSchema>;

/**
 * Operaciones a nivel de dependencia: create (clase cliente → clase o interfaz proveedora),
 * update (etiqueta editable — unidad 13c) y delete. Un `create` debe transportar ambos extremos;
 * un `update` debe transportar `name`. Invariantes verificadas por applyDelta — unidad 12.2 (12b).
 * El proveedor puede ser CUALQUIER clasificador (sin requisito de ser interfaz) y NO lleva multiplicidad.
 */
export const DependencyDeltaSchema = DeltaBase.extend({
  kind: z.literal('dependency'),
  op: z.enum(['create', 'update', 'delete']),
  dependencyId: z.string().uuid(),
  // Para create: ambos extremos requeridos
  clientClassId: z.string().uuid().optional(),
  supplierClassId: z.string().uuid().optional(),
  // Para update: etiqueta opcional de arista (unidad 13c)
  name: z.string().optional(),
}).strict().superRefine((delta, ctx) => {
  if (delta.op === 'create' && (!delta.clientClassId || !delta.supplierClassId)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Dependency create requires clientClassId and supplierClassId',
    });
  }
  if (delta.op === 'update' && delta.name === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Dependency update requires name',
    });
  }
});
export type DependencyDelta = z.infer<typeof DependencyDeltaSchema>;

/**
 * Operaciones a nivel de asociación n-aria: create (>=3 extremos miembros), update
 * (nombre y/o extremos miembros — corrección unidad 13d A) y delete. Un `create` debe
 * transportar memberEnds; un `update` debe transportar al menos uno de `name` o `memberEnds`.
 * Las invariantes del motor (todas las clases existen, >=3 extremos, sin clases duplicadas)
 * son verificadas por applyDelta tanto para create como para update (unidad 13.1 / 13d).
 * El piso ≥3 deliberadamente NO es filtro de esquema para que un payload de 2 extremos
 * se reporte como error tipado del motor (NaryAssociationMinEndsError) en vez de ZodError.
 */
export const NaryAssociationDeltaSchema = DeltaBase.extend({
  kind: z.literal('naryAssociation'),
  op: z.enum(['create', 'update', 'delete']),
  naryAssociationId: z.string().uuid(),
  // Para create (requerido) y update (reemplazo opcional): extremos miembros.
  memberEnds: z.array(z.object({
    classId: z.string().uuid(),
    multiplicity: MultiplicitySchema,
    role: z.string().optional(),
  })).optional(),
  name: z.string().optional(),
}).strict().superRefine((delta, ctx) => {
  if (delta.op === 'create' && (!delta.memberEnds || delta.memberEnds.length === 0)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'NaryAssociation create requires memberEnds',
    });
  }
  if (delta.op === 'update' && delta.name === undefined && delta.memberEnds === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'NaryAssociation update requires name or memberEnds',
    });
  }
});
export type NaryAssociationDelta = z.infer<typeof NaryAssociationDeltaSchema>;

/**
 * Delta de lote (batch): aplicación atómica de múltiples deltas (todo o nada).
 */
export const BatchDeltaSchema = DeltaBase.extend({
  kind: z.literal('batch'),
  deltas: z.array(z.union([
    ClassDeltaSchema,
    MemberDeltaSchema,
    AssociationDeltaSchema,
    GeneralizationDeltaSchema,
    RealizationDeltaSchema,
    DependencyDeltaSchema,
    NaryAssociationDeltaSchema,
  ])),
}).strict();
export type BatchDelta = z.infer<typeof BatchDeltaSchema>;

/**
 * Unión discriminada de todos los tipos de deltas.
 * Es el esquema único utilizado para validación y salida estructurada del LLM.
 */
export const DeltaSchema = z.discriminatedUnion('kind', [
  ClassDeltaSchema,
  MemberDeltaSchema,
  AssociationDeltaSchema,
  GeneralizationDeltaSchema,
  RealizationDeltaSchema,
  DependencyDeltaSchema,
  NaryAssociationDeltaSchema,
  BatchDeltaSchema,
]);
export type Delta = z.infer<typeof DeltaSchema>;

/**
 * JSON Schema orientado al LLM generado a partir de la unión Zod de deltas.
 * Es la fuente única de verdad para las salidas estructuradas del LLM (diseño D3).
 * Utiliza `z.toJSONSchema()` de Zod v4.
 */
export const deltaJsonSchema = z.toJSONSchema(DeltaSchema, {
  target: 'jsonSchema-2020-12',
  $refStrategy: 'none',
});