# Spec: Robust Vision Reader

## Purpose

Extract comprehensive, schema-valid UML diagrams from both hand-drawn sketches (whiteboards, paper doodles) and digital tool exports (draw.io, StarUML, PlantUML, etc.) via multimodal LLMs with high resilience against syntax, reference, and schema anomalies.

## Requirements

### Requirement: Full UML Element Extraction from Diverse Diagram Formats

The system MUST prompt the vision model with instructions and examples covering both informal hand-drawn sketches and formal software exports. The model MUST extract:
- Classes and Interfaces (`classKind: 'class' | 'interface'`, `isAbstract`)
- Class attributes (name, type, visibility)
- Class methods (name, returnType, parameters, visibility)
- Relationships (associations, generalizations, realizations, dependencies)
- Spatial positions approximating original layout

#### Scenario: Hand-drawn whiteboard extraction
- GIVEN a photo of a whiteboard with hand-drawn classes and handwritten names, attributes, and inheritance arrows
- WHEN the vision adapter processes the image
- THEN classes, their attributes, and generalization deltas are extracted and linked correctly.

#### Scenario: Digital tool export extraction
- GIVEN a PNG or JPEG exported from draw.io with 3-compartment boxes, visibility signs (`+`, `-`), and multiplicities
- WHEN the vision adapter processes the image
- THEN classes, members with visibility, and associations with multiplicities are extracted.

### Requirement: Resilient Sanitization and Identifier Normalization

The vision extraction pipeline MUST tolerate markdown codeblock wrappers, leading/trailing prose, and non-UUID identifiers. It MUST map symbolic class references (e.g. referencing a class by name) to resolved UUIDs, and ensure all generated IDs satisfy RFC4122 UUID format.

#### Scenario: Markdown-fenced and non-UUID response
- GIVEN the multimodal LLM returns ````json { "kind": "batch", "id": "batch-1", ... } ```` with class IDs `"c1"`, `"c2"` and association linking `"c1"` to `"c2"`
- WHEN the response is parsed
- THEN the markdown fences are stripped, `"c1"` and `"c2"` are normalized to consistent valid UUIDs across class and association deltas, and `BatchDeltaSchema` validation passes.

### Requirement: Bounded Vision Self-Healing Loop

When extraction results violate schema requirements, the adapter MUST execute a bounded retry (up to 2 attempts) providing a concise digest of validation issues back to the model before declaring failure.

#### Scenario: Model self-corrects on retry
- GIVEN the model's first response produces a schema mismatch
- WHEN the adapter sends a targeted repair prompt with the issue summary
- THEN the model provides a corrected schema-valid BatchDelta.

### Requirement: Cascade Pruning on User Review

In the frontend review modal, when a user drops one or more proposed classes, all dependent member deltas and relationships involving those dropped classes MUST be pruned from the batch delta before committing to `Y.Doc`.

#### Scenario: Dropping a class prunes its relationships
- GIVEN an extracted batch with class A, class B, and an association between A and B
- WHEN the user drops class B in the review modal and approves
- THEN only class A is committed, and the association between A and B is pruned without triggering a `ClassNotFound` error.
