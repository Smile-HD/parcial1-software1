/**
 * unit 13e — self-loop rendering (the "no se ve lo recursivo" bug).
 *
 * A self-edge (source === target) must render a VISIBLE loop that exits the
 * node and returns to it around the outside — never a degenerate point or a
 * curve hidden behind the opaque node body (the old getBezierPath behavior).
 *
 * 13e.7 refinement: the loop is a SYMMETRIC arch above the node that exits
 * and re-enters at the node's TOP-CENTER (exit stub left of center, return
 * stub right of center, apex horizontally centered on the node).
 *
 * Strict TDD: the pure geometry test (`getSelfLoopPath`) and the rendered
 * integration tests (self-association / self-dependency / self-composition
 * through DiagramCanvas) were written RED first against the pre-fix code,
 * where a self-edge produced a zero-extent path.
 */
import { render, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { buildYDocFromDiagram, type Diagram } from '@app/core';

import { DiagramCanvas } from './DiagramCanvas';
import {
  getSelfLoopPath,
  SELF_LOOP_DEFAULT_HEIGHT,
  SELF_LOOP_DEFAULT_WIDTH,
  SELF_LOOP_HALF_SPAN,
} from './selfLoop';

/**
 * Parse an SVG path made of M/L/Q commands (every emitted number is an
 * x,y pair) into its bounding extent + command count. The self-loop path
 * generator deliberately avoids arc commands so this stays exact.
 */
function loopExtent(d: string): { w: number; h: number; segments: number } {
  const segments = (d.match(/[MLQC]/g) ?? []).length;
  const nums = (d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i + 1 < nums.length; i += 2) {
    minX = Math.min(minX, nums[i]!);
    maxX = Math.max(maxX, nums[i]!);
    minY = Math.min(minY, nums[i + 1]!);
    maxY = Math.max(maxY, nums[i + 1]!);
  }
  return { w: maxX - minX, h: maxY - minY, segments };
}

/** Every (x, y) pair the path visits, in order (M/L/Q all emit pairs). */
function loopPoints(d: string): Array<[number, number]> {
  const nums = (d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
  const pts: Array<[number, number]> = [];
  for (let i = 0; i + 1 < nums.length; i += 2) {
    pts.push([nums[i]!, nums[i + 1]!]);
  }
  return pts;
}

describe('unit 13e — getSelfLoopPath (pure geometry, RED first)', () => {
  it('a coincident self-edge (handles at the same point) yields a NON-degenerate loop', () => {
    const [d, labelX, labelY] = getSelfLoopPath({
      sourceX: 100,
      sourceY: 50,
      targetX: 100,
      targetY: 50,
      width: 0,
      height: 0,
    });

    expect(d.startsWith('M')).toBe(true);
    expect(d).not.toContain('NaN');
    // Rounded arch: move + straight runs + quadratic corners, not a point.
    expect(loopExtent(d).segments).toBeGreaterThanOrEqual(6);
    const { w, h } = loopExtent(d);
    expect(w).toBeGreaterThanOrEqual(40);
    expect(h).toBeGreaterThanOrEqual(40);
    // The label anchor sits on the arch (above the node), not on the point.
    expect(labelY).toBeLessThan(50);
    expect(Number.isFinite(labelX)).toBe(true);
  });

  it('13e.7: the arch exits and re-enters at the TOP-CENTER, symmetric above the node', () => {
    // Handles at the node's vertical center: source = right edge, target =
    // left edge → node spans x∈[0,180], y∈[0,120]; top edge y=0, center x=90.
    const [d, labelX, labelY] = getSelfLoopPath({
      sourceX: 180, sourceY: 60, targetX: 0, targetY: 60,
      width: SELF_LOOP_DEFAULT_WIDTH, height: SELF_LOOP_DEFAULT_HEIGHT,
    });
    const pts = loopPoints(d);
    const topY = 0; // min(sy, ty) - h/2
    const centerX = 90;

    // Exit stub: top edge, left of center. Return stub: top edge, right of
    // center — both ON the node's top edge, symmetric about the center.
    expect(pts[0]).toEqual([centerX - SELF_LOOP_HALF_SPAN, topY]);
    expect(pts[pts.length - 1]).toEqual([centerX + SELF_LOOP_HALF_SPAN, topY]);

    // The apex is ABOVE the node's top edge and horizontally centered.
    const { w, h } = loopExtent(d);
    const minY = Math.min(...pts.map((p) => p[1]));
    const minX = Math.min(...pts.map((p) => p[0]));
    expect(minY).toBeLessThan(topY);
    expect(minX + w / 2).toBeCloseTo(centerX);
    // The whole loop stays outside the node body (never dips below the top).
    expect(minY + h).toBeLessThanOrEqual(topY);
    // The name label rides the arch apex, centered on the node.
    expect(labelY).toBeLessThan(minY);
    expect(labelX).toBeCloseTo(centerX);
  });

  it('falls back to the default box when dimensions are missing', () => {
    const [d] = getSelfLoopPath({
      sourceX: 0, sourceY: 0, targetX: 0, targetY: 0,
      width: SELF_LOOP_DEFAULT_WIDTH, height: SELF_LOOP_DEFAULT_HEIGHT,
    });
    const [dUndef] = getSelfLoopPath({
      sourceX: 0, sourceY: 0, targetX: 0, targetY: 0,
      width: undefined as unknown as number, height: undefined as unknown as number,
    });
    expect(dUndef).toBe(d);
    expect(loopExtent(d).w).toBeGreaterThan(0);
  });

  it('never emits NaN when a coordinate is non-finite', () => {
    const [d] = getSelfLoopPath({
      sourceX: NaN, sourceY: 10, targetX: 10, targetY: Infinity,
      width: 180, height: 120,
    });
    expect(d).not.toContain('NaN');
    expect(d).not.toContain('Infinity');
  });
});

const CLASS_ID = crypto.randomUUID();

/** One class; the edge loops back onto it (source === target). */
function selfFixture(extra: Partial<Diagram> = {}): Diagram {
  return {
    id: crypto.randomUUID(),
    name: 'Self',
    classes: [
      {
        id: CLASS_ID,
        name: 'TreeNode',
        position: { x: 0, y: 0 },
        attributes: [],
        methods: [],
      },
    ],
    associations: [],
    generalizations: [],
    realizations: [],
    dependencies: [],
    naryAssociations: [],
    ...extra,
  };
}

function baseEdgePath(container: HTMLElement): SVGPathElement {
  const edge = container.querySelector('.react-flow__edge');
  expect(edge).not.toBeNull();
  const svg = (edge!.querySelector('svg') ?? edge)! as SVGSVGElement;
  const path = Array.from(svg.querySelectorAll('path')).find((p) => !p.closest('marker'));
  expect(path).toBeDefined();
  return path as SVGPathElement;
}

function edgeSvg(container: HTMLElement): SVGSVGElement | HTMLElement {
  const el = container.querySelector('.react-flow__edge');
  expect(el).not.toBeNull();
  return (el!.querySelector('svg') ?? el!) as SVGSVGElement | HTMLElement;
}

describe('unit 13e — self-association renders a visible loop (RED first)', () => {
  it('a self-association path is a real loop, not a degenerate point', async () => {
    const diagram = selfFixture({
      associations: [
        {
          id: crypto.randomUUID(),
          sourceClassId: CLASS_ID,
          targetClassId: CLASS_ID,
          sourceMultiplicity: '1',
          targetMultiplicity: '0..*',
          directed: false,
          name: 'manages',
        },
      ],
    });
    const doc = buildYDocFromDiagram(diagram);
    const { container } = render(<DiagramCanvas doc={doc} />);

    await waitFor(() => {
      expect(container.querySelector('.react-flow__edge')).not.toBeNull();
    });
    const d = baseEdgePath(container as HTMLElement).getAttribute('d') ?? '';
    expect(d).not.toContain('NaN');
    const { w, h, segments } = loopExtent(d);
    expect(segments).toBeGreaterThanOrEqual(6);
    expect(w).toBeGreaterThan(0);
    expect(h).toBeGreaterThan(0);

    // The label survives on the loop.
    const texts = Array.from((edgeSvg(container as HTMLElement) as SVGSVGElement).querySelectorAll('text')).map(
      (t) => t.textContent ?? '',
    );
    expect(texts.some((t) => t.includes('manages'))).toBe(true);
  });

  it('a self-composition keeps its diamond marker on the declared end', async () => {
    const diagram = selfFixture({
      associations: [
        {
          id: crypto.randomUUID(),
          sourceClassId: CLASS_ID,
          targetClassId: CLASS_ID,
          directed: false,
          aggregation: 'composite',
          aggregationEnd: 'source',
        },
      ],
    });
    const doc = buildYDocFromDiagram(diagram);
    const { container } = render(<DiagramCanvas doc={doc} />);

    await waitFor(() => {
      expect(container.querySelector('.react-flow__edge')).not.toBeNull();
    });
    const base = baseEdgePath(container as HTMLElement);
    const { w, h } = loopExtent(base.getAttribute('d') ?? '');
    expect(w).toBeGreaterThan(0);
    expect(h).toBeGreaterThan(0);
    // Diamond at the source end (marker-start) — same rule as non-self edges.
    expect(base.getAttribute('marker-start') ?? '').toContain('composite');
  });
});

describe('unit 13e — self-dependency renders a visible loop (RED first)', () => {
  it('a self-dependency path is a real loop with the open arrow at the end', async () => {
    const diagram = selfFixture({
      dependencies: [{ id: crypto.randomUUID(), clientClassId: CLASS_ID, supplierClassId: CLASS_ID, name: 'uses' }],
    });
    const doc = buildYDocFromDiagram(diagram);
    const { container } = render(<DiagramCanvas doc={doc} />);

    await waitFor(() => {
      expect(container.querySelector('.react-flow__edge')).not.toBeNull();
    });
    const base = baseEdgePath(container as HTMLElement);
    const { w, h, segments } = loopExtent(base.getAttribute('d') ?? '');
    expect(segments).toBeGreaterThanOrEqual(6);
    expect(w).toBeGreaterThan(0);
    expect(h).toBeGreaterThan(0);
    expect(base.getAttribute('marker-end') ?? '').toContain('dependency-arrow');
    expect(base.getAttribute('stroke-dasharray')).toBeTruthy();
  });
});
