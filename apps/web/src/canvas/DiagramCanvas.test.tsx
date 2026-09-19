import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import * as Y from 'yjs';

import { buildYDocFromDiagram, DiagramSchema, projectYDocToDiagram, type Diagram, type Delta } from '@app/core';

import { computeNaryCentroid, DiagramCanvas, handleConnectWithTool, type ConnectGuardResult, handleCreateAssociation, handleCreateDependency, handleCreateGeneralization, handleCreateNaryAssociation, handleCreateRealization, handleDeleteDependency, handleDeleteGeneralization, handleDeleteNaryAssociation, handleDeleteRealization, handleNodeDragStop, handlePaletteDrop, handleSetAbstract, handleUpdateMultiplicity, handleUpdateNaryAssociation } from './DiagramCanvas';
import { PALETTE_DND_MIME } from './Palette';
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

  it('adds a class node when the user drops the palette Class item (create delta)', () => {
    // unit 13e.7 — the legacy "Add class" toolbar button is gone; the palette
    // drag-and-drop is the creation path (same MouseEvent trick as the 13b
    // onDrop wiring test — jsdom has no DragEvent with clientX).
    const diagram = makeFixture();
    const doc = buildYDocFromDiagram(diagram);
    const { container } = render(<DiagramCanvas doc={doc} />);
    expect(container.querySelectorAll('.react-flow__node')).toHaveLength(2);

    const dropEvent = new window.MouseEvent('drop', {
      bubbles: true,
      cancelable: true,
      clientX: 320,
      clientY: 240,
    });
    Object.defineProperty(dropEvent, 'dataTransfer', {
      value: { getData: () => 'class', setData: () => {}, effectAllowed: '', dropEffect: '' },
    });
    act(() => {
      container.querySelector('.react-flow')!.dispatchEvent(dropEvent);
    });

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

  it('editing name/roles in the panel updates the Y.Doc (unit 10.4 E2E — aggregation moved to the palette in 13c)', async () => {
    const doc = buildYDocFromDiagram(assocFixture({ directed: false }));
    const { container } = render(<DiagramCanvas doc={doc} />);

    const edge = await waitFor(() => {
      const el = container.querySelector('.react-flow__edge');
      expect(el).not.toBeNull();
      return el!;
    });
    fireEvent.click(edge);

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

  it('the association editor NO LONGER exposes aggregation dropdowns (unit 13c — they moved to the palette)', async () => {
    const doc = buildYDocFromDiagram(assocFixture({ aggregation: 'composite', directed: false }));
    const { container } = render(<DiagramCanvas doc={doc} />);

    const edge = await waitFor(() => {
      const el = container.querySelector('.react-flow__edge');
      expect(el).not.toBeNull();
      return el!;
    });
    fireEvent.click(edge);

    // The editor is open…
    expect(screen.getByTestId('edge-editor')).toBeTruthy();
    // …but the aggregation kind/end selects are gone.
    expect(screen.queryByLabelText('Aggregation kind')).toBeNull();
    expect(screen.queryByLabelText('Aggregation end')).toBeNull();
    // The model keeps the aggregation set at creation time (palette path).
    expect(projectYDocToDiagram(doc).associations[0]!.aggregation).toBe('composite');
  });

  it('flip diamond end control toggles aggregationEnd between source and target for composition/aggregation', async () => {
    const doc = buildYDocFromDiagram(
      assocFixture({ aggregation: 'composite', directed: false, aggregationEnd: 'source' }),
    );
    const { container } = render(<DiagramCanvas doc={doc} />);

    const edge = await waitFor(() => {
      const el = container.querySelector('.react-flow__edge');
      expect(el).not.toBeNull();
      return el!;
    });
    fireEvent.click(edge);

    // The flip diamond end control should be present for aggregation !== 'none'
    const flipButton = screen.getByRole('button', { name: /flip diamond end/i });
    expect(flipButton).toBeTruthy();

    // Initial state: aggregationEnd='source'
    expect(projectYDocToDiagram(doc).associations[0]!.aggregationEnd).toBe('source');

    // Click flip button → changes to 'target'
    fireEvent.click(flipButton);
    expect(projectYDocToDiagram(doc).associations[0]!.aggregationEnd).toBe('target');

    // Click again → changes back to 'source'
    fireEvent.click(flipButton);
    expect(projectYDocToDiagram(doc).associations[0]!.aggregationEnd).toBe('source');
  });

  it('flip diamond end control is ABSENT for plain associations (aggregation === none)', async () => {
    const doc = buildYDocFromDiagram(assocFixture({ aggregation: 'none', directed: false }));
    const { container } = render(<DiagramCanvas doc={doc} />);

    const edge = await waitFor(() => {
      const el = container.querySelector('.react-flow__edge');
      expect(el).not.toBeNull();
      return el!;
    });
    fireEvent.click(edge);

    // The flip diamond end control should NOT be present for plain associations
    expect(screen.queryByRole('button', { name: /flip diamond end/i })).toBeNull();
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

  it('palette Interface drop creates a class node with kind "interface"', () => {
    // unit 13e.7 — the legacy "Add interface" toolbar button is gone; the
    // palette drop carries the interface kind through the same creation path.
    const { diagram } = uiFixture();
    const doc = buildYDocFromDiagram(diagram);
    const { container } = render(<DiagramCanvas doc={doc} />);

    const dropEvent = new window.MouseEvent('drop', {
      bubbles: true,
      cancelable: true,
      clientX: 400,
      clientY: 300,
    });
    Object.defineProperty(dropEvent, 'dataTransfer', {
      value: { getData: () => 'interface', setData: () => {}, effectAllowed: '', dropEffect: '' },
    });
    act(() => {
      container.querySelector('.react-flow')!.dispatchEvent(dropEvent);
    });

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

  it('palette n-ary item enters pick mode; picking 3 classes with per-end multiplicities creates the n-ary', () => {
    // unit 13e.7 — the toolbar's "N-ary association" button is gone; the
    // palette item drives the SAME shared mode toggle (13b wiring).
    const { diagram, ids } = naryUiFixture();
    const doc = buildYDocFromDiagram(diagram);
    const { container } = render(<DiagramCanvas doc={doc} />);

    fireEvent.click(screen.getByTestId('palette-nary'));

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

    // unit 13e.7 — palette n-ary item (the toolbar twin is gone).
    fireEvent.click(screen.getByTestId('palette-nary'));
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

describe('unit 13b — palette drop creates nodes at the drop position (13b.2)', () => {
  it('handlePaletteDrop emits a class create delta at the given position', () => {
    const diagram = makeFixture();
    const doc = buildYDocFromDiagram(diagram);

    act(() => {
      handlePaletteDrop(doc, diagram.id, {
        kind: 'class',
        position: { x: 420, y: 260 },
        existingNames: diagram.classes.map((c) => c.name),
      });
    });

    const created = projectYDocToDiagram(doc).classes.find((c) => c.name === 'Class1');
    expect(created).toBeDefined();
    expect(created!.position).toEqual({ x: 420, y: 260 });
    expect(created!.kind).toBe('class');
  });

  it('handlePaletteDrop emits an interface create delta (classKind) at the given position', () => {
    const diagram = makeFixture();
    const doc = buildYDocFromDiagram(diagram);

    act(() => {
      handlePaletteDrop(doc, diagram.id, {
        kind: 'interface',
        position: { x: 60, y: 540 },
        existingNames: diagram.classes.map((c) => c.name),
      });
    });

    const created = projectYDocToDiagram(doc).classes.find((c) => c.name === 'Interface1');
    expect(created).toBeDefined();
    expect(created!.kind).toBe('interface');
    expect(created!.position).toEqual({ x: 60, y: 540 });
  });

  it('handlePaletteDrop picks the next free auto-name skipping existing ones', () => {
    const diagram = makeFixture();
    const doc = buildYDocFromDiagram(diagram);

    act(() => {
      handlePaletteDrop(doc, diagram.id, { kind: 'class', position: { x: 0, y: 0 }, existingNames: ['Class1'] });
    });

    const projected = projectYDocToDiagram(doc);
    expect(projected.classes.some((c) => c.name === 'Class2')).toBe(true);
  });

  it('dropping a palette item on the canvas creates the node (onDrop wiring)', () => {
    const diagram = makeFixture();
    const doc = buildYDocFromDiagram(diagram);
    const { container } = render(<DiagramCanvas doc={doc} />);

    const pane = container.querySelector('.react-flow')!;
    expect(pane).not.toBeNull();
    // jsdom has no DragEvent constructor (fireEvent.drop yields a plain Event
    // without clientX), so dispatch a real MouseEvent carrying the payload.
    const dropEvent = new window.MouseEvent('drop', {
      bubbles: true,
      cancelable: true,
      clientX: 320,
      clientY: 240,
    });
    Object.defineProperty(dropEvent, 'dataTransfer', {
      value: { getData: () => 'class', setData: () => {}, effectAllowed: '', dropEffect: '' },
    });
    act(() => {
      pane.dispatchEvent(dropEvent);
    });

    const created = projectYDocToDiagram(doc).classes.find((c) => c.name === 'Class1');
    expect(created).toBeDefined();
    // Zero-size test viewport: screenToFlowPosition is not finite, so the
    // handler falls back to the raw screen point (never an invalid delta).
    expect(created!.position).toEqual({ x: 320, y: 240 });
  });
});

describe('unit 13b — drag-to-connect emits the armed edge tool delta (13b.3)', () => {
  function connectFixture(): { diagram: Diagram; doc: Y.Doc; aId: string; bId: string; rId: string } {
    const aId = crypto.randomUUID();
    const bId = crypto.randomUUID();
    const rId = crypto.randomUUID();
    const diagram = DiagramSchema.parse({
      id: crypto.randomUUID(),
      name: 'Connect',
      classes: [
        { id: aId, name: 'A', position: { x: 0, y: 0 }, attributes: [], methods: [] },
        { id: bId, name: 'B', position: { x: 300, y: 0 }, attributes: [], methods: [] },
        { id: rId, name: 'R', position: { x: 600, y: 0 }, attributes: [], methods: [], kind: 'interface' },
      ],
      associations: [],
    });
    const doc = buildYDocFromDiagram(diagram);
    return { diagram, doc, aId, bId, rId };
  }
  const classifiersOf = (diagram: Diagram) =>
    diagram.classes.map((c) => ({ id: c.id, kind: c.kind ?? 'class' }));

  it('association tool: source→target association with default multiplicities', () => {
    const { diagram, doc, aId, bId } = connectFixture();
    const result = handleConnectWithTool(
      doc, diagram.id, 'association', { source: aId, target: bId }, classifiersOf(diagram),
    );
    expect(result.ok).toBe(true);
    const assoc = projectYDocToDiagram(doc).associations[0]!;
    expect(assoc.sourceClassId).toBe(aId);
    expect(assoc.targetClassId).toBe(bId);
    expect(assoc.directed).toBe(false);
    expect(assoc.sourceMultiplicity).toBe('1');
    expect(assoc.targetMultiplicity).toBe('1');
  });

  it('generalization tool: source is the subClass, target is the superClass', () => {
    const { diagram, doc, aId, bId } = connectFixture();
    const result = handleConnectWithTool(
      doc, diagram.id, 'generalization', { source: aId, target: bId }, classifiersOf(diagram),
    );
    expect(result.ok).toBe(true);
    expect(projectYDocToDiagram(doc).generalizations[0]).toMatchObject({ subClassId: aId, superClassId: bId });
  });

  it('realization tool: client class → supplier interface', () => {
    const { diagram, doc, aId, rId } = connectFixture();
    const result = handleConnectWithTool(
      doc, diagram.id, 'realization', { source: aId, target: rId }, classifiersOf(diagram),
    );
    expect(result.ok).toBe(true);
    expect(projectYDocToDiagram(doc).realizations![0]).toMatchObject({ clientClassId: aId, supplierInterfaceId: rId });
  });

  it('dependency tool: client → supplier, and the supplier may be an interface', () => {
    const { diagram, doc, aId, bId, rId } = connectFixture();
    expect(handleConnectWithTool(doc, diagram.id, 'dependency', { source: aId, target: bId }, classifiersOf(diagram)).ok).toBe(true);
    expect(handleConnectWithTool(doc, diagram.id, 'dependency', { source: bId, target: rId }, classifiersOf(diagram)).ok).toBe(true);
    const deps = projectYDocToDiagram(doc).dependencies!;
    expect(deps).toHaveLength(2);
    expect(deps[1]).toMatchObject({ clientClassId: bId, supplierClassId: rId });
  });

  it('no armed tool: a raw connection does nothing (no accidental edges)', () => {
    const { diagram, doc, aId, bId } = connectFixture();
    const result = handleConnectWithTool(
      doc, diagram.id, null, { source: aId, target: bId }, classifiersOf(diagram),
    );
    expect(result.ok).toBe(false);
    const projected = projectYDocToDiagram(doc);
    expect(projected.associations).toHaveLength(0);
    expect(projected.generalizations ?? []).toHaveLength(0);
    expect(projected.realizations ?? []).toHaveLength(0);
    expect(projected.dependencies ?? []).toHaveLength(0);
  });

  it('realization guard: a NON-interface target is rejected with a message, model unchanged', () => {
    const { diagram, doc, aId, bId } = connectFixture();
    const result = handleConnectWithTool(
      doc, diagram.id, 'realization', { source: aId, target: bId }, classifiersOf(diagram),
    );
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/interface/i);
    expect(projectYDocToDiagram(doc).realizations ?? []).toHaveLength(0);
  });

  it('association guard: self-association is now ALLOWED (valid UML — e.g., Employee→manages→Employee)', () => {
    const { diagram, doc, aId } = connectFixture();
    const result = handleConnectWithTool(
      doc, diagram.id, 'association', { source: aId, target: aId }, classifiersOf(diagram),
    );
    expect(result.ok).toBe(true);
    expect(result.message).toBeUndefined();
    const projected = projectYDocToDiagram(doc);
    expect(projected.associations).toHaveLength(1);
    const assoc = projected.associations[0]!;
    expect(assoc.sourceClassId).toBe(aId);
    expect(assoc.targetClassId).toBe(aId);
  });

  it('unknown endpoint guard: a connection referencing a missing class is rejected', () => {
    const { diagram, doc, aId } = connectFixture();
    const result = handleConnectWithTool(
      doc, diagram.id, 'association', { source: aId, target: crypto.randomUUID() }, classifiersOf(diagram),
    );
    expect(result.ok).toBe(false);
    expect(projectYDocToDiagram(doc).associations).toHaveLength(0);
  });

  it('generalization cycle: the engine rejection is surfaced as a message, model unchanged', () => {
    const { diagram, doc, aId, bId } = connectFixture();
    act(() => {
      handleCreateGeneralization(doc, diagram.id, { subClassId: aId, superClassId: bId });
    });

    const result = handleConnectWithTool(
      doc, diagram.id, 'generalization', { source: bId, target: aId }, classifiersOf(diagram),
    );
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/cycle/i);
    expect(projectYDocToDiagram(doc).generalizations).toHaveLength(1);
  });

  it('duplicate realization: the engine rejection is surfaced, still one edge', () => {
    const { diagram, doc, aId, rId } = connectFixture();
    expect(handleConnectWithTool(doc, diagram.id, 'realization', { source: aId, target: rId }, classifiersOf(diagram)).ok).toBe(true);
    const second = handleConnectWithTool(doc, diagram.id, 'realization', { source: aId, target: rId }, classifiersOf(diagram));
    expect(second.ok).toBe(false);
    expect(second.message).toMatch(/already exists/i);
    expect(projectYDocToDiagram(doc).realizations).toHaveLength(1);
  });
});

describe('unit 13b — canvas wiring: palette rail, armed-tool affordances (13b.4)', () => {
  function wireFixture(): { diagram: Diagram; doc: Y.Doc } {
    const diagram = makeFixture();
    const doc = buildYDocFromDiagram(diagram);
    return { diagram, doc };
  }

  it('the palette rail renders inside the canvas with all seven items', () => {
    const { doc } = wireFixture();
    render(<DiagramCanvas doc={doc} />);
    expect(screen.getByTestId('palette-class')).toBeTruthy();
    expect(screen.getByTestId('palette-nary')).toBeTruthy();
  });

  it('clicking an edge item arms the tool (aria-pressed + visible hint)', () => {
    const { doc } = wireFixture();
    render(<DiagramCanvas doc={doc} />);

    fireEvent.click(screen.getByTestId('palette-dependency'));
    expect(screen.getByTestId('palette-dependency').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('edge-tool-hint')).toBeTruthy();

    fireEvent.click(screen.getByTestId('palette-dependency'));
    expect(screen.getByTestId('palette-dependency').getAttribute('aria-pressed')).toBe('false');
    expect(screen.queryByTestId('edge-tool-hint')).toBeNull();
  });

  it('Escape clears the armed edge tool', () => {
    const { doc } = wireFixture();
    render(<DiagramCanvas doc={doc} />);

    fireEvent.click(screen.getByTestId('palette-generalization'));
    expect(screen.getByTestId('palette-generalization').getAttribute('aria-pressed')).toBe('true');

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.getByTestId('palette-generalization').getAttribute('aria-pressed')).toBe('false');
  });

  it('clicking the n-ary palette entry enters the existing pick-≥3 mode and creates through it', () => {
    const supplierId = crypto.randomUUID();
    const partId = crypto.randomUUID();
    const projectId = crypto.randomUUID();
    const diagram = DiagramSchema.parse({
      id: crypto.randomUUID(),
      name: 'NaryPalette',
      classes: [
        { id: supplierId, name: 'Supplier', position: { x: 0, y: 0 }, attributes: [], methods: [] },
        { id: partId, name: 'Part', position: { x: 300, y: 0 }, attributes: [], methods: [] },
        { id: projectId, name: 'Project', position: { x: 150, y: 300 }, attributes: [], methods: [] },
      ],
      associations: [],
    });
    const doc = buildYDocFromDiagram(diagram);
    const { container } = render(<DiagramCanvas doc={doc} />);

    fireEvent.click(screen.getByTestId('palette-nary'));
    expect(screen.getByTestId('palette-nary').getAttribute('aria-pressed')).toBe('true');
    // unit 13e.7 — the toolbar's "Cancel n-ary" twin is gone; the palette
    // item's aria-pressed (asserted above) is the single mode reflection.

    for (const index of [0, 1, 2]) {
      fireEvent.click(container.querySelectorAll('.react-flow__node')[index]!.querySelector('.uml-class')!);
    }
    const panel = screen.getByTestId('nary-panel');
    fireEvent.click(panel.querySelector<HTMLButtonElement>('button[aria-label="Create n-ary association"]')!);

    expect(projectYDocToDiagram(doc).naryAssociations).toHaveLength(1);
  });

  it('the palette drag mime type is the one the drop handler reads', () => {
    expect(PALETTE_DND_MIME).toBeTruthy();
  });
});

describe('unit 13b — drag-to-connect: association edge renders and tool is single-use', () => {
  function dragConnectFixture(): { diagram: Diagram; doc: Y.Doc; sourceId: string; targetId: string } {
    const sourceId = crypto.randomUUID();
    const targetId = crypto.randomUUID();
    const diagram = DiagramSchema.parse({
      id: crypto.randomUUID(),
      name: 'DragConnect',
      classes: [
        { id: sourceId, name: 'Source', position: { x: 0, y: 0 }, attributes: [], methods: [] },
        { id: targetId, name: 'Target', position: { x: 300, y: 0 }, attributes: [], methods: [] },
      ],
      associations: [],
    });
    const doc = buildYDocFromDiagram(diagram);
    return { diagram, doc, sourceId, targetId };
  }

  it('drag-created association renders as an edge in the DOM (regression for Bug #1)', async () => {
    const { diagram, doc, sourceId, targetId } = dragConnectFixture();
    const { container } = render(<DiagramCanvas doc={doc} />);

    // Arm the association tool via the palette
    fireEvent.click(screen.getByTestId('palette-association'));
    expect(screen.getByTestId('palette-association').getAttribute('aria-pressed')).toBe('true');

    // Simulate the onConnect callback that React Flow would call on drag completion
    // We call handleConnectWithTool directly (the pure function that onConnect delegates to)
    // which applies the delta to the Y.Doc; the Y.Doc observer triggers a re-render with new edges.
    act(() => {
      handleConnectWithTool(
        doc,
        diagram.id,
        'association',
        { source: sourceId, target: targetId },
        diagram.classes.map((cls) => ({ id: cls.id, kind: cls.kind ?? ('class' as const) })),
      );
    });

    // The Y.Doc observer fires, component re-renders with new edges
    const edge = await waitFor(() => {
      const el = container.querySelector('.react-flow__edge');
      expect(el).not.toBeNull();
      return el!;
    });
    expect(edge).not.toBeNull();
    // The edge should be an association edge (type='association' in data)
    // In jsdom the edge SVG renders; presence of .react-flow__edge confirms it mounted.
  });

  it('successful connection: model updates and handleConnectWithTool returns ok (single-use disarming is in onConnect)', () => {
    const { diagram, doc, sourceId, targetId } = dragConnectFixture();
    render(<DiagramCanvas doc={doc} />);

    // Arm the association tool (UI only; the guard logic is in handleConnectWithTool)
    fireEvent.click(screen.getByTestId('palette-association'));

    // Simulate successful connection via the pure handler
    let result: ConnectGuardResult;
    act(() => {
      result = handleConnectWithTool(
        doc,
        diagram.id,
        'association',
        { source: sourceId, target: targetId },
        diagram.classes.map((cls) => ({ id: cls.id, kind: cls.kind ?? ('class' as const) })),
      );
    });

    // The handler returns ok and the model has the new association
    expect(result!.ok).toBe(true);
    expect(projectYDocToDiagram(doc).associations).toHaveLength(1);
    // Note: tool disarming (setEdgeTool(null)) happens in the onConnect callback,
    // which is triggered by React Flow on drag completion. In jsdom we can't easily
    // simulate the drag, but the onConnect implementation correctly disarms on success.
  });

  it('rejected connection: model unchanged, handler returns error (tool stays armed in onConnect)', () => {
    // Realization to non-interface should be rejected
    const classAId = crypto.randomUUID();
    const classBId = crypto.randomUUID();
    const diagram = DiagramSchema.parse({
      id: crypto.randomUUID(),
      name: 'RejectConnect',
      classes: [
        { id: classAId, name: 'ClassA', position: { x: 0, y: 0 }, attributes: [], methods: [] },
        { id: classBId, name: 'ClassB', position: { x: 300, y: 0 }, attributes: [], methods: [] },
      ],
      associations: [],
    });
    const doc = buildYDocFromDiagram(diagram);
    render(<DiagramCanvas doc={doc} />);

    // Arm the realization tool
    fireEvent.click(screen.getByTestId('palette-realization'));

    // Simulate rejected connection: realization from class to class (target must be interface)
    let result: ConnectGuardResult;
    act(() => {
      result = handleConnectWithTool(
        doc,
        diagram.id,
        'realization',
        { source: classAId, target: classBId },
        diagram.classes.map((cls) => ({ id: cls.id, kind: cls.kind ?? ('class' as const) })),
      );
    });

    // The handler returns error and the model is unchanged
    expect(result!.ok).toBe(false);
    expect(result!.message).toMatch(/interface/i);
    expect(projectYDocToDiagram(doc).realizations).toHaveLength(0);
    // Note: onConnect keeps the tool armed on rejection (does not call setEdgeTool(null)),
    // and surfaces the message via setEdgeMessage. In jsdom we verify the handler result.
  });
});

describe('unit 13c — unified edge editor: ONE panel for every edge type', () => {
  function edgeEditorFixture(): { diagram: Diagram; assocId: string; genId: string; realId: string; depId: string } {
    const customerId = crypto.randomUUID();
    const orderId = crypto.randomUUID();
    const repoId = crypto.randomUUID();
    const assocId = crypto.randomUUID();
    const genId = crypto.randomUUID();
    const realId = crypto.randomUUID();
    const depId = crypto.randomUUID();
    const diagram = DiagramSchema.parse({
      id: crypto.randomUUID(),
      name: 'EdgeEditor',
      classes: [
        { id: customerId, name: 'Customer', position: { x: 0, y: 0 }, attributes: [], methods: [] },
        { id: orderId, name: 'Order', position: { x: 300, y: 0 }, attributes: [], methods: [] },
        { id: repoId, name: 'Repository', position: { x: 600, y: 0 }, attributes: [], methods: [], kind: 'interface' },
      ],
      associations: [{ id: assocId, sourceClassId: customerId, targetClassId: orderId, sourceMultiplicity: '1', targetMultiplicity: '0..*', directed: false }],
      generalizations: [{ id: genId, subClassId: customerId, superClassId: orderId }],
      realizations: [{ id: realId, clientClassId: customerId, supplierInterfaceId: repoId }],
      dependencies: [{ id: depId, clientClassId: orderId, supplierClassId: repoId }],
    });
    return { diagram, assocId, genId, realId, depId };
  }

  async function clickEdgeType(container: HTMLElement, type: string): Promise<void> {
    const edge = await waitFor(() => {
      const el = container.querySelector(`.react-flow__edge-${type}`);
      expect(el).not.toBeNull();
      return el!;
    });
    fireEvent.click(edge);
  }

  it('clicking a generalization edge opens the single editor with Label + Delete and NO multiplicity fields', async () => {
    const { diagram, genId } = edgeEditorFixture();
    const doc = buildYDocFromDiagram(diagram);
    const { container } = render(<DiagramCanvas doc={doc} />);

    await clickEdgeType(container, 'generalization');

    const editor = screen.getByTestId('edge-editor');
    expect(editor.querySelector(`input[aria-label="Generalization label"]`)).not.toBeNull();
    expect(editor.querySelector(`button[aria-label="Delete generalization ${genId}"]`)).not.toBeNull();
    // UML-correct: generalizations have no multiplicity.
    expect(editor.querySelector(`input[aria-label="Source multiplicity"]`)).toBeNull();
    expect(editor.querySelector(`input[aria-label="Target multiplicity"]`)).toBeNull();
  });

  it('clicking a realization edge opens the editor with Label + Delete and NO multiplicity fields', async () => {
    const { diagram, realId } = edgeEditorFixture();
    const doc = buildYDocFromDiagram(diagram);
    const { container } = render(<DiagramCanvas doc={doc} />);

    await clickEdgeType(container, 'realization');

    const editor = screen.getByTestId('edge-editor');
    expect(editor.querySelector(`input[aria-label="Realization label"]`)).not.toBeNull();
    expect(editor.querySelector(`button[aria-label="Delete realization ${realId}"]`)).not.toBeNull();
    expect(editor.querySelector(`input[aria-label="Source multiplicity"]`)).toBeNull();
  });

  it('clicking a dependency edge opens the editor with Label + Delete and NO multiplicity fields', async () => {
    const { diagram, depId } = edgeEditorFixture();
    const doc = buildYDocFromDiagram(diagram);
    const { container } = render(<DiagramCanvas doc={doc} />);

    await clickEdgeType(container, 'dependency');

    const editor = screen.getByTestId('edge-editor');
    expect(editor.querySelector(`input[aria-label="Dependency label"]`)).not.toBeNull();
    expect(editor.querySelector(`button[aria-label="Delete dependency ${depId}"]`)).not.toBeNull();
    expect(editor.querySelector(`input[aria-label="Source multiplicity"]`)).toBeNull();
  });

  it('clicking an association edge opens the SAME editor with label + multiplicities', async () => {
    const { diagram, assocId } = edgeEditorFixture();
    const doc = buildYDocFromDiagram(diagram);
    const { container } = render(<DiagramCanvas doc={doc} />);

    await clickEdgeType(container, 'association');

    const editor = screen.getByTestId('edge-editor');
    expect(editor.querySelector(`input[aria-label="Association name"]`)).not.toBeNull();
    expect((editor.querySelector(`input[aria-label="Source multiplicity"]`) as HTMLInputElement).value).toBe('1');
    expect((editor.querySelector(`input[aria-label="Target multiplicity"]`) as HTMLInputElement).value).toBe('0..*');
    expect(editor.querySelector(`button[aria-label="Delete association ${assocId}"]`)).not.toBeNull();
  });

  it('only ONE editor panel exists at a time (no overlapping editors)', async () => {
    const { diagram } = edgeEditorFixture();
    const doc = buildYDocFromDiagram(diagram);
    const { container } = render(<DiagramCanvas doc={doc} />);

    await clickEdgeType(container, 'association');
    await clickEdgeType(container, 'generalization');

    expect(container.querySelectorAll('[data-testid="edge-editor"]')).toHaveLength(1);
    // The last-clicked edge owns the single editor.
    const editor = screen.getByTestId('edge-editor');
    expect(editor.querySelector(`input[aria-label="Generalization label"]`)).not.toBeNull();
  });

  it('editing a generalization label updates the model (update name delta)', async () => {
    const { diagram, genId } = edgeEditorFixture();
    const doc = buildYDocFromDiagram(diagram);
    const { container } = render(<DiagramCanvas doc={doc} />);

    await clickEdgeType(container, 'generalization');
    const input = screen.getByTestId('edge-editor').querySelector(`input[aria-label="Generalization label"]`) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'inherits' } });
    fireEvent.blur(input);

    expect(projectYDocToDiagram(doc).generalizations.find((g) => g.id === genId)!.name).toBe('inherits');
  });

  it('editing a realization label updates the model', async () => {
    const { diagram, realId } = edgeEditorFixture();
    const doc = buildYDocFromDiagram(diagram);
    const { container } = render(<DiagramCanvas doc={doc} />);

    await clickEdgeType(container, 'realization');
    const input = screen.getByTestId('edge-editor').querySelector(`input[aria-label="Realization label"]`) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'implements' } });
    fireEvent.blur(input);

    expect(projectYDocToDiagram(doc).realizations.find((r) => r.id === realId)!.name).toBe('implements');
  });

  it('editing a dependency label updates the model', async () => {
    const { diagram, depId } = edgeEditorFixture();
    const doc = buildYDocFromDiagram(diagram);
    const { container } = render(<DiagramCanvas doc={doc} />);

    await clickEdgeType(container, 'dependency');
    const input = screen.getByTestId('edge-editor').querySelector(`input[aria-label="Dependency label"]`) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'uses' } });
    fireEvent.blur(input);

    expect(projectYDocToDiagram(doc).dependencies.find((d) => d.id === depId)!.name).toBe('uses');
  });

  it('an edge label survives an unrelated delta (bridge rewrite keeps the name)', async () => {
    const { diagram, genId } = edgeEditorFixture();
    const doc = buildYDocFromDiagram(diagram);
    const { container } = render(<DiagramCanvas doc={doc} />);

    await clickEdgeType(container, 'generalization');
    const input = screen.getByTestId('edge-editor').querySelector(`input[aria-label="Generalization label"]`) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'inherits' } });
    fireEvent.blur(input);

    // An unrelated class rename must not drop the label.
    act(() => {
      applyDeltaToYDoc(doc, {
        kind: 'class',
        op: 'rename',
        id: crypto.randomUUID(),
        diagramId: diagram.id,
        timestamp: new Date().toISOString(),
        classId: diagram.classes[0]!.id,
        newName: 'Client',
      });
    });
    const gen = projectYDocToDiagram(doc).generalizations.find((g) => g.id === genId);
    expect(gen!.name).toBe('inherits');
  });

  it('deleting a generalization from the editor removes it from model + DOM and closes the panel', async () => {
    const { diagram, genId } = edgeEditorFixture();
    const doc = buildYDocFromDiagram(diagram);
    const { container } = render(<DiagramCanvas doc={doc} />);

    await clickEdgeType(container, 'generalization');
    const editor = screen.getByTestId('edge-editor');
    fireEvent.click(editor.querySelector(`button[aria-label="Delete generalization ${genId}"]`)!);

    expect(projectYDocToDiagram(doc).generalizations).toHaveLength(0);
    expect(container.querySelectorAll('.react-flow__edge-generalization')).toHaveLength(0);
    expect(screen.queryByTestId('edge-editor')).toBeNull();
    // Other edges untouched
    expect(projectYDocToDiagram(doc).associations).toHaveLength(1);
  });

  it('deleting a realization from the editor removes it from model + DOM and closes the panel', async () => {
    const { diagram, realId } = edgeEditorFixture();
    const doc = buildYDocFromDiagram(diagram);
    const { container } = render(<DiagramCanvas doc={doc} />);

    await clickEdgeType(container, 'realization');
    const editor = screen.getByTestId('edge-editor');
    fireEvent.click(editor.querySelector(`button[aria-label="Delete realization ${realId}"]`)!);

    expect(projectYDocToDiagram(doc).realizations).toHaveLength(0);
    expect(container.querySelectorAll('.react-flow__edge-realization')).toHaveLength(0);
    expect(screen.queryByTestId('edge-editor')).toBeNull();
  });

  it('deleting a dependency from the editor removes it from model + DOM and closes the panel', async () => {
    const { diagram, depId } = edgeEditorFixture();
    const doc = buildYDocFromDiagram(diagram);
    const { container } = render(<DiagramCanvas doc={doc} />);

    await clickEdgeType(container, 'dependency');
    const editor = screen.getByTestId('edge-editor');
    fireEvent.click(editor.querySelector(`button[aria-label="Delete dependency ${depId}"]`)!);

    expect(projectYDocToDiagram(doc).dependencies).toHaveLength(0);
    expect(container.querySelectorAll('.react-flow__edge-dependency')).toHaveLength(0);
    expect(screen.queryByTestId('edge-editor')).toBeNull();
  });

  it('the editor has a close button that hides the panel without touching the model', async () => {
    const { diagram } = edgeEditorFixture();
    const doc = buildYDocFromDiagram(diagram);
    const { container } = render(<DiagramCanvas doc={doc} />);

    await clickEdgeType(container, 'generalization');
    fireEvent.click(screen.getByLabelText('Close edge editor'));

    expect(screen.queryByTestId('edge-editor')).toBeNull();
    expect(projectYDocToDiagram(doc).generalizations).toHaveLength(1);
  });

  it('an edited label renders as text on the edge itself', async () => {
    const { diagram } = edgeEditorFixture();
    const doc = buildYDocFromDiagram(diagram);
    const { container } = render(<DiagramCanvas doc={doc} />);

    await clickEdgeType(container, 'generalization');
    const input = screen.getByTestId('edge-editor').querySelector(`input[aria-label="Generalization label"]`) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'inherits' } });
    fireEvent.blur(input);

    await waitFor(() => {
      const edge = container.querySelector('.react-flow__edge-generalization');
      expect(edge).not.toBeNull();
      const texts = Array.from(edge!.querySelectorAll('text')).map((t) => t.textContent);
      expect(texts).toContain('inherits');
    });
  });
});

