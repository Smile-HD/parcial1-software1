import type { Association, Attribute, Class, Diagram } from '@app/core';

import { assertInsideOutputRoot, sanitizeJavaName } from './sanitize.js';

/**
 * IR → Spring file map generator (unit 14a).
 *
 * This module turns the canonical `@app/core` IR into an IN-MEMORY plan: a list
 * of {@link GeneratedFile} entries (sanitized path + kind + template id + render
 * model) plus a {@link CodegenWarning} collector. It performs NO filesystem
 * writes and needs NO Maven build — that is the point of the 14a/14b seam.
 *
 * Seam for 14b: the rendered text comes from an injectable {@link Renderer}.
 * 14a ships {@link planStubRenderer} (a deterministic placeholder) purely so the
 * map is complete and testable; 14b injects a Handlebars renderer WITHOUT
 * changing any type here or the mapping tables below.
 */

// ---------- public result types ----------

export type GeneratedFileKind = 'source' | 'resource' | 'build';

export interface GeneratedFile {
  /** POSIX path relative to the job output root, sanitized + containment-checked. */
  path: string;
  kind: GeneratedFileKind;
  /** Template id the renderer resolves (Handlebars template in 14b). */
  template: string;
  /** IR→JPA mapping result the template renders from. */
  model: unknown;
  /** Rendered text via the injected renderer. */
  content: string;
}

export interface CodegenWarning {
  /** Stable machine code, e.g. `unmapped-type`, `missing-endpoint`. */
  code: string;
  /** Human-readable message naming the offending element. */
  message: string;
  /** The element the warning refers to (e.g. `Product.name` or an id). */
  element: string;
}

export type Renderer = (template: string, model: unknown) => string;

export interface GenerateOptions {
  /** Absolute job output root used for containment assertions. */
  outputRoot: string;
  /** Base Java package for generated sources (default `com.example.generated`). */
  basePackage?: string;
  /** Renderer seam; defaults to {@link planStubRenderer}. 14b injects Handlebars. */
  render?: Renderer;
}

export interface GenerationResult {
  files: GeneratedFile[];
  warnings: CodegenWarning[];
}

// ---------- entity render models (the "content plan") ----------

export interface EntityFieldModel {
  /** Sanitized Java field name. */
  name: string;
  /** Mapped Java type, or `String` when the UML type is unmapped. */
  javaType: string;
  /** Original declared UML type (kept so 14b/templates can report it). */
  declaredType: string;
  visibility: '+' | '-' | '#' | '~';
  isStatic: boolean;
  isDerived: boolean;
  /** Attribute multiplicity, or null when unspecified. */
  multiplicity: string | null;
}

export type RelationshipKind = 'OneToMany' | 'ManyToOne' | 'ManyToMany' | 'OneToOne';

export interface EntityRelationshipModel {
  associationId: string;
  /** Java name of the entity on the other end. */
  targetEntity: string;
  kind: RelationshipKind;
  /** Which association end owns the FK (documented per mapping table). */
  owningSide: 'source' | 'target';
  thisSideIsOwning: boolean;
  sourceMultiplicity: string | null;
  targetMultiplicity: string | null;
}

export interface EntityModel {
  className: string;
  packageName: string;
  fields: EntityFieldModel[];
  relationships: EntityRelationshipModel[];
}

// ---------- mapping table 1: UML attribute type -> Java type ----------

/**
 * UML attribute type → Java field type (case-insensitive lookup by lowercased
 * key). Documented per codegen:R2. A type absent from this table is NOT an
 * error: {@link mapAttributeType} falls back to `String` and records a warning.
 *
 * | UML type            | Java type       |
 * |---------------------|-----------------|
 * | string              | String          |
 * | int / integer       | Integer         |
 * | long                | Long            |
 * | float               | Float           |
 * | double              | Double          |
 * | boolean             | Boolean         |
 * | char / character    | Character       |
 * | bigdecimal          | BigDecimal      |
 * | date                | LocalDate       |
 * | datetime / timestamp| LocalDateTime   |
 * | time                | LocalTime       |
 */
export const TYPE_MAPPING: Readonly<Record<string, string>> = {
  string: 'String',
  int: 'Integer',
  integer: 'Integer',
  long: 'Long',
  float: 'Float',
  double: 'Double',
  boolean: 'Boolean',
  char: 'Character',
  character: 'Character',
  bigdecimal: 'BigDecimal',
  date: 'LocalDate',
  datetime: 'LocalDateTime',
  timestamp: 'LocalDateTime',
  time: 'LocalTime',
};

/** Map a declared UML attribute type to a Java type, flagging unmapped types. */
export function mapAttributeType(declaredType: string): { javaType: string; mapped: boolean } {
  const javaType = TYPE_MAPPING[declaredType.toLowerCase()];
  if (javaType === undefined) {
    return { javaType: 'String', mapped: false };
  }
  return { javaType, mapped: true };
}

// ---------- mapping table 2: association multiplicities -> JPA relation ----------

export type Cardinality = 'one' | 'zeroOrOne' | 'many' | 'zero' | 'unknown';

