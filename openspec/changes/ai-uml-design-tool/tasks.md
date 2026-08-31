# Tasks: AI-Assisted UML Design Tool

Refs: `editor:R1` = `specs/diagram-editor/spec.md` Requirement 1. `RED` = failing test written first (threat-matrix cases are mandatory RED). `[P]` = parallelizable once its dependency units are merged.

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~6,500–8,000 authored (incl. tests, templates; +UML 2.5.1 compliance series) |
| 400-line budget risk | High |
| Chained PRs recommended | Yes |
| Suggested split | PR 1 → PR 19 (one PR per work unit, ordered below; unit 6b lands as its own PR between PR 6 and PR 7; units 9–13 inserted by the 2026-08-31 UML 2.5.1 compliance scope amendment — maintainer decision, codegen shifted to unit 14 so it consumes the enriched IR) |
| Delivery strategy | ask-on-risk (default — none passed; orchestrator must confirm) |
| Chain strategy | feature-branch-chain (decided — greenfield, sequential deps) |

Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: feature-branch-chain
400-line budget risk: High

Feature-branch-chain base boundaries: PR 1 base = tracker branch `feature/ai-uml-design-tool`; every PR n>1 base = PR n−1 branch. If a child diff shows a previous slice's changes, retarget/rebase before review.

Deployment possibility (explicitly OUT of scope for PRs 1–19): Docker image and AWS deployment MAY be requested later. Standing constraint: no choice may preclude containerization — config via env vars (`DATABASE_URL` for PostgreSQL), database data on a mounted volume, generated backend jar-packaged (`mvnw`). Offline assistant (Ollama) is localhost-only by spec; on AWS it would run on the instance itself. If Docker/AWS becomes a hard requirement, amend the proposal (delta spec) before applying.

### Scope amendment (2026-08-31 — maintainer decision)

UML 2.5.1 compliance audit found the IR covers a deliberate subset. Units 9–13 add the missing standard elements BEFORE codegen (which consumes the enriched IR): member adornments (visibility/static/derived/attribute multiplicity), arbitrary association multiplicities, aggregation/composition kinds with association names/roles, generalization, interfaces/abstract/realization/dependency, and n-ary associations. Editor:R4 is intentionally MODIFIED (`3..7` becomes valid UML); codegen (unit 14) and XMI import (unit 15) gain mapping requirements for the new elements.

### Suggested Work Units

