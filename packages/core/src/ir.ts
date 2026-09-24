import { z } from 'zod';

/**
 * Validación de multiplicidad (editor:R4, MODIFICADO por la enmienda de
 * cumplimiento UML 2.5.1 del 2026-08-31): los cuatro valores heredados siguen
 * siendo válidos y el esquema ahora acepta la gramática completa de multiplicidad
 * de UML 2.5.1 — `*` (muchos), `0`, enteros simples y rangos arbitrarios `m..n` /
 * `m..*` con enteros no negativos. Cualquier valor no numérico inválido es rechazado.
 */
export const MultiplicitySchema = z
  .string()
  .regex(/^\*|^\d+$|^\d+\.\.\d+$|^\d+\.\.\*$/, 'Multiplicity must be *, an integer, or m..n / m..* with non-negative integers');
export type Multiplicity = z.infer<typeof MultiplicitySchema>;

/** Los cuatro valores heredados siguen siendo aceptados (todos coinciden con MultiplicitySchema). */
export const MultiplicityEnum = z.enum(['1', '0..1', '1..*', '0..*']);

/**
 * Posición en el lienzo (coordenadas x, y).
 * Persistida como parte del IR por decisión de diseño.
 */
export const PositionSchema = z.object({
  x: z.number(),
  y: z.number(),
});
export type Position = z.infer<typeof PositionSchema>;

/**
 * Marcadores de visibilidad UML según la notación UML 2.5.1.
 */
export const VisibilitySchema = z.enum(['+', '-', '#', '~']);
export type Visibility = z.infer<typeof VisibilitySchema>;

/**
 * Atributo de una clase: nombre + tipo, con adornos UML. Todos los campos de adornos
 * son opcionales con valores predeterminados para que los diagramas antiguos sigan siendo válidos.
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
 * Parámetro de un método: nombre + tipo.
 */
export const ParameterSchema = z.object({
  name: z.string().min(1),
  type: z.string().min(1),
});
export type Parameter = z.infer<typeof ParameterSchema>;

/**
 * Método de una clase: nombre + tipo de retorno + lista de parámetros, con visibilidad
 * y adornos estáticos (ámbito de instancia por defecto).
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
 * Tipo de clasificador según UML 2.5.1: una clase normal o una interfaz.
 * Por defecto 'class' para que los diagramas previos a la unidad 12 sigan siendo válidos.
 */
export const ClassKindSchema = z.enum(['class', 'interface']);
export type ClassKind = z.infer<typeof ClassKindSchema>;

/**
 * Clase en el diagrama: nombre, posición, atributos, métodos.
 * `kind` distingue clases de interfaces (unidad 12.1); `isAbstract`
 * marca clases abstractas. Ambos usan valores por defecto (class/false) por compatibilidad.
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
 * Tipo de agregación según UML 2.5.1: none (simple), shared (diamante hueco),
 * composite (diamante relleno). Por defecto 'none' por compatibilidad.
 */
export const AggregationKindSchema = z.enum(['none', 'shared', 'composite']);
export type AggregationKind = z.infer<typeof AggregationKindSchema>;

/**
 * Asociación entre dos clases con multiplicidades en cada extremo.
 * La agregación/composición y los nombres/roles son opcionales (compatibilidad hacia atrás).
 * aggregationEnd declara explícitamente qué extremo posee el diamante de agregación ('source' o 'target'),
 * independiente de la dirección de trazado. Por defecto 'source'.
 * Corrección de unidad 13d C: las multiplicidades de los extremos son OPCIONALES — un extremo puede
 * no estar especificado (según la convención UML de que un nuevo conector no asume multiplicidad).
 */
export const AssociationSchema = z.object({
  id: z.string().uuid(),
  sourceClassId: z.string().uuid(),
  targetClassId: z.string().uuid(),
  sourceMultiplicity: MultiplicitySchema.optional(),
  targetMultiplicity: MultiplicitySchema.optional(),
  directed: z.boolean(),
  aggregation: AggregationKindSchema.default('none'),
  aggregationEnd: z.enum(['source', 'target']).default('source'),
  name: z.string().optional(),
  sourceRole: z.string().optional(),
  targetRole: z.string().optional(),
  associationClassId: z.string().uuid().optional(),
});
export type Association = z.infer<typeof AssociationSchema>;

