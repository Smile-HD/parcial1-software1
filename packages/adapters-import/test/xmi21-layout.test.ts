import { describe, it, expect } from 'vitest';
import { gridLayout, centerNaryDiamond } from '../src/xmi21-layout.js';

describe('gridLayout', () => {
  it('positions classes in a grid (15.5)', () => {
    const classes = [
      { id: 'c1', x: 0, y: 0 },
      { id: 'c2', x: 0, y: 0 },
      { id: 'c3', x: 0, y: 0 },
      { id: 'c4', x: 0, y: 0 },
    ];
    gridLayout(classes, 150);
    expect(classes[0].x).toBe(100);
    expect(classes[0].y).toBe(100);
    expect(classes[1].x).toBe(250);
    expect(classes[1].y).toBe(100);
    expect(classes[2].x).toBe(100);
    expect(classes[2].y).toBe(250);
    expect(classes[3].x).toBe(250);
    expect(classes[3].y).toBe(250);
  });
});

describe('centerNaryDiamond', () => {
  it('centers n-ary diamond at centroid of its member classes (15.5)', () => {
    const classPositions = new Map([
      ['c1', { x: 100, y: 100 }],
      ['c2', { x: 250, y: 100 }],
      ['c3', { x: 175, y: 250 }],
    ]);
    const nary = {
      memberEnds: [{ classId: 'c1' }, { classId: 'c2' }, { classId: 'c3' }],
      x: 0,
      y: 0,
    };
    centerNaryDiamond(nary, classPositions);
    expect(nary.x).toBeCloseTo(175);
    expect(nary.y).toBeCloseTo(150);
  });

  it('handles missing positions gracefully', () => {
    const classPositions = new Map([['c1', { x: 0, y: 0 }]]);
    const nary = {
      memberEnds: [{ classId: 'c1' }, { classId: 'c2' }],
      x: 0,
      y: 0,
    };
    centerNaryDiamond(nary, classPositions);
    expect(nary.x).toBe(0);
    expect(nary.y).toBe(0);
  });
});