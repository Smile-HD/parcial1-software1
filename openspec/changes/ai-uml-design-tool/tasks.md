# Tasks: AI-Assisted UML Design Tool

Refs: `editor:R1` = `specs/diagram-editor/spec.md` Requirement 1. `RED` = failing test written first (threat-matrix cases are mandatory RED). `[P]` = parallelizable once its dependency units are merged.

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~4,500–5,500 authored (incl. tests, templates) |
| 400-line budget risk | High |
| Chained PRs recommended | Yes |
| Suggested split | PR 1 → PR 14 (one PR per work unit, ordered below) |
| Delivery strategy | ask-on-risk (default — none passed; orchestrator must confirm) |
| Chain strategy | feature-branch-chain (decided — greenfield, sequential deps) |

Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: feature-branch-chain
400-line budget risk: High

Feature-branch-chain base boundaries: PR 1 base = tracker branch `feature/ai-uml-design-tool`; every PR n>1 base = PR n−1 branch. If a child diff shows a previous slice's changes, retarget/rebase before review.

Deployment possibility (explicitly OUT of scope for PRs 1–14): Docker image and AWS deployment MAY be requested later. Standing constraint: no choice may preclude containerization — config via env vars (`DATABASE_URL` for PostgreSQL), database data on a mounted volume, generated backend jar-packaged (`mvnw`). Offline assistant (Ollama) is localhost-only by spec; on AWS it would run on the instance itself. If Docker/AWS becomes a hard requirement, amend the proposal (delta spec) before applying.

### Suggested Work Units

| Unit | Goal | PR | Focused test command | Runtime harness | Rollback boundary |
|------|------|----|----------------------|-----------------|-------------------|
| 1 | Monorepo + toolchain + git | 1 | `pnpm -r test` | N/A — no runtime surface yet | delete root configs |
| 2 | Core IR + delta schemas | 2 | `pnpm --filter @app/core test` | N/A — pure lib | drop `packages/core/src` |
| 3 | applyDelta engine | 3 | `pnpm --filter @app/core test` | N/A — pure lib | revert `apply.ts` |
| 4 | PostgreSQL + Fastify API | 4 | `pnpm --filter @app/api test` | round-trip via HTTP inject (PG via Docker compose) | drop `apps/api` |
| 5 | Yjs collab transport | 5 | `pnpm --filter @app/collab-server test` | 2 in-memory Y clients on LAN | drop `apps/collab-server` |
| 6 | Editor canvas UI | 6 | `pnpm --filter @app/web test` | 2-browser manual script | drop `apps/web` |
| 7 | Text interpreter + confirm gate | 7 | `pnpm --filter @app/api test` | fake LLM, zero network | drop `packages/adapters-ai` |
| 8 | Voice front-end | 8 | `pnpm --filter @app/api test` | fake STT | drop voice route/UI |
| 9 | Codegen core + golden check | 9 | `pnpm --filter @app/codegen test` | `node tools/golden-check.mjs` (mvnw build+run) | drop `packages/codegen`, `templates/`, `tools/` |
| 10 | XMI importer | 10 | `pnpm --filter @app/adapters-import test` | bundled real EA sample | drop `xmi21.ts` + route |
| 11 | Photo importer | 11 | `pnpm --filter @app/api test` | fake vision + golden photo | drop photo route/UI |
| 12 | System B offline verification | 12 | `node tools/golden-check.mjs` | offline run, restart survival | revert golden-check extensions |
| 13 | Offline assistant (System B) | 13 | `node tools/golden-check.mjs` | assistant CRUD offline | revert assistant templates |
| 14 | Mobile test client + demo hardening | 14 | `pnpm --filter mobile-test-client test` | Expo Go vs generated backend | delete `mobile-test-client/` |

## Phase 1: Foundation (PR 1)

- [x] 1.1 `git init` at repo root; `.gitignore` (node, dist, sqlite files); create tracker branch `feature/ai-uml-design-tool`; initial commit.
- [x] 1.2 Create `pnpm-workspace.yaml`, root `package.json`, strict `tsconfig.base.json` (Node 22 target); scaffold packages `@app/core`, `@app/api`, `@app/web`, `@app/collab-server`, `@app/adapters-ai`, `@app/adapters-import`, `@app/codegen`.
- [x] 1.3 Configure Vitest per package + one smoke test each; verify `pnpm -r test` green and clean install on a second machine.

## Phase 2: Core IR & Delta Engine (PRs 2–3)

