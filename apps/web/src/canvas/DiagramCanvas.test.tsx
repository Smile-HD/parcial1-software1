import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type * as Y from 'yjs';

import { buildYDocFromDiagram, projectYDocToDiagram, type Diagram, type Delta } from '@app/core';

import { DiagramCanvas, handleCreateAssociation, handleNodeDragStop, handleUpdateMultiplicity } from './DiagramCanvas';
import { applyDeltaToYDoc } from './applyDeltaToYDoc';

/**
 * editor:R1 — canvas renders EXCLUSIVELY from the Y.Doc (canonical IR).
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

describe('6.4a association creation between two classes (editor:R4 — first half)', () => {
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

describe('6.4b multiplicity editing (editor:R4 — second half)', () => {
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

  it('rejects an out-of-enum multiplicity like 3..7: no throw escapes, no delta emitted, previous value retained', () => {
    const { diagram, doc, associationId } = makeAssociationFixture();
    let threw: unknown = null;

    act(() => {
      try {
        handleUpdateMultiplicity(doc, diagram.id, associationId, 'source', '3..7');
      } catch (error) {
        threw = error;
      }
    });

    expect(threw).toBeNull();
    const assoc = projectYDocToDiagram(doc).associations.find((a) => a.id === associationId);
    expect(assoc?.sourceMultiplicity).toBe('1'); // previous value retained
    expect(assoc?.targetMultiplicity).toBe('1');
  });

  it('renders the multiplicity editor with two selects (only the 4 enum values) when an edge is clicked, and changing a select updates the model', async () => {
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

    const source = screen.getByLabelText('Source multiplicity') as HTMLSelectElement;
    const target = screen.getByLabelText('Target multiplicity') as HTMLSelectElement;
    expect(Array.from(source.querySelectorAll('option')).map((o) => o.value)).toEqual(['1', '0..1', '1..*', '0..*']);
    expect(Array.from(target.querySelectorAll('option')).map((o) => o.value)).toEqual(['1', '0..1', '1..*', '0..*']);

    fireEvent.change(source, { target: { value: '0..*' } });
    expect(projectYDocToDiagram(doc).associations[0]!.sourceMultiplicity).toBe('0..*');
    expect(source.value).toBe('0..*');
    expect(target.value).toBe('1');
  });
});

describe('editor:R3 — in-place member editing', () => {
  /**
   * jsdom keeps React Flow node wrappers `visibility: hidden` (nodes are only
   * revealed after real layout measurement), so role-based queries exclude
   * node-internal elements from the accessibility tree. These helpers query
   * the container directly; `getByText` still works for node text.
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

    expect(screen.getByText('email: string')).toBeTruthy();
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

    expect(screen.getByText('getName(String): BigDecimal')).toBeTruthy();
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

    expect(screen.getByText('name: string')).toBeTruthy();
    expect(projectYDocToDiagram(doc).classes[0]!.attributes[0]).toMatchObject({ name: 'name' });
  });
});