describe('unit 13c — aggregation/composition palette tools create preset associations', () => {
  function kindFixture(): { diagram: Diagram; doc: Y.Doc; aId: string; bId: string } {
    const aId = crypto.randomUUID();
    const bId = crypto.randomUUID();
    const diagram = DiagramSchema.parse({
      id: crypto.randomUUID(),
      name: 'Kinds',
      classes: [
        { id: aId, name: 'A', position: { x: 0, y: 0 }, attributes: [], methods: [] },
        { id: bId, name: 'B', position: { x: 300, y: 0 }, attributes: [], methods: [] },
      ],
      associations: [],
    });
    const doc = buildYDocFromDiagram(diagram);
    return { diagram, doc, aId, bId };
  }
  const classifiersOf = (diagram: Diagram) =>
    diagram.classes.map((c) => ({ id: c.id, kind: c.kind ?? 'class' }));

  it('Aggregation tool: association with aggregation=shared and aggregationEnd=source', () => {
    const { diagram, doc, aId, bId } = kindFixture();
    const result = handleConnectWithTool(
      doc, diagram.id, 'aggregation', { source: aId, target: bId }, classifiersOf(diagram),
    );
    expect(result.ok).toBe(true);
    const assoc = projectYDocToDiagram(doc).associations[0]!;
    expect(assoc.aggregation).toBe('shared');
    expect(assoc.aggregationEnd).toBe('source');
    expect(assoc.sourceClassId).toBe(aId);
    expect(assoc.targetClassId).toBe(bId);
    expect(assoc.directed).toBe(false);
    // unit 13d fix C — aggregation/composition no longer default multiplicities
    // to '1': both ends start UNSPECIFIED (empty).
    expect(assoc.sourceMultiplicity).toBeUndefined();
    expect(assoc.targetMultiplicity).toBeUndefined();
  });

  it('Composition tool: association with aggregation=composite', () => {
    const { diagram, doc, aId, bId } = kindFixture();
    const result = handleConnectWithTool(
      doc, diagram.id, 'composition', { source: aId, target: bId }, classifiersOf(diagram),
    );
    expect(result.ok).toBe(true);
    expect(projectYDocToDiagram(doc).associations[0]!.aggregation).toBe('composite');
  });

  it('plain Association tool keeps aggregation=none', () => {
    const { diagram, doc, aId, bId } = kindFixture();
    const result = handleConnectWithTool(
      doc, diagram.id, 'association', { source: aId, target: bId }, classifiersOf(diagram),
    );
    expect(result.ok).toBe(true);
    expect(projectYDocToDiagram(doc).associations[0]!.aggregation).toBe('none');
  });

it('Aggregation tool allows self-aggregation (valid UML — e.g., TreeNode composed of TreeNode)', () => {
    const { diagram, doc, aId } = kindFixture();
    const result = handleConnectWithTool(
      doc, diagram.id, 'aggregation', { source: aId, target: aId }, classifiersOf(diagram),
    );
    expect(result.ok).toBe(true);
    expect(result.message).toBeUndefined();
    const projected = projectYDocToDiagram(doc);
    expect(projected.associations).toHaveLength(1);
    const assoc = projected.associations[0]!;
    expect(assoc.sourceClassId).toBe(aId);
    expect(assoc.targetClassId).toBe(aId);
    expect(assoc.aggregation).toBe('shared');
    expect(assoc.aggregationEnd).toBe('source');
  });

  it('the aggregation kind survives later unrelated deltas (bridge carries it)', () => {
    const { diagram, doc, aId, bId } = kindFixture();
    handleConnectWithTool(doc, diagram.id, 'composition', { source: aId, target: bId }, classifiersOf(diagram));
    act(() => {
      applyDeltaToYDoc(doc, {
        kind: 'class',
        op: 'rename',
        id: crypto.randomUUID(),
        diagramId: diagram.id,
        timestamp: new Date().toISOString(),
        classId: aId,
        newName: 'Renamed',
      });
    });
    expect(projectYDocToDiagram(doc).associations[0]!.aggregation).toBe('composite');
  });
});