| Unit | Goal | PR | Focused test command | Runtime harness | Rollback boundary |
|------|------|----|----------------------|-----------------|-------------------|
| 1 | Monorepo + toolchain + git | 1 | `pnpm -r test` | N/A — no runtime surface yet | delete root configs |
| 2 | Core IR + delta schemas | 2 | `pnpm --filter @app/core test` | N/A — pure lib | drop `packages/core/src` |
| 3 | applyDelta engine | 3 | `pnpm --filter @app/core test` | N/A — pure lib | revert `apply.ts` |
| 4 | PostgreSQL + Fastify API | 4 | `pnpm --filter @app/api test` | round-trip via HTTP inject (PG via Docker compose) | drop `apps/api` |
| 5 | Yjs collab transport | 5 | `pnpm --filter @app/collab-server test` | 2 in-memory Y clients on LAN | drop `apps/collab-server` |
| 6 | Editor canvas UI | 6 | `pnpm --filter @app/web test` | 2-browser manual script | drop `apps/web` |
| 6b | Web collab client (WebsocketProvider + presence + save 409-retry) | 6b | `pnpm --filter @app/web test` | 2 browsers live on one diagram | drop provider binding (revert to API-only load/save) |
| 6c | OPTIONAL (last): surgical delta bridge — applyDeltaToYDoc writes only the touched entity instead of clear+rebuild, enabling clean CRDT merges for concurrent offline multi-editor edits (limitation found during 6b.4) | optional (last) | `pnpm --filter @app/web test` | 2 browsers editing offline simultaneously, then reconnect | revert to full-rewrite bridge |
| 7 | Text interpreter + confirm gate | 7 | `pnpm --filter @app/api test` | fake LLM, zero network | drop `packages/adapters-ai` |
| 8 | Voice front-end | 8 | `pnpm --filter @app/api test` | fake STT | drop voice route/UI |
| 9 | UML member adornments (visibility/static/derived/attribute multiplicity) + arbitrary multiplicities | 9 | `pnpm --filter @app/core test && pnpm --filter @app/web test` | jsdom render checks | revert member schema fields |
| 10 | Aggregation/composition kinds + association names/roles | 10 | `pnpm --filter @app/core test && pnpm --filter @app/web test` | jsdom render checks | revert association fields |
| 11 | Generalization (inheritance) with cycle invariants | 11 | `pnpm --filter @app/core test && pnpm --filter @app/web test` | jsdom render checks | drop generalizations collection |
| 12 | Interfaces, abstract classes, realization, dependency | 12 | `pnpm --filter @app/core test && pnpm --filter @app/web test` | jsdom render checks | drop interface/dependency fields |
| 13 | N-ary associations (diamond node, ≥3 member ends) | 13 | `pnpm --filter @app/core test && pnpm --filter @app/web test` | jsdom render checks | drop n-ary collection |
| 14 | Codegen core + golden check (consumes IR v2) | 14 | `pnpm --filter @app/codegen test` | `node tools/golden-check.mjs` (mvnw build+run) | drop `packages/codegen`, `templates/`, `tools/` |
| 15 | XMI importer (maps full UML subset) | 15 | `pnpm --filter @app/adapters-import test` | bundled real EA sample | drop `xmi21.ts` + route |
| 16 | Photo importer | 16 | `pnpm --filter @app/api test` | fake vision + golden photo | drop photo route/UI |
| 17 | System B offline verification | 17 | `node tools/golden-check.mjs` | offline run, restart survival | revert golden-check extensions |
| 18 | Offline assistant (System B) | 18 | `node tools/golden-check.mjs` | assistant CRUD offline | revert assistant templates |
| 19 | Mobile test client + demo hardening | 19 | `pnpm --filter mobile-test-client test` | Expo Go vs generated backend | delete `mobile-test-client/` |

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
- [x] 5.1 Create `apps/collab-server` — `y-websocket` host, per-diagram rooms (design D4).
- [x] 5.2 Bind Y.Doc as the persisted IR: sync updates → PostgreSQL, room open → load. Transport must NOT become a second source of truth (realtime cross-cutting).
- [x] 5.3 Test: second in-memory client sees committed change; late joiner receives full current model (realtime:R1).
- [x] 5.4 Test: presence on join/leave via awareness (realtime:R2); concurrent same-attribute edit converges schema-valid; different-class edits both survive (realtime:R3); reconnect after 10s drop converges (realtime:R4).
- [x] 5.5 Verify: api + collab-server smoke run on LAN; presence list accurate.

## Phase 4: Adapters (PRs 6–8)

- [x] 6.1 Create `apps/web` (React 19 + Vite); React Flow canvas rendering exclusively from Y.Doc (editor:R1).
- [x] 6.2 Class create/rename/reposition/delete — every mutation emitted as delta through `applyDelta` (editor:R2).
- [x] 6.3 Member editors: attributes (name+type), methods (name+return+params); blank name rejected with validation message (editor:R3).
- [x] 6.4 Association editor: directed/undirected + multiplicity select limited to enum; `3..7` rejected, previous value retained (editor:R4).
- [x] 6.5 Load/save wiring via API; reloaded diagram matches saved state (editor:R5).
- [x] 6.6 Verify: all 4 diagram-editor acceptance criteria in a 2-browser manual pass.

### Unit 6b: Web collab client (added during 6.6 — realtime-collaboration spec requires it, design expects it, but no task existed for the client wiring)

