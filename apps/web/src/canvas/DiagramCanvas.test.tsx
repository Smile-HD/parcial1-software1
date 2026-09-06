import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type * as Y from 'yjs';

import { buildYDocFromDiagram, DiagramSchema, projectYDocToDiagram, type Diagram, type Delta } from '@app/core';

import { computeNaryCentroid, DiagramCanvas, handleCreateAssociation, handleCreateDependency, handleCreateGeneralization, handleCreateNaryAssociation, handleCreateRealization, handleDeleteDependency, handleDeleteGeneralization, handleDeleteNaryAssociation, handleDeleteRealization, handleNodeDragStop, handleSetAbstract, handleUpdateMultiplicity } from './DiagramCanvas';
import { applyDeltaToYDoc } from './applyDeltaToYDoc';

/**
 * editor:R1 â€” canvas renders EXCLUSIVELY from the Y.Doc (canonical IR).
 * No local React state is the model source of truth: nodes derive from
 * projecting the Y.Doc, and mutations flow through applyDelta before
 * being written back into the same Y.Doc so observers re-render.
 */
function makeFixture(): Diagram {
  return {
    id: crypto.randomUUID(),
    name: 'Shop',
    classes: [
      {
        id: crypto.randomUUID(),
        name: 'Customer',
        position: { x: 0, y: 0 },
        attributes: [{ id: crypto.randomUUID(), name: 'name', type: 'string' }],
        methods: [{ id: crypto.randomUUID(), name: 'getName', returnType: 'string', parameters: [] }],
      },
      {
        id: crypto.randomUUID(),
        name: 'Order',
        position: { x: 300, y: 0 },
        attributes: [],
        methods: [],
      },
    ],
    associations: [],
  };
}

/**
 * Module-scope query helpers (unit 9): jsdom keeps React Flow node wrappers
 * `visibility: hidden`, so role-based queries exclude node-internal elements.
 * Every describe block queries the container directly through these.
 */
function nodeButton(container: HTMLElement, label: string): HTMLButtonElement {
  const btn = container.querySelector(`button[aria-label="${label}"]`);
  expect(btn).not.toBeNull();
  return btn as HTMLButtonElement;
}

function nodeInput(container: HTMLElement, label: string): HTMLInputElement {
  const input = container.querySelector(`input[aria-label="${label}"]`);
  expect(input).not.toBeNull();
  return input as HTMLInputElement;
}

function nodeSelect(container: HTMLElement, label: string): HTMLSelectElement {
  const select = container.querySelector(`select[aria-label="${label}"]`);
  expect(select).not.toBeNull();
  return select as HTMLSelectElement;
}

describe('DiagramCanvas (renders exclusively from Y.Doc)', () => {
  it('renders one React Flow node per class found in the Y.Doc', () => {
    const diagram = makeFixture();
    const doc = buildYDocFromDiagram(diagram);

    const { container } = render(<DiagramCanvas doc={doc} />);

    expect(container.querySelectorAll('.react-flow__node')).toHaveLength(2);
    expect(screen.getByText('Customer')).toBeTruthy();
    expect(screen.getByText('Order')).toBeTruthy();
  });

  it('re-renders when a delta is applied through applyDelta to the same Y.Doc', () => {
    const diagram = makeFixture();
    const doc = buildYDocFromDiagram(diagram);
    const { container } = render(<DiagramCanvas doc={doc} />);
    expect(container.querySelectorAll('.react-flow__node')).toHaveLength(2);

    const createProduct: Delta = {
      kind: 'class',
      op: 'create',
      id: crypto.randomUUID(),
      diagramId: diagram.id,
      timestamp: new Date().toISOString(),
      classId: crypto.randomUUID(),
      name: 'Product',
      position: { x: 600, y: 0 },
    };

    act(() => {
      const result = applyDeltaToYDoc(doc, createProduct);
      expect(result.ok).toBe(true);
    });

    expect(container.querySelectorAll('.react-flow__node')).toHaveLength(3);
    expect(screen.getByText('Product')).toBeTruthy();
  });

  it('adds a class node when the user clicks "Add class" (create delta)', () => {
    const diagram = makeFixture();
    const doc = buildYDocFromDiagram(diagram);
    const { container } = render(<DiagramCanvas doc={doc} />);
    expect(container.querySelectorAll('.react-flow__node')).toHaveLength(2);

    fireEvent.click(screen.getByRole('button', { name: 'Add class' }));

    expect(container.querySelectorAll('.react-flow__node')).toHaveLength(3);
    expect(screen.getByText('Class1')).toBeTruthy();
  });

  it('re-renders with the new name when a rename delta is applied through applyDeltaToYDoc', () => {
    const diagram = makeFixture();
    const doc = buildYDocFromDiagram(diagram);
    render(<DiagramCanvas doc={doc} />);
    expect(screen.getByText('Customer')).toBeTruthy();

    const customerId = diagram.classes[0]!.id;
    const renameDelta: Delta = {
      kind: 'class',
      op: 'rename',
      id: crypto.randomUUID(),
      diagramId: diagram.id,
      timestamp: new Date().toISOString(),
      classId: customerId,
      newName: 'Client',
    };

    act(() => {
      const result = applyDeltaToYDoc(doc, renameDelta);
      expect(result.ok).toBe(true);
    });

    expect(screen.getByText('Client')).toBeTruthy();
    expect(screen.queryByText('Customer')).toBeNull();
  });

  it('repositions a class when the drag-end handler fires (reposition delta)', () => {
    const diagram = makeFixture();
    const doc = buildYDocFromDiagram(diagram);
    const { container } = render(<DiagramCanvas doc={doc} />);
    expect(container.querySelectorAll('.react-flow__node')).toHaveLength(2);

    const customerId = diagram.classes[0]!.id;
    act(() => {
      handleNodeDragStop(doc, diagram.id, {
        id: customerId,
        position: { x: 150, y: 240 },
      });
    });

    const projected = projectYDocToDiagram(doc);
    const moved = projected.classes.find((c) => c.id === customerId);
    expect(moved?.position).toEqual({ x: 150, y: 240 });
  });

  it('removes a class and its association when the node delete button is clicked (delete delta)', () => {
    const diagram = makeFixture();
    diagram.associations = [{
      id: crypto.randomUUID(),
      sourceClassId: diagram.classes[0]!.id,
      targetClassId: diagram.classes[1]!.id,
      sourceMultiplicity: '1',
      targetMultiplicity: '0..*',
      directed: false,
    }];
    const doc = buildYDocFromDiagram(diagram);
    const { container } = render(<DiagramCanvas doc={doc} />);

    expect(projectYDocToDiagram(doc).associations).toHaveLength(1);
    expect(container.querySelectorAll('.react-flow__node')).toHaveLength(2);

    const deleteButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Delete Customer"]',
    );
    expect(deleteButton).not.toBeNull();
    fireEvent.click(deleteButton!);

    const projected = projectYDocToDiagram(doc);
    expect(projected.associations).toHaveLength(0);
    expect(projected.classes.map((c) => c.id)).not.toContain(diagram.classes[0]!.id);
    expect(container.querySelectorAll('.react-flow__node')).toHaveLength(1);
  });
});

describe('6.3a attribute editing (member add/remove via applyDeltaToYDoc)', () => {
  it('persists a new attribute with its declared type when name + type are added', () => {
    const diagram = makeFixture();
    const doc = buildYDocFromDiagram(diagram);
    const { container } = render(<DiagramCanvas doc={doc} />);

    // Add-row lives inside the first class node (Customer).
    const customerNode = container.querySelector('.react-flow__node');
    expect(customerNode).not.toBeNull();
    const nameInput = customerNode!.querySelector<HTMLInputElement>('input[aria-label="Attribute name"]');
    const typeInput = customerNode!.querySelector<HTMLInputElement>('input[aria-label="Attribute type"]');
    const addButton = customerNode!.querySelector<HTMLButtonElement>('button[aria-label="Add attribute"]');
    expect(nameInput).not.toBeNull();
    expect(typeInput).not.toBeNull();
    expect(addButton).not.toBeNull();

    fireEvent.change(nameInput!, { target: { value: 'price' } });
    fireEvent.change(typeInput!, { target: { value: 'BigDecimal' } });
    fireEvent.click(addButton!);

    const projected = projectYDocToDiagram(doc);
    const customer = projected.classes.find((c) => c.name === 'Customer');
    expect(customer?.attributes.some((a) => a.name === 'price' && a.type === 'BigDecimal')).toBe(true);
    // Visible in the rendered node, not just the projection.
    const members = Array.from(container.querySelectorAll('.uml-class__member'));
    expect(members.some((m) => m.textContent?.includes('price: BigDecimal'))).toBe(true);
  });

  it('rejects a blank attribute name with a visible validation message and leaves the model unchanged', () => {
    const diagram = makeFixture();
    const doc = buildYDocFromDiagram(diagram);
    const { container } = render(<DiagramCanvas doc={doc} />);

    const customerNode = container.querySelector('.react-flow__node');
    const nameInput = customerNode!.querySelector<HTMLInputElement>('input[aria-label="Attribute name"]');
    const addButton = customerNode!.querySelector<HTMLButtonElement>('button[aria-label="Add attribute"]');

    fireEvent.change(nameInput!, { target: { value: '   ' } });
    fireEvent.click(addButton!);

    const message = container.querySelector('[role="alert"]');
    expect(message).not.toBeNull();
    expect(message!.textContent).toMatch(/name/i);

    const projected = projectYDocToDiagram(doc);
    const customer = projected.classes.find((c) => c.name === 'Customer');
    expect(customer?.attributes).toHaveLength(1); // only the fixture attribute remains
    expect(customer?.attributes.some((a) => a.name === 'price')).toBe(false);
  });

  it('removes an attribute when its remove button is clicked', () => {
    const diagram = makeFixture();
    const doc = buildYDocFromDiagram(diagram);
    const { container } = render(<DiagramCanvas doc={doc} />);
    const customerId = diagram.classes[0]!.id;
    const fixtureAttr = diagram.classes[0]!.attributes[0]!;

    expect(projectYDocToDiagram(doc).classes.find((c) => c.id === customerId)?.attributes).toHaveLength(1);

    const removeButton = container.querySelector<HTMLButtonElement>(
      `button[aria-label="Remove attribute ${fixtureAttr.name}"]`,
    );
    expect(removeButton).not.toBeNull();
    fireEvent.click(removeButton!);

    const projected = projectYDocToDiagram(doc);
    const customer = projected.classes.find((c) => c.id === customerId);
    expect(customer?.attributes).toHaveLength(0);
    expect(customer?.attributes.some((a) => a.id === fixtureAttr.id)).toBe(false);
  });
});

