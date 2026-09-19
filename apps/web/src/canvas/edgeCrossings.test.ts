import { describe, expect, it } from 'vitest';
import {
  addBridgeJumps,
  findCrossingPoints,
  parseOrthogonalSegments,
  type Segment,
} from './edgeCrossings';

describe('edgeCrossings (Line Jumps estilo Enterprise Architect)', () => {
  describe('parseOrthogonalSegments', () => {
    it('extracts horizontal and vertical segments from an orthogonal SVG path', () => {
      const path = 'M 100 100 L 200 100 L 200 300 L 400 300';
      const { horizontals, verticals } = parseOrthogonalSegments(path);

      expect(horizontals).toHaveLength(2);
      expect(horizontals[0]).toEqual({ x1: 100, y1: 100, x2: 200, y2: 100 });
      expect(horizontals[1]).toEqual({ x1: 200, y1: 300, x2: 400, y2: 300 });

      expect(verticals).toHaveLength(1);
      expect(verticals[0]).toEqual({ x1: 200, y1: 100, x2: 200, y2: 300 });
    });

    it('handles smooth-step paths with corner curves (Q commands)', () => {
      const path = 'M 50 50 L 100 50 Q 105 50 105 55 L 105 200';
      const { horizontals, verticals } = parseOrthogonalSegments(path);

      expect(horizontals.length).toBeGreaterThanOrEqual(1);
      expect(verticals.length).toBeGreaterThanOrEqual(1);
      expect(horizontals[0]?.y1).toBe(50);
      expect(verticals[0]?.x1).toBe(105);
    });
  });

  describe('findCrossingPoints', () => {
    it('detects 90-degree intersection between horizontal and vertical segments', () => {
      const horiz: Segment[] = [{ x1: 50, y1: 100, x2: 250, y2: 100 }];
      const vert: Segment[] = [{ x1: 150, y1: 50, x2: 150, y2: 200 }];

      const crossings = findCrossingPoints(horiz, vert);
      expect(crossings).toHaveLength(1);
      expect(crossings[0]).toEqual({ x: 150, y: 100 });
    });

    it('ignores intersections too close to endpoints (within margin)', () => {
      const horiz: Segment[] = [{ x1: 50, y1: 100, x2: 250, y2: 100 }];
      // Vertical line very close to left endpoint (x = 55, margin is 10)
      const vertNearEnd: Segment[] = [{ x1: 55, y1: 50, x2: 55, y2: 200 }];

      const crossings = findCrossingPoints(horiz, vertNearEnd, 10);
      expect(crossings).toHaveLength(0);
    });

    it('returns empty array when lines do not intersect', () => {
      const horiz: Segment[] = [{ x1: 50, y1: 100, x2: 100, y2: 100 }];
      const vert: Segment[] = [{ x1: 200, y1: 50, x2: 200, y2: 200 }];

      const crossings = findCrossingPoints(horiz, vert);
      expect(crossings).toHaveLength(0);
    });
  });

  describe('addBridgeJumps', () => {
    it('returns the unchanged path if there are no crossings', () => {
      const path = 'M 50 100 L 250 100';
      expect(addBridgeJumps(path, [])).toBe(path);
    });

    it('replaces intersection on horizontal segment with an upward arc (L to R)', () => {
      const path = 'M 50 100 L 250 100';
      const crossings = [{ x: 150, y: 100 }];
      const result = addBridgeJumps(path, crossings, 6);

      // Should contain arc jumping from x=144 to x=156 at y=100
      expect(result).toContain('144');
      expect(result).toContain('156');
      expect(result).toContain('A 6 6 0 0 0');
    });

    it('replaces intersection on horizontal segment with an upward arc (R to L)', () => {
      const path = 'M 250 100 L 50 100';
      const crossings = [{ x: 150, y: 100 }];
      const result = addBridgeJumps(path, crossings, 6);

      // Should contain arc jumping from x=156 to x=144 at y=100
      expect(result).toContain('156');
      expect(result).toContain('144');
      expect(result).toContain('A 6 6 0 0 1');
    });

    it('handles multiple crossings on the same horizontal segment in order', () => {
      const path = 'M 50 100 L 350 100';
      const crossings = [
        { x: 200, y: 100 },
        { x: 100, y: 100 },
      ];
      const result = addBridgeJumps(path, crossings, 6);

      // Crossings should be visited in order: 100 first, then 200
      const idx100 = result.indexOf('94');
      const idx200 = result.indexOf('194');
      expect(idx100).toBeGreaterThan(-1);
      expect(idx200).toBeGreaterThan(idx100);
    });
  });
});
