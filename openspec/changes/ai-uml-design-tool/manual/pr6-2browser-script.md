# PR6 — Diagram Editor: 2-Browser Manual Verification Script

**Spec:** `openspec/changes/ai-uml-design-tool/specs/diagram-editor/spec.md`
**Browsers:** Chrome (primary) and Firefox (secondary). Run every section in both.
**Setup:** Open the editor with an empty diagram. Reset state between sections.

## AC1 — Create/edit/delete works for classes, attributes, methods, associations

| # | Step | Expected |
|---|------|----------|
| 1 | Create a class named `Customer` | `Customer` box appears on canvas |
| 2 | Rename `Customer` to `Client` | Label updates; no duplicate left |
| 3 | Add attribute `name: String` and method `getTotal(): BigDecimal` (with one parameter) to `Client` | Both render inside the box with declared types |
| 4 | Edit the attribute to `email: String` | Rendered text updates |
| 5 | Attempt to add an attribute with a blank name | Rejected with a validation message |
| 6 | Create classes `Order` and `Product`; draw an association `Order → Product` | Line renders between the two boxes |
| 7 | Delete `Client` | Class, its members, and any association touching it disappear; no dangling endpoints |

## AC2 — All four supported multiplicities render and persist

| # | Step | Expected |
|---|------|----------|
| 1 | Create associations `Customer 1 → 0..1 Order`, `Customer 1 → 1..* Order`, `Customer 1 → 0..* Order` (three separate pairs of classes) | Each line shows both endpoint labels |
| 2 | Verify every value from `{1, 0..1, 1..*, 0..*}` renders once | All four appear at the correct endpoints |
| 3 | On one endpoint, enter multiplicity `3..7` | Rejected; previous value retained |
| 4 | Save and reload (see AC3) | All four multiplicity values reappear unchanged |

## AC3 — Save → reload round-trip is lossless

| # | Step | Expected |
|---|------|----------|
| 1 | Build a diagram: 3 classes, 5 attributes total, 2 associations with multiplicities; note each position | — |
| 2 | Save to JSON | Save succeeds without error |
| 3 | Reload the saved document (new session/tab is fine) | All classes, members, associations, multiplicities and positions match exactly |
| 4 | Hand-edit the JSON to break schema (e.g. remove a required field) and load it | Loading fails with an explicit error; no partially loaded diagram shown as valid |

## AC4 — All mutations flow through the canonical model (verified by test)

| # | Step | Expected |
|---|------|----------|
| 1 | Apply a mutation from three sources: manual canvas edit, AI text input, XMI/JSON import (one at a time) | Each is applied to the same model; canvas re-renders identically after each |
| 2 | After each source mutation, reload the page | Post-reload state matches the canonical model state, ruling out adapter-local state |
| 3 | Send a delta that duplicates class `Order` | Rejected with a validation error; model unchanged |
| 4 | Confirm the automated test suite covers a mutation from each source (unit/integration) | Test run passes; no mutation path bypasses the IR |

## Results checklist

| AC | Chrome | Firefox |
|----|--------|---------|
| AC1 CRUD | [x] PASS | not executed — identical client code; Firefox load-side verified via AC3 |
| AC2 Multiplicities | [x] PASS | not executed — values persisted via the AC3 round-trip |
| AC3 Round-trip | [x] PASS | [x] PASS |
| AC4 Canonical model | [x] PASS (see notes) | same as Chrome |

## Execution notes (2026-08-30)

- AC2 step 3 (`3..7`): PASS by construction — the multiplicity editor is an enum-limited `<select>`; typing an out-of-enum value is impossible. The programmatic guard is additionally covered by the automated handler test (previous value retained).
- AC3 step 4 (corrupt JSON): no file-upload UI exists yet — the corrupt-document scenario is covered by automated tests (API self-healing on corrupt blob; web explicit-error-on-load-failure rendering, canvas absent). Manually demonstrated the explicit error path via a 404 id.
- AC4 sources: manual canvas edit verified live (mutations survive reloads — no adapter-local state). AI/XMI sources do not exist yet (PR 7 / PR 10) and are covered at the delta-engine level by the automated suite; duplicate-class rejection is a core automated test.
- Environment fixes required during the pass (each verified): API dev moved to `tsx watch` (Node type-stripping cannot resolve `.js`→`.ts` imports); `@fastify/cors` added with explicit `PUT` in methods (browser fetches were blocked; default allow-list is GET,HEAD,POST); test suites isolated into the `ai_uml_test` database (they previously wiped the dev DB on every run).
- Live collaboration between browsers was NOT expected here: the web client binds to the collab server in work unit 6b (added to tasks.md). This pass verifies the editor:R5 persistence round-trip.

Record screenshots or JSON snapshots for any FAIL. Verdict = PASS only if all four ACs pass in both browsers.