describe('6.3b method editing (member add/remove via applyDeltaToYDoc)', () => {
  it('persists a new method with return type and parameter list when name + return + params are added', () => {
    const diagram = makeFixture();
    const doc = buildYDocFromDiagram(diagram);
    const { container } = render(<DiagramCanvas doc={doc} />);

    // Add-row lives inside the first class node (Customer).
    const customerNode = container.querySelector('.react-flow__node');
    expect(customerNode).not.toBeNull();
    const nameInput = customerNode!.querySelector<HTMLInputElement>('input[aria-label="Method name"]');
    const returnInput = customerNode!.querySelector<HTMLInputElement>('input[aria-label="Method return type"]');
    const paramsInput = customerNode!.querySelector<HTMLInputElement>('input[aria-label="Method parameters"]');
    const addButton = customerNode!.querySelector<HTMLButtonElement>('button[aria-label="Add method"]');
    expect(nameInput).not.toBeNull();
    expect(returnInput).not.toBeNull();
    expect(paramsInput).not.toBeNull();
    expect(addButton).not.toBeNull();

    fireEvent.change(nameInput!, { target: { value: 'getPrice' } });
    fireEvent.change(returnInput!, { target: { value: 'BigDecimal' } });
    fireEvent.change(paramsInput!, { target: { value: 'amount: BigDecimal' } });
    fireEvent.click(addButton!);

    const projected = projectYDocToDiagram(doc);
    const customer = projected.classes.find((c) => c.name === 'Customer');
    const added = customer?.methods.find((m) => m.name === 'getPrice');
    expect(added?.returnType).toBe('BigDecimal');
    expect(added?.parameters).toEqual([{ name: 'amount', type: 'BigDecimal' }]);
    // Visible in the rendered node, not just the projection.
    const members = Array.from(container.querySelectorAll('.uml-class__member'));
    expect(members.some((m) => m.textContent?.includes('getPrice(BigDecimal): BigDecimal'))).toBe(true);
  });

  it('rejects a blank method name with a visible validation message and leaves the model unchanged', () => {
    const diagram = makeFixture();
    const doc = buildYDocFromDiagram(diagram);
    const { container } = render(<DiagramCanvas doc={doc} />);

    const customerNode = container.querySelector('.react-flow__node');
    const nameInput = customerNode!.querySelector<HTMLInputElement>('input[aria-label="Method name"]');
    const addButton = customerNode!.querySelector<HTMLButtonElement>('button[aria-label="Add method"]');

    fireEvent.change(nameInput!, { target: { value: '   ' } });
    fireEvent.click(addButton!);

    const message = container.querySelector('[role="alert"]');
    expect(message).not.toBeNull();
    expect(message!.textContent).toMatch(/method name/i);

    const projected = projectYDocToDiagram(doc);
    const customer = projected.classes.find((c) => c.name === 'Customer');
    expect(customer?.methods).toHaveLength(1); // only the fixture method remains
    expect(customer?.methods.some((m) => m.name === 'getPrice')).toBe(false);
  });

  it('removes a method when its remove button is clicked', () => {
    const diagram = makeFixture();
    const doc = buildYDocFromDiagram(diagram);
    const { container } = render(<DiagramCanvas doc={doc} />);
    const customerId = diagram.classes[0]!.id;
    const fixtureMethod = diagram.classes[0]!.methods[0]!;

    expect(projectYDocToDiagram(doc).classes.find((c) => c.id === customerId)?.methods).toHaveLength(1);

    const removeButton = container.querySelector<HTMLButtonElement>(
      `button[aria-label="Remove method ${fixtureMethod.name}"]`,
    );
    expect(removeButton).not.toBeNull();
    fireEvent.click(removeButton!);

    const projected = projectYDocToDiagram(doc);
    const customer = projected.classes.find((c) => c.id === customerId);
    expect(customer?.methods).toHaveLength(0);
    expect(customer?.methods.some((m) => m.id === fixtureMethod.id)).toBe(false);
  });
});

describe('6.4a association creation between two classes (editor:R4 â€” first half)', () => {
  it('creates an undirected association with default multiplicities between two existing classes', () => {
    const diagram = makeFixture();
    const doc = buildYDocFromDiagram(diagram);
    const source = diagram.classes[0]!;
    const target = diagram.classes[1]!;

    act(() => {
      handleCreateAssociation(doc, diagram.id, {
        sourceClassId: source.id,
        targetClassId: target.id,
        directed: false,
      });
    });

    const projected = projectYDocToDiagram(doc);
    expect(projected.associations).toHaveLength(1);
    const assoc = projected.associations[0]!;
    expect(assoc.sourceClassId).toBe(source.id);
    expect(assoc.targetClassId).toBe(target.id);
    expect(assoc.directed).toBe(false);
    expect(assoc.sourceMultiplicity).toBe('1');
    expect(assoc.targetMultiplicity).toBe('1');
  });

  it('creates a directed association flagged in the projection when directed=true', () => {
    const diagram = makeFixture();
    const doc = buildYDocFromDiagram(diagram);
    const source = diagram.classes[0]!;
    const target = diagram.classes[1]!;

    act(() => {
      handleCreateAssociation(doc, diagram.id, {
        sourceClassId: source.id,
        targetClassId: target.id,
        directed: true,
      });
    });

    const projected = projectYDocToDiagram(doc);
    expect(projected.associations).toHaveLength(1);
    expect(projected.associations[0]!.directed).toBe(true);
  });
});

describe('6.4b multiplicity editing (editor:R4 â€” second half)', () => {
  function makeAssociationFixture(): { diagram: Diagram; doc: Y.Doc; associationId: string } {
    const diagram = makeFixture();
    diagram.associations = [{
      id: crypto.randomUUID(),
      sourceClassId: diagram.classes[0]!.id,
      targetClassId: diagram.classes[1]!.id,
      sourceMultiplicity: '1',
      targetMultiplicity: '1',
      directed: false,
    }];
    const doc = buildYDocFromDiagram(diagram);
    return { diagram, doc, associationId: diagram.associations[0]!.id };
  }

  it('updates an endpoint multiplicity to a valid enum value and the projection reflects it', () => {
    const { diagram, doc, associationId } = makeAssociationFixture();

    act(() => {
      handleUpdateMultiplicity(doc, diagram.id, associationId, 'source', '0..*');
    });

    const assoc = projectYDocToDiagram(doc).associations.find((a) => a.id === associationId);
    expect(assoc?.sourceMultiplicity).toBe('0..*');
    expect(assoc?.targetMultiplicity).toBe('1'); // untouched endpoint unchanged
  });

  it('accepts UML 2.5.1 arbitrary multiplicities (3..7, 2, *) — R4 modified by the compliance amendment', () => {
    const { diagram, doc, associationId } = makeAssociationFixture();

    act(() => {
      handleUpdateMultiplicity(doc, diagram.id, associationId, 'source', '3..7');
    });
    expect(projectYDocToDiagram(doc).associations.find((a) => a.id === associationId)?.sourceMultiplicity).toBe('3..7');

    act(() => {
      handleUpdateMultiplicity(doc, diagram.id, associationId, 'source', '2');
    });
    expect(projectYDocToDiagram(doc).associations.find((a) => a.id === associationId)?.sourceMultiplicity).toBe('2');

    act(() => {
      handleUpdateMultiplicity(doc, diagram.id, associationId, 'source', '*');
    });
    expect(projectYDocToDiagram(doc).associations.find((a) => a.id === associationId)?.sourceMultiplicity).toBe('*');
  });

  it('rejects non-numeric garbage: no delta emitted, previous value retained', () => {
    const { diagram, doc, associationId } = makeAssociationFixture();
    let threw: unknown = null;

    act(() => {
      try {
        handleUpdateMultiplicity(doc, diagram.id, associationId, 'source', 'abc');
      } catch (error) {
        threw = error;
      }
    });

    expect(threw).toBeNull();
    const assoc = projectYDocToDiagram(doc).associations.find((a) => a.id === associationId);
    expect(assoc?.sourceMultiplicity).toBe('1'); // previous value retained
    expect(assoc?.targetMultiplicity).toBe('1');
  });

  it('renders the multiplicity editor with two free text inputs when an edge is clicked, and editing updates the model', async () => {
    const diagram = makeFixture();
    diagram.associations = [{ id: crypto.randomUUID(), sourceClassId: diagram.classes[0]!.id, targetClassId: diagram.classes[1]!.id, sourceMultiplicity: '1', targetMultiplicity: '1', directed: false }];
    const doc = buildYDocFromDiagram(diagram);
    const { container } = render(<DiagramCanvas doc={doc} />);

    expect(screen.queryByLabelText('Source multiplicity')).toBeNull();

    const edge = await waitFor(() => {
      const el = container.querySelector('.react-flow__edge');
      expect(el).not.toBeNull();
      return el!;
    });
    expect(edge).not.toBeNull();
    fireEvent.click(edge!);

    const source = screen.getByLabelText('Source multiplicity') as HTMLInputElement;
    const target = screen.getByLabelText('Target multiplicity') as HTMLInputElement;
    expect(source.tagName).toBe('INPUT');
    expect(target.tagName).toBe('INPUT');
    expect(source.value).toBe('1');
    expect(target.value).toBe('1');

    // Free text: arbitrary UML range accepted on blur.
    fireEvent.change(source, { target: { value: '3..7' } });
    fireEvent.blur(source);
    expect(projectYDocToDiagram(doc).associations[0]!.sourceMultiplicity).toBe('3..7');

    // Garbage retained: the model keeps the previous value.
    fireEvent.change(target, { target: { value: 'abc' } });
    fireEvent.blur(target);
    expect(projectYDocToDiagram(doc).associations[0]!.targetMultiplicity).toBe('1');
  });
});

