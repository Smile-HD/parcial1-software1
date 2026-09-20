import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildYDocFromDiagram, projectYDocToDiagram } from '@app/core';

import { ImportPhotoButton } from './ImportPhotoButton';

/**
 * photo:R1–R4 — ImportPhotoButton + PhotoReviewModal behavior contract.
 *
 * The control drives the photo import: pick an image → client-side validate
 * (photo:R4) → POST base64 to create a job → poll GET until completed →
 * render review modal (photo:R2) with per-element drop/name-edit → approve
 * applies the filtered BatchDelta to the Y.Doc → cancel discards.
 *
 * Strict TDD: these tests are written FIRST against imports that do NOT
 * yet exist. The file MUST fail to compile until the production code is
 * implemented.
 *
 * Convention: vi.stubGlobal('fetch', ...) at the fetch boundary (App.test
 * pattern); no snapshots, no implementation details.
 */

// ── Constants ──────────────────────────────────────────────────────────────

const PHOTO_ARIA = 'Import a photo of a class diagram';

const uuid = (): string => crypto.randomUUID();
const now = (): string => new Date().toISOString();

// ── Helpers ────────────────────────────────────────────────────────────────

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function deferredResponse(): { promise: Promise<Response>; resolve: (r: Response) => void } {
  let resolveFn: (r: Response) => void = () => {};
  const promise = new Promise<Response>((resolve) => {
    resolveFn = resolve;
  });
  return { promise, resolve: resolveFn };
}

/** Minimal valid PNG: 8-byte PNG magic + padding (real enough for client validation). */
function makePngBytes(): Uint8Array {
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
}

/** PDF magic bytes — used to fake a renamed PDF. */
function makePdfBytes(): Uint8Array {
  return new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);
}

function makeFile(name: string, bytes: Uint8Array, type: string): File {
  const blob = new Blob([bytes as BlobPart], { type });
  const file = new File([blob], name, { type });
  trackBlobBytes(file, bytes);
  return file;
}

function makeOversizedFile(): File {
  // 11 MB dummy content (exceeds MAX_PHOTO_BYTES = 10 MB)
  const big = new Uint8Array(11 * 1024 * 1024);
  big[0] = 0x89; big[1] = 0x50; big[2] = 0x4e; big[3] = 0x47;
  return new File([big], 'huge.png', { type: 'image/png' });
}

async function pickFile(container: HTMLElement, file: File): Promise<void> {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  expect(input).toBeTruthy();
  await act(async () => {
    fireEvent.change(input, { target: { files: [file] } });
  });
}

// ── Batch fixtures ─────────────────────────────────────────────────────────

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

function batch(diagramId: string, deltas: unknown[]) {
  return {
    id: uuid(),
    diagramId,
    timestamp: now(),
    kind: 'batch' as const,
    deltas,
  };
}

function makeDoc(diagramId: string) {
  return buildYDocFromDiagram({
    id: diagramId,
    name: 'Photo target',
    classes: [],
    associations: [],
    generalizations: [],
    realizations: [],
    dependencies: [],
    naryAssociations: [],
  });
}

function renderButton(
  diagramId: string | null,
  doc: ReturnType<typeof makeDoc>,
  disabled = false,
) {
  return render(<ImportPhotoButton doc={doc} diagramId={diagramId} disabled={disabled} />);
}

function photoButton(): HTMLButtonElement {
  return screen.getByRole<HTMLButtonElement>('button', { name: PHOTO_ARIA });
}

// ── Blob byte-tracking for jsdom arrayBuffer polyfill ─────────────────────
// jsdom's Blob.prototype.arrayBuffer uses FileReader whose onload fires as
// a macrotask that React's act() never flushes.  We store each Blob's raw
// bytes in a WeakMap and override both `slice` and `arrayBuffer` so the
// latter returns Promise.resolve (microtask → flushed by act()).
const blobBytes = new WeakMap<Blob, Uint8Array>();
let origSlice: typeof Blob.prototype.slice;
let origArrayBuffer: typeof Blob.prototype.arrayBuffer;

function trackBlobBytes(blob: Blob, bytes: Uint8Array): void {
  blobBytes.set(blob, bytes);
}

