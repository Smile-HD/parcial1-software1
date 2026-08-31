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

import { MultiplicityEnum, projectYDocToDiagram, type AssociationDelta, type ClassDelta, type Diagram, type MemberDelta, type Parameter } from '@app/core';

import './canvas.css';
import { ClassNode, type ClassNodeData, type ClassFlowNode } from './ClassNode';
import { applyDeltaToYDoc } from './applyDeltaToYDoc';

const nodeTypes = { class: ClassNode };

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
 * self-loop or empty class id ever reaches it.
 */
export function handleCreateAssociation(
  doc: Y.Doc,
  diagramId: string,
  link: AssociationLink,
): void {
  if (link.sourceClassId === link.targetClassId || link.sourceClassId === '' || link.targetClassId === '') {
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
  const parsed = MultiplicityEnum.safeParse(value);
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
 * First free auto-name: Class1, Class2, ... skipping any existing name.
 */
function nextFreeClassName(existing: readonly string[]): string {
  let n = 1;
  while (existing.includes(`Class${n}`)) {
    n += 1;
  }
  return `Class${n}`;
}

export function DiagramCanvas({ doc }: DiagramCanvasProps) {
  // Derive state from the Y.Doc — the Y.Doc is the source of truth.
  const [diagram, setDiagram] = useState<Diagram>(() => projectYDocToDiagram(doc));

  const [linkMode, setLinkMode] = useState(false);
  const [linkSource, setLinkSource] = useState<string | null>(null);
  const [linkDirected, setLinkDirected] = useState(false);
  const [selectedAssociationId, setSelectedAssociationId] = useState<string | null>(null);

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
  const handleNodeClick = (node: { id: string }): void => {
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

  const handleAddAttribute = (classId: string, name: string, type: string): void => {
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
    };
    applyDeltaToYDoc(doc, delta);
  };

  /** editor:R3 — in-place attribute edit emitted as an `editAttribute` delta. */
  const handleEditAttribute = (classId: string, memberId: string, name: string, type: string): void => {
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

  const nodes = useMemo<ClassFlowNode[]>(
    () =>
      diagram.classes.map((cls) => ({
        id: cls.id,
        type: 'class' as const,
        position: cls.position,
        data: {
          name: cls.name,
          attributes: cls.attributes,
          methods: cls.methods,
          onRename: (newName: string) => handleRename(cls.id, newName),
          onDelete: () => handleDeleteClass(cls.id),
          onAddAttribute: (name: string, type: string) => handleAddAttribute(cls.id, name, type),
          onEditAttribute: (memberId: string, name: string, type: string) =>
            handleEditAttribute(cls.id, memberId, name, type),
          onRemoveAttribute: (memberId: string) => handleRemoveAttribute(cls.id, memberId),
          onAddMethod: (name: string, returnType: string, parameters: Parameter[]) =>
            handleAddMethod(cls.id, name, returnType, parameters),
          onEditMethod: (memberId: string, name: string, returnType: string, parameters: Parameter[]) =>
            handleEditMethod(cls.id, memberId, name, returnType, parameters),
          onRemoveMethod: (memberId: string) => handleRemoveMethod(cls.id, memberId),
        } satisfies ClassNodeData,
      })),
    [diagram],
  );

  const edges = useMemo<Edge[]>(
    () =>
      diagram.associations.map((assoc) => {
        const base = {
          id: assoc.id,
          source: assoc.sourceClassId,
          target: assoc.targetClassId,
          label: `${assoc.sourceMultiplicity} · ${assoc.targetMultiplicity}`,
        };
        return assoc.directed
          ? { ...base, markerEnd: { type: MarkerType.ArrowClosed } }
          : base;
      }),
    [diagram],
  );

  const selectedAssociation = useMemo(
    () => diagram.associations.find((assoc) => assoc.id === selectedAssociationId) ?? null,
    [diagram, selectedAssociationId],
  );

  return (
    <div className="diagram-canvas" style={{ width: '100%', height: '100%' }}>
      <div className="diagram-canvas__toolbar">
        <button type="button" onClick={handleAddClass}>
          Add class
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
      {selectedAssociation && (
        <div className="diagram-canvas__multiplicity">
          <label>
            Source multiplicity
            <select
              aria-label="Source multiplicity"
              value={selectedAssociation.sourceMultiplicity}
              onChange={(event) =>
                handleUpdateMultiplicity(doc, diagram.id, selectedAssociation.id, 'source', event.target.value)
              }
            >
              {MultiplicityEnum.options.map((multiplicity) => (
                <option key={multiplicity} value={multiplicity}>
                  {multiplicity}
                </option>
              ))}
            </select>
          </label>
          <label>
            Target multiplicity
            <select
              aria-label="Target multiplicity"
              value={selectedAssociation.targetMultiplicity}
              onChange={(event) =>
                handleUpdateMultiplicity(doc, diagram.id, selectedAssociation.id, 'target', event.target.value)
              }
            >
              {MultiplicityEnum.options.map((multiplicity) => (
                <option key={multiplicity} value={multiplicity}>
                  {multiplicity}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
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