/**
 * Validación de fotos (PR 16, tarea 16.1) — prevalidación del lado del cliente.
 *
 * photo:R4 — rechazar imágenes inválidas/excesivas LOCALMENTE con CERO llamadas a la API.
 * - La verificación de magic-bytes detecta un PDF renombrado a .png (rechazar).
 * - El límite de tamaño rechaza cargas excesivas antes de cualquier viaje de red.
 * - Formatos soportados: PNG, JPEG, GIF, WebP (formatos ráster según especificación).
 */
import type { BatchDelta } from '@app/core';

/** Tamaño máximo de subida: 10 MB. */
export const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

/** Tipos MIME soportados para importación de fotos. */
export const SUPPORTED_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

/** Firmas de magic-bytes para los formatos de imagen soportados. */
const MAGIC_BYTES: Record<string, number[]> = {
  'image/png': [0x89, 0x50, 0x4e, 0x47], // \x89PNG
  'image/jpeg': [0xff, 0xd8, 0xff], // Marcador SOI de JPEG
  'image/gif': [0x47, 0x49, 0x46, 0x38], // GIF8
  'image/webp': [0x52, 0x49, 0x46, 0x46], // RIFF (contenedor WebP)
};

/** Magic bytes de PDF — utilizados para detectar un PDF renombrado a .png. */
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46]; // %PDF

export type PhotoValidationError =
  | { kind: 'unsupported_format'; message: string }
  | { kind: 'oversized'; message: string }
  | { kind: 'magic_bytes_mismatch'; message: string }
  | { kind: 'empty_file'; message: string };

/**
 * Valida un File antes de subirlo. Retorna null en caso de éxito, o un error
 * estructurado ante un fallo. Todas las comprobaciones ocurren localmente — cero llamadas a la red.
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
 * Valida los magic bytes contra el tipo MIME declarado.
 * Lee los primeros 8 bytes y comprueba:
 * 1. El archivo NO comienza con la firma de PDF (detecta PDFs renombrados).
 * 2. Los bytes coinciden con la firma esperada para el tipo declarado.
 *
 * Este es un SEGUNDO paso después de validatePhotoFile — requiere leer bytes.
 * Retorna null en caso de éxito, o un error estructurado.
 */
export function validatePhotoBytes(
  firstBytes: Uint8Array,
  declaredMimeType: string,
): PhotoValidationError | null {
  if (firstBytes.length === 0) {
    return { kind: 'empty_file', message: 'File is empty' };
  }

  // Comprobar la firma mágica de PDF (detecta PDF renombrado a .png)
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
 * Resultado de una extracción de foto — ya sea un lote válido o una advertencia con
 * cero elementos. Nunca inventa clases (photo:R3).
 */
export type PhotoExtractionResult =
  | { ok: true; batch: BatchDelta; warnings: string[] }
  | { ok: false; warnings: string[] };

/**
 * Procesa una extracción en crudo del adaptador de visión. Si el lote tiene cero
 * elementos, genera una advertencia en lugar de un lote vacío. Nunca inventa
 * clases de relleno (photo:R3).
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
