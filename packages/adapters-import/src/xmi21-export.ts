import { randomUUID } from 'crypto';
import type { Diagram, Class, Association, Generalization, Realization, Dependency, NaryAssociation } from '@app/core';

// ── Escape de XML ──────────────────────────────────────────────────────────────

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ── Funciones auxiliares para construir atributos de propiedad UML ────────────

function visAttr(v: string | undefined): string {
  if (!v || v === '+') return '';
  return ` visibility="${esc(v)}"`;
}

function boolAttr(name: string, val: boolean | undefined): string {
  return val ? ` ${name}="true"` : '';
}

function eaScope(visibility: string | undefined): string {
  switch (visibility) {
    case '-': return 'Private';
    case '#': return 'Protected';
    case '~': return 'Package';
    case '+':
    default:
      return 'Public';
  }
}

function toDuid(id: string): string {
  return id.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8).toUpperCase() || 'EADUID';
}

export interface ResolvedTypeInfo {
  id: string;
  name: string;
  isClass: boolean;
}

/**
 * Normaliza y resuelve un tipo de datos UML de forma insensible a mayúsculas/minúsculas.
 * Si no se detecta ningún tipo de dato válido (vacío, undefined, null, 'none' o 'void' para atributos),
 * retorna null para que no se invente un tipo espurio ni se rompa la exportación.
 * Si coincide con una clase del diagrama (case-insensitively), retorna el ID y nombre de dicha clase.
 * Si es un tipo primitivo conocido, retorna el ID canónico de EA y su nombre.
 * Si es un tipo personalizado no primitivo, genera un ID EAJava válido preservando su nombre.
 */
export function resolveDataType(
  rawType: string | undefined,
  classes: Class[],
  isAttribute = false
): ResolvedTypeInfo | null {
  if (!rawType) return null;
  const trimmed = rawType.trim();
  if (trimmed.length === 0) return null;

  const lower = trimmed.toLowerCase();
  if (lower === 'none' || lower === 'undefined' || lower === 'null') {
    return null;
  }
  if (isAttribute && lower === 'void') {
    return null;
  }

  // 1. Coincidencia insensible a mayúsculas con clases existentes en el diagrama
  const matchedClass = classes.find(
    c => c.name.toLowerCase() === lower || c.id === trimmed
  );
  if (matchedClass) {
    return {
      id: matchedClass.id,
      name: matchedClass.name,
      isClass: true,
    };
  }

  // 2. Diccionario de primitivos estándar (case-insensitive)
  switch (lower) {
    case 'string':
    case 'str':
      return trimmed === 'string'
        ? { id: 'EAJava_string', name: 'string', isClass: false }
        : { id: 'EAJava_String', name: 'String', isClass: false };
    case 'int':
      return { id: 'EAJava_int', name: 'int', isClass: false };
    case 'integer':
      return trimmed === 'integer'
        ? { id: 'EAJava_int', name: 'int', isClass: false }
        : { id: 'EAJava_Integer', name: 'Integer', isClass: false };
    case 'boolean':
    case 'bool':
      return trimmed === 'Boolean'
        ? { id: 'EAJava_Boolean', name: 'Boolean', isClass: false }
        : { id: 'EAJava_boolean', name: 'boolean', isClass: false };
    case 'double':
      return { id: 'EAJava_double', name: 'double', isClass: false };
    case 'float':
      return { id: 'EAJava_float', name: 'float', isClass: false };
    case 'long':
      return trimmed === 'Long'
        ? { id: 'EAJava_Long', name: 'Long', isClass: false }
        : { id: 'EAJava_long', name: 'long', isClass: false };
    case 'short':
      return { id: 'EAJava_short', name: 'short', isClass: false };
    case 'byte':
      return { id: 'EAJava_byte', name: 'byte', isClass: false };
    case 'char':
    case 'character':
      return { id: 'EAJava_char', name: 'char', isClass: false };
    case 'date':
      return { id: 'EAJava_Date', name: 'Date', isClass: false };
    case 'datetime':
      return { id: 'EAJava_DateTime', name: 'DateTime', isClass: false };
    case 'timestamp':
      return { id: 'EAJava_Timestamp', name: 'Timestamp', isClass: false };
    case 'uuid':
    case 'guid':
      return { id: 'EAJava_UUID', name: 'UUID', isClass: false };
    case 'bigdecimal':
    case 'decimal':
      return { id: 'EAJava_BigDecimal', name: 'BigDecimal', isClass: false };
    case 'number':
      return { id: 'EAJava_double', name: 'double', isClass: false };
    case 'void':
      return { id: 'EAJava_void', name: 'void', isClass: false };
  }

  // 3. Tipo personalizado arbitrario
  const cleanId = trimmed.replace(/[^a-zA-Z0-9_]/g, '_');
  return {
    id: `EAJava_${cleanId}`,
    name: trimmed,
    isClass: false,
  };
}

