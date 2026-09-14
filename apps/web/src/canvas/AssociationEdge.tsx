/**
 * Componente de arista personalizado para asociaciones UML con rombos de
 * agregación/composición, etiqueta de nombre de asociación y etiquetas de rol en cada extremo.
 *
 * unidad 13e:
 *  - Las aristas no reflexivas se enrutan con getSmoothStepPath (conectores ortogonales
 *    estilo EA) en lugar de getBezierPath. Los marcadores siguen siendo cadenas `url(#id)`
 *    que hacen referencia a defs por arista (lección del PR 10).
 *  - Las autoasociaciones (source === target — asociaciones recursivas, válidas desde
 *    13d) renderizan un bucle redondeado visible mediante getSelfLoopPath en lugar de una
 *    curva bezier degenerada/oculta. El bucle se dimensiona a partir de las medidas del nodo,
 *    leídas del almacén de React Flow (EdgeProps de v12 no las incluye), con un valor
 *    por defecto antes de la medición.
 */
import { type EdgeProps, getSmoothStepPath, useStore, BaseEdge } from '@xyflow/react';

import type { Association } from '@app/core';

import { getSelfLoopGeometry } from './selfLoop';

interface AssociationEdgeData {
  association: Association;
}

export function AssociationEdge(props: EdgeProps<AssociationEdgeData>) {
  const { data, id, source, target, sourceX, sourceY, targetX, targetY } = props;

  // unidad 13e — tamaño medido del nodo (compartido) para el bucle reflexivo.
  // Los selectores primitivos mantienen useStore estable (sin cambios de identidad de objetos).
  const sourceWidth = useStore((s) => s.nodeLookup.get(source)?.measured?.width ?? 0);
  const sourceHeight = useStore((s) => s.nodeLookup.get(source)?.measured?.height ?? 0);

  const association = data?.association;

  // Fallback para aristas sin datos de asociación (compatibilidad hacia atrás)
  if (!association) {
    const [fallbackPath] = getSmoothStepPath(props);
    return <path d={fallbackPath} strokeWidth={1.5} stroke="#1a1a2e" fill="none" />;
  }

  const isSelf = source === target;

  const isComposite = association.aggregation === 'composite';
  const isShared = association.aggregation === 'shared';
  // El extremo del rombo ahora se declara explícitamente mediante aggregationEnd ('source' o 'target'),
  // no se deduce de las multiplicidades (conformidad con UML 2.5.1).
  const diamondEnd = association.aggregationEnd;

  // IDs de marcador únicos por arista
  const compositeDiamondId = `uml-${id}-composite-diamond`;
  const sharedDiamondId = `uml-${id}-shared-diamond`;
  const arrowId = `uml-${id}-arrow`;

  // Determinar el marcador para el extremo del todo (rombo)
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

  // Añadir flecha para asociaciones dirigidas
  // SVG solo permite un marcador por extremo; si el rombo ya ocupa markerEnd, se suprime la flecha
  if (association.directed) {
    if (diamondEnd === 'target' && (isComposite || isShared)) {
      // Rombo en el extremo destino -> sin espacio para la flecha (compromiso documentado)
      markerStart = markerStart ?? `url(#${arrowId})`;
    } else {
      markerEnd = markerEnd ?? `url(#${arrowId})`;
    }
  }

  // Multiplicidades: solo se dibujan los extremos DEFINIDOS (corrección C de unidad 13d — sin
  // '1' fantasma). unidad 13e — ubicación estilo EA: cada extremo lleva su propia multiplicidad (y
  // el rol debajo); el nombre de la asociación se centra en el conector. Si no hay nada definido
  // no se muestra ninguna etiqueta.
  const sourceMult = association.sourceMultiplicity;
  const targetMult = association.targetMultiplicity;
  const sourceRole = association.sourceRole;
  const targetRole = association.targetRole;

  // unidad 13e — generador de ruta: bucle redondeado visible para autoaristas, enrutamiento
  // ortogonal estilo EA para todo lo demás.
  const loop = isSelf
    ? getSelfLoopGeometry({ sourceX, sourceY, targetX, targetY, width: sourceWidth, height: sourceHeight })
    : null;
  const [path] = loop ? [loop.path] : getSmoothStepPath(props);

  // Anclajes de etiquetas: en el arco para autoaristas (13e.7: tramo de salida a la izquierda del
  // centro superior, tramo de retorno a la derecha — para que la etiqueta origen quede a la
  // IZQUIERDA de su tramo y la etiqueta destino a la DERECHA); desplazamientos de punto medio / por extremo
  // a lo largo de la cuerda para aristas regulares (geometría sin cambios desde 13d).
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
      {/* Marcadores personalizados para rombos y flecha - siempre renderizados para que los defs existan en el SVG de la arista */}
      <defs>
        {/* Rombo relleno para agregación compuesta (rombo de 4 puntos) */}
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
        {/* Rombo hueco para agregación compartida (rombo de 4 puntos) */}
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
        {/* Flecha triangular rellena para asociaciones dirigidas */}
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

      {/* La línea de arista base usando BaseEdge que maneja los marcadores correctamente */}
      <BaseEdge
        path={path}
        markerStart={markerStart}
        markerEnd={markerEnd}
        strokeWidth={1.5}
        stroke="#1a1a2e"
      />

      {/* unidad 13e — etiquetas estilo EA: el nombre de la asociación centrado en el
          conector (en el tramo superior del bucle para autoaristas), la multiplicidad
          de cada extremo al lado y el rol justo debajo. Solo se dibujan las
          multiplicidades DEFINIDAS (corrección C de unidad 13d). */}
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
