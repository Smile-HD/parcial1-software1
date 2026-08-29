# voice-input Specification

## Purpose

Let the user issue diagram edit commands by speech. Voice is a transcription front-end only: it produces text and hands it to the existing `ai-text-interpreter` pipeline.

## Requirements

### Requirement: Speech To Text Via Existing API

The system MUST transcribe recorded speech to text using an existing speech-to-text API. The system MUST NOT implement its own acoustic model.

#### Scenario: Successful transcription

- GIVEN the user holds the record control and says "add class Invoice"
- WHEN recording stops
- THEN the transcript "add class Invoice" is displayed to the user

#### Scenario: STT service unavailable

- GIVEN the speech-to-text API is unreachable
- WHEN the user attempts a voice command
- THEN the failure is reported explicitly
- AND the user is directed to the text command input as fallback

### Requirement: Shared Interpreter Pipeline

Transcribed text MUST be routed through the same interpreter, delta schema, and confirm-before-apply flow as typed commands. Voice MUST NOT have a privileged path that bypasses confirmation.

#### Scenario: Voice command requires confirmation

- GIVEN a transcript "add class Invoice"
- WHEN the interpreter produces a delta
- THEN the delta is shown for confirmation before any model mutation

#### Scenario: Voice generation request refused

- GIVEN the user says "generate me a full design for a hospital"
- WHEN the transcript reaches the interpreter
- THEN the request is refused exactly as with typed input

### Requirement: Transcript Correction

The system SHOULD let the user edit the transcript before interpretation, so misrecognition does not force re-recording.

#### Scenario: User corrects a misheard class name

- GIVEN the transcript reads "add class Involve"
- WHEN the user edits it to "add class Invoice" and submits
- THEN interpretation runs on the corrected text

## Acceptance Criteria

- [ ] Voice command produces a visible transcript
- [ ] Transcript flows through the identical interpreter + confirmation path
- [ ] STT outage degrades to text input with a clear message
- [ ] Editable transcript before submit

## Cross-Cutting Concerns

- Fully dependent on `ai-text-interpreter`; adds no new model-mutation surface.
- Requires internet (System A is online by design).

## Open Questions

- Confirm Spanish as the primary recognition language, and whether English commands must also work on demo day.
