/**
 * Componente de arista personalizado para dependencias UML: una línea DISCONTINUA con una
 * punta de flecha ABIERTA (sin relleno, en forma de V) apuntando hacia el proveedor
 * (notación de dependencia de UML 2.5.1). A diferencia de la realización, el proveedor puede
 * ser cualquier clase o interfaz y no hay etiqueta de multiplicidad.
 *
 * La arista se dibuja origen = clientClass → destino = supplierClass, por lo que
 * el marcador de flecha se ubica en marker-end. Los marcadores se referencian como
 * cadenas `url(#id)` — NO objetos MarkerType (lección del PR 10, aplicada por
 * GeneralizationEdge de PR 11 y RealizationEdge de PR 12a: React Flow
 * serializa los objetos de marcador en atributos que el navegador no puede resolver
 * para defs SVG personalizados).
 *
 * unidad 13e: las aristas no reflexivas se enrutan ortogonalmente (getSmoothStepPath, conector
 * por defecto de EA); las autodependencias (client === supplier, válidas desde
 * 13d) renderizan un bucle redondeado visible mediante getSelfLoopPath — dimensionado a partir
 * de las medidas del nodo leídas del almacén de React Flow — para que la punta de flecha
 * abierta retorne al nodo en lugar de ocultarse tras él.
 */
import { type EdgeProps, useStore, BaseEdge } from '@xyflow/react';

import type { Dependency } from '@app/core';

import { getSelfLoopGeometry } from './selfLoop';
import { useOrthogonalPathWithJumps } from './EdgeCrossingContext';

interface DependencyEdgeData {
  dependency: Dependency;
}

/** Trazo discontinuo según la notación de dependencia UML (cliente → proveedor). */
const DEPENDENCY_DASH = '6 4';

export function DependencyEdge(props: EdgeProps<DependencyEdgeData>) {
  const { id, data, source, target, sourceX, sourceY, targetX, targetY } = props;

  // unidad 13e — tamaño medido del nodo (compartido) para el bucle reflexivo.
  const sourceWidth = useStore((s) => s.nodeLookup.get(source)?.measured?.width ?? 0);
  const sourceHeight = useStore((s) => s.nodeLookup.get(source)?.measured?.height ?? 0);

  // Ruta ortogonal con saltos de puente en cruces (estilo Enterprise Architect)
  const [smoothPath, smoothLabelX, smoothLabelY] = useOrthogonalPathWithJumps(id, props);

  // Fallback para aristas sin datos de dependencia (defensivo).
  if (!data?.dependency) {
    return <path d={smoothPath} strokeWidth={1.5} stroke="#1a1a2e" strokeDasharray={DEPENDENCY_DASH} fill="none" />;
  }

  const arrowId = `uml-${id}-dependency-arrow`;
  const label = data.dependency.name;

  // unidad 13e — autodependencia: bucle visible; de lo contrario enrutamiento ortogonal con saltos.
  const isSelf = source === target;
  const loop = isSelf
    ? getSelfLoopGeometry({ sourceX, sourceY, targetX, targetY, width: sourceWidth, height: sourceHeight })
    : null;
  const [path, labelX, labelY] = loop ? [loop.path, loop.labelX, loop.labelY] : [smoothPath, smoothLabelX, smoothLabelY];

  return (
    <>
      <defs>
        {/* Punta de flecha abierta en V para dependencia (UML 2.5.1): dos trazos
            que se unen en la punta, relleno NONE para que la flecha permanezca abierta — el
            rasgo distintivo frente al triángulo de realización. */}
        <marker
          id={arrowId}
          markerWidth="12"
          markerHeight="12"
          refX="11"
          refY="6"
          orient="auto"
          markerUnits="userSpaceOnUse"
        >
          <path d="M 0 0 L 11 6 L 0 12" fill="none" stroke="#1a1a2e" strokeWidth="1.5" />
        </marker>
      </defs>

      <BaseEdge
        path={path}
        markerEnd={`url(#${arrowId})`}
        strokeWidth={1.5}
        stroke="#1a1a2e"
        strokeDasharray={DEPENDENCY_DASH}
      />

      {/* Etiqueta editable opcional (unidad 13c) centrada en la arista (bucle reflexivo:
          centrada en el tramo superior del bucle). */}
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
