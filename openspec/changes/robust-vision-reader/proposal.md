# Proposal: Robust Vision Reader

## Intent

The current diagram photo/image import pipeline is fragile and limited in production. When users provide hand-drawn whiteboard doodles, paper sketches, or screenshots/exports from diagramming tools (draw.io, StarUML, PlantUML, Enterprise Architect, Lucidchart), extraction frequently fails or loses all relationships and members.

Specifically:
1. The multimodal system prompt in `OpenAiVision` explicitly instructed the LLM to extract *only* class create operations, omitting attributes, methods, associations, generalizations (inheritance), realizations (interfaces), and dependencies.
2. The response parsing is brittle: markdown codeblocks (````json ... ````) or preambles throw JSON parse errors, and non-UUID identifiers (such as `"c1"` or class names) are rejected by `BatchDeltaSchema` because `repairModelIdentifiers` and reference resolution were not applied.
3. Lack of bounded self-healing retry on vision schema errors.
4. When users drop a class in the web review modal, associated members and relations referencing that dropped class are not pruned in cascade, causing `ClassNotFound` failures when committing to `Y.Doc`.

This change makes the vision reader robust across both sketches/doodles and digital tool diagrams, supports full UML element extraction, implements resilient JSON sanitization and reference repair, and ensures cascade pruning during review.

## Scope

### In Scope
- **Expanded Vision Prompting**: Provide explicit instructions and examples for extracting classes, interfaces, attributes, methods, associations, generalizations, realizations, and dependencies from both hand-drawn doodles and software exports.
- **Resilient Parsing & Normalization**:
  - Strip markdown code fences (````json ... ````) and extract root JSON objects.
  - Map class name references in relationships to their resolved class UUIDs.
  - Deep normalize and regenerate UUIDs using `repairModelIdentifiers`.
  - Fallback layout positioning for classes lacking coordinates.
- **Vision Self-Healing Loop**: Bounded retry (up to 2 attempts) passing Zod validation digests back to the vision model when initial output violates schema.
- **Frontend Review & Cascade Pruning**:
  - Update `ImportPhotoButton.tsx` to cascade-prune members and relationships when a class is dropped.
  - Enhance `PhotoReviewModal.tsx` to show detected members and connections for reviewed classes.
- **Testing**: Comprehensive unit tests in `@app/adapters-ai` and `@app/web`.

### Out of Scope
- Modifying the underlying core delta schema (`BatchDeltaSchema` and `DeltaSchema` are already fully expressive).
- Introducing local OCR/CV models (cloud multimodal API remains the source of truth per System A architecture).

## Capabilities

### New Capabilities
- `robust-vision-reader`: Multimodal extraction of complete UML class diagrams (classes, members, relationships) from both sketches and digital diagrams, resilient JSON/UUID repair, vision retry loop, and safe cascade deletion in the review modal.
