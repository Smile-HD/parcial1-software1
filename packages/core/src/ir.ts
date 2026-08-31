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
 * Class in the diagram: name, position, attributes, methods.
 */
export const ClassSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  position: PositionSchema,
  attributes: z.array(AttributeSchema),
  methods: z.array(MethodSchema),
});
export type Class = z.infer<typeof ClassSchema>;

/**
 * Association between two classes with multiplicities at each endpoint.
 */
export const AssociationSchema = z.object({
  id: z.string().uuid(),
  sourceClassId: z.string().uuid(),
  targetClassId: z.string().uuid(),
  sourceMultiplicity: MultiplicitySchema,
  targetMultiplicity: MultiplicitySchema,
  directed: z.boolean(),
});
export type Association = z.infer<typeof AssociationSchema>;

/**
 * Diagram: the top-level IR containing classes and associations.
 */
export const DiagramSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  classes: z.array(ClassSchema),
  associations: z.array(AssociationSchema),
});
export type Diagram = z.infer<typeof DiagramSchema>;