describe('editor:R3 â€” in-place member editing', () => {
  function nodeAlertText(container: HTMLElement): string {
    const alert = container.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    return (alert as HTMLElement).textContent ?? '';
  }

  it('edits an attribute via the edit control and emits an editAttribute delta', () => {
    const diagram = makeFixture(); // Customer has attribute `name: string`
    const doc = buildYDocFromDiagram(diagram);
    const { container } = render(<DiagramCanvas doc={doc} />);

    fireEvent.click(nodeButton(container, 'Edit attribute name'));

    const nameInput = nodeInput(container, 'Edit attribute name');
    const typeInput = nodeInput(container, 'Edit attribute type');
    expect(nameInput.value).toBe('name');
    expect(typeInput.value).toBe('string');

    fireEvent.change(nameInput, { target: { value: 'email' } });
    fireEvent.click(nodeButton(container, 'Confirm edit'));

    expect(screen.getByText('+email: string')).toBeTruthy();
    const projected = projectYDocToDiagram(doc);
    expect(projected.classes[0]!.attributes[0]).toMatchObject({ name: 'email', type: 'string' });
  });

  it('edits a method return type and parameters via an editMethod delta', () => {
    const diagram = makeFixture(); // Customer has method getName(): string
    const doc = buildYDocFromDiagram(diagram);
    const { container } = render(<DiagramCanvas doc={doc} />);

    fireEvent.click(nodeButton(container, 'Edit method getName'));

    const returnInput = nodeInput(container, 'Edit method return type');
    const paramsInput = nodeInput(container, 'Edit method parameters');
    expect(returnInput.value).toBe('string');
    expect(paramsInput.value).toBe('');

    fireEvent.change(returnInput, { target: { value: 'BigDecimal' } });
    fireEvent.change(paramsInput, { target: { value: 'id: String' } });
    fireEvent.click(nodeButton(container, 'Confirm edit'));

    expect(screen.getByText('+getName(String): BigDecimal')).toBeTruthy();
    const method = projectYDocToDiagram(doc).classes[0]!.methods[0]!;
    expect(method.returnType).toBe('BigDecimal');
    expect(method.parameters).toEqual([{ name: 'id', type: 'String' }]);
  });

  it('rejects a blank member edit with a validation message and no delta (previous value retained)', () => {
    const diagram = makeFixture();
    const doc = buildYDocFromDiagram(diagram);
    const { container } = render(<DiagramCanvas doc={doc} />);

    fireEvent.click(nodeButton(container, 'Edit attribute name'));
    fireEvent.change(nodeInput(container, 'Edit attribute name'), { target: { value: '   ' } });
    fireEvent.click(nodeButton(container, 'Confirm edit'));

    expect(nodeAlertText(container)).toContain('Name and type are required');
    // Model unchanged: the previous attribute value is retained.
    expect(projectYDocToDiagram(doc).classes[0]!.attributes[0]).toMatchObject({ name: 'name' });
  });

  it('cancel edit discards the draft without emitting any delta', () => {
    const diagram = makeFixture();
    const doc = buildYDocFromDiagram(diagram);
    const { container } = render(<DiagramCanvas doc={doc} />);

    fireEvent.click(nodeButton(container, 'Edit attribute name'));
    fireEvent.change(nodeInput(container, 'Edit attribute name'), { target: { value: 'email' } });
    fireEvent.click(nodeButton(container, 'Cancel edit'));

    expect(screen.getByText('+name: string')).toBeTruthy();
    expect(projectYDocToDiagram(doc).classes[0]!.attributes[0]).toMatchObject({ name: 'name' });
  });
});

describe('UML member adornments render (unit 9.3)', () => {
  it('renders visibility prefix, derived slash, multiplicity and static underline class', () => {
    const diagram: Diagram = {
      id: crypto.randomUUID(),
      name: 'Adorn',
      classes: [
        {
          id: crypto.randomUUID(),
          name: 'Product',
          position: { x: 0, y: 0 },
          attributes: [
            { id: crypto.randomUUID(), name: 'secret', type: 'string', visibility: '-', isStatic: false, isDerived: false },
            { id: crypto.randomUUID(), name: 'total', type: 'number', visibility: '+', isStatic: false, isDerived: true, multiplicity: '0..*' },
          ],
          methods: [
            { id: crypto.randomUUID(), name: 'count', returnType: 'int', parameters: [], visibility: '#', isStatic: true },
          ],
        },
      ],
      associations: [],
    };
    const doc = buildYDocFromDiagram(diagram);

    render(<DiagramCanvas doc={doc} />);

    expect(screen.getByText('-secret: string')).toBeTruthy();
    expect(screen.getByTestId('attr-total').textContent).toBe('+/total: number [0..*]');
    expect(screen.getByTestId('method-count').textContent).toBe('#count(): int');
    // Static members get the underline class.
    expect(screen.getByTestId('method-count').className).toContain('uml-member--static');
    expect(screen.getByTestId('attr-total').className).not.toContain('uml-member--static');
  });
});

describe('unit 9 — editor wiring: adornments flow from controls to the model', () => {
  it('adding an attribute with private/derived/0..* controls stores the adornments', () => {
    const diagram = makeFixture();
    const doc = buildYDocFromDiagram(diagram);
    const { container } = render(<DiagramCanvas doc={doc} />);

    const vis = nodeSelect(container, 'Attribute visibility');
    expect(vis).not.toBeNull();
    fireEvent.change(vis, { target: { value: '-' } });
    fireEvent.change(nodeInput(container, 'Attribute name'), { target: { value: 'secret' } });
    fireEvent.change(nodeInput(container, 'Attribute type'), { target: { value: 'string' } });
    fireEvent.change(nodeInput(container, 'Attribute multiplicity'), { target: { value: '0..*' } });
    fireEvent.click(nodeInput(container, 'Attribute derived'));
    fireEvent.click(nodeButton(container, 'Add attribute'));

    const customer = projectYDocToDiagram(doc).classes[0]!;
    const attr = customer.attributes.find((a) => a.name === 'secret');
    expect(attr).toBeDefined();
    expect(attr!.visibility).toBe('-');
    expect(attr!.isDerived).toBe(true);
    expect(attr!.multiplicity).toBe('0..*');
    // And the render shows the UML notation: private + derived slash + multiplicity.
    expect(screen.getByText('-/secret: string [0..*]')).toBeTruthy();
  });

  it('adding a method with static checkbox stores isStatic', () => {
    const diagram = makeFixture();
    const doc = buildYDocFromDiagram(diagram);
    const { container } = render(<DiagramCanvas doc={doc} />);

    fireEvent.change(nodeSelect(container, 'Method visibility'), { target: { value: '#' } });
    fireEvent.change(nodeInput(container, 'Method name'), { target: { value: 'count' } });
    fireEvent.change(nodeInput(container, 'Method return type'), { target: { value: 'int' } });
    fireEvent.click(nodeInput(container, 'Method static'));
    fireEvent.click(nodeButton(container, 'Add method'));

    const customer = projectYDocToDiagram(doc).classes[0]!;
    const method = customer.methods.find((m) => m.name === 'count');
    expect(method).toBeDefined();
    expect(method!.visibility).toBe('#');
    expect(method!.isStatic).toBe(true);
    expect(screen.getByTestId('method-count').className).toContain('uml-member--static');
  });
});

