# interpreter-llm-resilience Specification

## Purpose

Harden the production LLM path of the AI text interpreter so that schema
failures self-recover via a bounded retry+repair loop, and so that the
documented command vocabulary covers the full `DeltaSchema` discriminated
union including multi-command batches. The test-only `FakeLlm` path keeps
its deterministic single-command behavior.

## Requirements

### Requirement: Bounded Retry+Repair on Schema Failure (R1)

The interpreter, on the real LLM production path, MUST retry with the
same model up to N times (default 2, configurable via
`OPENAI_LLM_MAX_ATTEMPTS`, never greater than 3) when model output fails
delta-schema validation, passing back the raw output plus a concise
Zod-error digest (path + message, truncated). On final failure the
interpreter MUST return a refused outcome with a reason that cites the
Zod digest; the call to the LLM port MUST occur at most N times.

#### Scenario: First attempt valid

- GIVEN a real LLM configured with `maxAttempts = 2`
- WHEN the model's first output validates against `DeltaSchema`
- THEN the interpreter returns the validated delta
- AND the LLM port is called exactly once

#### Scenario: First attempt invalid, second valid

- GIVEN a real LLM configured with `maxAttempts = 2`
- WHEN the model's first output fails `DeltaSchema.safeParse`
- AND the model's second output validates
- THEN the interpreter returns the second (validated) delta
- AND the LLM port is called exactly twice

#### Scenario: All attempts invalid

- GIVEN a real LLM configured with `maxAttempts = 2`
- WHEN every model's output fails `DeltaSchema.safeParse`
- THEN the interpreter returns `{ kind: 'refused', reason: ... }`
- AND the reason string includes the Zod digest
- AND the LLM port is called exactly twice

#### Scenario: Retry count is bounded and configurable

- GIVEN a real LLM configured with `maxAttempts = 1`
- WHEN the model's only output fails `DeltaSchema.safeParse`
- THEN the interpreter returns a refused outcome
- AND the LLM port is called exactly once
- AND configuration values `> 3` are clamped to `3`

### Requirement: Real LLM Path Distinguishable from FakeLlm (R2)

The retry+repair loop MUST apply only to the real LLM production path.
The test-only `FakeLlm` MUST continue to behave deterministically: when
its output fails the delta schema, the interpreter returns immediately
with a schema-error (or refusal per the configured policy) without
invoking the retry+repair wrapper.

#### Scenario: FakeLlm invalid JSON bypasses retry

- GIVEN the test environment is wired with `FakeLlm`
- WHEN the stub returns output that fails `DeltaSchema.safeParse`
- THEN the interpreter does not retry
- AND the underlying real-LLM adapter is not invoked
- AND the outcome is a schema-error (or a refusal, per policy)

### Requirement: Full Vocabulary Coverage (R3)

The interpreter's documented supported categories MUST cover all seven
Delta kinds (class, member, association, generalization, realization,
dependency, n-ary association) plus batch. The `SUPPORTED_CATEGORIES`
list in `apps/api/src/interpreter.ts` MUST contain an entry for every
category listed in `DeltaSchema`'s discriminated union.

#### Scenario: SUPPORTED_CATEGORIES enumerates all seven kinds plus batch

- GIVEN `DeltaSchema` defines kinds
  `class | member | association | generalization | realization | dependency | nary | batch`
- WHEN the interpreter's `SUPPORTED_CATEGORIES` list is inspected
- THEN it contains every one of those eight categories
- AND the list is exposed (typed export) so the test can assert on it

### Requirement: Multi-Command Batch Support (R4)

When the user's utterance asks for multiple operations, the interpreter
MUST emit a single `BatchDelta` wrapping each operation. Single
utterances describing a single n-ary association MUST emit a single
`NaryAssociationDelta` (not a batch). The resulting delta MUST validate
against `DeltaSchema` end-to-end before being offered for confirmation.

#### Scenario: Multiple class creates

