import type { Association, Attribute, Class, Diagram, NaryAssociation } from '@app/core';

import { assertInsideOutputRoot, sanitizeJavaName } from './sanitize.js';

/**
 * Generador del mapa de archivos IR → Spring (unidad 14a).
 *
 * Este módulo transforma el IR canónico de `@app/core` en un plan EN MEMORIA: una lista
 * de entradas {@link GeneratedFile} (ruta sanitizada + tipo + id de plantilla + modelo
 * de renderizado) más un recolector de {@link CodegenWarning}. No realiza escrituras
 * en el sistema de archivos ni requiere compilación Maven — ese es el propósito del seam 14a/14b.
 *
 * Seam para 14b: el texto renderizado proviene de un {@link Renderer} inyectable.
 * 14a incluye {@link planStubRenderer} (un marcador de posición determinista) simplemente
 * para que el mapa esté completo y sea testeable; 14b inyecta un renderizador Handlebars
 * SIN cambiar ningún tipo aquí ni las tablas de mapeo a continuación.
 */

// ---------- tipos de resultados públicos ----------

export type GeneratedFileKind = 'source' | 'resource' | 'build';

export interface GeneratedFile {
  /** Ruta POSIX relativa a la raíz de salida del trabajo, sanitizada y con verificación de contención. */
  path: string;
  kind: GeneratedFileKind;
  /** ID de plantilla que resuelve el renderizador (plantilla Handlebars en 14b). */
  template: string;
  /** Resultado del mapeo IR→JPA a partir del cual renderiza la plantilla. */
  model: unknown;
  /** Texto renderizado a través del renderizador inyectado. */
  content: string;
}

export interface CodegenWarning {
  /** Código máquina estable, p. ej. `unmapped-type`, `missing-endpoint`. */
  code: string;
  /** Mensaje legible por humanos indicando el elemento infractor. */
  message: string;
  /** El elemento al que se refiere la advertencia (p. ej. `Product.name` o un id). */
  element: string;
}

export type Renderer = (template: string, model: unknown) => string;

export interface GenerateOptions {
  /** Raíz absoluta de salida del trabajo utilizada para aserciones de contención. */
  outputRoot: string;
  /** Paquete base de Java para los fuentes generados (por defecto `com.example.generated`). */
  basePackage?: string;
  /** Seam del renderizador; por defecto {@link planStubRenderer}. 14b inyecta Handlebars. */
  render?: Renderer;
}

export interface GenerationResult {
  files: GeneratedFile[];
  warnings: CodegenWarning[];
}

// ---------- modelos de renderizado de entidades (el "plan de contenido") ----------

export interface EntityFieldModel {
  /** Nombre de campo Java sanitizado. */
  name: string;
  /** Tipo Java mapeado, o `String` cuando el tipo UML no está mapeado. */
  javaType: string;
  /** Tipo UML original declarado (conservado para que 14b/plantillas puedan reportarlo). */
  declaredType: string;
  visibility: '+' | '-' | '#' | '~';
  isStatic: boolean;
  isDerived: boolean;
  /** Multiplicidad del atributo, o null cuando no está especificada. */
  multiplicity: string | null;
  /**
   * 14c: Modificador de campo Java a partir de la visibilidad UML (mapeo documentado):
   * `+`/`-` → `private` (la convención JPA mantiene los campos privados con accesores
   * públicos), `#` → `protected`, `~` → package-private (cadena vacía).
   */
  fieldModifier: 'private' | 'protected' | '';
  /**
   * 14c: true cuando la multiplicidad del atributo se clasifica como `many` — el
   * campo se renderiza como `List<T>` con `@ElementCollection` (tipo básico).
   */
  isCollection: boolean;
}

export type RelationshipKind = 'OneToMany' | 'ManyToOne' | 'ManyToMany' | 'OneToOne';

