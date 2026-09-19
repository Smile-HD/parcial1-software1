/**
 * Cálculo de intersecciones de aristas y generación de saltos de línea (Line Jumps estilo Enterprise Architect).
 *
 * Cuando dos asociaciones o conectores ortogonales se cruzan a 90 grados, esta utilidad
 * calcula el punto de cruce y reemplaza el segmento recto horizontal por un pequeño
 * arco semicircular ("puente") de radio R (~6px) que pasa visualmente por encima de la otra línea,
 * evitando que parezca una unión de 4 vías o una cruz sólida.
 */

export interface Point {
  x: number;
  y: number;
}

export interface Segment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/**
 * Simplifica un path ortogonal unificando comandos 'L' consecutivos que son colineales,
 * evitando que waypoints intermedios generados por getSmoothStepPath dividan los segmentos rectos.
 */
export function coalesceOrthogonalPath(path: string): string {
  const commandRegex = /([MLQ])\s*([^MLQ]+)/gi;
  const commands: { cmd: string; args: number[] }[] = [];
  let match: RegExpExecArray | null;

  while ((match = commandRegex.exec(path)) !== null) {
    const cmd = match[1]!.toUpperCase();
    const args = match[2]!
      .trim()
      .split(/[\s,]+/)
      .map(Number)
      .filter((n) => !Number.isNaN(n));
    commands.push({ cmd, args });
  }

  interface SegmentCommand {
    cmd: string;
    args: number[];
    startX: number;
    startY: number;
    endX: number;
    endY: number;
  }

  const simplified: SegmentCommand[] = [];
  let currX = 0;
  let currY = 0;

  for (const c of commands) {
    if (c.cmd === 'M') {
      if (c.args.length >= 2) {
        currX = c.args[0]!;
        currY = c.args[1]!;
      }
      simplified.push({
        cmd: 'M',
        args: [...c.args],
        startX: currX,
        startY: currY,
        endX: currX,
        endY: currY,
      });
    } else if (c.cmd === 'L') {
      const nextX = c.args[0]!;
      const nextY = c.args[1]!;
      const prev = simplified[simplified.length - 1];

      if (prev && prev.cmd === 'L') {
        const prevIsHoriz = Math.abs(prev.startY - prev.endY) < 0.5;
        const currIsHoriz = Math.abs(currY - nextY) < 0.5;
        const prevIsVert = Math.abs(prev.startX - prev.endX) < 0.5;
        const currIsVert = Math.abs(currX - nextX) < 0.5;

        // Fusión de segmentos horizontales colineales
        if (prevIsHoriz && currIsHoriz && Math.abs(prev.endY - currY) < 0.5) {
          prev.args[0] = nextX;
          prev.endX = nextX;
          currX = nextX;
          continue;
        }

        // Fusión de segmentos verticales colineales
        if (prevIsVert && currIsVert && Math.abs(prev.endX - currX) < 0.5) {
          prev.args[1] = nextY;
          prev.endY = nextY;
          currY = nextY;
          continue;
        }
      }

      simplified.push({
        cmd: 'L',
        args: [...c.args],
        startX: currX,
        startY: currY,
        endX: nextX,
        endY: nextY,
      });
      currX = nextX;
      currY = nextY;
    } else {
      simplified.push({
        cmd: c.cmd,
        args: [...c.args],
        startX: currX,
        startY: currY,
        endX: c.args[2] ?? currX,
        endY: c.args[3] ?? currY,
      });
      if (c.cmd === 'Q' && c.args.length >= 4) {
        currX = c.args[2]!;
        currY = c.args[3]!;
      }
    }
  }

  return simplified.map((c) => `${c.cmd} ${c.args.join(' ')}`).join(' ');
}

/**
 * Parsea un path SVG generado por getSmoothStepPath en sus segmentos rectos ortogonales
 * (horizontales y verticales), omitiendo las curvas de esquina.
 */
export function parseOrthogonalSegments(rawPath: string): {
  horizontals: Segment[];
  verticals: Segment[];
} {
  const path = coalesceOrthogonalPath(rawPath);
  const horizontals: Segment[] = [];
  const verticals: Segment[] = [];

  const commandRegex = /([MLQ])\s*([^MLQ]+)/gi;
  let match: RegExpExecArray | null;
  let currentX = 0;
  let currentY = 0;

  while ((match = commandRegex.exec(path)) !== null) {
    const cmd = match[1]!.toUpperCase();
    const args = match[2]!
      .trim()
      .split(/[\s,]+/)
      .map(Number)
      .filter((n) => !Number.isNaN(n));

    if (cmd === 'M') {
      if (args.length >= 2) {
        currentX = args[0]!;
        currentY = args[1]!;
      }
    } else if (cmd === 'L') {
      for (let i = 0; i + 1 < args.length; i += 2) {
        const nextX = args[i]!;
        const nextY = args[i + 1]!;
        if (Math.abs(currentY - nextY) < 1 && Math.abs(currentX - nextX) >= 1) {
          horizontals.push({ x1: currentX, y1: currentY, x2: nextX, y2: nextY });
        } else if (Math.abs(currentX - nextX) < 1 && Math.abs(currentY - nextY) >= 1) {
          verticals.push({ x1: currentX, y1: currentY, x2: nextX, y2: nextY });
        }
        currentX = nextX;
        currentY = nextY;
      }
    } else if (cmd === 'Q') {
      if (args.length >= 4) {
        currentX = args[2]!;
        currentY = args[3]!;
      }
    }
  }

  return { horizontals, verticals };
}