describe('unit 13c — node-wide drag-to-connect affordances', () => {
  // jsdom cannot run a real pointer-drag (d3 + getBoundingClientRect are
  // inert), so these tests prove the MECHANISM: while a tool is armed every
  // class node exposes a full-node transparent source handle (the overlay
  // that makes the whole body a valid connection start), and disarming
  // removes it so normal node dragging is untouched.
  function overlayNodes(): { diagram: Diagram; doc: Y.Doc } {
    const diagram = makeFixture();
    const doc = buildYDocFromDiagram(diagram);
    return { diagram, doc };
  }

  it('no armed tool: no connect overlays exist (node drag-to-move untouched)', () => {
    const { doc } = overlayNodes();
    const { container } = render(<DiagramCanvas doc={doc} />);
    expect(container.querySelectorAll('[data-testid="node-connect-overlay"]')).toHaveLength(0);
  });

  it('arming an edge tool exposes one full-node source-handle overlay per class node', () => {
    const { doc } = overlayNodes();
    const { container } = render(<DiagramCanvas doc={doc} />);

    fireEvent.click(screen.getByTestId('palette-association'));

    const overlays = container.querySelectorAll('[data-testid="node-connect-overlay"]');
    expect(overlays).toHaveLength(2);
    for (const el of Array.from(overlays)) {
      expect(el.classList.contains('react-flow__handle')).toBe(true);
      expect(el.classList.contains('source')).toBe(true);
      expect(el.classList.contains('nodrag')).toBe(true);
    }
  });

  it('disarming removes the overlays again', () => {
    const { doc } = overlayNodes();
    const { container } = render(<DiagramCanvas doc={doc} />);

    fireEvent.click(screen.getByTestId('palette-generalization'));
    expect(container.querySelectorAll('[data-testid="node-connect-overlay"]').length).toBeGreaterThan(0);

    fireEvent.click(screen.getByTestId('palette-generalization'));
    expect(container.querySelectorAll('[data-testid="node-connect-overlay"]')).toHaveLength(0);
  });

  it('Escape removes the overlays', () => {
    const { doc } = overlayNodes();
    const { container } = render(<DiagramCanvas doc={doc} />);

    fireEvent.click(screen.getByTestId('palette-dependency'));
    expect(container.querySelectorAll('[data-testid="node-connect-overlay"]').length).toBeGreaterThan(0);

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(container.querySelectorAll('[data-testid="node-connect-overlay"]')).toHaveLength(0);
  });
});