export interface EntityRelationshipModel {
  associationId: string;
  /** Nombre Java de la entidad en el otro extremo. */
  targetEntity: string;
  kind: RelationshipKind;
  /** Qué extremo de la asociación posee la FK (documentado según la tabla de mapeo). */
  owningSide: 'source' | 'target';
  thisSideIsOwning: boolean;
  sourceMultiplicity: string | null;
  targetMultiplicity: string | null;
  /**
   * 14c: true en el lado CONTENEDOR de una composición (el extremo del diamante) —
   * la plantilla añade `cascade = CascadeType.ALL, orphanRemoval = true`.
   * La agregación compartida se mapea como asociación simple (sin cascade) — decisión
   * documentada: los miembros compartidos pueden existir independientemente, por lo que el
   * ciclo de vida NO debe propagarse en cascada (semántica de composición UML 2.5.1).
   */
  cascade: boolean;
  /** 14c: refleja {@link cascade}; se mantiene separado para que las plantillas sigan siendo declarativas. */
  orphanRemoval: boolean;
}

export interface EntityModel {
  className: string;
  packageName: string;
  fields: EntityFieldModel[];
  relationships: EntityRelationshipModel[];
  /** 14c: isAbstract de UML → modificador de clase Java `abstract`. */
  isAbstract: boolean;
  /** 14c: nombre Java de la superclase a partir de generalización (null si no hay). */
  extendsClass: string | null;
  /** 14c: true en la raíz de una generalización → @Inheritance(SINGLE_TABLE) + @DiscriminatorColumn. */
  inheritanceRoot: boolean;
  /** 14c: nombres de interfaces realizadas por esta clase → cláusula `implements`. */
  implementsInterfaces: string[];
}

export interface InterfaceMethodModel {
  name: string;
  /** Tipo de retorno Java mapeado (fallback a `String` + advertencia si no está mapeado). */
  returnType: string;
  parameters: { name: string; type: string }[];
}

/** Modelo de renderizado para un clasificador interfaz UML → `interface` Java pura. */
export interface InterfaceModel {
  className: string;
  packageName: string;
  methods: InterfaceMethodModel[];
}

// ---------- tabla de mapeo 1: tipo de atributo UML -> tipo Java ----------

/**
 * Tipo de atributo UML → tipo de campo Java (búsqueda insensible a mayúsculas/minúsculas
 * mediante clave en minúsculas). Documentado según codegen:R2. La ausencia de un tipo en
 * esta tabla NO es un error: {@link mapAttributeType} recurre a `String` y registra una advertencia.
 *
 * | Tipo UML            | Tipo Java       |
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

/** Mapea un tipo de atributo UML declarado a un tipo Java, marcando tipos no mapeados. */
export function mapAttributeType(declaredType: string): { javaType: string; mapped: boolean } {
  const javaType = TYPE_MAPPING[declaredType.toLowerCase()];
  if (javaType === undefined) {
    return { javaType: 'String', mapped: false };
  }
  return { javaType, mapped: true };
}

// ---------- tabla de mapeo 2: multiplicidades de asociación -> relación JPA ----------

export type Cardinality = 'one' | 'zeroOrOne' | 'many' | 'zero' | 'unknown';

/**
 * Clasifica la multiplicidad de un extremo en una cardinalidad relevante para JPA.
 * Acepta la gramática completa de UML 2.5.1 permitida por el IR (`*`, enteros, `m..n`,
 * `m..*`); `undefined` (extremo no especificado) resulta en `unknown`.
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
 * Cardinalidades de extremos de asociación → tipo de relación JPA, indexadas por
 * `${sourceEnd}:${targetEnd}` donde cada extremo se normaliza a `one` o `many`
 * (un extremo `0..1` se comporta como un extremo to-one para la selección de la relación).
 *
 * Documentado según la especificación "Relation Mapping From Associations":
 *
 * | origen : destino| relación                  | lado propietario (owning)|
 * |-----------------|---------------------------|--------------------------|
 * | one   : many    | @OneToMany / @ManyToOne   | many (destino)           |
 * | many  : one     | @ManyToOne / @OneToMany   | many (origen)            |
 * | many  : many    | @ManyToMany (ambos)       | tabla join (ninguno)     |
 * | one   : one     | @OneToOne                 | origen (documentado)     |
 *
 * Los pares que involucran `zero`/`unknown` no se mapean → advertencia, relación omitida.
 */
