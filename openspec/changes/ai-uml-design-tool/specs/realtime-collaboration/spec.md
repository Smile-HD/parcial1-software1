# realtime-collaboration Specification

## Purpose

Allow two users to edit one diagram at the same time with visible presence and naive conflict handling, using a managed sync/CRDT library rather than hand-rolled merge logic.

## Requirements

### Requirement: Shared Editing Session

The system MUST allow at least two concurrent users to join the same diagram and see each other's committed changes without a manual refresh. Propagation SHOULD complete within 2 seconds under demo conditions.

#### Scenario: Second user sees a change

- GIVEN users A and B have the same diagram open
- WHEN A creates class `Invoice`
- THEN `Invoice` appears in B's canvas without B reloading

#### Scenario: Late joiner receives current state

- GIVEN A has already added 3 classes
- WHEN B joins the session
- THEN B's canvas renders the full current model, not an empty diagram

### Requirement: Presence Indication

The system MUST show which other users are currently connected to the diagram.

#### Scenario: Presence appears and disappears

- GIVEN A is alone in the diagram
- WHEN B joins and later disconnects
- THEN A sees B listed as present after the join
- AND A no longer sees B after the disconnect

### Requirement: Naive Conflict Handling

The system MUST resolve concurrent edits deterministically without corrupting the model. Last-write-wins per element attribute is acceptable. The system MUST NOT require manual merge resolution from the user.

#### Scenario: Concurrent edit of the same attribute

- GIVEN A and B both rename attribute `total` on class `Order`
- WHEN both edits are committed within the same second
- THEN both clients converge on one identical value
- AND the model remains schema-valid

#### Scenario: Concurrent edits on different classes both survive

- GIVEN A edits class `Order` and B edits class `Customer` simultaneously
- WHEN both edits propagate
- THEN both changes are present in both clients

### Requirement: Reconnection Recovery

The system SHOULD reconcile a client's state after a transient disconnect, without requiring the user to lose or manually re-enter work.

#### Scenario: Client reconnects after network drop

- GIVEN B loses connectivity for 10 seconds while A keeps editing
- WHEN B reconnects
- THEN B's canvas converges to the shared current state

## Acceptance Criteria

- [ ] Two browsers, one diagram, changes visible both ways
- [ ] Presence list accurate on join and leave
- [ ] Simultaneous conflicting edit converges, no corrupt model
- [ ] Reconnect converges without manual intervention

## Cross-Cutting Concerns

- Synchronizes the `diagram-editor` canonical model; sync transport MUST NOT become a second source of truth.
- AI-applied deltas propagate through this same channel.

## Open Questions

- Does demo day have reliable internet for a hosted sync service, or must sync run on LAN?
