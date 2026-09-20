/**
 * @app/codegen — Núcleo de generación de backend Spring desde IR.
 *
 * 14a incluye el sanitizador de nombres + guarda de raíz de salida y el mapa
 * en memoria IR→archivo (tablas de mapeo + recolector de advertencias). Las plantillas
 * Handlebars, la compilación de referencia y la API de trabajos HTTP llegan en 14b/14c/14d.
 */
export const PACKAGE_NAME = '@app/codegen' as const;

export {
  NameSanitizerError,
  assertInsideOutputRoot,
  isReservedJavaName,
  normalizeJavaIdentifier,
  sanitizeJavaName,
} from './sanitize.js';

export {
  generate,
  mapAttributeType,
  classifyMultiplicity,
  planStubRenderer,
  defaultReturnValue,
  TYPE_MAPPING,
  MULTIPLICITY_MAPPING,
  type Cardinality,
  type CodegenWarning,
  type EntityFieldModel,
  type EntityMethodModel,
  type EntityModel,
  type EntityRelationshipModel,
  type GeneratedFile,
  type GeneratedFileKind,
  type GenerateOptions,
  type GenerationResult,
  type RelationshipKind,
  type Renderer,
} from './generate.js';

export {
  createHandlebarsRenderer,
  DEFAULT_TEMPLATES_DIR,
  MAVEN_WRAPPER_TEMPLATE,
} from './render.js';
