import { describe, expect, it, vi, beforeEach } from 'vitest';
import { buildYDocFromDiagram, projectYDocToDiagram, type Diagram } from '@app/core';
import * as Y from 'yjs';

import {
  buildExportFilename,
  computeDynamicDiagramBounds,
  computeExportBounds,
  exportDiagramImage,
  sanitizeFilenameSegment,
} from './imageExport';

// Mock html-to-image — jsdom does not implement getComputedStyle which
// html-to-image needs. The mock returns a known data URL so we can verify
// the calling contract (args passed, format handling, empty-canvas guard).
vi.mock('html-to-image', () => ({
  toPng: vi.fn().mockResolvedValue('data:image/png;base64,FAKEPNG'),
  toJpeg: vi.fn().mockResolvedValue('data:image/jpeg;base64,FAKEJPEG'),
}));

import { toPng, toJpeg } from 'html-to-image';

function uuid(): string {
  return crypto.randomUUID();
}

function makeDiagram(overrides?: Partial<Diagram>): Diagram {
  const id1 = uuid();
  const id2 = uuid();
  return {
    id: uuid(),
    name: 'TestDiagram',
    classes: [
      {
        id: id1,
        name: 'Customer',
        position: { x: 0, y: 0 },
        attributes: [{ id: uuid(), name: 'name', type: 'string', visibility: '+', isStatic: false, isDerived: false }],
        methods: [],
        kind: 'class',
        isAbstract: false,
      },
      {
        id: id2,
        name: 'Order',
        position: { x: 300, y: 200 },
        attributes: [],
        methods: [],
        kind: 'class',
        isAbstract: false,
      },
    ],
    associations: [],
    generalizations: [],
    realizations: [],
    dependencies: [],
    naryAssociations: [],
    ...overrides,
  };
}

function makeEmptyDiagram(): Diagram {
  return {
    id: uuid(),
    name: 'Empty',
    classes: [],
    associations: [],
    generalizations: [],
    realizations: [],
    dependencies: [],
    naryAssociations: [],
  };
}

describe('sanitizeFilenameSegment', () => {
  it('replaces special chars with underscore', () => {
    expect(sanitizeFilenameSegment('My Diagram!')).toBe('My_Diagram_');
  });

  it('preserves alphanumeric, hyphens, underscores', () => {
    expect(sanitizeFilenameSegment('abc-123_def')).toBe('abc-123_def');
  });
});

describe('buildExportFilename', () => {
  it('builds "{name}_{id}.png" for PNG', () => {
    const name = buildExportFilename('Shop', 'abc-123', 'png');
    expect(name).toBe('Shop_abc-123.png');
  });

  it('builds "{name}_{id}.jpg" for JPEG', () => {
    const name = buildExportFilename('Shop', 'abc-123', 'jpeg');
    expect(name).toBe('Shop_abc-123.jpg');
  });
});

describe('computeExportBounds', () => {
  it('returns null for empty array', () => {
    expect(computeExportBounds([])).toBeNull();
  });

  it('returns fit-to-content bounds from positions', () => {
    const bounds = computeExportBounds([
      { x: 0, y: 0 },
      { x: 300, y: 200 },
    ]);
    expect(bounds).toEqual({ x: 0, y: 0, width: 300, height: 200 });
  });

  it('handles negative coordinates', () => {
    const bounds = computeExportBounds([
      { x: -100, y: -50 },
      { x: 200, y: 150 },
    ]);
    expect(bounds).toEqual({ x: -100, y: -50, width: 300, height: 200 });
  });
});

describe('computeDynamicDiagramBounds', () => {
  it('returns null for empty classes array', () => {
    expect(computeDynamicDiagramBounds([])).toBeNull();
  });

  it('calculates bounding box with padding and default node size', () => {
    const classes = [
      { id: 'c1', position: { x: 100, y: 100 } },
      { id: 'c2', position: { x: 400, y: 300 } },
    ];
    // Default node size is 220x140, padding is 40
    // minX = 100, minY = 100
    // maxX = 400 + 220 = 620, maxY = 300 + 140 = 440
    // left = 100 - 40 = 60
    // top = 100 - 40 = 60
    // width = 620 - 100 + 80 = 600
    // height = 440 - 100 + 80 = 420
    const bounds = computeDynamicDiagramBounds(classes, null, 40);
    expect(bounds).toEqual({
      x: 60,
      y: 60,
      width: 600,
      height: 420,
    });
  });

  it('enforces minimum width and height for small or single elements', () => {
    const classes = [{ id: 'c1', position: { x: 0, y: 0 } }];
    const bounds = computeDynamicDiagramBounds(classes, null, 10);
    expect(bounds?.width).toBeGreaterThanOrEqual(200);
    expect(bounds?.height).toBeGreaterThanOrEqual(150);
  });
});

