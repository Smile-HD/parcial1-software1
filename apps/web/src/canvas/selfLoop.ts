/**
 * unit 13e — self-loop geometry for recursive UML edges (source === target).
 *
 * The bug this fixes ("no se ve lo recursivo"): getBezierPath on a self-edge
 * draws a curve that either collapses to a point (when both handles resolve
 * to the same coordinates) or passes BEHIND the opaque node body — React Flow
 * renders nodes above edges, so the recursive relation is invisible.
 *
 * The fix (13e.7 refinement): a SYMMETRIC rounded arch ABOVE the node that
 * exits and re-enters at the node's TOP-CENTER — up from the top edge, across
 * an arch over the node, back down into the top edge — instead of the earlier
 * right-side bulge. This mirrors how EA draws recursive associations. The
 * exit stub sits left of center and the return stub right of center (a small
 * symmetric gap so the start/end markers never overlap); the arch apex is
 * horizontally centered on the node.
 *
 * Sized from the node's measured dimensions (React Flow v12 does NOT put them
 * on EdgeProps; the edge components read them from the store via useStore),
 * with a sensible default box when the node has not been measured yet (first
 * paint / jsdom). The handles sit at the node's vertical center (Left =
 * target, Right = source), so the node center X is the handles' midpoint and
 * the node top is `min(sy, ty) - h/2`.
 *
 * The path uses only M/L/Q commands (every emitted number is an x,y pair) so
 * tests can parse its extent exactly — no arc commands. NaN-safe: every
 * non-finite input is sanitized to 0 and every dimension falls back to the
 * default box.
 */

/** Default node box used when React Flow has not measured the node yet. */
export const SELF_LOOP_DEFAULT_WIDTH = 180;
export const SELF_LOOP_DEFAULT_HEIGHT = 120;

/** Half the horizontal distance between the exit and return stubs (px). */
export const SELF_LOOP_HALF_SPAN = 24;
/** Clearance between the node top and the arch apex (px). */
export const SELF_LOOP_LIFT = 40;
/** Rounded corner radius of the arch (px). */
export const SELF_LOOP_RADIUS = 12;

export interface SelfLoopInput {
  sourceX: number;
  sourceY: number;
  targetX: number;
  targetY: number;
  /** Measured node width; <= 0 or non-finite falls back to the default. */
  width?: number;
  /** Measured node height; <= 0 or non-finite falls back to the default. */
  height?: number;
}

const finite = (v: number): number => (Number.isFinite(v) ? v : 0);
const positive = (v: number | undefined, fallback: number): number =>
  v !== undefined && Number.isFinite(v) && v > 0 ? v : fallback;

/**
 * Full geometry for a self-loop: the path, the arch-apex label anchor and
 * the per-end label anchors (multiplicity/role live beside each vertical
 * stub, EA-style).
 */
export interface SelfLoopGeometry {
  path: string;
  /** Center of the arch apex (association/dependency name). */
  labelX: number;
  labelY: number;
  /** Beside the exit (source) stub — text-anchor: end. */
  sourceLabelX: number;
  sourceLabelY: number;
  /** Beside the return (target) stub — text-anchor: start. */
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

  // Handles are at the node's vertical center: their midpoint is the node
  // center X, and the top edge is half a height above the higher handle.
  const centerX = (sx + tx) / 2;
  const topY = Math.min(sy, ty) - h / 2;
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
 * Builds the symmetric rounded arch path for a self-edge plus the label
 * anchor (centered on the arch apex, above the line).
 *
 * Geometry: the arch exits the node's top edge left of center, rises to the
 * apex, crosses over the node and descends back into the top edge right of
 * center — markers keep orienting along the path tangents (diamond exiting
 * upward at the source stub, arrowhead entering downward at the target stub).
 */
export function getSelfLoopPath(input: SelfLoopInput): [path: string, labelX: number, labelY: number] {
  const g = getSelfLoopGeometry(input);
  return [g.path, g.labelX, g.labelY];
}
