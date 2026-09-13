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

### Scope amendment (2026-09-05 — maintainer decision)

The exam requirements explicitly require BOTH importing AND exporting to Enterprise Architect. Unit 15b adds an XMI 2.1 exporter, landing as its own PR between PR 15 and PR 16, consuming the enriched IR from units 9–13. Export must be lossless for the supported subset, proven by automated round-trip (export → re-import → identical model).

### Scope amendment (2026-09-06 — maintainer decision)

Adds Unit 16b (diagram image export, PNG/JPEG, spec `diagram-image-export`); paired with Unit 16 as the image I/O block (16 imports images into the model, 16b exports the model as image); new use case CU-12 in the report artifact.

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
| 15b | XMI 2.1 exporter (EA-compatible export; lossless round-trip with importer) | 15b | `pnpm --filter @app/adapters-import test` | export→import round-trip in-memory | drop `xmi21-export.ts` + export route |
| 16 | Photo importer | 16 | `pnpm --filter @app/api test` | fake vision + golden photo | drop photo route/UI |
| 17 | System B offline verification | 17 | `node tools/golden-check.mjs` | offline run, restart survival | revert golden-check extensions |
| 18 | Offline assistant (System B) | 18 | `node tools/golden-check.mjs` | assistant CRUD offline | revert assistant templates |
| 19 | Mobile test client + demo hardening | 19 | `flutter test` (mobile-test-client/) | Flutter app vs generated backend | delete `mobile-test-client/` |

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

- [x] 10.1 RED: `AssociationSchema` accepts `aggregation` enum `none|shared|composite` (default `none`), optional `name`, `sourceRole`, `targetRole` strings.
- [x] 10.2 RED: invalid aggregation value rejected; diamond end initially inferred by multiplicity convention (superseded by 10.7 — explicit end ownership).
- [x] 10.3 Renderer: hollow diamond (shared) / filled diamond (composite) SVG marker on the container end; association name label centered on the edge; role labels at ends.
- [x] 10.4 Editor UI: aggregation kind select + name/role inputs in the association editor (6.4 panel).
- [x] 10.5 Interpreter: "Order is composed of OrderLines", "aggregation between X and Y", role/named association commands; FakeLlm AND OpenAiLlm prompt coverage; `supportedCategories` updated.
- [x] 10.6 Verify: round-trip + collab convergence with diamonds rendering at the correct end.
- [x] 10.7 UML 2.5.1 correction: explicit `aggregationEnd: 'source'|'target'` on AssociationSchema (default 'source', backward compatible); multiplicity heuristic removed from renderer; "Aggregation end" select in editor panel; interpreter prompt + FakeLlm reversed-phrasing coverage ("OrderLine is part of Order" → diamond at Order end).

### Unit 11: Generalization (PR 11)

- [x] 11.1 RED: new IR collection `generalizations: [{ id, subClassId, superClassId }]` + delta kind `generalization` ops `create|delete` (DeltaSchema union grows).
- [x] 11.2 RED: engine invariants — both classes exist; no duplicate edge (same sub+super); NO cycles (reject A→B→A transitively); delete-class cascades its generalization edges.
- [x] 11.3 Renderer: hollow-triangle arrowhead toward superClass; transitive edge layout acceptable (straight lines).
- [x] 11.4 Editor UI: "make subclass of" action in class context menu; generalization list per class in the editor panel.
- [x] 11.5 Interpreter: "Product is a kind of Item", "Item inherits from X", "remove inheritance" commands.
- [x] 11.6 Verify: cycle rejection automated; round-trip + collab convergence.

### Unit 12: Interfaces, abstract, realization, dependency (PR 12)

- [x] 12.1 RED: `ClassSchema` accepts `kind: class|interface` (default class) + `isAbstract` boolean; abstract/interface render italic name, `«interface»` header, dashed border.
- [x] 12.2 RED: new delta kinds `realization` (client→interface; invariant: target kind === interface) and `dependency` (dashed client→supplier, no multiplicity) with create/delete + engine checks (existence, duplicates, interface-target validation).
- [x] 12.3 Renderer: realization = dashed line + hollow triangle; dependency = dashed line + open arrow.
- [x] 12.4 Editor UI: create interface action; mark-abstract toggle; realization/dependency creation from class context menu.
- [x] 12.5 Interpreter: "create interface Repository", "Order realizes Repository", "Order depends on Service" commands.
- [x] 12.6 Verify: round-trip + collab convergence; abstract/interface visuals match UML notation.

### Unit 13: N-ary associations (PR 13)

- [x] 13.1 RED: new IR collection `naryAssociations: [{ id, memberEnds: [{ classId, multiplicity, role? }], name? }]` (≥3 ends) + delta kind `naryAssociation` ops `create|delete` + engine invariants (every member class exists, ≥3 ends, no duplicate ends within one association, delete-class cascade removes affected n-ary).
- [x] 13.2 Renderer: central diamond node positioned at member centroid; one edge per member end with its multiplicity label.
- [x] 13.3 Editor UI: n-ary association mode — pick ≥3 classes, per-end multiplicity; delete via diamond context.
- [x] 13.4 Interpreter: "ternary association between Supplier, Part and Project" command (batch emits naryAssociation delta).
- [x] 13.5 Verify: round-trip + collab convergence; binary associations untouched.

