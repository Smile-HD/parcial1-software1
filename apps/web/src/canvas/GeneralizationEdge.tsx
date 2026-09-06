/**
 * Custom edge component for UML generalization (inheritance) edges:
 * a solid line with a hollow triangle arrowhead pointing toward the
 * superClass (UML 2.5.1 generalization notation).
 *
 * The edge is drawn source = subClass → target = superClass, so the
 * triangle marker sits on marker-end. Markers are referenced as
 * `url(#id)` strings — NOT MarkerType objects (PR 10 lesson: React Flow
 * serializes marker objects into attributes the browser cannot resolve
 * for custom SVG defs).
 */
import { type EdgeProps, getBezierPath, BaseEdge } from '@xyflow/react';

import type { Generalization } from '@app/core';

interface GeneralizationEdgeData {
  generalization: Generalization;
}

export function GeneralizationEdge(props: EdgeProps<GeneralizationEdgeData>) {
  const { id, data } = props;

  // Fallback for edges without generalization data (defensive).
  if (!data?.generalization) {
    const [fallbackPath] = getBezierPath(props);
    return <path d={fallbackPath} strokeWidth={1.5} stroke="#1a1a2e" fill="none" />;
  }

  const triangleId = `uml-${id}-generalization-triangle`;

  // v12 returns a [path, labelX, labelY] tuple — the label coords center the
  // editable edge name (unit 13c) on the bezier path.
  const [path, labelX, labelY] = getBezierPath(props);
  const label = data.generalization.name;

  return (
    <>
      <defs>
        {/* Hollow triangle for generalization (UML inheritance arrowhead).
            White fill so the line does not show through; dark stroke. */}
        <marker
          id={triangleId}
          markerWidth="16"
          markerHeight="16"
          refX="15"
          refY="8"
          orient="auto"
          markerUnits="userSpaceOnUse"
        >
          <path d="M 0 16 L 8 0 L 16 16 Z" fill="#ffffff" stroke="#1a1a2e" strokeWidth="2" />
        </marker>
      </defs>

      <BaseEdge
        path={path}
        markerEnd={`url(#${triangleId})`}
        strokeWidth={1.5}
        stroke="#1a1a2e"
      />

      {/* Optional editable label (unit 13c) centered on the edge. */}
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