- [x] 2.1 RED: IR schema rejects multiplicity outside `1|0..1|1..*|0..*` (editor:R4).
- [x] 2.2 Create `packages/core/src/ir.ts` — Zod Diagram/Class/Attribute/Method/Association; canvas positions included (design open question resolved: coordinates ARE persisted).
- [x] 2.3 Create `packages/core/src/delta.ts` — delta union (class/member/association ops + batch) + LLM-facing JSON Schema via `z.toJSONSchema` (design D3).
- [x] 2.4 Create `packages/core/src/ports.ts` — `DiagramRepository`, `LlmPort`, `SttPort`, `VisionPort`, `ImporterPort`, `TemplateStore` per design contracts.
- [x] 3.1 RED: duplicate-class delta rejected, model unchanged (editor:R1).
- [x] 3.2 Create `packages/core/src/apply.ts` — pure `applyDelta` with invariant checks.
- [x] 3.3 RED→GREEN: delete-class cascade removes its associations; no dangling endpoints (editor:R2).
- [x] 3.4 Atomic batch: one invalid delta ⇒ nothing applied (xmi:R4, photo:R2 depend on this).
- [x] 3.5 Verify: all core invariant tests green (`pnpm --filter @app/core test`).

## Phase 3: Transport & Persistence (PRs 4–5)

- [x] 4.1 Create `apps/api` Fastify bootstrap + `POST /diagrams`, `GET|PUT /diagrams/:id` on PostgreSQL 16 (`pg`, `jsonb` document column + Yjs update blob column); `compose.yaml` with a `postgres:16` service for local dev/test.
- [x] 4.2 Test: save→reload round-trip is lossless — classes, members, associations, multiplicities, positions (editor:R5).
- [x] 4.3 RED: corrupt JSON document ⇒ explicit load error, no partial diagram (editor:R5).
- [x] 4.4 Verify: `pnpm --filter @app/api test` green.
- [ ] 5.1 Create `apps/collab-server` — `y-websocket` host, per-diagram rooms (design D4).
- [ ] 5.2 Bind Y.Doc as the persisted IR: sync updates → PostgreSQL, room open → load. Transport must NOT become a second source of truth (realtime cross-cutting).
- [ ] 5.3 Test: second in-memory client sees committed change; late joiner receives full current model (realtime:R1).
- [ ] 5.4 Test: presence on join/leave via awareness (realtime:R2); concurrent same-attribute edit converges schema-valid; different-class edits both survive (realtime:R3); reconnect after 10s drop converges (realtime:R4).
- [ ] 5.5 Verify: api + collab-server smoke run on LAN; presence list accurate.

## Phase 4: Adapters (PRs 6–11)

- [ ] 6.1 Create `apps/web` (React 19 + Vite); React Flow canvas rendering exclusively from Y.Doc (editor:R1).
- [ ] 6.2 Class create/rename/reposition/delete — every mutation emitted as delta through `applyDelta` (editor:R2).
- [ ] 6.3 Member editors: attributes (name+type), methods (name+return+params); blank name rejected with validation message (editor:R3).
- [ ] 6.4 Association editor: directed/undirected + multiplicity select limited to enum; `3..7` rejected, previous value retained (editor:R4).
- [ ] 6.5 Load/save wiring via API; reloaded diagram matches saved state (editor:R5).
- [ ] 6.6 Verify: all 4 diagram-editor acceptance criteria in a 2-browser manual pass.
- [ ] 7.1 RED: "generate me a full design for a library system" ⇒ refusal response, no delta, no mutation (interpreter:R3) — automated with fake LLM.
- [ ] 7.2 RED: schema-invalid LLM output ⇒ 422, model untouched, user informed (interpreter:R1).
- [ ] 7.3 Create `packages/adapters-ai` — OpenAI structured-output `LlmPort` adapter + deterministic fake.
- [ ] 7.4 `POST /diagrams/:id/interpret` + pending-delta store + `POST /deltas/:id/confirm|reject`; confirmed delta → `applyDelta` → broadcast (interpreter:R2).
- [ ] 7.5 Out-of-vocabulary command rejected, supported categories surfaced (interpreter:R4).
- [ ] 7.6 Web delta-preview modal: confirm applies visibly, reject discards (interpreter:R2); scoped edit accepted after refusal (interpreter:R3).
- [ ] 7.7 Verify: refusal test automated; no delta reaches model unconfirmed (interpreter acceptance).
- [ ] 8.1 [P] Create `SttPort` + Whisper adapter + fake (voice:R1).
- [ ] 8.2 `POST /diagrams/:id/voice` routes transcript into the SAME interpret/confirm pipeline — no privileged path (voice:R2); "generate me a full design for a hospital" refused via voice (voice:R2).
- [ ] 8.3 STT outage ⇒ explicit failure + text-input fallback message (voice:R1).
- [ ] 8.4 Editable transcript before submit; corrected text drives interpretation (voice:R3).
- [ ] 9.1 RED: name sanitizer — `../../pom.xml` rejected; `class` rejected; every write asserted inside job output root (codegen threat row 1).
- [ ] 9.2 Create `packages/codegen/src/generate.ts` — IR→file map, type + multiplicity→JPA mapping tables, warning collector (document both tables).
- [ ] 9.3 Test: unmapped attribute type ⇒ warning + String fallback (codegen:R2); missing-endpoint association skipped with warning, generation completes (codegen:R3).
- [ ] 9.4 Test: 3-class diagram output contains ONLY backend sources/resources/build file — zero frontend dirs (codegen:R1).
- [ ] 9.5 Create `templates/spring-backend/**/*.hbs` (pom, application.properties, entity, repository, controller) + `golden/reference-diagram.json` + `tools/golden-check.mjs` — `spawn` argv array, `shell:false`, fixed cwd, timeout (codegen threat row 2).
- [ ] 9.6 `POST /diagrams/:id/generate` → `{jobId}`; `GET /jobs/:id`; artifact download — in-process job registry (design D8).
- [ ] 9.7 Verify: golden build green (codegen:R5); intentionally break one template once and confirm the check fails naming it (codegen:R5).
- [ ] 10.1 [P] RED: unsupported XMI version rejected naming supported version; current diagram unchanged (xmi:R1).
- [ ] 10.2 RED: truncated/malformed XML ⇒ parse error, pre-import state intact (xmi:R4).
- [ ] 10.3 Create `packages/adapters-import/src/xmi21.ts` (`fast-xml-parser`): classes/attrs/operations/associations+multiplicities (xmi:R1).
- [ ] 10.4 Ignore EA proprietary tagged values/extension blocks without failure; nothing leaks into IR (xmi:R2).
- [ ] 10.5 Grid auto-layout — every imported class positioned, no overlap (xmi:R3); bundle real EA XMI 2.1 sample fixture.
- [ ] 10.6 `POST /diagrams/:id/import/xmi` + review-then-apply gate; commit as ONE atomic delta batch (xmi:R4; realtime cross-cutting).
- [ ] 10.7 Verify: real sample imports — all classes/members/associations/multiplicities (xmi acceptance).
- [ ] 11.1 [P] RED: PDF renamed `.png` and oversized image rejected locally with ZERO API calls (photo:R4, threat row 3).
- [ ] 11.2 Create `VisionPort` + multimodal adapter + fake; extraction JSON schema validated; prose response rejected (photo:R1).
- [ ] 11.3 `POST /diagrams/:id/photo` as job; review proposal UI — edit/drop individual elements before approval (photo:R2).
- [ ] 11.4 Unreadable/zero-element result ⇒ explicit warning, NO fabricated classes; document input constraints (photo:R3).
- [ ] 11.5 Verify: golden clean photo end-to-end with fake; nothing commits without approval (photo acceptance).