describe('aggregation/composition render (unit 10.3)', () => {
  function assocFixture(fields: Partial<Diagram['associations'][number]>): Diagram {
    const diagram = makeFixture();
    diagram.associations = [
      {
        id: crypto.randomUUID(),
        sourceClassId: diagram.classes[0]!.id,
        targetClassId: diagram.classes[1]!.id,
        sourceMultiplicity: '0..1',
        targetMultiplicity: '1..*',
        directed: false,
        ...fields,
      },
    ];
    return diagram;
  }

  async function edgeContent(container: HTMLElement): Promise<SVGSVGElement | HTMLElement> {
    return await waitFor(() => {
      const el = container.querySelector('.react-flow__edge');
      expect(el).not.toBeNull();
      return (el!.querySelector('svg') ?? el!) as SVGSVGElement | HTMLElement;
    });
  }

  function baseEdgePath(svg: SVGSVGElement | HTMLElement): SVGPathElement {
    const path = Array.from(svg.querySelectorAll('path')).find((p) => !p.closest('marker'));
    expect(path).toBeDefined();
    return path as SVGPathElement;
  }

  it('composite renders a filled diamond marker on the WHOLE (single) end', async () => {
    const doc = buildYDocFromDiagram(assocFixture({ aggregation: 'composite' }));
    const { container } = render(<DiagramCanvas doc={doc} />);
    const svg = await edgeContent(container);

    // Composite => a filled diamond def exists (sized in user space, dark fill).
    const compositeMarker = Array.from(svg.querySelectorAll('marker')).find((m) =>
      (m.getAttribute('id') ?? '').includes('composite-diamond'),
    );
    const filled = compositeMarker?.querySelector('path');
    expect(filled).toBeDefined();
    expect(filled.getAttribute('fill')).toBe('#1a1a2e');
    expect(compositeMarker.getAttribute('markerUnits')).toBe('userSpaceOnUse');
    expect(compositeMarker.getAttribute('markerWidth')).toBe('18');

    // Whole end: source '0..1' is the single side => diamond at marker-start.
    const base = baseEdgePath(svg);
    expect(base.getAttribute('marker-start') ?? '').toContain('composite');
  });

  it('shared renders a hollow diamond marker on the WHOLE (single) end', async () => {
    const doc = buildYDocFromDiagram(
      assocFixture({ aggregation: 'shared', sourceMultiplicity: '0..*', targetMultiplicity: '1', aggregationEnd: 'target' }),
    );
    const { container } = render(<DiagramCanvas doc={doc} />);
    const svg = await edgeContent(container);

    // Shared => a hollow diamond def exists: white fill (line must not show
    // through) with a dark stroke, sized in user space.
    const sharedMarker = Array.from(svg.querySelectorAll('marker')).find((m) =>
      (m.getAttribute('id') ?? '').includes('shared-diamond'),
    );
    const hollow = sharedMarker?.querySelector('path');
    expect(hollow).toBeDefined();
    expect(hollow.getAttribute('fill')).toBe('#ffffff');
    expect(hollow.getAttribute('stroke')).toBe('#1a1a2e');
    expect((hollow.getAttribute('d') ?? '').includes('L')).toBe(true);
    expect(sharedMarker.getAttribute('markerUnits')).toBe('userSpaceOnUse');
    expect(sharedMarker.getAttribute('markerWidth')).toBe('18');

    // Diamond end is now explicitly declared via aggregationEnd='target'
    const base = baseEdgePath(svg);
    expect(base.getAttribute('marker-end') ?? '').toContain('shared');
  });

  it('renders association name centered and role labels at the ends', async () => {
    const doc = buildYDocFromDiagram(
      assocFixture({ aggregation: 'none', name: 'places', sourceRole: 'shop', targetRole: 'items' }),
    );
    const { container } = render(<DiagramCanvas doc={doc} />);
    const svg = await edgeContent(container);

    const texts = Array.from(svg.querySelectorAll('text')).map((t) => t.textContent ?? '');
    expect(texts.some((t) => t.includes('places'))).toBe(true);
    expect(texts.some((t) => t.includes('shop'))).toBe(true);
    expect(texts.some((t) => t.includes('items'))).toBe(true);
  });

  it('directed association renders an arrow marker (regression: pre-10 edge markerEnd)', async () => {
    const doc = buildYDocFromDiagram(assocFixture({ directed: true }));
    const { container } = render(<DiagramCanvas doc={doc} />);
    const svg = await edgeContent(container);

    const base = baseEdgePath(svg);
    const markers = `${base.getAttribute('marker-start') ?? ''} ${base.getAttribute('marker-end') ?? ''}`;
    expect(markers).toContain('arrow');
  });

  it('plain association (aggregation none, undirected) renders no diamond marker', async () => {
    const doc = buildYDocFromDiagram(assocFixture({}));
    const { container } = render(<DiagramCanvas doc={doc} />);
    const svg = await edgeContent(container);

    const base = baseEdgePath(svg);
    const markers = `${base.getAttribute('marker-start') ?? ''} ${base.getAttribute('marker-end') ?? ''}`;
    expect(markers).not.toContain('diamond');
  });

  it('base edge path has valid geometry (regression: getBezierPath tuple passed as d)', async () => {
    const doc = buildYDocFromDiagram(assocFixture({}));
    const { container } = render(<DiagramCanvas doc={doc} />);
    const svg = await edgeContent(container);

    const base = baseEdgePath(svg);
    const d = base.getAttribute('d') ?? '';
    // Valid path data: exactly one move command with real geometry.
    // (Regression: BaseEdge ignores `d`; the path string must arrive via the `path` prop.)
    expect(d.startsWith('M')).toBe(true);
    expect((d.match(/M/g) ?? []).length).toBe(1);
    expect(d.length).toBeGreaterThan(10);
  });

  it('editing aggregation/name/roles in the panel updates the Y.Doc (unit 10.4 E2E)', async () => {
    const doc = buildYDocFromDiagram(assocFixture({ directed: false }));
    const { container } = render(<DiagramCanvas doc={doc} />);

    const edge = await waitFor(() => {
      const el = container.querySelector('.react-flow__edge');
      expect(el).not.toBeNull();
      return el!;
    });
    fireEvent.click(edge);

    // Aggregation applies on change
    const aggSelect = screen.getByLabelText('Aggregation kind') as HTMLSelectElement;
    fireEvent.change(aggSelect, { target: { value: 'composite' } });
    expect(projectYDocToDiagram(doc).associations[0]!.aggregation).toBe('composite');

    // Name/roles apply on blur
    const nameInput = screen.getByLabelText('Association name') as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: 'contains' } });
    fireEvent.blur(nameInput);
    expect(projectYDocToDiagram(doc).associations[0]!.name).toBe('contains');

    const roleInput = screen.getByLabelText('Target role') as HTMLInputElement;
    fireEvent.change(roleInput, { target: { value: 'lines' } });
    fireEvent.blur(roleInput);
    expect(projectYDocToDiagram(doc).associations[0]!.targetRole).toBe('lines');
  });

  it('multiplicity heuristic is GONE: aggregationEnd="source" puts diamond at marker-start regardless of multiplicities', async () => {
    // Source '1' (single), target '1..*' (many) — old heuristic would put diamond at source.
    // But with aggregationEnd='source' explicitly, diamond goes to marker-start (source).
    const doc = buildYDocFromDiagram(
      assocFixture({ aggregation: 'composite', sourceMultiplicity: '1', targetMultiplicity: '1..*', aggregationEnd: 'source' }),
    );
    const { container } = render(<DiagramCanvas doc={doc} />);
    const svg = await edgeContent(container);

    const compositeMarker = Array.from(svg.querySelectorAll('marker')).find((m) =>
      (m.getAttribute('id') ?? '').includes('composite-diamond'),
    );
    expect(compositeMarker).toBeDefined();

    const base = baseEdgePath(svg);
    // Diamond at source end (marker-start) because aggregationEnd='source' explicitly
    expect(base.getAttribute('marker-start') ?? '').toContain('composite');
    expect(base.getAttribute('marker-end') ?? '').not.toContain('composite');
  });

  it('panel "Aggregation end" select updates aggregationEnd via delta', async () => {
    const doc = buildYDocFromDiagram(assocFixture({ aggregation: 'composite', directed: false }));
    const { container } = render(<DiagramCanvas doc={doc} />);

    const edge = await waitFor(() => {
      const el = container.querySelector('.react-flow__edge');
      expect(el).not.toBeNull();
      return el!;
    });
    fireEvent.click(edge);

    // Initially aggregationEnd defaults to 'source'
    let assoc = projectYDocToDiagram(doc).associations[0]!;
    expect(assoc.aggregationEnd).toBe('source');

    // Find and change the Aggregation end select
    const endSelect = screen.getByLabelText('Aggregation end') as HTMLSelectElement;
    expect(endSelect).not.toBeNull();
    fireEvent.change(endSelect, { target: { value: 'target' } });

    // Model should update
    assoc = projectYDocToDiagram(doc).associations[0]!;
    expect(assoc.aggregationEnd).toBe('target');
  });

  it('deletes the association when the panel delete button is clicked (association delete delta)', async () => {
    const fixture = assocFixture({});
    const doc = buildYDocFromDiagram(fixture);
    const { container } = render(<DiagramCanvas doc={doc} />);

    expect(projectYDocToDiagram(doc).associations).toHaveLength(1);

    // Select the edge to open the association panel
    const edge = await waitFor(() => {
      const el = container.querySelector('.react-flow__edge');
      expect(el).not.toBeNull();
      return el!;
    });
    fireEvent.click(edge);

    const deleteButton = screen.getByRole('button', { name: /delete association/i });
    fireEvent.click(deleteButton);

    // The association is gone from the model and the canvas; classes survive
    const projected = projectYDocToDiagram(doc);
    expect(projected.associations).toHaveLength(0);
    expect(projected.classes).toHaveLength(2);
    expect(container.querySelectorAll('.react-flow__edge')).toHaveLength(0);
  });
});