- [x] 6b.1 Bind the app Y.Doc to the collab server: `WebsocketProvider` with room = diagram id (design D4), connected after the API load so the provider syncs the same PG-backed state; transport must NOT become a second source of truth (realtime cross-cutting).
- [x] 6b.2 Save 409-retry: the collab debounce bumps `version` server-side; the App save path must re-read the current version and retry per the design invariant (`UPDATE ... WHERE id = $1 AND version = $2`; 0 rows ⇒ 409, writer re-reads and retries).
- [x] 6b.3 Presence bar: connected-user names via Yjs awareness (realtime:R2) rendered in the editor chrome.
- [x] 6b.4 Verify: two-browser live pass — an edit made in one browser appears in the other without reload; presence lists both users; state converges after a server restart (realtime:R4).
- [x] 7.1 RED: "generate me a full design for a library system" ⇒ refusal response, no delta, no mutation (interpreter:R3) — automated with fake LLM.
- [x] 7.2 RED: schema-invalid LLM output ⇒ 422, model untouched, user informed (interpreter:R1).
- [x] 7.3 Create `packages/adapters-ai` — OpenAI structured-output `LlmPort` adapter + deterministic fake.
- [x] 7.4 `POST /diagrams/:id/interpret` + pending-delta store + `POST /deltas/:id/confirm|reject`; confirmed delta → `applyDelta` → broadcast (interpreter:R2).
- [x] 7.5 Out-of-vocabulary command rejected, supported categories surfaced (interpreter:R4).
- [x] 7.6 Web delta-preview modal: confirm applies visibly, reject discards (interpreter:R2); scoped edit accepted after refusal (interpreter:R3).
- [x] 7.7 Verify: refusal test automated; no delta reaches model unconfirmed (interpreter acceptance).
- [x] 8.1 [P] Create `SttPort` + Whisper adapter + fake (voice:R1).
- [x] 8.2 `POST /diagrams/:id/voice` routes transcript into the SAME interpret/confirm pipeline — no privileged path (voice:R2); "generate me a full design for a hospital" refused via voice (voice:R2).
- [x] 8.3 STT outage ⇒ explicit failure + text-input fallback message (voice:R1).
- [x] 8.4 Editable transcript before submit; corrected text drives interpretation (voice:R3).
## Phase 4b: UML 2.5.1 Compliance (PRs 9–13 — scope amendment 2026-08-31)

### Unit 9: Member adornments + arbitrary multiplicities (PR 9)

- [x] 9.1 RED: `AttributeSchema`/`MethodSchema` accept `visibility` enum `+|-|#|~` (default `+`), `isStatic`/`isDerived` booleans (default false); attribute optional `multiplicity` string — old diagrams (no fields) still validate (backward compat).
- [x] 9.2 RED: `MultiplicitySchema` (association endpoints) accepts `*`, `0`, plain integers, and ranged `m..n` (e.g. `1..4`, `2..2`) alongside the legacy four; `3..7` now VALID (editor:R4 MODIFIED — update existing rejection test + spec scenario delta).
- [x] 9.3 Renderer: `+name`, `-name`, `#name`, `~name` prefixes; static members underlined; derived members `/name`; attribute multiplicity rendered `[0..*]` after type; update canvas.css.
- [x] 9.4 Editor UI: visibility select + static/derived toggles + attribute multiplicity input in ClassNode edit rows; association multiplicity inputs freed from enum (text input + validation).
- [x] 9.5 Interpreter: FakeLlm + OpenAiLlm prompt cover new fields; "private attribute x: int", "static method count", "multiplicity many" commands; `supportedCategories` updated.
- [x] 9.6 Apply engine: no new delta kinds (member deltas carry the new optional fields); engine round-trips them untouched.
- [x] 9.7 Verify: round-trip persistence of all new fields through API (editor:R5) + collab convergence; existing tests updated for R4 change.

### Unit 10: Aggregation/composition + association names & roles (PR 10)

- [ ] 10.1 RED: `AssociationSchema` accepts `aggregation` enum `none|shared|composite` (default `none`), optional `name`, `sourceRole`, `targetRole` strings.
- [ ] 10.2 RED: memberEnd ownership stays per multiplicity convention (composite diamond renders on the WHOLE end); invalid aggregation value rejected.
- [ ] 10.3 Renderer: hollow diamond (shared) / filled diamond (composite) SVG marker on the container end; association name label centered on the edge; role labels at ends.
- [ ] 10.4 Editor UI: aggregation kind select + name/role inputs in the association editor (6.4 panel).
- [ ] 10.5 Interpreter: "Order is composed of OrderLines", "aggregation between X and Y", role/named association commands; delete-class cascade unchanged (composition does NOT add auto-delete — codegen concern only).
- [ ] 10.6 Verify: round-trip + collab convergence with diamonds rendering at the correct end.

### Unit 11: Generalization (PR 11)

- [ ] 11.1 RED: new IR collection `generalizations: [{ id, subClassId, superClassId }]` + delta kind `generalization` ops `create|delete` (DeltaSchema union grows).
- [ ] 11.2 RED: engine invariants — both classes exist; no duplicate edge (same sub+super); NO cycles (reject A→B→A transitively); delete-class cascades its generalization edges.
- [ ] 11.3 Renderer: hollow-triangle arrowhead toward superClass; transitive edge layout acceptable (straight lines).
- [ ] 11.4 Editor UI: "make subclass of" action in class context menu; generalization list per class in the editor panel.
- [ ] 11.5 Interpreter: "Product is a kind of Item", "Item inherits from X", "remove inheritance" commands.
- [ ] 11.6 Verify: cycle rejection automated; round-trip + collab convergence.

