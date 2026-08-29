# ai-text-interpreter Specification

## Purpose

Translate constrained natural-language commands into structured deltas against the canonical diagram model. This capability is an INTERPRETER of user intent, not a design generator.

## Requirements

### Requirement: Command To Structured Delta

The system MUST convert an accepted command into a schema-validated structured delta (operation, target element, parameters). The system MUST NOT apply free-form model text produced by the AI directly to the model.

#### Scenario: Add a class by command

- GIVEN an open diagram
- WHEN the user submits "add a class Invoice with attribute total of type decimal"
- THEN the interpreter emits a delta containing one class creation and one attribute addition
- AND the delta validates against the delta schema

#### Scenario: Malformed AI output is discarded

- GIVEN the AI returns output that fails delta-schema validation
- WHEN the interpreter processes that output
- THEN no model mutation occurs
- AND the user is told the command could not be interpreted

### Requirement: Confirm Before Apply

The system MUST present the interpreted delta to the user for explicit confirmation before mutating the model. The system MUST NOT auto-apply interpreted deltas.

#### Scenario: User confirms

- GIVEN a pending interpreted delta adding class `Invoice`
- WHEN the user confirms
- THEN the delta is applied and visible on the canvas

#### Scenario: User rejects

- GIVEN a pending interpreted delta
- WHEN the user rejects it
- THEN the model is unchanged and the pending delta is discarded

### Requirement: Refuse Whole-Design Generation

The system MUST refuse requests to invent a complete design (for example "generate me a design for a hospital system") and MUST respond explaining that it edits an existing model on explicit instruction. This is an intentional, tested behavior.

#### Scenario: Generation request refused

- GIVEN an empty or populated diagram
- WHEN the user submits "generate me a full design for a library system"
- THEN no delta is produced and no model mutation occurs
- AND the response states the tool interprets edit commands rather than generating designs

#### Scenario: Scoped edit still accepted after a refusal

- GIVEN the previous request was refused
- WHEN the user submits "add class Book with attribute isbn: String"
- THEN the command is interpreted normally and a delta is offered for confirmation

### Requirement: Supported Command Vocabulary

The system MUST document and support a bounded command set covering: add/rename/delete class, add/remove attribute, add/remove method, add/remove association with multiplicities. Out-of-vocabulary commands MUST be rejected with a clear message rather than guessed.

#### Scenario: Out-of-vocabulary command

- GIVEN an open diagram
- WHEN the user submits "make the diagram prettier"
- THEN the command is rejected as unsupported
- AND the supported command categories are surfaced to the user

## Acceptance Criteria

- [ ] Every supported command category produces a valid delta
- [ ] No delta reaches the model without user confirmation
- [ ] Whole-design generation refusal covered by an automated test
- [ ] Invalid AI output never mutates the model

## Cross-Cutting Concerns

- Emits deltas consumed by `diagram-editor`; applied deltas propagate via `realtime-collaboration`.
- `voice-input` reuses this exact pipeline after transcription.

## Open Questions

- Does the rubric reward multi-command batches, or is single-command scope sufficient?
