import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildYDocFromDiagram, projectYDocToDiagram } from '@app/core';

import { applyDeltaToYDoc } from '../canvas/applyDeltaToYDoc';
import { ImportXmiButton } from './ImportXmiButton';

/**
 * unit 15.6 — ImportXmiButton behavior contract.
 *
 * The control drives the XMI import: pick a file → POST the raw XMI text to
 * /diagrams/:id/import/xmi as a SINGLE request (one atomic batch, never N
 * per-element calls) → apply the returned batch delta atomically to the
 * app-owned Y.Doc (editor:R1: the canvas renders from the model, the button
 * never touches /save). Rejections — server-side, schema-level or engine-level
 * — must surface to the user and leave the doc byte-for-byte unchanged, and
 * the control must stay usable for a retry afterwards.
 *
 * House convention (App.test.tsx): mock at the fetch boundary with
 * vi.stubGlobal('fetch', ...); no snapshots, no implementation details.
 */
const API_BASE = 'http://localhost:3000';
const IMPORT_ARIA = 'Import an Enterprise Architect XMI 2.1 file';
const XMI_TEXT = '<?xml version="1.0" encoding="UTF-8"?>\n<xmi:XMI xmi:version="2.1">stub</xmi:XMI>\n';

const uuid = (): string => crypto.randomUUID();
const now = (): string => new Date().toISOString();

/** Response stub in the shape the web app's REST client consumes (App.test.tsx pattern). */
function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

/** Deferred so tests can observe the in-flight phase before the API replies. */
function deferredResponse(): { promise: Promise<Response>; resolve: (r: Response) => void } {
  let resolveFn: (r: Response) => void = () => {};
  const promise = new Promise<Response>((resolve) => {
    resolveFn = resolve;
  });
  return { promise, resolve: resolveFn };
}

function makeFile(name: string, content: string): File {
  const file = new File([content], name, { type: 'application/xml' });
  // jsdom still lacks Blob.prototype.text; the component legitimately awaits
  // it, so supply the standard Web API from the backing content (environment
  // polyfill, not a mock of the component).
  if (typeof (file as unknown as { text?: unknown }).text !== 'function') {
    Object.defineProperty(file, 'text', {
      value: async () => content,
      configurable: true,
    });
  }
  return file;
}

/** Picks a file through the component's hidden input (fireEvent.change, act-wrapped). */
async function pickFile(container: HTMLElement, file: File): Promise<void> {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  expect(input).toBeTruthy();
  await act(async () => {
    fireEvent.change(input, { target: { files: [file] } });
  });
}

// ── Batch fixtures (core DeltaSchema shapes: strict, uuid ids, ISO timestamps) ──

function classCreate(diagramId: string, classId: string, name: string, x: number) {
  return {
    id: uuid(),
    diagramId,
    timestamp: now(),
    kind: 'class' as const,
    op: 'create' as const,
    classId,
    name,
    position: { x, y: 40 },
  };
}

function associationCreate(diagramId: string, associationId: string, sourceClassId: string, targetClassId: string) {
  return {
    id: uuid(),
    diagramId,
    timestamp: now(),
    kind: 'association' as const,
    op: 'create' as const,
    associationId,
    sourceClassId,
    targetClassId,
    // Engine gate (apply.ts): create requires both ends AND directedness.
    directed: false,
  };
}

function batch(diagramId: string, deltas: unknown[]) {
  return {
    id: uuid(),
    diagramId,
    timestamp: now(),
    kind: 'batch' as const,
    deltas,
  };
}

function importReply(diagramId: string, deltas: unknown[]) {
  const classCount = (deltas as { kind?: string; op?: string }[]).filter(
    (d) => d.kind === 'class' && d.op === 'create',
  ).length;
  return {
    deltaId: uuid(),
    batch: batch(diagramId, deltas),
    summary: {
      classes: classCount,
      associations: 0,
      generalizations: 0,
      realizations: 0,
      dependencies: 0,
      naryAssociations: 0,
    },
  };
}

