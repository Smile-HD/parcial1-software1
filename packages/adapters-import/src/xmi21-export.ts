import { randomUUID } from 'crypto';
import type { Diagram, Class, Association, Generalization, Realization, Dependency, NaryAssociation } from '@app/core';

// ── XML escaping ──────────────────────────────────────────────────────────────

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ── Helpers to build UML property attributes ──────────────────────────────────

function visAttr(v: string | undefined): string {
  if (!v || v === '+') return '';
  return ` visibility="${esc(v)}"`;
}

function boolAttr(name: string, val: boolean | undefined): string {
  return val ? ` ${name}="true"` : '';
}

// ── Multiplicity helpers ──────────────────────────────────────────────────────

/**
 * Build lowerValue/upperValue child elements from a UML multiplicity string.
 * Single values like "1" become a single LiteralInteger.
 * Ranges like "0..*" become lowerValue=0, upperValue=-1 (UnlimitedNatural).
 * Returns empty string if no multiplicity.
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
  // Plain integer: both bounds equal
  return `<lowerValue xmi:type="uml:LiteralInteger" xmi:id="${randomUUID()}" value="${esc(mult)}"/>` +
         `<upperValue xmi:type="uml:LiteralInteger" xmi:id="${randomUUID()}" value="${esc(mult)}"/>`;
}

// ── Aggregation mapping ──────────────────────────────────────────────────────

function aggregationAttr(a: Association): string {
  if (a.aggregation === 'none') return '';
  return ` aggregation="${esc(a.aggregation)}"`;
}

// ── XMI 2.1 Export ───────────────────────────────────────────────────────────

/**
 * Export a Diagram IR to a standard UML 2.x XMI 2.1 document that
 * Enterprise Architect can import.  The output uses the real EA 6.5 layout:
 *
 *   <xmi:XMI xmi:version="2.1">
 *     <uml:Model ...>
 *       <packagedElement xmi:type="uml:Class" ...>
 *         <ownedAttribute ...>  (class features)
 *         <ownedOperation ...>  (methods)
 *         <generalization ...>  (child of subclass)
 *       </packagedElement>
 *       <packagedElement xmi:type="uml:Association" ...>
 *         <memberEnd / ownedEnd>  (properties)
 *       </packagedElement>
 *       <packagedElement xmi:type="uml:Generalization" .../>
 *       <packagedElement xmi:type="uml:Realization" .../>
 *       <packagedElement xmi:type="uml:Dependency" .../>
 *     </uml:Model>
 *     <xmi:Extension>
 *       <layout>  (canvas positions, not standard UML but preserved for round-trip)
 *     </xmi:Extension>
 *   </xmi:XMI>
 */
