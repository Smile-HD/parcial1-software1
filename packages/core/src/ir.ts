import { z } from 'zod';

/**
 * Multiplicity enum for association endpoints.
 * Only these four values are allowed per editor:R4.
 */
export const MultiplicityEnum = z.enum(['1', '0..1', '1..*', '0..*']);
export type Multiplicity = z.infer<typeof MultiplicityEnum>;

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
 * Attribute of a class: name + type.
 */
export const AttributeSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  type: z.string().min(1),
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
 * Method of a class: name + return type + parameter list.
 */
export const MethodSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  returnType: z.string().min(1),
  parameters: z.array(ParameterSchema),
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
  sourceMultiplicity: MultiplicityEnum,
  targetMultiplicity: MultiplicityEnum,
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