/** Empty diagram fixture hydrated into the doc the button receives as a prop. */
function makeDoc(diagramId: string) {
  return buildYDocFromDiagram({
    id: diagramId,
    name: 'Import target',
    classes: [],
    associations: [],
    generalizations: [],
    realizations: [],
    dependencies: [],
    naryAssociations: [],
  });
}

function renderButton(diagramId: string | null, doc: ReturnType<typeof makeDoc>, disabled = false) {
  return render(<ImportXmiButton doc={doc} diagramId={diagramId} disabled={disabled} />);
}

/** The import button with its real element type (getByRole defaults to HTMLElement). */
function importButton(): HTMLButtonElement {
  return screen.getByRole<HTMLButtonElement>('button', { name: IMPORT_ARIA });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ImportXmiButton — rendering', () => {
  it('renders the import button with a stable accessible name', () => {
    renderButton(uuid(), makeDoc(uuid()));
    const button = importButton();
    expect(button.textContent).toBe('Import XMI');
  });

  it('restricts the file picker to XMI/XML types only', () => {
    const { container } = renderButton(uuid(), makeDoc(uuid()));
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input).toBeTruthy();
    expect(input.accept).toMatch(/\.xmi/);
    expect(input.accept).toMatch(/xml/i);
    // The picker must not accept arbitrary types (no wildcard).
    expect(input.accept).not.toContain('*');
  });

  it('is disabled while no diagram id is available or the editor is not ready', () => {
    const doc = makeDoc(uuid());
    const withoutId = renderButton(null, doc);
    expect(importButton().disabled).toBe(true);
    withoutId.unmount();

    renderButton(uuid(), makeDoc(uuid()), true);
    expect(importButton().disabled).toBe(true);
  });
});

describe('ImportXmiButton — happy path (single atomic batch)', () => {
  it('sends the picked XMI once, shows an in-flight state, and applies the returned batch to the Y.Doc', async () => {
    const diagramId = uuid();
    const doc = makeDoc(diagramId);
    const customer = uuid();
    const order = uuid();
    const reply = importReply(diagramId, [
      classCreate(diagramId, customer, 'Customer', 10),
      classCreate(diagramId, order, 'Order', 300),
      associationCreate(diagramId, uuid(), customer, order),
    ]);
    const gate = deferredResponse();
    const fetchMock = vi.fn().mockImplementation(() => gate.promise);
    vi.stubGlobal('fetch', fetchMock);

    const { container } = renderButton(diagramId, doc);
    await pickFile(container, makeFile('model.xmi', XMI_TEXT));

    // Transport contract: exactly ONE POST to the import route carrying the raw file text.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${API_BASE}/diagrams/${diagramId}/import/xmi`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ xmi: XMI_TEXT });

    // In-flight: the control is disabled and labels the work in progress.
    const button = importButton();
    expect(button.disabled).toBe(true);
    expect(button.textContent).toBe('Importing…');

    await act(async () => {
      gate.resolve(jsonResponse(reply));
    });

    // Success is surfaced and the whole batch landed in the doc through the
    // single request (no per-element calls happened).
    expect(await screen.findByText('Imported')).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const projected = projectYDocToDiagram(doc);
    expect(projected.classes.map((cls) => cls.name).sort()).toEqual(['Customer', 'Order']);
    expect(projected.associations).toHaveLength(1);
    expect(projected.associations[0]!.sourceClassId).toBe(customer);
    expect(screen.queryByRole('alert')).toBeNull();
    // The control is usable again after success.
    expect(button.disabled).toBe(false);
  });

  it('re-imports when the same file is picked again (the input is reset after each pick)', async () => {
    const diagramId = uuid();
    const doc = makeDoc(diagramId);
    const first = importReply(diagramId, [classCreate(diagramId, uuid(), 'Customer', 10)]);
    const second = importReply(diagramId, [classCreate(diagramId, uuid(), 'Order', 300)]);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(first))
      .mockResolvedValueOnce(jsonResponse(second));
    vi.stubGlobal('fetch', fetchMock);

    const { container } = renderButton(diagramId, doc);
    const file = makeFile('model.xmi', XMI_TEXT);
    await pickFile(container, file);
    expect(await screen.findByText('Imported')).toBeTruthy();

    await pickFile(container, file);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('Imported')).toBeTruthy();
    expect(projectYDocToDiagram(doc).classes.map((cls) => cls.name).sort()).toEqual(['Customer', 'Order']);
  });
});

