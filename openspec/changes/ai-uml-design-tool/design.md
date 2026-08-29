# Design: AI-Assisted UML Design Tool

## Technical Approach

One TypeScript pnpm monorepo for System A: pure `packages/core` owns the canonical IR, delta schemas and apply/validate operations; adapters wrap web UI, CRDT transport, LLM/STT/vision providers, importers and codegen. `packages/codegen` renders Handlebars templates (data files under `templates/`) into System B — a Java 21 / Spring Boot 3 / H2-file / Maven project whose only AI dependency is a localhost runtime. Single language across UI, API and IR removes IR duplication, the largest schedule risk. Deltas are the sole mutation channel (`diagram-editor` R1); every AI/import path lands in a confirm-before-apply gate.

## Architecture Decisions

| # | Decision | Choice | Alternatives (tradeoff) | Rationale |
|---|---|---|---|---|
| 1 | System A language | TypeScript end to end (Node 22 + Fastify API, React 19 + Vite web) | Java/Spring for A (second IR model, two toolchains); Python (weak canvas story) | One IR definition shared by UI and API; fastest 2-week loop |
| 2 | Canvas | React Flow (`@xyflow/react`) | Konva/raw canvas (hand-built edges, hit-testing); JointJS (licence) | Node/edge model maps 1:1 to classes/associations; nothing from scratch |
| 3 | IR + delta validation | Zod schemas in `core`, single source | Hand-written guards; JSON Schema by hand | `z.toJSONSchema` feeds LLM structured outputs, so schema and prompt cannot drift |
| 4 | Collaboration | Yjs `Y.Doc` + `y-websocket` self-hosted, awareness for presence | Liveblocks/Firebase (needs internet on demo day); hand-rolled OT | CRDT gives per-field convergence and reconnect for free; runs on LAN |
| 5 | IR ownership under sync | `Y.Doc` IS the persisted IR; canvas renders from it | Mirror Y state into a second store | Prevents the "second source of truth" the spec forbids |
| 6 | System A persistence | PostgreSQL 16 via `pg` (node-postgres); diagram stored as one `jsonb` document + Yjs update blob column | SQLite (rejected: exam mandates PostgreSQL for System A); flat files (no atomicity) | jsonb matches JSON round-trip requirement; runs via Docker compose locally, managed instance on AWS |
| 7 | AI providers | Ports `LlmPort`/`SttPort`/`VisionPort`; default OpenAI-compatible (structured outputs, Whisper, vision) | Direct SDK calls in handlers | Provider swappable; fake adapters make interpreter/photo tests deterministic |
| 8 | Slow jobs | In-process job registry + `GET /jobs/:id` polling | BullMQ+Redis (ops tax); synchronous request | Codegen and photo are seconds-scale; no extra infrastructure |
| 9 | Codegen engine | Handlebars `.hbs` files loaded at runtime from `templates/` | String concatenation in TS (templates become code) | Keeps templates as data, never runtime — the A/B boundary |
| 10 | System B stack | Java 21, Spring Boot 3.3, Spring Data JPA, H2 file mode, Maven wrapper | Gradle (heavier first build); embedded Postgres | `./mvnw spring-boot:run` is the documented one-command start; H2 file survives restart |
| 11 | Offline assistant | Deterministic intent matcher first; local Ollama (`qwen2.5:1.5b`) only classifies intent → fixed action enum; canned fallback | LLM free-text tool-calling (unreliable at 1.5B); pure keywords (not "AI") | Bounded action set, no arbitrary queries, localhost-only traffic |
| 12 | Mobile test client | Expo React Native, endpoint configurable at runtime — separate repo/tree, NOT generated | Native Android; web PWA (weaker "mobile" claim) | Reuses TS skills; explicit non-generation per spec |

## Data Flow

    voice ─STT─┐
    text ──────┼→ LlmPort ─→ Delta (Zod) ─→ CONFIRM GATE ─┐
    photo ─────┘  (vision)                                 │
    XMI ─→ parser ─→ Delta batch ─→ REVIEW GATE ────────────┤
                                                            ▼
    canvas edit ────────────────────────────────→ core.applyDelta(IR)
                                                            │
                          ┌─────────────────────────────────┤
                          ▼                                 ▼
                          Y.Doc sync ─→ peers            PostgreSQL jsonb doc
                                                            │
                                                    codegen ▼ (templates)
                                              System B tree → zip → mvnw run