export function exportDiagramToXmi(diagram: Diagram): string {
  const now = new Date().toISOString();
  const lines: string[] = [];

  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push(`<xmi:XMI xmi:version="2.1" xmlns:xmi="http://schema.omg.org/spec/XMI/2.1" xmlns:uml="http://schema.omg.org/spec/UML/2.1" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">`);
  lines.push(`  <uml:Model xmi:type="uml:Model" xmi:id="${diagram.id}" name="${esc(diagram.name)}">`);

  // ── Build id maps for cross-referencing ─────────────────────────────────
  const classIdSet = new Set(diagram.classes.map(c => c.id));
  const ifaceIds = new Set(diagram.classes.filter(c => c.kind === 'interface').map(c => c.id));

  // ── Classes and Interfaces ──────────────────────────────────────────────
  for (const cls of diagram.classes) {
    const xmiType = cls.kind === 'interface' ? 'uml:Interface' : 'uml:Class';
    lines.push(`    <packagedElement xmi:type="${xmiType}" xmi:id="${cls.id}" name="${esc(cls.name)}"${boolAttr('isAbstract', cls.isAbstract)}>`);

    // ownedAttribute (class features — NOT association ends)
    for (const attr of cls.attributes) {
      const attrId = attr.id;
      lines.push(`      <ownedAttribute xmi:type="uml:Property" xmi:id="${attrId}" name="${esc(attr.name)}"${visAttr(attr.visibility)}${boolAttr('isStatic', attr.isStatic)}${boolAttr('isDerived', attr.isDerived)}>`);
      lines.push(`        <type xmi:idref="${esc(attr.type)}"/>`);
      if (attr.multiplicity) {
        lines.push(`        ${multiplicityXml(attr.multiplicity)}`);
      }
      lines.push(`      </ownedAttribute>`);
    }

    // Association-end mirrored attributes (ownedAttribute with association ref)
    // We emit them as part of the association section, not here.

    // ownedOperation (methods)
    for (const method of cls.methods) {
      const methodId = method.id;
      lines.push(`      <ownedOperation xmi:type="uml:Operation" xmi:id="${methodId}" name="${esc(method.name)}"${visAttr(method.visibility)}${boolAttr('isStatic', method.isStatic)}>`);

      // In-parameters
      for (const param of method.parameters) {
        lines.push(`        <ownedParameter xmi:type="uml:Parameter" xmi:id="${randomUUID()}" name="${esc(param.name)}" direction="in" type="${esc(param.type)}"/>`);
      }

      // Return parameter (direction="return")
      if (method.returnType && method.returnType !== 'void') {
        lines.push(`        <ownedParameter xmi:type="uml:Parameter" xmi:id="${randomUUID()}" name="return" direction="return" type="${esc(method.returnType)}"/>`);
      } else if (method.returnType === 'void') {
        lines.push(`        <ownedParameter xmi:type="uml:Parameter" xmi:id="${randomUUID()}" name="return" direction="return" type="${esc(method.returnType)}"/>`);
      }

      lines.push(`      </ownedOperation>`);
    }

    // Generalization as a child of the subclass
    const subGens = diagram.generalizations.filter(g => g.subClassId === cls.id);
    for (const gen of subGens) {
      lines.push(`      <generalization xmi:type="uml:Generalization" xmi:id="${gen.id}" general="${gen.superClassId}"/>`);
    }

    lines.push(`    </packagedElement>`);
  }

  // ── Associations (binary) ───────────────────────────────────────────────
  for (const assoc of diagram.associations) {
    const sourceIsWhole = assoc.aggregationEnd === 'source';
    const diamondEnd = sourceIsWhole ? assoc.sourceClassId : assoc.targetClassId;

    lines.push(`    <packagedElement xmi:type="uml:Association" xmi:id="${assoc.id}" name="${assoc.name ? esc(assoc.name) : ''}">`);

    // memberEnd refs (two ends)
    lines.push(`      <memberEnd xmi:idref="${assoc.id}_src"/>`);
    lines.push(`      <memberEnd xmi:idref="${assoc.id}_tgt"/>`);

    // Source end (ownedEnd)
    const srcAgg = (assoc.aggregation !== 'none' && sourceIsWhole) ? ` aggregation="${esc(assoc.aggregation)}"` : '';
    lines.push(`      <ownedEnd xmi:type="uml:Property" xmi:id="${assoc.id}_src"${srcAgg}${assoc.sourceRole ? ` name="${esc(assoc.sourceRole)}"` : ''}>`);
    lines.push(`        <type xmi:idref="${assoc.sourceClassId}"/>`);
    if (assoc.sourceMultiplicity) {
      lines.push(`        ${multiplicityXml(assoc.sourceMultiplicity)}`);
    }
    lines.push(`      </ownedEnd>`);

    // Target end (ownedEnd)
    const tgtAgg = (assoc.aggregation !== 'none' && !sourceIsWhole) ? ` aggregation="${esc(assoc.aggregation)}"` : '';
    lines.push(`      <ownedEnd xmi:type="uml:Property" xmi:id="${assoc.id}_tgt"${tgtAgg}${assoc.targetRole ? ` name="${esc(assoc.targetRole)}"` : ''}>`);
    lines.push(`        <type xmi:idref="${assoc.targetClassId}"/>`);
    if (assoc.targetMultiplicity) {
      lines.push(`        ${multiplicityXml(assoc.targetMultiplicity)}`);
    }
    lines.push(`      </ownedEnd>`);

    lines.push(`    </packagedElement>`);
  }

  // ── Generalizations (top-level — those not already emitted as children) ──
  // Some generalizations are emitted as children of the subclass above.
  // We also emit them as top-level for completeness (EA allows both layouts).
  // However, to match the importer's child-of-subclass expectation, we keep
  // them ONLY as children (already emitted above). No top-level duplicates.

  // ── Realizations ────────────────────────────────────────────────────────
  for (const real of diagram.realizations) {
    lines.push(`    <packagedElement xmi:type="uml:Realization" xmi:id="${real.id}" client="${real.clientClassId}" supplier="${real.supplierInterfaceId}"/>`);
  }

  // ── Dependencies ────────────────────────────────────────────────────────
  for (const dep of diagram.dependencies) {
    lines.push(`    <packagedElement xmi:type="uml:Dependency" xmi:id="${dep.id}" client="${dep.clientClassId}" supplier="${dep.supplierClassId}"/>`);
  }

  // ── N-ary associations ──────────────────────────────────────────────────
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
      lines.push(`      <ownedEnd xmi:type="uml:Property" xmi:id="${endId}"${end.role ? ` name="${esc(end.role)}"` : ''}>`);
      lines.push(`        <type xmi:idref="${end.classId}"/>`);
      if (end.multiplicity) {
        lines.push(`        ${multiplicityXml(end.multiplicity)}`);
      }
      lines.push(`      </ownedEnd>`);
    }
    lines.push(`    </packagedElement>`);
  }

  lines.push(`  </uml:Model>`);

  // ── Layout extension (canvas positions) ─────────────────────────────────
  // This is NOT standard UML but preserves round-trip positions.  The
  // importer falls back to grid auto-layout when this block is absent.
  lines.push(`  <xmi:Extension extender="UMLDesignTool">`);
  lines.push(`    <layout diagramId="${diagram.id}">`);
  for (const cls of diagram.classes) {
    lines.push(`      <element xmiIdref="${cls.id}" x="${Math.round(cls.position.x)}" y="${Math.round(cls.position.y)}"/>`);
  }
  lines.push(`    </layout>`);
  lines.push(`  </xmi:Extension>`);

  lines.push(`</xmi:XMI>`);

  return lines.join('\n');
}