describe('ImportXmiButton — re-entry guard', () => {
  it('ignores button clicks while an import is in flight (no double submit)', async () => {
    const diagramId = uuid();
    const doc = makeDoc(diagramId);
    const reply = importReply(diagramId, [classCreate(diagramId, uuid(), 'Customer', 10)]);
    const gate = deferredResponse();
    const fetchMock = vi.fn().mockImplementation(() => gate.promise);
    vi.stubGlobal('fetch', fetchMock);

    const { container } = renderButton(diagramId, doc);
    await pickFile(container, makeFile('model.xmi', XMI_TEXT));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const button = importButton();
    fireEvent.click(button);
    fireEvent.click(button);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The accessible name stays stable through the in-flight phase.
    expect(button.getAttribute('aria-label')).toBe(IMPORT_ARIA);

    await act(async () => {
      gate.resolve(jsonResponse(reply));
    });
    expect(await screen.findByText('Imported')).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('ImportXmiButton — server rejection', () => {
  it('surfaces the server rejection message and leaves the doc untouched', async () => {
    const diagramId = uuid();
    const doc = makeDoc(diagramId);
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ error: 'XMI document is invalid' }, 422));
    vi.stubGlobal('fetch', fetchMock);

    const { container } = renderButton(diagramId, doc);
    await pickFile(container, makeFile('model.xmi', XMI_TEXT));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('XMI document is invalid');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(projectYDocToDiagram(doc).classes).toHaveLength(0);
    // Failed is not busy: the control re-enables for a retry and shows its idle label.
    const button = importButton();
    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe('Import XMI');
  });

  it('surfaces an error when a 200 response omits the batch', async () => {
    const diagramId = uuid();
    const doc = makeDoc(diagramId);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ deltaId: uuid(), summary: {} })));

    const { container } = renderButton(diagramId, doc);
    await pickFile(container, makeFile('model.xmi', XMI_TEXT));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('XMI import response did not include batch');
    expect(projectYDocToDiagram(doc).classes).toHaveLength(0);
  });

  it('muestra un error cuando el archivo XMI no contiene clases en lugar de reportar éxito falso', async () => {
    const diagramId = uuid();
    const doc = makeDoc(diagramId);
    const reply = {
      deltaId: uuid(),
      batch: {
        id: uuid(),
        diagramId,
        kind: 'batch' as const,
        deltas: [],
        timestamp: new Date().toISOString(),
      },
      summary: {
        classes: 0,
        associations: 0,
        generalizations: 0,
        realizations: 0,
        dependencies: 0,
        naryAssociations: 0,
      },
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(reply)));

    const { container } = renderButton(diagramId, doc);
    await pickFile(container, makeFile('empty.xmi', XMI_TEXT));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('No classes found in XMI file');
    expect(projectYDocToDiagram(doc).classes).toHaveLength(0);
    const button = importButton();
    expect(button.textContent).toBe('Import XMI');
  });

  it('applies nothing and explains the rejection when the model rejects one delta of the batch', async () => {
    const diagramId = uuid();
    const doc = makeDoc(diagramId);
    // The second delta links to a class that does not exist — the engine
    // rejects it, and batch semantics must roll the first delta back too.
    const ghost = uuid();
    const reply = importReply(diagramId, [
      classCreate(diagramId, uuid(), 'Customer', 10),
      associationCreate(diagramId, uuid(), ghost, uuid()),
    ]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(reply)));

    const { container } = renderButton(diagramId, doc);
    await pickFile(container, makeFile('model.xmi', XMI_TEXT));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('Imported 0 elements before a delta was rejected (BatchError)');
    const projected = projectYDocToDiagram(doc);
    expect(projected.classes).toHaveLength(0);
    expect(projected.associations).toHaveLength(0);
  });

  it('surfaces an error instead of hanging when the returned batch violates the delta schema', async () => {
    const diagramId = uuid();
    const doc = makeDoc(diagramId);
    // A class delta without classId fails core's schema gate (throws from the
    // parser, not an engine rejection) — the control must still recover.
    const malformed = {
      id: uuid(),
      diagramId,
      timestamp: now(),
      kind: 'class',
      op: 'create',
      name: 'Customer',
      position: { x: 10, y: 40 },
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(importReply(diagramId, [malformed]))));

    const { container } = renderButton(diagramId, doc);
    await pickFile(container, makeFile('model.xmi', XMI_TEXT));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('Imported 0 elements before a delta was rejected (SchemaError)');
    expect(projectYDocToDiagram(doc).classes).toHaveLength(0);
    const button = importButton();
    expect(button.disabled).toBe(false);
  });

  it('desambigua nombres de clases que ya existen en el lienzo para prevenir DuplicateClassError', async () => {
    const diagramId = uuid();
    const doc = makeDoc(diagramId);
    // El lienzo ya posee una clase llamada "Customer"
    applyDeltaToYDoc(doc, classCreate(diagramId, uuid(), 'Customer', 0));
    expect(projectYDocToDiagram(doc).classes).toHaveLength(1);

    // El archivo XMI entrante contiene también una clase llamada "Customer"
    const reply = importReply(diagramId, [classCreate(diagramId, uuid(), 'Customer', 100)]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(reply)));

    const { container } = renderButton(diagramId, doc);
    await pickFile(container, makeFile('model.xmi', XMI_TEXT));

    expect(await screen.findByText('Imported')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();

    const classNames = projectYDocToDiagram(doc).classes.map((c) => c.name);
    expect(classNames).toEqual(expect.arrayContaining(['Customer', 'Customer (2)']));
  });
});

