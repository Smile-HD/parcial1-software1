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

The system MUST support directed and undirected associations between two classes, each endpoint carrying a UML 2.5.1-compliant multiplicity: the legacy set `1`, `0..1`, `1..*`, `0..*`, plus `*` (many), `0`, plain integers (`2`, `3`), and arbitrary ranges `m..n` / `m..*` (non-negative integers). Non-numeric garbage (e.g. `abc`, `1..abc`) MUST be rejected with the previous value retained.

> MODIFIED 2026-08-31 (UML 2.5.1 compliance amendment): the original bounded four-value set and the `3..7` rejection scenario are superseded — `3..7` is valid UML and MUST be accepted.

#### Scenario: Create a one-to-many association

- GIVEN classes `Customer` and `Order`
- WHEN the user links them with multiplicities `1` and `0..*`
- THEN the association and both multiplicities are stored in the model
- AND the multiplicities render at the correct endpoints

#### Scenario: Arbitrary range accepted

- GIVEN an association being edited
- WHEN the user enters multiplicity `3..7`
- THEN the value is accepted and stored
- AND it renders at the edited endpoint

#### Scenario: Reject a non-numeric multiplicity

- GIVEN an association being edited
- WHEN the user enters multiplicity `abc`
- THEN the value is rejected and the previous multiplicity is retained

### Requirement: Member Adornments

The system MUST support UML member adornments on attributes and methods: visibility `+` (public, default), `-` (private), `#` (protected), `~` (package); static scope; derived marking; and an optional multiplicity on attributes. Existing diagrams without these fields MUST remain valid (backward compatibility).

#### Scenario: Visibility renders and persists

- GIVEN a class `Product`
- WHEN the user sets attribute `price` visibility to `-` (private)
- THEN the member renders as `- price: BigDecimal`
- AND the visibility survives save/reload

#### Scenario: Static and derived markers render

- GIVEN a class with a static method `count()` and derived attribute `/total`
- WHEN the diagram renders
- THEN the static member name is underlined
- AND the derived attribute name is prefixed with `/`

### Requirement: Aggregation and Composition

The system MUST distinguish plain association from shared aggregation (hollow diamond on the container end) and composite aggregation (filled diamond on the container end), and MUST support optional association names and role names per end.

#### Scenario: Composition renders with filled diamond

- GIVEN classes `Order` and `OrderLine`
- WHEN the user creates an aggregation `composite` with `Order` as the container
- THEN the association stores `aggregation: composite`
- AND a filled diamond renders on the `Order` end

#### Scenario: Association name and roles persist

- GIVEN an association between `Customer` and `Order`
- WHEN the user names it `places` with role `buyer` on the customer end
- THEN the name and role labels persist and render

### Requirement: Generalization

The system MUST support generalization (inheritance) between two existing classes, rendered as a solid line with a hollow triangle on the superclass end. The system MUST NOT allow cycles, duplicate edges, or edges referencing missing classes; deleting a class MUST remove its generalization edges.

#### Scenario: Subclass created

- GIVEN classes `Item` and `Product`
- WHEN the user makes `Product` a subclass of `Item`
- THEN a generalization edge with a hollow triangle renders toward `Item`
- AND the edge survives save/reload

#### Scenario: Cycle rejected

- GIVEN `Product` is already a subclass of `Item`
- WHEN the user tries to make `Item` a subclass of `Product`
- THEN the delta is rejected with a validation error
- AND the model is unchanged

### Requirement: Interfaces, Abstract Classes, Realization and Dependency

The system MUST support interfaces (`«interface»` header, dashed border), abstract classes (italic name), realization edges (dashed line, hollow triangle, supplier MUST be an interface), and dependency edges (dashed line, open arrow, no multiplicity).

#### Scenario: Interface with realizer

- GIVEN interface `Repository` and class `Order`
- WHEN the user creates a realization from `Order` to `Repository`
- THEN the edge renders dashed with a hollow triangle on `Repository`
- AND `Order` shows a realization entry

#### Scenario: Realization to non-interface rejected

- GIVEN two plain classes `A` and `B`
- WHEN the user creates a realization from `A` to `B`
- THEN the delta is rejected (supplier must be an interface)

### Requirement: N-ary Associations

The system MUST support n-ary associations connecting three or more classes through a central diamond node, with per-end multiplicities and optional roles. Deleting a member class MUST remove it from the association, and an association left with fewer than three ends MUST be deleted.

#### Scenario: Ternary association created

- GIVEN classes `Supplier`, `Part` and `Project`
- WHEN the user creates an n-ary association connecting all three with per-end multiplicities
- THEN a diamond node renders with one edge per member
- AND each end stores its own multiplicity

#### Scenario: Member deletion prunes the n-ary

- GIVEN the ternary association above
- WHEN the user deletes class `Project`
- THEN `Project` is removed from the association's member ends
- AND with only two ends left the whole n-ary association is removed

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
- [ ] All four legacy multiplicities render and persist, plus `*`, `0`, integers and arbitrary ranges
- [ ] Visibility, static, derived and attribute multiplicity render and persist
- [ ] Aggregation/composition diamonds, association names and roles render at the correct ends
- [ ] Generalization edges render with cycle invariant enforced
- [ ] Interfaces/abstract render per UML notation; realization/dependency edges render dashed
- [ ] N-ary associations render via diamond node with per-end multiplicities
- [ ] Save → reload round-trip is lossless across ALL new fields
- [ ] All mutations flow through the canonical model, verified by test

## Cross-Cutting Concerns

- `ai-text-interpreter`, `ea-xmi-importer`, `photo-importer` all emit deltas against this model.
- `realtime-collaboration` synchronizes this model between users.
- `spring-codegen` consumes this model as its only input.

## Open Questions

- Are visual coordinates part of the persisted contract or presentation-only metadata?
