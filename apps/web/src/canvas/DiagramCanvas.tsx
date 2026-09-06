/**
 * DiagramCanvas — React Flow canvas rendering exclusively from a Y.Doc.
 *
 * editor:R1 — the Y.Doc IS the canonical IR; React state is a derived
 * projection that triggers re-render when the Y.Doc changes.
 * No mutation bypasses applyDelta (see applyDeltaToYDoc).
 */
import { useEffect, useMemo, useState } from 'react';
import { ReactFlow, type Edge, MarkerType } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type * as Y from 'yjs';

import { MultiplicitySchema, projectYDocToDiagram, type Association, type AssociationDelta, type ClassDelta, type DependencyDelta, type Diagram, type Generalization, type GeneralizationDelta, type MemberDelta, type NaryAssociationDelta, type NaryMemberEnd, type Parameter, type Realization, type RealizationDelta } from '@app/core';

import './canvas.css';
import { ClassNode, type ClassNodeData, type ClassFlowNode, type MemberAdornments } from './ClassNode';
import { NaryDiamondNode, type NaryDiamondFlowNode } from './NaryDiamondNode';
import { applyDeltaToYDoc } from './applyDeltaToYDoc';
import { AssociationEdge } from './AssociationEdge';
import { GeneralizationEdge } from './GeneralizationEdge';
import { RealizationEdge } from './RealizationEdge';
import { DependencyEdge } from './DependencyEdge';
import { NaryEndEdge } from './NaryEndEdge';

const nodeTypes = { class: ClassNode, naryDiamond: NaryDiamondNode };
const edgeTypes = { association: AssociationEdge, generalization: GeneralizationEdge, realization: RealizationEdge, dependency: DependencyEdge, naryEnd: NaryEndEdge };

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
}

/**
 * editor:R4 - emits an association `create` delta via applyDeltaToYDoc.
 * Guards before emitting: the delta schema throws on invalid input, so no
 * empty class id ever reaches it. Self (recursive) associations — the same
 * class on both ends — are valid UML and allowed by the core engine.
 */