// ── Funciones auxiliares de multiplicidad ─────────────────────────────────────

/**
 * Construye elementos hijos lowerValue/upperValue a partir de una cadena de multiplicidad UML.
 * Valores individuales como "1" se convierten en un único LiteralInteger.
 * Rangos como "0..*" se convierten en lowerValue=0, upperValue=-1 (UnlimitedNatural).
 * Retorna una cadena vacía si no hay multiplicidad.
 */
function multiplicityXml(mult: string | undefined): string {
  if (!mult) return '';
  if (mult === '*') {
    return `<lowerValue xmi:type="uml:LiteralInteger" xmi:id="${randomUUID()}" value="0"/>` +
           `<upperValue xmi:type="uml:LiteralUnlimitedNatural" xmi:id="${randomUUID()}" value="-1"/>`;
  }
  if (mult.includes('..')) {
    const [lower, upper] = mult.split('..');
    const lowerVal = lower ?? '0';
    const upperXml = upper === '*'
      ? `<upperValue xmi:type="uml:LiteralUnlimitedNatural" xmi:id="${randomUUID()}" value="-1"/>`
      : `<upperValue xmi:type="uml:LiteralInteger" xmi:id="${randomUUID()}" value="${esc(upper)}"/>`;
    return `<lowerValue xmi:type="uml:LiteralInteger" xmi:id="${randomUUID()}" value="${esc(lowerVal)}"/>${upperXml}`;
  }
  // Entero simple: ambos límites iguales
  return `<lowerValue xmi:type="uml:LiteralInteger" xmi:id="${randomUUID()}" value="${esc(mult)}"/>` +
         `<upperValue xmi:type="uml:LiteralInteger" xmi:id="${randomUUID()}" value="${esc(mult)}"/>`;
}

// ── Mapeo de agregación ──────────────────────────────────────────────────────

function aggregationAttr(a: Association): string {
  if (a.aggregation === 'none') return '';
  return ` aggregation="${esc(a.aggregation)}"`;
}

// ── Exportación XMI 2.1 ───────────────────────────────────────────────────────────

/**
 * Exporta un IR Diagram a un documento estándar UML 2.x XMI 2.1 que
 * Enterprise Architect puede importar. La salida utiliza el diseño real de EA 6.5:
 *
 *   <xmi:XMI xmi:version="2.1">
 *     <uml:Model ...>
 *       <packagedElement xmi:type="uml:Class" ...>
 *         <ownedAttribute ...>  (características de la clase)
 *         <ownedOperation ...>  (métodos)
 *         <generalization ...>  (hijo de la subclase)
 *       </packagedElement>
 *       <packagedElement xmi:type="uml:Association" ...>
 *         <memberEnd / ownedEnd>  (propiedades)
 *       </packagedElement>
 *       <packagedElement xmi:type="uml:Generalization" .../>
 *       <packagedElement xmi:type="uml:Realization" .../>
 *       <packagedElement xmi:type="uml:Dependency" .../>
 *     </uml:Model>
 *     <xmi:Extension>
 *       <layout>  (posiciones en el lienzo, no estándar UML pero preservadas para round-trip)
 *     </xmi:Extension>
 *   </xmi:XMI>
 */
