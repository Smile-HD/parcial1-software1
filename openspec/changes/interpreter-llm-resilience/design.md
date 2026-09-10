# Design: Interpreter LLM Resilience

## Technical Approach

Introduce a `RetryRepairingLlmPort` decorator class in
`packages/adapters-ai/src/retry-repairing-llm.ts` that wraps any `LlmPort`
(the existing port contract from `packages/core/src/ports.ts`). The
decorator implements the bounded retry+repair loop on Zod failure only,
returning a synthetic `LlmResult` of `{ kind: 'refused', reason }` that
includes the Zod digest. `interpreter.ts` (the API-side caller) wires the
real `OpenAiLlm` through the decorator at boot time in `buildApp`. The
test-only `FakeLlm` is NEVER wrapped, so its deterministic behaviour and
existing tests stay untouched. Multi-command utterances reach the LLM as
single prompts; the LLM emits a `BatchDelta` naturally (already valid
against `DeltaSchema`, see `packages/core/src/delta.ts:232–243`).

This satisfies R1, R2, R3, R4, R5, R6 of
`openspec/changes/interpreter-llm-resilience/specs/interpreter-llm-resilience/spec.md`.

## Architecture Decisions

| #   | Decision                                  | Choice                                                    | Alternatives considered                       | Rationale                                                                                          |
| --- | ----------------------------------------- | --------------------------------------------------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| D1  | Where the retry+repair loop lives         | A `RetryRepairingLlmPort` decorator over `LlmPort`        | Inline loop in `interpreter.ts`; new port subtype | Decorator preserves separation of concerns: `interpreter.ts` stays a one-line Zod gate (R1) and the loop is testable in isolation; new subtype would duplicate the `LlmPort` shape. |
| D2  | Retry trigger condition                   | Zod failure only (`DeltaSchema.safeParse === false`)      | Any LLM error; LLM throwing                   | Network/transport errors already throw `LlmUnavailableError` upstream (R2 keeps `FakeLlm` deterministic). Retrying on non-Zod errors could amplify provider outages (cost/latency) for no schema benefit. |
| D3  | Repair-prompt payload                     | Raw model output + a compact Zod issue digest (truncated) | Just the digest; the whole prior conversation | The model needs the original output to know what to fix; just the digest loses context; full history is unbounded cost. |
| D4  | Bounded retry configuration                | `OPENAI_LLM_MAX_ATTEMPTS` env var, default 2, clamped max 3 | Hardcoded constant; > 3 attempts              | Env knob gives ops a lever; clamp prevents misconfiguration blowing up cost/latency.               |
| D5  | Test strategy for the wrapper             | A new stub `LlmPort` (fails-then-succeeds) drives the decorator deterministically; `FakeLlm` is never wrapped | Real `OpenAiLlm` in tests; `vi.useFakeTimers` with real adapter | Determinism + offline; the loop's correctness is the unit under test, not provider wiring.         |
| D6  | Multi-command handling                    | The LLM prompt explicitly demonstrates `BatchDelta` examples; the client never splits utterances. The `FakeLlm` keeps its existing single-or-batch behaviour. | Client-side sentence splitting; multi-call fan-out | The LLM owns intent resolution; a single round-trip is the cheapest and most coherent path. Splitter logic would duplicate what the model already handles. |

## Data Flow

```
UI / Editor
   │  POST /diagrams/:id/interpret  { text }
   ▼
apps/api/src/index.ts  (Fastify route)
   │  loadDiagramFromRow → currentIr
   │  interpretCommand(text, llm, currentIr, pendingDeltas)
   ▼
apps/api/src/interpreter.ts
   │  result = await llm.interpret(text, deltaJsonSchema, currentIr)
   ▼
RetryRepairingLlmPort.interpret(text, schema, currentIr)   ← new decorator
   │
   │  attempt 1 ──► inner.interpret(...)
   │                  └─► OpenAiLlm.fetch / FakeLlm.interpret
   │                  └─► DeltaSchema.safeParse(value)
   │                       ├─ success ──► return { kind: 'delta', value }
   │                       └─ failure ──► attempt < N ?
   │                                       yes ──► build repair prompt, attempt++
   │                                       no  ──► return { kind: 'refused', reason: digest }
   ▼
DeltaSchema.safeParse (interpreter:R1 gate, line 85–91 of interpreter.ts)
   │  success → store.put → { status: 'pending', deltaId, delta }
   │  failure → defensive fallback → { status: 'error', message: '...' } → 422
   ▼
apps/api/src/index.ts route
   │  200 with { status: 'pending' | 'refused' } | 422 | 502
   ▼
UI
```

Repair-prompt shape (sent to the inner LLM on attempt N≥2, when one exists):

```
Your previous output did not match the required JSON schema.
Issues (truncated):
  - /kind: expected "class" | "member" | ... | "batch"
  - /deltas/0/op: required

Your previous output was:
<the raw model output, truncated to a fixed character cap>
```

