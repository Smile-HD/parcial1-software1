/**
 * Componente de arista personalizado para aristas de realización UML: una línea DISCONTINUA con una
 * punta de flecha de triángulo hueco apuntando hacia la interfaz proveedora
 * (notación de realización UML 2.5.1).
 *
 * La arista se dibuja origen = clientClass → destino = supplierInterface, por lo que
 * el marcador de triángulo se ubica en marker-end. Los marcadores se referencian como
 * cadenas `url(#id)` — NO objetos MarkerType (lección del PR 10, aplicada por
 * GeneralizationEdge del PR 11: React Flow serializa objetos de marcador en
 * atributos que el navegador no puede resolver para definiciones SVG personalizadas).
 */
import { type EdgeProps, BaseEdge } from '@xyflow/react';

import type { Realization } from '@app/core';

import { useOrthogonalPathWithJumps } from './EdgeCrossingContext';

interface RealizationEdgeData {
  realization: Realization;
}

/** Trazo discontinuo según la notación de realización UML (cliente → interfaz). */
const REALIZATION_DASH = '6 4';

export function RealizationEdge(props: EdgeProps<RealizationEdgeData>) {
  const { id, data } = props;

  // unidad 13e — enrutamiento ortogonal estilo EA con saltos de puente en intersecciones;
  // las coordenadas de etiqueta de la tupla centran el nombre editable de la arista (unidad 13c) sobre el conector.
  const [path, labelX, labelY] = useOrthogonalPathWithJumps(id, props);

  // Respaldo para aristas sin datos de realización (defensivo).
  if (!data?.realization) {
    return <path d={path} strokeWidth={1.5} stroke="#1a1a2e" strokeDasharray={REALIZATION_DASH} fill="none" />;
  }

  const triangleId = `uml-${id}-realization-triangle`;
  const label = data.realization.name;

  return (
    <>
      <defs>
        {/* Triángulo hueco para realización (misma forma de punta de flecha que
            generalización; la línea discontinua es lo que la distingue).
            Relleno blanco para que la línea no se trasluzca; trazo oscuro. */}
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

      {/* Etiqueta editable opcional (unidad 13c) centrada en la arista. */}
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