describe('exportDiagramImage', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchSpy);
    vi.mocked(toPng).mockClear();
    vi.mocked(toJpeg).mockClear();
  });

  it('does NOT call fetch (image-export:R4)', async () => {
    const diagram = makeDiagram();
    const doc = buildYDocFromDiagram(diagram);
    const viewport = document.createElement('div');

    await exportDiagramImage(doc, viewport, 'png');

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does NOT emit any deltas — Y.Doc state vector unchanged (image-export:R3)', async () => {
    const diagram = makeDiagram();
    const doc = buildYDocFromDiagram(diagram);
    const stateVectorBefore = Y.encodeStateVector(doc);

    const viewport = document.createElement('div');
    await exportDiagramImage(doc, viewport, 'png');

    const stateVectorAfter = Y.encodeStateVector(doc);
    expect(Buffer.from(stateVectorAfter)).toEqual(Buffer.from(stateVectorBefore));
  });

  it('produces a filename from diagram name + sanitized id (image-export:R1)', async () => {
    const diagram = makeDiagram({ name: 'My Diagram!' });
    const doc = buildYDocFromDiagram(diagram);
    const viewport = document.createElement('div');

    const result = await exportDiagramImage(doc, viewport, 'png');

    // image-export:R1 — filename is derived from the diagram name (sanitized:
    // 'My Diagram!' -> 'My_Diagram_') + the diagram id.
    const projected = projectYDocToDiagram(doc);
    expect(result.filename).toBe(
      `${sanitizeFilenameSegment('My Diagram!')}_${sanitizeFilenameSegment(projected.id)}.png`,
    );
  });

  it('uses .jpg extension for JPEG format', async () => {
    const diagram = makeDiagram();
    const doc = buildYDocFromDiagram(diagram);
    const viewport = document.createElement('div');

    const result = await exportDiagramImage(doc, viewport, 'jpeg');

    expect(result.filename).toMatch(/\.jpg$/);
  });

  it('calls toPng with pixelRatio 2 (image-export:R2)', async () => {
    const diagram = makeDiagram();
    const doc = buildYDocFromDiagram(diagram);
    const viewport = document.createElement('div');

    await exportDiagramImage(doc, viewport, 'png');

    expect(toPng).toHaveBeenCalledWith(
      viewport,
      expect.objectContaining({ backgroundColor: undefined, pixelRatio: 2 }),
    );
  });

  it('calls toJpeg with white background and pixelRatio 2 (image-export:R2)', async () => {
    const diagram = makeDiagram();
    const doc = buildYDocFromDiagram(diagram);
    const viewport = document.createElement('div');

    await exportDiagramImage(doc, viewport, 'jpeg');

    expect(toJpeg).toHaveBeenCalledWith(
      viewport,
      expect.objectContaining({ backgroundColor: '#ffffff', pixelRatio: 2 }),
    );
  });

  it('returns dataUrl from toPng on success', async () => {
    const diagram = makeDiagram();
    const doc = buildYDocFromDiagram(diagram);
    const viewport = document.createElement('div');

    const result = await exportDiagramImage(doc, viewport, 'png');

    expect(result.dataUrl).toBe('data:image/png;base64,FAKEPNG');
    expect(result.warning).toBeNull();
  });

  it('returns empty-canvas warning and no dataUrl for empty diagram (image-export:R5)', async () => {
    const diagram = makeEmptyDiagram();
    const doc = buildYDocFromDiagram(diagram);
    const viewport = document.createElement('div');

    const result = await exportDiagramImage(doc, viewport, 'png');

    expect(result.warning).toBe('No diagram content to export');
    expect(result.dataUrl).toBeNull();
    expect(toPng).not.toHaveBeenCalled();
  });
});