### Unit 12: Interfaces, abstract, realization, dependency (PR 12)

- [ ] 12.1 RED: `ClassSchema` accepts `kind: class|interface` (default class) + `isAbstract` boolean; abstract/interface render italic name, `«interface»` header, dashed border.
- [ ] 12.2 RED: new delta kinds `realization` (client→interface; invariant: target kind === interface) and `dependency` (dashed client→supplier, no multiplicity) with create/delete + engine checks (existence, duplicates, interface-target validation).
- [ ] 12.3 Renderer: realization = dashed line + hollow triangle; dependency = dashed line + open arrow.
- [ ] 12.4 Editor UI: create interface action; mark-abstract toggle; realization/dependency creation from class context menu.
- [ ] 12.5 Interpreter: "create interface Repository", "Order realizes Repository", "Order depends on Service" commands.
- [ ] 12.6 Verify: round-trip + collab convergence; abstract/interface visuals match UML notation.

### Unit 13: N-ary associations (PR 13)

- [ ] 13.1 RED: new IR collection `naryAssociations: [{ id, memberEnds: [{ classId, multiplicity, role? }], name? }]` (≥3 ends) + delta kind `naryAssociation` ops `create|delete` + engine invariants (every member class exists, ≥3 ends, no duplicate ends within one association, delete-class cascade removes affected n-ary).
- [ ] 13.2 Renderer: central diamond node positioned at member centroid; one edge per member end with its multiplicity label.
- [ ] 13.3 Editor UI: n-ary association mode — pick ≥3 classes, per-end multiplicity; delete via diamond context.
- [ ] 13.4 Interpreter: "ternary association between Supplier, Part and Project" command (batch emits naryAssociation delta).
- [ ] 13.5 Verify: round-trip + collab convergence; binary associations untouched.

## Phase 5: Adapters II (PRs 14–16)

- [ ] 14.1 RED: name sanitizer — `../../pom.xml` rejected; `class` rejected; every write asserted inside job output root (codegen threat row 1).
- [ ] 14.2 Create `packages/codegen/src/generate.ts` — IR→file map, type + multiplicity→JPA mapping tables, warning collector (document both tables).
- [ ] 14.3 Test: unmapped attribute type ⇒ warning + String fallback (codegen:R2); missing-endpoint association skipped with warning, generation completes (codegen:R3).
- [ ] 14.4 Test: 3-class diagram output contains ONLY backend sources/resources/build file — zero frontend dirs (codegen:R1).
- [ ] 14.5 UML-v2 mapping: composition ⇒ owning-side `cascade = ALL, orphanRemoval = true`; shared aggregation ⇒ plain association (documented decision); generalization ⇒ `@Inheritance` single-table strategy with discriminator (warning per unmapped case); interfaces with realizations ⇒ `implements` clause; abstract class ⇒ `@MappedSuperclass` fallback OR abstract entity (warning); visibility `-`/`#` ⇒ private/protected fields; n-ary ⇒ intermediate join entity (documented); attribute multiplicity >1 ⇒ `List<T>` with `@ElementCollection`. Documented as codegen mapping table extension (spec delta below).
- [ ] 14.6 Create `templates/spring-backend/**/*.hbs` (pom, application.properties, entity, repository, controller) + `golden/reference-diagram.json` (uses composition, generalization, interface + n-ary to lock the mappings) + `tools/golden-check.mjs` — `spawn` argv array, `shell:false`, fixed cwd, timeout (codegen threat row 2).
- [ ] 14.7 `POST /diagrams/:id/generate` → `{jobId}`; `GET /jobs/:id`; artifact download — in-process job registry (design D8).
- [ ] 14.8 Verify: golden build green (codegen:R5); intentionally break one template once and confirm the check fails naming it (codegen:R5).
- [ ] 15.1 [P] RED: unsupported XMI version rejected naming supported version; current diagram unchanged (xmi:R1).
- [ ] 15.2 RED: truncated/malformed XML ⇒ parse error, pre-import state intact (xmi:R4).
- [ ] 15.3 Create `packages/adapters-import/src/xmi21.ts` (`fast-xml-parser`): classes/attrs/operations/associations+multiplicities, visibility from member name prefixes, aggregation kinds from memberEnd (`aggregation="shared"|"composite"`), generalization elements, interface/abstract classifiers, realization/dependency + n-ary membership (xmi:R1 + v2 subset).
- [ ] 15.4 Ignore EA proprietary tagged values/extension blocks without failure; nothing leaks into IR (xmi:R2).
- [ ] 15.5 Grid auto-layout — every imported class positioned, no overlap; diamond nodes at centroid (xmi:R3); bundle real EA XMI 2.1 sample fixture including one generalization + one composition.
- [ ] 15.6 `POST /diagrams/:id/import/xmi` + review-then-apply gate; commit as ONE atomic delta batch (xmi:R4; realtime cross-cutting).
- [ ] 15.7 Verify: real sample imports — all classes/members/associations/multiplicities + at least one generalization and composition round-trip (xmi acceptance).
- [ ] 16.1 [P] RED: PDF renamed `.png` and oversized image rejected locally with ZERO API calls (photo:R4, threat row 3).
- [ ] 16.2 Create `VisionPort` + multimodal adapter + fake; extraction JSON schema validated; prose response rejected (photo:R1).
- [ ] 16.3 `POST /diagrams/:id/photo` as job; review proposal UI — edit/drop individual elements before approval (photo:R2).
- [ ] 16.4 Unreadable/zero-element result ⇒ explicit warning, NO fabricated classes; document input constraints (photo:R3).
- [ ] 16.5 Verify: golden clean photo end-to-end with fake; nothing commits without approval (photo acceptance).