export const MULTIPLICITY_MAPPING: Readonly<Record<string, RelationshipKind>> = {
  'one:many': 'OneToMany',
  'many:one': 'ManyToOne',
  'many:many': 'ManyToMany',
  'one:one': 'OneToOne',
};

/** Normaliza una cardinalidad al eje to-one / to-many utilizado por la tabla. */
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

/** Resuelve las multiplicidades de los extremos de una asociación en una relación JPA. */
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

// ---------- tabla de mapeo 3: elementos UML 2.5.1 → JPA/Java (unidad 14c) ----------

/**
 * Mapeo semántico de UML 2.5.1 (especificación "UML 2.5.1 Element Mapping"). Cada fila está
 * implementada en {@link generate}; toda combinación no mapeable produce una advertencia
 * y se omite — nunca se descarta silenciosamente (política codegen:R2/R3).
 *
 * | Elemento UML                         | Mapeo JPA/Java                                          |
 * |--------------------------------------|---------------------------------------------------------|
 * | Composición (contenedor = diamante)  | colección del lado contenedor `cascade=ALL, orphanRemoval`|
 * | Agregación compartida                | asociación simple, SIN cascada (decisión documentada)  |
 * | Generalización                       | raíz: `@Inheritance(SINGLE_TABLE)` + `@DiscriminatorColumn`; subclase: `extends` (los campos heredados nunca se redeclaran) |
 * | Clasificador interfaz                | archivo `interface` Java puro (sin entidad/repo/controlador/servicio); quienes la realizan obtienen `implements` |
 * | Clase abstracta                      | SOLO entidad JPA `abstract` — sin repo/controlador/servicio (enmienda 17 del 2026-09-13: los tipos abstractos no pueden respaldar una superficie CRUD REST); advierte |
 * | Visibilidad de miembro `-` / `#`     | modificadores de campo `private` / `protected` (`+` permanece privado por convención JPA, `~` package-private) |
 * | Multiplicidad de atributo >1 (básico)| campo `List<T>` con `@ElementCollection`               |
 * | Asociación N-aria (diamante centroide)| entidad join intermedia `<NombresMiembrosOrdenados>Link` con un `@ManyToOne` propietario por miembro |
 *
 * Regla de nomenclatura N-aria (determinista): nombres sanitizados de las entidades miembro ordenados
 * lexicográficamente, concatenados, con sufijo `Link` (p. ej. Customer+Order+Product
 * → `CustomerOrderProductLink`). Cualquier colisión con un nombre de entidad existente se reporta
 * (`nary-join-name-collision`) y se omite la entidad join.
 */

// ---------- renderizador por defecto (marcador 14a; 14b inyecta Handlebars) ----------

/** Marcador de posición determinista y sin plantillas para completar el mapa 14a. */
export const planStubRenderer: Renderer = (template, model) =>
  `// codegen plan stub (14a) — template: ${template}\n// model: ${JSON.stringify(model)}\n`;

// ---------- generación ----------

const DEFAULT_PACKAGE = 'com.example.generated';

interface ClassInfo {
  javaName: string;
  isEntity: boolean;
  isInterface: boolean;
  isAbstract: boolean;
}

/**
 * Genera el mapa en memoria IR→archivos para un diagrama.
 *
 * @throws {NameSanitizerError} si algún nombre de clase/atributo o segmento del
 *   paquete base no es un identificador Java seguro, o una ruta planificada escapa
 *   de la raíz de salida (amenaza de codegen fila 1).
 */
