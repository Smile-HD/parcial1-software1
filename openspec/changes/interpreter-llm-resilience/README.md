# Interpreter LLM Resilience

Production hardening for the AI text interpreter. Adds a bounded
retry+repair loop on the real LLM path so schema-invalid model output is
recovered with a concise repair prompt rather than surfaced to the user
as a generic 422. Also unifies the supported command vocabulary with the
full `DeltaSchema` discriminated union and supports multi-command batches.

## How to test

The retry+repair decorator is enabled by default whenever the production
LLM path is wired (an `OPENAI_API_KEY` is set, so `buildApp` picks
`OpenAiLlm`). The decorator's budget is bounded by
`OPENAI_LLM_MAX_ATTEMPTS`:

| Env value | Effect on the production path |
| --- | --- |
| unset (default) | Up to **2** LLM calls per request. The 2nd call carries a concise repair prompt. |
| `1` | One call only. A Zod-invalid response becomes a refusal (no repair budget). |
| `2` | Same as default. Two calls. |
| `3` | Three calls. Maximum allowed. |
| `0`, negative, or non-numeric | Coerced to `1`. |
| `> 3` | Clamped to `3`. |

### Reproduce the original 422 error path (defensive fallback)

```bash
OPENAI_API_KEY=fake OPENAI_LLM_MAX_ATTEMPTS=1 pnpm dev
```

A request whose model output fails `DeltaSchema.safeParse` on the first
call (no repair budget) still surfaces the 422 with the banned literal
("The command could not be interpreted: the AI output did not match the
delta schema."). The decorator is in place but has no headroom.

### Reproduce self-recovery (default behaviour)

```bash
OPENAI_API_KEY=fake pnpm dev
```

The first invalid model response is fed back to the same model together
with a compact Zod-issue digest. A reasonable model fixes the shape and
the user sees a normal `pending` outcome. A pathological model that fails
on every attempt gets a `200 refused` outcome with the digest in the
reason — never the 422 literal.

## What's in scope

- New `RetryRepairingLlmPort` decorator (R1, R2, R5)
- `apps/api` `buildApp` wires the production LLM through it (R2, R5)
- `OpenAiLlm` system prompt gains a `BatchDelta` example (R4)
- `SUPPORTED_CATEGORIES` covers all 7 single kinds + batch (R3)
- `FakeLlm` is **never** wrapped — its deterministic behaviour is preserved
  so unit tests and offline dev run unchanged (R2)

## What's out of scope

- New delta kinds (already in `packages/core/src/delta.ts`)
- Streaming, tool use, function-calling providers
- Frontend/editor UI changes
- Voice-specific code (the voice route reuses the same pipeline)

## Multi-command batches

When the user asks for several operations in one utterance, the LLM
emits a single `BatchDelta`. The interpreter never splits a batch. The
system prompt carries explicit `BatchDelta` examples; a single
n-ary association is emitted as a single `NaryAssociationDelta`, **not**
wrapped in a batch.

## Architecture at a glance

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
RetryRepairingLlmPort.interpret(text, schema, currentIr)
   │  attempt 1 ──► inner.interpret(...)            ← new decorator
   │                  └─► OpenAiLlm.fetch
   │                  └─► DeltaSchema.safeParse
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
   │  200 with { status: 'pending' | 'refused' } | 422 (defensive) | 502 (transport)
   ▼
UI
```

## Tests

- `packages/adapters-ai/src/retry-repairing-llm.test.ts` — 7 unit tests
  covering the decorator contract (clamp, repair prompt, transport
  bypass, refusal with digest).
- `apps/api/src/interpreter.test.ts` — 3 new integration tests covering
  the wrapped production path, the `maxAttempts=1` path, the defensive
  422 path, multi-command `BatchDelta`, n-ary non-batching, and
  `SUPPORTED_CATEGORIES` coverage.
- `packages/adapters-ai/src/index.test.ts` — 1 new prompt test for the
  `BatchDelta` shape documentation.

Run them with `pnpm -r test`.