- GIVEN a real LLM production path
- WHEN the user submits "create classes Supplier, Part, Project"
- THEN the interpreter emits a single `BatchDelta` whose `deltas` array
  contains exactly three class-create operations

#### Scenario: Mixed create and attribute add

- GIVEN a real LLM production path
- WHEN the user submits
  "create class A and add attribute x: int to it"
- THEN the interpreter emits a single `BatchDelta` with one class
  create and one member add
- AND each sub-delta validates individually and as part of the batch

#### Scenario: Ternary association is a single delta, not a batch

- GIVEN a real LLM production path
- WHEN the user submits
  "create a ternary association between Supplier, Part, and Project"
- THEN the interpreter emits a single `NaryAssociationDelta`
- AND it is not wrapped in a `BatchDelta`

### Requirement: Generic Schema-Error Message Banned from Production UX (R5)

The literal string
`"The command could not be interpreted: the AI output did not match the
delta schema."` MUST NOT be returned to the user on the production LLM
path when retry+repair is enabled. It MAY be returned only when
retry+repair is disabled OR when retry+repair also fails AND no refusal
is possible (defensive fallback).

#### Scenario: Normal flow never surfaces the literal

- GIVEN a real LLM production path with retry+repair enabled
- AND a model output that fails `DeltaSchema.safeParse` on every attempt
- WHEN the interpreter produces its outcome
- THEN the user-facing response is a refusal with a reason
- AND the response body does NOT contain the banned literal

#### Scenario: Banned literal allowed when retry+repair is disabled

- GIVEN a real LLM production path with `maxAttempts = 1`
- AND the single model output fails `DeltaSchema.safeParse`
- WHEN the interpreter produces its outcome
- THEN returning the banned literal is permitted (defensive fallback)

### Requirement: Open Question Closure (R6)

This change closes the Open Question at
`openspec/changes/ai-uml-design-tool/specs/ai-text-interpreter/spec.md:99`
("multi-command batches vs single-command scope") in favour of
multi-command support, exercised end-to-end by R4.

#### Scenario: Open Question is resolved

- GIVEN the existing spec at
  `openspec/changes/ai-uml-design-tool/specs/ai-text-interpreter/spec.md`
- WHEN this change is archived
- THEN that Open Question entry is removed
- AND a cross-reference note is added pointing at R4 in this spec

## Cross-Cutting Concerns

- Depends on `diagram-editor` IR: every emitted delta MUST be valid
  against the same `DeltaSchema` the editor already applies.
- Emits deltas to the existing apply pipeline (`applyDelta` in
  `packages/core/src/delta.ts`), so the editor and `realtime-collaboration`
  channels consume the new shapes without contract change.
- `voice-input` reuses this pipeline after transcription, so R1–R5 apply
  to voice-driven utterances as well.
- The retry+repair wrapper is implementation detail and lives outside
  this spec; the spec pins the user-visible contract only.

## Acceptance Criteria

- [ ] R1 — production LLM retries schema-invalid output up to N times
      (default 2, max 3) and returns a refusal citing the Zod digest
      when all attempts fail
- [ ] R2 — `FakeLlm` path does not invoke the retry+repair wrapper
- [ ] R3 — `SUPPORTED_CATEGORIES` enumerates all seven Delta kinds plus
      batch
- [ ] R4 — multi-command utterances produce a single `BatchDelta`; a
      ternary association produces a single `NaryAssociationDelta`
- [ ] R5 — the generic schema-error literal is never surfaced on the
      production path when retry+repair is enabled
- [ ] R6 — Open Question at `ai-text-interpreter/spec.md:99` is closed
      by this change

## Related Delta

The existing `ai-text-interpreter` capability
(`openspec/changes/ai-uml-design-tool/specs/ai-text-interpreter/spec.md`)
gains (a) a requirement that the production LLM path returns either a
refused outcome with a clear reason OR a schema-valid Delta — never the
generic schema-error message to the user — and (b) the closure of its
Open Question at line 99. R6 above records that closure here.
