/**
 * DiagramCanvas — React Flow canvas rendering exclusively from a Y.Doc.
 *
 * editor:R1 — the Y.Doc IS the canonical IR; React state is a derived
 * projection that triggers re-render when the Y.Doc changes.
 * No mutation bypasses applyDelta (see applyDeltaToYDoc).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { ReactFlow, Background, BackgroundVariant, type Connection, type Edge, type ReactFlowInstance, MarkerType } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type * as Y from 'yjs';

import { MultiplicitySchema, projectYDocToDiagram, type ApplyError, type ApplyResult, type Association, type AssociationDelta, type ClassDelta, type DependencyDelta, type Diagram, type Generalization, type GeneralizationDelta, type MemberDelta, type NaryAssociationDelta, type NaryMemberEnd, type Parameter, type Realization, type RealizationDelta } from '@app/core';

import './canvas.css';
import { ClassNode, type ClassNodeData, type ClassFlowNode, type MemberAdornments } from './ClassNode';
import { NaryDiamondNode, type NaryDiamondFlowNode } from './NaryDiamondNode';
import { applyDeltaToYDoc } from './applyDeltaToYDoc';
import { AssociationEdge } from './AssociationEdge';
import { GeneralizationEdge } from './GeneralizationEdge';
import { RealizationEdge } from './RealizationEdge';
import { DependencyEdge } from './DependencyEdge';
import { NaryEndEdge } from './NaryEndEdge';
import { Palette, PALETTE_DND_MIME, type PaletteEdgeTool, type PaletteNodeKind } from './Palette';
import { QuickLinkerMenu } from './QuickLinkerMenu';
import {
  elementMenuOptions,
  quickLinkerTarget,
  validConnectorsFor,
  type QuickConnectorType,
  type QuickLinkerKind,
} from './quickLinker';
import { t, useT, type TKey } from '../i18n';

const nodeTypes = { class: ClassNode, naryDiamond: NaryDiamondNode };
const edgeTypes = { association: AssociationEdge, generalization: GeneralizationEdge, realization: RealizationEdge, dependency: DependencyEdge, naryEnd: NaryEndEdge };

/**
 * unit 13c — the edge kinds the unified editor understands. n-ary member
 * edges (`naryEnd`) are deliberately excluded: they are edited through the
 * n-ary diamond's own context/pick flow, not the per-edge panel.
 */
type EditorEdgeType = 'association' | 'generalization' | 'realization' | 'dependency';

/**
 * unit 13e.10 — edge-kind display labels come from the i18n dictionary (the
 * old hardcoded EDGE_TYPE_LABELS map → `tool.*` keys; EN values are
 * byte-identical, so every existing aria-label/testid contract survives).
 */
const EDGE_TYPE_KEYS: Record<EditorEdgeType, TKey> = {
  association: 'tool.association',
  generalization: 'tool.generalization',
  realization: 'tool.realization',
  dependency: 'tool.dependency',
};

/** unit 13e.10 — Quick Linker menu labels map to the same `tool.*` keys
 * (quickLinker.ts stays pure — the mapping lives at the render site). */
const CONNECTOR_TOOL_KEYS: Record<QuickConnectorType, TKey> = {
  association: 'tool.association',
  aggregation: 'tool.aggregation',
  composition: 'tool.composition',
  generalization: 'tool.generalization',
  realization: 'tool.realization',
  dependency: 'tool.dependency',
};

const ELEMENT_TOOL_KEYS: Record<PaletteNodeKind, TKey> = {
  class: 'tool.class',
  interface: 'tool.interface',
};

function isEditorEdgeType(type: string | undefined): type is EditorEdgeType {
  return type === 'association' || type === 'generalization' || type === 'realization' || type === 'dependency';
}

export interface DiagramCanvasProps {
  doc: Y.Doc;
}

/**
 * editor:R2 — drag-end: emits a reposition delta; the Y.Doc stays the source of truth.
 */
export function handleNodeDragStop(
  doc: Y.Doc,
  diagramId: string,
  node: { id: string; position: { x: number; y: number } },
): void {
  const delta: ClassDelta = {
    kind: 'class',
    op: 'reposition',
    id: crypto.randomUUID(),
    diagramId,
    timestamp: new Date().toISOString(),
    classId: node.id,
    newPosition: node.position,
  };
  applyDeltaToYDoc(doc, delta);
}

/** editor:R4 - link between two existing classes; multiplicities are per-endpoint editable. */
export interface AssociationLink {
  sourceClassId: string;
  targetClassId: string;
  directed: boolean;
  /**
   * unit 13c — optional aggregation kind preset (palette Aggregation /
   * Composition tools). Omitted = plain association ('none' via the IR
   * default), so every existing caller stays byte-identical.
   */
  aggregation?: 'none' | 'shared' | 'composite';
}

/**
 * editor:R4 - emits an association `create` delta via applyDeltaToYDoc.
 * Guards before emitting: the delta schema throws on invalid input, so no
 * empty class id ever reaches it. Self (recursive) associations — the same
 * class on both ends — are valid UML and allowed by the core engine (the
 * palette drag-to-connect path adds its own distinct-endpoint guard).
 * unit 13b: returns the engine result (null when the local guard rejects)
 * so the drag-to-connect path can surface rejections; existing callers
 * ignore the return value.
 */
export function handleCreateAssociation(
  doc: Y.Doc,
  diagramId: string,
  link: AssociationLink,
): ApplyResult<Diagram> | null {
  if (link.sourceClassId === '' || link.targetClassId === '') {
    return null;
  }
  // unit 13d fix C — Aggregation/Composition presets start with UNSPECIFIED
  // multiplicities (empty ends, per UML convention: a new connector carries
  // no assumed multiplicity). The plain Association tool keeps its documented
  // '1'/'1' default; the paths share this function but branch on the preset.
  const presetAggregation = link.aggregation !== undefined && link.aggregation !== 'none';
  const delta: AssociationDelta = {
    kind: 'association',
    op: 'create',
    id: crypto.randomUUID(),
    diagramId,
    timestamp: new Date().toISOString(),
    associationId: crypto.randomUUID(),
    sourceClassId: link.sourceClassId,
    targetClassId: link.targetClassId,
    ...(presetAggregation
      ? {}
      : { sourceMultiplicity: '1', targetMultiplicity: '1' }),
    directed: link.directed,
    // unit 13c — the palette Aggregation/Composition tools preset the kind;
    // the diamond sits on the source end by default (aggregationEnd='source').
    ...(presetAggregation
      ? { aggregation: link.aggregation, aggregationEnd: 'source' as const }
      : {}),
  };
  return applyDeltaToYDoc(doc, delta);
}

/**
 * editor:R4 - per-endpoint multiplicity edit, guarded against out-of-enum
 * values. The guard lives HERE (before emitting): `DeltaSchema.parse` in
 * core THROWS on invalid multiplicities, so `3..7` must never reach
 * applyDeltaToYDoc or the app crashes. Invalid input is silently rejected
 * and the previous value is retained (no delta is emitted).
 * unit 13d fix C — an EMPTY (or whitespace-only) value CLEARS the end to
 * unspecified via a `null` carrier (the core tri-state: undefined keeps,
 * string sets, null clears). Garbage is still rejected.
 */
export function handleUpdateMultiplicity(
  doc: Y.Doc,
  diagramId: string,
  associationId: string,
  endpoint: 'source' | 'target',
  value: string,
): void {
  const trimmed = value.trim();
  if (trimmed === '') {
    // Clear to unspecified — the editor must allow emptying a multiplicity.
    const clearDelta: AssociationDelta = {
      kind: 'association',
      op: 'updateMultiplicity',
      id: crypto.randomUUID(),
      diagramId,
      timestamp: new Date().toISOString(),
      associationId,
      ...(endpoint === 'source'
        ? { newSourceMultiplicity: null }
        : { newTargetMultiplicity: null }),
    };
    applyDeltaToYDoc(doc, clearDelta);
    return;
  }
  // unit 9 — full UML 2.5.1 multiplicity grammar (*, integers, m..n, m..*);
  // garbage is rejected and the previous value is retained (editor:R4).
  const parsed = MultiplicitySchema.safeParse(trimmed);
  if (!parsed.success) {
    return;
  }
  const multiplicity = parsed.data;
  const delta: AssociationDelta = {
    kind: 'association',
    op: 'updateMultiplicity',
    id: crypto.randomUUID(),
    diagramId,
    timestamp: new Date().toISOString(),
    associationId,
    ...(endpoint === 'source'
      ? { newSourceMultiplicity: multiplicity }
      : { newTargetMultiplicity: multiplicity }),
  };
  applyDeltaToYDoc(doc, delta);
}

/**
 * Unit 10 — update association aggregation kind, name, roles, and aggregationEnd.
 * Invalid aggregation values are rejected (no delta emitted).
 */
