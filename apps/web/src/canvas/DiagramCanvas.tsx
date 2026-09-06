/**
 * DiagramCanvas — React Flow canvas rendering exclusively from a Y.Doc.
 *
 * editor:R1 — the Y.Doc IS the canonical IR; React state is a derived
 * projection that triggers re-render when the Y.Doc changes.
 * No mutation bypasses applyDelta (see applyDeltaToYDoc).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { ReactFlow, type Connection, type Edge, type ReactFlowInstance, MarkerType } from '@xyflow/react';
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

const nodeTypes = { class: ClassNode, naryDiamond: NaryDiamondNode };
const edgeTypes = { association: AssociationEdge, generalization: GeneralizationEdge, realization: RealizationEdge, dependency: DependencyEdge, naryEnd: NaryEndEdge };

/**
 * unit 13c — the edge kinds the unified editor understands. n-ary member
 * edges (`naryEnd`) are deliberately excluded: they are edited through the
 * n-ary diamond's own context/pick flow, not the per-edge panel.
 */
type EditorEdgeType = 'association' | 'generalization' | 'realization' | 'dependency';

const EDGE_TYPE_LABELS: Record<EditorEdgeType, string> = {
  association: 'Association',
  generalization: 'Generalization',
  realization: 'Realization',
  dependency: 'Dependency',
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
  const delta: AssociationDelta = {
    kind: 'association',
    op: 'create',
    id: crypto.randomUUID(),
    diagramId,
    timestamp: new Date().toISOString(),
    associationId: crypto.randomUUID(),
    sourceClassId: link.sourceClassId,
    targetClassId: link.targetClassId,
    sourceMultiplicity: '1',
    targetMultiplicity: '1',
    directed: link.directed,
    // unit 13c — the palette Aggregation/Composition tools preset the kind;
    // the diamond sits on the source end by default (aggregationEnd='source').
    ...(link.aggregation !== undefined && link.aggregation !== 'none'
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
 */
export function handleUpdateMultiplicity(
  doc: Y.Doc,
  diagramId: string,
  associationId: string,
  endpoint: 'source' | 'target',
  value: string,
): void {
  // unit 9 — full UML 2.5.1 multiplicity grammar (*, integers, m..n, m..*);
  // garbage is rejected and the previous value is retained (editor:R4).
  const parsed = MultiplicitySchema.safeParse(value);
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
 */
export function handlePaletteDrop(
  doc: Y.Doc,
  diagramId: string,
  input: { kind: PaletteNodeKind; position: { x: number; y: number }; existingNames: readonly string[] },
): void {
  const prefix = input.kind === 'interface' ? 'Interface' : 'Class';
  const name = nextFreeClassName(input.existingNames, prefix);
  const delta: ClassDelta = {
    kind: 'class',
    op: 'create',
    id: crypto.randomUUID(),
    diagramId,
    timestamp: new Date().toISOString(),
    classId: crypto.randomUUID(),
    name,
    position: input.position,
    ...(input.kind === 'interface' ? { classKind: 'interface' as const } : {}),
  };
  applyDeltaToYDoc(doc, delta);
}

/** Outcome of a guarded drag-to-connect: ok, or rejected with a user message. */
export interface ConnectGuardResult {
  ok: boolean;
  message?: string;
}

/** Human-readable reason for an engine rejection surfaced in the UI. */
function describeApplyError(error: ApplyError): string {
  switch (error.kind) {
    case 'GeneralizationCycleError':
      return 'this inheritance would create a cycle';
    case 'DuplicateGeneralizationError':
      return 'this inheritance link already exists';
    case 'RealizationTargetNotInterfaceError':
      return 'the target must be an interface';
    case 'DuplicateRealizationError':
      return 'this realization already exists';
    case 'DuplicateDependencyError':
      return 'this dependency already exists';
    case 'ClassNotFoundError':
      return 'a referenced class does not exist';
    default:
      return 'the model rejected the change and is unchanged';
  }
}

function engineGuardResult(result: ApplyResult<Diagram> | null, label: string): ConnectGuardResult {
  if (result === null) {
    return { ok: false, message: `${label} rejected: invalid endpoints.` };
  }
  if (result.ok) {
    return { ok: true };
  }
  return { ok: false, message: `${label} rejected: ${describeApplyError(result.error)}.` };
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
    return { ok: false, message: 'Both ends of the connection must be classes.' };
  }
  const sourceCls = classifiers.find((cls) => cls.id === source);
  const targetCls = classifiers.find((cls) => cls.id === target);
  if (sourceCls === undefined || targetCls === undefined) {
    return { ok: false, message: 'Both endpoints must be existing classes.' };
  }

  switch (tool) {
    case 'association': {
      if (source === target) {
        return { ok: false, message: 'An association needs two distinct classes — drag to a different node.' };
      }
      const result = handleCreateAssociation(doc, diagramId, {
        sourceClassId: source,
        targetClassId: target,
        directed: false,
      });
      return engineGuardResult(result, 'Association');
    }
    // unit 13c — Aggregation/Composition reuse the association path with the
    // diamond kind preset (shared = hollow, composite = filled).
    case 'aggregation':
    case 'composition': {
      if (source === target) {
        return { ok: false, message: 'An association needs two distinct classes — drag to a different node.' };
      }
      const result = handleCreateAssociation(doc, diagramId, {
        sourceClassId: source,
        targetClassId: target,
        directed: false,
        aggregation: tool === 'aggregation' ? 'shared' : 'composite',
      });
      return engineGuardResult(result, tool === 'aggregation' ? 'Aggregation' : 'Composition');
    }
    case 'generalization': {
      if (source === target) {
        return { ok: false, message: 'A class cannot inherit from itself.' };
      }
      const result = handleCreateGeneralization(doc, diagramId, {
        subClassId: source,
        superClassId: target,
      });
      return engineGuardResult(result, 'Generalization');
    }
    case 'realization': {
      if (targetCls.kind !== 'interface') {
        return { ok: false, message: 'A realization must target an interface («interface»).' };
      }
      const result = handleCreateRealization(doc, diagramId, {
        clientClassId: source,
        supplierInterfaceId: target,
      });
      return engineGuardResult(result, 'Realization');
    }
    case 'dependency': {
      if (source === target) {
        return { ok: false, message: 'A dependency needs two distinct endpoints.' };
      }
      const result = handleCreateDependency(doc, diagramId, {
        clientClassId: source,
        supplierClassId: target,
      });
      return engineGuardResult(result, 'Dependency');
    }
  }
}

export function DiagramCanvas({ doc }: DiagramCanvasProps) {
  // Derive state from the Y.Doc — the Y.Doc is the source of truth.
  const [diagram, setDiagram] = useState<Diagram>(() => projectYDocToDiagram(doc));

  const [linkMode, setLinkMode] = useState(false);
  const [linkSource, setLinkSource] = useState<string | null>(null);
  const [linkDirected, setLinkDirected] = useState(false);
  // unit 13c — ONE editor for every edge kind: the selected edge's id + type.
  const [selectedEdge, setSelectedEdge] = useState<{ id: string; type: EditorEdgeType } | null>(null);
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
   * unit 13b — toolbar and palette share ONE creation path:
   * handlePaletteDrop with a staggered position (toolbar) or the drop point.
   */
  const handleAddClass = (): void => {
    handlePaletteDrop(doc, diagram.id, {
      kind: 'class',
      position: { x: 80 + diagram.classes.length * 40, y: 80 + diagram.classes.length * 40 },
      existingNames: diagram.classes.map((cls) => cls.name),
    });
  };

  /** editor:R Interfaces (unit 12.4) — toolbar action: create an interface node. */
  const handleAddInterface = (): void => {
    handlePaletteDrop(doc, diagram.id, {
      kind: 'interface',
      position: { x: 80 + diagram.classes.length * 40, y: 80 + diagram.classes.length * 40 },
      existingNames: diagram.classes.map((cls) => cls.name),
    });
  };

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

  /** editor:R4 - link mode: click source class, then a different class to complete. */
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
    if (!linkMode) return;
    if (linkSource === null) {
      setLinkSource(node.id);
      return;
    }
    if (node.id === linkSource) {
      setLinkSource(null);
      return;
    }
    handleCreateAssociation(doc, diagram.id, {
      sourceClassId: linkSource,
      targetClassId: node.id,
      directed: linkDirected,
    });
    setLinkSource(null);
    setLinkMode(false);
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
    // node-wide connect overlays.
    [diagram, edgeTool],
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
   * unit 13b — the palette and toolbar share ONE n-ary pick-mode toggle.
   * Entering it disarms any armed edge tool (the modes are exclusive).
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
      {/* unit 13b — left creation rail: drag nodes, arm edge tools, n-ary. */}
      <Palette
        activeEdgeTool={edgeTool}
        naryMode={naryMode}
        onEdgeToolChange={changeEdgeTool}
        onNaryModeToggle={toggleNaryMode}
      />
      <div className="diagram-canvas__toolbar">
        <button type="button" onClick={handleAddClass}>
          Add class
        </button>
        <button type="button" onClick={handleAddInterface}>
          Add interface
        </button>
        <button
          type="button"
          onClick={() => {
            setLinkMode(!linkMode);
            setLinkSource(null);
          }}
        >
          {linkMode ? 'Cancel link' : 'Link classes'}
        </button>
        {/* Unit 13.3 — n-ary association mode: pick >=3 classes, set per-end
            multiplicities, create. Unit 13b — the palette diamond toggles the
            SAME mode via this shared handler. */}
        <button type="button" onClick={toggleNaryMode}>
          {naryMode ? 'Cancel n-ary' : 'N-ary association'}
        </button>
        <label>
          <input
            type="checkbox"
            checked={linkDirected}
            disabled={!linkMode}
            onChange={(event) => setLinkDirected(event.target.checked)}
          />
          Directed
        </label>
        {linkSource !== null && <span>Select target class</span>}
      </div>
      {/* unit 13b — affordances for the armed edge tool + guard feedback. */}
      {edgeTool !== null && (
        <div className="diagram-canvas__hint" data-testid="edge-tool-hint" role="status">
          {edgeTool[0]!.toUpperCase() + edgeTool.slice(1)} tool armed — drag from a source node to a
          target node. Press Esc to cancel.
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
            N-ary association — {narySelection.length} of 3+ classes selected
          </span>
          {narySelection.map((classId) => {
            const cls = diagram.classes.find((candidate) => candidate.id === classId);
            if (cls === undefined) return null;
            return (
              <label key={classId} className="diagram-canvas__nary-end">
                {cls.name}
                <input
                  aria-label={`Multiplicity for ${cls.name}`}
                  value={naryEnds[classId] ?? '1'}
                  onChange={(event) =>
                    setNaryEnds((prev) => ({ ...prev, [classId]: event.target.value }))
                  }
                />
              </label>
            );
          })}
          <label>
            Name
            <input
              aria-label="N-ary association name"
              placeholder="optional"
              value={naryName}
              onChange={(event) => setNaryName(event.target.value)}
            />
          </label>
          <button
            type="button"
            className="diagram-canvas__create-nary"
            aria-label="Create n-ary association"
            disabled={narySelection.length < 3}
            onClick={handleCreateNaryFromPanel}
          >
            Create
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
            {EDGE_TYPE_LABELS[selectedEdgeData.type]}
          </span>
          <label>
            {selectedEdgeData.type === 'association' ? 'Association name' : 'Label'}
            <input
              aria-label={
                selectedEdgeData.type === 'association'
                  ? 'Association name'
                  : `${EDGE_TYPE_LABELS[selectedEdgeData.type]} label`
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
                Source role
                <input
                  aria-label="Source role"
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
                Target role
                <input
                  aria-label="Target role"
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
                Source multiplicity
                <input
                  aria-label="Source multiplicity"
                  defaultValue={selectedEdgeData.edge.sourceMultiplicity}
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
                Target multiplicity
                <input
                  aria-label="Target multiplicity"
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
            </>
          )}
          <button
            type="button"
            className="diagram-canvas__delete-edge"
            aria-label={`Delete ${selectedEdgeData.type} ${selectedEdgeData.edge.id}`}
            onClick={deleteSelectedEdge}
          >
            Delete {selectedEdgeData.type}
          </button>
          <button
            type="button"
            className="diagram-canvas__close-edge-editor"
            aria-label="Close edge editor"
            onClick={() => setSelectedEdge(null)}
          >
            Close
          </button>
        </div>
      )}
      {selectedClass && (
        <div className="diagram-canvas__generalizations" data-testid="generalization-panel">
          <span className="diagram-canvas__generalizations-title">
            Generalizations for {selectedClass.name}
          </span>
          {selectedClassGeneralizations.length === 0 && (
            <span className="diagram-canvas__generalizations-empty">None</span>
          )}
          {selectedClassGeneralizations.map((gen) => (
            <div key={gen.id} className="diagram-canvas__generalization-row">
              <span>
                {gen.subClassId === selectedClass.id
                  ? `Inherits from ${classNameById(gen.superClassId)}`
                  : `Inherited by ${classNameById(gen.subClassId)}`}
              </span>
              <button
                type="button"
                className="diagram-canvas__delete-generalization"
                aria-label={`Delete generalization ${gen.id}`}
                onClick={() => handleDeleteGeneralization(doc, diagram.id, gen.id)}
              >
                Remove inheritance
              </button>
            </div>
          ))}
        </div>
      )}
      {selectedClass && (
        <div className="diagram-canvas__realizations" data-testid="realization-panel">
          <span className="diagram-canvas__realizations-title">
            Realizations for {selectedClass.name}
          </span>
          {selectedClassRealizations.length === 0 && (
            <span className="diagram-canvas__realizations-empty">None</span>
          )}
          {selectedClassRealizations.map((real) => (
            <div key={real.id} className="diagram-canvas__realization-row">
              <span>
                {real.clientClassId === selectedClass.id
                  ? `Realizes ${classNameById(real.supplierInterfaceId)}`
                  : `Realized by ${classNameById(real.clientClassId)}`}
              </span>
              <button
                type="button"
                className="diagram-canvas__delete-realization"
                aria-label={`Delete realization ${real.id}`}
                onClick={() => handleDeleteRealization(doc, diagram.id, real.id)}
              >
                Remove realization
              </button>
            </div>
          ))}
        </div>
      )}
      {selectedClass && (
        <div className="diagram-canvas__dependencies" data-testid="dependency-panel">
          <span className="diagram-canvas__dependencies-title">
            Dependencies for {selectedClass.name}
          </span>
          {selectedClassDependencies.length === 0 && (
            <span className="diagram-canvas__dependencies-empty">None</span>
          )}
          {selectedClassDependencies.map((dep) => (
            <div key={dep.id} className="diagram-canvas__dependency-row">
              <span>
                {dep.clientClassId === selectedClass.id
                  ? `Depends on ${classNameById(dep.supplierClassId)}`
                  : `Dependency from ${classNameById(dep.clientClassId)}`}
              </span>
              <button
                type="button"
                className="diagram-canvas__delete-dependency"
                aria-label={`Delete dependency ${dep.id}`}
                onClick={() => handleDeleteDependency(doc, diagram.id, dep.id)}
              >
                Remove dependency
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
          }
        }}
        onNodeDragStop={(_event, node) => handleNodeDragStop(doc, diagram.id, node)}
        fitView
      />
    </div>
  );
}