The decorator uses the same `OpenAiLlm` instance for the repair call (the
inner port is itself opaque — we never re-prompt with new system content;
we just re-invoke `interpret` with a different user-side payload OR a
repaired delta). Implementation detail chosen in code: the decorator
short-circuits by passing the raw output through a follow-up
`interpret` call with a `repair:` prefix utterance (cheap and provider-agnostic).

## File Changes

| File                                                      | Action   | Description                                                                                      | R1 | R2 | R3 | R4 | R5 | R6 |
| --------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------ | -- | -- | -- | -- | -- | -- |
| `packages/adapters-ai/src/retry-repairing-llm.ts`         | Create   | New `RetryRepairingLlmPort` decorator class + `ZodIssueDigest` helper.                           | ✔  | ✔  |    |    | ✔  |    |
| `packages/adapters-ai/src/retry-repairing-llm.test.ts`    | Create   | Unit tests with a stub `LlmPort`: first-valid, invalid-then-valid, all-invalid, clamp > 3, transport-throw bypasses retry. | ✔  | ✔  |    |    | ✔  |    |
| `packages/adapters-ai/src/index.ts`                       | Modify   | Add one `BatchDelta` example block to the system prompt; export the new decorator.              |    |    |    | ✔  |    |    |
| `packages/adapters-ai/src/index.test.ts`                  | Modify   | (Optional) Update prompt-shape assertion; the new decorator has its own test file.              |    |    |    | ✔  |    |    |
| `apps/api/src/interpreter.ts`                             | Modify   | Convert `SUPPORTED_CATEGORIES` to a typed export covering all 7 single kinds + batch; keep the R1 Zod gate. |    |    | ✔  |    |    |    |
| `apps/api/src/index.ts`                                   | Modify   | In `buildApp`, when wiring the default `OpenAiLlm` (i.e. NOT the test-injected `LlmPort`), wrap it in `RetryRepairingLlmPort`. Read `OPENAI_LLM_MAX_ATTEMPTS`. | ✔  | ✔  |    |    | ✔  |    |
| `apps/api/src/interpreter.test.ts`                        | Modify   | Add: multi-command utterance produces a `BatchDelta` (stub LLM); defensive-fallback test with `maxAttempts=1`; refusal reason includes the digest; SUPPORTED_CATEGORIES contains all 8 entries. |    |    | ✔  | ✔  | ✔  |    |
| `openspec/changes/ai-uml-design-tool/specs/ai-text-interpreter/spec.md` | Modify | Add the "production path returns refused OR valid delta, never the literal" requirement; close the Open Question at line 99. |    |    |    |    |    | ✔  |

## Interfaces / Contracts

```ts
// packages/adapters-ai/src/retry-repairing-llm.ts
import type { LlmPort, LlmResult } from '@app/core';

export interface RetryRepairingLlmOptions {
  /** Inclusive total attempts. Clamped to [1, 3]. Default 2. */
  maxAttempts: number;
  /** Max chars of the Zod digest included in the repair prompt. Default 500. */
  maxDigestChars: number;
}

export class RetryRepairingLlmPort implements LlmPort {
  constructor(
    private readonly inner: LlmPort,
    private readonly options: Partial<RetryRepairingLlmOptions> = {},
  ) {}

  async interpret(
    utterance: string,
    deltaJsonSchema: object,
    currentIr: import('@app/core').Diagram,
  ): Promise<LlmResult> {
    // …loop body. On final failure:
    // return { kind: 'refused', reason: `I could not translate your command into a valid edit. ${digest}` };
  }
}
```

The `LlmPort` interface (already in `packages/core/src/ports.ts:32–34`) is
unchanged. The decorator is structurally a `LlmPort`, so
`interpreterCommand(text, llm, …)` accepts it without modification.

## Testing Strategy

