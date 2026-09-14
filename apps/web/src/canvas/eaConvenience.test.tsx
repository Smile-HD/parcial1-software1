import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { buildYDocFromDiagram, projectYDocToDiagram, type Diagram } from '@app/core';

import { DiagramCanvas } from './DiagramCanvas';

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
});
