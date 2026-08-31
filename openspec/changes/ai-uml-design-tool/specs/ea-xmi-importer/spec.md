# ea-xmi-importer Specification

## Purpose

Import class-diagram structure from Enterprise Architect XMI 2.1 exports into the canonical diagram model, mapping the supported subset and ignoring proprietary extensions.

## Requirements

### Requirement: XMI 2.1 Structural Parsing

The system MUST parse Enterprise Architect XMI 2.1 files and extract classes, attributes, operations and associations with multiplicities. Unsupported XMI versions MUST be rejected with an explicit message rather than partially parsed.

#### Scenario: Real EA sample imports

- GIVEN a real Enterprise Architect XMI 2.1 export with 5 classes and 4 associations
- WHEN the file is imported
- THEN all 5 classes with their attributes and operations exist in the model
- AND all 4 associations exist with their multiplicities

#### Scenario: Wrong version rejected

- GIVEN an XMI file declaring an unsupported version
- WHEN the user imports it
- THEN the import is rejected with a message naming the supported version
- AND the current diagram is unchanged

### Requirement: Ignore Proprietary Extensions

The system MUST ignore Enterprise Architect proprietary tagged values and vendor extension blocks. Their presence MUST NOT abort the import.

#### Scenario: Tagged values skipped silently

- GIVEN an XMI file containing EA-specific tagged values and extension elements
- WHEN the file is imported
- THEN the supported structural elements import successfully
- AND no proprietary metadata leaks into the canonical model

### Requirement: UML 2.5 Element Mapping (added 2026-08-31)

Beyond classes, members and binary associations, the importer MUST map the elements added by the compliance series when present in the EA export: member visibility (from UML notation on member names), aggregation kinds (`aggregation="shared"|"composite"` on memberEnd), generalization elements, interface/abstract classifiers, realization and dependency abstractions, n-ary associations (EA ternary+ diamonds), and non-legacy multiplicities (`*`, integers, ranges). Unmappable-but-valid UML 2.5.1 constructs MUST be reported as warnings, never silently dropped.

#### Scenario: Generalization and composition import

- GIVEN an EA XMI 2.1 export with a generalization `Product→Item` and a composite association
- WHEN the file is imported
- THEN the model contains the generalization edge and the composition with its filled-diamond end
- AND both survive the review-then-apply gate

#### Scenario: Arbitrary multiplicity imports

- GIVEN an EA export carrying multiplicity `3..7` on an association end
- WHEN the file is imported
- THEN the model stores `3..7` exactly (UML 2.5.1 ranges are valid)

### Requirement: Auto-Layout Of Imported Elements

Because XMI may carry no usable geometry, the system MUST assign non-overlapping canvas positions to imported classes so the result is immediately readable.

#### Scenario: Imported classes are laid out

- GIVEN an XMI file with no diagram geometry
- WHEN the import completes
- THEN every imported class has a position
- AND no two class boxes overlap

### Requirement: Import Failure Atomicity

A failed import MUST NOT leave the diagram in a partially imported state. The system MUST either commit the whole import or none of it.

#### Scenario: Malformed XML aborts cleanly

- GIVEN a truncated or malformed XMI file
- WHEN the user imports it
- THEN the import fails with a parse error
- AND the pre-import diagram state is intact

## Acceptance Criteria

- [ ] Real EA XMI 2.1 sample imports with classes, members, associations, multiplicities
- [ ] Proprietary tagged values ignored without failure
- [ ] Auto-layout produces a readable, non-overlapping diagram
- [ ] Failed import is atomic

## Cross-Cutting Concerns

- Emits deltas into the `diagram-editor` canonical model; imported models must be codegen-ready.
- Large imports propagate through `realtime-collaboration` as a single batch.

## Open Questions

- If the real export turns out to be `.qea` (SQLite) instead of XMI, is the Plan B reader in scope?