/**
 * Encuentra todos los puntos de intersección entre segmentos horizontales y verticales.
 * @param horizontals Lista de segmentos horizontales
 * @param verticals Lista de segmentos verticales
 * @param margin Margen mínimo de separación con respecto a los extremos (por defecto 10px)
 */
export function findCrossingPoints(
  horizontals: Segment[],
  verticals: Segment[],
  margin: number = 10,
): Point[] {
  const crossings: Point[] = [];

  for (const h of horizontals) {
    const hMinX = Math.min(h.x1, h.x2);
    const hMaxX = Math.max(h.x1, h.x2);
    const hY = h.y1;

    for (const v of verticals) {
      const vX = v.x1;
      const vMinY = Math.min(v.y1, v.y2);
      const vMaxY = Math.max(v.y1, v.y2);

      if (
        vX > hMinX + margin &&
        vX < hMaxX - margin &&
        hY > vMinY + margin &&
        hY < vMaxY - margin
      ) {
        crossings.push({ x: vX, y: hY });
      }
    }
  }

  return crossings;
}

/**
 * Inserta arcos semicirculares de puente (Line Jumps) en un path SVG en los puntos de cruce indicados.
 *
 * @param path Path SVG ortogonal original (ej. generado por getSmoothStepPath)
 * @param crossings Lista de puntos {x, y} donde esta línea cruza a otra
 * @param radius Radio del arco del puente en píxeles (por defecto 6px)
 */
export function addBridgeJumps(
  rawPath: string,
  crossings: Point[],
  radius: number = 6,
): string {
  if (!crossings || crossings.length === 0) {
    return rawPath;
  }

  const path = coalesceOrthogonalPath(rawPath);
  const commandRegex = /([MLQ])\s*([^MLQ]+)/gi;
  let match: RegExpExecArray | null;
  let currentX = 0;
  let currentY = 0;
  let result = '';

  while ((match = commandRegex.exec(path)) !== null) {
    const cmd = match[1]!.toUpperCase();
    const rawArgs = match[2]!.trim();
    const args = rawArgs
      .split(/[\s,]+/)
      .map(Number)
      .filter((n) => !Number.isNaN(n));

    if (cmd === 'M') {
      if (args.length >= 2) {
        currentX = args[0]!;
        currentY = args[1]!;
      }
      result += `M ${args[0]} ${args[1]} `;
    } else if (cmd === 'Q') {
      if (args.length >= 4) {
        currentX = args[2]!;
        currentY = args[3]!;
      }
      result += `Q ${args.join(' ')} `;
    } else if (cmd === 'L') {
      const targetX = args[0]!;
      const targetY = args[1]!;

      const isHorizontal = Math.abs(currentY - targetY) < 1 && Math.abs(currentX - targetX) >= radius * 2 + 2;

      if (!isHorizontal) {
        result += `L ${targetX} ${targetY} `;
        currentX = targetX;
        currentY = targetY;
        continue;
      }

      const minX = Math.min(currentX, targetX);
      const maxX = Math.max(currentX, targetX);
      const movingRight = targetX > currentX;

      const segmentCrossings = crossings.filter(
        (c) =>
          Math.abs(c.y - currentY) < 2 &&
          c.x > minX + radius + 1 &&
          c.x < maxX - radius - 1,
      );

      if (segmentCrossings.length === 0) {
        result += `L ${targetX} ${targetY} `;
        currentX = targetX;
        currentY = targetY;
        continue;
      }

      segmentCrossings.sort((a, b) => (movingRight ? a.x - b.x : b.x - a.x));

      const validCrossings: Point[] = [];
      for (const pt of segmentCrossings) {
        if (
          validCrossings.length === 0 ||
          Math.abs(pt.x - validCrossings[validCrossings.length - 1]!.x) >= radius * 2
        ) {
          validCrossings.push(pt);
        }
      }

      for (const cross of validCrossings) {
        const startArcX = movingRight ? cross.x - radius : cross.x + radius;
        const endArcX = movingRight ? cross.x + radius : cross.x - radius;
        const sweep = movingRight ? 0 : 1;

        result += `L ${startArcX} ${currentY} A ${radius} ${radius} 0 0 ${sweep} ${endArcX} ${currentY} `;
      }

      result += `L ${targetX} ${targetY} `;
      currentX = targetX;
      currentY = targetY;
    }
  }

  return result.trim();
}
