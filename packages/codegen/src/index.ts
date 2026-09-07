/**
 * @app/codegen — IR → Spring backend generation core.
 *
 * 14a ships the name sanitizer + output-root guard and the in-memory IR→file
 * map (mapping tables + warning collector). Handlebars templates, the golden
 * build and the HTTP job API land in 14b/14c/14d.
 */
export const PACKAGE_NAME = '@app/codegen' as const;

export {
  NameSanitizerError,
  assertInsideOutputRoot,
  isReservedJavaName,
  sanitizeJavaName,
} from './sanitize.js';

export {
  generate,
  mapAttributeType,
  classifyMultiplicity,
  planStubRenderer,
  TYPE_MAPPING,
  MULTIPLICITY_MAPPING,
  type Cardinality,
  type CodegenWarning,
  type EntityFieldModel,
  type EntityModel,
  type EntityRelationshipModel,
  type GeneratedFile,
  type GeneratedFileKind,
  type GenerateOptions,
  type GenerationResult,
  type RelationshipKind,
  type Renderer,
} from './generate.js';
