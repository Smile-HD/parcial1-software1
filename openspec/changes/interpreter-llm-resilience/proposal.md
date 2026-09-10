# Proposal: Interpreter LLM Resilience

## Intent

Production traffic hits the real LLM (OpenAI-compatible adapter), not the
deterministic `FakeLlm` used by tests. In production the model can return JSON
that fails the Zod delta-schema gate at `interpreter.ts:85–91`, which surfaces
to the user as the generic
`"The command could not be interpreted: the AI output did not match the delta
schema."` and a `422` from the API. That is a poor UX for a multi-step
conversational tool: the user sees a dead-end error, gets no hint of what
went wrong, and has no recovery path. The bounded command vocabulary exposed
to the user also doesn't yet cover the full delta schema uniformly
(generalization, realization, dependency, n-ary, batch), and a multi-command
utterance collapses to whichever single command the LLM happened to emit.
This change closes both gaps: the production LLM path becomes
self-recovering through a bounded retry+repair loop, and the vocabulary
coverage of the spec is unified with the engine's `Delta` schema. It also
resolves the existing Open Question in
`openspec/changes/ai-uml-design-tool/specs/ai-text-interpreter/spec.md:99`
by adopting multi-command batch support (BatchDelta is already part of
`packages/core/src/delta.ts:232–243`).

## Scope

### In Scope
- Retry+repair loop in the real LLM production path: on Zod failure, the
  interpreter feeds the model's raw output + a concise schema-error digest
  back to the same model, up to N attempts (configurable, default 2),
  then either accepts the valid output or surfaces a refusal with a clear
  reason. Total attempts are bounded so a pathological model cannot stall
  the request.
- Vocabulary coverage: the bounded command set documented in the spec
  matches the full discriminated union in `DeltaSchema` (class, member,
  association, generalization, realization, dependency, n-ary, batch).
- Multi-command utterances produce a `BatchDelta` (already supported by
  `BatchDeltaSchema` and `applyDelta`) instead of a single-delta snapshot.
- Strict TDD: tests written RED first. New cases in
  `apps/api/src/interpreter.test.ts` and a focused test for the
  retry+repair seam in `packages/adapters-ai/src/index.test.ts`.
- The `FakeLlm` test helper and its single-command behaviour stay as
  offline dev defaults; it does not need to grow the loop (offline path
  is deterministic and never hits the schema gate for well-formed input).

### Out of Scope
- Adding new delta kinds to the engine (BatchDelta and the seven single
  kinds are already in `packages/core/src/delta.ts`).
- A full conversational memory across calls (single-turn input only).
- Streaming responses, tool use, or function-calling providers (keeps the
  `OpenAI-compatible` json_object contract simple).
- Frontend/editor UI changes (the API contract carries the same `pending`
  vs `refused` outcomes the web client already handles).
- Codegen, importers, collaboration, voice, and offline AI flows.

## Capabilities

### New Capabilities
- `interpreter-llm-resilience`: bounded retry+repair on the real LLM
  production path, refusal-with-reason as a first-class terminal outcome,
  and multi-command batch support mapped to `BatchDelta`.

### Modified Capabilities
- `ai-text-interpreter`: the existing spec (in
  `openspec/changes/ai-uml-design-tool/specs/ai-text-interpreter/spec.md`)
  gains (a) a new requirement that the production LLM path MUST return
  either a refused outcome with a clear reason OR a schema-valid Delta
  — never a generic schema-error message to the user, and (b) a new
  scenario closing Open Question line 99 in favour of multi-command
  batch support. Implementation-only internals (retry loop, repair
  prompt) are NOT part of the spec; the spec pins the user-visible
  contract.

## Approach

- The real-LLM adapter gains a thin `withRetryAndRepair` wrapper
  (sibling helper to the existing `repairModelIdentifiers` in
  `packages/adapters-ai/src/index.ts:687–711`). The wrapper:
  1. Calls the model once.
  2. Runs `DeltaSchema.safeParse` on the returned value.
  3. On failure, builds a short repair prompt: the model output + a
     compact Zod issue list (path + message, truncated to ~500 chars).
  4. Re-invokes the model up to `maxAttempts - 1` times (default 2 total).
  5. On final failure, returns `{ kind: 'refused', reason: "I could not
     translate your command into a valid edit. Try a shorter or
     differently worded request." }` — the user sees a refusal with a
     clear reason, not a 422 schema-error.
