import { z } from 'zod';
import { MultiplicitySchema, AggregationKindSchema } from './ir.js';

/**
 * Base delta fields shared by all delta types.
 */
const DeltaBase = z.object({
  id: z.string().uuid(),
  diagramId: z.string().uuid(),
  timestamp: z.string().datetime({ offset: true }),
});

/**
 * Class-level operations: create, rename, reposition, delete, update.
 * `classKind` (not `kind` — that is the delta discriminator) carries the
 * UML classifier kind on create and update (unit 12.1/12.4); `isAbstract`
 * toggles abstract marking. The `update` op must carry at least one of them.
 */
export const ClassDeltaSchema = DeltaBase.extend({
  kind: z.literal('class'),
  op: z.enum(['create', 'rename', 'reposition', 'delete', 'update']),
  classId: z.string().uuid(),
  // For create: name + position required
  name: z.string().min(1).optional(),
  position: z.object({ x: z.number(), y: z.number() }).optional(),
  // For rename: new name required
  newName: z.string().min(1).optional(),
  // For reposition: new position required
  newPosition: z.object({ x: z.number(), y: z.number() }).optional(),
  // Unit 12: classifier kind + abstract marking (create/update carriers)
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
 * Member-level operations: attribute/method add, edit, delete.
 */
export const MemberDeltaSchema = DeltaBase.extend({
  kind: z.literal('member'),
  op: z.enum(['addAttribute', 'editAttribute', 'deleteAttribute', 'addMethod', 'editMethod', 'deleteMethod']),
  classId: z.string().uuid(),
  memberId: z.string().uuid(),
  // For add/edit attribute
  name: z.string().min(1).optional(),
  type: z.string().min(1).optional(),
  // For add/edit method
  returnType: z.string().min(1).optional(),
  parameters: z.array(z.object({ name: z.string().min(1), type: z.string().min(1) })).optional(),
  // UML adornments (unit 9 — optional so legacy deltas stay valid)
  visibility: z.enum(['+', '-', '#', '~']).optional(),
  isStatic: z.boolean().optional(),
  isDerived: z.boolean().optional(),
  multiplicity: z.string().optional(),
}).strict();
export type MemberDelta = z.infer<typeof MemberDeltaSchema>;

/**
 * Association-level operations: create, update multiplicities, delete.
 * Aggregation, name, roles, and aggregationEnd are optional so legacy deltas stay valid.
 * Unit 13d fix C: create multiplicities are optional (an end may start
 * unspecified), and the update carriers are NULLABLE — `null` CLEARS an end
 * back to unspecified, a string sets it, and `undefined` keeps it (tri-state).
 */
export const AssociationDeltaSchema = DeltaBase.extend({
  kind: z.literal('association'),
  op: z.enum(['create', 'updateMultiplicity', 'delete']),
  associationId: z.string().uuid(),
  // For create
  sourceClassId: z.string().uuid().optional(),
  targetClassId: z.string().uuid().optional(),
  sourceMultiplicity: MultiplicitySchema.optional(),
  targetMultiplicity: MultiplicitySchema.optional(),
  directed: z.boolean().optional(),
  // Unit 10: optional aggregation, name, roles on create
  aggregation: AggregationKindSchema.optional(),
  aggregationEnd: z.enum(['source', 'target']).optional(),
  name: z.string().optional(),
  sourceRole: z.string().optional(),
  targetRole: z.string().optional(),
  // For updateMultiplicity (null = clear to unspecified)
  newSourceMultiplicity: MultiplicitySchema.nullable().optional(),
  newTargetMultiplicity: MultiplicitySchema.nullable().optional(),
}).strict();
export type AssociationDelta = z.infer<typeof AssociationDeltaSchema>;

/**
 * Generalization-level operations: create (subclass → superclass), update
 * (editable label — unit 13c) and delete. A `create` must carry both ends
 * (schema gate); an `update` must carry `name` (schema gate, mirroring the
 * class-update gate). Engine invariants (both classes exist, no duplicates,
 * no cycles) are enforced by applyDelta — unit 11.2.
 */
export const GeneralizationDeltaSchema = DeltaBase.extend({
  kind: z.literal('generalization'),
  op: z.enum(['create', 'update', 'delete']),
  generalizationId: z.string().uuid(),
  // For create: both ends required (enforced by the refinement below)
  subClassId: z.string().uuid().optional(),
  superClassId: z.string().uuid().optional(),
  // For update: the optional edge label (unit 13c)
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
 * Realization-level operations: create (client class → supplier interface),
 * update (editable label — unit 13c) and delete. A `create` must carry both
 * ends (schema gate); an `update` must carry `name` (schema gate). Engine
 * invariants (both exist, supplier is an interface, no duplicates) are
 * enforced by applyDelta — unit 12.2.
 */
export const RealizationDeltaSchema = DeltaBase.extend({
  kind: z.literal('realization'),
  op: z.enum(['create', 'update', 'delete']),
  realizationId: z.string().uuid(),
  // For create: both ends required (enforced by the refinement below)
  clientClassId: z.string().uuid().optional(),
  supplierInterfaceId: z.string().uuid().optional(),
  // For update: the optional edge label (unit 13c)
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
 * Dependency-level operations: create (client class → supplier class or
 * interface), update (editable label — unit 13c) and delete. A `create`
 * must carry both ends (schema gate); an `update` must carry `name`
 * (schema gate). Engine invariants (both exist, no duplicates) are
 * enforced by applyDelta — unit 12.2 (12b half). The supplier may be ANY
 * classifier (no interface requirement) and there is NO multiplicity.
 */
export const DependencyDeltaSchema = DeltaBase.extend({
  kind: z.literal('dependency'),
  op: z.enum(['create', 'update', 'delete']),
  dependencyId: z.string().uuid(),
  // For create: both ends required (enforced by the refinement below)
  clientClassId: z.string().uuid().optional(),
  supplierClassId: z.string().uuid().optional(),
  // For update: the optional edge label (unit 13c)
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
 * N-ary association-level operations: create (>=3 member ends), update
 * (name and/or member ends — unit 13d fix A) and delete. A `create` must
 * carry memberEnds (schema gate); an `update` must carry at least one of
 * `name` / `memberEnds` (schema gate, mirroring the class-update gate). The
 * engine invariants — every member class exists, >=3 ends, no duplicate
 * classId within one association — are enforced by applyDelta for BOTH
 * create and update (unit 13.1 / 13d). The ≥3 floor is deliberately NOT a
 * schema gate so a 2-end payload surfaces as a typed engine error
 * (NaryAssociationMinEndsError) instead of a thrown ZodError.
 */
export const NaryAssociationDeltaSchema = DeltaBase.extend({
  kind: z.literal('naryAssociation'),
  op: z.enum(['create', 'update', 'delete']),
  naryAssociationId: z.string().uuid(),
  // For create (required) and update (optional replacement): member ends.
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
 * Batch delta: atomic application of multiple deltas (all or nothing).
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
 * Discriminated union of all delta types.
 * This is the single schema used for validation and LLM structured output.
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
 * LLM-facing JSON Schema generated from the Zod delta union.
 * This is the single source of truth for LLM structured outputs (design D3).
 * Uses Zod v4's `z.toJSONSchema()`.
 */
export const deltaJsonSchema = z.toJSONSchema(DeltaSchema, {
  target: 'jsonSchema-2020-12',
  $refStrategy: 'none',
});