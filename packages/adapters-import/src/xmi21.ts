import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { randomUUID } from 'crypto';
import { gridLayout } from './xmi21-layout.js';
import type { Delta, BatchDelta, ClassDelta, MemberDelta, AssociationDelta, GeneralizationDelta, RealizationDelta, DependencyDelta, NaryAssociationDelta } from '@app/core';

export type XmiModel = {
  classes: Array<{
    id: string;
    name: string;
    kind: 'class' | 'interface';
    isAbstract: boolean;
    attributes: Array<{ name: string; type: string; visibility: string; isStatic: boolean; isDerived: boolean; multiplicity?: string }>;
    methods: Array<{ name: string; returnType: string; visibility: string; isStatic: boolean; parameters?: Array<{ name: string; type: string }> }>;
  }>;
  associations: Array<{
    id: string;
    source: string;
    target: string;
    aggregation: 'none' | 'shared' | 'composite';
    aggregationEnd: 'source' | 'target';
    name?: string;
    sourceRole?: string;
    targetRole?: string;
    sourceMultiplicity?: string;
    targetMultiplicity?: string;
  }>;
  generalizations: Array<{
    id: string;
    subClassId: string;
    superClassId: string;
  }>;
  realizations: Array<{
    id: string;
    clientId: string;
    supplierId: string;
  }>;
  dependencies: Array<{
    id: string;
    clientId: string;
    supplierId: string;
  }>;
  naryAssociations: Array<{
    id: string;
    memberEnds: Array<{ classId: string; multiplicity?: string; role?: string }>;
    name?: string;
  }>;
};

const VERSION_PATTERN = /^2\.1/i;

