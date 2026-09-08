/**
 * Member-end edge of a UML 2.5.1 n-ary association (unit 13.2): a plain
 * solid line from the central diamond node to one member class, labeled
 * with that end's multiplicity (and its optional role name).
 *
 * Markers are not used on this edge (n-ary member ends are undirected
 * plain lines in UML notation) — and per the PR 10 lesson, any marker
 * reference stays a `url(#id)` string, never a MarkerType object.
 */
import { type EdgeProps, getSmoothStepPath, BaseEdge } from '@xyflow/react';

import type { NaryMemberEnd } from '@app/core';

export interface NaryEndEdgeData {
  end: NaryMemberEnd;
  naryAssociationId: string;
}

export function NaryEndEdge(props: EdgeProps<NaryEndEdgeData>) {
  const { data, sourceX, sourceY, targetX, targetY } = props;

  // unit 13e — EA-style orthogonal routing (diamond → member class).
  const [path, labelX, labelY] = getSmoothStepPath(props);

  // Fallback for edges without end data (defensive).
  if (!data?.end) {
    return <path d={path} strokeWidth={1.5} stroke="#1a1a2e" fill="none" />;
  }

  const cx = labelX ?? (sourceX + targetX) / 2;
  const cy = labelY ?? (sourceY + targetY) / 2;

  return (
    <>
      <BaseEdge path={path} strokeWidth={1.5} stroke="#1a1a2e" />

      {/* Per-end multiplicity label (editor:R N-ary scenario "each end
          stores its own multiplicity"). */}
      <text
        x={cx}
        y={cy - 8}
        dominantBaseline="middle"
        textAnchor="middle"
        fontSize="10"
        fill="#333"
        paintOrder="stroke"
        stroke="white"
        strokeWidth="3"
        data-testid={`nary-end-label-${data.end.classId}`}
      >
        {data.end.multiplicity}
      </text>

      {/* Optional role name, just under the multiplicity. */}
      {data.end.role !== undefined && (
        <text
          x={cx}
          y={cy + 6}
          dominantBaseline="middle"
          textAnchor="middle"
          fontSize="9"
          fill="#555"
          fontStyle="italic"
          paintOrder="stroke"
          stroke="white"
          strokeWidth="3"
          data-testid={`nary-end-role-${data.end.classId}`}
        >
          {data.end.role}
        </text>
      )}
    </>
  );
}