export function handleUpdateAssociationMeta(
  doc: Y.Doc,
  diagramId: string,
  associationId: string,
  updates: { aggregation?: 'none' | 'shared' | 'composite'; aggregationEnd?: 'source' | 'target'; name?: string; sourceRole?: string; targetRole?: string },
): void {
  // Validate aggregation if provided
  if (updates.aggregation !== undefined && !['none', 'shared', 'composite'].includes(updates.aggregation)) {
    return;
  }
  // Validate aggregationEnd if provided
  if (updates.aggregationEnd !== undefined && !['source', 'target'].includes(updates.aggregationEnd)) {
    return;
  }
  const delta: AssociationDelta = {
    kind: 'association',
    op: 'updateMultiplicity', // reuse existing op kind for backward compat; fields are optional
    id: crypto.randomUUID(),
    diagramId,
    timestamp: new Date().toISOString(),
    associationId,
    ...(updates.aggregation !== undefined ? { aggregation: updates.aggregation } : {}),
    ...(updates.aggregationEnd !== undefined ? { aggregationEnd: updates.aggregationEnd } : {}),
    ...(updates.name !== undefined ? { name: updates.name || undefined } : {}),
    ...(updates.sourceRole !== undefined ? { sourceRole: updates.sourceRole || undefined } : {}),
    ...(updates.targetRole !== undefined ? { targetRole: updates.targetRole || undefined } : {}),
  };
  applyDeltaToYDoc(doc, delta);
}

/**
 * editor:R4 — delete an association by emitting an association `delete` delta.
 * The op exists in core since Unit 6; this wires it to the UI so associations
 * can be removed without deleting a member class.
 */
export function handleDeleteAssociation(
  doc: Y.Doc,
  diagramId: string,
  associationId: string,
): void {
  const delta: AssociationDelta = {
    kind: 'association',
    op: 'delete',
    id: crypto.randomUUID(),
    diagramId,
    timestamp: new Date().toISOString(),
    associationId,
  };
  applyDeltaToYDoc(doc, delta);
}

/**
 * editor:R Generalization (unit 11.4) — emit a generalization `create` delta
 * (subClass → superClass). Engine invariants (existence, duplicates, cycles)
 * are enforced by applyDelta; a rejected delta leaves the Y.Doc unchanged.
 * unit 13b: returns the engine result so the drag-to-connect path can
 * surface cycle/duplicate rejections; existing callers ignore it.
 */
export function handleCreateGeneralization(
  doc: Y.Doc,
  diagramId: string,
  link: { subClassId: string; superClassId: string },
): ApplyResult<Diagram> | null {
  if (link.subClassId === '' || link.superClassId === '') {
    return null;
  }
  const delta: GeneralizationDelta = {
    kind: 'generalization',
    op: 'create',
    id: crypto.randomUUID(),
    diagramId,
    timestamp: new Date().toISOString(),
    generalizationId: crypto.randomUUID(),
    subClassId: link.subClassId,
    superClassId: link.superClassId,
  };
  return applyDeltaToYDoc(doc, delta);
}

/**
 * editor:R Generalization (unit 11.4) — emit a generalization `delete` delta.
 */
export function handleDeleteGeneralization(
  doc: Y.Doc,
  diagramId: string,
  generalizationId: string,
): void {
  const delta: GeneralizationDelta = {
    kind: 'generalization',
    op: 'delete',
    id: crypto.randomUUID(),
    diagramId,
    timestamp: new Date().toISOString(),
    generalizationId,
  };
  applyDeltaToYDoc(doc, delta);
}

/**
 * editor:R Interfaces (unit 12.2/12.4) — emit a realization `create` delta
 * (client class → supplier interface). Engine invariants (existence,
 * interface-target, duplicates) are enforced by applyDelta; a rejected
 * delta leaves the Y.Doc unchanged.
 * unit 13b: returns the engine result so the drag-to-connect path can
 * surface rejections; existing callers ignore it.
 */
export function handleCreateRealization(
  doc: Y.Doc,
  diagramId: string,
  link: { clientClassId: string; supplierInterfaceId: string },
): ApplyResult<Diagram> | null {
  if (link.clientClassId === '' || link.supplierInterfaceId === '') {
    return null;
  }
  const delta: RealizationDelta = {
    kind: 'realization',
    op: 'create',
    id: crypto.randomUUID(),
    diagramId,
    timestamp: new Date().toISOString(),
    realizationId: crypto.randomUUID(),
    clientClassId: link.clientClassId,
    supplierInterfaceId: link.supplierInterfaceId,
  };
  return applyDeltaToYDoc(doc, delta);
}

/**
 * editor:R Interfaces (unit 12.4) — emit a realization `delete` delta.
 */
export function handleDeleteRealization(
  doc: Y.Doc,
  diagramId: string,
  realizationId: string,
): void {
  const delta: RealizationDelta = {
    kind: 'realization',
    op: 'delete',
    id: crypto.randomUUID(),
    diagramId,
    timestamp: new Date().toISOString(),
    realizationId,
  };
  applyDeltaToYDoc(doc, delta);
}

/**
 * editor:R Interfaces (unit 12.2/12.4 — 12b half) — emit a dependency
 * `create` delta (client class → supplier class or interface). Engine
 * invariants (existence, duplicates) are enforced by applyDelta; a
 * rejected delta leaves the Y.Doc unchanged.
 * unit 13b: returns the engine result so the drag-to-connect path can
 * surface rejections; existing callers ignore it.
 */
export function handleCreateDependency(
  doc: Y.Doc,
  diagramId: string,
  link: { clientClassId: string; supplierClassId: string },
): ApplyResult<Diagram> | null {
  if (link.clientClassId === '' || link.supplierClassId === '') {
    return null;
  }
  const delta: DependencyDelta = {
    kind: 'dependency',
    op: 'create',
    id: crypto.randomUUID(),
    diagramId,
    timestamp: new Date().toISOString(),
    dependencyId: crypto.randomUUID(),
    clientClassId: link.clientClassId,
    supplierClassId: link.supplierClassId,
  };
  return applyDeltaToYDoc(doc, delta);
}

/**
 * editor:R Interfaces (unit 12.4 — 12b half) — emit a dependency `delete` delta.
 */
export function handleDeleteDependency(
  doc: Y.Doc,
  diagramId: string,
  dependencyId: string,
): void {
  const delta: DependencyDelta = {
    kind: 'dependency',
    op: 'delete',
    id: crypto.randomUUID(),
    diagramId,
    timestamp: new Date().toISOString(),
    dependencyId,
  };
  applyDeltaToYDoc(doc, delta);
}

/**
 * unit 13c — update a generalization's editable label via the core `update`
 * name delta. An empty string clears the label (engine maps '' → undefined).
 */
export function handleUpdateGeneralizationLabel(
  doc: Y.Doc,
  diagramId: string,
  generalizationId: string,
  name: string,
): void {
  const delta: GeneralizationDelta = {
    kind: 'generalization',
    op: 'update',
    id: crypto.randomUUID(),
    diagramId,
    timestamp: new Date().toISOString(),
    generalizationId,
    name,
  };
  applyDeltaToYDoc(doc, delta);
}

/** unit 13c — update a realization's editable label (see generalization twin). */
export function handleUpdateRealizationLabel(
  doc: Y.Doc,
  diagramId: string,
  realizationId: string,
  name: string,
): void {
  const delta: RealizationDelta = {
    kind: 'realization',
    op: 'update',
    id: crypto.randomUUID(),
    diagramId,
    timestamp: new Date().toISOString(),
    realizationId,
    name,
  };
  applyDeltaToYDoc(doc, delta);
}

/** unit 13c — update a dependency's editable label (see generalization twin). */
export function handleUpdateDependencyLabel(
  doc: Y.Doc,
  diagramId: string,
  dependencyId: string,
  name: string,
): void {
  const delta: DependencyDelta = {
    kind: 'dependency',
    op: 'update',
    id: crypto.randomUUID(),
    diagramId,
    timestamp: new Date().toISOString(),
    dependencyId,
    name,
  };
  applyDeltaToYDoc(doc, delta);
}

/**
 * editor:R N-ary (unit 13.2) — centroid of the member class positions.
 * The diamond node is positioned here and re-derived on every projection,
 * so it always sits at the center of its members (never user-dragged).
 * An empty member list degenerates to the origin (defensive only: the
 * engine guarantees >=3 ends).
 */
export function computeNaryCentroid(
  positions: readonly { x: number; y: number }[],
): { x: number; y: number } {
  if (positions.length === 0) {
    return { x: 0, y: 0 };
  }
  const sum = positions.reduce((acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y }), { x: 0, y: 0 });
  return { x: sum.x / positions.length, y: sum.y / positions.length };
}

/** One member end as entered in the n-ary editor UI. */
export interface NaryMemberEndInput {
  classId: string;
  multiplicity: string;
  role?: string;
}

/**
 * editor:R N-ary (unit 13.2/13.3) — emit an naryAssociation `create` delta.
 * Guards BEFORE emitting (DeltaSchema.parse throws, so garbage must never
 * reach applyDeltaToYDoc): fewer than three ends are rejected, and every
 * multiplicity must satisfy MultiplicitySchema. Engine invariants (member
 * existence, duplicate ends) are enforced by applyDelta; a rejected delta
 * leaves the Y.Doc unchanged.
 */