export function exportDiagramToXmi(diagram: Diagram): string {
  const lines: string[] = [];
  const cleanId = diagram.id.replace(/-/g, '_');
  const packageId = `EAPK_${cleanId}`;
  const diagramId = `EAID_${cleanId}`;
  const primitiveTypesMap = new Map<string, ResolvedTypeInfo>();

  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push(`<xmi:XMI xmi:version="2.1" xmlns:xmi="http://schema.omg.org/spec/XMI/2.1" xmlns:uml="http://schema.omg.org/spec/UML/2.1" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">`);
  lines.push(`  <xmi:Documentation exporter="Enterprise Architect" exporterVersion="6.5"/>`);
  lines.push(`  <uml:Model xmi:type="uml:Model" xmi:id="${diagram.id}" name="EA_Model" visibility="public">`);
  lines.push(`    <packagedElement xmi:type="uml:Package" xmi:id="${packageId}" name="${esc(diagram.name)}" visibility="public">`);

  // ── Construir mapas de id para referencias cruzadas ─────────────────────────
  const classIdSet = new Set(diagram.classes.map(c => c.id));
  const ifaceIds = new Set(diagram.classes.filter(c => c.kind === 'interface').map(c => c.id));

  // ── Clases e Interfaces ──────────────────────────────────────────────────
  for (const cls of diagram.classes) {
    const xmiType = cls.kind === 'interface' ? 'uml:Interface' : 'uml:Class';
    lines.push(`      <packagedElement xmi:type="${xmiType}" xmi:id="${cls.id}" name="${esc(cls.name)}"${boolAttr('isAbstract', cls.isAbstract)}>`);

    // ownedAttribute (características de la clase — NO extremos de asociación)
    for (const attr of cls.attributes) {
      const attrId = attr.id;
      const isStatic = attr.isStatic ? 'true' : 'false';
      const isDerived = attr.isDerived ? 'true' : 'false';
      lines.push(`      <ownedAttribute xmi:type="uml:Property" xmi:id="${attrId}" name="${esc(attr.name)}"${visAttr(attr.visibility)} isStatic="${isStatic}" isReadOnly="false" isDerived="${isDerived}" isOrdered="false" isUnique="true" isDerivedUnion="false">`);
      if (attr.multiplicity) {
        lines.push(`        ${multiplicityXml(attr.multiplicity)}`);
      } else {
        lines.push(`        <lowerValue xmi:type="uml:LiteralInteger" xmi:id="${randomUUID()}" value="1"/>`);
        lines.push(`        <upperValue xmi:type="uml:LiteralInteger" xmi:id="${randomUUID()}" value="1"/>`);
      }
      const resolved = resolveDataType(attr.type, diagram.classes, true);
      if (resolved) {
        if (!resolved.isClass) primitiveTypesMap.set(resolved.id, resolved);
        lines.push(`        <type xmi:idref="${esc(resolved.id)}"/>`);
      }
      lines.push(`      </ownedAttribute>`);
    }

    // Atributos reflejados de extremos de asociación (ownedAttribute con ref de asociación)
    // Los emitimos como parte de la sección de asociación, no aquí.

    // ownedOperation (métodos)
    for (const method of cls.methods) {
      const methodId = method.id;
      lines.push(`      <ownedOperation xmi:type="uml:Operation" xmi:id="${methodId}" name="${esc(method.name)}"${visAttr(method.visibility)}${boolAttr('isStatic', method.isStatic)}>`);

      // Parámetros de entrada
      for (const param of method.parameters) {
        const resolvedParam = resolveDataType(param.type, diagram.classes, true);
        if (resolvedParam && !resolvedParam.isClass) primitiveTypesMap.set(resolvedParam.id, resolvedParam);
        const typeAttr = resolvedParam ? ` type="${esc(resolvedParam.name)}"` : '';
        lines.push(`        <ownedParameter xmi:type="uml:Parameter" xmi:id="${randomUUID()}" name="${esc(param.name)}" direction="in"${typeAttr}/>`);
      }

      // Parámetro de retorno (direction="return")
      const resolvedRet = resolveDataType(method.returnType, diagram.classes, false);
      if (resolvedRet) {
        if (!resolvedRet.isClass) primitiveTypesMap.set(resolvedRet.id, resolvedRet);
        lines.push(`        <ownedParameter xmi:type="uml:Parameter" xmi:id="${randomUUID()}" name="return" direction="return" type="${esc(resolvedRet.name)}"/>`);
      }

      lines.push(`      </ownedOperation>`);
    }

    // Generalización como hijo de la subclase
    const subGens = diagram.generalizations.filter(g => g.subClassId === cls.id);
    for (const gen of subGens) {
      lines.push(`      <generalization xmi:type="uml:Generalization" xmi:id="${gen.id}" general="${gen.superClassId}"${gen.name ? ` name="${esc(gen.name)}"` : ''}/>`);
    }

    lines.push(`    </packagedElement>`);
  }

  // ── Asociaciones (binarias) ───────────────────────────────────────────────
  for (const assoc of diagram.associations) {
    const sourceIsWhole = assoc.aggregationEnd === 'source';
    const diamondEnd = sourceIsWhole ? assoc.sourceClassId : assoc.targetClassId;

    lines.push(`    <packagedElement xmi:type="uml:Association" xmi:id="${assoc.id}" name="${assoc.name ? esc(assoc.name) : ''}">`);

    // Referencias memberEnd (dos extremos)
    lines.push(`      <memberEnd xmi:idref="${assoc.id}_src"/>`);
    lines.push(`      <memberEnd xmi:idref="${assoc.id}_tgt"/>`);

    // Extremo origen (ownedEnd)
    const srcAgg = (assoc.aggregation !== 'none' && sourceIsWhole) ? ` aggregation="${esc(assoc.aggregation)}"` : '';
    lines.push(`      <ownedEnd xmi:type="uml:Property" xmi:id="${assoc.id}_src"${srcAgg}${assoc.sourceRole ? ` name="${esc(assoc.sourceRole)}"` : ''} isStatic="false" isReadOnly="false" isDerived="false" isOrdered="false" isUnique="true" isDerivedUnion="false">`);
    lines.push(`        <type xmi:idref="${assoc.sourceClassId}"/>`);
    if (assoc.sourceMultiplicity) {
      lines.push(`        ${multiplicityXml(assoc.sourceMultiplicity)}`);
    }
    lines.push(`      </ownedEnd>`);

    // Extremo destino (ownedEnd)
    const tgtAgg = (assoc.aggregation !== 'none' && !sourceIsWhole) ? ` aggregation="${esc(assoc.aggregation)}"` : '';
    lines.push(`      <ownedEnd xmi:type="uml:Property" xmi:id="${assoc.id}_tgt"${tgtAgg}${assoc.targetRole ? ` name="${esc(assoc.targetRole)}"` : ''} isStatic="false" isReadOnly="false" isDerived="false" isOrdered="false" isUnique="true" isDerivedUnion="false">`);
    lines.push(`        <type xmi:idref="${assoc.targetClassId}"/>`);
    if (assoc.targetMultiplicity) {
      lines.push(`        ${multiplicityXml(assoc.targetMultiplicity)}`);
    }
    lines.push(`      </ownedEnd>`);

    lines.push(`    </packagedElement>`);
  }

  // ── Generalizaciones (nivel superior — aquellas no emitidas ya como hijos) ──
  // Algunas generalizaciones se emiten arriba como hijos de la subclase.
  // También podríamos emitirlas a nivel superior para completitud (EA permite ambas distribuciones).
  // Sin embargo, para satisfacer la expectativa del importador (hijo de la subclase), las mantenemos
  // ÚNICAMENTE como hijos (ya emitidas arriba). Sin duplicados en el nivel superior.

  // ── Realizaciones ────────────────────────────────────────────────────────
  for (const real of diagram.realizations) {
    lines.push(`    <packagedElement xmi:type="uml:Realization" xmi:id="${real.id}" client="${real.clientClassId}" supplier="${real.supplierInterfaceId}"${real.name ? ` name="${esc(real.name)}"` : ''}/>`);
  }

  // ── Dependencias ─────────────────────────────────────────────────────────
  for (const dep of diagram.dependencies) {
    lines.push(`    <packagedElement xmi:type="uml:Dependency" xmi:id="${dep.id}" client="${dep.clientClassId}" supplier="${dep.supplierClassId}"${dep.name ? ` name="${esc(dep.name)}"` : ''}/>`);
  }

  // ── Asociaciones N-arias ──────────────────────────────────────────────────
  for (const nary of diagram.naryAssociations) {
    lines.push(`    <packagedElement xmi:type="uml:Association" xmi:id="${nary.id}" name="${nary.name ? esc(nary.name) : ''}">`);
    for (let i = 0; i < nary.memberEnds.length; i++) {
      const end = nary.memberEnds[i];
      const endId = `${nary.id}_end${i}`;
      lines.push(`      <memberEnd xmi:idref="${endId}"/>`);
    }
    for (let i = 0; i < nary.memberEnds.length; i++) {
      const end = nary.memberEnds[i];
      const endId = `${nary.id}_end${i}`;
      lines.push(`      <ownedEnd xmi:type="uml:Property" xmi:id="${endId}"${end.role ? ` name="${esc(end.role)}"` : ''} isStatic="false" isReadOnly="false" isDerived="false" isOrdered="false" isUnique="true" isDerivedUnion="false">`);
      lines.push(`        <type xmi:idref="${end.classId}"/>`);
      if (end.multiplicity) {
        lines.push(`        ${multiplicityXml(end.multiplicity)}`);
      }
      lines.push(`      </ownedEnd>`);
    }
    lines.push(`    </packagedElement>`);
  }

  lines.push(`    </packagedElement>`);
  lines.push(`  </uml:Model>`);

  // ── Extensión nativa de Enterprise Architect (renderizado directo del diagrama) ──
  lines.push(`  <xmi:Extension extender="Enterprise Architect" extenderID="6.5">`);
  lines.push(`    <elements>`);
  lines.push(`      <element xmi:idref="${packageId}" xmi:type="uml:Package" name="${esc(diagram.name)}" scope="public">`);
  lines.push(`        <model package2="${diagramId}" tpos="0" ea_localid="1" ea_eleType="package"/>`);
  lines.push(`        <properties isSpecification="false" sType="Package" nType="0" scope="public"/>`);
  lines.push(`        <project author="UMLDesignTool" version="1.0"/>`);
  lines.push(`      </element>`);
  for (let i = 0; i < diagram.classes.length; i++) {
    const cls = diagram.classes[i];
    const sType = cls.kind === 'interface' ? 'Interface' : 'Class';
    const xmiType = cls.kind === 'interface' ? 'uml:Interface' : 'uml:Class';
    lines.push(`      <element xmi:idref="${cls.id}" xmi:type="${xmiType}" name="${esc(cls.name)}" scope="public">`);
    lines.push(`        <model package="${packageId}" tpos="0" ea_localid="${i + 2}" ea_eleType="element"/>`);
    lines.push(`        <properties isSpecification="false" sType="${sType}" nType="0" scope="public"/>`);
    lines.push(`        <project author="UMLDesignTool" version="1.0"/>`);

    if (cls.attributes.length > 0) {
      lines.push(`        <attributes>`);
      for (const attr of cls.attributes) {
        const resolved = resolveDataType(attr.type, diagram.classes, true);
        const typeStr = resolved ? esc(resolved.name) : '';
        const scope = eaScope(attr.visibility);
        const staticFlag = attr.isStatic ? '1' : '0';
        lines.push(`          <attribute xmi:idref="${attr.id}" name="${esc(attr.name)}" scope="${scope}">`);
        lines.push(`            <properties type="${typeStr}" collection="false" static="${staticFlag}" duplicates="0" changeability="changeable"/>`);
        lines.push(`          </attribute>`);
      }
      lines.push(`        </attributes>`);
    }

    if (cls.methods.length > 0) {
      lines.push(`        <operations>`);
      for (const method of cls.methods) {
        const resolvedRet = resolveDataType(method.returnType, diagram.classes, false);
        const returnTypeStr = resolvedRet ? esc(resolvedRet.name) : '';
        const scope = eaScope(method.visibility);
        const staticStr = method.isStatic ? 'true' : 'false';
        const isAbstractStr = cls.kind === 'interface' || cls.isAbstract ? 'true' : 'false';
        lines.push(`          <operation xmi:idref="${method.id}" name="${esc(method.name)}" scope="${scope}">`);
        lines.push(`            <type type="${returnTypeStr}" static="${staticStr}" isAbstract="${isAbstractStr}"/>`);
        if (method.parameters.length > 0) {
          lines.push(`            <parameters>`);
          for (let pIdx = 0; pIdx < method.parameters.length; pIdx++) {
            const param = method.parameters[pIdx];
            const resolvedParam = resolveDataType(param.type, diagram.classes, true);
            const paramTypeStr = resolvedParam ? esc(resolvedParam.name) : '';
            lines.push(`              <parameter xmi:idref="${randomUUID()}" name="${esc(param.name)}" visibility="public">`);
            lines.push(`                <properties pos="${pIdx}" type="${paramTypeStr}"/>`);
            lines.push(`              </parameter>`);
          }
          lines.push(`            </parameters>`);
        }
        lines.push(`          </operation>`);
      }
      lines.push(`        </operations>`);
    }

    lines.push(`      </element>`);
  }
  for (let i = 0; i < diagram.naryAssociations.length; i++) {
    const nary = diagram.naryAssociations[i];
    lines.push(`      <element xmi:idref="${nary.id}" xmi:type="uml:Association" name="${esc(nary.name ?? 'NaryAssociation')}" scope="public">`);
    lines.push(`        <model package="${packageId}" tpos="0" ea_localid="${diagram.classes.length + i + 2}" ea_eleType="element"/>`);
    lines.push(`        <properties isSpecification="false" sType="Association" nType="0" scope="public"/>`);
    lines.push(`        <project author="UMLDesignTool" version="1.0"/>`);
    if (nary.memberEnds.length > 0) {
      lines.push(`        <links>`);
      for (let j = 0; j < nary.memberEnds.length; j++) {
        const end = nary.memberEnds[j];
        lines.push(`          <Association xmi:id="${nary.id}_end${j}" start="${nary.id}" end="${end.classId}"/>`);
      }
      lines.push(`        </links>`);
    }
    lines.push(`      </element>`);
  }
  lines.push(`    </elements>`);

  // Conectores con nombres, roles y etiquetas en estilo Enterprise Architect
  lines.push(`    <connectors>`);
  for (const assoc of diagram.associations) {
    const srcRole = assoc.sourceRole ? ` lt="${esc(assoc.sourceRole)}"` : '';
    const tgtRole = assoc.targetRole ? ` rt="${esc(assoc.targetRole)}"` : '';
    const srcMult = assoc.sourceMultiplicity ? ` lb="${esc(assoc.sourceMultiplicity)}"` : '';
    const tgtMult = assoc.targetMultiplicity ? ` rb="${esc(assoc.targetMultiplicity)}"` : '';
    const assocName = assoc.name ? ` mt="${esc(assoc.name)}"` : '';

    const sourceIsWhole = assoc.aggregationEnd === 'source';
    let eaType = 'Association';
    let subtypeAttr = '';
    let direction = 'Unspecified';
    let srcAgg = 'none';
    let tgtAgg = 'none';

    if (assoc.aggregation === 'composite') {
      eaType = 'Aggregation';
      subtypeAttr = ' subtype="Strong"';
      direction = sourceIsWhole ? 'Source -> Destination' : 'Destination -> Source';
      if (sourceIsWhole) {
        srcAgg = 'none';
        tgtAgg = 'composite';
      } else {
        srcAgg = 'composite';
        tgtAgg = 'none';
      }
    } else if (assoc.aggregation === 'shared') {
      eaType = 'Aggregation';
      direction = sourceIsWhole ? 'Source -> Destination' : 'Destination -> Source';
      if (sourceIsWhole) {
        srcAgg = 'none';
        tgtAgg = 'shared';
      } else {
        srcAgg = 'shared';
        tgtAgg = 'none';
      }
    }

    lines.push(`      <connector xmi:idref="${assoc.id}">`);
    lines.push(`        <source xmi:idref="${assoc.sourceClassId}">`);
    if (assoc.sourceRole) lines.push(`          <role name="${esc(assoc.sourceRole)}"/>`);
    const srcMultAttr = assoc.sourceMultiplicity ? ` multiplicity="${esc(assoc.sourceMultiplicity)}"` : '';
    lines.push(`          <type${srcMultAttr} aggregation="${srcAgg}"/>`);
    lines.push(`        </source>`);
    lines.push(`        <target xmi:idref="${assoc.targetClassId}">`);
    if (assoc.targetRole) lines.push(`          <role name="${esc(assoc.targetRole)}"/>`);
    const tgtMultAttr = assoc.targetMultiplicity ? ` multiplicity="${esc(assoc.targetMultiplicity)}"` : '';
    lines.push(`          <type${tgtMultAttr} aggregation="${tgtAgg}"/>`);
    lines.push(`        </target>`);
    lines.push(`        <properties ea_type="${eaType}"${subtypeAttr} direction="${direction}"${assoc.name ? ` name="${esc(assoc.name)}"` : ''}/>`);
    lines.push(`        <labels${assocName}${srcRole}${tgtRole}${srcMult}${tgtMult}/>`);
    lines.push(`      </connector>`);
  }
  for (const gen of diagram.generalizations) {
    lines.push(`      <connector xmi:idref="${gen.id}">`);
    lines.push(`        <source xmi:idref="${gen.subClassId}"/>`);
    lines.push(`        <target xmi:idref="${gen.superClassId}"/>`);
    lines.push(`        <properties ea_type="Generalization"${gen.name ? ` name="${esc(gen.name)}"` : ''}/>`);
    lines.push(`        <labels${gen.name ? ` mt="${esc(gen.name)}"` : ''}/>`);
    lines.push(`      </connector>`);
  }
  for (const real of diagram.realizations) {
    lines.push(`      <connector xmi:idref="${real.id}">`);
    lines.push(`        <source xmi:idref="${real.clientClassId}"/>`);
    lines.push(`        <target xmi:idref="${real.supplierInterfaceId}"/>`);
    lines.push(`        <properties ea_type="Realization"${real.name ? ` name="${esc(real.name)}"` : ''}/>`);
    lines.push(`        <labels${real.name ? ` mt="${esc(real.name)}"` : ''}/>`);
    lines.push(`      </connector>`);
  }
  for (const dep of diagram.dependencies) {
    lines.push(`      <connector xmi:idref="${dep.id}">`);
    lines.push(`        <source xmi:idref="${dep.clientClassId}"/>`);
    lines.push(`        <target xmi:idref="${dep.supplierClassId}"/>`);
    lines.push(`        <properties ea_type="Dependency"${dep.name ? ` name="${esc(dep.name)}"` : ''}/>`);
    lines.push(`        <labels${dep.name ? ` mt="${esc(dep.name)}"` : ''}/>`);
    lines.push(`      </connector>`);
  }
  for (const nary of diagram.naryAssociations) {
    for (let j = 0; j < nary.memberEnds.length; j++) {
      const end = nary.memberEnds[j];
      const endId = `${nary.id}_end${j}`;
      const roleAttr = end.role ? ` name="${esc(end.role)}"` : '';
      const multAttr = end.multiplicity ? ` multiplicity="${esc(end.multiplicity)}"` : '';
      const roleLabel = end.role ? ` lt="${esc(end.role)}"` : '';
      const multLabel = end.multiplicity ? ` lb="${esc(end.multiplicity)}"` : '';
      lines.push(`      <connector xmi:idref="${endId}">`);
      lines.push(`        <source xmi:idref="${nary.id}">`);
      lines.push(`          <model type="Association"/>`);
      lines.push(`          <role visibility="Public" targetScope="instance"/>`);
      lines.push(`          <type aggregation="none" containment="Unspecified"/>`);
      lines.push(`          <modifiers isOrdered="false" changeable="none" isNavigable="false"/>`);
      lines.push(`          <style value="Union=0;Derived=0;AllowDuplicates=0;Owned=0;Navigable=Unspecified;"/>`);
      lines.push(`        </source>`);
      lines.push(`        <target xmi:idref="${end.classId}">`);
      lines.push(`          <model type="Class"/>`);
      lines.push(`          <role${roleAttr} visibility="Public" targetScope="instance"/>`);
      lines.push(`          <type${multAttr} aggregation="none" containment="Unspecified"/>`);
      lines.push(`          <modifiers isOrdered="false" changeable="none" isNavigable="false"/>`);
      lines.push(`          <style value="Union=0;Derived=0;AllowDuplicates=0;Owned=0;Navigable=Unspecified;"/>`);
      lines.push(`        </target>`);
      lines.push(`        <properties ea_type="Association" direction="Unspecified"/>`);
      lines.push(`        <labels${roleLabel}${multLabel}/>`);
      lines.push(`      </connector>`);
    }
  }
  lines.push(`    </connectors>`);

  if (primitiveTypesMap.size > 0) {
    lines.push(`    <primitivetypes>`);
    lines.push(`      <packagedElement xmi:type="uml:Package" xmi:id="EAPrimitiveTypesPackage" name="EA_PrimitiveTypes_Package" visibility="public">`);
    lines.push(`        <packagedElement xmi:type="uml:Package" xmi:id="EAJavaTypesPackage" name="EA_Java_Types_Package" visibility="public">`);
    for (const prim of primitiveTypesMap.values()) {
      lines.push(`          <packagedElement xmi:type="uml:PrimitiveType" xmi:id="${prim.id}" name="${esc(prim.name)}" visibility="public"/>`);
    }
    lines.push(`        </packagedElement>`);
    lines.push(`      </packagedElement>`);
    lines.push(`    </primitivetypes>`);
  }

  lines.push(`    <diagrams>`);
  lines.push(`      <diagram xmi:id="${diagramId}">`);
  lines.push(`        <model package="${packageId}" localID="1" owner="${packageId}"/>`);
  lines.push(`        <properties name="${esc(diagram.name)}" type="Logical"/>`);
  lines.push(`        <project author="UMLDesignTool" version="1.0"/>`);
  lines.push(`        <elements>`);
  for (let i = 0; i < diagram.classes.length; i++) {
    const cls = diagram.classes[i];
    const left = Math.round(cls.position.x);
    const top = Math.round(cls.position.y);
    const right = left + 140;
    const bottom = top + 90;
    const duid = toDuid(cls.id);
    lines.push(`          <element geometry="Left=${left};Top=${top};Right=${right};Bottom=${bottom};" subject="${cls.id}" seqno="${i + 1}" style="DUID=${duid};"/>`);
  }
  const classPosMap = new Map(diagram.classes.map(c => [c.id, c.position]));
  for (let i = 0; i < diagram.naryAssociations.length; i++) {
    const nary = diagram.naryAssociations[i];
    const memberPositions = nary.memberEnds.map(e => classPosMap.get(e.classId)).filter((p): p is { x: number; y: number } => Boolean(p));
    const cx = memberPositions.length > 0 ? memberPositions.reduce((s, p) => s + p.x, 0) / memberPositions.length : 200;
    const cy = memberPositions.length > 0 ? memberPositions.reduce((s, p) => s + p.y, 0) / memberPositions.length : 200;
    const left = Math.round(cx - 20);
    const top = Math.round(cy - 20);
    const right = left + 40;
    const bottom = top + 40;
    const duid = toDuid(nary.id);
    lines.push(`          <element geometry="Left=${left};Top=${top};Right=${right};Bottom=${bottom};" subject="${nary.id}" seqno="${diagram.classes.length + i + 1}" style="DUID=${duid};"/>`);
  }
  for (const assoc of diagram.associations) {
    const sDuid = toDuid(assoc.sourceClassId);
    const tDuid = toDuid(assoc.targetClassId);
    lines.push(`          <element geometry="EDGE=2;$LLB=;LLT=;LMT=;LMB=;LRT=;LRB=;IRHS=;ILHS=;Path=;" subject="${assoc.id}" style="Mode=3;EOID=${tDuid};SOID=${sDuid};Color=-1;LWidth=0;Hidden=0;"/>`);
  }
  for (const gen of diagram.generalizations) {
    const sDuid = toDuid(gen.subClassId);
    const tDuid = toDuid(gen.superClassId);
    lines.push(`          <element geometry="EDGE=2;$LLB=;LLT=;LMT=;LMB=;LRT=;LRB=;IRHS=;ILHS=;Path=;" subject="${gen.id}" style="Mode=3;EOID=${tDuid};SOID=${sDuid};Color=-1;LWidth=0;Hidden=0;"/>`);
  }
  for (const real of diagram.realizations) {
    const sDuid = toDuid(real.clientClassId);
    const tDuid = toDuid(real.supplierInterfaceId);
    lines.push(`          <element geometry="EDGE=2;$LLB=;LLT=;LMT=;LMB=;LRT=;LRB=;IRHS=;ILHS=;Path=;" subject="${real.id}" style="Mode=3;EOID=${tDuid};SOID=${sDuid};Color=-1;LWidth=0;Hidden=0;"/>`);
  }
  for (const dep of diagram.dependencies) {
    const sDuid = toDuid(dep.clientClassId);
    const tDuid = toDuid(dep.supplierClassId);
    lines.push(`          <element geometry="EDGE=2;$LLB=;LLT=;LMT=;LMB=;LRT=;LRB=;IRHS=;ILHS=;Path=;" subject="${dep.id}" style="Mode=3;EOID=${tDuid};SOID=${sDuid};Color=-1;LWidth=0;Hidden=0;"/>`);
  }
  for (const nary of diagram.naryAssociations) {
    const naryDuid = toDuid(nary.id);
    for (let j = 0; j < nary.memberEnds.length; j++) {
      const end = nary.memberEnds[j];
      const classDuid = toDuid(end.classId);
      const endId = `${nary.id}_end${j}`;
      lines.push(`          <element geometry="SX=0;SY=0;EX=0;EY=0;EDGE=2;$LLB=;LLT=;LMT=;LMB=;LRT=;LRB=;IRHS=;ILHS=;Path=;" subject="${endId}" style="Mode=3;EOID=${classDuid};SOID=${naryDuid};Color=-1;LWidth=0;Hidden=0;"/>`);
    }
  }
  lines.push(`        </elements>`);
  lines.push(`      </diagram>`);
  lines.push(`    </diagrams>`);
  lines.push(`  </xmi:Extension>`);

  // ── Extensión de diseño (posiciones en el lienzo) ─────────────────────────
  // Preserva las posiciones de round-trip para el propio importador de la herramienta.
  lines.push(`  <xmi:Extension extender="UMLDesignTool">`);
  lines.push(`    <layout diagramId="${diagram.id}">`);
  for (const cls of diagram.classes) {
    lines.push(`      <element xmiIdref="${cls.id}" x="${Math.round(cls.position.x)}" y="${Math.round(cls.position.y)}"/>`);
  }
  for (const nary of diagram.naryAssociations) {
    const memberPositions = nary.memberEnds.map(e => classPosMap.get(e.classId)).filter((p): p is { x: number; y: number } => Boolean(p));
    const cx = memberPositions.length > 0 ? memberPositions.reduce((s, p) => s + p.x, 0) / memberPositions.length : 200;
    const cy = memberPositions.length > 0 ? memberPositions.reduce((s, p) => s + p.y, 0) / memberPositions.length : 200;
    lines.push(`      <element xmiIdref="${nary.id}" x="${Math.round(cx)}" y="${Math.round(cy)}"/>`);
  }
  lines.push(`    </layout>`);
  lines.push(`  </xmi:Extension>`);

  lines.push(`</xmi:XMI>`);

  return lines.join('\n');
}
