/**
 * unit 13d — EA-style Quick Linker: PURE logic tests (strict TDD, RED first).
 *
 * These three functions are the heart of the Quick Linker: the metamodel-
 * filtered connector menu (`validConnectorsFor`), the drop-point hit-test
 * (`quickLinkerTarget`) and the creatable-element list (`elementMenuOptions`).
 * The pointer-drag gesture itself cannot run in jsdom (same known limitation
 * as 13b/13c), so the gesture is built exclusively on top of these functions
 * and they carry the behavioral proof.
 */
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_NODE_HEIGHT,
  DEFAULT_NODE_WIDTH,
  elementMenuOptions,
  quickLinkerTarget,
  validConnectorsFor,
  type QuickLinkerNode,
} from './quickLinker';

describe('unit 13d — validConnectorsFor: metamodel-filtered connector menu', () => {
  it('class → class offers the five always-valid connectors and NO realization', () => {
    const options = validConnectorsFor('class', 'class');
    expect(options).toContain('association');
    expect(options).toContain('aggregation');
    expect(options).toContain('composition');
    expect(options).toContain('generalization');
    expect(options).toContain('dependency');
    // Realization is the interface-gated one: absent for a class target.
    expect(options).not.toContain('realization');
    expect(options).toHaveLength(5);
  });

  it('class → interface adds realization to the set (six options)', () => {
    const options = validConnectorsFor('class', 'interface');
    expect(options).toContain('realization');
    expect(options).toHaveLength(6);
  });

  it('interface → class has NO realization (target is not an interface)', () => {
    const options = validConnectorsFor('interface', 'class');
    expect(options).not.toContain('realization');
    expect(options).toHaveLength(5);
  });

  it('interface → interface allows realization (interfaces may realize interfaces)', () => {
    const options = validConnectorsFor('interface', 'interface');
    expect(options).toContain('realization');
    expect(options).toHaveLength(6);
  });

  it('the source kind never filters the menu (permissive like the existing handlers)', () => {
    expect(validConnectorsFor('class', 'class')).toEqual(validConnectorsFor('interface', 'class'));
    expect(validConnectorsFor('class', 'interface')).toEqual(validConnectorsFor('interface', 'interface'));
  });

  it('option order is stable and realization sits between generalization and dependency', () => {
    expect(validConnectorsFor('class', 'interface')).toEqual([
      'association',
      'aggregation',
      'composition',
      'generalization',
      'realization',
      'dependency',
    ]);
  });

  it('self-link (class → same class) EXCLUDES generalization but INCLUDES association/aggregation/composition/dependency', () => {
    const options = validConnectorsFor('class', 'class', true);
    // Self-valid connectors for recursive relationships
    expect(options).toContain('association');
    expect(options).toContain('aggregation');
    expect(options).toContain('composition');
    expect(options).toContain('dependency');
    // Self-generalization is a cycle — excluded
    expect(options).not.toContain('generalization');
    // Realization impossible for self (would require interface target)
    expect(options).not.toContain('realization');
    expect(options).toHaveLength(4);
  });

  it('self-link (interface → same interface) EXCLUDES generalization but INCLUDES association/aggregation/composition/dependency/realization', () => {
    const options = validConnectorsFor('interface', 'interface', true);
    // Self-valid connectors for recursive relationships
    expect(options).toContain('association');
    expect(options).toContain('aggregation');
    expect(options).toContain('composition');
    expect(options).toContain('dependency');
    // Interfaces can realize interfaces (even self)
    expect(options).toContain('realization');
    // Self-generalization is a cycle — excluded
    expect(options).not.toContain('generalization');
    expect(options).toHaveLength(5);
  });
});

describe('unit 13d — quickLinkerTarget: drop-point hit-test', () => {
  // Two nodes: A occupies [0,180]x[0,120] (default size), B occupies
  // [300,420]x[0,80] (explicit measured size).
  const nodes: QuickLinkerNode[] = [
    { id: 'a', position: { x: 0, y: 0 } },
    { id: 'b', position: { x: 300, y: 0 }, width: 120, height: 80 },
  ];

  it('returns the node whose rectangle contains the drop point', () => {
    expect(quickLinkerTarget({ x: 50, y: 50 }, nodes)).toBe('a');
    expect(quickLinkerTarget({ x: 340, y: 40 }, nodes)).toBe('b');
  });

  it('returns null for empty canvas (no rectangle contains the point)', () => {
    expect(quickLinkerTarget({ x: 250, y: 50 }, nodes)).toBeNull();
    expect(quickLinkerTarget({ x: -1, y: 50 }, nodes)).toBeNull();
    expect(quickLinkerTarget({ x: 50, y: 500 }, nodes)).toBeNull();
  });

  it('uses the MEASURED size when present: outside the measured rect is empty canvas', () => {
    // B is 120x80; (415, 90) is inside the DEFAULT box but outside the measured one.
    expect(quickLinkerTarget({ x: 415, y: 90 }, nodes)).toBeNull();
  });

  it('falls back to the default node box when the node was never measured', () => {
    // A has no width/height: the default box (DEFAULT_NODE_WIDTH x DEFAULT_NODE_HEIGHT) applies.
    expect(quickLinkerTarget({ x: DEFAULT_NODE_WIDTH / 2, y: DEFAULT_NODE_HEIGHT / 2 }, nodes)).toBe('a');
    expect(quickLinkerTarget({ x: DEFAULT_NODE_WIDTH + 1, y: 10 }, nodes)).toBeNull();
  });

  it('boundary points count as inside (inclusive containment)', () => {
    expect(quickLinkerTarget({ x: 0, y: 0 }, nodes)).toBe('a');
    expect(quickLinkerTarget({ x: 300 + 120, y: 80 }, nodes)).toBe('b');
  });

  it('overlapping nodes: the LAST (topmost-rendered) node wins', () => {
    const overlapping: QuickLinkerNode[] = [
      { id: 'under', position: { x: 0, y: 0 }, width: 200, height: 200 },
      { id: 'over', position: { x: 100, y: 100 }, width: 200, height: 200 },
    ];
    expect(quickLinkerTarget({ x: 150, y: 150 }, overlapping)).toBe('over');
  });

  it('empty node list always resolves to empty canvas', () => {
    expect(quickLinkerTarget({ x: 10, y: 10 }, [])).toBeNull();
  });
});

describe('unit 13d — elementMenuOptions: creatable element types', () => {
  it('offers exactly Class and Interface (the palette node kinds)', () => {
    expect(elementMenuOptions()).toEqual(['class', 'interface']);
  });

  it('returns a fresh array each call (menu state can never mutate the module)', () => {
    const first = elementMenuOptions();
    first.push('component' as never);
    expect(elementMenuOptions()).toEqual(['class', 'interface']);
  });
});