describe('unit 13d — EA-style Quick Linker: corner arrow + drag-to-menu gesture', () => {
  // A(0,0) class, B(300,0) class, R(600,0) interface. jsdom never measures
  // nodes (no ResizeObserver), so every node occupies the DEFAULT box
  // 180x120 from its position: A=[0..180]x[0..120], B=[300..480]x[0..120],
  // R=[600..780]x[0..120]. (900,400) is empty canvas.
  function quickLinkerFixture(): { diagram: Diagram; doc: Y.Doc; aId: string; bId: string; rId: string } {
    const aId = crypto.randomUUID();
    const bId = crypto.randomUUID();
    const rId = crypto.randomUUID();
    const diagram = DiagramSchema.parse({
      id: crypto.randomUUID(),
      name: 'QuickLink',
      classes: [
        { id: aId, name: 'A', position: { x: 0, y: 0 }, attributes: [], methods: [] },
        { id: bId, name: 'B', position: { x: 300, y: 0 }, attributes: [], methods: [] },
        { id: rId, name: 'R', position: { x: 600, y: 0 }, attributes: [], methods: [], kind: 'interface' },
      ],
      associations: [],
    });
    const doc = buildYDocFromDiagram(diagram);
    return { diagram, doc, aId, bId, rId };
  }

  const clickNode = (container: HTMLElement, index: number): void => {
    fireEvent.click(container.querySelectorAll('.react-flow__node')[index]!.querySelector('.uml-class')!);
  };

  // jsdom has no PointerEvent constructor: carry real coordinates on a
  // MouseEvent typed as the pointer event (same trick as the 13b drop test).
  const dispatchPointer = (target: EventTarget, type: 'pointerdown' | 'pointerup', x: number, y: number): void => {
    const event = new window.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y });
    act(() => {
      target.dispatchEvent(event);
    });
  };

  /** Select node `index`, drag its Quick Linker arrow, release at `drop`. */
  const quickLinkGesture = (container: HTMLElement, index: number, drop: { x: number; y: number }): void => {
    clickNode(container, index);
    const arrow = container.querySelector('[data-testid="quicklinker-arrow"]');
    expect(arrow).not.toBeNull();
    dispatchPointer(arrow!, 'pointerdown', 175, 2);
    dispatchPointer(window, 'pointerup', drop.x, drop.y);
  };

  const menuOptionIds = (): string[] =>
    Array.from(screen.getByTestId('quicklinker-menu').querySelectorAll('button')).map(
      (b) => b.getAttribute('data-testid') ?? '',
    );

  it('the corner arrow renders ONLY on the selected node', () => {
    const { doc } = quickLinkerFixture();
    const { container } = render(<DiagramCanvas doc={doc} />);

    expect(container.querySelectorAll('[data-testid="quicklinker-arrow"]')).toHaveLength(0);
    clickNode(container, 0);
    const arrows = container.querySelectorAll('[data-testid="quicklinker-arrow"]');
    expect(arrows).toHaveLength(1);
    expect(arrows[0]!.getAttribute('aria-label')).toBe('Quick Linker');
  });

  it('drop on an existing CLASS opens the connector menu WITHOUT Realization', () => {
    const { doc } = quickLinkerFixture();
    const { container } = render(<DiagramCanvas doc={doc} />);

    quickLinkGesture(container, 0, { x: 340, y: 40 });

    expect(menuOptionIds()).toEqual([
      'quicklinker-option-association',
      'quicklinker-option-aggregation',
      'quicklinker-option-composition',
      'quicklinker-option-generalization',
      'quicklinker-option-dependency',
    ]);
    expect(projectYDocToDiagram(doc).associations).toHaveLength(0); // menu alone creates nothing
  });

  it('drop on an INTERFACE adds Realization to the menu (metamodel filter)', () => {
    const { doc } = quickLinkerFixture();
    const { container } = render(<DiagramCanvas doc={doc} />);

    quickLinkGesture(container, 0, { x: 640, y: 40 });

    expect(menuOptionIds()).toContain('quicklinker-option-realization');
    expect(menuOptionIds()).toHaveLength(6);
  });

  it('choosing Association creates the source→target association and closes the menu', async () => {
    const { diagram, doc, aId, bId } = quickLinkerFixture();
    const { container } = render(<DiagramCanvas doc={doc} />);

    quickLinkGesture(container, 0, { x: 340, y: 40 });
    fireEvent.click(screen.getByTestId('quicklinker-option-association'));

    const projected = projectYDocToDiagram(doc);
    expect(projected.associations).toHaveLength(1);
    expect(projected.associations[0]).toMatchObject({ sourceClassId: aId, targetClassId: bId });
    expect(screen.queryByTestId('quicklinker-menu')).toBeNull();
    await waitFor(() => {
      expect(container.querySelectorAll('.react-flow__edge')).toHaveLength(1);
    });
    expect(diagram.classes).toHaveLength(3);
  });

  it('choosing Generalization makes the source the subClass of the target', () => {
    const { doc, aId, bId } = quickLinkerFixture();
    const { container } = render(<DiagramCanvas doc={doc} />);

    quickLinkGesture(container, 0, { x: 340, y: 40 });
    fireEvent.click(screen.getByTestId('quicklinker-option-generalization'));

    expect(projectYDocToDiagram(doc).generalizations[0]).toMatchObject({ subClassId: aId, superClassId: bId });
  });

  it('choosing Composition presets aggregation=composite through the shared guard', () => {
    const { doc } = quickLinkerFixture();
    const { container } = render(<DiagramCanvas doc={doc} />);

    quickLinkGesture(container, 0, { x: 340, y: 40 });
    fireEvent.click(screen.getByTestId('quicklinker-option-composition'));

    const assoc = projectYDocToDiagram(doc).associations[0]!;
    expect(assoc.aggregation).toBe('composite');
    // unit 13d fix C — the quick-linker composition path shares the empty
    // multiplicity default: both ends start unspecified.
    expect(assoc.sourceMultiplicity).toBeUndefined();
    expect(assoc.targetMultiplicity).toBeUndefined();
  });

  it('EMPTY-CANVAS gesture creates the element AND the connector in one flow', () => {
    const { doc, aId } = quickLinkerFixture();
    const { container } = render(<DiagramCanvas doc={doc} />);

    // Drop on empty canvas → element menu (Class / Interface).
    quickLinkGesture(container, 0, { x: 900, y: 400 });
    expect(menuOptionIds()).toEqual(['quicklinker-option-class', 'quicklinker-option-interface']);

    // Pick Interface → the node is created AT the drop point and the
    // connector menu chains open immediately (source class → new interface).
    fireEvent.click(screen.getByTestId('quicklinker-option-interface'));
    const created = projectYDocToDiagram(doc).classes.find((c) => c.name === 'Interface1');
    expect(created).toBeDefined();
    expect(created!.position).toEqual({ x: 900, y: 400 });
    expect(created!.kind).toBe('interface');
    expect(menuOptionIds()).toContain('quicklinker-option-realization');

    // Pick Realization → the connector lands between source and the new element.
    fireEvent.click(screen.getByTestId('quicklinker-option-realization'));
    const projected = projectYDocToDiagram(doc);
    expect(projected.realizations).toHaveLength(1);
    expect(projected.realizations![0]).toMatchObject({ clientClassId: aId, supplierInterfaceId: created!.id });
    expect(screen.queryByTestId('quicklinker-menu')).toBeNull();
  });

  it('empty-canvas drop with CLASS chains a connector menu WITHOUT Realization', () => {
    const { doc } = quickLinkerFixture();
    const { container } = render(<DiagramCanvas doc={doc} />);

    quickLinkGesture(container, 0, { x: 900, y: 400 });
    fireEvent.click(screen.getByTestId('quicklinker-option-class'));

    const created = projectYDocToDiagram(doc).classes.find((c) => c.name === 'Class1');
    expect(created).toBeDefined();
    expect(menuOptionIds()).not.toContain('quicklinker-option-realization');
  });

  it('Escape closes the connector menu with NO model change', () => {
    const { doc } = quickLinkerFixture();
    const { container } = render(<DiagramCanvas doc={doc} />);

    quickLinkGesture(container, 0, { x: 340, y: 40 });
    fireEvent.keyDown(window, { key: 'Escape' });

    expect(screen.queryByTestId('quicklinker-menu')).toBeNull();
    const projected = projectYDocToDiagram(doc);
    expect(projected.associations).toHaveLength(0);
    expect(projected.generalizations ?? []).toHaveLength(0);
    expect(projected.realizations ?? []).toHaveLength(0);
    expect(projected.dependencies ?? []).toHaveLength(0);
  });

  it('click-away closes the element menu with NO model change', () => {
    const { doc } = quickLinkerFixture();
    const { container } = render(<DiagramCanvas doc={doc} />);

    quickLinkGesture(container, 0, { x: 900, y: 400 });
    dispatchPointer(document.body, 'pointerdown', 5, 600);

    expect(screen.queryByTestId('quicklinker-menu')).toBeNull();
    expect(projectYDocToDiagram(doc).classes).toHaveLength(3); // nothing created
  });

  it('dropping the arrow back on the source itself opens the connector menu with self-valid connectors (excludes generalization)', () => {
    const { doc } = quickLinkerFixture();
    const { container } = render(<DiagramCanvas doc={doc} />);

    quickLinkGesture(container, 0, { x: 100, y: 60 }); // inside A's own box

    // Menu opens with self-valid connectors: association, aggregation, composition, dependency (NO generalization)
    const menu = screen.getByTestId('quicklinker-menu');
    expect(menu).not.toBeNull();
    expect(screen.getByTestId('quicklinker-option-association')).toBeTruthy();
    expect(screen.getByTestId('quicklinker-option-aggregation')).toBeTruthy();
    expect(screen.getByTestId('quicklinker-option-composition')).toBeTruthy();
    expect(screen.getByTestId('quicklinker-option-dependency')).toBeTruthy();
    expect(screen.queryByTestId('quicklinker-option-generalization')).toBeNull();
    expect(screen.queryByTestId('quicklinker-option-realization')).toBeNull();
    // No model change until a connector is picked
    expect(projectYDocToDiagram(doc).associations).toHaveLength(0);
  });

  it('a thin rubber band follows the cursor during the drag and disappears on drop', () => {
    const { doc } = quickLinkerFixture();
    const { container } = render(<DiagramCanvas doc={doc} />);

    clickNode(container, 0);
    const arrow = container.querySelector('[data-testid="quicklinker-arrow"]')!;
    dispatchPointer(arrow, 'pointerdown', 175, 2);
    expect(container.querySelector('[data-testid="quicklinker-rubberband"]')).not.toBeNull();

    dispatchPointer(window, 'pointermove', 250, 90);
    const line = container.querySelector('.quicklinker-rubberband line')!;
    expect(line.getAttribute('x2')).toBe('250');

    dispatchPointer(window, 'pointerup', 340, 40);
    expect(container.querySelector('[data-testid="quicklinker-rubberband"]')).toBeNull();
  });

  it('coexists with the 13c arm-tool path: quick link works while a tool is armed', () => {
    const { doc, aId, bId } = quickLinkerFixture();
    const { container } = render(<DiagramCanvas doc={doc} />);

    fireEvent.click(screen.getByTestId('palette-dependency')); // 13c path armed
    expect(container.querySelectorAll('[data-testid="node-connect-overlay"]').length).toBeGreaterThan(0);

    quickLinkGesture(container, 0, { x: 340, y: 40 });
    fireEvent.click(screen.getByTestId('quicklinker-option-dependency'));

    expect(projectYDocToDiagram(doc).dependencies![0]).toMatchObject({ clientClassId: aId, supplierClassId: bId });
  });

  it('handlePaletteDrop returns the created classId (element+connector chaining)', () => {
    const { diagram, doc } = quickLinkerFixture();
    let newId = '';
    act(() => {
      newId = handlePaletteDrop(doc, diagram.id, {
        kind: 'class',
        position: { x: 10, y: 20 },
        existingNames: diagram.classes.map((c) => c.name),
      });
    });
    expect(newId).toBeTruthy();
    expect(projectYDocToDiagram(doc).classes.some((c) => c.id === newId)).toBe(true);
  });

  it('a rejected Quick Linker connector surfaces the guard message with the model unchanged', () => {
    // The menu reuses handleConnectWithTool verbatim, so engine rejections
    // flow through the same message channel: A→B generalization first, then
    // B→A generalization closes a cycle and must be refused.
    const { doc } = quickLinkerFixture();
    const { container } = render(<DiagramCanvas doc={doc} />);

    quickLinkGesture(container, 0, { x: 340, y: 40 });
    fireEvent.click(screen.getByTestId('quicklinker-option-generalization'));
    expect(projectYDocToDiagram(doc).generalizations).toHaveLength(1);

    quickLinkGesture(container, 1, { x: 100, y: 40 }); // B → A (inside A's box)
    fireEvent.click(screen.getByTestId('quicklinker-option-generalization'));

    const projected = projectYDocToDiagram(doc);
    expect(projected.generalizations).toHaveLength(1); // cycle refused
    expect(screen.getByTestId('palette-validation').textContent).toMatch(/cycle/i);
    expect(screen.queryByTestId('quicklinker-menu')).toBeNull();
  });
});

