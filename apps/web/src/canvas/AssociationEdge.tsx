/**
 * Custom edge component for UML associations with aggregation/composition
 * diamonds, association name label, and role labels at each end.
 *
 * unit 13e:
 *  - Non-self edges route with getSmoothStepPath (EA-style orthogonal
 *    connectors) instead of getBezierPath. Markers stay `url(#id)` strings
 *    referencing per-edge defs (PR 10 lesson).
 *  - Self-edges (source === target — recursive associations, valid since
 *    13d) render a visible rounded loop via getSelfLoopPath instead of a
 *    degenerate/hidden bezier. The loop is sized from the node's measured
 *    dimensions, read from the React Flow store (v12 EdgeProps does not
 *    carry them), with a default-box fallback before measurement.
 */
import { type EdgeProps, getSmoothStepPath, useStore, BaseEdge } from '@xyflow/react';

import type { Association } from '@app/core';

import { getSelfLoopGeometry } from './selfLoop';

interface AssociationEdgeData {
  association: Association;
}

export function AssociationEdge(props: EdgeProps<AssociationEdgeData>) {
  const { data, id, source, target, sourceX, sourceY, targetX, targetY } = props;

  // unit 13e — measured size of the (shared) node for the self-loop.
  // Primitive selectors keep useStore stable (no object identity churn).
  const sourceWidth = useStore((s) => s.nodeLookup.get(source)?.measured?.width ?? 0);
  const sourceHeight = useStore((s) => s.nodeLookup.get(source)?.measured?.height ?? 0);

  const association = data?.association;

  // Fallback for edges without association data (backward compat)
  if (!association) {
    const [fallbackPath] = getSmoothStepPath(props);
    return <path d={fallbackPath} strokeWidth={1.5} stroke="#1a1a2e" fill="none" />;
  }

  const isSelf = source === target;

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

  // Multiplicities: only DEFINED ends are drawn (unit 13d fix C — no phantom
  // '1'). unit 13e — EA placement: each end carries its own multiplicity (and
  // role below it); the association name is centered on the connector. With
  // nothing set there is no label at all.
  const sourceMult = association.sourceMultiplicity;
  const targetMult = association.targetMultiplicity;
  const sourceRole = association.sourceRole;
  const targetRole = association.targetRole;

  // unit 13e — path generator: visible rounded loop for self-edges, EA-style
  // orthogonal routing for everything else.
  const loop = isSelf
    ? getSelfLoopGeometry({ sourceX, sourceY, targetX, targetY, width: sourceWidth, height: sourceHeight })
    : null;
  const [path] = loop ? [loop.path] : getSmoothStepPath(props);

  // Label anchors: on the arch for self-edges (13e.7: exit stub left of
  // top-center, return stub right of it — so the source label sits to the
  // LEFT of its run and the target label to the RIGHT); midpoint / per-end
  // offsets along the chord for regular edges (unchanged geometry from 13d).
  const cx = (sourceX + targetX) / 2;
  const cy = (sourceY + targetY) / 2;
  const dx = targetX - sourceX;
  const dy = targetY - sourceY;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const offset = 20;
  const nameX = loop ? loop.labelX : cx;
  const nameY = loop ? loop.labelY : cy - 8;
  const srcX = loop ? loop.sourceLabelX : sourceX + ux * offset;
  const srcY = loop ? loop.sourceLabelY : sourceY + uy * offset - 8;
  const tgtX = loop ? loop.targetLabelX : targetX - ux * offset;
  const tgtY = loop ? loop.targetLabelY : targetY - uy * offset - 8;
  const srcAnchor: 'start' | 'end' = loop ? 'end' : 'middle';
  const tgtAnchor: 'start' | 'end' = loop ? 'start' : 'middle';

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

      {/* unit 13e — EA-style labels: the association name centered on the
          connector (on the loop's top run for self-edges), each end's
          multiplicity beside it and the role just below. Only DEFINED
          multiplicities are drawn (unit 13d fix C). */}
      {association.name && (
        <text
          x={nameX}
          y={nameY}
          dominantBaseline="middle"
          textAnchor="middle"
          fontSize="10"
          fill="#333"
          paintOrder="stroke"
          stroke="white"
          strokeWidth="3"
        >
          {association.name}
        </text>
      )}
      {sourceMult !== undefined && (
        <text
          x={srcX}
          y={sourceRole ? srcY - 6 : srcY}
          dominantBaseline="middle"
          textAnchor={srcAnchor}
          fontSize="10"
          fill="#333"
          paintOrder="stroke"
          stroke="white"
          strokeWidth="3"
        >
          {sourceMult}
        </text>
      )}
      {sourceRole && (
        <text
          x={srcX}
          y={sourceMult !== undefined ? srcY + 8 : srcY}
          dominantBaseline="middle"
          textAnchor={srcAnchor}
          fontSize="9"
          fill="#555"
          fontStyle="italic"
          paintOrder="stroke"
          stroke="white"
          strokeWidth="3"
        >
          {sourceRole}
        </text>
      )}
      {targetMult !== undefined && (
        <text
          x={tgtX}
          y={targetRole ? tgtY - 6 : tgtY}
          dominantBaseline="middle"
          textAnchor={tgtAnchor}
          fontSize="10"
          fill="#333"
          paintOrder="stroke"
          stroke="white"
          strokeWidth="3"
        >
          {targetMult}
        </text>
      )}
      {targetRole && (
        <text
          x={tgtX}
          y={targetMult !== undefined ? tgtY + 8 : tgtY}
          dominantBaseline="middle"
          textAnchor={tgtAnchor}
          fontSize="9"
          fill="#555"
          fontStyle="italic"
          paintOrder="stroke"
          stroke="white"
          strokeWidth="3"
        >
          {targetRole}
        </text>
      )}
    </>
  );
}