export function generate(diagram: Diagram, options: GenerateOptions): GenerationResult {
  const outputRoot = options.outputRoot;
  const render = options.render ?? planStubRenderer;
  const basePackage = options.basePackage ?? DEFAULT_PACKAGE;
  const warnings: CodegenWarning[] = [];

  // El paquete base debe ser una cadena de identificadores seguros.
  const packageSegments = basePackage.split('.');
  for (const segment of packageSegments) {
    sanitizeJavaName(segment);
  }
  const packagePath = packageSegments.join('/');

  // Resuelve cada clase a un nombre Java sanitizado (rechaza traversal/reservadas).
  const classInfo = new Map<string, ClassInfo>();
  for (const cls of diagram.classes) {
    classInfo.set(cls.id, {
      javaName: sanitizeJavaName(cls.name),
      isEntity: cls.kind === 'class',
      isInterface: cls.kind === 'interface',
      isAbstract: cls.isAbstract,
    });
  }

  // Construye un modelo de entidad por clase UML (clases abstractas incluidas — 14c)
  // y un modelo de interfaz por clasificador de interfaz UML.
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
      // Los atributos en un clasificador interfaz no son mapeables — advertir, nunca descartar.
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

  // Adjunta relaciones a partir de asociaciones, omitiendo/advirtiendo según codegen:R3.
  for (const assoc of diagram.associations) {
    attachRelationship(assoc, classInfo, entities, warnings);
  }

  // 14c: generalización → herencia single-table, realización → implements.
  applyGeneralizations(diagram, classInfo, entities, warnings);
  applyRealizations(diagram, classInfo, entities, warnings);

  // 14c: asociaciones n-arias → entidades join intermedias (agregadas al mapa).
  buildNaryJoinEntities(diagram, classInfo, entities, warnings, basePackage);

  // Ensambla el mapa de archivos, verificando la contención de cada ruta planificada.
  const files: GeneratedFile[] = [];
  const push = (path: string, kind: GeneratedFileKind, template: string, model: unknown): void => {
    assertInsideOutputRoot(outputRoot, path);
    files.push({ path, kind, template, model, content: render(template, model) });
  };

  for (const iface of interfaces.values()) {
    // Las interfaces son archivos Java puros: SIN entidad/repositorio/controlador/servicio.
    push(`src/main/java/${packagePath}/${iface.className}.java`, 'source', 'interface', iface);
  }

  for (const entity of entities.values()) {
    const name = entity.className;
    push(`src/main/java/${packagePath}/${name}.java`, 'source', 'entity', entity);
    // Corrección de especificación 17 (2026-09-13): una clase UML abstracta no puede
    // instanciarse, por lo que una superficie REST/CRUD sobre ella solo fallaría en runtime
    // (Jackson no puede deserializar el tipo abstracto; Spring Data no puede persistirlo).
    // Emite ÚNICAMENTE la entidad (la jerarquía de herencia aún la necesita); el repositorio/
    // servicio/controlador pertenecen a clases concretas. Las subclases concretas heredan los campos persistidos.
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
    assistantModel: 'qwen2.5:1.5b',
    assistantOllamaUrl: 'http://127.0.0.1:11434',
  });
  // 14.6b: perfil de producción — PostgreSQL exclusivamente mediante variables de entorno, nada hardcodeado.
  push('src/main/resources/application-prod.properties', 'resource', 'application-prod-properties', {
    basePackage,
  });

  // ---- Entradas aditivas de 14b (lógica de mapeo superior intacta) ----
  // Clase principal de Spring Boot: requerida por spring-boot-maven-plugin para producir
  // un jar ejecutable (el golden check inicia `java -jar target/*.jar`).
  push(`src/main/java/${packagePath}/Application.java`, 'source', 'application', {
    basePackage,
  });
  // Recursos del Maven wrapper incorporados (decisión de diseño 10 — inicio en un solo comando).
  // Archivos en crudo, nunca procesados por plantillas, servidos textualmente por el renderizador 14b
  // desde templates/spring-backend/maven-wrapper/; el renderizador stub solo los planifica.
  push('mvnw', 'build', 'maven-wrapper', { asset: 'mvnw' });
  push('mvnw.cmd', 'build', 'maven-wrapper', { asset: 'mvnw.cmd' });
  push('.mvn/wrapper/maven-wrapper.properties', 'build', 'maven-wrapper', {
    asset: 'maven-wrapper.properties',
  });

  // ---- Extras del zip en 14c (decisión del mantenedor 2026-09-07) ----
  // Contenedor + orquestación + documentación incluidos en el artefacto generado.
  push('Dockerfile', 'build', 'dockerfile', {});
  push('docker-compose.yml', 'build', 'docker-compose', {});
  push('README.md', 'resource', 'readme', { basePackage });

  // ---- 18: Asistente offline (diseño D11 — matcher bilingüe + fallback a Ollama) ----
  // Solo entidades concretas (las clases abstractas no pueden respaldar el despacho del asistente).
  const assistantEntities = [...entities.entries()]
    .filter(([_, e]) => !e.isAbstract)
    .map(([name]) => name);
  const assistantModel = {
    packageName: basePackage,
    entities: assistantEntities,
    assistantModel: 'qwen2.5:1.5b',
    assistantOllamaUrl: 'http://127.0.0.1:11434',
  };
  push(`src/main/java/${packagePath}/assistant/AssistantEngine.java`, 'source', 'assistant-engine', assistantModel);
  push(`src/main/java/${packagePath}/assistant/IntentMatcher.java`, 'source', 'intent-matcher', assistantModel);
  push(`src/main/java/${packagePath}/assistant/OllamaEngine.java`, 'source', 'ollama-engine', assistantModel);
  push(`src/main/java/${packagePath}/assistant/AuditLog.java`, 'source', 'audit-log', assistantModel);
  push(`src/main/java/${packagePath}/web/AssistantController.java`, 'source', 'assistant-controller', assistantModel);

  return { files, warnings };
}