/**
 * Classify an endpoint multiplicity into a JPA-relevant cardinality.
 * Accepts the full UML 2.5.1 grammar the IR allows (`*`, integers, `m..n`,
 * `m..*`); `undefined` (an unspecified end) is `unknown`.
 */
export function classifyMultiplicity(multiplicity: string | undefined): Cardinality {
  if (multiplicity === undefined) return 'unknown';
  if (multiplicity === '*') return 'many';

  let lower: number;
  let upper: number;
  const range = /^(\d+)\.\.(\d+|\*)$/.exec(multiplicity);
  const single = /^(\d+)$/.exec(multiplicity);
  if (range) {
    lower = Number(range[1]);
    upper = range[2] === '*' ? Number.POSITIVE_INFINITY : Number(range[2]);
  } else if (single) {
    lower = Number(single[1]);
    upper = Number(single[1]);
  } else {
    return 'unknown';
  }

  if (upper === 0) return 'zero';
  if (upper === 1) return lower === 1 ? 'one' : 'zeroOrOne';
  return 'many';
}

/**
 * Association endpoint cardinalities → JPA relationship kind, keyed by
 * `${sourceEnd}:${targetEnd}` where each end is normalized to `one` or `many`
 * (a `0..1` end behaves as a to-one end for relationship selection).
 *
 * Documented per the spec "Relation Mapping From Associations":
 *
 * | source : target | relationship              | owning side            |
 * |-----------------|---------------------------|------------------------|
 * | one   : many    | @OneToMany / @ManyToOne   | many (target)          |
 * | many  : one     | @ManyToOne / @OneToMany   | many (source)          |
 * | many  : many    | @ManyToMany (both)        | join table (neither)   |
 * | one   : one     | @OneToOne                 | source (documented)    |
 *
 * Pairs involving `zero`/`unknown` are unmapped → warning, relationship skipped.
 */
export const MULTIPLICITY_MAPPING: Readonly<Record<string, RelationshipKind>> = {
  'one:many': 'OneToMany',
  'many:one': 'ManyToOne',
  'many:many': 'ManyToMany',
  'one:one': 'OneToOne',
};

/** Normalize a cardinality to the to-one / to-many axis used by the table. */
function toEnd(card: Cardinality): 'one' | 'many' | null {
  if (card === 'many') return 'many';
  if (card === 'one' || card === 'zeroOrOne') return 'one';
  return null; // 'zero' | 'unknown'
}

interface ResolvedPair {
  kind: RelationshipKind;
  sourceOwning: boolean;
  targetOwning: boolean;
  owningSide: 'source' | 'target';
}

/** Resolve an association's endpoint multiplicities into a JPA relationship. */
function resolvePair(
  sourceMult: string | undefined,
  targetMult: string | undefined,
): ResolvedPair | null {
  const sourceEnd = toEnd(classifyMultiplicity(sourceMult));
  const targetEnd = toEnd(classifyMultiplicity(targetMult));
  if (sourceEnd === null || targetEnd === null) return null;

  const kind = MULTIPLICITY_MAPPING[`${sourceEnd}:${targetEnd}`];
  if (kind === undefined) return null;

  switch (kind) {
    case 'OneToMany':
      return { kind, sourceOwning: false, targetOwning: true, owningSide: 'target' };
    case 'ManyToOne':
      return { kind, sourceOwning: true, targetOwning: false, owningSide: 'source' };
    case 'ManyToMany':
      return { kind, sourceOwning: false, targetOwning: false, owningSide: 'source' };
    case 'OneToOne':
      return { kind, sourceOwning: true, targetOwning: false, owningSide: 'source' };
  }
}

// ---------- default renderer (14a placeholder; 14b injects Handlebars) ----------

/** Deterministic, template-free placeholder so the 14a map is complete. */
export const planStubRenderer: Renderer = (template, model) =>
  `// codegen plan stub (14a) — template: ${template}\n// model: ${JSON.stringify(model)}\n`;

// ---------- generation ----------

const DEFAULT_PACKAGE = 'com.example.generated';

interface ClassInfo {
  javaName: string;
  isEntity: boolean;
}

/**
 * Generate the in-memory IR→file map for a diagram.
 *
 * @throws {NameSanitizerError} if any class/attribute name or base-package
 *   segment is not a safe Java identifier, or a planned path escapes the output
 *   root (codegen threat row 1).
 */
