/**
 * Arista de extremo miembro de una asociación n-aria UML 2.5.1 (unidad 13.2): una línea
 * sólida continua desde el nodo diamante central hacia una clase miembro, etiquetada
 * con la multiplicidad de dicho extremo (y su nombre de rol opcional).
 *
 * No se usan marcadores en esta arista (los extremos miembros n-arios son líneas
 * continuas sin dirección en la notación UML) — y según la lección del PR 10, cualquier
 * referencia a marcador permanece como una cadena `url(#id)`, nunca un objeto MarkerType.
 */
import { type EdgeProps, getSmoothStepPath, BaseEdge } from '@xyflow/react';

import type { NaryMemberEnd } from '@app/core';

export interface NaryEndEdgeData {
  end: NaryMemberEnd;
  naryAssociationId: string;
}

export function NaryEndEdge(props: EdgeProps<NaryEndEdgeData>) {
  const { data, sourceX, sourceY, targetX, targetY } = props;

  // unidad 13e — enrutamiento ortogonal estilo EA (diamante → clase miembro).
  const [path, labelX, labelY] = getSmoothStepPath(props);

  // Respaldo para aristas sin datos de extremo (defensivo).
  if (!data?.end) {
    return <path d={path} strokeWidth={1.5} stroke="#1a1a2e" fill="none" />;
  }

  const cx = labelX ?? (sourceX + targetX) / 2;
  const cy = labelY ?? (sourceY + targetY) / 2;

  return (
    <>
      <BaseEdge path={path} strokeWidth={1.5} stroke="#1a1a2e" />

      {/* Etiqueta de multiplicidad por extremo (escenario editor:R N-aria "cada extremo
          almacena su propia multiplicidad"). */}
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

      {/* Nombre de rol opcional, justo debajo de la multiplicidad. */}
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