describe('unit 11 — generalization render (11.3)', () => {
  function genFixture(): { diagram: Diagram; itemId: string; productId: string; genId: string } {
    const diagram = makeFixture(); // Customer, Order
    const itemId = diagram.classes[1]!.id;   // Item role: Order
    const productId = diagram.classes[0]!.id; // Product role: Customer
    const genId = crypto.randomUUID();
    diagram.generalizations = [{ id: genId, subClassId: productId, superClassId: itemId }];
    return { diagram, itemId, productId, genId };
  }

  async function edgeContent(container: HTMLElement): Promise<SVGSVGElement | HTMLElement> {
    return await waitFor(() => {
      const el = container.querySelector('.react-flow__edge');
      expect(el).not.toBeNull();
      return (el!.querySelector('svg') ?? el!) as SVGSVGElement | HTMLElement;
    });
  }

  it('renders a generalization edge with a hollow triangle marker at the SUPERCLASS end', async () => {
    const { diagram } = genFixture();
    const doc = buildYDocFromDiagram(diagram);
    const { container } = render(<DiagramCanvas doc={doc} />);

    const svg = await edgeContent(container);

    // Hollow triangle def exists: white fill (line must not show through)
    // with a dark stroke — the UML generalization arrowhead.
    const triangleMarker = Array.from(svg.querySelectorAll('marker')).find((m) =>
      (m.getAttribute('id') ?? '').includes('generalization-triangle'),
    );
    expect(triangleMarker).toBeDefined();
    const trianglePath = triangleMarker!.querySelector('path');
    expect(trianglePath).toBeDefined();
    expect(trianglePath!.getAttribute('fill')).toBe('#ffffff');
    expect(trianglePath!.getAttribute('stroke')).toBe('#1a1a2e');

    // The triangle sits on the target (superClass) end: marker-end references it.
    const basePath = Array.from(svg.querySelectorAll('path')).find((p) => !p.closest('marker'));
    expect(basePath).toBeDefined();
    expect(basePath!.getAttribute('marker-end') ?? '').toContain('generalization-triangle');
  });

  it('generalization edges render alongside associations (separate edge type)', async () => {
    const diagram = makeFixture();
    diagram.associations = [{
      id: crypto.randomUUID(),
      sourceClassId: diagram.classes[0]!.id,
      targetClassId: diagram.classes[1]!.id,
      sourceMultiplicity: '1',
      targetMultiplicity: '1',
      directed: false,
    }];
    diagram.generalizations = [{
      id: crypto.randomUUID(),
      subClassId: diagram.classes[0]!.id,
      superClassId: diagram.classes[1]!.id,
    }];
    const doc = buildYDocFromDiagram(diagram);
    const { container } = render(<DiagramCanvas doc={doc} />);

    await waitFor(() => {
      expect(container.querySelectorAll('.react-flow__edge')).toHaveLength(2);
    });
  });

  it('handleCreateGeneralization writes the edge through applyDeltaToYDoc (bridge round-trip)', () => {
    const { diagram, itemId, productId } = genFixture();
    const doc = buildYDocFromDiagram(diagram);
    // Start clean: no generalizations yet.
    diagram.generalizations = [];
    const cleanDoc = buildYDocFromDiagram(diagram);

    act(() => {
      handleCreateGeneralization(cleanDoc, diagram.id, { subClassId: productId, superClassId: itemId });
    });

    const projected = projectYDocToDiagram(cleanDoc);
    expect(projected.generalizations).toHaveLength(1);
    expect(projected.generalizations[0]).toMatchObject({ subClassId: productId, superClassId: itemId });
    // doc (the fixture-built one) is untouched
    expect(projectYDocToDiagram(doc).generalizations).toHaveLength(1);
  });

  it('handleCreateGeneralization rejects a cyclic request leaving the model unchanged', () => {
    const { diagram, itemId, productId, genId } = genFixture();
    const doc = buildYDocFromDiagram(diagram);

    act(() => {
      // itemId → productId would close the 2-cycle with the existing productId → itemId edge.
      handleCreateGeneralization(doc, diagram.id, { subClassId: itemId, superClassId: productId });
    });

    const projected = projectYDocToDiagram(doc);
    expect(projected.generalizations).toHaveLength(1);
    expect(projected.generalizations[0]!.id).toBe(genId);
  });

  it('handleDeleteGeneralization removes the edge from the Y.Doc', () => {
    const { diagram, genId } = genFixture();
    const doc = buildYDocFromDiagram(diagram);

    act(() => {
      handleDeleteGeneralization(doc, diagram.id, genId);
    });

    expect(projectYDocToDiagram(doc).generalizations).toHaveLength(0);
  });
});

describe('unit 11 — editor UI: context menu + per-class generalization list (11.4)', () => {
  function genDiagram(): { diagram: Diagram; itemId: string; productId: string; genId: string } {
    const diagram = makeFixture();
    const itemId = diagram.classes[1]!.id;   // Order plays the super role
    const productId = diagram.classes[0]!.id; // Customer plays the sub role
    const genId = crypto.randomUUID();
    diagram.generalizations = [{ id: genId, subClassId: productId, superClassId: itemId }];
    return { diagram, itemId, productId, genId };
  }

  it('right-clicking a class opens a context menu with "make subclass of" actions for other classes', () => {
    const { diagram } = genDiagram();
    const doc = buildYDocFromDiagram(diagram);
    const { container } = render(<DiagramCanvas doc={doc} />);

    const customerNode = container.querySelector('.react-flow__node');
    expect(customerNode).not.toBeNull();
    fireEvent.contextMenu(customerNode!.querySelector('.uml-class')!);

    // The menu offers the OTHER class (Order) as a superclass candidate.
    const menuItem = container.querySelector('button[aria-label="Make subclass of Order"]');
    expect(menuItem).not.toBeNull();
    // It does not offer itself.
    expect(container.querySelector('button[aria-label="Make subclass of Customer"]')).toBeNull();
  });

  it('choosing "make subclass of" emits a generalization create delta into the Y.Doc', () => {
    const diagram = makeFixture(); // no generalizations initially
    const doc = buildYDocFromDiagram(diagram);
    const { container } = render(<DiagramCanvas doc={doc} />);

    const customerNode = container.querySelector('.react-flow__node');
    fireEvent.contextMenu(customerNode!.querySelector('.uml-class')!);
    fireEvent.click(container.querySelector('button[aria-label="Make subclass of Order"]')!);

    const projected = projectYDocToDiagram(doc);
    expect(projected.generalizations).toHaveLength(1);
    expect(projected.generalizations[0]).toMatchObject({
      subClassId: diagram.classes[0]!.id,
      superClassId: diagram.classes[1]!.id,
    });
  });

  it('clicking a class shows its generalizations in the editor panel with role labels', () => {
    const { diagram, genId } = genDiagram();
    const doc = buildYDocFromDiagram(diagram);
    const { container } = render(<DiagramCanvas doc={doc} />);

    const customerNode = container.querySelector('.react-flow__node');
    fireEvent.click(customerNode!.querySelector('.uml-class')!);

    const panel = screen.getByTestId('generalization-panel');
    expect(panel.textContent).toContain('Inherits from Order');

    // The superclass class node shows the mirrored entry.
    fireEvent.click(container.querySelectorAll('.react-flow__node')[1]!.querySelector('.uml-class')!);
    expect(screen.getByTestId('generalization-panel').textContent).toContain('Inherited by Customer');
  });

  it('deleting a generalization from the panel removes the edge from the model', () => {
    const { diagram, genId } = genDiagram();
    const doc = buildYDocFromDiagram(diagram);
    const { container } = render(<DiagramCanvas doc={doc} />);

    const customerNode = container.querySelector('.react-flow__node');
    fireEvent.click(customerNode!.querySelector('.uml-class')!);

    const deleteButton = screen.getByTestId('generalization-panel').querySelector<HTMLButtonElement>(
      `button[aria-label="Delete generalization ${genId}"]`,
    );
    expect(deleteButton).not.toBeNull();
    fireEvent.click(deleteButton!);

    expect(projectYDocToDiagram(doc).generalizations).toHaveLength(0);
  });
});

describe('unit 12a — interface/abstract render (12.1)', () => {
  function kindFixture(): { diagram: Diagram; classId: string; ifaceId: string; abstractId: string } {
    const classId = crypto.randomUUID();
    const ifaceId = crypto.randomUUID();
    const abstractId = crypto.randomUUID();
    const diagram: Diagram = {
      id: crypto.randomUUID(),
      name: 'Kinds',
      classes: [
        { id: classId, name: 'Order', position: { x: 0, y: 0 }, attributes: [], methods: [] },
        { id: ifaceId, name: 'Repository', position: { x: 300, y: 0 }, attributes: [], methods: [], kind: 'interface' },
        { id: abstractId, name: 'Shape', position: { x: 600, y: 0 }, attributes: [], methods: [], isAbstract: true },
      ],
      associations: [],
    };
    return { diagram: DiagramSchema.parse(diagram), classId, ifaceId, abstractId };
  }

  function nodeRootFor(container: HTMLElement, name: string): Element {
    const nameEl = Array.from(container.querySelectorAll('.uml-class__name')).find((el) => el.textContent === name);
    expect(nameEl).toBeDefined();
    return nameEl!.closest('.uml-class')!;
  }

  it('interface node renders a «interface» stereotype header with italic name and dashed-border modifier', () => {
    const { diagram } = kindFixture();
    const doc = buildYDocFromDiagram(diagram);
    const { container } = render(<DiagramCanvas doc={doc} />);

    // Stereotype header is real rendered text (UML notation), not a class name.
    expect(screen.getAllByText('«interface»').length).toBe(1);

    const ifaceRoot = nodeRootFor(container, 'Repository');
    expect(ifaceRoot.className).toContain('uml-class--interface');
    const ifaceName = Array.from(container.querySelectorAll('.uml-class__name')).find((el) => el.textContent === 'Repository');
    expect(ifaceName!.className).toContain('uml-class__name--italic');
  });

  it('abstract class renders italic name but NO stereotype and NO dashed border', () => {
    const { diagram } = kindFixture();
    const doc = buildYDocFromDiagram(diagram);
    const { container } = render(<DiagramCanvas doc={doc} />);

    const abstractRoot = nodeRootFor(container, 'Shape');
    expect(abstractRoot.className).not.toContain('uml-class--interface');
    const abstractName = Array.from(container.querySelectorAll('.uml-class__name')).find((el) => el.textContent === 'Shape');
    expect(abstractName!.className).toContain('uml-class__name--italic');
  });

  it('plain class renders solid border, upright name, no stereotype (backward compat)', () => {
    const { diagram } = kindFixture();
    const doc = buildYDocFromDiagram(diagram);
    const { container } = render(<DiagramCanvas doc={doc} />);

    const plainRoot = nodeRootFor(container, 'Order');
    expect(plainRoot.className).not.toContain('uml-class--interface');
    const plainName = Array.from(container.querySelectorAll('.uml-class__name')).find((el) => el.textContent === 'Order');
    expect(plainName!.className).not.toContain('uml-class__name--italic');
    expect(screen.getAllByText('«interface»')).toHaveLength(1); // only Repository
  });
});