export function handleCreateNaryAssociation(
  doc: Y.Doc,
  diagramId: string,
  input: { memberEnds: NaryMemberEndInput[]; name?: string },
): void {
  if (input.memberEnds.length < 3) {
    return;
  }
  const memberEnds: NaryMemberEnd[] = [];
  for (const end of input.memberEnds) {
    if (end.classId === '') {
      return;
    }
    const parsed = MultiplicitySchema.safeParse(end.multiplicity);
    if (!parsed.success) {
      return;
    }
    memberEnds.push({
      classId: end.classId,
      multiplicity: parsed.data,
      ...(end.role !== undefined && end.role !== '' ? { role: end.role } : {}),
    });
  }
  const delta: NaryAssociationDelta = {
    kind: 'naryAssociation',
    op: 'create',
    id: crypto.randomUUID(),
    diagramId,
    timestamp: new Date().toISOString(),
    naryAssociationId: crypto.randomUUID(),
    memberEnds,
    ...(input.name !== undefined && input.name !== '' ? { name: input.name } : {}),
  };
  applyDeltaToYDoc(doc, delta);
}

/**
 * editor:R N-ary (unit 13d fix A) — emit an naryAssociation `update` delta
 * (the diamond editor's commits). Same pre-emit guards as create: fewer than
 * three ends or an invalid multiplicity never reach the throwing schema
 * parse; a rejected input emits NOTHING (previous value retained). `name`
 * accepts an empty string to CLEAR the label (engine maps '' → undefined).
 */
export function handleUpdateNaryAssociation(
  doc: Y.Doc,
  diagramId: string,
  naryAssociationId: string,
  updates: { name?: string; memberEnds?: NaryMemberEndInput[] },
): void {
  if (updates.name === undefined && updates.memberEnds === undefined) {
    return;
  }
  const delta: NaryAssociationDelta = {
    kind: 'naryAssociation',
    op: 'update',
    id: crypto.randomUUID(),
    diagramId,
    timestamp: new Date().toISOString(),
    naryAssociationId,
    ...(updates.name !== undefined ? { name: updates.name } : {}),
  };
  if (updates.memberEnds !== undefined) {
    if (updates.memberEnds.length < 3) {
      return;
    }
    const memberEnds: NaryMemberEnd[] = [];
    for (const end of updates.memberEnds) {
      if (end.classId === '') {
        return;
      }
      const parsed = MultiplicitySchema.safeParse(end.multiplicity);
      if (!parsed.success) {
        return;
      }
      memberEnds.push({
        classId: end.classId,
        multiplicity: parsed.data,
        ...(end.role !== undefined && end.role !== '' ? { role: end.role } : {}),
      });
    }
    delta.memberEnds = memberEnds;
  }
  applyDeltaToYDoc(doc, delta);
}

/**
 * editor:R N-ary (unit 13.3) — emit an naryAssociation `delete` delta
 * (the diamond's context-menu action).
 */
export function handleDeleteNaryAssociation(
  doc: Y.Doc,
  diagramId: string,
  naryAssociationId: string,
): void {
  const delta: NaryAssociationDelta = {
    kind: 'naryAssociation',
    op: 'delete',
    id: crypto.randomUUID(),
    diagramId,
    timestamp: new Date().toISOString(),
    naryAssociationId,
  };
  applyDeltaToYDoc(doc, delta);
}

/**
 * editor:R Interfaces (unit 12.4) — toggle the abstract marker via a class
 * `update` delta carrying isAbstract.
 */
export function handleSetAbstract(
  doc: Y.Doc,
  diagramId: string,
  classId: string,
  isAbstract: boolean,
): void {
  const delta: ClassDelta = {
    kind: 'class',
    op: 'update',
    id: crypto.randomUUID(),
    diagramId,
    timestamp: new Date().toISOString(),
    classId,
    isAbstract,
  };
  applyDeltaToYDoc(doc, delta);
}

/**
 * First free auto-name: Class1, Class2, ... (or Interface1, ... with a
 * custom prefix) skipping any existing name.
 */
function nextFreeClassName(existing: readonly string[], prefix = 'Class'): string {
  let n = 1;
  while (existing.includes(`${prefix}${n}`)) {
    n += 1;
  }
  return `${prefix}${n}`;
}

/**
 * unit 13b (editor:R Class Element CRUD / Interfaces) — palette drop:
 * create a class/interface node at the canvas position where the item was
 * dropped. Emits the SAME class `create` delta the toolbar buttons use
 * (interfaces carry classKind), parameterized by drop position + kind, with
 * the next free auto-name. The toolbar handlers delegate here so there is
 * exactly one creation path.
 * unit 13d — returns the created classId so the Quick Linker's
 * element+connector gesture can chain the connector delta onto the element
 * it just created. Existing callers ignore the return value.
 */
export function handlePaletteDrop(
  doc: Y.Doc,
  diagramId: string,
  input: { kind: PaletteNodeKind; position: { x: number; y: number }; existingNames: readonly string[] },
): string {
  const prefix = input.kind === 'interface' ? 'Interface' : 'Class';
  const name = nextFreeClassName(input.existingNames, prefix);
  const classId = crypto.randomUUID();
  const delta: ClassDelta = {
    kind: 'class',
    op: 'create',
    id: crypto.randomUUID(),
    diagramId,
    timestamp: new Date().toISOString(),
    classId,
    name,
    position: input.position,
    ...(input.kind === 'interface' ? { classKind: 'interface' as const } : {}),
  };
  applyDeltaToYDoc(doc, delta);
  return classId;
}

/** Outcome of a guarded drag-to-connect: ok, or rejected with a user message. */
export interface ConnectGuardResult {
  ok: boolean;
  message?: string;
}

/**
 * Human-readable reason for an engine rejection surfaced in the UI.
 * unit 13e.10 — module-level `t()` at CALL time: these run inside event
 * handlers (not render), and `t` reads the current language on every call.
 */
function describeApplyError(error: ApplyError): string {
  switch (error.kind) {
    case 'GeneralizationCycleError':
      return t('reason.cycle');
    case 'DuplicateGeneralizationError':
      return t('reason.duplicateGeneralization');
    case 'RealizationTargetNotInterfaceError':
      return t('reason.realizationNotInterface');
    case 'DuplicateRealizationError':
      return t('reason.duplicateRealization');
    case 'DuplicateDependencyError':
      return t('reason.duplicateDependency');
    case 'ClassNotFoundError':
      return t('reason.classNotFound');
    default:
      return t('reason.unknown');
  }
}

function engineGuardResult(result: ApplyResult<Diagram> | null, label: string): ConnectGuardResult {
  if (result === null) {
    return { ok: false, message: t('guard.invalidEndpoints', { label }) };
  }
  if (result.ok) {
    return { ok: true };
  }
  return { ok: false, message: t('guard.rejectedReason', { label, reason: describeApplyError(result.error) }) };
}

/**
 * unit 13b (editor:R Associations/Generalization/Realization/Dependency) —
 * the drag-to-connect core: given the ARMED edge tool and a React Flow
 * connection (source node → target node), enforce the UI-level invariants
 * the engine also enforces (so the user sees a clear message instead of a
 * silent failure) and emit the matching delta with the correct field names:
 *  - association:    sourceClassId/targetClassId, distinct existing classes
 *  - aggregation:    association with aggregation='shared' preset (13c)
 *  - composition:    association with aggregation='composite' preset (13c)
 *  - generalization: subClassId=source → superClassId=target (cycles are
 *                    rejected by the engine; the rejection is surfaced)
 *  - realization:    clientClassId=source → supplierInterfaceId=target,
 *                    target MUST be an interface
 *  - dependency:     clientClassId=source → supplierClassId=target (the
 *                    supplier may be any classifier, class or interface)
 * With no tool armed the connection is ignored — no accidental edges.
 */
export function handleConnectWithTool(
  doc: Y.Doc,
  diagramId: string,
  tool: PaletteEdgeTool | null,
  connection: { source: string | null; target: string | null },
  classifiers: readonly { id: string; kind: 'class' | 'interface' }[],
): ConnectGuardResult {
  if (tool === null) {
    return { ok: false };
  }
  const { source, target } = connection;
  if (source === null || target === null) {
    return { ok: false, message: t('guard.bothEndsClasses') };
  }
  const sourceCls = classifiers.find((cls) => cls.id === source);
  const targetCls = classifiers.find((cls) => cls.id === target);
  if (sourceCls === undefined || targetCls === undefined) {
    return { ok: false, message: t('guard.endpointsExist') };
  }

  switch (tool) {
    case 'association': {
      // Self-association is valid UML (e.g., Employee→manages→Employee)
      const result = handleCreateAssociation(doc, diagramId, {
        sourceClassId: source,
        targetClassId: target,
        directed: false,
      });
      return engineGuardResult(result, t('tool.association'));
    }
    // unit 13c — Aggregation/Composition reuse the association path with the
    // diamond kind preset (shared = hollow, composite = filled).
    case 'aggregation':
    case 'composition': {
      // Self-aggregation/composition is valid UML (e.g., TreeNode composed of TreeNode)
      const result = handleCreateAssociation(doc, diagramId, {
        sourceClassId: source,
        targetClassId: target,
        directed: false,
        aggregation: tool === 'aggregation' ? 'shared' : 'composite',
      });
      return engineGuardResult(result, tool === 'aggregation' ? t('tool.aggregation') : t('tool.composition'));
    }
    case 'generalization': {
      if (source === target) {
        return { ok: false, message: t('guard.noSelfInheritance') };
      }
      const result = handleCreateGeneralization(doc, diagramId, {
        subClassId: source,
        superClassId: target,
      });
      return engineGuardResult(result, t('tool.generalization'));
    }
    case 'realization': {
      if (targetCls.kind !== 'interface') {
        return { ok: false, message: t('guard.realizationTarget') };
      }
      const result = handleCreateRealization(doc, diagramId, {
        clientClassId: source,
        supplierInterfaceId: target,
      });
      return engineGuardResult(result, t('tool.realization'));
    }
    case 'dependency': {
      // Self-dependency is valid UML
      const result = handleCreateDependency(doc, diagramId, {
        clientClassId: source,
        supplierClassId: target,
      });
      return engineGuardResult(result, t('tool.dependency'));
    }
  }
}