- `interpreter.ts` keeps its single-line `LlmResult → InterpretOutcome`
  mapping. The schema-error path (line 86–90) becomes a defensive
  fallback only — production should never reach it.
- `OPENAI_LLM_MAX_ATTEMPTS` env knob (default 2) for ops.
- Multi-command batch: the spec clarifies the production contract; the
  adapter prompt already includes batch as a valid shape, so no
  prompt surgery is required for the production path. `FakeLlm` is
  unchanged.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `apps/api/src/interpreter.ts` | Modified | Schema-error branch becomes a defensive fallback; mapping is unchanged. |
| `apps/api/src/index.ts` | Modified | `/diagrams/:id/interpret` error mapping: 422 only on the defensive path, refusals remain 200. |
| `packages/adapters-ai/src/index.ts` | Modified | Add `withRetryAndRepair` wrapper; expose `OpenAiLlm.fromEnv` retry config. |
| `packages/adapters-ai/src/index.test.ts` | Modified | RED-first tests for the wrapper: invalid → repair → valid; invalid → repair → invalid → refused. |
| `apps/api/src/interpreter.test.ts` | Modified | RED-first tests: real-LLM failure path returns refused; multi-command utterance yields `BatchDelta` shape through the wrapper seam. |
| `packages/core/src/delta.ts` | Unchanged (confirm) | `BatchDeltaSchema` (lines 232–243) already covers the multi-command case. |
| `openspec/changes/ai-uml-design-tool/specs/ai-text-interpreter/spec.md` | Delta spec | New requirement: production LLM path returns refused OR valid Delta, never a schema-error to the user. Closes Open Question line 99. |

## Risks

| Risk | L | Mitigation |
|------|---|------------|
| Retry loop amplifies cost / latency on a flaky model | Med | `OPENAI_LLM_MAX_ATTEMPTS` env knob (default 2); wrapper is bounded. |
| Repair prompt confuses the model into worse output | Low | Compact issue digest; second failure terminates as a refused outcome. |
| Test parity: real-LLM path is hard to integration-test offline | Med | Wrap the LLM call behind the same `LlmPort`; tests inject a stub LlmPort that fails first then succeeds. |
| Batch shape changes the editor's apply path | Low | `applyDelta` already handles `BatchDelta`; web client already accepts `pending` outcomes carrying any `Delta`. |
| Vocabulary growth reveals spec gaps | Low | Delta spec reuses the existing command-vocabulary list; no new kinds invented. |

## Rollback Plan

The change is additive behind the existing `LlmPort` interface. To roll
back: revert the wrapper addition in `packages/adapters-ai/src/index.ts`,
revert the `interpreter.ts` defensive-fallback simplification, drop the
new tests. The API and `DeltaSchema` are unchanged, so the editor and
client keep working. No DB migration, no data shape change.

## Dependencies

- `OPENAI_API_KEY` already required for the real-LLM path (unchanged).
- New env: `OPENAI_LLM_MAX_ATTEMPTS` (default 2, optional).
- No new third-party packages.

## Success Criteria

- [ ] Production LLM path NEVER surfaces the generic
      "The command could not be interpreted: the AI output did not match
      the delta schema" message to the user; the 422 branch is a
      defensive fallback that tests cannot reach on the production path.
- [ ] RED-first tests for the retry+repair wrapper pass GREEN.
- [ ] Multi-command utterance through the production path yields a
      `BatchDelta` with all sub-deltas schema-valid.
- [ ] `pnpm -r test` and `tsc --noEmit` pass.
- [ ] Open Question in
      `openspec/changes/ai-uml-design-tool/specs/ai-text-interpreter/spec.md:99`
      is closed in favour of multi-command batch support (delta spec).
