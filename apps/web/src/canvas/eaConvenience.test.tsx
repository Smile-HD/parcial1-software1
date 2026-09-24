import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { buildYDocFromDiagram, projectYDocToDiagram, type Diagram } from '@app/core';

import { DiagramCanvas } from './DiagramCanvas';
import { getBoxIntersection } from './AssociationEdge';

function makeFixture(): Diagram {
  return {
    id: crypto.randomUUID(),
    name: 'ConvenienceTest',
    classes: [
      {
        id: crypto.randomUUID(),
        name: 'Order',
        position: { x: 100, y: 100 },
        kind: 'class',
        isAbstract: false,
        attributes: [],
        methods: [],
      },
      {
        id: crypto.randomUUID(),
        name: 'Item',
        position: { x: 300, y: 100 },
        kind: 'class',
        isAbstract: false,
        attributes: [],
        methods: [],
      },
    ],
    associations: [],
    generalizations: [],
    realizations: [],
    dependencies: [],
    naryAssociations: [],
  };
}

describe('Enterprise Architect diagrammer convenience features', () => {
  it('allows click-to-place from Palette: clicking Class creates a class on the canvas', () => {
    const doc = buildYDocFromDiagram(makeFixture());
    const { container } = render(<DiagramCanvas doc={doc} />);
    expect(container.querySelectorAll('.react-flow__node')).toHaveLength(2);

    const classButton = screen.getByTestId('palette-class');
    fireEvent.click(classButton);

    const projected = projectYDocToDiagram(doc);
    expect(projected.classes).toHaveLength(3);
    expect(container.querySelectorAll('.react-flow__node')).toHaveLength(3);
  });

  it('allows click-to-place from Palette: clicking Interface creates an interface on the canvas', () => {
    const doc = buildYDocFromDiagram(makeFixture());
    const { container } = render(<DiagramCanvas doc={doc} />);

    const ifaceButton = screen.getByTestId('palette-interface');
    fireEvent.click(ifaceButton);

    const projected = projectYDocToDiagram(doc);
    expect(projected.classes.some((c) => c.kind === 'interface')).toBe(true);
  });

  it('deletes the selected class when pressing Delete key', () => {
    const doc = buildYDocFromDiagram(makeFixture());
    const { container } = render(<DiagramCanvas doc={doc} />);
    const firstNode = container.querySelector('.react-flow__node .uml-class')!;
    expect(firstNode).not.toBeNull();

    // Click to select the first class
    fireEvent.click(firstNode);
    expect(firstNode.classList.contains('uml-class--selected')).toBe(true);

    // Press Delete key
    fireEvent.keyDown(window, { key: 'Delete' });

    const projected = projectYDocToDiagram(doc);
    expect(projected.classes).toHaveLength(1);
  });

  it('nudges the selected class by 20px when pressing arrow keys', () => {
    const doc = buildYDocFromDiagram(makeFixture());
    const { container } = render(<DiagramCanvas doc={doc} />);
    const firstNode = container.querySelector('.react-flow__node .uml-class')!;

    // Select the first class
    fireEvent.click(firstNode);

    // Initial position was { x: 100, y: 100 }
    fireEvent.keyDown(window, { key: 'ArrowRight' });

    const projected = projectYDocToDiagram(doc);
    const orderClass = projected.classes.find((c) => c.name === 'Order')!;
    expect(orderClass.position).toEqual({ x: 120, y: 100 });

    fireEvent.keyDown(window, { key: 'ArrowDown' });
    const projectedAfterDown = projectYDocToDiagram(doc);
    const orderClassAfterDown = projectedAfterDown.classes.find((c) => c.name === 'Order')!;
    expect(orderClassAfterDown.position).toEqual({ x: 120, y: 120 });
  });

  it('renders top and bottom handles on class nodes for vertical connections', () => {
    const doc = buildYDocFromDiagram(makeFixture());
    const { container } = render(<DiagramCanvas doc={doc} />);
    const node = container.querySelector('.react-flow__node')!;

    const topHandle = node.querySelector('.react-flow__handle-top');
    const bottomHandle = node.querySelector('.react-flow__handle-bottom');
    expect(topHandle).not.toBeNull();
    expect(bottomHandle).not.toBeNull();
  });

  it('computes correct box perimeter intersection for association class dashed connector', () => {
    // Box centered at (200, 150) with width 200, height 100 (x in [100, 300], y in [100, 200])
    // Target to the right (x=400, y=150) -> should intersect right edge at (300, 150)
    const [ix, iy] = getBoxIntersection(100, 100, 200, 100, 400, 150);
    expect(ix).toBe(300);
    expect(iy).toBe(150);

    // Target above (x=200, y=50) -> should intersect top edge at (200, 100)
    const [ixTop, iyTop] = getBoxIntersection(100, 100, 200, 100, 200, 50);
    expect(ixTop).toBe(200);
    expect(iyTop).toBe(100);
  });

  it('allows linking an association class to an association via the edge editor', async () => {
    const fixture = makeFixture();
    // Add third class "Enrollment"
    const enrollmentId = crypto.randomUUID();
    fixture.classes.push({
      id: enrollmentId,
      name: 'Enrollment',
      position: { x: 200, y: 300 },
      kind: 'class',
      isAbstract: false,
      attributes: [],
      methods: [],
    });
    // Add association between Order and Item
    const assocId = crypto.randomUUID();
    fixture.associations.push({
      id: assocId,
      diagramId: fixture.id,
      sourceClassId: fixture.classes[0]!.id,
      targetClassId: fixture.classes[1]!.id,
      sourceMultiplicity: '1',
      targetMultiplicity: '*',
      directed: false,
      aggregation: 'none',
    });

    const doc = buildYDocFromDiagram(fixture);
    const { container } = render(<DiagramCanvas doc={doc} />);

    // Click the association edge to open editor
    const edge = await waitFor(() => {
      const el = container.querySelector('.react-flow__edge');
      expect(el).not.toBeNull();
      return el!;
    });
    fireEvent.click(edge);

    // Check that association class selector is present
    const assocClassSelect = screen.getByTestId('edge-assoc-class-select');
    expect(assocClassSelect).not.toBeNull();

    // Select Enrollment as association class
    fireEvent.change(assocClassSelect, { target: { value: enrollmentId } });

    const projected = projectYDocToDiagram(doc);
    expect(projected.associations[0]?.associationClassId).toBe(enrollmentId);
  });
});