function installBlobPolyfills(): void {
  origSlice = Blob.prototype.slice;
  origArrayBuffer = Blob.prototype.arrayBuffer;

  Blob.prototype.slice = function (
    this: Blob,
    ...args: Parameters<Blob['slice']>
  ): Blob {
    const result = origSlice.apply(this, args);
    const parentData = blobBytes.get(this);
    if (parentData) {
      const rawStart = typeof args[0] === 'number' ? args[0] : 0;
      const rawEnd = typeof args[1] === 'number' ? args[1] : parentData.length;
      const s = rawStart < 0
        ? Math.max(parentData.length + rawStart, 0)
        : Math.min(Math.max(rawStart, 0), parentData.length);
      const e = rawEnd < 0
        ? Math.max(parentData.length + rawEnd, 0)
        : Math.min(Math.max(rawEnd, 0), parentData.length);
      blobBytes.set(result, parentData.slice(s, e));
    }
    return result;
  };

  Blob.prototype.arrayBuffer = function (this: Blob): Promise<ArrayBuffer> {
    const data = blobBytes.get(this);
    if (data) {
      return Promise.resolve(
        data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer,
      );
    }
    // Fallback for untracked blobs (shouldn't happen in these tests)
    return origArrayBuffer.call(this);
  };
}

function restoreBlobPolyfills(): void {
  Blob.prototype.slice = origSlice;
  Blob.prototype.arrayBuffer = origArrayBuffer;
}

// ── Lifecycle ──────────────────────────────────────────────────────────────

beforeEach(() => {
  installBlobPolyfills();
});

afterEach(() => {
  restoreBlobPolyfills();
  vi.unstubAllGlobals();
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe('ImportPhotoButton — rendering', () => {
  it('renders the import button with a stable accessible name', () => {
    renderButton(uuid(), makeDoc(uuid()));
    const button = photoButton();
    expect(button.textContent).toBe('Import Photo');
  });

  it('restricts the file picker to image types only', () => {
    const { container } = renderButton(uuid(), makeDoc(uuid()));
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input).toBeTruthy();
    expect(input.accept).toMatch(/image\//);
  });

  it('is disabled while no diagram id is available or the editor is not ready', () => {
    const doc = makeDoc(uuid());
    const withoutId = renderButton(null, doc);
    expect(photoButton().disabled).toBe(true);
    withoutId.unmount();

    renderButton(uuid(), makeDoc(uuid()), true);
    expect(photoButton().disabled).toBe(true);
  });
});

describe('ImportPhotoButton — local validation (photo:R4)', () => {
  it('rejects a PDF renamed to .png with a visible error and ZERO fetch calls', async () => {
    const diagramId = uuid();
    const doc = makeDoc(diagramId);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const { container } = renderButton(diagramId, doc);
    await pickFile(container, makeFile('fake.png', makePdfBytes(), 'image/png'));

    expect(fetchMock).not.toHaveBeenCalled();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/pdf/i);
    expect(projectYDocToDiagram(doc).classes).toHaveLength(0);
  });

  it('rejects an oversized file with a visible error and ZERO fetch calls', async () => {
    const diagramId = uuid();
    const doc = makeDoc(diagramId);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const { container } = renderButton(diagramId, doc);
    await pickFile(container, makeOversizedFile());

    expect(fetchMock).not.toHaveBeenCalled();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/too large|MB/i);
    expect(projectYDocToDiagram(doc).classes).toHaveLength(0);
  });
});

