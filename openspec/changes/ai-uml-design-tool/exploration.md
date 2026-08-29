# Exploration: ai-uml-design-tool

> SDD explore artifact — change `ai-uml-design-tool`, project `parcial1`.
> Phase scope: structure the problem, surface risks/open questions, compare high-level approaches.
> NOT in scope here: stack selection, specs, design details, tasks.

## Exploration: ai-uml-design-tool

### Current State

- Greenfield: NO source code, NO git repo, NO package manifests at `D:\Moondancer\software1\parcial1`. Only `openspec/` scaffolding and `.atl/skill-registry.md` exist (per sdd-init artifact).
- No existing architecture, patterns, or tests to preserve; every structural decision is open.
- Constraints: university exam project, hard deadline 2 weeks (4 max), scope NON-negotiable — the evaluator requires every capability at least minimally working. Strategy is fixed as **demo mode**: thinnest end-to-end slice touching every requirement, aggressive reuse of existing tools/libraries, nothing built from scratch.
- Product: a collaborative software-development tool for the DESIGN phase — conceptual/data design via UML class diagrams — with AI-assisted editing, code generation, and importers.

#### Two-system distinction (foundational)

- **System A — Tool backend (team-built, ONLINE):** collaborative UML editor, AI interpreter (text + voice), code generator, importers (Architect files, photos). The tool's own AI works WITH internet.
- **System B — Generated backend (ARTIFACT produced by the tool, OFFLINE):** a Spring Boot management backend that must run offline and ship its own offline AI assistant; the mobile-app angle belongs on this side.
- The code generator inside System A is the BRIDGE that emits System B. Codegen templates are the seam and must live outside System A's runtime.

#### Component map — minimum viable (exam demo) vs full/ideal

| # | Component | System | Minimum viable (exam demo) | Full / ideal |
|---|-----------|--------|----------------------------|--------------|
| 1 | UML class-diagram editor (classes, attributes, methods, associations, multiplicities) | A | Canvas on an existing diagram lib; CRUD of model elements; JSON persistence | Full UML conformance, auto-layout, undo/redo, versioning, multi-project |
| 2 | Real-time collaboration | A | 2 users on one diagram with presence, via managed sync service or CRDT lib; naive conflict handling | Full CRDT, cursors, comments, permissions, offline merge |
| 3 | AI text interpreter (INTERPRETER, not generator) | A | Constrained command set → structured model deltas (create class/attribute/method/association with multiplicity); confirm-before-apply; refuses "generate me a design" requests | Multi-turn NLU, disambiguation, undo, hardened guardrails |
| 4 | Voice input | A | Existing STT API → text → same interpreter pipeline as #3 | Streaming ASR, custom UML vocabulary |
| 5 | Code generator → Spring Boot management backend | A→B | Template-driven: model → @Entity classes, relations, repositories, minimal controllers, buildable project; one template set | Layered output (services/DTOs/validation/security), incremental regen, configurable targets |
| 6 | Architect importer | A | Parse the one discovered format → map a subset of constructs into the model | Full format coverage, round-trip |
| 7 | Photo → diagram importer | A | One multimodal-LLM API call: image → structured JSON → model; demo with clean photos | Robustness to handwriting/skew, OCR pipeline, human review loop |
| 8 | Generated backend runs offline | B | Generated app runs locally with embedded/file-based persistence; CRUD works with no network | Offline-first sync, installer/packaging |
| 9 | Offline AI assistant inside generated backend | B | Local small model via local runtime performs a narrow, scripted action set over app data; canned fallback path | Tool-calling agent over the app domain, RAG over data |
| 10 | Mobile app | B | Assumed OUT of exam demo scope; if forced, thin wrapper demonstrating the offline assistant | Native app embedding generated backend + assistant |

Key architectural fact: the **UML diagram model (structured IR) is the single source of truth**. Editor, interpreter, voice, codegen, and both importers are all producers/consumers of that IR. The AI interpreter operates on the MODEL (deltas), never by rendering/redrawing the whole diagram — this is both a requirement nuance and an efficiency property.

### Affected Areas

Greenfield — no existing files are affected. Planned areas for later phases:

- `openspec/changes/ai-uml-design-tool/` — this exploration plus downstream SDD artifacts (proposal, specs, design, tasks)
- Repo root — System A application (editor UI, collaboration, interpreter, codegen, importers), structure defined in design phase
- Separate artifact tree — codegen templates + generated-backend project skeleton (System B); MUST live outside System A runtime
- Note: no git repo yet; repo initialization is a pending decision carried from sdd-init

### Approaches

High-level architecture for System A. No stack selection — concrete frameworks are the design phase's job.

1. **Modular monolith around the canonical diagram model** — one deployable; strict internal modules: diagram-model (IR), editor/collab, ai-interpreter, codegen, importers; modules communicate only through the IR.
   - Pros: minimal ops overhead; easy local demo; few failure points live; modules can be split out later.
   - Cons: boundaries enforced by discipline only; no inherent horizontal-scaling story.
   - Effort: Low-Medium

2. **Microservices per capability** — separate services for editor/collab hub, AI gateway, codegen, importers.
   - Pros: independent scaling per capability; clean deploy boundaries; looks impressive to evaluators.
   - Cons: heavy ops tax (orchestration, networking, service discovery); slower dev loop; many demo failure points; buys nothing at exam scale; eats the deadline.
   - Effort: High