/** Visibilidad de miembro UML → modificador de campo Java (documentado en tabla de mapeo 3). */
function fieldModifierFor(visibility: '+' | '-' | '#' | '~'): 'private' | 'protected' | '' {
  if (visibility === '#') return 'protected';
  if (visibility === '~') return ''; // package-private
  return 'private'; // '+' mantiene campos privados + accesores públicos (convención JPA)
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
    // 14c: multiplicidad >1 en un atributo básico → List<T> + @ElementCollection.
    isCollection: classifyMultiplicity(attribute.multiplicity) === 'many',
  };
}

/** Mapea una operación de interfaz a la firma de un método Java (tipos mediante tabla 1). */
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

  // codegen:R3 — un extremo ausente del modelo se omite con una advertencia.
  if (!source || !target) {
    const missingId = !source ? assoc.sourceClassId : assoc.targetClassId;
    warnings.push({
      code: 'missing-endpoint',
      message: `Association ${assoc.id} references class ${missingId} which is absent from the model; skipped`,
      element: assoc.id,
    });
    return;
  }

  // 14c: un extremo de asociación en una interfaz no es mapeable en JPA —
  // política permanente documentada (estaba "diferida a 14c" en 14a).
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

  // 14c: la composición se propaga en cascada únicamente desde el lado CONTENEDOR (diamante).
  // La agregación compartida ('shared') y las asociaciones simples ('none') se mantienen simples.
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
 * 14c: generalización → herencia single-table. La raíz (una superclase que
 * no es a su vez una subclase) obtiene `inheritanceRoot` → @Inheritance +
 * @DiscriminatorColumn; cada subclase registra `extendsClass` y conserva ÚNICAMENTE
 * sus propios campos (los campos heredados nunca se redeclaran). Casos no mapeables
 * advierten y omiten la arista — nunca silencioso.
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
    if (!subEntity || !supEntity) continue; // subclase de interfaz — advertida en la ruta superior
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
    // Una clase que es a su vez una subclase es un nodo intermedio, no la raíz.
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

/** 14c: realización → cláusula `implements` en la entidad realizadora. */
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
 * 14c: asociación n-aria (PR 13 diamante centroide → `naryAssociations` con
 * ≥3 memberEnds) → entidad join intermedia. Regla de nomenclatura (documentada en
 * tabla de mapeo 3): nombres sanitizados de los miembros ordenados lexicográficamente + "Link".
 * La entidad join contiene un @ManyToOne propietario por miembro (los nombres de roles son
 * orientativos y no afectan la nomenclatura de campos — simplificación documentada);
 * los miembros no reciben colección de referencia inversa (superficie generada mínima).
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

/** El tipo de relación vista desde el extremo opuesto de la asociación. */
function inverseKind(kind: RelationshipKind): RelationshipKind {
  if (kind === 'OneToMany') return 'ManyToOne';
  if (kind === 'ManyToOne') return 'OneToMany';
  return kind; // ManyToMany / OneToOne son simétricos
}