describe('ImportPhotoButton — happy path (upload + poll + review + approve)', () => {
  it('POSTs base64 once, polls until completed, and shows the review modal', async () => {
    const diagramId = uuid();
    const doc = makeDoc(diagramId);
    const classId = uuid();
    const batchDelta = batch(diagramId, [
      classCreate(diagramId, classId, 'Customer', 10),
    ]);
    const jobId = uuid();

    const postGate = deferredResponse();
    const pollGate = deferredResponse();
    const fetchMock = vi.fn()
      // POST /diagrams/:id/photo → 202 { jobId }
      .mockImplementationOnce(() => postGate.promise)
      // GET /diagrams/:id/photo/:jobId → polling
      .mockImplementationOnce(() => pollGate.promise);
    vi.stubGlobal('fetch', fetchMock);

    const { container } = renderButton(diagramId, doc);
    await pickFile(container, makeFile('diagram.png', makePngBytes(), 'image/png'));

    // In-flight: button disabled, shows uploading label.
    expect(photoButton().disabled).toBe(true);
    expect(photoButton().textContent).toBe('Uploading…');

    // POST resolved with 202 + jobId
    await act(async () => {
      postGate.resolve(jsonResponse({ jobId }, 202));
    });

    // Now polling — button shows extracting label.
    expect(photoButton().textContent).toBe('Extracting…');

    // Poll resolved with succeeded + batch
    await act(async () => {
      pollGate.resolve(jsonResponse({
        id: jobId,
        status: 'succeeded',
        batch: batchDelta,
        warnings: [],
      }));
    });

    // Review modal should appear
    const modal = await screen.findByRole('dialog', { name: /photo review/i });
    expect(modal).toBeTruthy();
    expect(screen.getByText('Customer')).toBeTruthy();

    // Exactly 2 fetch calls: POST + one poll
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('handles large photo files (>100KB) without call stack size exceeded error', async () => {
    const diagramId = uuid();
    const doc = makeDoc(diagramId);
    const jobId = uuid();
    const batchDelta = batch(diagramId, [
      classCreate(diagramId, uuid(), 'LargeDiagram', 10),
    ]);

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ jobId }, 202))
      .mockResolvedValueOnce(jsonResponse({ id: jobId, status: 'succeeded', batch: batchDelta }));
    vi.stubGlobal('fetch', fetchMock);

    // 150 KB valid PNG bytes (exceeds V8 65536 stack argument limit if spread)
    const largePng = new Uint8Array(150_000);
    largePng[0] = 0x89; largePng[1] = 0x50; largePng[2] = 0x4e; largePng[3] = 0x47;
    largePng[4] = 0x0d; largePng[5] = 0x0a; largePng[6] = 0x1a; largePng[7] = 0x0a;

    const { container } = renderButton(diagramId, doc);
    await pickFile(container, makeFile('large.png', largePng, 'image/png'));

    const modal = await screen.findByRole('dialog', { name: /photo review/i });
    expect(modal).toBeTruthy();
    expect(screen.getByText('LargeDiagram')).toBeTruthy();
  });

  it('polls multiple times before receiving the completed result', async () => {
    vi.useFakeTimers();
    const diagramId = uuid();
    const doc = makeDoc(diagramId);
    const classId = uuid();
    const batchDelta = batch(diagramId, [
      classCreate(diagramId, classId, 'Product', 10),
    ]);
    const jobId = uuid();

    const postGate = deferredResponse();
    const poll1 = deferredResponse();
    const poll2 = deferredResponse();
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => postGate.promise)
      .mockImplementationOnce(() => poll1.promise)
      .mockImplementationOnce(() => poll2.promise);
    vi.stubGlobal('fetch', fetchMock);

    const { container } = renderButton(diagramId, doc);
    await pickFile(container, makeFile('diagram.png', makePngBytes(), 'image/png'));

    await act(async () => {
      postGate.resolve(jsonResponse({ jobId }, 202));
    });

    // First poll: still running
    await act(async () => {
      poll1.resolve(jsonResponse({ id: jobId, status: 'running' }));
    });

    // Advance past POLL_INTERVAL_MS so the component schedules its next tick
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });

    // Second poll: succeeded
    await act(async () => {
      poll2.resolve(jsonResponse({
        id: jobId,
        status: 'succeeded',
        batch: batchDelta,
        warnings: [],
      }));
    });

    vi.useRealTimers();

    await screen.findByRole('dialog', { name: /photo review/i });
    expect(screen.getByText('Product')).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(3); // POST + 2 polls
  });
});