/**
 * unit 13d — EA-style Quick Linker: the menu opened when the quick-link drag
 * ends. 'connector' = dropped on an existing element (menu lists the valid
 * connectors source→target); 'element' = dropped on empty canvas (menu lists
 * creatable kinds; picking one creates the element AT the drop point and then
 * chains into the connector menu — element+connector in one gesture).
 * `anchor` is the screen point the menu renders at; `dropPosition` is the
 * flow-coordinate point the new element is created at.
 */
type QuickLinkerMenuState =
  | {
      mode: 'connector';
      anchor: { x: number; y: number };
      sourceId: string;
      sourceKind: QuickLinkerKind;
      targetId: string;
      targetKind: QuickLinkerKind;
    }
  | {
      mode: 'element';
      anchor: { x: number; y: number };
      sourceId: string;
      sourceKind: QuickLinkerKind;
      dropPosition: { x: number; y: number };
    };

export function DiagramCanvas({ doc }: DiagramCanvasProps) {
  // unit 13e.10 — reactive accessor: every JSX string below re-renders live
  // when the language toggle flips (module-level `t` serves the handlers).
  const { t: tr } = useT();
  // Derive state from the Y.Doc — the Y.Doc is the source of truth.
  const [diagram, setDiagram] = useState<Diagram>(() => projectYDocToDiagram(doc));

  // unit 13e.11 — the canvas owns the toolbox collapse (the toggle button
  // only renders when onToggleCollapsed is passed).
  const [paletteCollapsed, setPaletteCollapsed] = useState(false);
  // unit 13c — ONE editor for every edge kind: the selected edge's id + type.
  const [selectedEdge, setSelectedEdge] = useState<{ id: string; type: EditorEdgeType } | null>(null);
  // unit 13d fix A — the n-ary diamond's own editor: the selected n-ary id.
  // Resolved from the live projection, so deleting the n-ary closes the panel.
  const [selectedNaryId, setSelectedNaryId] = useState<string | null>(null);
  // Unit 11.4 — the class whose generalization list is shown in the panel.
  const [selectedClassId, setSelectedClassId] = useState<string | null>(null);
  // Unit 13.3 — n-ary association mode: pick >=3 classes, per-end multiplicity.
  const [naryMode, setNaryMode] = useState(false);
  const [narySelection, setNarySelection] = useState<string[]>([]);
  const [naryEnds, setNaryEnds] = useState<Record<string, string>>({});
  const [naryName, setNaryName] = useState('');
  // Unit 13b — armed edge tool from the palette; null means connections are
  // disabled entirely (no accidental edges). edgeMessage surfaces guard/engine
  // rejections from the drag-to-connect path.
  const [edgeTool, setEdgeTool] = useState<PaletteEdgeTool | null>(null);
  const [edgeMessage, setEdgeMessage] = useState<string | null>(null);
  // React Flow instance (via onInit) — gives screenToFlowPosition for drops.
  const rfRef = useRef<ReactFlowInstance | null>(null);
  // unit 13d — Quick Linker: live drag endpoints (screen coords, for the
  // rubber band) and the menu opened when the drag ends.
  const [quickLinkDrag, setQuickLinkDrag] = useState<{
    start: { x: number; y: number };
    cursor: { x: number; y: number };
  } | null>(null);
  const [quickLinkMenu, setQuickLinkMenu] = useState<QuickLinkerMenuState | null>(null);

  useEffect(() => {
    const sync = (): void => {
      setDiagram(projectYDocToDiagram(doc));
    };
    doc.on('update', sync);
    return () => {
      doc.off('update', sync);
    };
  }, [doc]);

  // Unit 13b — Escape cancels the armed edge tool (and its last message).
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setEdgeTool(null);
        setEdgeMessage(null);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  /**
   * unit 13e.7 — the old toolbar's handleAddClass/handleAddInterface are GONE:
   * the palette drag (onDrop → handlePaletteDrop) and the Quick Linker are
   * the only creation paths. The exported pure handlers stay (tests import
   * them directly).
   */

  /** unit 13b — allow palette drops over the canvas. */
  const onDragOver = useCallback((event: DragEvent): void => {
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'copy';
    }
  }, []);

  /**
   * unit 13b — palette drop: read the dragged node kind from the
   * dataTransfer, convert the screen point to flow coordinates, and emit
   * the class/interface create delta at that position.
   */
  const onDrop = useCallback(
    (event: DragEvent): void => {
      event.preventDefault();
      if (event.dataTransfer === undefined || event.dataTransfer === null) {
        return;
      }
      const kind = event.dataTransfer.getData(PALETTE_DND_MIME);
      if (kind !== 'class' && kind !== 'interface') {
        return;
      }
      const screenPos = { x: event.clientX, y: event.clientY };
      // screenToFlowPosition needs a measured viewport; before React Flow has
      // laid out (or in zero-size test containers) it can return NaN — fall
      // back to the raw screen point so a drop never emits an invalid delta.
      let position = screenPos;
      if (rfRef.current !== null) {
        const flow = rfRef.current.screenToFlowPosition(screenPos);
        if (Number.isFinite(flow.x) && Number.isFinite(flow.y)) {
          position = flow;
        }
      }
      handlePaletteDrop(doc, diagram.id, {
        kind,
        position,
        existingNames: diagram.classes.map((cls) => cls.name),
      });
    },
    [doc, diagram],
  );

  /**
   * unit 13b — React Flow connection completed while an edge tool is armed:
   * delegate to the guarded handler and surface any rejection message. On
   * success the tool auto-disarms (single-use); on rejection it stays armed
   * so the user can retry. Escape or clicking the palette item again also
   * disarms it.
   */
  const onConnect = useCallback(
    (connection: Connection): void => {
      const result = handleConnectWithTool(
        doc,
        diagram.id,
        edgeTool,
        { source: connection.source ?? null, target: connection.target ?? null },
        diagram.classes.map((cls) => ({ id: cls.id, kind: cls.kind ?? ('class' as const) })),
      );
      setEdgeMessage(result.ok ? null : (result.message ?? null));
      if (result.ok) {
        setEdgeTool(null);
      }
    },
    [doc, diagram, edgeTool],
  );

  /**
   * unit 13d — EA-style Quick Linker, drop resolution. Given the pointer-up
   * screen point: convert to flow coordinates (same finite-guard as the
   * palette drop), hit-test the class nodes (measured size when React Flow
   * has one — jsdom never measures, so the default box applies), then open
   * the connector menu over an element or the element menu over empty
   * canvas. Dropping back onto the source itself opens the connector menu
   * with self-valid connectors (association/aggregation/composition/dependency;
   * generalization excluded because self-inheritance is a cycle).
   */
  const finishQuickLink = (sourceId: string, cursor: { x: number; y: number }): void => {
    // The Y.Doc is the source of truth: resolve everything from a FRESH
    // projection so a collab edit during the drag can never go stale.
    const live = projectYDocToDiagram(doc);
    let dropPoint = cursor;
    if (rfRef.current !== null) {
      const flow = rfRef.current.screenToFlowPosition(cursor);
      if (Number.isFinite(flow.x) && Number.isFinite(flow.y)) {
        dropPoint = flow;
      }
    }
    const measuredById = new Map((rfRef.current?.getNodes() ?? []).map((n) => [n.id, n.measured]));
    const hitNodes = live.classes.map((cls) => ({
      id: cls.id,
      position: cls.position,
      width: measuredById.get(cls.id)?.width,
      height: measuredById.get(cls.id)?.height,
    }));
    const sourceKind = (live.classes.find((cls) => cls.id === sourceId)?.kind ?? 'class') as QuickLinkerKind;
    const targetId = quickLinkerTarget(dropPoint, hitNodes);
    if (targetId === null) {
      setQuickLinkMenu({ mode: 'element', anchor: cursor, sourceId, sourceKind, dropPosition: dropPoint });
      return;
    }
    if (targetId === sourceId) {
      // Self-link: open connector menu with self-valid connectors (excludes generalization)
      const targetKind = sourceKind;
      setQuickLinkMenu({ mode: 'connector', anchor: cursor, sourceId, sourceKind, targetId, targetKind });
      return;
    }
    const targetKind = (live.classes.find((cls) => cls.id === targetId)?.kind ?? 'class') as QuickLinkerKind;
    setQuickLinkMenu({ mode: 'connector', anchor: cursor, sourceId, sourceKind, targetId, targetKind });
  };

  /**
   * unit 13d — pointer-down on the selected node's corner arrow starts the
   * quick-link drag: a thin rubber band follows the cursor (window-level
   * listeners, removed on pointer-up) and the drop is resolved by
   * `finishQuickLink`. This is the EA fast path; the 13c arm-tool +
   * body-drag path stays fully intact.
   */
  const startQuickLink = (sourceId: string, clientX: number, clientY: number): void => {
    const start = { x: clientX, y: clientY };
    setQuickLinkDrag({ start, cursor: start });
    setQuickLinkMenu(null);
    const onMove = (event: MouseEvent): void => {
      setQuickLinkDrag((prev) =>
        prev === null ? prev : { ...prev, cursor: { x: event.clientX, y: event.clientY } },
      );
    };
    const onUp = (event: MouseEvent): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      setQuickLinkDrag(null);
      finishQuickLink(sourceId, { x: event.clientX, y: event.clientY });
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  /**
   * unit 13d — choosing a connector from the Quick Linker menu: delegate to
   * the SAME guarded dispatcher the drag-to-connect path uses
   * (`handleConnectWithTool`), so every UI/engine guard (distinct endpoints,
   * realization-interface, cycles, duplicates) applies verbatim and
   * rejections surface through the existing message channel.
   */
  const pickQuickConnector = (tool: QuickConnectorType): void => {
    if (quickLinkMenu === null || quickLinkMenu.mode !== 'connector') {
      return;
    }
    const live = projectYDocToDiagram(doc);
    const result = handleConnectWithTool(
      doc,
      live.id,
      tool,
      { source: quickLinkMenu.sourceId, target: quickLinkMenu.targetId },
      live.classes.map((cls) => ({ id: cls.id, kind: cls.kind ?? ('class' as const) })),
    );
    setEdgeMessage(result.ok ? null : (result.message ?? null));
    setQuickLinkMenu(null);
  };

  /**
   * unit 13d — choosing Class/Interface from the element menu: create the
   * element at the drop point (shared `handlePaletteDrop` creation path),
   * then chain straight into the connector menu for source→new element —
   * element + connector in one gesture, exactly like EA.
   */
  const pickQuickElement = (kind: string): void => {
    if (quickLinkMenu === null || quickLinkMenu.mode !== 'element') {
      return;
    }
    const nodeKind: PaletteNodeKind = kind === 'interface' ? 'interface' : 'class';
    const live = projectYDocToDiagram(doc);
    const newId = handlePaletteDrop(doc, live.id, {
      kind: nodeKind,
      position: quickLinkMenu.dropPosition,
      existingNames: live.classes.map((cls) => cls.name),
    });
    setQuickLinkMenu({
      mode: 'connector',
      anchor: quickLinkMenu.anchor,
      sourceId: quickLinkMenu.sourceId,
      sourceKind: quickLinkMenu.sourceKind,
      targetId: newId,
      targetKind: nodeKind,
    });
  };

  const handleRename = (classId: string, newName: string): void => {
    const delta: ClassDelta = {
      kind: 'class',
      op: 'rename',
      id: crypto.randomUUID(),
      diagramId: diagram.id,
      timestamp: new Date().toISOString(),
      classId,
      newName,
    };
    applyDeltaToYDoc(doc, delta);
  };

  const handleDeleteClass = (classId: string): void => {
    const delta: ClassDelta = {
      kind: 'class',
      op: 'delete',
      id: crypto.randomUUID(),
      diagramId: diagram.id,
      timestamp: new Date().toISOString(),
      classId,
    };
    applyDeltaToYDoc(doc, delta);
  };

  /**
   * unit 13e.7 — the old click-to-link mode is GONE (the palette edge tools +
   * Quick Linker replaced it). A node click now only drives the n-ary pick
   * mode and the exclusive editor selection.
   */
  const handleNodeClick = (node: { id: string; type?: string }): void => {
    // Unit 13.3 — n-ary mode: clicking classes accumulates the member
    // selection (click again to drop it). The diamond itself is not a
    // selectable member; only class nodes participate.
    if (naryMode) {
      if (node.type !== 'class') return;
      setNarySelection((prev) =>
        prev.includes(node.id) ? prev.filter((id) => id !== node.id) : [...prev, node.id],
      );
      return;
    }
    // unit 13d fix A — clicking the n-ary diamond selects it and opens its
    // editor (name + per-end multiplicities + delete), like any other
    // element. The edge editor is exclusive: only one editor at a time.
    if (node.type === 'naryDiamond') {
      setSelectedNaryId(node.id);
      setSelectedEdge(null);
      return;
    }
    // A class click closes the n-ary editor (selection is exclusive).
    setSelectedNaryId(null);
  };

  /** Unit 13.3 — commit the n-ary association from the editor panel. */
  const handleCreateNaryFromPanel = (): void => {
    const memberEnds: NaryMemberEndInput[] = narySelection
      .filter((classId) => diagram.classes.some((cls) => cls.id === classId))
      .map((classId) => ({
        classId,
        multiplicity: naryEnds[classId] ?? '1',
      }));
    handleCreateNaryAssociation(doc, diagram.id, {
      memberEnds,
      ...(naryName.trim() !== '' ? { name: naryName.trim() } : {}),
    });
    setNaryMode(false);
    setNarySelection([]);
    setNaryEnds({});
    setNaryName('');
  };

  const handleAddAttribute = (classId: string, name: string, type: string, adornments?: MemberAdornments): void => {
    const delta: MemberDelta = {
      kind: 'member',
      op: 'addAttribute',
      id: crypto.randomUUID(),
      diagramId: diagram.id,
      timestamp: new Date().toISOString(),
      classId,
      memberId: crypto.randomUUID(),
      name,
      type,
      ...adornments,
    };
    applyDeltaToYDoc(doc, delta);
  };

  /** editor:R3 — in-place attribute edit emitted as an `editAttribute` delta. */
  const handleEditAttribute = (classId: string, memberId: string, name: string, type: string, adornments?: MemberAdornments): void => {
    const delta: MemberDelta = {
      kind: 'member',
      op: 'editAttribute',
      id: crypto.randomUUID(),
      diagramId: diagram.id,
      timestamp: new Date().toISOString(),
      classId,
      memberId,
      name,
      type,
      ...adornments,
    };
    applyDeltaToYDoc(doc, delta);
  };

  const handleRemoveAttribute = (classId: string, memberId: string): void => {
    const delta: MemberDelta = {
      kind: 'member',
      op: 'deleteAttribute',
      id: crypto.randomUUID(),
      diagramId: diagram.id,
      timestamp: new Date().toISOString(),
      classId,
      memberId,
    };
    applyDeltaToYDoc(doc, delta);
  };

  const handleAddMethod = (
    classId: string,
    name: string,
    returnType: string,
    parameters: Parameter[],
    adornments?: MemberAdornments,
  ): void => {
    const delta: MemberDelta = {
      kind: 'member',
      op: 'addMethod',
      id: crypto.randomUUID(),
      diagramId: diagram.id,
      timestamp: new Date().toISOString(),
      classId,
      memberId: crypto.randomUUID(),
      name,
      returnType,
      parameters,
      ...adornments,
    };
    applyDeltaToYDoc(doc, delta);
  };

  /** editor:R3 — in-place method edit emitted as an `editMethod` delta. */
  const handleEditMethod = (
    classId: string,
    memberId: string,
    name: string,
    returnType: string,
    parameters: Parameter[],
    adornments?: MemberAdornments,
  ): void => {
    const delta: MemberDelta = {
      kind: 'member',
      op: 'editMethod',
      id: crypto.randomUUID(),
      diagramId: diagram.id,
      timestamp: new Date().toISOString(),
      classId,
      memberId,
      name,
      returnType,
      parameters,
      ...adornments,
    };
    applyDeltaToYDoc(doc, delta);
  };

  const handleRemoveMethod = (classId: string, memberId: string): void => {
    const delta: MemberDelta = {
      kind: 'member',
      op: 'deleteMethod',
      id: crypto.randomUUID(),
      diagramId: diagram.id,
      timestamp: new Date().toISOString(),
      classId,
      memberId,
    };
    applyDeltaToYDoc(doc, delta);
  };

  const nodes = useMemo<(ClassFlowNode | NaryDiamondFlowNode)[]>(
    () => [
      ...diagram.classes.map((cls) => ({
        id: cls.id,
        type: 'class' as const,
        position: cls.position,
        data: {
          name: cls.name,
          attributes: cls.attributes,
          methods: cls.methods,
          kind: cls.kind ?? 'class',
          isAbstract: cls.isAbstract ?? false,
          otherClasses: diagram.classes
            .filter((other) => other.id !== cls.id)
            .map((other) => ({ id: other.id, name: other.name })),
          otherInterfaces: diagram.classes
            .filter((other) => other.id !== cls.id && (other.kind ?? 'class') === 'interface')
            .map((other) => ({ id: other.id, name: other.name })),
          onRename: (newName: string) => handleRename(cls.id, newName),
          onDelete: () => handleDeleteClass(cls.id),
          onAddAttribute: (name: string, type: string, adornments?: MemberAdornments) =>
            handleAddAttribute(cls.id, name, type, adornments),
          onEditAttribute: (memberId: string, name: string, type: string, adornments?: MemberAdornments) =>
            handleEditAttribute(cls.id, memberId, name, type, adornments),
          onRemoveAttribute: (memberId: string) => handleRemoveAttribute(cls.id, memberId),
          onAddMethod: (name: string, returnType: string, parameters: Parameter[], adornments?: MemberAdornments) =>
            handleAddMethod(cls.id, name, returnType, parameters, adornments),
          onEditMethod: (memberId: string, name: string, returnType: string, parameters: Parameter[], adornments?: MemberAdornments) =>
            handleEditMethod(cls.id, memberId, name, returnType, parameters, adornments),
          onRemoveMethod: (memberId: string) => handleRemoveMethod(cls.id, memberId),
          onMakeSubclass: (superClassId: string) =>
            handleCreateGeneralization(doc, diagram.id, { subClassId: cls.id, superClassId }),
          onToggleAbstract: (isAbstract: boolean) => handleSetAbstract(doc, diagram.id, cls.id, isAbstract),
          onRealize: (supplierInterfaceId: string) =>
            handleCreateRealization(doc, diagram.id, { clientClassId: cls.id, supplierInterfaceId }),
          onDependOn: (supplierClassId: string) =>
            handleCreateDependency(doc, diagram.id, { clientClassId: cls.id, supplierClassId }),
          onSelect: () => setSelectedClassId(cls.id),
          // unit 13c — while an edge tool is armed the node body itself
          // becomes a valid connection start (full-node overlay handle).
          connectArmed: edgeTool !== null,
          // unit 13d — the Quick Linker arrow renders only on the selected
          // node; pointer-down on it starts the quick-link drag.
          selected: selectedClassId === cls.id,
          onQuickLinkStart: (clientX: number, clientY: number) => startQuickLink(cls.id, clientX, clientY),
        } satisfies ClassNodeData,
      })),
      // Unit 13.2 — one diamond node per n-ary association, positioned at the
      // centroid of its member classes and re-derived on every projection
      // (draggable: false — the centroid IS its position).
      ...(diagram.naryAssociations ?? [])
        .map((nary) => {
          const memberPositions = nary.memberEnds
            .map((end) => diagram.classes.find((cls) => cls.id === end.classId)?.position)
            .filter((pos): pos is { x: number; y: number } => pos !== undefined);
          if (memberPositions.length === 0) return null;
          return {
            id: nary.id,
            type: 'naryDiamond' as const,
            position: computeNaryCentroid(memberPositions),
            draggable: false,
            data: {
              nary,
              onDelete: () => handleDeleteNaryAssociation(doc, diagram.id, nary.id),
            },
          } satisfies NaryDiamondFlowNode;
        })
        .filter((node): node is NaryDiamondFlowNode => node !== null),
    ],
    // unit 13c — edgeTool joins the deps: arming/disarming toggles the
    // node-wide connect overlays. unit 13d — selectedClassId toggles the
    // Quick Linker corner arrow.
    [diagram, edgeTool, selectedClassId],
  );

  const edges = useMemo<Edge[]>(
    () => [
      ...diagram.associations.map((assoc) => ({
        id: assoc.id,
        source: assoc.sourceClassId,
        target: assoc.targetClassId,
        type: 'association' as const,
        data: { association: assoc },
      })),
      // Unit 11.3 — generalization edges: source = subClass, target = superClass
      // so the hollow triangle marker renders on the superclass end.
      ...diagram.generalizations.map((gen) => ({
        id: gen.id,
        source: gen.subClassId,
        target: gen.superClassId,
        type: 'generalization' as const,
        data: { generalization: gen },
      })),
      // Unit 12.3 — realization edges: source = client class, target = supplier
      // interface, so the dashed line + hollow triangle renders on the interface end.
      ...(diagram.realizations ?? []).map((real) => ({
        id: real.id,
        source: real.clientClassId,
        target: real.supplierInterfaceId,
        type: 'realization' as const,
        data: { realization: real },
      })),
      // Unit 12.3 (12b) — dependency edges: source = client class, target =
      // supplier, so the dashed line + open arrow renders on the supplier end.
      ...(diagram.dependencies ?? []).map((dep) => ({
        id: dep.id,
        source: dep.clientClassId,
        target: dep.supplierClassId,
        type: 'dependency' as const,
        data: { dependency: dep },
      })),
      // Unit 13.2 — one plain edge per n-ary member end: diamond → class,
      // labeled with that end's multiplicity (and role when present).
      ...(diagram.naryAssociations ?? []).flatMap((nary) =>
        nary.memberEnds.map((end) => ({
          id: `${nary.id}:${end.classId}`,
          source: nary.id,
          target: end.classId,
          type: 'naryEnd' as const,
          data: { end, naryAssociationId: nary.id },
        })),
      ),
    ],
    [diagram],
  );

  // unit 13c — the selected edge resolved from the live projection. When the
  // edge disappears (deleted from anywhere), this becomes null and the editor
  // closes itself — no stale panel.
  const selectedEdgeData = useMemo(
    () => {
      if (selectedEdge === null) {
        return null;
      }
      switch (selectedEdge.type) {
        case 'association': {
          const assoc = diagram.associations.find((a) => a.id === selectedEdge.id);
          return assoc ? { type: 'association' as const, edge: assoc } : null;
        }
        case 'generalization': {
          const gen = diagram.generalizations.find((g) => g.id === selectedEdge.id);
          return gen ? { type: 'generalization' as const, edge: gen } : null;
        }
        case 'realization': {
          const real = (diagram.realizations ?? []).find((r) => r.id === selectedEdge.id);
          return real ? { type: 'realization' as const, edge: real } : null;
        }
        case 'dependency': {
          const dep = (diagram.dependencies ?? []).find((d) => d.id === selectedEdge.id);
          return dep ? { type: 'dependency' as const, edge: dep } : null;
        }
      }
    },
    [diagram, selectedEdge],
  );

  // unit 13d fix A — the selected n-ary resolved from the live projection.
  // When the association disappears (deleted from anywhere), this becomes
  // null and the diamond editor closes itself — no stale panel.
  const selectedNary = useMemo(
    () => (diagram.naryAssociations ?? []).find((n) => n.id === selectedNaryId) ?? null,
    [diagram, selectedNaryId],
  );

  /**
   * unit 13d fix A — commit the diamond editor's Name field (empty clears,
   * mirroring the edge label semantics).
   */
  const commitNaryName = (value: string): void => {
    if (selectedNary === null) {
      return;
    }
    handleUpdateNaryAssociation(doc, diagram.id, selectedNary.id, { name: value.trim() });
  };

  /**
   * unit 13d fix A — commit one member end's multiplicity: rebuild the full
   * memberEnds array (replace semantics of the core update delta) with only
   * that end changed; roles and the other ends survive. Invalid input is
   * guarded inside handleUpdateNaryAssociation (no delta emitted).
   */
  const commitNaryEndMultiplicity = (classId: string, value: string): void => {
    if (selectedNary === null) {
      return;
    }
    const memberEnds: NaryMemberEndInput[] = selectedNary.memberEnds.map((end) => ({
      classId: end.classId,
      multiplicity: end.classId === classId ? value.trim() : end.multiplicity,
      ...(end.role !== undefined ? { role: end.role } : {}),
    }));
    handleUpdateNaryAssociation(doc, diagram.id, selectedNary.id, { memberEnds });
  };

  // Unit 11.4 — generalization list for the selected class (both roles).
  const selectedClass = useMemo(
    () => diagram.classes.find((cls) => cls.id === selectedClassId) ?? null,
    [diagram, selectedClassId],
  );
  const classNameById = (id: string): string =>
    diagram.classes.find((cls) => cls.id === id)?.name ?? '?';
  const selectedClassGeneralizations = useMemo(
    () =>
      selectedClass === null
        ? []
        : diagram.generalizations.filter(
            (gen) => gen.subClassId === selectedClass.id || gen.superClassId === selectedClass.id,
          ),
    [diagram, selectedClass],
  );

  // Unit 12.4 — realization list for the selected class (both roles).
  const selectedClassRealizations = useMemo(
    () =>
      selectedClass === null
        ? []
        : (diagram.realizations ?? []).filter(
            (real) => real.clientClassId === selectedClass.id || real.supplierInterfaceId === selectedClass.id,
          ),
    [diagram, selectedClass],
  );

  // Unit 12.4 (12b) — dependency list for the selected class (both roles).
  const selectedClassDependencies = useMemo(
    () =>
      selectedClass === null
        ? []
        : (diagram.dependencies ?? []).filter(
            (dep) => dep.clientClassId === selectedClass.id || dep.supplierClassId === selectedClass.id,
          ),
    [diagram, selectedClass],
  );

  /**
   * unit 13b/13e.7 — the palette n-ary item toggles the pick mode (the old
   * toolbar twin is gone). Entering it disarms any armed edge tool (the
   * modes are exclusive).
   */
  const toggleNaryMode = (): void => {
    setNaryMode((prev) => !prev);
    setNarySelection([]);
    setNaryEnds({});
    setNaryName('');
    setEdgeTool(null);
    setEdgeMessage(null);
  };

  /** unit 13b — arm/disarm an edge tool; arming exits n-ary pick mode. */
  const changeEdgeTool = (tool: PaletteEdgeTool | null): void => {
    setEdgeTool(tool);
    setEdgeMessage(null);
    if (tool !== null) {
      setNaryMode(false);
      setNarySelection([]);
      setNaryEnds({});
      setNaryName('');
    }
  };

  /**
   * unit 13c — commit the unified editor's Label field for whichever edge
   * kind is selected. Associations keep the meta-update path (empty clears);
   * the three label kinds emit the core `update` name delta (empty clears).
   */
  const commitEdgeLabel = (value: string): void => {
    if (selectedEdgeData === null) {
      return;
    }
    const trimmed = value.trim();
    switch (selectedEdgeData.type) {
      case 'association':
        handleUpdateAssociationMeta(doc, diagram.id, selectedEdgeData.edge.id, { name: trimmed || undefined });
        break;
      case 'generalization':
        handleUpdateGeneralizationLabel(doc, diagram.id, selectedEdgeData.edge.id, trimmed);
        break;
      case 'realization':
        handleUpdateRealizationLabel(doc, diagram.id, selectedEdgeData.edge.id, trimmed);
        break;
      case 'dependency':
        handleUpdateDependencyLabel(doc, diagram.id, selectedEdgeData.edge.id, trimmed);
        break;
    }
  };

  /** unit 13c — delete the selected edge via its kind's delete delta and close. */
  const deleteSelectedEdge = (): void => {
    if (selectedEdgeData === null) {
      return;
    }
    switch (selectedEdgeData.type) {
      case 'association':
        handleDeleteAssociation(doc, diagram.id, selectedEdgeData.edge.id);
        break;
      case 'generalization':
        handleDeleteGeneralization(doc, diagram.id, selectedEdgeData.edge.id);
        break;
      case 'realization':
        handleDeleteRealization(doc, diagram.id, selectedEdgeData.edge.id);
        break;
      case 'dependency':
        handleDeleteDependency(doc, diagram.id, selectedEdgeData.edge.id);
        break;
    }
    setSelectedEdge(null);
  };

  return (
    <div className="diagram-canvas" style={{ width: '100%', height: '100%' }}>
      {/* unit 13b — left creation rail: drag nodes, arm edge tools, n-ary.
          unit 13e.11 — the canvas owns the collapse state (header toggle). */}
      <Palette
        activeEdgeTool={edgeTool}
        naryMode={naryMode}
        onEdgeToolChange={changeEdgeTool}
        onNaryModeToggle={toggleNaryMode}
        collapsed={paletteCollapsed}
        onToggleCollapsed={() => setPaletteCollapsed((prev) => !prev)}
      />
      {/* unit 13e.7 — the legacy `.diagram-canvas__toolbar` (Add class /
          Add interface / Link classes / N-ary association / Directed) is
          REMOVED: the palette items + drag-to-connect + Quick Linker fully
          replace it (user request: "quitar los botones antiguos"). */}
      {/* unit 13b — affordances for the armed edge tool + guard feedback. */}
      {edgeTool !== null && (
        <div className="diagram-canvas__hint" data-testid="edge-tool-hint" role="status">
          {tr('canvas.edgeToolHint', { tool: tr(CONNECTOR_TOOL_KEYS[edgeTool]) })}
        </div>
      )}
      {edgeMessage !== null && (
        <div className="diagram-canvas__palette-message" role="alert" data-testid="palette-validation">
          {edgeMessage}
        </div>
      )}
      {naryMode && narySelection.length > 0 && (
        <div className="diagram-canvas__nary" data-testid="nary-panel">
          <span className="diagram-canvas__nary-title">
            {tr('nary.panelTitle', { n: narySelection.length })}
          </span>
          {narySelection.map((classId) => {
            const cls = diagram.classes.find((candidate) => candidate.id === classId);
            if (cls === undefined) return null;
            return (
              <label key={classId} className="diagram-canvas__nary-end">
                {cls.name}
                <input
                  aria-label={tr('nary.multiplicityFor', { name: cls.name })}
                  value={naryEnds[classId] ?? '1'}
                  onChange={(event) =>
                    setNaryEnds((prev) => ({ ...prev, [classId]: event.target.value }))
                  }
                />
              </label>
            );
          })}
          <label>
            {tr('nary.name')}
            <input
              aria-label={tr('nary.nameAria')}
              placeholder={tr('nary.optional')}
              value={naryName}
              onChange={(event) => setNaryName(event.target.value)}
            />
          </label>
          <button
            type="button"
            className="diagram-canvas__create-nary"
            aria-label={tr('nary.createAria')}
            disabled={narySelection.length < 3}
            onClick={handleCreateNaryFromPanel}
          >
            {tr('nary.create')}
          </button>
        </div>
      )}
      {/* unit 13c — ONE unified edge editor for every edge kind: label +
          delete for all, multiplicities/roles for associations only. The
          aggregation kind is chosen at creation time via the palette
          (Aggregation/Composition tools), so no dropdowns live here. */}
      {selectedEdgeData && (
        <div className="diagram-canvas__edge-editor" data-testid="edge-editor" key={selectedEdgeData.edge.id}>
          <span className="diagram-canvas__edge-editor-title">
            {tr(EDGE_TYPE_KEYS[selectedEdgeData.type])}
          </span>
          <label>
            {selectedEdgeData.type === 'association' ? tr('editor.associationName') : tr('editor.label')}
            <input
              aria-label={
                selectedEdgeData.type === 'association'
                  ? tr('editor.associationName')
                  : tr('editor.labelAria', { type: tr(EDGE_TYPE_KEYS[selectedEdgeData.type]) })
              }
              defaultValue={selectedEdgeData.edge.name ?? ''}
              onBlur={(event) => commitEdgeLabel(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  commitEdgeLabel((event.target as HTMLInputElement).value);
                }
              }}
            />
          </label>
          {selectedEdgeData.type === 'association' && (
            <>
              <label>
                {tr('editor.sourceRole')}
                <input
                  aria-label={tr('editor.sourceRole')}
                  defaultValue={selectedEdgeData.edge.sourceRole ?? ''}
                  onBlur={(event) =>
                    handleUpdateAssociationMeta(doc, diagram.id, selectedEdgeData.edge.id, { sourceRole: event.target.value.trim() || undefined })
                  }
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      handleUpdateAssociationMeta(doc, diagram.id, selectedEdgeData.edge.id, { sourceRole: (event.target as HTMLInputElement).value.trim() || undefined });
                    }
                  }}
                />
              </label>
              <label>
                {tr('editor.targetRole')}
                <input
                  aria-label={tr('editor.targetRole')}
                  defaultValue={selectedEdgeData.edge.targetRole ?? ''}
                  onBlur={(event) =>
                    handleUpdateAssociationMeta(doc, diagram.id, selectedEdgeData.edge.id, { targetRole: event.target.value.trim() || undefined })
                  }
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      handleUpdateAssociationMeta(doc, diagram.id, selectedEdgeData.edge.id, { targetRole: (event.target as HTMLInputElement).value.trim() || undefined });
                    }
                  }}
                />
              </label>
              <label>
                {tr('editor.sourceMultiplicity')}
                <input
                  aria-label={tr('editor.sourceMultiplicity')}
                  defaultValue={selectedEdgeData.edge.sourceMultiplicity ?? ''}
                  onBlur={(event) =>
                    handleUpdateMultiplicity(doc, diagram.id, selectedEdgeData.edge.id, 'source', event.target.value)
                  }
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      handleUpdateMultiplicity(doc, diagram.id, selectedEdgeData.edge.id, 'source', (event.target as HTMLInputElement).value);
                    }
                  }}
                />
              </label>
              <label>
                {tr('editor.targetMultiplicity')}
                <input
                  aria-label={tr('editor.targetMultiplicity')}
                  defaultValue={selectedEdgeData.edge.targetMultiplicity}
                  onBlur={(event) =>
                    handleUpdateMultiplicity(doc, diagram.id, selectedEdgeData.edge.id, 'target', event.target.value)
                  }
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      handleUpdateMultiplicity(doc, diagram.id, selectedEdgeData.edge.id, 'target', (event.target as HTMLInputElement).value);
                    }
                  }}
                />
              </label>
              {/* Flip diamond end control — only for aggregation/composition associations */}
              {selectedEdgeData.edge.aggregation !== 'none' && selectedEdgeData.edge.aggregationEnd !== undefined && (
                <div className="diagram-canvas__flip-diamond">
                  <span>
                    {tr('editor.diamondEnd', {
                      end: selectedEdgeData.edge.aggregationEnd === 'source' ? tr('editor.endSource') : tr('editor.endTarget'),
                    })}
                  </span>
                  <button
                    type="button"
                    aria-label={tr('editor.flipDiamondEndAria', {
                      end: selectedEdgeData.edge.aggregationEnd === 'source' ? tr('editor.endTarget') : tr('editor.endSource'),
                    })}
                    onClick={() =>
                      handleUpdateAssociationMeta(doc, diagram.id, selectedEdgeData.edge.id, {
                        aggregationEnd: selectedEdgeData.edge.aggregationEnd === 'source' ? 'target' : 'source',
                      })
                    }
                  >
                    {tr('editor.flipDiamondEnd')}
                  </button>
                </div>
              )}
            </>
          )}
          <button
            type="button"
            className="diagram-canvas__delete-edge"
            aria-label={tr('editor.deleteAria', { type: selectedEdgeData.type, id: selectedEdgeData.edge.id })}
            onClick={deleteSelectedEdge}
          >
            {tr('editor.delete', { type: selectedEdgeData.type })}
          </button>
          <button
            type="button"
            className="diagram-canvas__close-edge-editor"
            aria-label={tr('editor.closeAria')}
            onClick={() => setSelectedEdge(null)}
          >
            {tr('editor.close')}
          </button>
        </div>
      )}
      {/* unit 13d fix A — the n-ary diamond's own editor (same pattern as the
          unified edge editor): editable name, one multiplicity input per
          member end (labeled by class name), and Delete. Every commit emits
          the core naryAssociation `update` delta. */}
      {selectedNary && (
        <div className="diagram-canvas__edge-editor" data-testid="nary-editor" key={selectedNary.id}>
          <span className="diagram-canvas__edge-editor-title">
            {tr('naryEditor.title')}
          </span>
          <label>
            {tr('nary.name')}
            <input
              aria-label={tr('naryEditor.nameAria')}
              defaultValue={selectedNary.name ?? ''}
              onBlur={(event) => commitNaryName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  commitNaryName((event.target as HTMLInputElement).value);
                }
              }}
            />
          </label>
          {selectedNary.memberEnds.map((end) => {
            const cls = diagram.classes.find((candidate) => candidate.id === end.classId);
            return (
              <label key={end.classId} className="diagram-canvas__nary-end">
                {cls?.name ?? '?'}
                <input
                  aria-label={tr('naryEditor.endMultiplicityAria', { name: cls?.name ?? end.classId })}
                  defaultValue={end.multiplicity}
                  onBlur={(event) => commitNaryEndMultiplicity(end.classId, event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      commitNaryEndMultiplicity(end.classId, (event.target as HTMLInputElement).value);
                    }
                  }}
                />
              </label>
            );
          })}
          <button
            type="button"
            className="diagram-canvas__delete-edge"
            aria-label={tr('naryEditor.deleteAria', { id: selectedNary.id })}
            onClick={() => {
              handleDeleteNaryAssociation(doc, diagram.id, selectedNary.id);
              // The projection-driven selectedNary resolution closes the
              // panel; clearing the id also covers the same-tick case.
              setSelectedNaryId(null);
            }}
          >
            {tr('naryEditor.delete')}
          </button>
          <button
            type="button"
            className="diagram-canvas__close-edge-editor"
            aria-label={tr('naryEditor.closeAria')}
            onClick={() => setSelectedNaryId(null)}
          >
            {tr('editor.close')}
          </button>
        </div>
      )}
      {selectedClass && (
        <div className="diagram-canvas__generalizations" data-testid="generalization-panel">
          <span className="diagram-canvas__generalizations-title">
            {tr('panel.generalizationsFor', { name: selectedClass.name })}
          </span>
          {selectedClassGeneralizations.length === 0 && (
            <span className="diagram-canvas__generalizations-empty">{tr('panel.none')}</span>
          )}
          {selectedClassGeneralizations.map((gen) => (
            <div key={gen.id} className="diagram-canvas__generalization-row">
              <span>
                {gen.subClassId === selectedClass.id
                  ? tr('panel.inheritsFrom', { name: classNameById(gen.superClassId) })
                  : tr('panel.inheritedBy', { name: classNameById(gen.subClassId) })}
              </span>
              <button
                type="button"
                className="diagram-canvas__delete-generalization"
                aria-label={tr('panel.removeInheritanceAria', { id: gen.id })}
                onClick={() => handleDeleteGeneralization(doc, diagram.id, gen.id)}
              >
                {tr('panel.removeInheritance')}
              </button>
            </div>
          ))}
        </div>
      )}
      {selectedClass && (
        <div className="diagram-canvas__realizations" data-testid="realization-panel">
          <span className="diagram-canvas__realizations-title">
            {tr('panel.realizationsFor', { name: selectedClass.name })}
          </span>
          {selectedClassRealizations.length === 0 && (
            <span className="diagram-canvas__realizations-empty">{tr('panel.none')}</span>
          )}
          {selectedClassRealizations.map((real) => (
            <div key={real.id} className="diagram-canvas__realization-row">
              <span>
                {real.clientClassId === selectedClass.id
                  ? tr('panel.realizes', { name: classNameById(real.supplierInterfaceId) })
                  : tr('panel.realizedBy', { name: classNameById(real.clientClassId) })}
              </span>
              <button
                type="button"
                className="diagram-canvas__delete-realization"
                aria-label={tr('panel.removeRealizationAria', { id: real.id })}
                onClick={() => handleDeleteRealization(doc, diagram.id, real.id)}
              >
                {tr('panel.removeRealization')}
              </button>
            </div>
          ))}
        </div>
      )}
      {selectedClass && (
        <div className="diagram-canvas__dependencies" data-testid="dependency-panel">
          <span className="diagram-canvas__dependencies-title">
            {tr('panel.dependenciesFor', { name: selectedClass.name })}
          </span>
          {selectedClassDependencies.length === 0 && (
            <span className="diagram-canvas__dependencies-empty">{tr('panel.none')}</span>
          )}
          {selectedClassDependencies.map((dep) => (
            <div key={dep.id} className="diagram-canvas__dependency-row">
              <span>
                {dep.clientClassId === selectedClass.id
                  ? tr('panel.dependsOn', { name: classNameById(dep.supplierClassId) })
                  : tr('panel.dependencyFrom', { name: classNameById(dep.clientClassId) })}
              </span>
              <button
                type="button"
                className="diagram-canvas__delete-dependency"
                aria-label={tr('panel.removeDependencyAria', { id: dep.id })}
                onClick={() => handleDeleteDependency(doc, diagram.id, dep.id)}
              >
                {tr('panel.removeDependency')}
              </button>
            </div>
          ))}
        </div>
      )}
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        // unit 13b — connections are only startable while an edge tool is
        // armed; loose mode lets the drag begin from any handle (the delta
        // cares about node direction, not handle identity).
        nodesConnectable={edgeTool !== null}
        connectionMode="loose"
        // unit 13c — forgiving snap radius around handles; combined with the
        // full-node connect overlays this makes body-wide drag-to-connect.
        connectionRadius={40}
        onConnect={onConnect}
        onEdgesChange={() => {}}
        onDrop={onDrop}
        onDragOver={onDragOver}
        onInit={(instance) => {
          rfRef.current = instance;
        }}
        onNodesChange={() => {}}
        onNodeClick={(_event, node) => handleNodeClick(node)}
        // unit 13c — clicking any editor edge kind opens the ONE unified
        // editor; n-ary member edges keep their own diamond flow.
        onEdgeClick={(_event, edge) => {
          if (isEditorEdgeType(edge.type)) {
            setSelectedEdge({ id: edge.id, type: edge.type });
            // Editors are exclusive: opening the edge editor closes the
            // n-ary diamond editor (unit 13d fix A).
            setSelectedNaryId(null);
          }
        }}
        // unit 13d fix D — clicking empty canvas deselects: clear the
        // selected class, close the edge/n-ary editors, and disarm any
        // armed edge tool (the click equivalent of Escape).
        onPaneClick={() => {
          setSelectedClassId(null);
          setSelectedEdge(null);
          setSelectedNaryId(null);
          setEdgeTool(null);
          setEdgeMessage(null);
        }}
        onNodeDragStop={(_event, node) => handleNodeDragStop(doc, diagram.id, node)}
        fitView
      >
        {/* unit 13e — EA-like canvas: subtle dot grid behind the elements. */}
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#c9c9c9" />
      </ReactFlow>
      {/* unit 13d — Quick Linker rubber band: a thin dashed line from the
          corner arrow to the live cursor while the quick-link drag runs. */}
      {quickLinkDrag !== null && (
        <svg className="quicklinker-rubberband" data-testid="quicklinker-rubberband" aria-hidden="true">
          <line
            x1={quickLinkDrag.start.x}
            y1={quickLinkDrag.start.y}
            x2={quickLinkDrag.cursor.x}
            y2={quickLinkDrag.cursor.y}
          />
        </svg>
      )}
      {/* unit 13d — the metamodel-filtered menu: connector options over an
          existing element, creatable element types over empty canvas.
          Escape / click-away closes WITHOUT creating anything. */}
      {quickLinkMenu !== null &&
        (quickLinkMenu.mode === 'connector' ? (
          <QuickLinkerMenu
            position={quickLinkMenu.anchor}
            items={validConnectorsFor(quickLinkMenu.sourceKind, quickLinkMenu.targetKind, quickLinkMenu.sourceId === quickLinkMenu.targetId).map(
              (connector) => ({ id: connector, label: tr(CONNECTOR_TOOL_KEYS[connector]) }),
            )}
            onSelect={(id) => pickQuickConnector(id as QuickConnectorType)}
            onClose={() => setQuickLinkMenu(null)}
          />
        ) : (
          <QuickLinkerMenu
            position={quickLinkMenu.anchor}
            items={elementMenuOptions().map((kind) => ({ id: kind, label: tr(ELEMENT_TOOL_KEYS[kind]) }))}
            onSelect={pickQuickElement}
            onClose={() => setQuickLinkMenu(null)}
          />
        ))}
    </div>
  );
}