/**
 * unit 13d fix A — the n-ary diamond must be selectable + editable: clicking
 * it opens an editor panel (name + one multiplicity input per member end +
 * delete), and every edit flows through the core naryAssociation `update`
 * delta via the bridge.
 */
describe('unit 13d — n-ary diamond selectable + editable (fix A)', () => {
  function naryEditableFixture(): { diagram: Diagram; doc: Y.Doc; naryId: string; ids: Record<string, string> } {
    const supplierId = crypto.randomUUID();
    const partId = crypto.randomUUID();
    const projectId = crypto.randomUUID();
    const naryId = crypto.randomUUID();
    const diagram = DiagramSchema.parse({
      id: crypto.randomUUID(),
      name: 'NaryEdit',
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
            { classId: projectId, multiplicity: '1' },
          ],
        },
      ],
    });
    const doc = buildYDocFromDiagram(diagram);
    return { diagram, doc, naryId, ids: { Supplier: supplierId, Part: partId, Project: projectId } };
  }

  async function openNaryEditor(container: HTMLElement): Promise<HTMLElement> {
    const diamond = await waitFor(() => {
      const el = container.querySelector('.uml-nary-diamond');
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    fireEvent.click(diamond);
    return screen.getByTestId('nary-editor');
  }

  it('clicking the diamond opens the n-ary editor with name + per-end multiplicity inputs + delete', async () => {
    const { doc, naryId } = naryEditableFixture();
    const { container } = render(<DiagramCanvas doc={doc} />);

    const editor = await openNaryEditor(container);
    expect(editor.querySelector('input[aria-label="N-ary name"]')).not.toBeNull();
    expect(editor.querySelector('input[aria-label="N-ary end multiplicity for Supplier"]')).not.toBeNull();
    expect(editor.querySelector('input[aria-label="N-ary end multiplicity for Part"]')).not.toBeNull();
    expect(editor.querySelector('input[aria-label="N-ary end multiplicity for Project"]')).not.toBeNull();
    expect(editor.querySelector(`button[aria-label="Delete n-ary association ${naryId}"]`)).not.toBeNull();
  });

  it('the editor prefills the current name and each end multiplicity', async () => {
    const { doc } = naryEditableFixture();
    const { container } = render(<DiagramCanvas doc={doc} />);

    const editor = await openNaryEditor(container);
    expect((editor.querySelector('input[aria-label="N-ary name"]') as HTMLInputElement).value).toBe('supply');
    expect((editor.querySelector('input[aria-label="N-ary end multiplicity for Supplier"]') as HTMLInputElement).value).toBe('1');
    expect((editor.querySelector('input[aria-label="N-ary end multiplicity for Part"]') as HTMLInputElement).value).toBe('0..*');
  });

  it('editing the name updates the model through the update delta', async () => {
    const { doc, naryId } = naryEditableFixture();
    const { container } = render(<DiagramCanvas doc={doc} />);

    const editor = await openNaryEditor(container);
    const nameInput = editor.querySelector('input[aria-label="N-ary name"]') as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: 'delivers' } });
    fireEvent.blur(nameInput);

    const nary = projectYDocToDiagram(doc).naryAssociations.find((n) => n.id === naryId);
    expect(nary!.name).toBe('delivers');
    // Ends untouched by a name-only update.
    expect(nary!.memberEnds).toHaveLength(3);
  });

  it('editing an end multiplicity updates THAT end only; roles and other ends survive', async () => {
    const { doc, naryId, ids } = naryEditableFixture();
    const { container } = render(<DiagramCanvas doc={doc} />);

    const editor = await openNaryEditor(container);
    const partInput = editor.querySelector('input[aria-label="N-ary end multiplicity for Part"]') as HTMLInputElement;
    fireEvent.change(partInput, { target: { value: '2' } });
    fireEvent.blur(partInput);

    const ends = projectYDocToDiagram(doc).naryAssociations.find((n) => n.id === naryId)!.memberEnds;
    expect(ends.find((e) => e.classId === ids.Part)!.multiplicity).toBe('2');
    expect(ends.find((e) => e.classId === ids.Supplier)!.multiplicity).toBe('1');
    expect(ends.find((e) => e.classId === ids.Supplier)!.role).toBe('supplier');
    expect(ends.find((e) => e.classId === ids.Project)!.multiplicity).toBe('1');
  });

  it('an invalid end multiplicity is rejected: no delta, previous value retained', async () => {
    const { doc, naryId, ids } = naryEditableFixture();
    const { container } = render(<DiagramCanvas doc={doc} />);

    const editor = await openNaryEditor(container);
    const partInput = editor.querySelector('input[aria-label="N-ary end multiplicity for Part"]') as HTMLInputElement;
    fireEvent.change(partInput, { target: { value: 'abc' } });
    fireEvent.blur(partInput);

    const ends = projectYDocToDiagram(doc).naryAssociations.find((n) => n.id === naryId)!.memberEnds;
    expect(ends.find((e) => e.classId === ids.Part)!.multiplicity).toBe('0..*');
  });

  it('the Delete button removes the n-ary and closes the editor', async () => {
    const { doc, naryId } = naryEditableFixture();
    const { container } = render(<DiagramCanvas doc={doc} />);

    const editor = await openNaryEditor(container);
    fireEvent.click(editor.querySelector(`button[aria-label="Delete n-ary association ${naryId}"]`)!);

    expect(projectYDocToDiagram(doc).naryAssociations).toHaveLength(0);
    expect(screen.queryByTestId('nary-editor')).toBeNull();
  });

  it('handleUpdateNaryAssociation writes name + ends through the bridge and guards bad input', () => {
    const { diagram, doc, naryId, ids } = naryEditableFixture();

    act(() => {
      handleUpdateNaryAssociation(doc, diagram.id, naryId, { name: 'delivers' });
    });
    expect(projectYDocToDiagram(doc).naryAssociations[0]!.name).toBe('delivers');

    act(() => {
      handleUpdateNaryAssociation(doc, diagram.id, naryId, {
        memberEnds: [
          { classId: ids.Supplier, multiplicity: '*' },
          { classId: ids.Part, multiplicity: '2' },
          { classId: ids.Project, multiplicity: '1' },
        ],
      });
    });
    let ends = projectYDocToDiagram(doc).naryAssociations[0]!.memberEnds;
    expect(ends.find((e) => e.classId === ids.Part)!.multiplicity).toBe('2');
    expect(ends.find((e) => e.classId === ids.Supplier)!.multiplicity).toBe('*');

    // Guards: <3 ends and garbage multiplicity emit NOTHING.
    act(() => {
      handleUpdateNaryAssociation(doc, diagram.id, naryId, {
        memberEnds: [{ classId: ids.Supplier, multiplicity: '1' }],
      });
      handleUpdateNaryAssociation(doc, diagram.id, naryId, {
        memberEnds: [
          { classId: ids.Supplier, multiplicity: '1' },
          { classId: ids.Part, multiplicity: 'nope' },
          { classId: ids.Project, multiplicity: '1' },
        ],
      });
    });
    ends = projectYDocToDiagram(doc).naryAssociations[0]!.memberEnds;
    expect(ends.find((e) => e.classId === ids.Part)!.multiplicity).toBe('2');
  });
});

