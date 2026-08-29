# diagram-editor Specification

## Purpose

Canvas-based UML class-diagram editor for System A. Owns the canonical diagram model (IR) that every other capability reads from or writes to.

## Requirements

### Requirement: Canonical Diagram Model

The system MUST maintain a single canonical in-memory diagram model (IR) as the sole source of truth for classes, attributes, methods, associations and multiplicities. All mutations — manual, AI, or importer — MUST be expressed as deltas against this model.

#### Scenario: Mutation from any source converges on one model

- GIVEN a diagram open in the editor
- WHEN a mutation arrives from the canvas, the AI interpreter, or an importer
- THEN the mutation is applied to the canonical model
- AND the canvas re-renders from that model, not from adapter-local state

#### Scenario: Delta rejected when it violates model invariants

- GIVEN a canonical model containing class `Order`
- WHEN a delta attempts to add a second class named `Order`
- THEN the delta is rejected with a validation error
- AND the model remains unchanged

### Requirement: Class Element CRUD

The system MUST allow users to create, rename, reposition and delete UML classes on the canvas.

#### Scenario: Create and delete a class

- GIVEN an empty diagram
- WHEN the user creates a class named `Customer` and then deletes it
- THEN `Customer` appears on the canvas after creation
- AND after deletion neither the class nor its members exist in the model

#### Scenario: Deleting a class removes its associations

- GIVEN classes `Order` and `Customer` linked by an association
- WHEN the user deletes `Customer`
- THEN the association is removed from the model
- AND no dangling endpoint reference remains

### Requirement: Attributes and Methods

The system MUST allow adding, editing and removing attributes (name + type) and methods (name + return type + parameter list) on any class.

#### Scenario: Add a typed attribute

- GIVEN a class `Product`
- WHEN the user adds attribute `price: BigDecimal`
- THEN the attribute is persisted in the model with its declared type
- AND it renders inside the class box

#### Scenario: Reject an empty member name

- GIVEN a class `Product`
- WHEN the user attempts to add an attribute with a blank name
- THEN the edit is rejected with a validation message

### Requirement: Associations and Multiplicities

The system MUST support directed and undirected associations between two classes, each endpoint carrying a multiplicity from the set `1`, `0..1`, `1..*`, `0..*`.

#### Scenario: Create a one-to-many association

- GIVEN classes `Customer` and `Order`
- WHEN the user links them with multiplicities `1` and `0..*`
- THEN the association and both multiplicities are stored in the model
- AND the multiplicities render at the correct endpoints

#### Scenario: Reject an unsupported multiplicity

- GIVEN an association being edited
- WHEN the user enters multiplicity `3..7`
- THEN the value is rejected and the previous multiplicity is retained

### Requirement: JSON Persistence

The system MUST persist and reload the canonical model as JSON. A reloaded diagram MUST be structurally equivalent to the saved one.

#### Scenario: Round-trip a diagram

- GIVEN a diagram with 3 classes, 5 attributes and 2 associations
- WHEN the diagram is saved and then reloaded in a new session
- THEN all classes, members, associations, multiplicities and positions match the saved state

#### Scenario: Reject a corrupt document

- GIVEN a stored JSON document that fails schema validation
- WHEN the user attempts to load it
- THEN loading fails with an explicit error
- AND no partially loaded diagram is presented as valid

## Acceptance Criteria

- [ ] Create/edit/delete works for classes, attributes, methods, associations
- [ ] All four supported multiplicities render and persist
- [ ] Save → reload round-trip is lossless
- [ ] All mutations flow through the canonical model, verified by test

## Cross-Cutting Concerns

- `ai-text-interpreter`, `ea-xmi-importer`, `photo-importer` all emit deltas against this model.
- `realtime-collaboration` synchronizes this model between users.
- `spring-codegen` consumes this model as its only input.

## Open Questions

- Are visual coordinates part of the persisted contract or presentation-only metadata?