## Phase 6: System B Demo & Hardening (PRs 17–19)

- [ ] 17.1 Extend golden check: backend reaches ready state and answers health/CRUD with outbound internet blocked; zero outbound calls observed (offline:R1).
- [ ] 17.2 Test: H2 file persistence — record survives restart; first run auto-creates schema (offline:R2).
- [ ] 17.3 Test: CRUD cycle per generated entity; missing-required-field create ⇒ client error, nothing persisted (offline:R3).
- [ ] 17.4 Generated README documents single-command `./mvnw spring-boot:run`; fresh-operator scenario passes without source edits (offline:R4).
- [ ] 17.5 Verify: all offline-backend-artifact acceptance criteria via golden check run fully offline.
- [ ] 18.1 Assistant templates: `POST /api/assistant`; deterministic intent matcher → fixed action enum (list/count/create) bound to generated CRUD (assistant:R2, design D11 — Ollama `qwen2.5:1.5b`, localhost only).
- [ ] 18.2 RED (JUnit in generated project): raw datastore query refused, no mutation (assistant:R2); unmappable request ⇒ canned capability response, no guess (assistant:R3).
- [ ] 18.3 Model-unavailable ⇒ explicit unavailable response; CRUD unaffected (assistant:R1).
- [ ] 18.4 Local audit log: timestamp + action name + outcome per executed action (assistant:R4).
- [ ] 18.5 Verify: assistant answers offline inside golden check; no outbound calls (assistant:R1).
- [ ] 19.1 Create external `mobile-test-client/` (Expo React Native, outside codegen output, excluded from A's build) (mobile:R1).
- [ ] 19.2 Runtime-configurable backend base URL; retarget without rebuild (mobile:R4).
- [ ] 19.3 CRUD screen: full cycle on demo entity; backend-down ⇒ explicit connection error, no stale data shown (mobile:R2).
- [ ] 19.4 Assistant screen: scripted action results + canned fallback verbatim (mobile:R3).
- [ ] 19.5 Scope check: only endpoint config + demo-entity CRUD + assistant view (mobile:R5).
- [ ] 19.6 Demo hardening: README + rehearsed demo script; verify every proposal fallback rung (AI→video, collab→scripted, photo→golden, XMI→sample, assistant→canned, codegen→pre-generated, client→web/REST).

## Phase 7 (OPTIONAL hardening — only if time remains after unit 19)

- [ ] 6c.1 Refactor `applyDeltaToYDoc` to apply deltas surgically (write only the touched class/member/association in place instead of `clear()` + rebuild). Root cause it fixes: the full-rewrite bridge gives concurrent offline multi-editor edits new Yjs element identities, so reconnect merges duplicate/lose array members. Live multi-user editing and single-editor offline reconnection are NOT affected (verified in 6b). Sanctioned by the proposal's "naive conflict handling" allowance; demo fallback exists (scripted second user).
