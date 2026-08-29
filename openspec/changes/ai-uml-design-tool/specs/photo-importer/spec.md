# photo-importer Specification

## Purpose

Turn a photograph of a hand-drawn or whiteboard class diagram into canonical model elements via a multimodal LLM API, always under human review.

## Requirements

### Requirement: Image To Structured JSON

The system MUST send the uploaded image to a multimodal LLM API and require a schema-validated JSON description of classes, attributes, methods and associations. Free-form prose responses MUST be rejected.

#### Scenario: Clean photo produces valid structure

- GIVEN a clear, well-lit photo of a 3-class diagram
- WHEN the photo is imported
- THEN the API response validates against the extraction schema
- AND 3 candidate classes are proposed with their members

#### Scenario: Schema-invalid response rejected

- GIVEN the API returns unstructured text
- WHEN validation runs
- THEN the import fails with an explicit error
- AND no elements are added to the model

### Requirement: Mandatory Human Review

The system MUST present extracted elements as a reviewable proposal and MUST NOT commit them to the canonical model without explicit user approval. The user MUST be able to edit or drop individual proposed elements before approval.

#### Scenario: User approves after editing

- GIVEN a proposal containing a misread class name `Custmer`
- WHEN the user corrects it to `Customer` and approves
- THEN the corrected element is committed to the model

#### Scenario: User discards the proposal

- GIVEN a low-quality extraction proposal
- WHEN the user discards it
- THEN the diagram is unchanged

### Requirement: Input Quality Constraints

The system MUST document supported input conditions (single diagram per photo, legible text, adequate lighting) and SHOULD warn when the extraction returns low confidence or zero elements.

#### Scenario: Unreadable photo warns instead of inventing

- GIVEN a blurry photo where no class is legible
- WHEN the import runs
- THEN the system reports that no elements could be extracted
- AND it MUST NOT fabricate placeholder classes

### Requirement: Supported Upload Formats

The system MUST accept common raster formats (PNG, JPEG) and reject unsupported file types before calling the API.

#### Scenario: Unsupported file rejected locally

- GIVEN the user uploads a PDF
- WHEN the upload is validated
- THEN it is rejected with a supported-format message
- AND no API call is made

## Acceptance Criteria

- [ ] Golden clean photo extracts a correct 3-class diagram end-to-end
- [ ] Nothing enters the model without human approval
- [ ] Invalid/unreadable input degrades with a message, never fabrication
- [ ] Format validation happens before the paid API call

## Cross-Cutting Concerns

- Shares the review-then-apply discipline of `ai-text-interpreter`.
- Commits deltas into the `diagram-editor` canonical model.
- Requires internet; a bundled golden photo result is the demo fallback.

## Open Questions

- Which multimodal provider, and is its cost/quota acceptable for repeated demo runs?