### Unit 13b: Drag-from-palette editor UX (PR 13b — interaction layer, 2026-09-06)

- [x] 13b.1 Palette component (`apps/web/src/canvas/Palette.tsx`): left rail with 7 items (Class, Interface, Association, Generalization, Realization, Dependency, N-ary diamond), UML-notation glyphs, stable `data-testid`s (`palette-class` … `palette-nary`), accessible labels; edge items arm/disarm via `aria-pressed` + `--active` highlight. Tests: `Palette.test.tsx` (8).
- [x] 13b.2 Node creation by drag-and-drop: Class/Interface items are HTML5-draggable (kind travels in `dataTransfer` under `application/x-uml-palette`); canvas `onDragOver`/`onDrop` convert the drop point via `screenToFlowPosition` (finite-value guard falls back to the screen point) and emit the existing class `create` delta through the shared `handlePaletteDrop` (toolbar "Add class"/"Add interface" now delegate to it — one creation path). Tests: drop handler emits correct delta for both kinds + next-free-name; real drop event on the pane creates the node.
- [x] 13b.3 Edge creation by drag-to-connect: clicking an edge item arms the active edge tool; `nodesConnectable` is true only while armed (raw drag with no tool does nothing); `onConnect` → `handleConnectWithTool` emits association (`sourceClassId`/`targetClassId`, undirected, 1/1), generalization (`subClassId`=source → `superClassId`=target), realization (`clientClassId` → `supplierInterfaceId`) or dependency (`clientClassId` → `supplierClassId`) deltas. The four create handlers now return the engine `ApplyResult` so rejections surface. Tests: one per tool + no-tool no-op.
- [x] 13b.4 Invariant guards before emitting: realization target MUST be an interface (UI message, no delta); association/dependency/generalization endpoints must be distinct existing classes; generalization cycles and duplicate realization/dependency engine rejections are surfaced as a visible `role="alert"` message with the model unchanged. Escape or re-clicking the armed item disarms; hint shows the armed tool. Tests: guard + engine-rejection cases + canvas wiring (arm/disarm, Escape, hint).
- [x] 13b.5 N-ary palette entry: the diamond toggles the EXISTING pick-≥3 mode (shared `toggleNaryMode` with the toolbar button; modes are mutually exclusive with edge tools). Test: palette click enters pick mode and creates through the existing panel.
- [x] 13b.6 Verify: all 388 pre-existing tests still green (context-menu creation paths untouched, palette path added alongside); full `pnpm -r test` green (415 total).

### Unit 13c: Unified edge editing + palette blocks + node-wide connect (PR 13c — editor UX, 2026-09-06)

- [x] 13c.1 RED: optional `name` on `GeneralizationSchema`/`RealizationSchema`/`DependencySchema` (backward compat: existing diagrams without name still validate; non-string rejected). Tests: `ir.test.ts` (6).
- [x] 13c.2 RED: `update` op on the three edge delta schemas carrying `name` (schema gate: update requires name, mirroring the class-update gate); engine handling in `apply.ts` (empty string clears the label; unknown edge → matching NotFound error; delete/create unchanged). Tests: `delta.test.ts` (6 new + 3 unknown-op tests evolved to `create|update|delete`), `apply.test.ts` (6).
- [x] 13c.3 `ydoc.ts` build/project carries the optional `name` for the three collections (blob-preserving, like associations); the web bridge `applyDeltaToYDoc.ts` carries it too (its full rewrite would otherwise drop labels on any unrelated delta). Tests: `ydoc.test.ts` round-trip + backward compat (3).
- [x] 13c.4 ONE unified edge editor: clicking any association/generalization/realization/dependency edge opens a single panel (one position below the toolbar, `data-testid="edge-editor"`) tracking edge id + type; Label field + Delete for every kind; source/target multiplicity + roles for associations ONLY (UML-correct: the other three have no multiplicity); Aggregation/Aggregation-end dropdowns REMOVED from the editor (kind now comes from the palette). Editor closes on delete, on Close, and auto-closes when the edge disappears elsewhere. Tests: 15 in `DiagramCanvas.test.tsx` (open per kind, no-multiplicity per kind, single-panel, label edit per kind, bridge survival, delete per kind model+DOM+close, close button, label renders on the edge).
- [x] 13c.5 Delete wired for ALL edge kinds through the existing delete deltas (association already; generalization/realization/dependency added to the editor). The per-class generalization/realization/dependency LISTS stay (useful) but moved to the RIGHT edge — zero collision with the left-side editor.
- [x] 13c.6 Palette restructured into TWO labeled blocks: **Objects** (Class, Interface) and **Relations** (Association, Aggregation, Composition, Generalization, Realization, Dependency, N-ary). Aggregation/Composition are association tools with the diamond kind preset: drawing source→target creates an association with `aggregation:'shared'`/`'composite'` + `aggregationEnd:'source'`; plain Association keeps `'none'`. Tests: `Palette.test.tsx` (6 new + item list evolved), `DiagramCanvas.test.tsx` (5 tool cases incl. distinct-endpoint guard + kind survives bridge).
- [x] 13c.7 Node-wide drag-to-connect: while an edge tool is armed, every class node exposes a transparent FULL-NODE source handle (`#connect-body`, rendered only when armed so node drag-to-move is untouched) + `connectionRadius={40}` — a connection can start anywhere on the body, not just the small dots. jsdom tests cover the mechanism (overlay presence/classes per arm/disarm/Escape); real pointer-drag needs a browser re-test.
- [x] 13c.8 Verify: all 418 pre-existing tests still green (node drag, edge click-select, handle connect, context-menu creation, n-ary pick mode untouched); full `pnpm -r test` green (468 total).

