/**
 * Photo validation (PR 16, task 16.1) — client-side pre-validation.
 *
 * photo:R4 — reject invalid/oversized images LOCALLY with ZERO API calls.
 * - Magic-bytes check catches a PDF renamed to .png (reject).
 * - Size cap rejects oversized uploads before any network round-trip.
 * - Supported formats: PNG, JPEG, GIF, WebP (raster formats per spec).
 */
import type { BatchDelta } from '@app/core';

/** Maximum upload size: 10 MB. */
export const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

/** Supported MIME types for photo import. */
export const SUPPORTED_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

/** Magic-byte signatures for supported image formats. */
const MAGIC_BYTES: Record<string, number[]> = {
  'image/png': [0x89, 0x50, 0x4e, 0x47], // \x89PNG
  'image/jpeg': [0xff, 0xd8, 0xff], // JPEG SOI marker
  'image/gif': [0x47, 0x49, 0x46, 0x38], // GIF8
  'image/webp': [0x52, 0x49, 0x46, 0x46], // RIFF (WebP container)
};

/** PDF magic bytes — used to detect a PDF renamed to .png. */
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46]; // %PDF

export type PhotoValidationError =
  | { kind: 'unsupported_format'; message: string }
  | { kind: 'oversized'; message: string }
  | { kind: 'magic_bytes_mismatch'; message: string }
  | { kind: 'empty_file'; message: string };

/**
 * Validate a File before upload. Returns null on success, or a structured
 * error on failure. All checks happen locally — zero network calls.
 */
export function validatePhotoFile(file: File): PhotoValidationError | null {
  if (file.size === 0) {
    return { kind: 'empty_file', message: 'File is empty' };
  }

  if (file.size > MAX_PHOTO_BYTES) {
    return {
      kind: 'oversized',
      message: `File too large: ${(file.size / (1024 * 1024)).toFixed(1)} MB (max ${MAX_PHOTO_BYTES / (1024 * 1024)} MB)`,
    };
  }

  if (!SUPPORTED_MIME_TYPES.has(file.type)) {
    return {
      kind: 'unsupported_format',
      message: `Unsupported format: ${file.type || 'unknown'}. Supported: PNG, JPEG, GIF, WebP`,
    };
  }

  return null;
}

/**
 * Validate magic bytes against the declared MIME type.
 * Reads the first 8 bytes and checks:
 * 1. The file does NOT start with PDF magic (catches renamed PDFs).
 * 2. The bytes match the expected signature for the declared type.
 *
 * This is a SECOND pass after validatePhotoFile — it requires reading bytes.
 * Returns null on success, or a structured error.
 */
export function validatePhotoBytes(
  firstBytes: Uint8Array,
  declaredMimeType: string,
): PhotoValidationError | null {
  if (firstBytes.length === 0) {
    return { kind: 'empty_file', message: 'File is empty' };
  }

  // Check for PDF magic (catches PDF renamed to .png)
  if (matchesMagic(firstBytes, PDF_MAGIC)) {
    return {
      kind: 'magic_bytes_mismatch',
      message: 'File appears to be a PDF, not an image. Supported formats: PNG, JPEG, GIF, WebP',
    };
  }

  const expected = MAGIC_BYTES[declaredMimeType];
  if (expected && !matchesMagic(firstBytes, expected)) {
    return {
      kind: 'magic_bytes_mismatch',
      message: `File content does not match declared type (${declaredMimeType}). Upload a valid image file.`,
    };
  }

  return null;
}

function matchesMagic(bytes: Uint8Array, magic: number[]): boolean {
  if (bytes.length < magic.length) return false;
  for (let i = 0; i < magic.length; i++) {
    if (bytes[i] !== magic[i]) return false;
  }
  return true;
}

/**
 * Result of a photo extraction — either a valid batch or a warning with
 * zero elements. Never fabricates classes (photo:R3).
 */
export type PhotoExtractionResult =
  | { ok: true; batch: BatchDelta; warnings: string[] }
  | { ok: false; warnings: string[] };

/**
 * Process a raw extraction from the vision adapter. If the batch has zero
 * elements, produce a warning instead of an empty batch. Never fabricates
 * placeholder classes (photo:R3).
 */
export function processExtraction(raw: BatchDelta): PhotoExtractionResult {
  const warnings: string[] = [];
  const elementCount = raw.deltas.filter(
    (d) => d.kind === 'class' && d.op === 'create',
  ).length;

  if (elementCount === 0) {
    warnings.push('No classes could be extracted from the image. The photo may be blurry, poorly lit, or contain no recognizable class diagram.');
  }

  return { ok: true, batch: raw, warnings };
}