| Layer        | What                                                                                                  | Approach                                                                                          | Target file                                                    |
| ------------ | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Unit (RED)   | First attempt valid → 1 call                                                                           | Stub LLM emits valid delta; assert call count and return                                         | `retry-repairing-llm.test.ts`                                  |
| Unit (RED)   | First invalid, second valid → 2 calls                                                                  | Stub LLM emits invalid then valid; assert call count and second-valid return                     | `retry-repairing-llm.test.ts`                                  |
| Unit (RED)   | All attempts invalid → refused with digest in reason                                                   | Stub LLM emits invalid N times; assert refusal reason contains the digest and call count = N     | `retry-repairing-llm.test.ts`                                  |
| Unit (RED)   | Inner LLM throws → retry is NOT triggered (R2, transport errors are surfaced unchanged)               | Stub LLM throws; assert error propagates and no retry occurred                                   | `retry-repairing-llm.test.ts`                                  |
| Unit (RED)   | `maxAttempts > 3` is clamped to 3                                                                      | Construct with maxAttempts=10, run invalid loop, assert call count = 3                           | `retry-repairing-llm.test.ts`                                  |
| Unit (RED)   | `maxAttempts = 0` is clamped to 1 (no retries)                                                          | Construct with maxAttempts=0, run invalid output, assert call count = 1 and refusal              | `retry-repairing-llm.test.ts`                                  |
| Integration  | `SUPPORTED_CATEGORIES` enumerates all 7 single kinds + batch (R3)                                       | Static import + assert each label present                                                         | `interpreter.test.ts`                                          |
| Integration  | Multi-command utterance through the decorator seam returns a `BatchDelta` (R4)                        | Stub LLM emits a `BatchDelta`; assert the `interpretCommand` outcome is `pending` with `kind:'batch'` | `interpreter.test.ts`                                          |
| Integration  | N-ary association utterance is NOT wrapped in a `BatchDelta` (R4)                                      | Stub LLM emits a single `NaryAssociationDelta`; assert outcome is `pending` with `kind:'naryAssociation'` | `interpreter.test.ts`                                          |
| Integration  | Defensive fallback 422 path is reachable when the wrapped LLM exhausts retries AND the Zod gate still fails (R5) | Wrap stub with `maxAttempts=1`, emit invalid output, assert 422 with banned literal                | `interpreter.test.ts`                                          |
| Integration  | Production path with retry+repair returns 200 refused, never the banned literal (R5)                  | Wrap stub with `maxAttempts=2`, emit invalid, assert 200 + refused                                | `interpreter.test.ts`                                          |
| Integration  | Refusal reason includes the Zod digest (R1)                                                            | Assert `body.reason` includes one of the Zod issue paths                                         | `interpreter.test.ts`                                          |
| Smoke        | `FakeLlm` invalid output never invokes the decorator (R2)                                              | Inject `FakeLlm` directly; assert no wrapper call (use a wrapper that throws to detect wrapping) | `interpreter.test.ts`                                          |

All RED tests are written first; the production code (the decorator class
+ `SUPPORTED_CATEGORIES` update + `buildApp` wiring) lands in the
subsequent `sdd-apply` phase.

## Failure Modes

| Failure mode                                  | Behavior                                                                                            |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Inner LLM throws (network, 5xx, non-JSON)     | Exception propagates untouched. `interpreter.ts` catches it as `LlmUnavailableError` → 502. The decorator does NOT retry. |
| `maxAttempts = 0`                             | Clamped to 1 by the constructor. Single attempt; on Zod failure, returns refused with the digest.   |
| `maxAttempts > 3`                             | Clamped to 3. Three attempts max.                                                                   |
| Zod digest exceeds `maxDigestChars` (default 500) | Truncated with a trailing `[truncated]` marker.                                                     |
| Raw model output exceeds the repair-prompt size cap (default ~4 KB) | Truncated similarly; the model still gets the digest.                                               |
| Inner LLM returns `{ kind: 'refused' }` on attempt 1 | The decorator returns that refusal immediately — no retry on a clean refusal.                       |
| Inner LLM returns `{ kind: 'refused' }` on a later attempt | The decorator surfaces that refusal (the model itself is saying "I can't").                         |

## Threat Matrix

N/A — no routing, shell, subprocess, VCS/PR automation, executable-file
classification, or process-integration boundary is introduced. The change
is a pure TS decorator over an existing in-process port; the only new
env var (`OPENAI_LLM_MAX_ATTEMPTS`) is read with the same `process.env`
pattern already in use (`OPENAI_API_KEY`, `LLM_MODEL`, `OPENAI_BASE_URL`).

## Migration / Rollout

No migration required. The change is additive:
- `FakeLlm` is unchanged, so all existing tests keep passing.
- The default `OpenAiLlm` is wrapped, but its public `LlmPort` shape is
  preserved. The only new env var (`OPENAI_LLM_MAX_ATTEMPTS`) is optional
  with a safe default of 2.
- Rollback: revert the `buildApp` wiring change and delete the new file.

## Open Questions

None — all design decisions are settled by the proposal, the spec, and
the existing codebase patterns. Multi-command handling (D6) is the only
one that could have gone differently (client-side split), and the
proposal explicitly rejected that path; the spec's R4 closes the
existing Open Question in the same direction.

## Risks

| Risk                                                                                 | Mitigation                                                                                              |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| Repair prompt degrades output on a model that is not good at self-correction (e.g. small local models). | Bounded attempts + final refusal. Operators can set `OPENAI_LLM_MAX_ATTEMPTS=1` to disable repair if a specific model degrades. |
| Cost/latency amplification when the model is consistently producing invalid output.   | Default 2 attempts; clamp at 3; `OPENAI_LLM_MAX_ATTEMPTS` is ops-tunable. Worst case is 3× the latency of one call. |
| `SUPPORTED_CATEGORIES` drift if `DeltaSchema` gains a new `kind` without an update here. | Test asserts all 8 current entries; adding a new kind breaks the test until the list is updated (intentional gate). |
| Multi-command prompt for `OpenAiLlm` not strong enough — model keeps emitting single deltas. | System prompt carries an explicit `BatchDelta` example; if a particular provider model still misbehaves, that is a per-model prompt-tuning concern, not a structural one. |
