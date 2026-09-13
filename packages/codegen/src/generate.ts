import type { Association, Attribute, Class, Diagram, NaryAssociation } from '@app/core';

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
  /**
   * 14c: Java field modifier from UML visibility (documented mapping):
   * `+`/`-` → `private` (JPA convention keeps fields private with public
   * accessors), `#` → `protected`, `~` → package-private (empty string).
   */
  fieldModifier: 'private' | 'protected' | '';
  /**
   * 14c: true when the attribute multiplicity classifies as `many` — the
   * field renders as `List<T>` with `@ElementCollection` (basic type).
   */
  isCollection: boolean;
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
  /**
   * 14c: true on the CONTAINER side of a composition (the diamond end) —
   * the template adds `cascade = CascadeType.ALL, orphanRemoval = true`.
   * Shared aggregation maps to a plain association (no cascade) — documented
   * decision: shared members can exist independently, so lifecycle must NOT
   * cascade (UML 2.5.1 §composition semantics).
   */
  cascade: boolean;
  /** 14c: mirrors {@link cascade}; kept separate so templates stay declarative. */
  orphanRemoval: boolean;
}

export interface EntityModel {
  className: string;
  packageName: string;
  fields: EntityFieldModel[];
  relationships: EntityRelationshipModel[];
  /** 14c: UML isAbstract → `abstract` Java class modifier. */
  isAbstract: boolean;
  /** 14c: superclass Java name from generalization (null when none). */
  extendsClass: string | null;
  /** 14c: true on a generalization root → @Inheritance(SINGLE_TABLE) + @DiscriminatorColumn. */
  inheritanceRoot: boolean;
  /** 14c: interface names realized by this class → `implements` clause. */
  implementsInterfaces: string[];
}

export interface InterfaceMethodModel {
  name: string;
  /** Mapped Java return type (`String` fallback + warning when unmapped). */
  returnType: string;
  parameters: { name: string; type: string }[];
}

/** Render model for a UML interface classifier → plain Java `interface`. */
export interface InterfaceModel {
  className: string;
  packageName: string;
  methods: InterfaceMethodModel[];
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

// ---------- mapping table 3: UML 2.5.1 elements → JPA/Java (unit 14c) ----------

/**
 * UML 2.5.1 semantic mapping (spec "UML 2.5.1 Element Mapping"). Every row is
 * implemented in {@link generate}; every unmappable combination produces a
 * warning and is skipped — never silently dropped (codegen:R2/R3 policy).
 *
 * | UML element                          | JPA/Java mapping                                        |
 * |--------------------------------------|---------------------------------------------------------|
 * | Composition (container = diamond end)| container-side collection `cascade=ALL, orphanRemoval`  |
 * | Shared aggregation                   | plain association, NO cascade (documented decision)     |
 * | Generalization                       | root: `@Inheritance(SINGLE_TABLE)` + `@DiscriminatorColumn`; subclass: `extends` (inherited fields never redeclared) |
 * | Interface classifier                 | plain Java `interface` file (no entity/repo/controller/service); realizers get `implements` |
 * | Abstract class                       | `abstract` JPA entity ONLY — no repo/controller/service (17 amendment 2026-09-13: abstract types cannot back a REST CRUD surface); warns |
 * | Member visibility `-` / `#`          | `private` / `protected` field modifiers (`+` stays private per JPA convention, `~` package-private) |
 * | Attribute multiplicity >1 (basic)    | `List<T>` field with `@ElementCollection`               |
 * | N-ary association (centroid diamond) | intermediate join entity `<SortedMemberNames>Link` with an owning `@ManyToOne` per member |
 *
 * N-ary naming rule (deterministic): sanitized member entity names sorted
 * lexicographically, concatenated, suffixed `Link` (e.g. Customer+Order+Product
 * → `CustomerOrderProductLink`). A collision with an existing entity name is
 * reported (`nary-join-name-collision`) and the join entity is skipped.
 */

// ---------- default renderer (14a placeholder; 14b injects Handlebars) ----------

/** Deterministic, template-free placeholder so the 14a map is complete. */
export const planStubRenderer: Renderer = (template, model) =>
  `// codegen plan stub (14a) — template: ${template}\n// model: ${JSON.stringify(model)}\n`;

// ---------- generation ----------

const DEFAULT_PACKAGE = 'com.example.generated';

interface ClassInfo {
  javaName: string;
  isEntity: boolean;
  isInterface: boolean;
  isAbstract: boolean;
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
    classInfo.set(cls.id, {
      javaName: sanitizeJavaName(cls.name),
      isEntity: cls.kind === 'class',
      isInterface: cls.kind === 'interface',
      isAbstract: cls.isAbstract,
    });
  }

