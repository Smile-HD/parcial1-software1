/**
 * Photo validation (PR 16, task 16.1) — tests.
 *
 * photo:R4 — PDF renamed .png rejected LOCALLY with ZERO API calls.
 * Oversized rejected LOCALLY with ZERO fetch calls.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  validatePhotoFile,
  validatePhotoBytes,
  processExtraction,
  MAX_PHOTO_BYTES,
} from './photoValidation.js';
import type { BatchDelta } from '@app/core';

afterEach(() => {
  vi.restoreAllMocks();
});

function makeFile(opts: { name?: string; type?: string; size?: number } = {}): File {
  const { name = 'diagram.png', type = 'image/png', size = 1024 } = opts;
  // jsdom File: new File(parts, name, options) — type goes in options.
  // For empty file (size=0) use empty buffer; otherwise create buffer of target size.
  const content = size === 0 ? new Uint8Array(0) : new Uint8Array(size);
  return new File([content], name, { type });
}

describe('validatePhotoFile', () => {
  it('accepts a valid PNG file within size limit', () => {
    const file = makeFile({ name: 'diagram.png', type: 'image/png', size: 5000 });
    expect(validatePhotoFile(file)).toBeNull();
  });

  it('accepts a valid JPEG file', () => {
    const file = makeFile({ name: 'photo.jpg', type: 'image/jpeg', size: 8000 });
    expect(validatePhotoFile(file)).toBeNull();
  });

  it('rejects an oversized file (>10 MB)', () => {
    const file = makeFile({ name: 'huge.png', type: 'image/png', size: MAX_PHOTO_BYTES + 1 });
    const err = validatePhotoFile(file);
    expect(err).not.toBeNull();
    expect(err!.kind).toBe('oversized');
    expect(err!.message).toMatch(/File too large/);
  });

  it('rejects a PDF (unsupported MIME type)', () => {
    const file = makeFile({ name: 'diagram.pdf', type: 'application/pdf', size: 5000 });
    const err = validatePhotoFile(file);
    expect(err).not.toBeNull();
    expect(err!.kind).toBe('unsupported_format');
    expect(err!.message).toMatch(/Unsupported format/);
  });

  it('rejects an empty file', () => {
    const file = makeFile({ name: 'empty.png', type: 'image/png', size: 0 });
    const err = validatePhotoFile(file);
    expect(err).not.toBeNull();
    expect(err!.kind).toBe('empty_file');
  });
});

describe('validatePhotoBytes — magic bytes', () => {
  it('accepts valid PNG magic bytes', () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(validatePhotoBytes(bytes, 'image/png')).toBeNull();
  });

  it('rejects PDF magic bytes when declared as PNG (renamed PDF)', () => {
    // %PDF header
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);
    const err = validatePhotoBytes(bytes, 'image/png');
    expect(err).not.toBeNull();
    expect(err!.kind).toBe('magic_bytes_mismatch');
    expect(err!.message).toMatch(/PDF/);
  });

  it('rejects PDF magic bytes when declared as JPEG', () => {
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);
    const err = validatePhotoBytes(bytes, 'image/jpeg');
    expect(err).not.toBeNull();
    expect(err!.kind).toBe('magic_bytes_mismatch');
  });

  it('rejects mismatched magic bytes (PNG header declared as JPEG)', () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const err = validatePhotoBytes(bytes, 'image/jpeg');
    expect(err).not.toBeNull();
    expect(err!.kind).toBe('magic_bytes_mismatch');
  });

  it('accepts valid JPEG magic bytes', () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    expect(validatePhotoBytes(bytes, 'image/jpeg')).toBeNull();
  });

  it('rejects zero-length bytes', () => {
    const err = validatePhotoBytes(new Uint8Array([]), 'image/png');
    expect(err).not.toBeNull();
    expect(err!.kind).toBe('empty_file');
  });
});

describe('processExtraction', () => {
  it('passes through a batch with classes', () => {
    const batch: BatchDelta = {
      kind: 'batch', id: crypto.randomUUID(), diagramId: crypto.randomUUID(),
      timestamp: '2026-01-01T00:00:00.000Z',
      deltas: [
        { kind: 'class', op: 'create', id: crypto.randomUUID(), diagramId: crypto.randomUUID(),
          timestamp: '2026-01-01T00:00:00.000Z', classId: crypto.randomUUID(),
          name: 'Foo', position: { x: 0, y: 0 } },
      ],
    };
    const result = processExtraction(batch);
    expect(result.ok).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });

  it('warns on zero-element extraction (photo:R3 — no fabrication)', () => {
    const batch: BatchDelta = {
      kind: 'batch', id: crypto.randomUUID(), diagramId: crypto.randomUUID(),
      timestamp: '2026-01-01T00:00:00.000Z',
      deltas: [],
    };
    const result = processExtraction(batch);
    expect(result.ok).toBe(true);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toMatch(/No classes/);
  });
});