export function handleCreateAssociation(
  doc: Y.Doc,
  diagramId: string,
  link: AssociationLink,
): void {
  if (link.sourceClassId === '' || link.targetClassId === '') {
    return;
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
  };
  applyDeltaToYDoc(doc, delta);
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
 */
export function handleCreateGeneralization(
  doc: Y.Doc,
  diagramId: string,
  link: { subClassId: string; superClassId: string },
): void {
  if (link.subClassId === '' || link.superClassId === '') {
    return;
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
  applyDeltaToYDoc(doc, delta);
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
 */
export function handleCreateRealization(
  doc: Y.Doc,
  diagramId: string,
  link: { clientClassId: string; supplierInterfaceId: string },
): void {
  if (link.clientClassId === '' || link.supplierInterfaceId === '') {
    return;
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
  applyDeltaToYDoc(doc, delta);
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
 */
export function handleCreateDependency(
  doc: Y.Doc,
  diagramId: string,
  link: { clientClassId: string; supplierClassId: string },
): void {
  if (link.clientClassId === '' || link.supplierClassId === '') {
    return;
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
  applyDeltaToYDoc(doc, delta);
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

export function DiagramCanvas({ doc }: DiagramCanvasProps) {
  // Derive state from the Y.Doc — the Y.Doc is the source of truth.
  const [diagram, setDiagram] = useState<Diagram>(() => projectYDocToDiagram(doc));

  const [linkMode, setLinkMode] = useState(false);
  const [linkSource, setLinkSource] = useState<string | null>(null);
  const [linkDirected, setLinkDirected] = useState(false);
  const [selectedAssociationId, setSelectedAssociationId] = useState<string | null>(null);
  // Unit 11.4 — the class whose generalization list is shown in the panel.
  const [selectedClassId, setSelectedClassId] = useState<string | null>(null);
  // Unit 13.3 — n-ary association mode: pick >=3 classes, per-end multiplicity.
  const [naryMode, setNaryMode] = useState(false);
  const [narySelection, setNarySelection] = useState<string[]>([]);
  const [naryEnds, setNaryEnds] = useState<Record<string, string>>({});
  const [naryName, setNaryName] = useState('');

  useEffect(() => {
    const sync = (): void => {
      setDiagram(projectYDocToDiagram(doc));
    };
    doc.on('update', sync);
    return () => {
      doc.off('update', sync);
    };
  }, [doc]);

  const handleAddClass = (): void => {
    const name = nextFreeClassName(diagram.classes.map((cls) => cls.name));
    const delta: ClassDelta = {
      kind: 'class',
      op: 'create',
      id: crypto.randomUUID(),
      diagramId: diagram.id,
      timestamp: new Date().toISOString(),
      classId: crypto.randomUUID(),
      name,
      position: { x: 80 + diagram.classes.length * 40, y: 80 + diagram.classes.length * 40 },
    };
    applyDeltaToYDoc(doc, delta);
  };

  /** editor:R Interfaces (unit 12.4) — toolbar action: create an interface node. */
  const handleAddInterface = (): void => {
    const name = nextFreeClassName(diagram.classes.map((cls) => cls.name), 'Interface');
    const delta: ClassDelta = {
      kind: 'class',
      op: 'create',
      id: crypto.randomUUID(),
      diagramId: diagram.id,
      timestamp: new Date().toISOString(),
      classId: crypto.randomUUID(),
      name,
      position: { x: 80 + diagram.classes.length * 40, y: 80 + diagram.classes.length * 40 },
      classKind: 'interface',
    };
    applyDeltaToYDoc(doc, delta);
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
    [diagram],
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

  const selectedAssociation = useMemo(
    () => diagram.associations.find((assoc) => assoc.id === selectedAssociationId) ?? null,
    [diagram, selectedAssociationId],
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

  return (
    <div className="diagram-canvas" style={{ width: '100%', height: '100%' }}>
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
            multiplicities, create. */}
        <button
          type="button"
          onClick={() => {
            setNaryMode(!naryMode);
            setNarySelection([]);
            setNaryEnds({});
            setNaryName('');
          }}
        >
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
      {selectedAssociation && (
        <div className="diagram-canvas__multiplicity">
          <label>
            Association name
            <input
              aria-label="Association name"
              defaultValue={selectedAssociation.name ?? ''}
              onBlur={(event) =>
                handleUpdateAssociationMeta(doc, diagram.id, selectedAssociation.id, { name: event.target.value.trim() || undefined })
              }
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  handleUpdateAssociationMeta(doc, diagram.id, selectedAssociation.id, { name: (event.target as HTMLInputElement).value.trim() || undefined });
                }
              }}
            />
          </label>
          <label>
            Aggregation
            <select
              aria-label="Aggregation kind"
              defaultValue={selectedAssociation.aggregation ?? 'none'}
              onChange={(event) =>
                handleUpdateAssociationMeta(doc, diagram.id, selectedAssociation.id, { aggregation: event.target.value as 'none' | 'shared' | 'composite' })
              }
            >
              <option value="none">None</option>
              <option value="shared">Shared (hollow diamond)</option>
              <option value="composite">Composite (filled diamond)</option>
            </select>
          </label>
          <label>
            Aggregation end
            <select
              aria-label="Aggregation end"
              defaultValue={selectedAssociation.aggregationEnd ?? 'source'}
              disabled={selectedAssociation.aggregation === 'none'}
              onChange={(event) =>
                handleUpdateAssociationMeta(doc, diagram.id, selectedAssociation.id, { aggregationEnd: event.target.value as 'source' | 'target' })
              }
            >
              <option value="source">Source class</option>
              <option value="target">Target class</option>
            </select>
          </label>
          <label>
            Source role
            <input
              aria-label="Source role"
              defaultValue={selectedAssociation.sourceRole ?? ''}
              onBlur={(event) =>
                handleUpdateAssociationMeta(doc, diagram.id, selectedAssociation.id, { sourceRole: event.target.value.trim() || undefined })
              }
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  handleUpdateAssociationMeta(doc, diagram.id, selectedAssociation.id, { sourceRole: (event.target as HTMLInputElement).value.trim() || undefined });
                }
              }}
            />
          </label>
          <label>
            Target role
            <input
              aria-label="Target role"
              defaultValue={selectedAssociation.targetRole ?? ''}
              onBlur={(event) =>
                handleUpdateAssociationMeta(doc, diagram.id, selectedAssociation.id, { targetRole: event.target.value.trim() || undefined })
              }
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  handleUpdateAssociationMeta(doc, diagram.id, selectedAssociation.id, { targetRole: (event.target as HTMLInputElement).value.trim() || undefined });
                }
              }}
            />
          </label>
          <label>
            Source multiplicity
            <input
              aria-label="Source multiplicity"
              defaultValue={selectedAssociation.sourceMultiplicity}
              onBlur={(event) =>
                handleUpdateMultiplicity(doc, diagram.id, selectedAssociation.id, 'source', event.target.value)
              }
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  handleUpdateMultiplicity(doc, diagram.id, selectedAssociation.id, 'source', (event.target as HTMLInputElement).value);
                }
              }}
            />
          </label>
          <label>
            Target multiplicity
            <input
              aria-label="Target multiplicity"
              defaultValue={selectedAssociation.targetMultiplicity}
              onBlur={(event) =>
                handleUpdateMultiplicity(doc, diagram.id, selectedAssociation.id, 'target', event.target.value)
              }
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  handleUpdateMultiplicity(doc, diagram.id, selectedAssociation.id, 'target', (event.target as HTMLInputElement).value);
                }
              }}
            />
          </label>
          <button
            type="button"
            className="diagram-canvas__delete-association"
            aria-label={`Delete association ${selectedAssociation.id}`}
            onClick={() => {
              handleDeleteAssociation(doc, diagram.id, selectedAssociation.id);
              setSelectedAssociationId(null);
            }}
          >
            Delete association
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
        nodesConnectable={false}
        onNodesChange={() => {}}
        onNodeClick={(_event, node) => handleNodeClick(node)}
        onEdgeClick={(_event, edge) => setSelectedAssociationId(edge.id)}
        onNodeDragStop={(_event, node) => handleNodeDragStop(doc, diagram.id, node)}
        fitView
      />
    </div>
  );
}