  // Build one entity model per UML class (abstract classes included — 14c)
  // and one interface model per UML interface classifier.
  const entities = new Map<string, EntityModel>();
  const interfaces = new Map<string, InterfaceModel>();
  for (const cls of diagram.classes) {
    const info = classInfo.get(cls.id);
    if (!info) continue;
    if (cls.kind === 'interface') {
      interfaces.set(info.javaName, {
        className: info.javaName,
        packageName: basePackage,
        methods: cls.methods.map((m) => mapInterfaceMethod(cls, m, warnings)),
      });
      // Attributes on an interface classifier are unmappable — warn, never drop.
      for (const a of cls.attributes) {
        warnings.push({
          code: 'interface-attribute-skipped',
          message: `Attribute "${a.name}" on interface ${cls.name} has no Java-interface mapping (interfaces carry no state); skipped`,
          element: `${cls.name}.${a.name}`,
        });
      }
      continue;
    }
    entities.set(info.javaName, {
      className: info.javaName,
      packageName: basePackage,
      fields: cls.attributes.map((a) => mapField(cls, a, warnings)),
      relationships: [],
      isAbstract: cls.isAbstract,
      extendsClass: null,
      inheritanceRoot: false,
      implementsInterfaces: [],
    });
  }

  // Attach relationships from associations, skipping/warning per codegen:R3.
  for (const assoc of diagram.associations) {
    attachRelationship(assoc, classInfo, entities, warnings);
  }

  // 14c: generalization → single-table inheritance, realization → implements.
  applyGeneralizations(diagram, classInfo, entities, warnings);
  applyRealizations(diagram, classInfo, entities, warnings);

  // 14c: n-ary associations → intermediate join entities (added to the map).
  buildNaryJoinEntities(diagram, classInfo, entities, warnings, basePackage);

  // Assemble the file map, containment-checking every planned path.
  const files: GeneratedFile[] = [];
  const push = (path: string, kind: GeneratedFileKind, template: string, model: unknown): void => {
    assertInsideOutputRoot(outputRoot, path);
    files.push({ path, kind, template, model, content: render(template, model) });
  };

  for (const iface of interfaces.values()) {
    // Interfaces are plain Java files: NO entity/repository/controller/service.
    push(`src/main/java/${packagePath}/${iface.className}.java`, 'source', 'interface', iface);
  }