### Unit 13d: EA-style Quick Linker (PR 13d — editor UX, 2026-09-06)

- [x] 13d.1 RED (strict TDD, pure logic first): `apps/web/src/canvas/quickLinker.ts` — `validConnectorsFor(sourceKind, targetKind)` (Association/Aggregation/Composition/Generalization/Dependency always; Realization ONLY when the target is an interface, mirroring `RealizationTargetNotInterfaceError`), `quickLinkerTarget(dropPoint, nodes)` (flow-coordinate rectangle containment, measured size with default-box fallback, topmost-wins on overlap, `null` = empty canvas), `elementMenuOptions()` (Class/Interface). Tests: `quickLinker.test.ts` (15).
- [x] 13d.2 `QuickLinkerMenu.tsx`: one dumb positioned (`fixed`, at the pointer-up anchor) menu component serving BOTH menus (connector + element); `data-testid="quicklinker-menu"`, `role=menu`/`menuitem`; choosing reports the item id; Escape or capture-phase click-away closes WITHOUT creating anything. Tests: `QuickLinkerMenu.test.tsx` (6, props-driven — no pointer drag needed).
- [x] 13d.3 Corner arrow: `ClassNode.tsx` renders a ~14px Quick Linker arrow at the TOP-RIGHT of the SELECTED node only (`data-testid="quicklinker-arrow"`, `aria-label="Quick Linker"`, `nodrag`); canvas passes `selected` (from `selectedClassId`) + `onQuickLinkStart`. Hidden otherwise.
- [x] 13d.4 Drag + menu wiring in `DiagramCanvas.tsx`: pointer-down on the arrow starts a quick-link drag (window pointermove/pointerup listeners, thin dashed rubber-band SVG to the cursor); pointer-up resolves via `finishQuickLink` — screen→flow conversion with the same finite-guard as the palette drop, hit-test against FRESH Y.Doc projection + React Flow measured sizes. Drop on an element → connector menu (`validConnectorsFor`); drop on empty canvas → element menu; drop on the source itself cancels. Picking a connector delegates to the EXISTING `handleConnectWithTool` (every 13b/13c guard + rejection message applies verbatim). The 13c arm-tool + body-drag path is untouched and coexists.
- [x] 13d.5 Element+connector in one gesture: choosing Class/Interface from the element menu creates the node AT the drop point via the shared `handlePaletteDrop` (now returns the created classId — additive, existing callers ignore it), then chains straight into the connector menu for source→new element (e.g. class → new interface → Realization creates both deltas in one flow).
- [x] 13d.6 Verify: all 468 pre-existing tests still green (palette 13b, unified edge editor 13c, node-wide connect, context-menu creation, n-ary untouched); full `pnpm -r test` green (504 total: +15 pure logic, +6 menu component, +16 canvas gesture incl. jsdom-testable pointer flow via MouseEvent-typed-as-pointer dispatch + engine-rejection surfacing). Real-browser re-test still advised for the visual drag feel (d3 pan/zoom inert in jsdom).
- [x] 13d.7 N-ary diamond selectable + editable (fix A): core `NaryAssociationDelta` gains `op: 'update'` carrying optional `name` and/or optional replacement `memberEnds` (schema gate: update requires at least one carrier; engine re-validates the SAME create invariants — every member exists, ≥3 ends, no duplicates; empty name clears). ydoc + bridge round-trip name + per-end multiplicities (verified already lossless). Web: clicking the diamond opens a dedicated editor panel (`data-testid="nary-editor"`, unified-editor pattern) with editable Name, one multiplicity input per member end (labeled by class name, invalid input guarded pre-emit) and Delete (reuses the existing delete delta); new exported `handleUpdateNaryAssociation` emits the update delta through the bridge. RED→GREEN: 8 core apply + 3 delta + 1 ydoc + 7 web.
- [x] 13d.8 Composition/Aggregation start with EMPTY multiplicities (fix C): core `AssociationSchema.sourceMultiplicity`/`targetMultiplicity` become OPTIONAL (unspecified ≠ '1'; existing diagrams stay valid); association create engine guard drops the multiplicity requirement; `updateMultiplicity` carriers become tri-state NULLABLE (undefined keeps, string sets, null clears) with the at-least-one guard fixed to `=== undefined`. Web: `handleCreateAssociation` defaults '1'/'1' ONLY for the plain Association tool (documented); Aggregation/Composition presets (palette drag, quick-linker, shared path) leave both ends unspecified; `handleUpdateMultiplicity` maps empty input to a null clear; `AssociationEdge` draws only DEFINED multiplicities (no phantom '1', no dangling '·', no center label at all when nothing is set); editor inputs prefill `?? ''` and can be cleared. Generalization/realization/dependency confirmed multiplicity-free. RED→GREEN: 5 core apply + 4 ir + 3 delta + 3 ydoc + 6 web (+2 existing 13c/13d tests updated to the new default).
- [x] 13d.9 Clicking empty canvas deselects (fix D): `<ReactFlow onPaneClick>` clears the selected class (Quick Linker arrow hidden), closes the edge AND n-ary editors, and disarms any armed edge tool + message — the click equivalent of Escape. RED→GREEN: 4 web (jsdom fires the real React Flow pane onClick on `.react-flow__pane`).

