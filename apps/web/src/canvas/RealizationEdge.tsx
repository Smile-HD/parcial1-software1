/**
 * Custom edge component for UML realization edges: a DASHED line with a
 * hollow triangle arrowhead pointing toward the supplier interface
 * (UML 2.5.1 realization notation).
 *
 * The edge is drawn source = clientClass → target = supplierInterface, so
 * the triangle marker sits on marker-end. Markers are referenced as
 * `url(#id)` strings — NOT MarkerType objects (PR 10 lesson, applied by
 * PR 11's GeneralizationEdge: React Flow serializes marker objects into
 * attributes the browser cannot resolve for custom SVG defs).
 */
import { type EdgeProps, getBezierPath, BaseEdge } from '@xyflow/react';

import type { Realization } from '@app/core';

interface RealizationEdgeData {
  realization: Realization;
}

/** Dashed stroke per UML realization notation (client → interface). */
const REALIZATION_DASH = '6 4';

export function RealizationEdge(props: EdgeProps<RealizationEdgeData>) {
  const { id, data } = props;

  // Fallback for edges without realization data (defensive).
  if (!data?.realization) {
    const [fallbackPath] = getBezierPath(props);
    return <path d={fallbackPath} strokeWidth={1.5} stroke="#1a1a2e" strokeDasharray={REALIZATION_DASH} fill="none" />;
  }

  const triangleId = `uml-${id}-realization-triangle`;

  // v12 returns a [path, labelX, labelY] tuple — the label coords center the
  // editable edge name (unit 13c) on the bezier path.
  const [path, labelX, labelY] = getBezierPath(props);
  const label = data.realization.name;

  return (
    <>
      <defs>
        {/* Hollow triangle for realization (same arrowhead shape as
            generalization; the dashed line is what distinguishes it).
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
        strokeDasharray={REALIZATION_DASH}
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
