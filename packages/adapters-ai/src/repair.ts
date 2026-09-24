/**
 * Identificadores y normalización de salidas de modelos AI.
 */

/** Campos UUID que el modelo tiene permitido inventar; los valores malformados se regeneran. */
export const REPAIRABLE_ID_FIELDS = new Set([
  'id',
  'classId',
  'memberId',
  'associationId',
  'generalizationId',
  'realizationId',
  'dependencyId',
  'naryAssociationId',
  'sourceClassId',
  'targetClassId',
  'subClassId',
  'superClassId',
  'clientClassId',
  'supplierInterfaceId',
  'supplierClassId',
  'associationClassId',
  'newAssociationClassId',
]);

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const RFC3339_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Recorre en profundidad una estructura producida por el modelo y regenera IDs/timestamps malformados.
 * Cada ocurrencia de la MISMA cadena de ID inválida se mapea al MISMO UUID generado
 * (memoizado), de modo que los placeholders del modelo como "NEW_CLASS_1" se mantengan
 * coherentes a lo largo de los elementos de un lote.
 */
export function repairModelIdentifiers(value: unknown, memo: Map<string, string> = new Map()): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => repairModelIdentifiers(item, memo));
  }
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (typeof val === 'string' && REPAIRABLE_ID_FIELDS.has(key) && !UUID_RE.test(val)) {
      const existing = memo.get(val);
      out[key] = existing ?? crypto.randomUUID();
      if (existing === undefined) {
        memo.set(val, out[key] as string);
      }
      continue;
    }
    if (typeof val === 'string' && key === 'timestamp' && !RFC3339_RE.test(val)) {
      out[key] = new Date().toISOString();
      continue;
    }
    out[key] = repairModelIdentifiers(val, memo);
  }
  return out;
}