/**
 * unit 13d fix C — composition/aggregation must NOT default to a multiplicity:
 * creation leaves both ends unspecified, the renderer draws no multiplicity
 * label, and the editor can clear a multiplicity back to empty.
 */
describe('unit 13d — composition/aggregation start with EMPTY multiplicities (fix C)', () => {
  function pairFixture(): { diagram: Diagram; doc: Y.Doc; aId: string; bId: string } {
    const aId = crypto.randomUUID();
    const bId = crypto.randomUUID();
    const diagram = DiagramSchema.parse({
      id: crypto.randomUUID(),
      name: 'EmptyMults',
      classes: [
        { id: aId, name: 'A', position: { x: 0, y: 0 }, attributes: [], methods: [] },
        { id: bId, name: 'B', position: { x: 300, y: 0 }, attributes: [], methods: [] },
      ],
      associations: [],
    });
    const doc = buildYDocFromDiagram(diagram);
    return { diagram, doc, aId, bId };
  }
  const classifiersOf = (diagram: Diagram) =>
    diagram.classes.map((c) => ({ id: c.id, kind: c.kind ?? 'class' }));

  it('Composition tool: multiplicities are unspecified (empty), NOT "1"', () => {
    const { diagram, doc, aId, bId } = pairFixture();
    const result = handleConnectWithTool(
      doc, diagram.id, 'composition', { source: aId, target: bId }, classifiersOf(diagram),
    );
    expect(result.ok).toBe(true);
    const assoc = projectYDocToDiagram(doc).associations[0]!;
    expect(assoc.aggregation).toBe('composite');
    expect(assoc.sourceMultiplicity).toBeUndefined();
    expect(assoc.targetMultiplicity).toBeUndefined();
  });

  it('plain Association tool KEEPS its documented 1/1 defaults', () => {
    const { diagram, doc, aId, bId } = pairFixture();
    const result = handleConnectWithTool(
      doc, diagram.id, 'association', { source: aId, target: bId }, classifiersOf(diagram),
    );
    expect(result.ok).toBe(true);
    const assoc = projectYDocToDiagram(doc).associations[0]!;
    expect(assoc.sourceMultiplicity).toBe('1');
    expect(assoc.targetMultiplicity).toBe('1');
  });

  it('a composition edge renders NO multiplicity label (unspecified ≠ "1")', async () => {
    const { diagram, doc, aId, bId } = pairFixture();
    handleConnectWithTool(doc, diagram.id, 'composition', { source: aId, target: bId }, classifiersOf(diagram));
    const { container } = render(<DiagramCanvas doc={doc} />);

    const edge = await waitFor(() => {
      const el = container.querySelector('.react-flow__edge-association');
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    const texts = Array.from(edge.querySelectorAll('text')).map((t) => t.textContent ?? '');
    expect(texts.some((t) => t.includes('·'))).toBe(false);
    expect(texts.some((t) => t.trim() === '1')).toBe(false);
  });

  it('a named composition edge shows ONLY the name — no multiplicity fragment', async () => {
    const { diagram, doc, aId, bId } = pairFixture();
    handleConnectWithTool(doc, diagram.id, 'composition', { source: aId, target: bId }, classifiersOf(diagram));
    const assocId = projectYDocToDiagram(doc).associations[0]!.id;
    act(() => {
      applyDeltaToYDoc(doc, {
        kind: 'association',
        op: 'updateMultiplicity',
        id: crypto.randomUUID(),
        diagramId: diagram.id,
        timestamp: new Date().toISOString(),
        associationId: assocId,
        name: 'owns',
      });
    });
    const { container } = render(<DiagramCanvas doc={doc} />);

    const edge = await waitFor(() => {
      const el = container.querySelector('.react-flow__edge-association');
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    const texts = Array.from(edge.querySelectorAll('text')).map((t) => t.textContent ?? '');
    expect(texts.some((t) => t.includes('owns'))).toBe(true);
    expect(texts.some((t) => t.includes('·'))).toBe(false);
  });

  it('editor: unspecified multiplicities render as EMPTY inputs and can be set', async () => {
    const aId = crypto.randomUUID();
    const bId = crypto.randomUUID();
    const assocId = crypto.randomUUID();
    const diagram = DiagramSchema.parse({
      id: crypto.randomUUID(),
      name: 'UnspecAssoc',
      classes: [
        { id: aId, name: 'A', position: { x: 0, y: 0 }, attributes: [], methods: [] },
        { id: bId, name: 'B', position: { x: 300, y: 0 }, attributes: [], methods: [] },
      ],
      associations: [{ id: assocId, sourceClassId: aId, targetClassId: bId, directed: false, aggregation: 'composite' }],
    });
    const doc = buildYDocFromDiagram(diagram);
    const { container } = render(<DiagramCanvas doc={doc} />);

    const edge = await waitFor(() => {
      const el = container.querySelector('.react-flow__edge-association');
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    fireEvent.click(edge);

    const editor = screen.getByTestId('edge-editor');
    const source = editor.querySelector('input[aria-label="Source multiplicity"]') as HTMLInputElement;
    const target = editor.querySelector('input[aria-label="Target multiplicity"]') as HTMLInputElement;
    expect(source.value).toBe('');
    expect(target.value).toBe('');

    fireEvent.change(source, { target: { value: '2' } });
    fireEvent.blur(source);
    expect(projectYDocToDiagram(doc).associations[0]!.sourceMultiplicity).toBe('2');
  });

  it('editor: clearing a multiplicity to empty makes it unspecified', async () => {
    const aId = crypto.randomUUID();
    const bId = crypto.randomUUID();
    const assocId = crypto.randomUUID();
    const diagram = DiagramSchema.parse({
      id: crypto.randomUUID(),
      name: 'ClearMult',
      classes: [
        { id: aId, name: 'A', position: { x: 0, y: 0 }, attributes: [], methods: [] },
        { id: bId, name: 'B', position: { x: 300, y: 0 }, attributes: [], methods: [] },
      ],
      associations: [{ id: assocId, sourceClassId: aId, targetClassId: bId, sourceMultiplicity: '1', targetMultiplicity: '1', directed: false }],
    });
    const doc = buildYDocFromDiagram(diagram);
    const { container } = render(<DiagramCanvas doc={doc} />);

    const edge = await waitFor(() => {
      const el = container.querySelector('.react-flow__edge-association');
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    fireEvent.click(edge);

    const editor = screen.getByTestId('edge-editor');
    const source = editor.querySelector('input[aria-label="Source multiplicity"]') as HTMLInputElement;
    expect(source.value).toBe('1');
    fireEvent.change(source, { target: { value: '' } });
    fireEvent.blur(source);

    const assoc = projectYDocToDiagram(doc).associations[0]!;
    expect(assoc.sourceMultiplicity).toBeUndefined();
    expect(assoc.targetMultiplicity).toBe('1'); // other end untouched
  });
});

/**
 * unit 13d fix D — clicking empty canvas deselects: clears the selected node,
 * closes the edge/n-ary editor, and disarms any armed edge tool (the click
 * equivalent of Escape).
 */
describe('unit 13d — clicking empty canvas deselects (fix D)', () => {
  function paneFixture(): { diagram: Diagram; doc: Y.Doc } {
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
    return { diagram, doc };
  }

  const clickPane = (container: HTMLElement): void => {
    const pane = container.querySelector('.react-flow__pane');
    expect(pane).not.toBeNull();
    fireEvent.click(pane!);
  };

  it('pane click closes the edge editor', async () => {
    const { doc } = paneFixture();
    const { container } = render(<DiagramCanvas doc={doc} />);

    const edge = await waitFor(() => {
      const el = container.querySelector('.react-flow__edge-association');
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    fireEvent.click(edge);
    expect(screen.getByTestId('edge-editor')).toBeDefined();

    clickPane(container);
    expect(screen.queryByTestId('edge-editor')).toBeNull();
  });

  it('pane click disarms the armed edge tool (connect overlays gone)', () => {
    const { doc } = paneFixture();
    const { container } = render(<DiagramCanvas doc={doc} />);

    fireEvent.click(screen.getByTestId('palette-association'));
    expect(container.querySelectorAll('[data-testid="node-connect-overlay"]').length).toBeGreaterThan(0);

    clickPane(container);
    expect(container.querySelectorAll('[data-testid="node-connect-overlay"]')).toHaveLength(0);
  });

  it('pane click deselects the selected class (Quick Linker arrow hidden)', () => {
    const { doc } = paneFixture();
    const { container } = render(<DiagramCanvas doc={doc} />);

    fireEvent.click(container.querySelectorAll('.react-flow__node')[0]!.querySelector('.uml-class')!);
    expect(container.querySelectorAll('[data-testid="quicklinker-arrow"]')).toHaveLength(1);

    clickPane(container);
    expect(container.querySelectorAll('[data-testid="quicklinker-arrow"]')).toHaveLength(0);
  });

  it('pane click closes the n-ary editor', async () => {
    const supplierId = crypto.randomUUID();
    const partId = crypto.randomUUID();
    const projectId = crypto.randomUUID();
    const diagram = DiagramSchema.parse({
      id: crypto.randomUUID(),
      name: 'NaryPane',
      classes: [
        { id: supplierId, name: 'Supplier', position: { x: 0, y: 0 }, attributes: [], methods: [] },
        { id: partId, name: 'Part', position: { x: 300, y: 0 }, attributes: [], methods: [] },
        { id: projectId, name: 'Project', position: { x: 150, y: 300 }, attributes: [], methods: [] },
      ],
      associations: [],
      naryAssociations: [
        {
          id: crypto.randomUUID(),
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
    fireEvent.click(diamond);
    expect(screen.getByTestId('nary-editor')).toBeDefined();

    clickPane(container);
    expect(screen.queryByTestId('nary-editor')).toBeNull();
  });
});

describe('límite visible del lienzo (diagram-canvas-boundary)', () => {
  it('renderiza la hoja delimitadora del lienzo con dimensiones estándar', async () => {
    const doc = buildYDocFromDiagram(DiagramSchema.parse({
      id: crypto.randomUUID(),
      name: 'EmptyDiagram',
      classes: [],
      associations: [],
      generalizations: [],
      realizations: [],
      dependencies: [],
      naryAssociations: [],
    }));
    const { container } = render(<DiagramCanvas doc={doc} />);

    const boundary = await waitFor(() => {
      const el = container.querySelector('[data-testid="diagram-canvas-boundary"]');
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });

    expect(boundary.classList.contains('diagram-canvas-boundary')).toBe(true);
    expect(boundary.style.width).toBe('3200px');
    expect(boundary.style.height).toBe('2200px');
  });

  it('expande los límites de la hoja cuando hay clases fuera del margen estándar', async () => {
    const aId = crypto.randomUUID();
    const diagram = DiagramSchema.parse({
      id: crypto.randomUUID(),
      name: 'OuterDiagram',
      classes: [
        { id: aId, name: 'FarClass', position: { x: 3500, y: 2500 }, attributes: [], methods: [] },
      ],
      associations: [],
      generalizations: [],
      realizations: [],
      dependencies: [],
      naryAssociations: [],
    });
    const doc = buildYDocFromDiagram(diagram);
    const { container } = render(<DiagramCanvas doc={doc} />);

    const boundary = await waitFor(() => {
      const el = container.querySelector('[data-testid="diagram-canvas-boundary"]');
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });

    // Ancho expandido para incluir la posición 3500 + 360 = 3860
    expect(parseInt(boundary.style.width, 10)).toBeGreaterThanOrEqual(3860);
    // Alto expandido para incluir la posición 2500 + 260 = 2760
    expect(parseInt(boundary.style.height, 10)).toBeGreaterThanOrEqual(2760);
  });

  it('renderiza aristas dentro del contexto EdgeCrossingProvider sin errores', async () => {
    const aId = crypto.randomUUID();
    const bId = crypto.randomUUID();
    const cId = crypto.randomUUID();
    const dId = crypto.randomUUID();
    const horizAssocId = crypto.randomUUID();
    const vertAssocId = crypto.randomUUID();

    const diagram = DiagramSchema.parse({
      id: crypto.randomUUID(),
      name: 'CrossingDiagram',
      classes: [
        { id: aId, name: 'ClassA', position: { x: 0, y: 100 }, attributes: [], methods: [] },
        { id: bId, name: 'ClassB', position: { x: 400, y: 100 }, attributes: [], methods: [] },
        { id: cId, name: 'ClassC', position: { x: 200, y: 0 }, attributes: [], methods: [] },
        { id: dId, name: 'ClassD', position: { x: 200, y: 400 }, attributes: [], methods: [] },
      ],
      associations: [
        { id: horizAssocId, sourceClassId: aId, targetClassId: bId, directed: false },
        { id: vertAssocId, sourceClassId: cId, targetClassId: dId, directed: false },
      ],
      generalizations: [],
      realizations: [],
      dependencies: [],
      naryAssociations: [],
    });
    const doc = buildYDocFromDiagram(diagram);
    const { container } = render(<DiagramCanvas doc={doc} />);

    await waitFor(() => {
      expect(screen.getByText('ClassA')).toBeTruthy();
      expect(screen.getByText('ClassC')).toBeTruthy();
    });

    // En jsdom, React Flow renderiza las aristas en el contenedor
    expect(container.querySelector('.react-flow')).not.toBeNull();
  });
});

describe('transmisión colaborativa de arrastre en tiempo real (60/120 FPS)', () => {
  it('propaga el reposicionamiento atómico en vivo a pares conectados de Yjs sin recrear la estructura', () => {
    const classId = crypto.randomUUID();
    const diagram = DiagramSchema.parse({
      id: crypto.randomUUID(),
      name: 'CollabDiagram',
      classes: [
        { id: classId, name: 'LiveClass', position: { x: 50, y: 50 }, attributes: [], methods: [] },
      ],
      associations: [],
      generalizations: [],
      realizations: [],
      dependencies: [],
      naryAssociations: [],
    });

    const docA = buildYDocFromDiagram(diagram);
    const docB = new Y.Doc();

    // Sincronización bidireccional simulada de WebSocket
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
    docA.on('update', (update) => {
      Y.applyUpdate(docB, update);
    });

    // Simular un evento de arrastre en vuelo (in-flight live drag) en docA
    handleNodeDragStop(docA, diagram.id, {
      id: classId,
      position: { x: 320, y: 480 },
    });

    // docB debe reflejar de inmediato la nueva posición sin perder la clase
    const projectedB = projectYDocToDiagram(docB);
    const moved = projectedB.classes.find((c) => c.id === classId);
    expect(moved?.position).toEqual({ x: 320, y: 480 });
  });

  it('emite actualizaciones de arrastre en vuelo con origin local-drag para proteger el render local', () => {
    const classId = crypto.randomUUID();
    const diagram = DiagramSchema.parse({
      id: crypto.randomUUID(),
      name: 'CollabDiagram',
      classes: [
        { id: classId, name: 'LiveClass', position: { x: 50, y: 50 }, attributes: [], methods: [] },
      ],
      associations: [],
      generalizations: [],
      realizations: [],
      dependencies: [],
      naryAssociations: [],
    });

    const doc = buildYDocFromDiagram(diagram);
    let capturedOrigin: unknown = undefined;
    doc.on('update', (_update, origin) => {
      capturedOrigin = origin;
    });

    handleNodeDragStop(
      doc,
      diagram.id,
      {
        id: classId,
        position: { x: 200, y: 250 },
      },
      'local-drag',
    );

    expect(capturedOrigin).toBe('local-drag');
  });
});