3. **Hexagonal (ports & adapters) modular monolith + background workers** — pure, framework-agnostic domain core = diagram model + operations; adapters for web UI, collab transport, LLM/STT/vision gateways, file importers, template codegen; slow jobs (codegen runs, photo import) run in background workers sharing the codebase. System B is emitted as an output artifact from templates and is itself a small hexagonal app.
   - Pros: core transforms (interpreter ops, codegen) are pure → testable, verifiable, demo-safe; adapters swappable (no provider lock-in for LLM/STT/vision); scales by cloning workers; decomposition optionality keeps a future microservices path open; directly answers "definir bien la arquitectura".
   - Cons: upfront design cost; team must understand ports/adapters; over-engineering risk if taken too far.
   - Effort: Medium

### Recommendation

Direction: **Approach 3** — a hexagonal modular monolith for System A organized around the canonical diagram-model IR, with background workers for slow jobs; System B kept as a template-generated artifact in a separate tree, never part of System A's runtime. Rationale:

- IR-first makes every capability a stateless transform over the model — that is the real scalability lever.
- A pure core makes the interpreter and codegen deterministic, testable, and demo-safe.
- Swappable adapters de-risk dependence on any single external AI provider.
- Microservices (Approach 2) rejected for the exam timeline: ops cost buys nothing at demo scale; module boundaries preserve the option to extract services later (AI gateway and codegen workers are the natural first extraction candidates).

This is a DIRECTION, not a stack — concrete frameworks/libraries remain the design phase's decision.

### Risks

- **Photo → diagram (research-grade, complexity-bound):** recognition of arbitrary diagram photos is an open problem; accuracy unpredictable. Mitigation: delegate entirely to a multimodal API, demo with clean photos, include a human review step. Highest technical risk.
- **Offline AI assistant (research-grade, complexity-bound):** small local models are weak at reliable action/tool execution; target hardware unknown. Mitigation: narrow scripted action set + canned fallback path.
- **Real-time collaboration demo fragility (effort-bound, integration-heavy):** sync bugs surface at the worst moment. Mitigation: managed sync/CRDT lib, rehearsed 2-user demo script.
- **Interpreter misreads during live demo:** mitigation: structured-output schema + confirm-before-apply; the AI MUST refuse "generate me a design" requests (evaluator trap — the AI is an interpreter, not a generator).
- **Generated code doesn't compile:** mitigation: pre-validated template set + one golden sample project kept always buildable.
- **"Architect" format unknown (blocking uncertainty):** importer effort is unbounded until the tool/format is identified — could be trivial parsing or could balloon.
- **Schedule risk dominates:** fixed scope + 2 weeks (4 max). Enforce agreed build order: (1) editor + text interpreter + codegen → (2) voice + basic collaboration → (3) photo import + offline AI. Anything not demoable by the deadline degrades to a stub with a recorded rationale.
- **Two-backend confusion:** letting System B code leak into System A runtime breaks the offline story and the artifact boundary; templates must be data, not code paths.
- **Demo-day internet availability:** System A's AI needs internet; if the evaluation room has none, a recorded-demo fallback is required.

### Open Questions & Assumptions (recorded, NOT asked now)

1. What exactly is the "Architect" tool and its file format/spec? Are sample files available? — blocking for the importer spec.
2. Evaluation rubric: which capabilities are weighted? Live vs recorded demo? Internet available during evaluation?
3. Team size and skill distribution (frontend / AI / backend).
4. Is the mobile app in scope for the exam demo, or can the offline assistant be demonstrated through the generated backend alone? — ASSUMPTION: the latter.
5. What concretely does "the assistant performs actions" mean inside the generated backend (natural-language CRUD? Q&A over data?) — ASSUMPTION: narrow scripted actions over generated entities.
6. Required UML construct subset beyond class/attribute/method/association (inheritance, aggregation, composition, interfaces) — ASSUMPTION: core set + inheritance if cheap.
7. "Management software" scope for the generated backend — ASSUMPTION: entities + repositories + minimal REST CRUD.
8. Voice input language (ASSUMPTION: Spanish) and whether interpreter input language matches.
9. Whether Architect import must be lossless — ASSUMPTION: subset mapping acceptable.
10. Offline persistence expectations for the generated backend — ASSUMPTION: embedded/file-based DB.

### Scalability Considerations (user explicitly cares: "quiero que sea escalable, definir bien la arquitectura")

- IR as single source of truth → every capability is a stateless transform → System A's core can scale horizontally behind a load balancer; only collaboration state is stateful → isolate it in a managed sync/CRDT service, naturally sharded per diagram.
- Slow AI calls (LLM/STT/vision) and codegen runs → async command queue + background workers → request rate decoupled from processing rate; workers scale independently.
- Template/artifact separation → the generated backend evolves independently via versioned templates; zero coupling to tool runtime.
- Future decomposition path: module boundaries allow extracting the AI gateway and codegen workers into services when load demands — scalability as optionality, not premature distribution.
- Per-diagram document-based collaboration bounds contention by diagram size, not user count.

### Ready for Proposal

Yes. The problem is well-structured: two systems, one canonical IR, ten capability components, an agreed demo-mode strategy and build order. The orchestrator should tell the user: exploration complete; recommended direction is a hexagonal modular monolith around the diagram model with a template-generated offline artifact; next phase (propose) will fix the demo slice scope per capability. The identity of the "Architect" tool is the largest unknown and should be clarified before or during spec phase. Stack selection stays deferred to design.