describe('ImportXmiButton — transport failure', () => {
  it('shows a retryable error when the network fails and stays usable for a successful retry', async () => {
    const diagramId = uuid();
    const doc = makeDoc(diagramId);
    const reply = importReply(diagramId, [classCreate(diagramId, uuid(), 'Customer', 10)]);
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('network down'))
      .mockResolvedValueOnce(jsonResponse(reply));
    vi.stubGlobal('fetch', fetchMock);

    const { container } = renderButton(diagramId, doc);
    await pickFile(container, makeFile('model.xmi', XMI_TEXT));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Failed to reach the import service');
    const button = importButton();
    expect(button.disabled).toBe(false);

    // A second pick after the failure succeeds and clears the error.
    await pickFile(container, makeFile('model.xmi', XMI_TEXT));
    expect(await screen.findByText('Imported')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(projectYDocToDiagram(doc).classes.map((cls) => cls.name)).toEqual(['Customer']);
  });
});

describe('ImportXmiButton — local file handling', () => {
  it('sends an empty wrong-extension file to the server gate without touching the doc', async () => {
    const diagramId = uuid();
    const doc = makeDoc(diagramId);
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ error: 'XMI payload is empty' }, 400));
    vi.stubGlobal('fetch', fetchMock);

    const { container } = renderButton(diagramId, doc);
    await pickFile(container, makeFile('notes.txt', ''));

    // The component delegates content validation to the accept attribute
    // (picker hint) plus the server gate: the pick is still sent, verbatim.
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ xmi: '' });
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('XMI payload is empty');
    expect(projectYDocToDiagram(doc).classes).toHaveLength(0);
  });

  it('does nothing when a file is picked before a diagram id exists', async () => {
    const diagramId = uuid();
    const doc = makeDoc(diagramId);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const { container } = renderButton(null, doc);
    await pickFile(container, makeFile('model.xmi', XMI_TEXT));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(importButton().textContent).toBe('Import XMI');
    expect(projectYDocToDiagram(doc).classes).toHaveLength(0);
  });
});
