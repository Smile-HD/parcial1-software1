/**
 * RetryRepairingLlmPort (interpreter-llm-resilience, R1).
 *
 * A thin decorator over any LlmPort that adds a bounded retry+repair loop
 * on Zod delta-schema failure. The loop is BOTH user-visible (the user gets
 * a refusal-with-digest instead of a 422) and operational (the inner port is
 * given a concise repair prompt so a flaky model can self-correct without a
 * full second round-trip from the user).
 *
 * Design decisions (see design.md):
 *  D1 — decorator over LlmPort (separation of concerns).
 *  D2 — retry only on Zod failure; transport errors propagate untouched.
 *  D3 — repair payload = raw model output + a compact Zod issue digest.
 *  D4 — `OPENAI_LLM_MAX_ATTEMPTS`, default 2, clamped to [1, 3].
 *  D5 — tests drive a stub LlmPort; FakeLlm is never wrapped.
 */
import { DeltaSchema, type Diagram, type LlmPort, type LlmResult } from '@app/core';

export interface RetryRepairingLlmOptions {
  /** Inclusive total attempts. Clamped to [1, 3]. Default 2. */
  maxAttempts: number;
  /** Max chars of the Zod digest included in the repair prompt. Default 500. */
  maxDigestChars: number;
  /** Max chars of the raw model output replayed in the repair prompt. Default 4000. */
  maxRawOutputChars: number;
}

const DEFAULTS: Required<RetryRepairingLlmOptions> = {
  maxAttempts: 2,
  maxDigestChars: 500,
  maxRawOutputChars: 4000,
};

/** Clamp an attempt count to the [1, 3] band. Exported for testability. */
export function clampMaxAttempts(value: number): number {
  if (!Number.isFinite(value)) return 1;
  const asInt = Math.floor(value);
  if (asInt < 1) return 1;
  if (asInt > 3) return 3;
  return asInt;
}

/**
 * Truncate `s` to at most `max` characters, appending a marker so callers
 * know the value was clipped. Exported for testability.
 */
export function truncate(s: string, max: number, marker = ' [truncated]'): string {
  if (max <= 0) return '';
  if (s.length <= max) return s;
  if (max <= marker.length) return marker.slice(0, max);
  return s.slice(0, max - marker.length) + marker;
}

/**
 * Build a compact Zod-issue digest suitable for a repair prompt.
 * Each issue is rendered as `/path: message` on its own line. The full
 * digest is then truncated to `maxDigestChars`.
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
 * Build the repair-prompt string the decorator passes to the inner port on
 * attempt N ≥ 2. Prefixed with `repair:` so the inner port / the production
 * adapter can recognize and route it (the inner port stays opaque; the
 * decorator never re-prompts with a fresh system message).
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
 * RetryRepairingLlmPort — a decorator that wraps an inner LlmPort and retries
 * on Zod delta-schema failure with a concise repair prompt. On final
 * failure it returns a synthetic `LlmResult` of `{ kind: 'refused', reason }`
 * so the caller never has to surface the banned schema-error literal.
 *
 * Transport errors (the inner port throws) are NOT retried: the decorator
 * surfaces them untouched so the caller's 502 path stays correct.
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

      // Refusals are terminal — the inner model is explicitly saying "I can't".
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
