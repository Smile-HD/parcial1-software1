/**
 * @app/core — IR canónico, esquemas de deltas y operaciones de aplicación/validación.
 * Fase 2 (PRs 2-3): Motor de IR + deltas.
 */
export {
  // Esquemas y tipos del IR
  MultiplicitySchema,
  MultiplicityEnum,
  VisibilitySchema,
  type Visibility,
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
  ClassKindSchema,
  type ClassKind,
  AssociationSchema,
  type Association,
  GeneralizationSchema,
  type Generalization,
  RealizationSchema,
  type Realization,
  DependencySchema,
  type Dependency,
  NaryMemberEndSchema,
  type NaryMemberEnd,
  NaryAssociationSchema,
  type NaryAssociation,
  DiagramSchema,
  type Diagram,
} from './ir.js';

export {
  // Esquemas y tipos de deltas (Fase 2.3)
  DeltaSchema,
  type Delta,
  ClassDeltaSchema,
  type ClassDelta,
  MemberDeltaSchema,
  type MemberDelta,
  AssociationDeltaSchema,
  type AssociationDelta,
  GeneralizationDeltaSchema,
  type GeneralizationDelta,
  RealizationDeltaSchema,
  type RealizationDelta,
  DependencyDeltaSchema,
  type DependencyDelta,
  NaryAssociationDeltaSchema,
  type NaryAssociationDelta,
  BatchDeltaSchema,
  type BatchDelta,
  deltaJsonSchema,
} from './delta.js';

export {
  // Interfaces de puertos (Fase 2.4)
  type DiagramRepository,
  type LlmPort,
  type SttPort,
  type VisionPort,
  type ImporterPort,
  type TemplateStore,
  type LlmResult,
} from './ports.js';

export {
  // Motor de aplicación (Fase 2.5 / PR 3)
  applyDelta,
  type ApplyResult,
  type ApplyError,
} from './apply.js';

export {
  // Códec Y.Doc (PR 4) — compartido por API y servidor colaborativo
  buildYDocFromDiagram,
  projectYDocToDiagram,
  encodeYDoc,
  applyUpdateToYDoc,
  loadYDocFromUpdate,
  validateYDocProjection,
} from './ydoc.js';

export const PACKAGE_NAME = '@app/core' as const;