describe('unit 12a — realization edge render (12.3)', () => {
  function realFixture(): { diagram: Diagram; orderId: string; repoId: string; realId: string } {
    const orderId = crypto.randomUUID();
    const repoId = crypto.randomUUID();
    const realId = crypto.randomUUID();
    const diagram = {
      id: crypto.randomUUID(),
      name: 'Realize',
      classes: [
        { id: orderId, name: 'Order', position: { x: 0, y: 0 }, attributes: [], methods: [] },
        { id: repoId, name: 'Repository', position: { x: 300, y: 0 }, attributes: [], methods: [], kind: 'interface' },
      ],
      associations: [],
      realizations: [{ id: realId, clientClassId: orderId, supplierInterfaceId: repoId }],
    };
    return { diagram: DiagramSchema.parse(diagram), orderId, repoId, realId };
  }

  it('renders a dashed line with a hollow triangle marker at the INTERFACE (target) end', async () => {
    const { diagram } = realFixture();
    const doc = buildYDocFromDiagram(diagram);
    const { container } = render(<DiagramCanvas doc={doc} />);

    const svg = await waitFor(() => {
      const el = container.querySelector('.react-flow__edge');
      expect(el).not.toBeNull();
      return (el!.querySelector('svg') ?? el!) as SVGSVGElement | HTMLElement;
    });

    // Hollow triangle def: white fill, dark stroke (UML realization arrowhead).
    const triangleMarker = Array.from(svg.querySelectorAll('marker')).find((m) =>
      (m.getAttribute('id') ?? '').includes('realization-triangle'),
    );
    expect(triangleMarker).toBeDefined();
    const trianglePath = triangleMarker!.querySelector('path');
    expect(trianglePath).toBeDefined();
    expect(trianglePath!.getAttribute('fill')).toBe('#ffffff');
    expect(trianglePath!.getAttribute('stroke')).toBe('#1a1a2e');

    // Dashed line + triangle on the target (interface) end via url(#id) string.
    const basePath = Array.from(svg.querySelectorAll('path')).find((p) => !p.closest('marker'));
    expect(basePath).toBeDefined();
    expect(basePath!.getAttribute('marker-end') ?? '').toContain('realization-triangle');
    expect(basePath!.getAttribute('stroke-dasharray')).toBeTruthy();
  });

  it('handleCreateRealization writes the edge through applyDeltaToYDoc (bridge round-trip)', () => {
    const { diagram, orderId, repoId } = realFixture();
    diagram.realizations = [];
    const doc = buildYDocFromDiagram(diagram);

    act(() => {
      handleCreateRealization(doc, diagram.id, { clientClassId: orderId, supplierInterfaceId: repoId });
    });

    const projected = projectYDocToDiagram(doc);
    expect(projected.realizations).toHaveLength(1);
    expect(projected.realizations[0]).toMatchObject({ clientClassId: orderId, supplierInterfaceId: repoId });
  });

  it('handleCreateRealization REJECTS a non-interface supplier leaving the model unchanged (runtime harness, 12.6 invariant)', () => {
    const { diagram, orderId } = realFixture();
    diagram.realizations = [];
    // Point the supplier at the plain class (Order realizes Order's peer that is NOT an interface).
    const plainSupplier = diagram.classes.find((c) => c.name === 'Order')!;
    const doc = buildYDocFromDiagram(diagram);

    act(() => {
      handleCreateRealization(doc, diagram.id, { clientClassId: plainSupplier.id, supplierInterfaceId: plainSupplier.id });
    });

    expect(projectYDocToDiagram(doc).realizations).toHaveLength(0);
  });

  it('handleDeleteRealization removes the edge from the Y.Doc', () => {
    const { diagram, realId } = realFixture();
    const doc = buildYDocFromDiagram(diagram);

    act(() => {
      handleDeleteRealization(doc, diagram.id, realId);
    });

    expect(projectYDocToDiagram(doc).realizations).toHaveLength(0);
  });

  it('handleSetAbstract toggles isAbstract through the class update delta', () => {
    const { diagram, orderId } = realFixture();
    const doc = buildYDocFromDiagram(diagram);

    act(() => {
      handleSetAbstract(doc, diagram.id, orderId, true);
    });

    const order = projectYDocToDiagram(doc).classes.find((c) => c.id === orderId)!;
    expect(order.isAbstract).toBe(true);
    expect(order.kind).toBe('class');
  });
});

describe('unit 12a — editor UI: add interface, realize + abstract in context menu, realization panel (12.4)', () => {
  function uiFixture(): { diagram: Diagram; orderId: string; repoId: string } {
    const orderId = crypto.randomUUID();
    const repoId = crypto.randomUUID();
    const diagram = {
      id: crypto.randomUUID(),
      name: 'Ui',
      classes: [
        { id: orderId, name: 'Order', position: { x: 0, y: 0 }, attributes: [], methods: [] },
        { id: repoId, name: 'Repository', position: { x: 300, y: 0 }, attributes: [], methods: [], kind: 'interface' },
      ],
      associations: [],
    };
    return { diagram: DiagramSchema.parse(diagram), orderId, repoId };
  }

  it('toolbar "Add interface" creates a class node with kind "interface"', () => {
    const { diagram } = uiFixture();
    const doc = buildYDocFromDiagram(diagram);
    const { container } = render(<DiagramCanvas doc={doc} />);

    const addButton = Array.from(container.querySelectorAll('.diagram-canvas__toolbar button')).find(
      (b) => b.textContent === 'Add interface',
    );
    expect(addButton).toBeDefined();
    fireEvent.click(addButton!);

    const created = projectYDocToDiagram(doc).classes.find((c) => c.kind === 'interface' && c.name !== 'Repository');
    expect(created).toBeDefined();
    expect(created!.isAbstract).toBe(false);
  });

  it('context menu offers "Realize <Interface>" only for interfaces and emits the create delta', () => {
    const { diagram, orderId } = uiFixture();
    const doc = buildYDocFromDiagram(diagram);
    const { container } = render(<DiagramCanvas doc={doc} />);

    const orderNode = container.querySelector('.react-flow__node');
    fireEvent.contextMenu(orderNode!.querySelector('.uml-class')!);

    // Interface candidate present; plain-class candidate (itself) absent.
    const realizeButton = container.querySelector('button[aria-label="Realize Repository"]');
    expect(realizeButton).not.toBeNull();
    fireEvent.click(realizeButton!);

    const projected = projectYDocToDiagram(doc);
    expect(projected.realizations).toHaveLength(1);
    expect(projected.realizations[0]).toMatchObject({ clientClassId: orderId, supplierInterfaceId: diagram.classes[1]!.id });
  });

  it('context menu "Mark abstract" toggle sets isAbstract on the class', () => {
    const { diagram, orderId } = uiFixture();
    const doc = buildYDocFromDiagram(diagram);
    const { container } = render(<DiagramCanvas doc={doc} />);

    const orderNode = container.querySelector('.react-flow__node');
    fireEvent.contextMenu(orderNode!.querySelector('.uml-class')!);

    const toggle = container.querySelector('button[aria-label="Mark abstract"]');
    expect(toggle).not.toBeNull();
    fireEvent.click(toggle!);

    expect(projectYDocToDiagram(doc).classes.find((c) => c.id === orderId)!.isAbstract).toBe(true);
  });

  it('clicking a class shows its realizations in the panel with role labels and remove works', () => {
    const { diagram, orderId, repoId } = uiFixture();
    const realId = crypto.randomUUID();
    (diagram as { realizations: unknown[] }).realizations = [{ id: realId, clientClassId: orderId, supplierInterfaceId: repoId }];
    const doc = buildYDocFromDiagram(diagram);
    const { container } = render(<DiagramCanvas doc={doc} />);

    // Client side: Order realizes Repository.
    const orderNode = container.querySelector('.react-flow__node');
    fireEvent.click(orderNode!.querySelector('.uml-class')!);
    const panel = screen.getByTestId('realization-panel');
    expect(panel.textContent).toContain('Realizes Repository');

    // Supplier side mirrored on the interface.
    fireEvent.click(container.querySelectorAll('.react-flow__node')[1]!.querySelector('.uml-class')!);
    expect(screen.getByTestId('realization-panel').textContent).toContain('Realized by Order');

    // Remove from the panel deletes the edge.
    fireEvent.click(container.querySelector('.react-flow__node')!.querySelector('.uml-class')!);
    const removeButton = screen.getByTestId('realization-panel').querySelector<HTMLButtonElement>(
      `button[aria-label="Delete realization ${realId}"]`,
    );
    expect(removeButton).not.toBeNull();
    fireEvent.click(removeButton!);
    expect(projectYDocToDiagram(doc).realizations).toHaveLength(0);
  });
});