Interpreter sequence:

    UI → API: POST /diagrams/:id/interpret {utterance}
    API → LlmPort: prompt + delta JSON Schema
    LlmPort → API: candidate JSON        [refusal ⇒ 200 {refused, reason}]
    API: Zod parse                       [fail ⇒ 422, model untouched]
    API → UI: {deltaId, preview}
    UI → API: POST /deltas/:deltaId/confirm
    API: core.applyDelta → Y.Doc → persist → broadcast

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `pnpm-workspace.yaml`, `package.json`, `tsconfig.base.json` | Create | Monorepo root, strict TS |
| `packages/core/src/ir.ts` | Create | Zod IR: Diagram/Class/Attribute/Method/Association, multiplicity enum `1\|0..1\|1..*\|0..*` |
| `packages/core/src/delta.ts` | Create | Delta union + `z.toJSONSchema` export for LLM |
| `packages/core/src/apply.ts` | Create | Pure `applyDelta`, invariant checks (dup class, dangling endpoint cascade) |
| `packages/core/src/ports.ts` | Create | `DiagramRepository`, `LlmPort`, `SttPort`, `VisionPort`, `ImporterPort`, `TemplateStore` |
| `packages/adapters-ai/src/openai*.ts` | Create | Structured-output LLM, Whisper STT, vision adapters + fakes |
| `packages/adapters-import/src/xmi21.ts` | Create | XMI 2.1 parse (`fast-xml-parser`), version guard, atomic delta batch, grid auto-layout |
| `packages/codegen/src/generate.ts` | Create | IR → file map; type + multiplicity mapping tables; warning collector |
| `templates/spring-backend/**/*.hbs` | Create | pom, app, entity, repository, controller, `application.properties`, assistant module |
| `apps/api/src/routes/*.ts` | Create | diagrams, interpret, confirm, voice, photo, import, generate, jobs |
| `apps/web/src/canvas/*.tsx` | Create | React Flow canvas, member editors, delta-preview modal, presence bar |
| `apps/collab-server/src/index.ts` | Create | `y-websocket` host, per-diagram rooms |
| `golden/reference-diagram.json` | Create | Golden IR for the always-buildable check |
| `tools/golden-check.mjs` | Create | Generate → `mvnw -q package` in a sandbox dir → assert start |
| `mobile-test-client/` | Create | External Expo client (separate tree, excluded from A's build) |

## Interfaces / Contracts

```ts
// packages/core/src/ports.ts
export interface LlmPort { interpret(u: string, schema: object, ir: Diagram): Promise<LlmResult>; }
// LlmResult = { kind: 'delta'; value: unknown } | { kind: 'refused'; reason: string }
export interface TemplateStore { list(): Promise<string[]>; read(rel: string): Promise<string>; }
```

External API (System A): `POST /diagrams`, `GET|PUT /diagrams/:id`, `POST /diagrams/:id/interpret`,
`POST /deltas/:id/confirm|reject`, `POST /diagrams/:id/voice`, `POST /diagrams/:id/photo`,
`POST /diagrams/:id/import/xmi`, `POST /diagrams/:id/generate` → `{jobId}`, `GET /jobs/:id`, `GET /jobs/:id/artifact`.
System B (generated): `/api/{entity}` CRUD + `POST /api/assistant` → `{action, result, fallback?}`.

## Persistence Schema (PostgreSQL 16 — decided)

One table; the IR is stored as a document, never normalized into entity tables (the schema lives in Zod in `packages/core` — a relational mirror would be a second source of truth).

```sql
CREATE TABLE diagrams (
  id         uuid PRIMARY KEY,            -- uuidv7, generated by the API
  name       text NOT NULL,               -- listing label
  doc        jsonb NOT NULL,              -- readable projection of the IR
  yjs_state  bytea NOT NULL,              -- binary Yjs update blob (authoritative)
  version    integer NOT NULL DEFAULT 1,  -- optimistic concurrency counter
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_diagrams_updated ON diagrams (updated_at DESC);
```

Invariants:

- **Blob is authoritative.** Room open rebuilds the Y.Doc from `yjs_state`. `doc` is a write-time projection generated from the in-memory Y.Doc (`toJSON`) — never independently authored. Sole exception: initial creation (importer/`POST` JSON), where the Y.Doc is built in memory from Zod-validated JSON first.
- **Single transaction per save.** REST (`POST`/`PUT`) and collab debounce both write `doc + yjs_state + version` in one transaction, bumping `version`. Both use `UPDATE ... WHERE id = $1 AND version = $2`; 0 rows affected ⇒ 409, writer re-reads and retries.
- **Self-healing load.** `doc` failing Zod parse ⇒ regenerated from the blob and rewritten. Corrupt blob ⇒ explicit load error, never a partial diagram (editor:R5). Invalid-JSON `doc` is impossible: Postgres `jsonb` rejects it at write time.
- **Migrations**: plain numbered SQL files + a minimal runner in the API. No ORM. Local dev/test via `compose.yaml` (`postgres:16-alpine`, healthcheck, mounted volume); all config through `DATABASE_URL`.

Scope notes (explicit non-requirements): no auth/login/registration — verified absent from all 10 specs; presence identity is ephemeral via Yjs awareness. If auth is requested later: `users` table + JWT at the API edge + identity in awareness — an adapter, not a re-architecture. The generated System B targets gestión systems (business CRUD: entities + REST + offline assistant); codegen templates are shaped for that domain.

## Deployment Model

System A: three local processes — Vite dev server (web), Fastify API, `y-websocket` collab server — on one LAN host; PostgreSQL 16 via Docker compose (single container locally; managed instance on AWS if deployed). System B: generated into a temp tree, zipped for download, unzipped by the operator, run with `./mvnw spring-boot:run`; H2 file created on first start; Ollama installed once on the demo machine (localhost only). Mobile client runs via Expo Go against a configured LAN endpoint.

## Build Order

| Phase | Deliverable |
|-------|-------------|
| 1 | `core` IR/delta/apply + React Flow canvas + JSON persistence; interpreter with confirm gate; codegen + golden check green |
| 2 | Voice (STT → same pipeline); Yjs collaboration + presence |
| 3 | XMI importer; photo importer with review gate; System B offline assistant |
| 4 | External mobile test client; demo hardening — every fallback rehearsed |

## Testing Strategy

| Layer | What to Test | Approach |
|-------|-------------|----------|
| Unit | `applyDelta` invariants, multiplicity validation, type/relation mapping, XMI parse, assistant intent matcher | Vitest on pure `core`/`codegen`; JUnit for the assistant matcher |
| Integration | Interpret→confirm→persist, refusal path, schema-invalid LLM output, photo format rejection, atomic import failure | Fastify `inject` + fake AI adapters (no network) |
| E2E | Two-browser collaboration convergence; golden generate→build→CRUD; offline run with network disabled | Playwright; `tools/golden-check.mjs` in CI; manual offline checklist |

## Threat Matrix

| Boundary | Adversarial cases | Applicability | Design response | Planned RED tests |
|---|---|---|---|---|
| Documentation-like paths | Class/attribute names that resolve to build files (`pom.xml`, `../`, `mvnw`) | **Applicable** — codegen derives output paths from user-controlled names | Sanitize to a Java identifier allow-list `[A-Za-z_][A-Za-z0-9_]*`; reject reserved words; every write resolved and asserted inside the job output root | Name `../../pom.xml` → generation rejected, no write outside root; name `class` → rejected |
| Git repository selection | `git -C`, relative/absolute paths | **N/A** — no VCS automation in this change | — | — |
| Commit state | staged, `commit -a`, empty index | **N/A** — no commits produced | — | — |
| Push state | tracking branch, first push, refspec | **N/A** — no push automation | — | — |
| PR commands | `--head`, env prefix, composed commands | **N/A** — no PR automation | — | — |
| Subprocess execution (added row) | Golden check invoking Maven with interpolated paths; shell metacharacters in a diagram name | **Applicable** — `tools/golden-check.mjs` spawns `mvnw` | `spawn` with an argv array, `shell:false`, fixed cwd, timeout; no string interpolation | Diagram name `a; rm -rf .` → build runs on the literal path, no shell expansion; timeout kills a hung build |
| Upload handling (added row) | PDF/SVG renamed `.png`, oversized image | **Applicable** — photo importer takes user files | Magic-byte sniff + size cap before any paid API call | Renamed PDF rejected locally, zero API calls |

## Migration / Rollout

No migration — greenfield. Rollout is the phased build order with the proposal's degradation ladder: any capability not demoable falls back to its recorded/golden path. Demo-day internet risk is contained because collaboration is self-hosted and only the three online AI calls need the network.

## Open Questions

- [ ] Canvas coordinates: persisted contract (needed for XMI auto-layout round-trip) — assumed **yes**, part of the IR.
- [ ] Local model + Ollama fit in demo-machine RAM (~2 GB for 1.5B q4) — needs a hardware check.
- [ ] Is a real EA XMI 2.1 sample available, or is the `.qea` SQLite Plan B reader in scope?
- [ ] Ollama installed on the demo machine vs shipped installer — affects "self-contained" claim for System B.
- [ ] Team size/skills — the TypeScript-everywhere choice assumes no dedicated Java specialist.
