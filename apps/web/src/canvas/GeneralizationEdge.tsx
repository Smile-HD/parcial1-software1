/**
 * Componente de arista personalizado para generalización UML (herencia):
 * una línea continua con una punta de flecha triangular hueca apuntando hacia la
 * superClass (notación de generalización de UML 2.5.1).
 *
 * La arista se dibuja origen = subClass → destino = superClass, por lo que el
 * marcador triangular se ubica en marker-end. Los marcadores se referencian como
 * cadenas `url(#id)` — NO objetos MarkerType (lección del PR 10: React Flow
 * serializa los objetos de marcador en atributos que el navegador no puede resolver
 * para defs SVG personalizados).
 */
import { type EdgeProps, BaseEdge } from '@xyflow/react';

import type { Generalization } from '@app/core';

import { useOrthogonalPathWithJumps } from './EdgeCrossingContext';

interface GeneralizationEdgeData {
  generalization: Generalization;
}

export function GeneralizationEdge(props: EdgeProps<GeneralizationEdgeData>) {
  const { id, data } = props;

  // unidad 13e — enrutamiento ortogonal estilo EA con saltos de puente en intersecciones;
  // las coordenadas de etiqueta de la tupla centran el nombre editable de la arista en el conector.
  const [path, labelX, labelY] = useOrthogonalPathWithJumps(id, props);

  // Fallback para aristas sin datos de generalización (defensivo).
  if (!data?.generalization) {
    return <path d={path} strokeWidth={1.5} stroke="#1a1a2e" fill="none" />;
  }

  const triangleId = `uml-${id}-generalization-triangle`;
  const label = data.generalization.name;

  return (
    <>
      <defs>
        {/* Triángulo hueco para generalización (punta de flecha de herencia UML).
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
