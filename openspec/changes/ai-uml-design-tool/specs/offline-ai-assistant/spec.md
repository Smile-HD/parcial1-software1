# offline-ai-assistant Specification

## Purpose

The AI assistant that ships inside System B (the generated backend). It runs entirely locally, executes a narrow set of scripted actions against the generated CRUD domain, and degrades to a canned response when it cannot map a request.

## Requirements

### Requirement: Fully Local Inference

The assistant MUST perform inference using a locally hosted small model bundled with or installed alongside the generated backend. It MUST NOT call any remote AI endpoint.

#### Scenario: Assistant answers offline

- GIVEN the generated backend is running with outbound internet blocked
- WHEN a client sends an assistant request
- THEN a response is returned
- AND no outbound external network call is observed

#### Scenario: Model unavailable degrades, not crashes

- GIVEN the local model fails to load
- WHEN a client sends an assistant request
- THEN the backend returns an explicit unavailable response
- AND CRUD endpoints keep working normally

### Requirement: Narrow Scripted Action Set

The assistant MUST support only a documented, bounded set of scripted actions mapped to existing CRUD operations (for example: list records of an entity, count records, create a record from named fields). It MUST NOT execute arbitrary generated queries or code.

#### Scenario: Scripted list action executes

- GIVEN entity `Product` has 3 records
- WHEN the user asks the assistant to list products
- THEN the assistant invokes the list action and returns the 3 records

#### Scenario: Arbitrary execution refused

- GIVEN the user asks the assistant to run a raw database statement
- WHEN the request is processed
- THEN the assistant refuses
- AND no datastore mutation occurs

### Requirement: Canned Fallback Response

When a request does not map to a supported action with sufficient confidence, the assistant MUST return a canned response listing what it can do. It MUST NOT guess an action.

#### Scenario: Unmappable request falls back

- GIVEN the user asks an open-ended question outside the action set
- WHEN the assistant processes it
- THEN the canned capability response is returned
- AND no action is executed

### Requirement: Action Auditability

Every executed assistant action SHOULD be recorded locally with timestamp, action name and outcome, so demo behavior is explainable.

#### Scenario: Executed action is logged

- GIVEN the assistant executes a create action
- WHEN the action completes
- THEN a local log entry records the action name and its result

## Acceptance Criteria

- [ ] Assistant responds with internet disabled, no remote calls
- [ ] Every documented scripted action executes against generated CRUD
- [ ] Unmapped requests return the canned fallback, never a guessed action
- [ ] Assistant failure never breaks backend CRUD

## Cross-Cutting Concerns

- Hosted inside `offline-backend-artifact`; must not compromise its offline guarantee.
- Emitted by `spring-codegen` as part of the generated backend module.
- Exercised by the external `mobile-test-client`.

## Open Questions

- Which local model and runtime fit the demo machine's RAM/CPU budget, and is the model file distributed with the generated project or installed separately?
