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
 */
import { type EdgeProps, getBezierPath, BaseEdge } from '@xyflow/react';

import type { Dependency } from '@app/core';

interface DependencyEdgeData {
  dependency: Dependency;
}

/** Dashed stroke per UML dependency notation (client → supplier). */
const DEPENDENCY_DASH = '6 4';

export function DependencyEdge(props: EdgeProps<DependencyEdgeData>) {
  const { id, data } = props;

  // Fallback for edges without dependency data (defensive).
  if (!data?.dependency) {
    const [fallbackPath] = getBezierPath(props);
    return <path d={fallbackPath} strokeWidth={1.5} stroke="#1a1a2e" strokeDasharray={DEPENDENCY_DASH} fill="none" />;
  }

  const arrowId = `uml-${id}-dependency-arrow`;

  // v12 returns a [path, labelX, labelY] tuple — take the path string.
  const [path] = getBezierPath(props);

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
    </>
  );
}
