import { z } from 'zod';

/**
 * Multiplicity validation (editor:R4, MODIFIED by the 2026-08-31 UML 2.5.1
 * compliance amendment): the legacy four values stay valid, and the schema
 * now accepts the full UML 2.5.1 multiplicity grammar — `*` (many), `0`,
 * plain integers, and arbitrary ranges `m..n` / `m..*` with non-negative
 * integers. Non-numeric garbage is rejected.
 */
export const MultiplicitySchema = z
  .string()
  .regex(/^\*|^\d+$|^\d+\.\.\d+$|^\d+\.\.\*$/, 'Multiplicity must be *, an integer, or m..n / m..* with non-negative integers');
export type Multiplicity = z.infer<typeof MultiplicitySchema>;

/** The four legacy values remain accepted (they all match MultiplicitySchema). */
export const MultiplicityEnum = z.enum(['1', '0..1', '1..*', '0..*']);

/**
 * Position on the canvas (x, y coordinates).
 * Persisted as part of the IR per design decision.
 */
export const PositionSchema = z.object({
  x: z.number(),
  y: z.number(),
});
export type Position = z.infer<typeof PositionSchema>;

/**
 * UML visibility markers per UML 2.5.1 notation.
 */
export const VisibilitySchema = z.enum(['+', '-', '#', '~']);
export type Visibility = z.infer<typeof VisibilitySchema>;

/**
 * Attribute of a class: name + type, with UML adornments. All adornment
 * fields are optional with defaults so pre-compliance diagrams stay valid.
 */
export const AttributeSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  type: z.string().min(1),
  visibility: VisibilitySchema.default('+'),
  isStatic: z.boolean().default(false),
  isDerived: z.boolean().default(false),
  multiplicity: MultiplicitySchema.optional(),
});
export type Attribute = z.infer<typeof AttributeSchema>;

/**
 * Parameter of a method: name + type.
 */
export const ParameterSchema = z.object({
  name: z.string().min(1),
  type: z.string().min(1),
});
export type Parameter = z.infer<typeof ParameterSchema>;

/**
 * Method of a class: name + return type + parameter list, with visibility
 * and static adornments (instance-scope by default).
 */
export const MethodSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  returnType: z.string().min(1),
  parameters: z.array(ParameterSchema),
  visibility: VisibilitySchema.default('+'),
  isStatic: z.boolean().default(false),
});
export type Method = z.infer<typeof MethodSchema>;

/**
 * Classifier kind per UML 2.5.1: a plain class or an interface.
 * Defaults to 'class' so pre-unit-12 diagrams stay valid (backward compat).
 */
export const ClassKindSchema = z.enum(['class', 'interface']);
export type ClassKind = z.infer<typeof ClassKindSchema>;

/**
 * Class in the diagram: name, position, attributes, methods.
 * `kind` distinguishes classes from interfaces (unit 12.1); `isAbstract`
 * marks abstract classes. Both default to class/false for backward compat.
 */
export const ClassSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  position: PositionSchema,
  attributes: z.array(AttributeSchema),
  methods: z.array(MethodSchema),
  kind: ClassKindSchema.default('class'),
  isAbstract: z.boolean().default(false),
});
export type Class = z.infer<typeof ClassSchema>;

/**
 * Aggregation kind per UML 2.5.1: none (plain), shared (hollow diamond),
 * composite (filled diamond). Defaults to 'none' for backward compat.
 */
export const AggregationKindSchema = z.enum(['none', 'shared', 'composite']);
export type AggregationKind = z.infer<typeof AggregationKindSchema>;

/**
 * Association between two classes with multiplicities at each endpoint.
 * Aggregation/composition and association names/roles are optional (backward compat).
 * aggregationEnd explicitly declares which end owns the aggregation diamond ('source' or 'target'),
 * independent of drawing direction. Defaults to 'source' for backward compat with old diagrams.
 */
export const AssociationSchema = z.object({
  id: z.string().uuid(),
  sourceClassId: z.string().uuid(),
  targetClassId: z.string().uuid(),
  sourceMultiplicity: MultiplicitySchema,
  targetMultiplicity: MultiplicitySchema,
  directed: z.boolean(),
  aggregation: AggregationKindSchema.default('none'),
  aggregationEnd: z.enum(['source', 'target']).default('source'),
  name: z.string().optional(),
  sourceRole: z.string().optional(),
  targetRole: z.string().optional(),
});
export type Association = z.infer<typeof AssociationSchema>;

/**
 * Generalization (inheritance) edge between two classes: the subClass
 * inherits from the superClass (UML 2.5.1 generalization, rendered as a
 * solid line with a hollow triangle on the superclass end).
 * Cycle and duplicate invariants are enforced by the apply engine.
 */
export const GeneralizationSchema = z.object({
  id: z.string().uuid(),
  subClassId: z.string().uuid(),
  superClassId: z.string().uuid(),
});
export type Generalization = z.infer<typeof GeneralizationSchema>;

/**
 * Realization edge: a client classifier (class) realizes a supplier
 * interface (UML 2.5.1 realization, rendered as a dashed line with a
 * hollow triangle on the interface end). The supplier MUST have
 * `kind === 'interface'` — enforced by the apply engine (unit 12.2).
 */
export const RealizationSchema = z.object({
  id: z.string().uuid(),
  clientClassId: z.string().uuid(),
  supplierInterfaceId: z.string().uuid(),
});
export type Realization = z.infer<typeof RealizationSchema>;

/**
 * Dependency edge: a client classifier uses a supplier classifier
 * (UML 2.5.1 dependency, rendered as a dashed line with an open arrow on
 * the supplier end; no multiplicity). Unlike realization, the supplier
 * may be ANY class or interface — enforced by the apply engine (unit 12.2).
 */
export const DependencySchema = z.object({
  id: z.string().uuid(),
  clientClassId: z.string().uuid(),
  supplierClassId: z.string().uuid(),
});
export type Dependency = z.infer<typeof DependencySchema>;

/**
 * Diagram: the top-level IR containing classes, associations,
 * generalizations, realizations and dependencies. `generalizations`,
 * `realizations` and `dependencies` default to [] so pre-unit-11/12
 * diagrams stay valid (backward compat).
 */
export const DiagramSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  classes: z.array(ClassSchema),
  associations: z.array(AssociationSchema),
  generalizations: z.array(GeneralizationSchema).default([]),
  realizations: z.array(RealizationSchema).default([]),
  dependencies: z.array(DependencySchema).default([]),
});
export type Diagram = z.infer<typeof DiagramSchema>;