describe('ImportPhotoButton — review modal interaction (photo:R2)', () => {
  it('drop one element + approve → the dropped class is NOT in the Y.Doc', async () => {
    const diagramId = uuid();
    const doc = makeDoc(diagramId);
    const classA = uuid();
    const classB = uuid();
    const batchDelta = batch(diagramId, [
      classCreate(diagramId, classA, 'Customer', 10),
      classCreate(diagramId, classB, 'Order', 300),
    ]);
    const jobId = uuid();

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ jobId }, 202))
      .mockResolvedValueOnce(jsonResponse({
        id: jobId,
        status: 'succeeded',
        batch: batchDelta,
        warnings: [],
      }));
    vi.stubGlobal('fetch', fetchMock);

    const { container } = renderButton(diagramId, doc);
    await pickFile(container, makeFile('diagram.png', makePngBytes(), 'image/png'));

    await waitFor(() => expect(screen.queryByRole('dialog', { name: /photo review/i })).toBeTruthy());

    // Drop the "Order" class
    const dropButtons = screen.getAllByRole('button', { name: /drop/i });
    expect(dropButtons.length).toBe(2);
    await act(async () => {
      fireEvent.click(dropButtons[1]!); // drop "Order"
    });

    // "Order" should no longer be visible in the review
    expect(screen.queryByText('Order')).toBeNull();
    expect(screen.getByText('Customer')).toBeTruthy();

    // Approve the remaining batch
    const approveBtn = screen.getByRole('button', { name: /approve/i });
    await act(async () => {
      fireEvent.click(approveBtn);
    });

    // Y.Doc should have Customer but NOT Order
    const projected = projectYDocToDiagram(doc);
    expect(projected.classes.map((c) => c.name).sort()).toEqual(['Customer']);
  });

  it('drop a class prunes its members and associations in cascade without error', async () => {
    const diagramId = uuid();
    const doc = makeDoc(diagramId);
    const classA = uuid();
    const classB = uuid();
    const batchDelta = batch(diagramId, [
      classCreate(diagramId, classA, 'Customer', 10),
      classCreate(diagramId, classB, 'Order', 300),
      {
        id: uuid(),
        diagramId,
        timestamp: now(),
        kind: 'member' as const,
        op: 'addAttribute' as const,
        classId: classB,
        memberId: uuid(),
        name: 'total',
        type: 'Double',
      },
      {
        id: uuid(),
        diagramId,
        timestamp: now(),
        kind: 'association' as const,
        op: 'create' as const,
        associationId: uuid(),
        sourceClassId: classA,
        targetClassId: classB,
        directed: true,
      },
    ]);
    const jobId = uuid();

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ jobId }, 202))
      .mockResolvedValueOnce(jsonResponse({
        id: jobId,
        status: 'succeeded',
        batch: batchDelta,
        warnings: [],
      }));
    vi.stubGlobal('fetch', fetchMock);

    const { container } = renderButton(diagramId, doc);
    await pickFile(container, makeFile('diagram.png', makePngBytes(), 'image/png'));

    await waitFor(() => expect(screen.queryByRole('dialog', { name: /photo review/i })).toBeTruthy());

    // Drop classB ("Order")
    const dropButtons = screen.getAllByRole('button', { name: /drop/i });
    await act(async () => {
      fireEvent.click(dropButtons[1]!);
    });

    // Approve the remaining batch
    const approveBtn = screen.getByRole('button', { name: /approve/i });
    await act(async () => {
      fireEvent.click(approveBtn);
    });

    // No error alert should be shown
    expect(screen.queryByRole('alert')).toBeNull();

    // Customer is saved, Order is dropped, and no orphan associations exist
    const projected = projectYDocToDiagram(doc);
    expect(projected.classes.map((c) => c.name)).toEqual(['Customer']);
    expect(projected.associations).toHaveLength(0);
  });

  it('cancel → Y.Doc state vector unchanged, no modal', async () => {
    const diagramId = uuid();
    const doc = makeDoc(diagramId);
    const classId = uuid();
    const batchDelta = batch(diagramId, [
      classCreate(diagramId, classId, 'Customer', 10),
    ]);
    const jobId = uuid();

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ jobId }, 202))
      .mockResolvedValueOnce(jsonResponse({
        id: jobId,
        status: 'succeeded',
        batch: batchDelta,
        warnings: [],
      }));
    vi.stubGlobal('fetch', fetchMock);

    const { container } = renderButton(diagramId, doc);
    await pickFile(container, makeFile('diagram.png', makePngBytes(), 'image/png'));

    await waitFor(() => expect(screen.queryByRole('dialog', { name: /photo review/i })).toBeTruthy());

    // Capture Y.Doc projected state BEFORE cancel
    const stateBefore = projectYDocToDiagram(doc);

    // Cancel
    const cancelBtn = screen.getByRole('button', { name: /cancel/i });
    await act(async () => {
      fireEvent.click(cancelBtn);
    });

    // Modal gone, doc unchanged
    expect(screen.queryByRole('dialog', { name: /photo review/i })).toBeNull();
    expect(projectYDocToDiagram(doc).classes).toHaveLength(0);
    // Projected state should be identical (no mutation)
    expect(projectYDocToDiagram(doc)).toEqual(stateBefore);
  });

  it('edit a class name in the review modal before approving', async () => {
    const diagramId = uuid();
    const doc = makeDoc(diagramId);
    const classId = uuid();
    const batchDelta = batch(diagramId, [
      classCreate(diagramId, classId, 'Custmer', 10), // typo
    ]);
    const jobId = uuid();

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ jobId }, 202))
      .mockResolvedValueOnce(jsonResponse({
        id: jobId,
        status: 'succeeded',
        batch: batchDelta,
        warnings: [],
      }));
    vi.stubGlobal('fetch', fetchMock);

    const { container } = renderButton(diagramId, doc);
    await pickFile(container, makeFile('diagram.png', makePngBytes(), 'image/png'));

    await waitFor(() => expect(screen.queryByRole('dialog', { name: /photo review/i })).toBeTruthy());

    // Fix the typo
    const nameInput = screen.getByDisplayValue('Custmer') as HTMLInputElement;
    await act(async () => {
      fireEvent.change(nameInput, { target: { value: 'Customer' } });
    });

    // Approve
    const approveBtn = screen.getByRole('button', { name: /approve/i });
    await act(async () => {
      fireEvent.click(approveBtn);
    });

    const projected = projectYDocToDiagram(doc);
    expect(projected.classes[0]!.name).toBe('Customer');
  });
});