  for (const entity of entities.values()) {
    const name = entity.className;
    push(`src/main/java/${packagePath}/${name}.java`, 'source', 'entity', entity);
    // 17 spec fix (2026-09-13): an abstract UML class cannot be instantiated, so a
    // REST/CRUD surface over it can only fail at runtime (Jackson cannot deserialize
    // the abstract type; Spring Data cannot persist it). Emit ONLY the entity (the
    // inheritance hierarchy still needs it); repository/service/controller belong to
    // concrete classes. Concrete subclasses inherit the persisted fields.
    if (entity.isAbstract) {
      warnings.push({
        code: 'abstract-class-no-crud',
        message: `Abstract class ${name}: repository/controller/service intentionally not generated (abstract types cannot back a REST CRUD surface); the entity is emitted for inheritance`,
        element: name,
      });
      continue;
    }
    push(
      `src/main/java/${packagePath}/repository/${name}Repository.java`,
      'source',
      'repository',
      { className: name, packageName: basePackage },
    );
    push(
      `src/main/java/${packagePath}/service/${name}Service.java`,
      'source',
      'service',
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
  // 14.6b: production profile — PostgreSQL purely via env vars, nothing hardcoded.
  push('src/main/resources/application-prod.properties', 'resource', 'application-prod-properties', {
    basePackage,
  });

  // ---- 14b additive entries (mapping logic above untouched) ----
  // Spring Boot main class: required for spring-boot-maven-plugin to produce
  // an executable jar (the golden check starts `java -jar target/*.jar`).
  push(`src/main/java/${packagePath}/Application.java`, 'source', 'application', {
    basePackage,
  });
  // Vendored Maven wrapper assets (design decision 10 — one-command start).
  // Raw, never-templated files served verbatim by the 14b renderer from
  // templates/spring-backend/maven-wrapper/; the stub renderer just plans them.
  push('mvnw', 'build', 'maven-wrapper', { asset: 'mvnw' });
  push('mvnw.cmd', 'build', 'maven-wrapper', { asset: 'mvnw.cmd' });
  push('.mvn/wrapper/maven-wrapper.properties', 'build', 'maven-wrapper', {
    asset: 'maven-wrapper.properties',
  });

  // ---- 14c zip extras (maintainer decision 2026-09-07) ----
  // Container + orchestration + docs shipped inside the generated artifact.
  push('Dockerfile', 'build', 'dockerfile', {});
  push('docker-compose.yml', 'build', 'docker-compose', {});
  push('README.md', 'resource', 'readme', { basePackage });

  return { files, warnings };
}

/** UML member visibility → Java field modifier (documented in mapping table 3). */
function fieldModifierFor(visibility: '+' | '-' | '#' | '~'): 'private' | 'protected' | '' {
  if (visibility === '#') return 'protected';
  if (visibility === '~') return ''; // package-private
  return 'private'; // '+' keeps private fields + public accessors (JPA convention)
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
    fieldModifier: fieldModifierFor(attribute.visibility),
    // 14c: multiplicity >1 on a basic attribute → List<T> + @ElementCollection.
    isCollection: classifyMultiplicity(attribute.multiplicity) === 'many',
  };
}

/** Map an interface operation to a Java method signature (types via table 1). */
function mapInterfaceMethod(
  cls: Class,
  method: Class['methods'][number],
  warnings: CodegenWarning[],
): InterfaceMethodModel {
  const ret = mapAttributeType(method.returnType);
  if (!ret.mapped) {
    warnings.push({
      code: 'unmapped-type',
      message: `Return type "${method.returnType}" on ${cls.name}.${method.name}() has no mapping; falling back to String`,
      element: `${cls.name}.${method.name}()`,
    });
  }
  const parameters = method.parameters.map((p) => {
    const mapped = mapAttributeType(p.type);
    if (!mapped.mapped) {
      warnings.push({
        code: 'unmapped-type',
        message: `Parameter type "${p.type}" on ${cls.name}.${method.name}(${p.name}) has no mapping; falling back to String`,
        element: `${cls.name}.${method.name}(${p.name})`,
      });
    }
    return { name: sanitizeJavaName(p.name), type: mapped.javaType };
  });
  return {
    name: sanitizeJavaName(method.name),
    returnType: ret.javaType,
    parameters,
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

  // 14c: an association endpoint on an interface is unmappable in JPA —
  // documented permanent policy (was "deferred to 14c" in 14a).
  if (!source.isEntity || !target.isEntity) {
    const iface = !source.isEntity ? source : target;
    warnings.push({
      code: 'interface-endpoint-skipped',
      message: `Association ${assoc.id} touches interface ${iface.javaName}; JPA relationships to interfaces are not generated; skipped`,
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

  // 14c: composition cascades from the CONTAINER (diamond) side only.
  // Shared aggregation ('shared') and plain associations ('none') stay plain.
  const isComposite = assoc.aggregation === 'composite';
  const sourceIsContainer = isComposite && assoc.aggregationEnd === 'source';
  const targetIsContainer = isComposite && assoc.aggregationEnd === 'target';

  sourceEntity.relationships.push({
    associationId: assoc.id,
    targetEntity: target.javaName,
    kind: pair.kind,
    owningSide: pair.owningSide,
    thisSideIsOwning: pair.sourceOwning,
    sourceMultiplicity: assoc.sourceMultiplicity ?? null,
    targetMultiplicity: assoc.targetMultiplicity ?? null,
    cascade: sourceIsContainer,
    orphanRemoval: sourceIsContainer,
  });
  targetEntity.relationships.push({
    associationId: assoc.id,
    targetEntity: source.javaName,
    kind: inverseKind(pair.kind),
    owningSide: pair.owningSide,
    thisSideIsOwning: pair.targetOwning,
    sourceMultiplicity: assoc.sourceMultiplicity ?? null,
    targetMultiplicity: assoc.targetMultiplicity ?? null,
    cascade: targetIsContainer,
    orphanRemoval: targetIsContainer,
  });
}

/**
 * 14c: generalization → single-table inheritance. The root (a superclass that
 * is not itself a subclass) gets `inheritanceRoot` → @Inheritance +
 * @DiscriminatorColumn; every subclass records `extendsClass` and keeps ONLY
 * its own fields (inherited fields are never redeclared). Unmappable cases
 * warn and skip the edge — never silent.
 */
function applyGeneralizations(
  diagram: Diagram,
  classInfo: Map<string, ClassInfo>,
  entities: Map<string, EntityModel>,
  warnings: CodegenWarning[],
): void {
  const superIds = new Set<string>();
  for (const gen of diagram.generalizations) {
    const sub = classInfo.get(gen.subClassId);
    const sup = classInfo.get(gen.superClassId);
    if (!sub || !sup) {
      warnings.push({
        code: 'missing-endpoint',
        message: `Generalization ${gen.id} references an absent class; skipped`,
        element: gen.id,
      });
      continue;
    }
    if (sup.isInterface) {
      warnings.push({
        code: 'generalization-to-interface',
        message: `Generalization ${gen.id}: ${sub.javaName} cannot extend interface ${sup.javaName} (use realization); skipped`,
        element: gen.id,
      });
      continue;
    }
    const subEntity = entities.get(sub.javaName);
    const supEntity = entities.get(sup.javaName);
    if (!subEntity || !supEntity) continue; // interface subclass — warned above path
    if (subEntity.extendsClass !== null) {
      warnings.push({
        code: 'multiple-generalization',
        message: `Class ${sub.javaName} already extends ${subEntity.extendsClass}; generalization ${gen.id} (second superclass) is unmappable in Java; skipped`,
        element: gen.id,
      });
      continue;
    }
    subEntity.extendsClass = sup.javaName;
    superIds.add(sup.javaName);
  }
  for (const name of superIds) {
    const entity = entities.get(name);
    if (!entity) continue;
    // A class that is itself a subclass is an intermediate node, not the root.
    if (entity.extendsClass === null) entity.inheritanceRoot = true;
    if (entity.isAbstract && entity.inheritanceRoot) {
      warnings.push({
        code: 'abstract-inheritance-root-table',
        message: `Abstract class ${name} is an inheritance root; the SINGLE_TABLE strategy needs a table for it (generated as @Entity abstract root)`,
        element: name,
      });
    }
  }
}

/** 14c: realization → `implements` clause on the realizing entity. */
function applyRealizations(
  diagram: Diagram,
  classInfo: Map<string, ClassInfo>,
  entities: Map<string, EntityModel>,
  warnings: CodegenWarning[],
): void {
  for (const real of diagram.realizations) {
    const client = classInfo.get(real.clientClassId);
    const supplier = classInfo.get(real.supplierInterfaceId);
    if (!client || !supplier) {
      warnings.push({
        code: 'missing-endpoint',
        message: `Realization ${real.id} references an absent classifier; skipped`,
        element: real.id,
      });
      continue;
    }
    if (!supplier.isInterface) {
      warnings.push({
        code: 'realization-supplier-not-interface',
        message: `Realization ${real.id}: supplier ${supplier.javaName} is not an interface; skipped`,
        element: real.id,
      });
      continue;
    }
    if (!client.isEntity) {
      warnings.push({
        code: 'realization-client-not-class',
        message: `Realization ${real.id}: client ${client.javaName} is an interface (use generalization/extends); skipped`,
        element: real.id,
      });
      continue;
    }
    const entity = entities.get(client.javaName);
    if (!entity) continue;
    if (!entity.implementsInterfaces.includes(supplier.javaName)) {
      entity.implementsInterfaces.push(supplier.javaName);
    }
  }
}

/**
 * 14c: n-ary association (PR 13 centroid diamond → `naryAssociations` with
 * ≥3 memberEnds) → intermediate join entity. Naming rule (documented in
 * mapping table 3): sanitized member names sorted lexicographically + "Link".
 * The join entity carries one owning @ManyToOne per member (role names are
 * advisory and do not affect field naming — documented simplification);
 * members get no back-reference collection (minimal generated surface).
 */
function buildNaryJoinEntities(
  diagram: Diagram,
  classInfo: Map<string, ClassInfo>,
  entities: Map<string, EntityModel>,
  warnings: CodegenWarning[],
  basePackage: string,
): void {
  for (const nary of diagram.naryAssociations) {
    const members: { info: ClassInfo; multiplicity: string }[] = [];
    let blocked = false;
    for (const end of nary.memberEnds) {
      const info = classInfo.get(end.classId);
      if (!info) {
        warnings.push({
          code: 'missing-endpoint',
          message: `N-ary association ${nary.id} references absent class ${end.classId}; skipped`,
          element: nary.id,
        });
        blocked = true;
        break;
      }
      if (info.isInterface) {
        warnings.push({
          code: 'nary-interface-member',
          message: `N-ary association ${nary.id} has interface member ${info.javaName}; @ManyToOne to an interface is unmappable; skipped`,
          element: nary.id,
        });
        blocked = true;
        break;
      }
      members.push({ info, multiplicity: end.multiplicity });
    }
    if (blocked) continue;

    const names = members.map((m) => m.info.javaName);
    if (new Set(names).size !== names.length) {
      warnings.push({
        code: 'nary-duplicate-member',
        message: `N-ary association ${nary.id} repeats a member class; a join entity with duplicate fields is unmappable; skipped`,
        element: nary.id,
      });
      continue;
    }

    const joinName = [...names].sort().join('') + 'Link';
    if (entities.has(joinName)) {
      warnings.push({
        code: 'nary-join-name-collision',
        message: `N-ary join entity name ${joinName} collides with an existing class; skipped (rename a member or the association)`,
        element: nary.id,
      });
      continue;
    }

    const join: EntityModel = {
      className: joinName,
      packageName: basePackage,
      fields: [],
      relationships: [...names].sort().map((targetEntity) => ({
        associationId: nary.id,
        targetEntity,
        kind: 'ManyToOne' as RelationshipKind,
        owningSide: 'source' as const,
        thisSideIsOwning: true,
        sourceMultiplicity: '0..*' as string | null,
        targetMultiplicity: '1' as string | null,
        cascade: false,
        orphanRemoval: false,
      })),
      isAbstract: false,
      extendsClass: null,
      inheritanceRoot: false,
      implementsInterfaces: [],
    };
    entities.set(joinName, join);
  }
}

/** The relationship kind seen from the opposite end of the association. */
function inverseKind(kind: RelationshipKind): RelationshipKind {
  if (kind === 'OneToMany') return 'ManyToOne';
  if (kind === 'ManyToOne') return 'OneToMany';
  return kind; // ManyToMany / OneToOne are symmetric
}
