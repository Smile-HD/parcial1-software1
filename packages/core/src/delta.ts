import { z } from 'zod';
import { MultiplicitySchema } from './ir.js';

/**
 * Base delta fields shared by all delta types.
 */
const DeltaBase = z.object({
  id: z.string().uuid(),
  diagramId: z.string().uuid(),
  timestamp: z.string().datetime({ offset: true }),
});

/**
 * Class-level operations: create, rename, reposition, delete.
 */
export const ClassDeltaSchema = DeltaBase.extend({
  kind: z.literal('class'),
  op: z.enum(['create', 'rename', 'reposition', 'delete']),
  classId: z.string().uuid(),
  // For create: name + position required
  name: z.string().min(1).optional(),
  position: z.object({ x: z.number(), y: z.number() }).optional(),
  // For rename: new name required
  newName: z.string().min(1).optional(),
  // For reposition: new position required
  newPosition: z.object({ x: z.number(), y: z.number() }).optional(),
}).strict();
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
  // For updateMultiplicity
  newSourceMultiplicity: MultiplicitySchema.optional(),
  newTargetMultiplicity: MultiplicitySchema.optional(),
}).strict();
export type AssociationDelta = z.infer<typeof AssociationDeltaSchema>;

/**
 * Batch delta: atomic application of multiple deltas (all or nothing).
 */
export const BatchDeltaSchema = DeltaBase.extend({
  kind: z.literal('batch'),
  deltas: z.array(z.union([
    ClassDeltaSchema,
    MemberDeltaSchema,
    AssociationDeltaSchema,
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