# spring-codegen Specification

## Purpose

The bridge from System A to System B: transform the canonical diagram model into a buildable Spring Boot backend using data-driven templates. Templates are data, never runtime code of System A.

## Requirements

### Requirement: Backend-Only Generation

The system MUST generate backend artifacts only — entities, relation mappings, repositories, and minimal controllers plus build/config files. The system MUST NOT generate any frontend or mobile client.

#### Scenario: Generated output contains no frontend

- GIVEN a diagram with 3 classes
- WHEN generation runs
- THEN the output tree contains only backend sources, resources and a build file
- AND no UI, template-rendering or client-app directory is emitted

### Requirement: Entity Generation From Classes

The system MUST emit one JPA `@Entity` per UML class, with a generated identifier and one persistent field per attribute, mapping UML types to Java/JPA types via a documented mapping table.

#### Scenario: Class becomes entity

- GIVEN class `Product` with attributes `name: String` and `price: BigDecimal`
- WHEN generation runs
- THEN a `Product` entity exists with an id plus both typed fields

#### Scenario: Unknown type mapping is reported

- GIVEN an attribute whose declared type has no mapping entry
- WHEN generation runs
- THEN generation reports the unmapped type as a warning with the element name
- AND either falls back to `String` or fails explicitly per configured policy

### Requirement: Relation Mapping From Associations

The system MUST translate associations and multiplicities into JPA relationship annotations: `1`↔`0..*` to `@OneToMany`/`@ManyToOne`, `0..*`↔`0..*` to `@ManyToMany`, `1`↔`1`/`0..1` to `@OneToOne`.

#### Scenario: One-to-many mapped correctly

- GIVEN `Customer 1 —— 0..* Order`
- WHEN generation runs
- THEN `Customer` holds a `@OneToMany` collection of `Order`
- AND `Order` holds the owning `@ManyToOne` reference

#### Scenario: Association with a missing endpoint is skipped

- GIVEN an association referencing a class absent from the model
- WHEN generation runs
- THEN the association is skipped with a reported warning
- AND the remaining generation still completes

### Requirement: Repositories And Minimal Controllers

The system MUST emit one Spring Data repository per entity and one REST controller per entity exposing create, read (single + list), update and delete.

#### Scenario: CRUD endpoints exist per entity

- GIVEN entity `Product` was generated
- WHEN the generated backend starts
- THEN `POST`, `GET` (single and list), `PUT` and `DELETE` endpoints for products respond

### Requirement: Golden Sample Always Builds

The repository MUST contain a golden reference diagram whose generated project compiles and starts. CI or a documented local script MUST verify this on every template change; a template change that breaks the golden build MUST be treated as a failure.

#### Scenario: Golden build verified

- GIVEN the golden reference diagram
- WHEN generation runs and the generated project is built and started
- THEN the build succeeds and the application reaches a ready state

#### Scenario: Template regression fails loudly

- GIVEN a template edit that produces uncompilable output
- WHEN the golden check runs
- THEN the check fails and identifies the offending template

## Acceptance Criteria

- [ ] Entities, relations, repositories, controllers generated from the model
- [ ] Type and multiplicity mapping tables documented
- [ ] Golden sample builds, starts, serves CRUD
- [ ] Zero frontend artifacts in output

## Cross-Cutting Concerns

- Consumes only the `diagram-editor` canonical model.
- Produces `offline-backend-artifact`; must leave room for the `offline-ai-assistant` module.
- `mobile-test-client` is external and consumes the generated API contract.

## Open Questions

- Is Maven or Gradle expected by the rubric for the generated project?
