# Tasks: Interpreter LLM Resilience

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~250–350 (3 new files, 4 modified) |
| 400-line budget risk | Low |
| 800-line (cached) budget risk | Low |
| Chained PRs recommended | No |
| Suggested split | single PR |
| Delivery strategy | single-pr (cached) |
| Chain strategy | size-exception (not needed) |

Decision needed before apply: No
Chained PRs recommended: No
Chain strategy: size-exception
400-line budget risk: Low

## Phase 1: Decorator + tests (R1, R2, R5)

- [x] 1.1 RED retry-repairing-llm.test.ts [TDD: red] — first attempt valid passes through; assert call count = 1 and return equals the validated delta.
- [x] 1.2 RED retry-repairing-llm.test.ts [TDD: red] — first invalid, second valid returns the second; assert call count = 2.
- [x] 1.3 RED retry-repairing-llm.test.ts [TDD: red] — all attempts invalid returns refused with reason including the Zod digest; assert call count = N.
- [x] 1.4 RED retry-repairing-llm.test.ts [TDD: red] — `maxAttempts` clamp: `0 → 1`, `10 → 3`; assert call counts and refusal on failure.
- [x] 1.5 RED retry-repairing-llm.test.ts [TDD: red] — inner LLM throws → exception propagates untouched, no retry; assert call count = 1 and error identity.
- [x] 1.6 GREEN packages/adapters-ai/src/retry-repairing-llm.ts [TDD: green] — implement `RetryRepairingLlmPort` decorator with `maxAttempts` clamp `[1, 3]`, `ZodIssueDigest` helper, and `safeParse`-driven retry loop; export from `packages/adapters-ai/src/index.ts`.

## Phase 2: Interpreter wiring (R2, R5)

- [x] 2.1 RED apps/api/src/index.test.ts [TDD: red] — `buildApp` wraps the real `OpenAiLlm` with the decorator and NOT the test-injected `FakeLlm`; assert via a spy.
- [x] 2.2 GREEN apps/api/src/index.ts [TDD: green] — in `buildApp`, wrap the default `OpenAiLlm` with `RetryRepairingLlmPort` reading `OPENAI_LLM_MAX_ATTEMPTS` (default 2, clamp 3); preserve direct injection of any non-`OpenAiLlm` port.

## Phase 3: Prompt + vocabulary (R3, R4)

- [x] 3.1 RED apps/api/src/interpreter.test.ts [TDD: red] — multi-command utterance produces a `BatchDelta` in pending state; assert `delta.kind === 'batch'`, `deltas.length === 3`.
- [x] 3.2 RED apps/api/src/interpreter.test.ts [TDD: red] — n-ary association utterance is NOT wrapped in a batch; assert `delta.kind === 'naryAssociation'`.
- [x] 3.3 RED apps/api/src/interpreter.test.ts [TDD: red] — `SUPPORTED_CATEGORIES` covers all 7 Delta kinds + batch; assert each label present and the export is typed.
- [x] 3.4 GREEN apps/api/src/interpreter.ts [TDD: green] — convert `SUPPORTED_CATEGORIES` to a typed export enumerating all 8 categories; keep the R1 Zod gate as a defensive fallback.
- [x] 3.5 GREEN packages/adapters-ai/src/index.ts [TDD: green] — extend the OpenAI system prompt with a `BatchDelta` example showing required UUID/timestamp fields on every sub-delta.

## Phase 4: Documentation + verification (R6, AC)

- [x] 4.1 ops — run `pnpm -r test` and `pnpm -r exec tsc --noEmit -p tsconfig.base.json`; ensure all green; capture output.
- [x] 4.2 doc openspec/changes/interpreter-llm-resilience/README.md — short "How to test" note: reproduce original error path with `OPENAI_LLM_MAX_ATTEMPTS=1` vs self-recovery with default.
- [x] 4.3 ops — close Open Question at `openspec/changes/ai-uml-design-tool/specs/ai-text-interpreter/spec.md:99` in favour of R4.

Notes: strict TDD ON (RED before GREEN); `FakeLlm` never wrapped (R2);
threat matrix `N/A` per design (no shell/VCS boundary).
