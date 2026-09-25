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
import { useState } from 'react';
import { type EdgeProps, useStore, BaseEdge, Position, EdgeLabelRenderer } from '@xyflow/react';

import type { Association } from '@app/core';

import { getSelfLoopGeometry } from './selfLoop';
import { useOrthogonalPathWithJumps } from './EdgeCrossingContext';

interface AssociationEdgeData {
  association: Association;
  onUpdateMultiplicity?: (end: 'source' | 'target', value: string) => void;
}

export function AssociationEdge(props: EdgeProps<AssociationEdgeData>) {
  const {
    data,
    id,
    source,
    target,
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  } = props;

  // unidad 13e — tamaño medido del nodo (compartido) para el bucle reflexivo.
  // Los selectores primitivos mantienen useStore estable (sin cambios de identidad de objetos).
  const sourceWidth = useStore((s) => s.nodeLookup.get(source)?.measured?.width ?? 0);
  const sourceHeight = useStore((s) => s.nodeLookup.get(source)?.measured?.height ?? 0);

  const [activePicker, setActivePicker] = useState<'source' | 'target' | null>(null);
  const [customDraft, setCustomDraft] = useState('');

  const association = data?.association;
  const assocClassId = association?.associationClassId;
  const assocClassNode = useStore((s) => (assocClassId ? s.nodeLookup.get(assocClassId) : undefined));

  // Ruta ortogonal con saltos de puente en cruces (estilo Enterprise Architect)
  const [smoothPath, orthoLabelX, orthoLabelY] = useOrthogonalPathWithJumps(id, props);

  // Fallback para aristas sin datos de asociación (compatibilidad hacia atrás)
  if (!association) {
    return <path d={smoothPath} strokeWidth={1.5} stroke="#1a1a2e" fill="none" />;
  }

  let assocDashedPath: string | null = null;
  if (assocClassNode) {
    const nodePos = (assocClassNode as any).internals?.positionAbsolute ?? assocClassNode.position ?? { x: 0, y: 0 };
    const nodeW = assocClassNode.measured?.width ?? 160;
    const nodeH = assocClassNode.measured?.height ?? 100;
    const [targetBoxX, targetBoxY] = getBoxIntersection(
      nodePos.x,
      nodePos.y,
      nodeW,
      nodeH,
      orthoLabelX,
      orthoLabelY,
    );
    assocDashedPath = `M ${orthoLabelX} ${orthoLabelY} L ${targetBoxX} ${targetBoxY}`;
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
  const [path] = loop ? [loop.path] : [smoothPath];

  // Anclajes de etiquetas: en el arco para autoaristas; para aristas regulares
  // se orientan a lo largo del tramo ortogonal de salida/llegada según sourcePosition y targetPosition,
  // impidiendo que queden tapadas bajo la caja del nodo o sobrepuestas al marcador.
  const nameX = loop ? loop.labelX : orthoLabelX;
  const nameY = loop ? loop.labelY : orthoLabelY - 8;

  let srcX: number;
  let srcY: number;
  let tgtX: number;
  let tgtY: number;
  let srcAnchor: 'start' | 'end' | 'middle';
  let tgtAnchor: 'start' | 'end' | 'middle';

  if (loop) {
    srcX = loop.sourceLabelX;
    srcY = loop.sourceLabelY;
    tgtX = loop.targetLabelX;
    tgtY = loop.targetLabelY;
    srcAnchor = 'end';
    tgtAnchor = 'start';
  } else {
    const dist = 28; // Distancia a lo largo del conector para librar rombos/flechas
    const lateral = 12; // Desplazamiento lateral perpendicular para no pisar la línea

    // Extremo origen: la línea sale del nodo según sourcePosition
    switch (sourcePosition) {
      case Position.Right:
        srcX = sourceX + dist;
        srcY = sourceY - lateral;
        srcAnchor = 'start';
        break;
      case Position.Left:
        srcX = sourceX - dist;
        srcY = sourceY - lateral;
        srcAnchor = 'end';
        break;
      case Position.Bottom:
        srcX = sourceX + lateral;
        srcY = sourceY + dist;
        srcAnchor = 'start';
        break;
      case Position.Top:
        srcX = sourceX + lateral;
        srcY = sourceY - dist;
        srcAnchor = 'start';
        break;
      default: {
        const dx = targetX - sourceX;
        const dy = targetY - sourceY;
        const len = Math.hypot(dx, dy) || 1;
        srcX = sourceX + (dx / len) * dist;
        srcY = sourceY + (dy / len) * dist - 8;
        srcAnchor = 'middle';
        break;
      }
    }

    // Extremo destino: la línea llega al nodo según targetPosition
    switch (targetPosition) {
      case Position.Left:
        tgtX = targetX - dist;
        tgtY = targetY - lateral;
        tgtAnchor = 'end';
        break;
      case Position.Right:
        tgtX = targetX + dist;
        tgtY = targetY - lateral;
        tgtAnchor = 'start';
        break;
      case Position.Top:
        tgtX = targetX + lateral;
        tgtY = targetY - dist;
        tgtAnchor = 'start';
        break;
      case Position.Bottom:
        tgtX = targetX + lateral;
        tgtY = targetY + dist;
        tgtAnchor = 'start';
        break;
      default: {
        const dx = targetX - sourceX;
        const dy = targetY - sourceY;
        const len = Math.hypot(dx, dy) || 1;
        tgtX = targetX - (dx / len) * dist;
        tgtY = targetY - (dy / len) * dist - 8;
        tgtAnchor = 'middle';
        break;
      }
    }
  }

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

      {/* Línea punteada hacia la clase de asociación intermedia (UML 2.5.1) */}
      {assocDashedPath && (
        <path
          d={assocDashedPath}
          stroke="#475569"
          strokeWidth={1.5}
          strokeDasharray="4,4"
          fill="none"
          data-testid={`assoc-class-dashed-${id}`}
        />
      )}

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

      {/* unidad 13f — StarUML style inline multiplicity editor right on the edge (no modal needed) */}
      {data?.onUpdateMultiplicity && (
        <EdgeLabelRenderer>
          {/* Source Multiplicity Badge */}
          <div
            className="nodrag nopan staruml-mult-badge"
            data-testid={`staruml-mult-source-${id}`}
            style={{
              position: 'absolute',
              transform: `translate(-50%, -50%) translate(${srcX}px, ${sourceRole ? srcY - 6 : srcY}px)`,
              pointerEvents: 'all',
            }}
            onMouseDown={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              setActivePicker((prev) => (prev === 'source' ? null : 'source'));
              setCustomDraft(sourceMult ?? '');
            }}
            title="Click to change multiplicity (StarUML)"
          >
            {sourceMult ?? <span className="staruml-mult-badge__placeholder">+</span>}
          </div>

          {/* Target Multiplicity Badge */}
          <div
            className="nodrag nopan staruml-mult-badge"
            data-testid={`staruml-mult-target-${id}`}
            style={{
              position: 'absolute',
              transform: `translate(-50%, -50%) translate(${tgtX}px, ${targetRole ? tgtY - 6 : tgtY}px)`,
              pointerEvents: 'all',
            }}
            onMouseDown={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              setActivePicker((prev) => (prev === 'target' ? null : 'target'));
              setCustomDraft(targetMult ?? '');
            }}
            title="Click to change multiplicity (StarUML)"
          >
            {targetMult ?? <span className="staruml-mult-badge__placeholder">+</span>}
          </div>

          {/* StarUML Quick-Picker Popover */}
          {activePicker !== null && (
            <div
              className="nodrag nopan staruml-mult-picker"
              data-testid="staruml-mult-picker"
              style={{
                position: 'absolute',
                transform: `translate(-50%, -100%) translate(${
                  activePicker === 'source' ? srcX : tgtX
                }px, ${(activePicker === 'source' ? (sourceRole ? srcY - 6 : srcY) : (targetRole ? tgtY - 6 : tgtY)) - 10}px)`,
                pointerEvents: 'all',
                zIndex: 100,
              }}
              onMouseDown={(e) => e.stopPropagation()}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="staruml-mult-picker__presets">
                {['1', '0..1', '*', '0..*', '1..*'].map((val) => (
                  <button
                    key={val}
                    type="button"
                    className="staruml-mult-picker__preset"
                    onClick={() => {
                      data.onUpdateMultiplicity?.(activePicker, val);
                      setActivePicker(null);
                    }}
                  >
                    {val}
                  </button>
                ))}
                <button
                  type="button"
                  className="staruml-mult-picker__preset staruml-mult-picker__preset--clear"
                  title="Clear multiplicity"
                  onClick={() => {
                    data.onUpdateMultiplicity?.(activePicker, '');
                    setActivePicker(null);
                  }}
                >
                  ✕
                </button>
              </div>
              <form
                className="staruml-mult-picker__custom"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (customDraft.trim()) {
                    data.onUpdateMultiplicity?.(activePicker, customDraft.trim());
                  }
                  setActivePicker(null);
                }}
              >
                <input
                  type="text"
                  className="staruml-mult-picker__input"
                  value={customDraft}
                  onChange={(e) => setCustomDraft(e.target.value)}
                  placeholder="Custom…"
                  autoFocus
                />
                <button type="submit" className="staruml-mult-picker__submit">✓</button>
              </form>
            </div>
          )}
        </EdgeLabelRenderer>
      )}
    </>
  );
}

/**
 * Computes the intersection of a ray from a rectangle's center towards (fromX, fromY)
 * with the rectangle boundary.
 */
export function getBoxIntersection(
  boxX: number,
  boxY: number,
  boxW: number,
  boxH: number,
  fromX: number,
  fromY: number,
): [number, number] {
  const cx = boxX + boxW / 2;
  const cy = boxY + boxH / 2;
  const dx = fromX - cx;
  const dy = fromY - cy;
  if (dx === 0 && dy === 0) return [cx, cy];

  const hw = boxW / 2;
  const hh = boxH / 2;
  const absDx = Math.abs(dx);
  const absDy = Math.abs(dy);

  if (absDx * hh > absDy * hw) {
    const signX = dx > 0 ? 1 : -1;
    return [cx + signX * hw, cy + (dy / absDx) * hw];
  } else {
    const signY = dy > 0 ? 1 : -1;
    return [cx + (dx / absDy) * hh, cy + signY * hh];
  }
}