describe('unit 12b — dependency edge render (12.3)', () => {
  function depFixture(): { diagram: Diagram; orderId: string; serviceId: string; depId: string } {
    const orderId = crypto.randomUUID();
    const serviceId = crypto.randomUUID();
    const depId = crypto.randomUUID();
    const diagram = {
      id: crypto.randomUUID(),
      name: 'Depends',
      classes: [
        { id: orderId, name: 'Order', position: { x: 0, y: 0 }, attributes: [], methods: [] },
        { id: serviceId, name: 'Service', position: { x: 300, y: 0 }, attributes: [], methods: [] },
      ],
      associations: [],
      dependencies: [{ id: depId, clientClassId: orderId, supplierClassId: serviceId }],
    };
    return { diagram: DiagramSchema.parse(diagram), orderId, serviceId, depId };
  }

  it('renders a dashed line with an OPEN (non-filled) arrowhead at the SUPPLIER (target) end', async () => {
    const { diagram } = depFixture();
    const doc = buildYDocFromDiagram(diagram);
    const { container } = render(<DiagramCanvas doc={doc} />);

    const svg = await waitFor(() => {
      const el = container.querySelector('.react-flow__edge');
      expect(el).not.toBeNull();
      return (el!.querySelector('svg') ?? el!) as SVGSVGElement | HTMLElement;
    });

    // Open V arrowhead def: fill NONE (non-filled) with dark stroke — the
    // UML dependency arrowhead, distinct from the realization triangle.
    const arrowMarker = Array.from(svg.querySelectorAll('marker')).find((m) =>
      (m.getAttribute('id') ?? '').includes('dependency-arrow'),
    );
    expect(arrowMarker).toBeDefined();
    const arrowPath = arrowMarker!.querySelector('path');
    expect(arrowPath).toBeDefined();
    expect(arrowPath!.getAttribute('fill')).toBe('none');
    expect(arrowPath!.getAttribute('stroke')).toBe('#1a1a2e');

    // Dashed line + open arrow on the target (supplier) end via url(#id) string.
    const basePath = Array.from(svg.querySelectorAll('path')).find((p) => !p.closest('marker'));
    expect(basePath).toBeDefined();
    expect(basePath!.getAttribute('marker-end') ?? '').toContain('dependency-arrow');
    expect(basePath!.getAttribute('stroke-dasharray')).toBeTruthy();
  });

  it('handleCreateDependency writes the edge through applyDeltaToYDoc (bridge round-trip)', () => {
    const { diagram, orderId, serviceId } = depFixture();
    diagram.dependencies = [];
    const doc = buildYDocFromDiagram(diagram);

    act(() => {
      handleCreateDependency(doc, diagram.id, { clientClassId: orderId, supplierClassId: serviceId });
    });

    const projected = projectYDocToDiagram(doc);
    expect(projected.dependencies).toHaveLength(1);
    expect(projected.dependencies[0]).toMatchObject({ clientClassId: orderId, supplierClassId: serviceId });
  });

  it('handleCreateDependency REJECTS a duplicate leaving the model unchanged (runtime harness, 12.6 invariant)', () => {
    const { diagram, orderId, serviceId } = depFixture();
    const doc = buildYDocFromDiagram(diagram);

    act(() => {
      handleCreateDependency(doc, diagram.id, { clientClassId: orderId, supplierClassId: serviceId });
    });

    expect(projectYDocToDiagram(doc).dependencies).toHaveLength(1);
  });

  it('handleCreateDependency REJECTS a missing end leaving the model unchanged (runtime harness, 12.6 invariant)', () => {
    const { diagram, orderId } = depFixture();
    diagram.dependencies = [];
    const doc = buildYDocFromDiagram(diagram);

    act(() => {
      handleCreateDependency(doc, diagram.id, { clientClassId: orderId, supplierClassId: crypto.randomUUID() });
    });

    expect(projectYDocToDiagram(doc).dependencies).toHaveLength(0);
  });

  it('handleDeleteDependency removes the edge from the Y.Doc', () => {
    const { diagram, depId } = depFixture();
    const doc = buildYDocFromDiagram(diagram);

    act(() => {
      handleDeleteDependency(doc, diagram.id, depId);
    });

    expect(projectYDocToDiagram(doc).dependencies).toHaveLength(0);
  });
});

describe('unit 12b — editor UI: "depends on" in context menu + dependency panel (12.4)', () => {
  function depUiFixture(): { diagram: Diagram; orderId: string; serviceId: string; repoId: string } {
    const orderId = crypto.randomUUID();
    const serviceId = crypto.randomUUID();
    const repoId = crypto.randomUUID();
    const diagram = {
      id: crypto.randomUUID(),
      name: 'DepUi',
      classes: [
        { id: orderId, name: 'Order', position: { x: 0, y: 0 }, attributes: [], methods: [] },
        { id: serviceId, name: 'Service', position: { x: 300, y: 0 }, attributes: [], methods: [] },
        { id: repoId, name: 'Repository', position: { x: 600, y: 0 }, attributes: [], methods: [], kind: 'interface' },
      ],
      associations: [],
    };
    return { diagram: DiagramSchema.parse(diagram), orderId, serviceId, repoId };
  }

  it('context menu offers "Depends on <X>" for EVERY other classifier (class AND interface) and emits the create delta', () => {
    const { diagram, orderId, serviceId, repoId } = depUiFixture();
    const doc = buildYDocFromDiagram(diagram);
    const { container } = render(<DiagramCanvas doc={doc} />);

    const orderNode = container.querySelector('.react-flow__node');
    fireEvent.contextMenu(orderNode!.querySelector('.uml-class')!);

    // Supplier may be ANY classifier: plain class and interface both offered.
    const plainButton = container.querySelector('button[aria-label="Depends on Service"]');
    expect(plainButton).not.toBeNull();
    expect(container.querySelector('button[aria-label="Depends on Repository"]')).not.toBeNull();

    fireEvent.click(plainButton!);

    const projected = projectYDocToDiagram(doc);
    expect(projected.dependencies).toHaveLength(1);
    expect(projected.dependencies[0]).toMatchObject({ clientClassId: orderId, supplierClassId: serviceId });
    expect(projected.dependencies[0]!.supplierClassId).not.toBe(repoId);
  });

  it('clicking a class shows its dependencies in the panel with role labels and remove works', () => {
    const { diagram, orderId, serviceId } = depUiFixture();
    const depId = crypto.randomUUID();
    (diagram as { dependencies: unknown[] }).dependencies = [{ id: depId, clientClassId: orderId, supplierClassId: serviceId }];
    const doc = buildYDocFromDiagram(diagram);
    const { container } = render(<DiagramCanvas doc={doc} />);

    // Client side: Order depends on Service.
    const orderNode = container.querySelector('.react-flow__node');
    fireEvent.click(orderNode!.querySelector('.uml-class')!);
    const panel = screen.getByTestId('dependency-panel');
    expect(panel.textContent).toContain('Depends on Service');

    // Supplier side mirrored on Service.
    fireEvent.click(container.querySelectorAll('.react-flow__node')[1]!.querySelector('.uml-class')!);
    expect(screen.getByTestId('dependency-panel').textContent).toContain('Dependency from Order');

    // Remove from the panel deletes the edge.
    fireEvent.click(container.querySelector('.react-flow__node')!.querySelector('.uml-class')!);
    const removeButton = screen.getByTestId('dependency-panel').querySelector<HTMLButtonElement>(
      `button[aria-label="Delete dependency ${depId}"]`,
    );
    expect(removeButton).not.toBeNull();
    fireEvent.click(removeButton!);
    expect(projectYDocToDiagram(doc).dependencies).toHaveLength(0);
  });
});