/** Fuerza a que un hijo de fast-xml-parser (objeto único, arreglo o ausente) sea un arreglo. */
function toArray<T>(value: T | T[] | undefined): T[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * Normaliza la visibilidad UML: las exportaciones XMI 2.1 usan palabras semánticas
 * ("private", "public", "protected", "package"); el esquema del motor usa los
 * símbolos UML 2.5.1 ('-', '+', '#', '~'). Los símbolos se mantienen sin cambios para
 * que el diseño estilo UML-1.x manual continúe funcionando.
 */
function normalizeVisibility(visibility: string | undefined): '+' | '-' | '#' | '~' {
  switch (visibility) {
    case 'private': return '-';
    case 'protected': return '#';
    case 'package': return '~';
    case 'public': return '+';
    case '+': case '-': case '#': case '~': return visibility;
    default: return '+';
  }
}

/**
 * Desambigua nombres de clasificadores que colisionan entre paquetes (evidencia del
 * fixture 6: EA permite `PackageA::Orden` y `PackageB::Orden`, y el motor condiciona la
 * creación de clases por NOMBRE — apply.ts isDuplicateClassName — de modo que dos
 * duplicados simples hacen que el motor RECHACE EL LOTE COMPLETO de forma atómica).
 *
 * Política (directiva del usuario: "no fallar y nunca rechazar el lote completo —
 * importarlo como la alternativa más cercana"): solo se renombran los nombres en un grupo
 * de colisión real, calificándolos con la cola MÍNIMA de la cadena de paquetes que los haga
 * únicos (PackageA::Orden / PackageB::Orden — coincidiendo con el ejemplo del usuario; el
 * segmento raíz común Package2 no es necesario). Si la cadena completa aún colisiona
 * (rutas idénticas — EA no debería emitirlo, pero nunca rechazamos), un sufijo numérico
 * mantiene cada nombre único. Las exportaciones sin colisiones conservan nombres simples:
 * todos los fixtures previos quedan intactos.
 */
function disambiguateClassifierNames(model: XmiModel, chains: string[][]): void {
  const groups = new Map<string, number[]>();
  model.classes.forEach((c, i) => {
    const idxs = groups.get(c.name);
    if (idxs) idxs.push(i); else groups.set(c.name, [i]);
  });

  for (const [name, idxs] of groups) {
    if (idxs.length < 2) continue;
    const maxDepth = Math.max(0, ...idxs.map(i => (chains[i] ?? []).length));
    let resolved: string[] | undefined;
    for (let depth = 1; depth <= maxDepth + 1; depth++) {
      const qualified = idxs.map(i => {
        const chain = chains[i] ?? [];
        const suffix = chain.slice(Math.max(0, chain.length - depth));
        return suffix.length ? `${suffix.join('::')}::${name}` : name;
      });
      if (new Set(qualified).size === idxs.length) {
        resolved = qualified;
        break;
      }
    }
    if (!resolved) {
      // La cadena completa aún colisiona: conservar la calificación más profunda y agregar
      // sufijos numéricos para que el lote se aplique (la representación más cercana gana
      // frente al rechazo).
      const base = idxs.map(i => {
        const chain = chains[i] ?? [];
        return chain.length ? `${chain.join('::')}::${name}` : name;
      });
      resolved = base.map((n, k) => (k === 0 ? n : `${n} (${k + 1})`));
    }
    idxs.forEach((classIdx, k) => {
      model.classes[classIdx]!.name = resolved![k]!;
    });
  }
}

function parseXmiDocument(xml: string): XmiModel {
  const validation = XMLValidator.validate(xml, { allowBooleanAttributes: false });
  if (validation !== true) {
    throw new Error(`XMI parse error: ${(validation as { err: { msg: string } }).err.msg}`);
  }
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
  let parsed: any;
  try {
    parsed = parser.parse(xml);
  } catch (e) {
    throw new Error('XMI parse error: malformed XML');
  }

  const model: XmiModel = {
    classes: [],
    associations: [],
    generalizations: [],
    realizations: [],
    dependencies: [],
    naryAssociations: [],
  };

  // Detección de diseño: XMI 2.1 real envuelve todo en <xmi:XMI> o <XMI> y almacena el contenido
  // del modelo como <uml:Model>, <uml:Package> o <packagedElement>; el fixture manual estilo EA
  // utiliza <UML:Model> con hijos UML:Class directos. Se soportan AMBOS.
  const xmiRoot = parsed?.['xmi:XMI'] || parsed?.['XMI'];
  const legacyRoot = xmiRoot ? undefined : (parsed?.['UML:Model'] || parsed?.Model || parsed);
  if (!xmiRoot && !legacyRoot) throw new Error('XMI parse error: no UML:Model root');

  const versionSource = xmiRoot ?? legacyRoot;
  const version = versionSource['@_xmi:version'] || versionSource['@_version'] || '2.1';
  if (!VERSION_PATTERN.test(version)) {
    throw new Error(`Unsupported XMI version: ${version || 'unknown'}; supported: 2.1`);
  }

  if (xmiRoot) {
    parseRealXmi21(xmiRoot, model);
    return model;
  }

  const root = legacyRoot;
  const elements = root['UML:Class'] || [];
  const assocs = root['UML:Association'] || [];
  const gens = root['UML:Generalization'] || [];
  const reals = root['UML:Realization'] || [];
  const deps = root['UML:Dependency'] || [];

  // Clases
  (Array.isArray(elements) ? elements : [elements]).forEach((el: any) => {
    const name = el['@_name'] || 'Unnamed';
    const id = el['@_id'] || randomUUID();
    const kind = el['@_kind'] === 'interface' ? 'interface' : 'class';
    const isAbstract = el['@_isAbstract'] === 'true';
    const classAttrs: any[] = [];
    const classMethods: any[] = [];

    (Array.isArray(el['UML:Attribute']) ? el['UML:Attribute'] : el['UML:Attribute'] ? [el['UML:Attribute']] : []).forEach((a: any) => {
      const visibility = a['@_visibility'] || '+';
      const isStatic = a['@_isStatic'] === 'true';
      const isDerived = a['@_isDerived'] === 'true';
      const mult = a['@_multiplicity'] || undefined;
      classAttrs.push({
        name: a['@_name'] || '',
        type: a['@_type'] || 'String',
        visibility,
        isStatic,
        isDerived,
        multiplicity: mult,
      });
    });

    (Array.isArray(el['UML:Operation']) ? el['UML:Operation'] : el['UML:Operation'] ? [el['UML:Operation']] : []).forEach((m: any) => {
      const visibility = m['@_visibility'] || '+';
      const isStatic = m['@_isStatic'] === 'true';
      const params = (Array.isArray(m['UML:Parameter']) ? m['UML:Parameter'] : m['UML:Parameter'] ? [m['UML:Parameter']] : []).map((p: any) => ({
        name: p['@_name'] || '',
        type: p['@_type'] || 'String',
      }));
      classMethods.push({
        name: m['@_name'] || '',
        returnType: m['@_type'] || 'void',
        visibility,
        isStatic,
        parameters: params,
      });
    });

    model.classes.push({ id, name, kind, isAbstract, attributes: classAttrs, methods: classMethods });
  });

  // Asociaciones
  (Array.isArray(assocs) ? assocs : [assocs]).forEach((a: any) => {
    const id = a['@_id'] || randomUUID();
    const name = a['@_name'] || undefined;
    const ends = a['UML:AssociationEnd'] || [];
    const endList = Array.isArray(ends) ? ends : [ends];
    if (endList.length < 2) return;
    const source = endList[0]['@_class'] || '';
    const target = endList[1]['@_class'] || '';
    const agg = endList[0]['@_aggregation'] || endList[1]['@_aggregation'] || 'none';
    const aggregation = agg === 'composite' ? 'composite' : agg === 'shared' ? 'shared' : 'none';
    const aggregationEnd = endList[0]['@_aggregation'] ? 'source' : 'target';
    const sourceMultiplicity = endList[0]['@_multiplicity'] || undefined;
    const targetMultiplicity = endList[1]['@_multiplicity'] || undefined;
    const sourceRole = endList[0]['@_role'] || undefined;
    const targetRole = endList[1]['@_role'] || undefined;
    model.associations.push({
      id,
      source,
      target,
      aggregation,
      aggregationEnd,
      name,
      sourceRole,
      targetRole,
      sourceMultiplicity,
      targetMultiplicity,
    });
  });

  // Generalizaciones
  (Array.isArray(gens) ? gens : [gens]).forEach((g: any) => {
    const id = g['@_id'] || randomUUID();
    const sub = g['@_child'] || '';
    const sup = g['@_parent'] || '';
    if (sub && sup) model.generalizations.push({ id, subClassId: sub, superClassId: sup });
  });

  // Realizaciones
  (Array.isArray(reals) ? reals : [reals]).forEach((r: any) => {
    const id = r['@_id'] || randomUUID();
    const client = r['@_client'] || '';
    const supplier = r['@_supplier'] || '';
    if (client && supplier) model.realizations.push({ id, clientId: client, supplierId: supplier });
  });

  // Dependencias
  (Array.isArray(deps) ? deps : [deps]).forEach((d: any) => {
    const id = d['@_id'] || randomUUID();
    const client = d['@_client'] || '';
    const supplier = d['@_supplier'] || '';
    if (client && supplier) model.dependencies.push({ id, clientId: client, supplierId: supplier });
  });

  // N-arias (si están presentes)
  const naries = root['UML:NaryAssociation'] || [];
  (Array.isArray(naries) ? naries : [naries]).forEach((n: any) => {
    const id = n['@_id'] || randomUUID();
    const name = n['@_name'] || undefined;
    const ends = n['UML:AssociationEnd'] || [];
    const endList = Array.isArray(ends) ? ends : [ends];
    if (endList.length < 3) return;
    const memberEnds = endList.map((e: any) => ({
      classId: e['@_class'] || '',
      multiplicity: e['@_multiplicity'] || undefined,
      role: e['@_role'] || undefined,
    }));
    if (memberEnds.every(m => m.classId)) {
      model.naryAssociations.push({ id, memberEnds, name });
    }
  });

  // Misma política de nunca rechazar para el diseño manual; aquí no se conocen cadenas
  // de paquetes, por lo que una colisión real (no existe en ningún fixture) recurriría
  // a la protección por sufijo numérico en lugar de ser rechazada.
  disambiguateClassifierNames(model, model.classes.map(() => []));

  return model;
}

/**
 * Parsea un documento XMI 2.1 REAL (diseño de Enterprise Architect 6.5):
 * <xmi:XMI> → <uml:Model> → <packagedElement xmi:type="uml:Class|uml:Package|uml:Association">
 * con anidación arbitraria de paquetes. El tipo de elemento proviene del atributo
 * `xmi:type`, nunca del nombre de la etiqueta.
 *
 * Reglas de rigurosidad (especificación xmi:R2 / 15.4 / 15.5):
 * - Nada de <xmi:Extension> se filtra al IR. El ÚNICO uso permitido es el subárbol
 *   <primitivetypes> como tabla de búsqueda id→nombre (para resolver
 *   `xmi:idref="EAJava_string"` en el tipo "string").
 * - Se ignora la geometría de diagrama de EA: el diseño en cuadrícula determina las posiciones posteriormente.
 */
function parseRealXmi21(xmiRoot: any, model: XmiModel): void {
  const classNodes: any[] = [];
  // Ascendencia de paquetes por nodo de clase (alineada por índice con classNodes), utilizada por
  // la política de desambiguación de colisiones a continuación.
  const classNodeChains: string[][] = [];
  const associationNodes: any[] = [];
  const realizationNodes: any[] = [];
  const dependencyNodes: any[] = [];

  // Función auxiliar para extraer elementos hijos de un contenedor admitiendo packagedElement,
  // ownedMember o etiquetas directas de clasificadores UML.
  const getContainerElements = (cont: any): any[] => {
    if (!cont) return [];
    const elements: any[] = [];
    elements.push(...toArray(cont['packagedElement']));
    elements.push(...toArray(cont['ownedMember']));
    elements.push(...toArray(cont['uml:Class']).map((e: any) => ({ ...e, '@_xmi:type': 'uml:Class' })));
    elements.push(...toArray(cont['uml:Interface']).map((e: any) => ({ ...e, '@_xmi:type': 'uml:Interface' })));
    elements.push(...toArray(cont['uml:Package']).map((e: any) => ({ ...e, '@_xmi:type': 'uml:Package' })));
    elements.push(...toArray(cont['uml:Association']).map((e: any) => ({ ...e, '@_xmi:type': 'uml:Association' })));
    elements.push(...toArray(cont['uml:Realization']).map((e: any) => ({ ...e, '@_xmi:type': 'uml:Realization' })));
    elements.push(...toArray(cont['uml:Dependency']).map((e: any) => ({ ...e, '@_xmi:type': 'uml:Dependency' })));
    elements.push(...toArray(cont['Class']).map((e: any) => ({ ...e, '@_xmi:type': 'uml:Class' })));
    elements.push(...toArray(cont['Interface']).map((e: any) => ({ ...e, '@_xmi:type': 'uml:Interface' })));
    elements.push(...toArray(cont['Package']).map((e: any) => ({ ...e, '@_xmi:type': 'uml:Package' })));
    elements.push(...toArray(cont['Association']).map((e: any) => ({ ...e, '@_xmi:type': 'uml:Association' })));
    return elements;
  };

  const walkPackaged = (container: any, chain: string[]) => {
    for (const el of getContainerElements(container)) {
      let type = el['@_xmi:type'] || el['@_xsi:type'] || el['@_type'] || '';
      if (type && !type.includes(':')) {
        type = `uml:${type}`;
      }
      if (type === 'uml:Package') {
        walkPackaged(el, [...chain, el['@_name'] || el['name'] || '']);
      } else if (type === 'uml:Class' || type === 'uml:Interface') {
        classNodes.push(el);
        classNodeChains.push(chain);
      } else if (type === 'uml:Association' || type === 'uml:AssociationClass') {
        associationNodes.push(el);
        if (type === 'uml:AssociationClass') {
          // Mapeo dual: el mismo nodo es también una caja de clase (ver comentario).
          classNodes.push(el);
          classNodeChains.push(chain);
        }
      } else if (type === 'uml:Realization') {
        realizationNodes.push(el);
      } else if (type === 'uml:Dependency') {
        dependencyNodes.push(el);
      }
      // uml:PrimitiveType (solo índice), uml:Abstraction y cualquier otro
      // xmi:type se omite como elemento (el contenido desconocido estilo
      // xmi:Extension es tolerado, nunca importado).
    }
  };

  // Recolectar todos los contenedores raíz posibles: <uml:Model>, <uml:Package>, <Model>, <Package>,
  // o el propio xmiRoot si contiene elementos empaquetados directamente.
  const rootContainers: any[] = [];
  const candidateKeys = ['uml:Model', 'uml:Package', 'Model', 'Package', 'packagedElement', 'ownedMember'];
  for (const key of candidateKeys) {
    const val = xmiRoot?.[key];
    if (val !== undefined) {
      if (key === 'packagedElement' || key === 'ownedMember') {
        rootContainers.push(xmiRoot);
      } else {
        rootContainers.push(...toArray(val));
      }
    }
  }
  if (rootContainers.length === 0 && xmiRoot) {
    rootContainers.push(xmiRoot);
  }
  for (const container of rootContainers) {
    walkPackaged(container, []);
  }

  // ---- Índice id→nombre (clases del modelo + primitivas ÚNICAMENTE de
  // xmi:Extension/primitivetypes) utilizado para resolver `<type xmi:idref>`.
  const nameIndex = new Map<string, string>();
  for (const c of classNodes) {
    const cid = c['@_xmi:id'] || c['@_id'];
    const cname = c['@_name'] || c['name'];
    if (cid && cname) nameIndex.set(cid, cname);
  }
  const indexPrimitiveTypes = (container: any) => {
    for (const el of getContainerElements(container)) {
      const eid = el['@_xmi:id'] || el['@_id'];
      const ename = el['@_name'] || el['name'];
      if (eid && ename) nameIndex.set(eid, ename);
      indexPrimitiveTypes(el); // paquetes de tipos primitivos anidados
    }
  };
  indexPrimitiveTypes(xmiRoot?.['xmi:Extension']?.['primitivetypes'] ?? xmiRoot?.['Extension']?.['primitivetypes']);

  const resolveType = (idref: string | undefined): string | undefined =>
    idref ? (nameIndex.get(idref) ?? idref) : undefined;

  // ---- Paso 2: construir clases (características + generalizaciones hijas) y un
  // índice global de propiedades (los `ownedEnd` propiedad de la asociación y los
  // `ownedAttribute` reflejados en la clase son las MISMAS Propiedades UML, direccionables por xmi:id).
  type EndProp = { type: string | undefined; aggregation: string | undefined; lower: string | undefined; upper: string | undefined; name: string | undefined };
  const propertyIndex = new Map<string, EndProp>();
  const memberEndRefs = new Set<string>();
  const readProp = (el: any): EndProp => ({
    type: el?.['type']?.['@_xmi:idref'],
    aggregation: el?.['@_aggregation'],
    lower: el?.['lowerValue']?.['@_value'],
    upper: el?.['upperValue']?.['@_value'],
    name: el?.['@_name'],
  });

  for (const assoc of associationNodes) {
    for (const end of toArray(assoc['ownedEnd'])) {
      if (end['@_xmi:id']) propertyIndex.set(end['@_xmi:id'], readProp(end));
    }
    for (const me of toArray(assoc['memberEnd'])) {
      const ref = me?.['@_xmi:idref'];
      if (ref) memberEndRefs.add(ref);
    }
  }

  for (const el of classNodes) {
    const id = el['@_xmi:id'] || el['@_id'] || randomUUID();
    const classAttrs: XmiModel['classes'][number]['attributes'] = [];
    const classMethods: XmiModel['classes'][number]['methods'] = [];

    for (const attr of toArray(el['ownedAttribute'] ?? el['UML:Attribute'] ?? el['attribute'])) {
      const attrId = attr['@_xmi:id'] || attr['@_id'];
      // Registrar CADA propiedad de extremo (extremos de asociación reflejados incluidos) en
      // el índice para que las asociaciones puedan resolverlos posteriormente.
      if (attrId) propertyIndex.set(attrId, readProp(attr));

      // Extremo de asociación vs atributo de característica: un ownedAttribute que declara
      // un propietario `association` (o cuyo id es referenciado por el memberEnd de alguna
      // Asociación) es un extremo de relación, NO una característica — nunca importarlo como
      // atributo (evita que Producto filtre un 4to atributo fantasma).
      const isRelationEnd = Boolean(attr['@_association']) || Boolean(attrId && memberEndRefs.has(attrId));
      if (isRelationEnd) continue;

      // XMI 2.1 almacena el tipo de la característica como referencia hija, no como atributo.
      const typeId = resolveType(attr['type']?.['@_xmi:idref'] || attr['type']?.['@_idref'] || attr['@_type'] || attr['type']);
      // LiteralIntegers lower/upper → cadena de multiplicidad UML (1/1 → "1").
      const lower = attr['lowerValue']?.['@_value'];
      const upper = attr['upperValue']?.['@_value'];
      let multiplicity: string | undefined;
      if (lower !== undefined || upper !== undefined) {
        const l = lower ?? '1';
        const u = upper ?? '1';
        multiplicity = (l === u && l !== '-1') ? l : `${l === '-1' ? '*' : l}..${u === '-1' ? '*' : u}`;
      }

      classAttrs.push({
        name: attr['@_name'] || attr['name'] || '',
        type: typeId || attr['@_type'] || attr['type'] || 'String',
        visibility: attr['@_visibility'] || '+',
        isStatic: attr['@_isStatic'] === 'true',
        isDerived: attr['@_isDerived'] === 'true',
        ...(multiplicity !== undefined ? { multiplicity } : {}),
      });
    }

    // ownedOperation → métodos. En las exportaciones de EA 6.5 los parámetros de cada operación
    // son hijos `ownedParameter` cuyo tipo es un idref de ATRIBUTO (type="EAJava_int"),
    // y el "parámetro" de retorno (direction="return") es el returnType — nunca debe filtrarse
    // a la lista de parámetros.
    for (const op of toArray(el['ownedOperation'] ?? el['UML:Operation'] ?? el['operation'])) {
      let namedReturnType: string | undefined;
      let firstReturnType: string | undefined;
      const parameters: Array<{ name: string; type: string }> = [];
      for (const p of toArray(op['ownedParameter'] ?? op['UML:Parameter'] ?? op['parameter'])) {
        // El idref de tipo se encuentra aquí en el atributo @_type (no es un hijo <type>).
        const resolved = resolveType(p['@_type'] || p['type']);
        if (p['@_direction'] === 'return') {
          if (p['@_name'] === 'return') {
            if (namedReturnType === undefined && resolved) namedReturnType = resolved;
          } else if (firstReturnType === undefined && resolved) {
            firstReturnType = resolved;
          }
          continue;
        }
        if ((p['@_name'] || p['name']) && resolved) {
          parameters.push({ name: p['@_name'] || p['name'], type: resolved });
        }
      }
      const returnType = namedReturnType ?? firstReturnType ?? 'void';
      classMethods.push({
        name: op['@_name'] || op['name'] || '',
        returnType,
        visibility: op['@_visibility'] || '+',
        isStatic: op['@_isStatic'] === 'true',
        parameters,
      });
    }

    const rawElType = el['@_xmi:type'] || el['@_xsi:type'] || el['@_type'] || '';
    const isInterface = rawElType === 'uml:Interface' || rawElType === 'Interface';
    model.classes.push({
      id,
      name: el['@_name'] || el['name'] || 'Unnamed',
      kind: isInterface ? 'interface' : 'class',
      isAbstract: el['@_isAbstract'] === 'true',
      attributes: classAttrs,
      methods: classMethods,
    });

    // La generalización es un HIJO de la subclase en XMI 2.1:
    // <generalization xmi:type="uml:Generalization" general="SUPER_ID"/>
    // dentro de la subclase. Por ende: subClassId = esta clase, superClassId = @general.
    for (const g of toArray(el['generalization'])) {
      const sup = g['@_general'];
      if (sup) {
        model.generalizations.push({ id: g['@_xmi:id'] || randomUUID(), subClassId: id, superClassId: sup });
      }
    }
  }

  // ---- Paso 3: asociaciones. Resolver cada idref de memberEnd a través del
  // índice de propiedades; derivar el par conectado y el tipo de agregación.
  //
  // Decisión de propiedad de la composición (documentada para paridad con el
  // fixture manual ea-sample): en las exportaciones de EA 6.5, la propiedad del extremo
  // que porta aggregation="composite|shared" tiene un idref `type` que apunta al TODO
  // (el extremo donde se ubica el diamante) — p. ej. conector EAID_E31D9ED5 con
  // ea_type=Aggregation/subtype=Strong con source=Producto/target=Class1 y su extremo
  // compuesto tipifica Producto. Emitimos source=todo, target=parte y aggregationEnd='source',
  // exactamente como el fixture manual codifica Order◆—OrderLine (el origen porta el marcador compuesto).
  const multiplicityOf = (e: EndProp): string | undefined => {
    if (e.lower === undefined && e.upper === undefined) return undefined;
    const l = e.lower ?? '1';
    const u = e.upper ?? '1';
    return (l === u && l !== '-1') ? l : `${l === '-1' ? '*' : l}..${u === '-1' ? '*' : u}`;
  };

  for (const assoc of associationNodes) {
    const id = assoc['@_xmi:id'] || randomUUID();
    const refs = toArray(assoc['memberEnd']).map((me: any) => me?.['@_xmi:idref']).filter(Boolean);
    const ends = refs.map((r: string) => propertyIndex.get(r)).filter(Boolean) as EndProp[];
    const typedEnds = ends.filter(e => e.type);
    if (typedEnds.length < 2) continue; // asociación colgante sin memberEnd: omitir, nunca inventar

    // ---- Enrutamiento N-ario: una asociación con 3+ extremos miembro tipificados distintos
    // es una auténtica asociación n-aria UML (p. ej. EAID_56CC2820 vinculando Class2, Class4 y Class3).
    // Emitirla como origen/destino binario descartaría silenciosamente los extremos intermedios,
    // por lo que se envía a naryAssociations. Los ids de clase duplicados dentro de una misma asociación
    // se colapsan (el motor los prohíbe).
    if (typedEnds.length >= 3) {
      const seen = new Set<string>();
      const memberEnds: XmiModel['naryAssociations'][number]['memberEnds'] = [];
      for (const e of typedEnds) {
        const classId = e.type!;
        if (seen.has(classId)) continue;
        seen.add(classId);
        const multiplicity = multiplicityOf(e);
        memberEnds.push({
          classId,
          ...(multiplicity !== undefined ? { multiplicity } : {}),
          ...(e.name ? { role: e.name } : {}),
        });
      }
      if (memberEnds.length >= 3) {
        model.naryAssociations.push({
          id,
          memberEnds,
          ...(assoc['@_name'] ? { name: assoc['@_name'] } : {}),
        });
      }
      continue;
    }

    // El primer/último memberEnd en orden de documento anclan la dirección emitida para
    // asociaciones simples (no agregadas).
    const firstEnd = typedEnds[0];
    const lastEnd = typedEnds[typedEnds.length - 1];
    if (!firstEnd || !lastEnd || !firstEnd.type || !lastEnd.type) continue;

    let aggregation: 'none' | 'shared' | 'composite' = 'none';
    let diamondEnd: EndProp | undefined;
    for (const e of typedEnds) {
      if (e.aggregation === 'composite' || e.aggregation === 'shared') {
        aggregation = e.aggregation;
        diamondEnd = e;
        break;
      }
    }

    let source: string;
    let target: string;
    const aggregationEnd: 'source' = 'source';
    if (diamondEnd && diamondEnd.type && typedEnds.length === 2) {
      const whole = diamondEnd.type;
      const part = typedEnds.find(e => e.type !== whole)?.type ?? whole; // autocomposición recurre a la misma clase
      source = whole;
      target = part;
    } else {
      source = firstEnd.type;
      target = lastEnd.type;
    }

    // Los extremos en exportaciones reales de EA a menudo no tienen nombre/multiplicidad: esos campos
    // permanecen omitidos para que el lote utilice los valores vacíos por defecto de PR13d (opcionales).
    const sourceMultiplicity = multiplicityOf(firstEnd);
    const targetMultiplicity = multiplicityOf(lastEnd);
    model.associations.push({
      id,
      source,
      target,
      aggregation,
      aggregationEnd,
      ...(assoc['@_name'] ? { name: assoc['@_name'] } : {}),
      ...(firstEnd.name ? { sourceRole: firstEnd.name } : {}),
      ...(lastEnd.name ? { targetRole: lastEnd.name } : {}),
      ...(sourceMultiplicity !== undefined ? { sourceMultiplicity } : {}),
      ...(targetMultiplicity !== undefined ? { targetMultiplicity } : {}),
    });
  }

  // ---- Realizaciones (uml:Realization como packagedElement de nivel superior):
  // el cliente realiza al proveedor, donde el proveedor es la interfaz. El paso de emisión
  // resuelve ambos mediante el mapa de ids de clasificadores y omite extremos no resolubles.
  for (const r of realizationNodes) {
    const client = r['@_client'];
    const supplier = r['@_supplier'];
    if (client && supplier) {
      model.realizations.push({ id: r['@_xmi:id'] || randomUUID(), clientId: client, supplierId: supplier });
    }
  }

  // ---- Dependencias (uml:Dependency como packagedElement de nivel superior):
  // cliente depende-de proveedor. A diferencia de una realización, el motor permite que el
  // proveedor (y cliente) sea CUALQUIER clasificador, interfaz incluida (la regla
  // RealizationTargetNotInterface no aplica a dependencias). La dirección coincide con la ruta
  // manual de UML:Dependency y la semántica delta clientClassId -> supplierClassId del motor.
  for (const dep of dependencyNodes) {
    const client = dep['@_client'];
    const supplier = dep['@_supplier'];
    if (client && supplier) {
      model.dependencies.push({ id: dep['@_xmi:id'] || randomUUID(), clientId: client, supplierId: supplier });
    }
  }

  // ---- Desambiguación de colisiones (fixture 6): model.classes y
  // classNodeChains están alineados por índice (ambos construidos iterando classNodes en orden de
  // documento), por lo que cada clasificador porta su propia ascendencia de paquetes. Solo los nombres
  // con colisiones reales se califican; todo lo demás permanece simple.
  disambiguateClassifierNames(model, classNodeChains);
}

function xmiToDeltaBatch(model: XmiModel, diagramId: string): BatchDelta {
  // Promover clasificadores destino de una realización a tipo 'interface'
  // para que el motor aplique la realización sin fallar con RealizationTargetNotInterfaceError.
  const realizationSuppliers = new Set(model.realizations.map(r => r.supplierId));
  for (const c of model.classes) {
    if (realizationSuppliers.has(c.id) && c.kind === 'class') {
      c.kind = 'interface';
      c.isAbstract = true;
    }
  }

  // Construir remapeo de id XMI → UUID para todas las clases
  const classIdMap = new Map<string, string>();
  for (const c of model.classes) {
    classIdMap.set(c.id, randomUUID());
  }

  // Construir clases posicionadas para el diseño en cuadrícula
  const positioned = model.classes.map(c => ({ id: c.id, x: 0, y: 0 }));
  gridLayout(positioned, 150);
  const positionMap = new Map<string, { x: number; y: number }>();
  for (const p of positioned) {
    positionMap.set(p.id, { x: p.x, y: p.y });
  }

  const now = new Date().toISOString();
  const deltas: Delta[] = [];

  // Clases
  for (const c of model.classes) {
    const uuid = classIdMap.get(c.id)!;
    const pos = positionMap.get(c.id)!;
    deltas.push({
      kind: 'class',
      id: randomUUID(),
      diagramId,
      timestamp: now,
      op: 'create',
      classId: uuid,
      name: c.name,
      classKind: c.kind,
      isAbstract: c.isAbstract,
      position: { x: pos.x, y: pos.y },
    } as ClassDelta);

    // La operación create del motor deliberadamente no persiste isAbstract (unidad
    // 12.4: la marca abstracta viaja en un delta `update` de clase). Emitir el
    // seguimiento para que las interfaces/clases abstractas importadas conserven el flag en el
    // diagrama aplicado en lugar de revertir silenciosamente a false.
    if (c.isAbstract) {
      deltas.push({
        kind: 'class',
        id: randomUUID(),
        diagramId,
        timestamp: now,
        op: 'update',
        classId: uuid,
        isAbstract: true,
      } as ClassDelta);
    }

    // Invariante de nombres únicos de miembros por clase (el motor core rechaza nombres duplicados
    // entre atributos y métodos de una misma clase con DuplicateMemberError).
    const usedMemberNames = new Set<string>();

    // Atributos
    for (const attr of c.attributes) {
      let attrName = attr.name;
      if (usedMemberNames.has(attrName)) {
        let counter = 2;
        while (usedMemberNames.has(`${attrName}_${counter}`)) {
          counter++;
        }
        attrName = `${attrName}_${counter}`;
      }
      usedMemberNames.add(attrName);

      deltas.push({
        kind: 'member',
        id: randomUUID(),
        diagramId,
        timestamp: now,
        op: 'addAttribute',
        classId: uuid,
        memberId: randomUUID(),
        name: attrName,
        type: attr.type,
        visibility: normalizeVisibility(attr.visibility),
        ...(attr.isStatic !== undefined ? { isStatic: attr.isStatic } : {}),
        ...(attr.isDerived !== undefined ? { isDerived: attr.isDerived } : {}),
        ...(attr.multiplicity !== undefined ? { multiplicity: attr.multiplicity } : {}),
      } as MemberDelta);
    }

    // Métodos (métodos sobrecargados en XMI se diferencian para cumplir con la invariante de unicidad de core)
    for (const method of c.methods) {
      let methodName = method.name;
      if (usedMemberNames.has(methodName)) {
        let counter = 2;
        while (usedMemberNames.has(`${methodName}_${counter}`)) {
          counter++;
        }
        methodName = `${methodName}_${counter}`;
      }
      usedMemberNames.add(methodName);

      deltas.push({
        kind: 'member',
        id: randomUUID(),
        diagramId,
        timestamp: now,
        op: 'addMethod',
        classId: uuid,
        memberId: randomUUID(),
        name: methodName,
        returnType: method.returnType,
        parameters: method.parameters,
        visibility: normalizeVisibility(method.visibility),
        ...(method.isStatic !== undefined ? { isStatic: method.isStatic } : {}),
      } as MemberDelta);
    }
  }

  // Asociaciones
  for (const a of model.associations) {
    const sourceUuid = classIdMap.get(a.source);
    const targetUuid = classIdMap.get(a.target);
    if (!sourceUuid || !targetUuid) continue;
    deltas.push({
      kind: 'association',
      id: randomUUID(),
      diagramId,
      timestamp: now,
      op: 'create',
      associationId: randomUUID(),
      sourceClassId: sourceUuid,
      targetClassId: targetUuid,
      // Los portadores opcionales solo se emiten cuando están definidos: exportaciones reales de EA tienen
      // extremos de asociación sin nombre y sin multiplicidad, y AssociationDeltaSchema
      // es .strict() (PR13d: las multiplicidades al crear son opcionales).
      ...(a.name !== undefined ? { name: a.name } : {}),
      ...(a.sourceRole !== undefined ? { sourceRole: a.sourceRole } : {}),
      ...(a.targetRole !== undefined ? { targetRole: a.targetRole } : {}),
      ...(a.sourceMultiplicity !== undefined ? { sourceMultiplicity: a.sourceMultiplicity } : {}),
      ...(a.targetMultiplicity !== undefined ? { targetMultiplicity: a.targetMultiplicity } : {}),
      aggregation: a.aggregation,
      aggregationEnd: a.aggregationEnd,
      directed: false,
    } as AssociationDelta);
  }

  // Generalizaciones
  const seenGeneralizations = new Set<string>();
  for (const g of model.generalizations) {
    const subUuid = classIdMap.get(g.subClassId);
    const superUuid = classIdMap.get(g.superClassId);
    // Omitir aristas no resolubles, auto-bucles (sub === super) o duplicados exactos
    if (!subUuid || !superUuid || subUuid === superUuid) continue;
    const key = `${subUuid}->${superUuid}`;
    if (seenGeneralizations.has(key)) continue;
    seenGeneralizations.add(key);

    deltas.push({
      kind: 'generalization',
      id: randomUUID(),
      diagramId,
      timestamp: now,
      op: 'create',
      generalizationId: randomUUID(),
      subClassId: subUuid,
      superClassId: superUuid,
      ...(g.name !== undefined ? { name: g.name } : {}),
    } as GeneralizationDelta);
  }

  // Realizaciones
  const seenRealizations = new Set<string>();
  for (const r of model.realizations) {
    const clientUuid = classIdMap.get(r.clientId);
    const supplierUuid = classIdMap.get(r.supplierId);
    if (!clientUuid || !supplierUuid || clientUuid === supplierUuid) continue;
    const key = `${clientUuid}->${supplierUuid}`;
    if (seenRealizations.has(key)) continue;
    seenRealizations.add(key);

    deltas.push({
      kind: 'realization',
      id: randomUUID(),
      diagramId,
      timestamp: now,
      op: 'create',
      realizationId: randomUUID(),
      clientClassId: clientUuid,
      supplierInterfaceId: supplierUuid,
    } as RealizationDelta);
  }

  // Dependencias
  const seenDependencies = new Set<string>();
  for (const d of model.dependencies) {
    const clientUuid = classIdMap.get(d.clientId);
    const supplierUuid = classIdMap.get(d.supplierId);
    if (!clientUuid || !supplierUuid) continue;
    const key = `${clientUuid}->${supplierUuid}`;
    if (seenDependencies.has(key)) continue;
    seenDependencies.add(key);

    deltas.push({
      kind: 'dependency',
      id: randomUUID(),
      diagramId,
      timestamp: now,
      op: 'create',
      dependencyId: randomUUID(),
      clientClassId: clientUuid,
      supplierClassId: supplierUuid,
    } as DependencyDelta);
  }

  // N-arias
  for (const n of model.naryAssociations) {
    const memberEnds = n.memberEnds
      .map(end => {
        const classUuid = classIdMap.get(end.classId);
        if (!classUuid) return null;
        return {
          classId: classUuid,
          multiplicity: end.multiplicity ?? '1',
          ...(end.role !== undefined ? { role: end.role } : {}),
        };
      })
      .filter((end): end is { classId: string; multiplicity: string; role?: string } => end !== null);

    if (memberEnds.length >= 3) {
      deltas.push({
        kind: 'naryAssociation',
        id: randomUUID(),
        diagramId,
        timestamp: now,
        op: 'create',
        naryAssociationId: randomUUID(),
        memberEnds,
        ...(n.name !== undefined ? { name: n.name } : {}),
      } as NaryAssociationDelta);
    }
  }

  return {
    kind: 'batch',
    id: randomUUID(),
    diagramId,
    timestamp: now,
    deltas,
  } as BatchDelta;
}

export { parseXmiDocument, xmiToDeltaBatch };