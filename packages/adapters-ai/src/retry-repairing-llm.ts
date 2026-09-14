/**
 * RetryRepairingLlmPort (interpreter-llm-resilience, R1).
 *
 * Un decorador ligero sobre cualquier LlmPort que añade un bucle acotado de reintento+reparación
 * ante fallos del esquema Zod de deltas. El bucle es TANTO visible para el usuario (obtiene
 * una negativa con resumen en lugar de un 422) como operacional (al puerto interno se le da un
 * prompt de reparación conciso para que un modelo inestable pueda autocorregirse sin requerir
 * un viaje de ida y vuelta completo del usuario).
 *
 * Decisiones de diseño (ver design.md):
 *  D1 — decorador sobre LlmPort (separación de responsabilidades).
 *  D2 — reintento solo ante fallo de Zod; los errores de transporte se propagan sin cambios.
 *  D3 — payload de reparación = salida sin procesar del modelo + resumen compacto de incidencias Zod.
 *  D4 — `OPENAI_LLM_MAX_ATTEMPTS`, por defecto 2, acotado a [1, 3].
 *  D5 — las pruebas controlan un LlmPort simulado; FakeLlm nunca se envuelve.
 */
import { DeltaSchema, type Diagram, type LlmPort, type LlmResult } from '@app/core';

export interface RetryRepairingLlmOptions {
  /** Total inclusivo de intentos. Acotado a [1, 3]. Por defecto 2. */
  maxAttempts: number;
  /** Caracteres máximos del resumen Zod incluidos en el prompt de reparación. Por defecto 500. */
  maxDigestChars: number;
  /** Caracteres máximos de la salida sin procesar del modelo repetida en el prompt de reparación. Por defecto 4000. */
  maxRawOutputChars: number;
}

const DEFAULTS: Required<RetryRepairingLlmOptions> = {
  maxAttempts: 2,
  maxDigestChars: 500,
  maxRawOutputChars: 4000,
};

/** Acota un conteo de intentos a la banda [1, 3]. Exportado para pruebas. */
export function clampMaxAttempts(value: number): number {
  if (!Number.isFinite(value)) return 1;
  const asInt = Math.floor(value);
  if (asInt < 1) return 1;
  if (asInt > 3) return 3;
  return asInt;
}

/**
 * Trunca `s` a un máximo de `max` caracteres, adjuntando un marcador para que los
 * invocadores sepan que el valor fue recortado. Exportado para pruebas.
 */
export function truncate(s: string, max: number, marker = ' [truncated]'): string {
  if (max <= 0) return '';
  if (s.length <= max) return s;
  if (max <= marker.length) return marker.slice(0, max);
  return s.slice(0, max - marker.length) + marker;
}

/**
 * Construye un resumen compacto de incidencias Zod adecuado para un prompt de reparación.
 * Cada incidencia se muestra como `/ruta: mensaje` en su propia línea. El resumen
 * completo se trunca luego a `maxDigestChars`.
 */
export function buildZodDigest(
  error: { issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }> },
  maxDigestChars: number,
): string {
  if (error.issues.length === 0) return 'unknown schema mismatch';
  const lines = error.issues.map((issue) => {
    const path = issue.path.length === 0 ? '/' : '/' + issue.path.map((p) => String(p)).join('/');
    return `- ${path}: ${issue.message}`;
  });
  return truncate(lines.join('\n'), maxDigestChars);
}

/**
 * Construye la cadena del prompt de reparación que el decorador pasa al puerto interno en
 * el intento N ≥ 2. Prefijada con `repair:` para que el puerto interno o el adaptador de
 * producción puedan reconocerla y enrutarla (el puerto interno permanece opaco; el decorador
 * nunca vuelve a solicitar con un mensaje de sistema nuevo).
 */
export function buildRepairUtterance(
  previousUtterance: string,
  rawOutput: string,
  digest: string,
  maxRawOutputChars: number,
): string {
  const replayed = truncate(JSON.stringify(rawOutput), maxRawOutputChars);
  return [
    'repair:',
    `Original utterance: ${previousUtterance}`,
    '',
    'Your previous output did not match the required JSON schema.',
    `Issues (truncated):\n${digest}`,
    '',
    `Your previous output was:\n${replayed}`,
    '',
    'Respond with a single JSON object {"action":"apply","delta":...} or {"action":"refuse","reason":"..."} that fixes the issues above.',
  ].join('\n');
}

/**
 * RetryRepairingLlmPort — un decorador que envuelve un LlmPort interno y reintenta
 * ante fallos de esquema Zod con un prompt de reparación conciso. En caso de fallo final,
 * retorna un `LlmResult` sintético de `{ kind: 'refused', reason }` para que el invocador
 * nunca tenga que exponer el literal prohibido de error de esquema.
 *
 * Los errores de transporte (cuando el puerto interno lanza una excepción) NO se reintentan:
 * el decorador los propaga intactos para que la ruta 502 del invocador se mantenga correcta.
 */
export class RetryRepairingLlmPort implements LlmPort {
  private readonly inner: LlmPort;
  private readonly maxAttempts: number;
  private readonly maxDigestChars: number;
  private readonly maxRawOutputChars: number;

  constructor(inner: LlmPort, options: Partial<RetryRepairingLlmOptions> = {}) {
    this.inner = inner;
    const opts = { ...DEFAULTS, ...options };
    this.maxAttempts = clampMaxAttempts(opts.maxAttempts);
    this.maxDigestChars = Math.max(0, Math.floor(opts.maxDigestChars));
    this.maxRawOutputChars = Math.max(0, Math.floor(opts.maxRawOutputChars));
  }

  async interpret(utterance: string, _deltaJsonSchema: object, currentIr: Diagram): Promise<LlmResult> {
    let lastRaw = '';
    let lastDigest = '';

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      const callUtterance = attempt === 1
        ? utterance
        : buildRepairUtterance(utterance, lastRaw, lastDigest, this.maxRawOutputChars);
      const result = await this.inner.interpret(callUtterance, _deltaJsonSchema, currentIr);
      lastRaw = JSON.stringify(result);

      // Las negativas son terminales — el modelo interno está diciendo explícitamente "No puedo".
      if (result.kind === 'refused') {
        return result;
      }

      const parsed = DeltaSchema.safeParse(result.value);
      if (parsed.success) {
        return { kind: 'delta', value: parsed.data };
      }

      lastDigest = buildZodDigest(parsed.error, this.maxDigestChars);
    }

    return {
      kind: 'refused',
      reason: `I could not translate your command into a valid edit. Issues:\n${lastDigest}`,
    };
  }
}
