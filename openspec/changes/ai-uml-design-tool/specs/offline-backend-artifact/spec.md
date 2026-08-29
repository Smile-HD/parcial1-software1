# offline-backend-artifact Specification

## Purpose

System B: the Spring Boot backend produced by `spring-codegen`. It MUST run and serve full CRUD on a machine with no network access.

## Requirements

### Requirement: Runs With No Network

The generated backend MUST start and serve requests with networking to external services unavailable. It MUST NOT require any remote dependency at runtime — no cloud database, no license check, no remote AI endpoint.

#### Scenario: Startup with internet disabled

- GIVEN a machine with outbound internet blocked
- WHEN the generated backend is started
- THEN it reaches a ready state and answers a health/CRUD request

#### Scenario: No outbound calls at runtime

- GIVEN the backend is running under outbound-traffic monitoring
- WHEN a full CRUD cycle is executed
- THEN no outbound external network call is observed

### Requirement: Embedded Or File-Based Persistence

The generated backend MUST persist data using an embedded or file-based datastore requiring no separately installed database server. Data MUST survive a restart.

#### Scenario: Data survives restart

- GIVEN a record was created through the API
- WHEN the backend is stopped and restarted
- THEN the record is still retrievable

#### Scenario: First run initializes schema

- GIVEN a clean environment with no existing datastore file
- WHEN the backend starts for the first time
- THEN the schema is created automatically and CRUD works without manual setup

### Requirement: Full CRUD Per Entity

The generated backend MUST expose working create, read (single + list), update and delete operations for every entity derived from the diagram.

#### Scenario: CRUD cycle per entity

- GIVEN entities `Customer` and `Order` were generated
- WHEN a client creates, reads, updates and deletes one record of each
- THEN every operation returns a success status and the final read confirms deletion

#### Scenario: Invalid payload rejected

- GIVEN a create request missing a required field
- WHEN it is submitted
- THEN the backend responds with a client-error status and does not persist a record

### Requirement: Self-Contained Startup Procedure

The generated project MUST include a documented single-command build/run procedure and MUST NOT require manual source edits before first run.

#### Scenario: Fresh operator starts it

- GIVEN a fresh checkout of the generated project and the documented JDK
- WHEN the operator follows the documented command
- THEN the backend builds and starts without editing source files

## Acceptance Criteria

- [ ] Starts and serves CRUD with internet disabled
- [ ] Embedded/file persistence survives restart, no external DB server
- [ ] CRUD verified for every generated entity
- [ ] One documented command from checkout to running

## Cross-Cutting Concerns

- Produced by `spring-codegen`; hosts `offline-ai-assistant`.
- Exercised by the external `mobile-test-client`, which is the proof of functionality.

## Open Questions

- Is the demo machine's JDK version fixed, and is the offline artifact allowed to ship a pre-populated dependency cache?