### Unit 13e: EA-style visual theme + self-loop rendering (PR 13e — presentation + the recursive-edge fix, 2026-09-06)

- [x] 13e.1 Self-loop rendering (the "no se ve lo recursivo" bug, STRICT TDD): new pure module `apps/web/src/canvas/selfLoop.ts` — `getSelfLoopGeometry`/`getSelfLoopPath` build a rounded orthogonal loop (M/L/Q only, so tests parse its extent exactly) that exits the source handle, bulges right, runs ABOVE the node top and returns into the target handle — always outside the node body (the old bezier collapsed to a point or hid behind the opaque node). Sized from the node's measured dimensions read via `useStore` (React Flow v12.11 EdgeProps carries NO sourceNode/width — gotcha), default 180×120 box before measurement; non-finite inputs sanitized to 0. AssociationEdge + DependencyEdge detect `source === target` (id comparison — coordinate proximity would false-positive in jsdom) and render the loop with the SAME markers (diamond on the declared end, open-V arrow at the end) + per-end labels on the loop runs. RED→GREEN: `selfLoop.test.tsx` (7: 4 pure geometry + 3 canvas integration incl. self-composition diamond + self-dependency dashed arrow).
- [x] 13e.2 EA-style class box (`ClassNode.tsx` + css): three 1px-ruled compartments — `uml-class__compartment--name/--attributes/--operations` — empty ones kept as thin bands (consistent three-box look; the member-add rows live inside their compartment); stereotype «interface» above the centered bold name (italic rule kept); the EA signature folded-corner tab `uml-class__corner-tab` (top-right dog-ear, decorative span); `uml-class--selected` modifier (data.selected from 13d) → EA blue 2px border + soft glow; cream gradient fill `#FFF8E1`, `#8A8A6A` 1px border, interface keeps the 12a dashed border; members left-aligned with `+ - # ~` / `/derived` / underlined-static (already in the data — rendered EA-style).
- [x] 13e.3 Orthogonal connectors + EA labels (ALL edge components): `getBezierPath` → `getSmoothStepPath` for every non-self edge (association, generalization, realization, dependency, n-ary end) — EA's default right-angle routing; all `url(#id)` marker defs untouched (PR 10 lesson). Association labels restructured EA-style: name centered on the connector, each end's multiplicity beside that end with the role below (only DEFINED multiplicities drawn — 13d fix-C "no phantom 1 / no '·'" behavior preserved).
- [x] 13e.4 Docked toolbox (`Palette.tsx` + css): full-height left rail `#F3F3F3` with right border + "Toolbox" header strip; Objects/Relations groups kept (13c), items restyled as compact icon+label rows with subtle separators; armed tool highlighted EA-blue (`--active` → `#dcebfa` + inset border). All 13b/13c testids/aria untouched.
- [x] 13e.5 Compact professional chrome (`App.tsx` + css): inline styles replaced by classes (`app-shell`, `app-shell__title`, `app-toolbar`, `interpreter-bar`, `app-canvas`) — compact Segoe-like 12px font, light-gray chrome with thin borders, gradient title bar; canvas gets a subtle dot grid (`<Background variant={Dots}>`) on `#FAFAF6`; handles shrunk to tiny neutral dots; panels/menus unified to the light theme. Behavior untouched (all 13b–13d interactions still green).
- [x] 13e.6 Verify: structural readback tests `eaTheme.test.tsx` (8: compartments incl. empty bands, corner tab ×2, stereotype-above-name order, selected modifier, visibility prefix inside the attributes compartment, toolbox header, dot background) — CSS is presentation, so no pixel tests. Full suites green standalone: core 222, web 233 (218 pre-existing + 15 new); `pnpm -r test` green (567 total). Real-browser re-test advised for the visual feel (loop clearance, smoothstep routing around big boxes).
- [x] 13e.7 Remove the obsolete canvas toolbar (user request "quitar los botones antiguos"): deleted the `.diagram-canvas__toolbar` block (Add class / Add interface / Link classes–Cancel link / N-ary association–Cancel n-ary / Directed checkbox / Select target span) plus the dead `linkMode`/`linkSource`/`linkDirected` state, `handleAddClass`/`handleAddInterface` and the linkMode branch of `handleNodeClick` — the palette (drag Class/Interface, arm edge tools, n-ary item) + Quick Linker fully replace it; exported pure handlers untouched (tests import them). Directed-flag coverage stays via the exported-handler unit tests; the palette Association tool creates undirected associations by design, directed links remain editable through the edge editor. Test refactor: 2 toolbar-click setups → palette drag-drop simulation (jsdom MouseEvent carrying dataTransfer), 2 n-ary toolbar clicks → `palette-nary` testid, 1 'Cancel n-ary' reflection assertion dropped (palette aria-pressed already asserts the mode), App.test readiness wait `Add class` button → `palette-class` testid.
- [x] 13e.8 App name without "AI": `<h1>` → `t('app.title')` = "UML Design Tool" in BOTH languages (product name, intentional); `index.html` `<title>` aligned. AI interpreter/preview wording (preview.heading etc.) deliberately keeps "AI".
- [x] 13e.9 i18n wired into `App.tsx`: loading/error paragraphs, Save/Saving…/Saved, the whole interpreter bar (aria-label, placeholder, Send, Record/Stop + aria-labels, Thinking…, Refused: {reason}) and the handler fallback messages (module-level `t()` at call time: interpreter.reach/confirm/discard/applyFailed, voice.*) all go through the dictionary; `<LanguageToggle />` rendered in `.app-toolbar` after PresenceBar. EN values byte-identical to the old literals, so every existing App/interpreter/voice/presence test passes untouched.
- [x] 13e.10 i18n wired into the canvas layer: `DiagramCanvas` (reactive `useT` for JSX: edge-tool hint `canvas.edgeToolHint {tool}`, n-ary pick panel `nary.*` + new `nary.nameAria`, unified edge editor `editor.*` with EDGE_TYPE_LABELS → `tool.*` keys, n-ary diamond editor `naryEditor.*`, relation panels `panel.*`; module-level `t()` at call time for `describeApplyError`/`engineGuardResult`/`handleConnectWithTool` guard+reason messages), `ClassNode` (`useT`; context menu + member add/edit/validation/placeholders → `node.*`, "Depends on" reuses byte-identical `panel.dependsOn`, Quick Linker aria stays the feature name), `PresenceBar` (`presence.onlineUsers`), QuickLinkerMenu items mapped through `tool.*` at the DiagramCanvas render site (`quickLinker.ts` kept pure — CONNECTOR/ELEMENT_LABELS no longer feed the menu). All EN strings byte-identical to the removed literals → every aria-label/testid contract of 11.4/12a–12b/13b–13d preserved (verified against the exact-match queries in DiagramCanvas.test.tsx).
- [x] 13e.11 Responsive + collapse + EA presence chips: canvas owns `paletteCollapsed` and passes `collapsed`/`onToggleCollapsed` (the `palette-toggle` button finally renders); `canvas.css` appended LAST (single rollback block): `.palette--collapsed` icon-only rail, `@media (max-width:900px)` auto-collapse + wrapping chrome + scrollable panels, `@media (max-width:600px)` stacked interpreter bar, EA light presence chips (white bg, #d0d0c8 border, initials avatar via exported `presenceInitials` — "User-a1b2"→"UA", green online dot, 12px name) and the `.lang-toggle` segmented control (active = EA blue #dcebfa); `body { margin: 0 }` so the existing 100vh `.app-shell` flex column truly fills the viewport. STRICT TDD: new `i18n.test.tsx` written RED (9/9 failing) → GREEN (9): h1 "UML Design Tool" without "AI" in both langs, legacy toolbar absent, palette toggle collapses, live EN↔ES switch (Save→Guardar, Toolbox→Caja de herramientas, edge-tool hint, ES context menu), guard handlers translate at call time, presence initials + ES aria. Web 242 (233 + 9), `pnpm -r test` 576 green; vite build validates the CSS; raw `tsc` adds zero new errors (repo has no typecheck script; pre-existing strict-mode debt untouched).
- [x] 13e.12 Unit record + verify: full `pnpm -r test` green (576: core 222, web 242, api 33, collab 16, adapters-ai 61, adapters-import 1, codegen 1); structural readback for 13e.7–11 lives in `i18n.test.tsx`; tasks.md 13e.7–13e.12 recorded. Unit 13e COMPLETE — ready for verify/archive of the change.
- [x] 13e.13 Toolbox label truncation fix (user-reported: labels rendered as "gene…", horizontal scroll inside the rail): the 13e.9 restyle switched items to icon+label ROWS but left the docked rail at 86px — after group/item padding and the 40px glyph only ~20px remained for text. `canvas.css`: docked `.palette` width 86px → 160px (EA toolbox scale), `overflow-x: hidden` on the rail, `.palette__label` gets `min-width:0` + `nowrap` + `text-overflow:ellipsis` at 11px (long translations degrade to ellipsis with the tooltip carrying the full text — never a scrollbar), `.palette__header` wraps so the ES "Caja de herramientas" (pinned by `i18n.test.tsx`) never squeezes the toggle. Collapsed 52px rail and the 900px auto-collapse untouched. CSS-only; web suite re-run green.

## Phase 5: Adapters II (PRs 14–16)

### Unit 14a: Generation core + name sanitizer (PR 14a — split 2026-09-07)

- [x] 14.1 RED: name sanitizer — `../../pom.xml` (read-only) rejected; `class` rejected; every write asserted inside job output root (codegen threat row 1).
- [x] 14.2 Create `packages/codegen/src/generate.ts` — IR→file map, type + multiplicity→JPA mapping tables, warning collector (document both tables).
- [x] 14.3 Test: unmapped attribute type ⇒ warning + String fallback (codegen:R2); missing-endpoint association skipped with warning, generation completes (codegen:R3).
- [x] 14.4 Test: 3-class diagram output contains ONLY backend sources/resources/build file — zero frontend dirs (codegen:R1). Verified 2026-09-07 on `feature/ai-uml-design-tool-pr14`: codegen 18/18, full monorepo suite 593/593 green with Postgres up.

### Unit 14b: Spring templates + golden build (PR 14b — split 2026-09-07)

- [x] 14.6 Create `templates/spring-backend/**/*.hbs` (pom, application.properties, entity, repository, controller) + `golden/reference-diagram.json` (basic subset at this stage — composition, generalization, interface and n-ary are added in 14c to lock the v2 mappings) + `tools/golden-check.mjs` — `spawn` argv array, `shell:false`, fixed cwd, timeout (codegen threat row 2). Implemented on `feature/ai-uml-design-tool-pr14`: `handlebars` dep + `packages/codegen/src/render.ts` (`createHandlebarsRenderer` compiles the `.hbs` set once, serves the vendored Maven wrapper assets verbatim via a whitelist); file map extended ADDITIVELY with `Application.java` (template `application` — required for an executable boot jar) + `mvnw`/`mvnw.cmd`/`.mvn/wrapper/maven-wrapper.properties` (Maven 3.9.9 distributionUrl, wrapper 3.3.2 scripts vendored byte-identical); golden IR fixture = 4 classes (Customer/Order/Product/ShippingAddress), mapped types String/Integer/BigDecimal/Boolean/Date→LocalDate, associations 1↔0..*, 0..*↔0..*, 1↔1; entity template quotes `@Table` names (reserved SQL word ORDER), EAGER to-many + `@JsonIgnoreProperties` back-reference filters (bidirectional JSON); `tools/golden-check.mjs` = generate (tsx) → tmp sandbox → `cmd.exe /d /s /c mvnw.cmd -q -DskipTests package` (15-min timeout, tree-kill) → `java -jar` on 18080 (120-s readiness poll) → POST+GET CRUD → teardown; compile failures print the offending template id + generated file path via the manifest. RED-first: `render.test.ts` 14 tests (codegen 18→32).
- [x] 14.8 Verify: golden build green (codegen:R5); intentionally break one template once and confirm the check fails naming it (codegen:R5). Verified 2026-09-07: golden check GREEN (BUILD SUCCESS + CRUD round-trip id=1); entity.hbs closing brace removed → check FAILED exit 1 naming template "entity" + the 4 offending .java files; restored byte-identical → GREEN again. `pnpm --filter @app/codegen test` 32/32; `pnpm -r test` 607/607 green (core 222, web 242, api 33, collab 16, adapters-ai 61, adapters-import 1, codegen 32).

### Unit 14c: UML v2 semantic mappings + production profile (PR 14c — split 2026-09-07)

PR 14c additions (maintainer decision 2026-09-07): beyond 14.5/14.6b this slice also ships (C) a thin service layer — `service.hbs` generates `@Service XxxService` constructor-injecting `XxxRepository` with `findAll/findById/save/deleteById` (`jakarta.persistence.EntityNotFoundException` → 404 via controller `@ExceptionHandler`); controllers now delegate to the service and never touch the repository; interfaces get no service, entities and abstract classes do (3+1 architecture, aligned with the course reference repo). And (D) zip extras in the generated output: `Dockerfile` (eclipse-temurin:21-jre-alpine + `COPY target/*.jar` + ENTRYPOINT), `docker-compose.yml` (app on prod profile + `postgres:16-alpine` with volume) and `README.md` (local/prod/AWS-EC2+RDS run docs) emitted as new file-map entries through the same containment guard. The golden fixture was extended to lock every v2 mapping (composition, generalization root+subclass, interface+realization, abstract entity, `*` multiplicity attribute, private/protected attributes, ternary → `CustomerOrderProductLink`).

- [x] 14.5 UML-v2 mapping: composition ⇒ owning-side `cascade = ALL, orphanRemoval = true`; shared aggregation ⇒ plain association (documented decision); generalization ⇒ `@Inheritance` single-table strategy with discriminator (warning per unmapped case); interfaces with realizations ⇒ `implements` clause; abstract class ⇒ `@MappedSuperclass` fallback OR abstract entity (warning); visibility `-`/`#` ⇒ private/protected fields; n-ary ⇒ intermediate join entity (documented); attribute multiplicity >1 ⇒ `List<T>` with `@ElementCollection`. Documented as codegen mapping table extension (spec delta below). Extend `golden/reference-diagram.json` from 14b to lock every mapping above. Implemented 2026-09-07 on `feature/ai-uml-design-tool-pr14`: mapping table 3 in `generate.ts` (composition cascades from the diamond/container side; shared aggregation = plain, documented; generalization root ⇒ `@Inheritance(SINGLE_TABLE)`+`@DiscriminatorColumn("DTYPE")`, subclass `extends` + no `@Table`/`@Id` redeclaration; interface ⇒ plain `interface` file only, realizers `implements`; abstract ⇒ `abstract` entity + repo/controller/service, warn `abstract-inheritance-root-table`; `-`/`#`/`~` ⇒ private/protected/package-private modifiers; attr multiplicity many ⇒ `List<T>` `@ElementCollection(fetch=EAGER)` — LAZY + open-in-view=false 500'd the golden GET, EAGER matches the documented to-many convention; n-ary ⇒ deterministic `<SortedMemberNames>Link` join entity with owning `@ManyToOne` per member). Unmappable combos warn, never silent: `interface-endpoint-skipped`, `generalization-to-interface`, `multiple-generalization`, `realization-supplier-not-interface`, `realization-client-not-class`, `interface-attribute-skipped`, `nary-interface-member`, `nary-duplicate-member`, `nary-join-name-collision`. Fixture extended to 8 classes/4 associations/1 generalization/1 realization/1 ternary → 43 files, zero warnings. RED-first: +32 tests (codegen 32→64); `node tools/golden-check.mjs` GREEN (BUILD SUCCESS + boot + CRUD id=1).
- [x] 14.6b Production profile in generated backend: `application-prod.properties` (PostgreSQL via env vars, schema managed by JPA/Flyway) alongside the offline H2 profile; generated README documents the AWS deploy path (EB/EC2 + RDS PostgreSQL) — production deploy itself is operator work. Implemented 2026-09-07: `application-prod-properties.hbs` wires `SPRING_DATASOURCE_URL/USERNAME/PASSWORD` env vars only (nothing hardcoded, PostgreSQLDialect, ddl-auto=update); pom adds `org.postgresql:postgresql` runtime driver; README template documents local H2 run, prod Postgres run and the EC2+RDS path; golden check boots the same jar on the default profile green.

### Unit 14d: Generate-over-HTTP job API (PR 14d — split 2026-09-07)

- [x] 14.7 `POST /diagrams/:id/generate` → `{jobId}`; `GET /jobs/:id`; artifact download — in-process job registry (design D8).
- [x] 15.1 [P] RED: unsupported XMI version rejected naming supported version; current diagram unchanged (xmi:R1).
- [x] 15.2 RED: truncated/malformed XML ⇒ parse error, pre-import state intact (xmi:R4).
- [x] 15.3 Create `packages/adapters-import/src/xmi21.ts` (`fast-xml-parser`): classes/attrs/operations/associations+multiplicities, visibility from member name prefixes, aggregation kinds from memberEnd (`aggregation="shared"|"composite"`), generalization elements, interface/abstract classifiers, realization/dependency + n-ary membership (xmi:R1 + v2 subset).
- [x] 15.4 Ignore EA proprietary tagged values/extension blocks without failure; nothing leaks into IR (xmi:R2).
- [x] 15.5 Grid auto-layout — every imported class positioned, no overlap; diamond nodes at centroid (xmi:R3); bundle real EA XMI 2.1 sample fixture including one generalization + one composition.
- [ ] 15.6 `POST /diagrams/:id/import/xmi` + review-then-apply gate; commit as ONE atomic delta batch (xmi:R4; realtime cross-cutting). **PARTIAL**: atomic single-batch apply DONE (ImportXmiButton applies the whole BatchDelta atomically; API validates with BatchDeltaSchema); the explicit client-side review/preview modal is DEFERRED — product decision pending (documented exception, same as the batch trust model).
- [x] 15.6a `ImportXmiButton` jsdom tests (13): single-POST atomic-batch contract, in-flight disable / no double submit, server + engine + schema rejection surfaces leave the Y.Doc untouched, network-failure retry path, `accept` restriction and empty-file gate. Fixed a real hang bug: `applyDeltaToYDoc` ran outside the handler's guard, so a 200 response carrying a schema-invalid batch threw `ZodError` past the async handler and the control stayed in "Importing…" forever with no user feedback — the apply is now guarded and reports `xmi.applyFailed` with kind `SchemaError`.
- [x] 15.6b `POST /diagrams/:id/import/xmi` route tests (`apps/api/src/xmi-import.test.ts`, 7 tests): real EA fixtures driven over HTTP, returned batch parsed with `BatchDeltaSchema` and applied through the real engine (regression guard for #284), malformed XML → 400, unsupported XMI version → 400 naming `supported: 2.1`, non-existent diagram → 404, route method/path pinned against `apps/web/src/api/xmiApi.ts`. Fixed a real bug: `loadDiagramById` throws `DiagramNotFoundError` (it never returns falsy), so the existence check was dead code and a bad diagram id produced an uncaught 500 instead of the declared 404; the handler now mirrors the `/generate` route (404 `{error:'Diagram not found'}`, other throws → 500 `{error}`). KNOWN GAP (documented, not fixed): a payload that parses but yields a schema-invalid batch surfaces as a plain 500 via uncaught `ZodError` — an input-caused 400/422 would be the better contract; deferred as follow-up.
- [x] 15.7 Verify: real sample imports — all classes/members/associations/multiplicities + at least one generalization and composition round-trip (xmi acceptance). Contract test asserts BatchDeltaSchema + applyDelta success on the real fixture.

### Unit 15b: XMI 2.1 exporter (PR 15b — scope amendment 2026-09-05)

- [x] 15b.1 RED: exported XMI parses back through the importer into the SAME model — lossless round-trip for the full supported subset (classes, members with visibility/static/derived/attribute-multiplicity, associations with kinds/names/roles/multiplicities, generalizations, interfaces/abstract/realization/dependency, n-ary).
- [x] 15b.2 Create `packages/adapters-import/src/xmi21-export.ts` — IR → standard UML 2.x XMI 2.1 document that EA can import (visibility prefixes `+|-|#|~`, derived /, static, multiplicity ranges, aggregation kinds on memberEnd, generalization/realization/dependency elements, n-ary membership); no EA-proprietary extensions required for round-trip.
- [x] 15b.3 Export preserves layout: canvas positions serialized in an XMI layout extension; importer falls back to grid auto-layout when absent.
- [x] 15b.4 `GET /diagrams/:id/export/xmi` streams the `.xmi` file as attachment; export is strictly read-only — idempotent, no mutation, no confirm gate.
- [x] 15b.5 Verify: golden diagram exercising the full supported subset round-trips (export → import → identical model) and works offline with zero network calls.
- [x] 16.1 [P] RED: PDF renamed `.png` and oversized image rejected locally with ZERO API calls (photo:R4, threat row 3).
- [x] 16.2 Create `VisionPort` + multimodal adapter + fake; extraction JSON schema validated; prose response rejected (photo:R1).
- [x] 16.3 `POST /diagrams/:id/photo` as job; review proposal UI — edit/drop individual elements before approval (photo:R2).
- [x] 16.4 Unreadable/zero-element result ⇒ explicit warning, NO fabricated classes; document input constraints (photo:R3).
- [x] 16.5 Verify: golden clean photo end-to-end with fake; nothing commits without approval (photo acceptance).

### Unit 16b: Diagram image export (PR 16b — scope amendment 2026-09-06; pairs with Unit 16 as image I/O)

- [x] 16b.1 RED: export never bumps version, emits zero deltas, zero API calls with network blocked (image-export:R3, image-export:R4).
- [x] 16b.2 Wire html-to-image (or equivalent) on React Flow viewport + Export PNG / Export JPEG controls; filename from diagram name + id (image-export:R1).
- [x] 16b.3 JPEG white-background compositing + fit-to-content bounds at fixed 2x scale (image-export:R2).
- [x] 16b.4 Empty-canvas guard: explicit warning, no file produced (image-export:R5).
- [x] 16b.5 Verify: golden diagram exports visually match canvas (manual) and web suite stays green (image-export:R1–R5). **Note:** web suite green (273/273); the manual visual check is deferred to the maintainer on the live demo canvas.

## Phase 6: System B Demo & Hardening (PRs 17–19)

- [x] 17.1 Extend golden check: backend reaches ready state and answers health/CRUD with outbound internet blocked; zero outbound calls observed (offline:R1). (`--offline` mode: `mvnw -o` build + dead SOCKS proxy JVM)
- [x] 17.2 Test: H2 file persistence — record survives restart; first run auto-creates schema (offline:R2). (pre-kill visibility proof + 8s MVStore flush window before hard kill — see 17 handoff notes)
- [x] 17.3 Test: CRUD cycle per generated entity; missing-required-field create ⇒ client error, nothing persisted (offline:R3). (spec amendment: abstract classes generate entity ONLY — repo/controller/service are for concrete classes; 17.3b asserts abstract Payment route is 404; Bean Validation `@Valid`/`@NotBlank`/`@NotNull` added to templates)
- [x] 17.4 Generated README documents single-command `./mvnw spring-boot:run`; fresh-operator scenario passes without source edits (offline:R4).
- [x] 17.5 Verify: all offline-backend-artifact acceptance criteria via golden check run fully offline. (`node tools/golden-check.mjs --offline` exit 0, 2026-09-13)
- [x] 17.6 Production profile test: generated backend boots with `application-prod.properties` against a real PostgreSQL (local 5433 instance); schema created on first start and records survive restart — the production counterpart of 17.2's H2 test. (`node tools/golden-check.mjs --prod` exit 0; temp DB created/dropped cleanly)
- [ ] 18.1 Assistant templates: `POST /api/assistant`; deterministic intent matcher → fixed action enum (list/count/create) bound to generated CRUD (assistant:R2, design D11 — Ollama `qwen2.5:1.5b`, localhost only).
- [ ] 18.2 RED (JUnit in generated project): raw datastore query refused, no mutation (assistant:R2); unmappable request ⇒ canned capability response, no guess (assistant:R3).
- [ ] 18.3 Model-unavailable ⇒ explicit unavailable response; CRUD unaffected (assistant:R1).
- [ ] 18.4 Local audit log: timestamp + action name + outcome per executed action (assistant:R4).
- [ ] 18.5 Verify: assistant answers offline inside golden check; no outbound calls (assistant:R1).
- [ ] 19.1 Create external `mobile-test-client/` (Flutter, Dart SDK required; outside codegen output, excluded from A's pnpm build) (mobile:R1).
- [ ] 19.2 Runtime-configurable backend base URL (settings screen persisted via shared_preferences); retarget without rebuild (mobile:R4).
- [ ] 19.3 CRUD screen: full cycle on demo entity via `http` package; backend-down ⇒ explicit connection error, no stale data shown (mobile:R2).
- [ ] 19.4 Assistant screen: scripted action results + canned fallback verbatim (mobile:R3).
- [ ] 19.5 Scope check: only endpoint config + demo-entity CRUD + assistant view (mobile:R5).
- [ ] 19.6 Demo hardening: README + rehearsed demo script; verify every proposal fallback rung (AI→video, collab→scripted, photo→golden, XMI→sample, assistant→canned, codegen→pre-generated, client→web/REST).

## Phase 7 (OPTIONAL hardening — only if time remains after unit 19)

- [ ] 6c.1 Refactor `applyDeltaToYDoc` to apply deltas surgically (write only the touched class/member/association in place instead of `clear()` + rebuild). Root cause it fixes: the full-rewrite bridge gives concurrent offline multi-editor edits new Yjs element identities, so reconnect merges duplicate/lose array members. Live multi-user editing and single-editor offline reconnection are NOT affected (verified in 6b). Sanctioned by the proposal's "naive conflict handling" allowance; demo fallback exists (scripted second user).