export function generate(diagram: Diagram, options: GenerateOptions): GenerationResult {
  const outputRoot = options.outputRoot;
  const render = options.render ?? planStubRenderer;
  const basePackage = options.basePackage ?? DEFAULT_PACKAGE;
  const warnings: CodegenWarning[] = [];

  // Base package must itself be a chain of safe identifiers.
  const packageSegments = basePackage.split('.');
  for (const segment of packageSegments) {
    sanitizeJavaName(segment);
  }
  const packagePath = packageSegments.join('/');

  // Resolve every class to a sanitized Java name (rejects traversal/reserved).
  const classInfo = new Map<string, ClassInfo>();
  for (const cls of diagram.classes) {
    classInfo.set(cls.id, { javaName: sanitizeJavaName(cls.name), isEntity: cls.kind === 'class' });
  }

  // Build one entity model per UML class (interfaces/abstract land in 14c).
  const entities = new Map<string, EntityModel>();
  for (const cls of diagram.classes) {
    if (cls.kind !== 'class') continue;
    const info = classInfo.get(cls.id);
    if (!info) continue;
    entities.set(info.javaName, {
      className: info.javaName,
      packageName: basePackage,
      fields: cls.attributes.map((a) => mapField(cls, a, warnings)),
      relationships: [],
    });
  }

  // Attach relationships from associations, skipping/warning per codegen:R3.
  for (const assoc of diagram.associations) {
    attachRelationship(assoc, classInfo, entities, warnings);
  }

  // Assemble the file map, containment-checking every planned path.
  const files: GeneratedFile[] = [];
  const push = (path: string, kind: GeneratedFileKind, template: string, model: unknown): void => {
    assertInsideOutputRoot(outputRoot, path);
    files.push({ path, kind, template, model, content: render(template, model) });
  };

  for (const entity of entities.values()) {
    const name = entity.className;
    push(`src/main/java/${packagePath}/${name}.java`, 'source', 'entity', entity);
    push(
      `src/main/java/${packagePath}/repository/${name}Repository.java`,
      'source',
      'repository',
      { className: name, packageName: basePackage },
    );
    push(
      `src/main/java/${packagePath}/web/${name}Controller.java`,
      'source',
      'controller',
      { className: name, packageName: basePackage },
    );
  }

  push('pom.xml', 'build', 'pom', { basePackage, entities: [...entities.keys()] });
  push('src/main/resources/application.properties', 'resource', 'application-properties', {
    basePackage,
  });

  return { files, warnings };
}

function mapField(
  cls: Class,
  attribute: Attribute,
  warnings: CodegenWarning[],
): EntityFieldModel {
  const name = sanitizeJavaName(attribute.name);
  const { javaType, mapped } = mapAttributeType(attribute.type);
  if (!mapped) {
    warnings.push({
      code: 'unmapped-type',
      message: `Attribute type "${attribute.type}" on ${cls.name}.${attribute.name} has no mapping; falling back to String`,
      element: `${cls.name}.${attribute.name}`,
    });
  }
  return {
    name,
    javaType,
    declaredType: attribute.type,
    visibility: attribute.visibility,
    isStatic: attribute.isStatic,
    isDerived: attribute.isDerived,
    multiplicity: attribute.multiplicity ?? null,
  };
}

function attachRelationship(
  assoc: Association,
  classInfo: Map<string, ClassInfo>,
  entities: Map<string, EntityModel>,
  warnings: CodegenWarning[],
): void {
  const source = classInfo.get(assoc.sourceClassId);
  const target = classInfo.get(assoc.targetClassId);

  // codegen:R3 — an endpoint absent from the model is skipped with a warning.
  if (!source || !target) {
    const missingId = !source ? assoc.sourceClassId : assoc.targetClassId;
    warnings.push({
      code: 'missing-endpoint',
      message: `Association ${assoc.id} references class ${missingId} which is absent from the model; skipped`,
      element: assoc.id,
    });
    return;
  }

  // Interfaces/abstract endpoints are mapped in 14c; skip without dropping silently.
  if (!source.isEntity || !target.isEntity) {
    warnings.push({
      code: 'deferred-endpoint-kind',
      message: `Association ${assoc.id} touches a non-class endpoint; UML v2 mapping is deferred to 14c`,
      element: assoc.id,
    });
    return;
  }

  const pair = resolvePair(assoc.sourceMultiplicity, assoc.targetMultiplicity);
  if (!pair) {
    warnings.push({
      code: 'unmapped-multiplicity',
      message: `Association ${assoc.id} multiplicities (${assoc.sourceMultiplicity ?? 'unset'}..${assoc.targetMultiplicity ?? 'unset'}) have no JPA mapping; skipped`,
      element: assoc.id,
    });
    return;
  }

  const sourceEntity = entities.get(source.javaName);
  const targetEntity = entities.get(target.javaName);
  if (!sourceEntity || !targetEntity) return;

  sourceEntity.relationships.push({
    associationId: assoc.id,
    targetEntity: target.javaName,
    kind: pair.kind,
    owningSide: pair.owningSide,
    thisSideIsOwning: pair.sourceOwning,
    sourceMultiplicity: assoc.sourceMultiplicity ?? null,
    targetMultiplicity: assoc.targetMultiplicity ?? null,
  });
  targetEntity.relationships.push({
    associationId: assoc.id,
    targetEntity: source.javaName,
    kind: inverseKind(pair.kind),
    owningSide: pair.owningSide,
    thisSideIsOwning: pair.targetOwning,
    sourceMultiplicity: assoc.sourceMultiplicity ?? null,
    targetMultiplicity: assoc.targetMultiplicity ?? null,
  });
}

/** The relationship kind seen from the opposite end of the association. */
function inverseKind(kind: RelationshipKind): RelationshipKind {
  if (kind === 'OneToMany') return 'ManyToOne';
  if (kind === 'ManyToOne') return 'OneToMany';
  return kind; // ManyToMany / OneToOne are symmetric
}
