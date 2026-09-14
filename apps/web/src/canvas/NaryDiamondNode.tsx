/**
 * Nodo de rombo central para una asociación n-aria UML 2.5.1 (unidad 13.2).
 *
 * El nodo NO es arrastrado por el usuario: DiagramCanvas lo posiciona en el
 * centroide de sus clases miembro y recalcula esa posición cada vez que
 * el modelo cambia (draggable: false). Hacer clic derecho en el rombo abre
 * el menú contextual cuya única acción elimina toda la asociación n-aria
 * mediante un delta `delete` de naryAssociation (editor:R N-ary, unidad 13.3).
 *
 * El rombo se dibuja como una ruta SVG en línea (mismo lenguaje visual que los
 * rombos de agregación de asociación en AssociationEdge). No se necesitan defs de marcadores
 * aquí — y según la lección de PR 10, cualquier referencia a marcadores en otro lugar
 * permanece como cadenas `url(#id)`, nunca objetos MarkerType.
 */
import { useState } from 'react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';

import type { NaryAssociation } from '@app/core';

export type NaryDiamondNodeData = Record<string, unknown> & {
  nary: NaryAssociation;
  /** Emite un delta de eliminación de naryAssociation para esta asociación. */
  onDelete: () => void;
};

export type NaryDiamondFlowNode = Node<NaryDiamondNodeData, 'naryDiamond'>;

/** Tamaño del recuadro del rombo (px). La ruta SVG se dibuja dentro de este recuadro. */
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
        // editor:R N-aria (unidad 13.3) — clic derecho abre el menú de eliminación;
        // el menú del navegador se suprime.
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
      {/* Handle de origen único: cada arista de extremo miembro se dibuja rombo → clase. */}
      <Handle type="source" position={Position.Top} />
    </div>
  );
}
