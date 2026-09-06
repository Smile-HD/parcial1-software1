/**
 * Central diamond node for a UML 2.5.1 n-ary association (unit 13.2).
 *
 * The node is NOT user-dragged: DiagramCanvas positions it at the
 * centroid of its member classes and re-derives that position whenever
 * the model changes (draggable: false). Right-clicking the diamond opens
 * the context menu whose only action deletes the whole n-ary association
 * through an naryAssociation `delete` delta (editor:R N-ary, unit 13.3).
 *
 * The diamond is drawn as an inline SVG path (same visual language as the
 * association aggregation diamonds in AssociationEdge). No marker defs are
 * needed here — and per the PR 10 lesson, any marker references elsewhere
 * stay `url(#id)` strings, never MarkerType objects.
 */
import { useState } from 'react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';

import type { NaryAssociation } from '@app/core';

export type NaryDiamondNodeData = Record<string, unknown> & {
  nary: NaryAssociation;
  /** Emit an naryAssociation delete delta for this association. */
  onDelete: () => void;
};

export type NaryDiamondFlowNode = Node<NaryDiamondNodeData, 'naryDiamond'>;

/** Diamond box size (px). The SVG path is drawn inside this box. */
export const NARY_DIAMOND_SIZE = 44;

export function NaryDiamondNode({ data }: NodeProps<NaryDiamondFlowNode>) {
  const [menuOpen, setMenuOpen] = useState(false);
  const half = NARY_DIAMOND_SIZE / 2;
  const d = `M ${half} 2 L ${NARY_DIAMOND_SIZE - 2} ${half} L ${half} ${NARY_DIAMOND_SIZE - 2} L 2 ${half} Z`;

  return (
    <div
      className="uml-nary-diamond"
      data-nary-id={data.nary.id}
      data-testid={`nary-diamond-${data.nary.id}`}
      style={{ width: NARY_DIAMOND_SIZE, height: NARY_DIAMOND_SIZE }}
      onContextMenu={(event) => {
        // editor:R N-ary (unit 13.3) — right-click opens the delete menu;
        // the browser menu is suppressed.
        event.preventDefault();
        setMenuOpen(true);
      }}
    >
      {menuOpen && (
        <div className="uml-nary-diamond__context-menu" role="menu" data-testid="nary-context-menu">
          <button
            type="button"
            role="menuitem"
            aria-label={`Delete n-ary association ${data.nary.id}`}
            onClick={(event) => {
              event.stopPropagation();
              data.onDelete();
              setMenuOpen(false);
            }}
          >
            Delete n-ary association
          </button>
          <button
            type="button"
            aria-label="Close context menu"
            onClick={(event) => {
              event.stopPropagation();
              setMenuOpen(false);
            }}
          >
            Close
          </button>
        </div>
      )}
      <svg
        className="uml-nary-diamond__svg"
        width={NARY_DIAMOND_SIZE}
        height={NARY_DIAMOND_SIZE}
        viewBox={`0 0 ${NARY_DIAMOND_SIZE} ${NARY_DIAMOND_SIZE}`}
      >
        <path d={d} fill="#ffffff" stroke="#1a1a2e" strokeWidth={2} />
        {data.nary.name !== undefined && (
          <text x={half} y={half + 3} textAnchor="middle" fontSize="8" fill="#1a1a2e">
            {data.nary.name}
          </text>
        )}
      </svg>
      {/* Single source handle: every member-end edge is drawn diamond → class. */}
      <Handle type="source" position={Position.Top} />
    </div>
  );
}