describe('ImportPhotoButton — zero-element extraction (photo:R3)', () => {
  it('shows an explicit warning, no fabricated elements, approve disabled', async () => {
    const diagramId = uuid();
    const doc = makeDoc(diagramId);
    const batchDelta = batch(diagramId, []); // zero elements
    const jobId = uuid();

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ jobId }, 202))
      .mockResolvedValueOnce(jsonResponse({
        id: jobId,
        status: 'succeeded',
        batch: batchDelta,
        warnings: ['No classes could be extracted from the image.'],
      }));
    vi.stubGlobal('fetch', fetchMock);

    const { container } = renderButton(diagramId, doc);
    await pickFile(container, makeFile('diagram.png', makePngBytes(), 'image/png'));

    await waitFor(() => expect(screen.queryByRole('dialog', { name: /photo review/i })).toBeTruthy());

    // Warning shown
    expect(screen.getByRole('alert').textContent).toContain('No classes');

    // No fabricated elements — list must be empty (photo:R3)
    expect(screen.queryAllByRole('listitem')).toHaveLength(0);

    // Approve button must be disabled
    const approveBtn = screen.getByRole('button', { name: /approve/i });
    expect((approveBtn as HTMLButtonElement).disabled).toBe(true);

    // Doc untouched
    expect(projectYDocToDiagram(doc).classes).toHaveLength(0);
  });
});

describe('ImportPhotoButton — server job error', () => {
  it('surfaces the error and applies nothing', async () => {
    const diagramId = uuid();
    const doc = makeDoc(diagramId);
    const jobId = uuid();

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ jobId }, 202))
      .mockResolvedValueOnce(jsonResponse({
        id: jobId,
        status: 'failed',
        error: 'Vision model unavailable',
      }));
    vi.stubGlobal('fetch', fetchMock);

    const { container } = renderButton(diagramId, doc);
    await pickFile(container, makeFile('diagram.png', makePngBytes(), 'image/png'));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Vision model unavailable');
    expect(projectYDocToDiagram(doc).classes).toHaveLength(0);
    // Button re-enabled for retry
    expect(photoButton().disabled).toBe(false);
  });

  it('surfaces a POST error and applies nothing', async () => {
    const diagramId = uuid();
    const doc = makeDoc(diagramId);

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ error: 'Photo import already in progress' }, 409));
    vi.stubGlobal('fetch', fetchMock);

    const { container } = renderButton(diagramId, doc);
    await pickFile(container, makeFile('diagram.png', makePngBytes(), 'image/png'));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Photo import already in progress');
    expect(projectYDocToDiagram(doc).classes).toHaveLength(0);
    expect(photoButton().disabled).toBe(false);
  });
});

describe('ImportPhotoButton — no file picked before diagram id exists', () => {
  it('does nothing when a file is picked before a diagram id exists', async () => {
    const diagramId = uuid();
    const doc = makeDoc(diagramId);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const { container } = renderButton(null, doc);
    await pickFile(container, makeFile('diagram.png', makePngBytes(), 'image/png'));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(photoButton().textContent).toBe('Import Photo');
  });
});