/**
 * Arista de generalización (herencia) entre dos clases: la subClase
 * hereda de la superClase (generalización UML 2.5.1, representada como una
 * línea sólida con un triángulo hueco en el extremo de la superclase).
 * Las invariantes de ciclos y duplicados son aplicadas por el motor applyDelta.
 * `name` es una etiqueta editable opcional (unidad 13c).
 */
export const GeneralizationSchema = z.object({
  id: z.string().uuid(),
  subClassId: z.string().uuid(),
  superClassId: z.string().uuid(),
  name: z.string().optional(),
});
export type Generalization = z.infer<typeof GeneralizationSchema>;

/**
 * Arista de realización: un clasificador cliente (clase) realiza una interfaz
 * proveedora (realización UML 2.5.1, representada como línea segmentada con
 * triángulo hueco en el extremo de la interfaz). El proveedor DEBE tener
 * `kind === 'interface'` — verificado por el motor applyDelta (unidad 12.2).
 * `name` es una etiqueta editable opcional (unidad 13c).
 */
export const RealizationSchema = z.object({
  id: z.string().uuid(),
  clientClassId: z.string().uuid(),
  supplierInterfaceId: z.string().uuid(),
  name: z.string().optional(),
});
export type Realization = z.infer<typeof RealizationSchema>;

/**
 * Arista de dependencia: un clasificador cliente usa un clasificador proveedor
 * (dependencia UML 2.5.1, representada como línea segmentada con flecha abierta en
 * el extremo proveedor; sin multiplicidad). A diferencia de la realización, el
 * proveedor puede ser CUALQUIER clase o interfaz — verificado por el motor applyDelta (unidad 12.2).
 * `name` es una etiqueta editable opcional (unidad 13c).
 */
export const DependencySchema = z.object({
  id: z.string().uuid(),
  clientClassId: z.string().uuid(),
  supplierClassId: z.string().uuid(),
  name: z.string().optional(),
});
export type Dependency = z.infer<typeof DependencySchema>;

/**
 * Un extremo miembro de una asociación n-aria: la clase participante junto con su
 * propia multiplicidad y rol opcional (editor:R N-ary, unidad 13.1).
 */
export const NaryMemberEndSchema = z.object({
  classId: z.string().uuid(),
  multiplicity: MultiplicitySchema,
  role: z.string().optional(),
});
export type NaryMemberEnd = z.infer<typeof NaryMemberEndSchema>;

/**
 * Asociación n-aria: una única asociación que conecta TRES O MÁS clases
 * mediante un diamante central (asociación n-aria UML 2.5.1, unidad 13.1).
 * Mantenida en su PROPIA colección para no afectar la ruta de asociaciones binarias
 * (decisión de diseño D13). El límite `min(3)` asegura la integridad del IR: el motor
 * applyDelta elimina asociaciones n-arias por debajo de este umbral al borrar clases miembros.
 */
export const NaryAssociationSchema = z.object({
  id: z.string().uuid(),
  memberEnds: z.array(NaryMemberEndSchema).min(3),
  name: z.string().optional(),
});
export type NaryAssociation = z.infer<typeof NaryAssociationSchema>;

/**
 * Diagrama: el IR de nivel superior que contiene clases, asociaciones,
 * generalizaciones, realizaciones, dependencias y asociaciones n-arias.
 * `generalizations`, `realizations`, `dependencies` y `naryAssociations`
 * usan valor predeterminado [] para asegurar compatibilidad hacia atrás.
 */
export const DiagramSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  classes: z.array(ClassSchema),
  associations: z.array(AssociationSchema),
  generalizations: z.array(GeneralizationSchema).default([]),
  realizations: z.array(RealizationSchema).default([]),
  dependencies: z.array(DependencySchema).default([]),
  naryAssociations: z.array(NaryAssociationSchema).default([]),
});
export type Diagram = z.infer<typeof DiagramSchema>;