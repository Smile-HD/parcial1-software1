/**
 * Custom edge component for UML dependency edges: a DASHED line with an
 * OPEN (non-filled, V-shaped) arrowhead pointing toward the supplier
 * (UML 2.5.1 dependency notation). Unlike realization, the supplier may
 * be any class or interface and there is no multiplicity label.
 *
 * The edge is drawn source = clientClass → target = supplierClass, so
 * the arrow marker sits on marker-end. Markers are referenced as
 * `url(#id)` strings — NOT MarkerType objects (PR 10 lesson, applied by
 * PR 11's GeneralizationEdge and PR 12a's RealizationEdge: React Flow
 * serializes marker objects into attributes the browser cannot resolve
 * for custom SVG defs).
 *
 * unit 13e: non-self edges route orthogonally (getSmoothStepPath, EA's
 * default connector); self-dependencies (client === supplier, valid since
 * 13d) render a visible rounded loop via getSelfLoopPath — sized from the
 * node's measured dimensions read from the React Flow store — so the open
 * arrowhead returns into the node instead of hiding behind it.
 */
import { type EdgeProps, getSmoothStepPath, useStore, BaseEdge } from '@xyflow/react';

import type { Dependency } from '@app/core';

import { getSelfLoopGeometry } from './selfLoop';

interface DependencyEdgeData {
  dependency: Dependency;
}

/** Dashed stroke per UML dependency notation (client → supplier). */
const DEPENDENCY_DASH = '6 4';

export function DependencyEdge(props: EdgeProps<DependencyEdgeData>) {
  const { id, data, source, target, sourceX, sourceY, targetX, targetY } = props;

  // unit 13e — measured size of the (shared) node for the self-loop.
  const sourceWidth = useStore((s) => s.nodeLookup.get(source)?.measured?.width ?? 0);
  const sourceHeight = useStore((s) => s.nodeLookup.get(source)?.measured?.height ?? 0);

  // Fallback for edges without dependency data (defensive).
  if (!data?.dependency) {
    const [fallbackPath] = getSmoothStepPath(props);
    return <path d={fallbackPath} strokeWidth={1.5} stroke="#1a1a2e" strokeDasharray={DEPENDENCY_DASH} fill="none" />;
  }

  const arrowId = `uml-${id}-dependency-arrow`;
  const label = data.dependency.name;

  // unit 13e — self-dependency: visible loop; otherwise orthogonal routing.
  const isSelf = source === target;
  const loop = isSelf
    ? getSelfLoopGeometry({ sourceX, sourceY, targetX, targetY, width: sourceWidth, height: sourceHeight })
    : null;
  const [path, labelX, labelY] = loop ? [loop.path, loop.labelX, loop.labelY] : getSmoothStepPath(props);

  return (
    <>
      <defs>
        {/* Open V-shaped arrowhead for dependency (UML 2.5.1): two strokes
            meeting at the tip, fill NONE so the arrow stays open — the
            distinguishing feature versus the realization triangle. */}
        <marker
          id={arrowId}
          markerWidth="12"
          markerHeight="12"
          refX="11"
          refY="6"
          orient="auto"
          markerUnits="userSpaceOnUse"
        >
          <path d="M 0 0 L 11 6 L 0 12" fill="none" stroke="#1a1a2e" strokeWidth="1.5" />
        </marker>
      </defs>

      <BaseEdge
        path={path}
        markerEnd={`url(#${arrowId})`}
        strokeWidth={1.5}
        stroke="#1a1a2e"
        strokeDasharray={DEPENDENCY_DASH}
      />

      {/* Optional editable label (unit 13c) centered on the edge (self-loop:
          centered on the loop's top run). */}
      {label ? (
        <text
          x={labelX}
          y={labelY - 8}
          dominantBaseline="middle"
          textAnchor="middle"
          fontSize="10"
          fill="#333"
          paintOrder="stroke"
          stroke="white"
          strokeWidth="3"
        >
          {label}
        </text>
      ) : null}
    </>
  );
}
