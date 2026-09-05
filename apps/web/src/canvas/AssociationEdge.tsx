/**
 * Custom edge component for UML associations with aggregation/composition diamonds,
 * association name label, and role labels at each end.
 */
import { type EdgeProps, getBezierPath, BaseEdge } from '@xyflow/react';
import { useRef, useEffect } from 'react';

import type { Association } from '@app/core';

interface AssociationEdgeData {
  association: Association;
}

export function AssociationEdge(props: EdgeProps<AssociationEdgeData>) {
  const { data, id, sourceX, sourceY, targetX, targetY } = props;
  const association = data?.association;

  // Fallback for edges without association data (backward compat)
  if (!association) {
    const [fallbackPath] = getBezierPath(props);
    return <path d={fallbackPath} strokeWidth={1.5} stroke="#1a1a2e" fill="none" />;
  }

  const isComposite = association.aggregation === 'composite';
  const isShared = association.aggregation === 'shared';
  // Diamond end is now explicitly declared via aggregationEnd ('source' or 'target'),
  // not guessed from multiplicities (UML 2.5.1 compliance).
  const diamondEnd = association.aggregationEnd;

  // Unique marker IDs per edge
  const compositeDiamondId = `uml-${id}-composite-diamond`;
  const sharedDiamondId = `uml-${id}-shared-diamond`;
  const arrowId = `uml-${id}-arrow`;

  // Determine marker for the whole end (diamond)
  let markerStart: string | undefined;
  let markerEnd: string | undefined;

  if (isComposite || isShared) {
    const diamondId = isComposite ? compositeDiamondId : sharedDiamondId;
    if (diamondEnd === 'source') {
      markerStart = `url(#${diamondId})`;
    } else {
      markerEnd = `url(#${diamondId})`;
    }
  }

  // Add arrow for directed associations
  // SVG only allows one marker per end; if diamond already occupies markerEnd, suppress arrow
  if (association.directed) {
    if (diamondEnd === 'target' && (isComposite || isShared)) {
      // Diamond at target end -> no room for arrow (documented tradeoff)
      markerStart = markerStart ?? `url(#${arrowId})`;
    } else {
      markerEnd = markerEnd ?? `url(#${arrowId})`;
    }
  }

  // Label for association name + multiplicities (centered)
  const centerLabel = association.name
    ? `${association.name} | ${association.sourceMultiplicity} · ${association.targetMultiplicity}`
    : `${association.sourceMultiplicity} · ${association.targetMultiplicity}`;

  // Role labels at ends
  const sourceLabel = association.sourceRole;
  const targetLabel = association.targetRole;

  // Compute center for labels (midpoint of source/target)
  const cx = (sourceX + targetX) / 2;
  const cy = (sourceY + targetY) / 2;

  // Compute source/target label positions (offset from endpoints along edge)
  const dx = targetX - sourceX;
  const dy = targetY - sourceY;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const offset = 20;
  const sourceLx = sourceX + ux * offset;
  const sourceLy = sourceY + uy * offset;
  const targetLx = targetX - ux * offset;
  const targetLy = targetY - uy * offset;

  // v12 returns a [path, labelX, labelY] tuple — take the path string
  const [path] = getBezierPath(props);

  return (
    <>
      {/* Custom markers for diamonds and arrow - always rendered so defs exist in edge SVG */}
      <defs>
        {/* Filled diamond for composite aggregation (4-point diamond) */}
        <marker
          id={compositeDiamondId}
          markerWidth="18"
          markerHeight="18"
          refX="9"
          refY="9"
          orient="auto"
          markerUnits="userSpaceOnUse"
        >
          <path d="M 0 9 L 9 0 L 18 9 L 9 18 Z" fill="#1a1a2e" />
        </marker>
        {/* Hollow diamond for shared aggregation (4-point diamond) */}
        <marker
          id={sharedDiamondId}
          markerWidth="18"
          markerHeight="18"
          refX="9"
          refY="9"
          orient="auto"
          markerUnits="userSpaceOnUse"
        >
          <path d="M 0 9 L 9 0 L 18 9 L 9 18 Z" fill="#ffffff" stroke="#1a1a2e" strokeWidth="2" />
        </marker>
        {/* Filled triangle arrow for directed associations */}
        <marker
          id={arrowId}
          markerWidth="12"
          markerHeight="12"
          refX="11"
          refY="6"
          orient="auto"
          markerUnits="userSpaceOnUse"
        >
          <path d="M 0 0 L 12 6 L 0 12 Z" fill="#1a1a2e" />
        </marker>
      </defs>

      {/* The base edge line using BaseEdge which handles markers correctly */}
      <BaseEdge
        path={path}
        markerStart={markerStart}
        markerEnd={markerEnd}
        strokeWidth={1.5}
        stroke="#1a1a2e"
      />

      {/* Center label (association name + multiplicities) - absolute coordinates */}
      {centerLabel && (
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
        >
          {centerLabel}
        </text>
      )}

      {/* Source role label - absolute coordinates near source */}
      {sourceLabel && (
        <text
          x={sourceLx}
          y={sourceLy - 8}
          dominantBaseline="middle"
          textAnchor="middle"
          fontSize="9"
          fill="#555"
          fontStyle="italic"
          paintOrder="stroke"
          stroke="white"
          strokeWidth="3"
        >
          {sourceLabel}
        </text>
      )}

      {/* Target role label - absolute coordinates near target */}
      {targetLabel && (
        <text
          x={targetLx}
          y={targetLy - 8}
          dominantBaseline="middle"
          textAnchor="middle"
          fontSize="9"
          fill="#555"
          fontStyle="italic"
          paintOrder="stroke"
          stroke="white"
          strokeWidth="3"
        >
          {targetLabel}
        </text>
      )}
    </>
  );
}