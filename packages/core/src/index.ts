/**
 * @app/core — Canonical IR, delta schemas, and apply/validate operations.
 * Phase 2 (PRs 2-3): IR + delta engine.
 */
export {
  // IR schemas and types
  MultiplicityEnum,
  type Multiplicity,
  PositionSchema,
  type Position,
  AttributeSchema,
  type Attribute,
  ParameterSchema,
  type Parameter,
  MethodSchema,
  type Method,
  ClassSchema,
  type Class,
  AssociationSchema,
  type Association,
  DiagramSchema,
  type Diagram,
} from './ir.js';

export {
  // Delta schemas and types (Phase 2.3)
  DeltaSchema,
  type Delta,
  ClassDeltaSchema,
  type ClassDelta,
  MemberDeltaSchema,
  type MemberDelta,
  AssociationDeltaSchema,
  type AssociationDelta,
  BatchDeltaSchema,
  type BatchDelta,
  deltaJsonSchema,
} from './delta.js';

export {
  // Port interfaces (Phase 2.4)
  type DiagramRepository,
  type LlmPort,
  type SttPort,
  type VisionPort,
  type ImporterPort,
  type TemplateStore,
  type LlmResult,
} from './ports.js';

export {
  // Apply engine (Phase 2.5 / PR 3)
  applyDelta,
  type ApplyResult,
  type ApplyError,
} from './apply.js';

export const PACKAGE_NAME = '@app/core' as const;