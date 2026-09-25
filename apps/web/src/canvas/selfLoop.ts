/**
 * unidad 13e — geometría de bucle autorreferencial para aristas recursivas UML (source === target).
 *
 * El error que esto corrige ("no se ve lo recursivo"): getBezierPath en una arista
 * autorreferencial dibuja una curva que o bien colapsa a un punto (cuando ambos conectores resuelven
 * a las mismas coordenadas) o pasa POR DETRÁS del cuerpo opaco del nodo — React Flow
 * renderiza los nodos por encima de las aristas, por lo que la relación recursiva resulta invisible.
 *
 * La solución (refinamiento 13e.7): un arco redondeado SIMÉTRICO POR ENCIMA del nodo que
 * sale y reingresa en el CENTRO SUPERIOR del nodo — sube desde el borde superior, cruza
 * un arco sobre el nodo y desciende de regreso al borde superior — en lugar del ensanchamiento
 * lateral derecho anterior. Esto refleja cómo Enterprise Architect dibuja asociaciones recursivas.
 * El muñón de salida se ubica a la izquierda del centro y el muñón de retorno a la derecha del centro (una pequeña
 * separación simétrica para que los marcadores de inicio/fin nunca se solapen); el ápice del arco está
 * centrado horizontalmente en el nodo.
 *
 * Dimensionado a partir de las medidas del nodo (React Flow v12 NO las incluye
 * en EdgeProps; los componentes de arista las leen del almacén mediante useStore),
 * con una caja predeterminada razonable cuando el nodo aún no ha sido medido (primer
 * pintado / jsdom). Los conectores se ubican en el centro vertical del nodo (Left =
 * target, Right = source), por lo que el centro X del nodo es el punto medio de los conectores y
 * la parte superior del nodo es `min(sy, ty) - h/2`.
 *
 * La trayectoria usa solo comandos M/L/Q (cada número emitido es un par x,y) para que
 * las pruebas puedan analizar su extensión con exactitud — sin comandos de arco. Seguro ante NaN: cada
 * entrada no finita se sanitiza a 0 y cada dimensión recurre a la
 * caja predeterminada.
 */

/** Caja de nodo predeterminada utilizada cuando React Flow aún no ha medido el nodo. */
export const SELF_LOOP_DEFAULT_WIDTH = 180;
export const SELF_LOOP_DEFAULT_HEIGHT = 120;

/** La mitad de la distancia horizontal entre los muñones de salida y retorno (px). */
export const SELF_LOOP_HALF_SPAN = 24;
/** Separación libre entre la parte superior del nodo y el ápice del arco (px). */
export const SELF_LOOP_LIFT = 40;
/** Radio de las esquinas redondeadas del arco (px). */
export const SELF_LOOP_RADIUS = 12;

export interface SelfLoopInput {
  sourceX: number;
  sourceY: number;
  targetX: number;
  targetY: number;
  /** Ancho medido del nodo; <= 0 o no finito recurre al valor predeterminado. */
  width?: number;
  /** Alto medido del nodo; <= 0 o no finito recurre al valor predeterminado. */
  height?: number;
}

const finite = (v: number): number => (Number.isFinite(v) ? v : 0);
const positive = (v: number | undefined, fallback: number): number =>
  v !== undefined && Number.isFinite(v) && v > 0 ? v : fallback;

/**
 * Geometría completa para un bucle autorreferencial: la trayectoria, el ancla de etiqueta del ápice del arco y
 * las anclas de etiqueta por extremo (multiplicidad/rol se ubican junto a cada muñón
 * vertical, estilo EA).
 */
export interface SelfLoopGeometry {
  path: string;
  /** Centro del ápice del arco (nombre de asociación/dependencia). */
  labelX: number;
  labelY: number;
  /** Junto al muñón de salida (origen) — text-anchor: end. */
  sourceLabelX: number;
  sourceLabelY: number;
  /** Junto al muñón de retorno (destino) — text-anchor: start. */
  targetLabelX: number;
  targetLabelY: number;
}

export function getSelfLoopGeometry(input: SelfLoopInput): SelfLoopGeometry {
  const sx = finite(input.sourceX);
  const sy = finite(input.sourceY);
  const tx = finite(input.targetX);
  const ty = finite(input.targetY);
  const h = positive(input.height, SELF_LOOP_DEFAULT_HEIGHT);
  const r = Math.min(SELF_LOOP_RADIUS, SELF_LOOP_HALF_SPAN - 4);

  // Los conectores están en el centro vertical del nodo: su punto medio es el
  // centro X del nodo, y el borde superior está a media altura por encima del conector más alto.
  // Si uno de los extremos ya está en el borde superior (Math.abs(sy - ty) > 20), el borde superior es Math.min(sy, ty).
  const centerX = (sx + tx) / 2;
  const topY = Math.abs(sy - ty) > 20 ? Math.min(sy, ty) : Math.min(sy, ty) - h / 2;
  const exitX = centerX - SELF_LOOP_HALF_SPAN;
  const enterX = centerX + SELF_LOOP_HALF_SPAN;
  const apexY = topY - SELF_LOOP_LIFT;

  const path =
    `M ${exitX} ${topY} ` +
    `L ${exitX} ${apexY + r} ` +
    `Q ${exitX} ${apexY} ${exitX + r} ${apexY} ` +
    `L ${enterX - r} ${apexY} ` +
    `Q ${enterX} ${apexY} ${enterX} ${apexY + r} ` +
    `L ${enterX} ${topY}`;

  return {
    path,
    labelX: centerX,
    labelY: apexY - 8,
    sourceLabelX: exitX - 8,
    sourceLabelY: (topY + apexY) / 2,
    targetLabelX: enterX + 8,
    targetLabelY: (topY + apexY) / 2,
  };
}

/**
 * Construye la trayectoria del arco redondeado simétrico para una arista autorreferencial más el
 * ancla de etiqueta (centrada en el ápice del arco, por encima de la línea).
 *
 * Geometría: el arco sale del borde superior del nodo a la izquierda del centro, se eleva hasta el
 * ápice, cruza sobre el nodo y desciende de vuelta hacia el borde superior a la derecha del
 * centro — los marcadores continúan orientándose según las tangentes de la trayectoria (diamante saliendo
 * hacia arriba en el muñón de origen, punta de flecha entrando hacia abajo en el muñón de destino).
 */
export function getSelfLoopPath(input: SelfLoopInput): [path: string, labelX: number, labelY: number] {
  const g = getSelfLoopGeometry(input);
  return [g.path, g.labelX, g.labelY];
}