describe('unit 13 — n-ary association render: diamond at centroid + labeled member edges (13.2)', () => {
  function naryFixture(): { diagram: Diagram; supplierId: string; partId: string; projectIdId: string; naryId: string } {
    const supplierId = crypto.randomUUID();
    const partId = crypto.randomUUID();
    const projectId = crypto.randomUUID();
    const naryId = crypto.randomUUID();
    const diagram = DiagramSchema.parse({
      id: crypto.randomUUID(),
      name: 'Nary',
      classes: [
        { id: supplierId, name: 'Supplier', position: { x: 0, y: 0 }, attributes: [], methods: [] },
        { id: partId, name: 'Part', position: { x: 300, y: 0 }, attributes: [], methods: [] },
        { id: projectId, name: 'Project', position: { x: 150, y: 300 }, attributes: [], methods: [] },
      ],
      associations: [],
      naryAssociations: [
        {
          id: naryId,
          name: 'supply',
          memberEnds: [
            { classId: supplierId, multiplicity: '1', role: 'supplier' },
            { classId: partId, multiplicity: '0..*' },
            { classId: projectId, multiplicity: '*' },
          ],
        },
      ],
    });
    return { diagram, supplierId, partId, projectIdId: projectId, naryId };
  }

  it('computeNaryCentroid returns the arithmetic mean of member positions', () => {
    expect(computeNaryCentroid([
      { x: 0, y: 0 },
      { x: 300, y: 0 },
      { x: 150, y: 300 },
    ])).toEqual({ x: 150, y: 100 });
    expect(computeNaryCentroid([])).toEqual({ x: 0, y: 0 });
  });

  it('renders a diamond node positioned at the centroid of its member classes', async () => {
    const { diagram, naryId } = naryFixture();
    const doc = buildYDocFromDiagram(diagram);
    const { container } = render(<DiagramCanvas doc={doc} />);

    const diamond = await waitFor(() => {
      const el = container.querySelector('.uml-nary-diamond');
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    expect(diamond.getAttribute('data-nary-id')).toBe(naryId);

    // The node wrapper carries the centroid translate (0+300+150)/3=150, (0+0+300)/3=100.
    const wrapper = diamond.closest('.react-flow__node') as HTMLElement;
    expect(wrapper).not.toBeNull();
    expect(wrapper.getAttribute('style') ?? '').toContain('translate(150px,100px)');
  });

  it('renders one edge per member end, each labeled with that end multiplicity', async () => {
    const { diagram, supplierId, partId, projectIdId } = naryFixture();
    const doc = buildYDocFromDiagram(diagram);
    const { container } = render(<DiagramCanvas doc={doc} />);

    await waitFor(() => {
      expect(container.querySelectorAll('.react-flow__edge')).toHaveLength(3);
    });

    const labels = Array.from(container.querySelectorAll('[data-testid^="nary-end-label"]'));
    expect(labels).toHaveLength(3);
    const byClass = new Map(labels.map((el) => [(el.getAttribute('data-testid') ?? ''), (el.textContent ?? '')]));
    expect(byClass.get(`nary-end-label-${supplierId}`)).toBe('1');
    expect(byClass.get(`nary-end-label-${partId}`)).toBe('0..*');
    expect(byClass.get(`nary-end-label-${projectIdId}`)).toBe('*');
  });

  it('handleCreateNaryAssociation writes the n-ary through applyDeltaToYDoc (bridge round-trip)', () => {
    const { diagram, supplierId, partId, projectIdId } = naryFixture();
    diagram.naryAssociations = [];
    const doc = buildYDocFromDiagram(diagram);

    act(() => {
      handleCreateNaryAssociation(doc, diagram.id, {
        memberEnds: [
          { classId: supplierId, multiplicity: '1' },
          { classId: partId, multiplicity: '0..*' },
          { classId: projectIdId, multiplicity: '*' },
        ],
        name: 'supply',
      });
    });

    const projected = projectYDocToDiagram(doc);
    expect(projected.naryAssociations).toHaveLength(1);
    expect(projected.naryAssociations[0]!.memberEnds).toHaveLength(3);
    expect(projected.naryAssociations[0]!.name).toBe('supply');
  });

  it('handleCreateNaryAssociation guards <3 ends and invalid multiplicity: no delta, model unchanged', () => {
    const { diagram, supplierId, partId, projectIdId } = naryFixture();
    diagram.naryAssociations = [];
    const doc = buildYDocFromDiagram(diagram);

    act(() => {
      handleCreateNaryAssociation(doc, diagram.id, {
        memberEnds: [
          { classId: supplierId, multiplicity: '1' },
          { classId: partId, multiplicity: '1' },
        ],
      });
      handleCreateNaryAssociation(doc, diagram.id, {
        memberEnds: [
          { classId: supplierId, multiplicity: '1' },
          { classId: partId, multiplicity: '1' },
          { classId: projectIdId, multiplicity: 'garbage' },
        ],
      });
    });

    expect(projectYDocToDiagram(doc).naryAssociations).toHaveLength(0);
  });

  it('handleCreateNaryAssociation REJECTS an unknown member class leaving the model unchanged (runtime harness)', () => {
    const { diagram, supplierId, partId } = naryFixture();
    diagram.naryAssociations = [];
    const doc = buildYDocFromDiagram(diagram);

    act(() => {
      handleCreateNaryAssociation(doc, diagram.id, {
        memberEnds: [
          { classId: supplierId, multiplicity: '1' },
          { classId: partId, multiplicity: '1' },
          { classId: crypto.randomUUID(), multiplicity: '1' },
        ],
      });
    });

    expect(projectYDocToDiagram(doc).naryAssociations).toHaveLength(0);
  });

  it('handleDeleteNaryAssociation removes the n-ary from the Y.Doc', () => {
    const { diagram, naryId } = naryFixture();
    const doc = buildYDocFromDiagram(diagram);

    act(() => {
      handleDeleteNaryAssociation(doc, diagram.id, naryId);
    });

    expect(projectYDocToDiagram(doc).naryAssociations).toHaveLength(0);
  });

  it('BINARY ASSOCIATIONS UNTOUCHED: n-ary create/delete never mutates the associations collection (D13)', () => {
    const { diagram, supplierId, partId, projectIdId } = naryFixture();
    const binaryId = crypto.randomUUID();
    diagram.associations = [
      {
        id: binaryId,
        sourceClassId: supplierId,
        targetClassId: partId,
        sourceMultiplicity: '1',
        targetMultiplicity: '0..*',
        directed: false,
      },
    ];
    diagram.naryAssociations = [];
    const doc = buildYDocFromDiagram(diagram);

    act(() => {
      handleCreateNaryAssociation(doc, diagram.id, {
        memberEnds: [
          { classId: supplierId, multiplicity: '1' },
          { classId: partId, multiplicity: '1' },
          { classId: projectIdId, multiplicity: '1' },
        ],
      });
    });
    let projected = projectYDocToDiagram(doc);
    expect(projected.naryAssociations).toHaveLength(1);
    expect(projected.associations).toHaveLength(1);
    expect(projected.associations[0]!.id).toBe(binaryId);

    act(() => {
      handleDeleteNaryAssociation(doc, diagram.id, projected.naryAssociations[0]!.id);
    });
    projected = projectYDocToDiagram(doc);
    expect(projected.naryAssociations).toHaveLength(0);
    expect(projected.associations).toHaveLength(1);
    expect(projected.associations[0]!.id).toBe(binaryId);
  });
});

describe('unit 13 — editor UI: n-ary mode, per-end multiplicity, diamond context delete (13.3)', () => {
  function naryUiFixture(): { diagram: Diagram; ids: Record<string, string> } {
    const supplierId = crypto.randomUUID();
    const partId = crypto.randomUUID();
    const projectId = crypto.randomUUID();
    const diagram = DiagramSchema.parse({
      id: crypto.randomUUID(),
      name: 'NaryUi',
      classes: [
        { id: supplierId, name: 'Supplier', position: { x: 0, y: 0 }, attributes: [], methods: [] },
        { id: partId, name: 'Part', position: { x: 300, y: 0 }, attributes: [], methods: [] },
        { id: projectId, name: 'Project', position: { x: 150, y: 300 }, attributes: [], methods: [] },
      ],
      associations: [],
    });
    return { diagram, ids: { Supplier: supplierId, Part: partId, Project: projectId } };
  }

  function clickClass(container: HTMLElement, index: number): void {
    const classEl = container.querySelectorAll('.react-flow__node')[index]!.querySelector('.uml-class')!;
    fireEvent.click(classEl);
  }

  it('toolbar enters n-ary mode; picking 3 classes with per-end multiplicities creates the n-ary', () => {
    const { diagram, ids } = naryUiFixture();
    const doc = buildYDocFromDiagram(diagram);
    const { container } = render(<DiagramCanvas doc={doc} />);

    fireEvent.click(screen.getByRole('button', { name: 'N-ary association' }));

    clickClass(container, 0);
    clickClass(container, 1);
    clickClass(container, 2);

    const panel = screen.getByTestId('nary-panel');
    expect(panel).toBeDefined();

    // Per-end multiplicity editing.
    const partInput = panel.querySelector<HTMLInputElement>('input[aria-label="Multiplicity for Part"]')!;
    fireEvent.change(partInput, { target: { value: '0..*' } });

    fireEvent.click(panel.querySelector<HTMLButtonElement>('button[aria-label="Create n-ary association"]')!);

    const projected = projectYDocToDiagram(doc);
    expect(projected.naryAssociations).toHaveLength(1);
    const ends = projected.naryAssociations[0]!.memberEnds;
    expect(ends).toHaveLength(3);
    expect(ends.find((e) => e.classId === ids.Supplier)!.multiplicity).toBe('1');
    expect(ends.find((e) => e.classId === ids.Part)!.multiplicity).toBe('0..*');
    expect(ends.find((e) => e.classId === ids.Project)!.multiplicity).toBe('1');
  });

  it('creating with fewer than 3 picked classes is guarded: model unchanged', () => {
    const { diagram } = naryUiFixture();
    const doc = buildYDocFromDiagram(diagram);
    const { container } = render(<DiagramCanvas doc={doc} />);

    fireEvent.click(screen.getByRole('button', { name: 'N-ary association' }));
    clickClass(container, 0);
    clickClass(container, 1);

    const panel = screen.getByTestId('nary-panel');
    const createButton = panel.querySelector<HTMLButtonElement>('button[aria-label="Create n-ary association"]')!;
    expect(createButton.disabled).toBe(true);

    fireEvent.click(createButton);
    expect(projectYDocToDiagram(doc).naryAssociations).toHaveLength(0);
  });

  it('right-clicking the diamond opens a context menu that deletes the n-ary association', async () => {
    const supplierId = crypto.randomUUID();
    const partId = crypto.randomUUID();
    const projectId = crypto.randomUUID();
    const naryId = crypto.randomUUID();
    const diagram = DiagramSchema.parse({
      id: crypto.randomUUID(),
      name: 'NaryCtx',
      classes: [
        { id: supplierId, name: 'Supplier', position: { x: 0, y: 0 }, attributes: [], methods: [] },
        { id: partId, name: 'Part', position: { x: 300, y: 0 }, attributes: [], methods: [] },
        { id: projectId, name: 'Project', position: { x: 150, y: 300 }, attributes: [], methods: [] },
      ],
      associations: [],
      naryAssociations: [
        {
          id: naryId,
          memberEnds: [
            { classId: supplierId, multiplicity: '1' },
            { classId: partId, multiplicity: '1' },
            { classId: projectId, multiplicity: '1' },
          ],
        },
      ],
    });
    const doc = buildYDocFromDiagram(diagram);
    const { container } = render(<DiagramCanvas doc={doc} />);

    const diamond = await waitFor(() => {
      const el = container.querySelector('.uml-nary-diamond');
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    fireEvent.contextMenu(diamond);

    const menu = screen.getByTestId('nary-context-menu');
    fireEvent.click(menu.querySelector<HTMLButtonElement>(`button[aria-label="Delete n-ary association ${naryId}"]`)!);

    expect(projectYDocToDiagram(doc).naryAssociations).toHaveLength(0);
  });
});