## Phase 5: System B Demo & Hardening (PRs 12–14)

- [ ] 12.1 Extend golden check: backend reaches ready state and answers health/CRUD with outbound internet blocked; zero outbound calls observed (offline:R1).
- [ ] 12.2 Test: H2 file persistence — record survives restart; first run auto-creates schema (offline:R2).
- [ ] 12.3 Test: CRUD cycle per generated entity; missing-required-field create ⇒ client error, nothing persisted (offline:R3).
- [ ] 12.4 Generated README documents single-command `./mvnw spring-boot:run`; fresh-operator scenario passes without source edits (offline:R4).
- [ ] 12.5 Verify: all offline-backend-artifact acceptance criteria via golden check run fully offline.
- [ ] 13.1 Assistant templates: `POST /api/assistant`; deterministic intent matcher → fixed action enum (list/count/create) bound to generated CRUD (assistant:R2, design D11 — Ollama `qwen2.5:1.5b`, localhost only).
- [ ] 13.2 RED (JUnit in generated project): raw datastore query refused, no mutation (assistant:R2); unmappable request ⇒ canned capability response, no guess (assistant:R3).
- [ ] 13.3 Model-unavailable ⇒ explicit unavailable response; CRUD unaffected (assistant:R1).
- [ ] 13.4 Local audit log: timestamp + action name + outcome per executed action (assistant:R4).
- [ ] 13.5 Verify: assistant answers offline inside golden check; no outbound calls (assistant:R1).
- [ ] 14.1 Create external `mobile-test-client/` (Expo React Native, outside codegen output, excluded from A's build) (mobile:R1).
- [ ] 14.2 Runtime-configurable backend base URL; retarget without rebuild (mobile:R4).
- [ ] 14.3 CRUD screen: full cycle on demo entity; backend-down ⇒ explicit connection error, no stale data shown (mobile:R2).
- [ ] 14.4 Assistant screen: scripted action results + canned fallback verbatim (mobile:R3).
- [ ] 14.5 Scope check: only endpoint config + demo-entity CRUD + assistant view (mobile:R5).
- [ ] 14.6 Demo hardening: README + rehearsed demo script; verify every proposal fallback rung (AI→video, collab→scripted, photo→golden, XMI→sample, assistant→canned, codegen→pre-generated, client→web/REST).
