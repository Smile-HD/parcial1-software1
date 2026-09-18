# Design: Robust Vision Reader

## Architecture Context

`OpenAiVision` implements `VisionPort` (`packages/core/src/ports.ts`) and is invoked asynchronously by `apps/api/src/photo-import.ts`. The resulting `BatchDelta` is retrieved by `apps/web/src/photo/ImportPhotoButton.tsx` and reviewed in `PhotoReviewModal.tsx` before being committed to `Y.Doc`.

## Key Design Decisions

### D1: Single Vision Adapter with Internal Resilient Normalizer
Instead of a separate pipeline, encapsulate the sanitization, reference resolution, and ID repair inside `OpenAiVision` (and shared utility functions in `packages/adapters-ai/src/vision.ts`).
- `cleanAndExtractJson(raw: string)`: removes ```json ... ``` codeblocks, comments, and finds outermost `{ ... }`.
- `resolveClassReferences(batch: unknown)`: resolves any class name references in `classId`, `sourceClassId`, `targetClassId`, `subClassId`, `superClassId`, etc., to the class's identifier.
- `repairModelIdentifiers(batch)`: re-uses the established memoized UUID repair function from `@app/adapters-ai`.
- Position assignment: calculates automatic grid positions `(100 + i * 250, 120)` if the model returns missing or zeroed positions.

### D2: Bounded Self-Healing Retry
If `cleanAndExtractJson` or `BatchDeltaSchema.safeParse` fails after ID repair, send a repair message back into the conversation with the model:
- Messages: original system + user image message, followed by assistant response, followed by user repair prompt:
  `"Your previous extraction failed schema validation: <digest>. Return ONLY the corrected JSON object matching the BatchDelta schema."`
- Maximum 2 attempts total (1 initial + 1 repair attempt).

### D3: Safe Cascade Pruning in Review Modal
In `apps/web/src/photo/ImportPhotoButton.tsx`:
```typescript
const visibleClassIds = new Set(state.classes.filter(c => !c.dropped).map(c => c.classId));
```
When building `filteredDeltas`:
- `class create`: kept if in `visibleClassIds`
- `member`: kept if `visibleClassIds.has(delta.classId)`
- `association`: kept if `visibleClassIds.has(delta.sourceClassId)` and `visibleClassIds.has(delta.targetClassId)`
- `generalization`: kept if `visibleClassIds.has(delta.subClassId)` and `visibleClassIds.has(delta.superClassId)`
- `realization`: kept if `visibleClassIds.has(delta.clientClassId)` and `visibleClassIds.has(delta.supplierInterfaceId)`
- `dependency`: kept if `visibleClassIds.has(delta.clientClassId)` and `visibleClassIds.has(delta.supplierClassId)`
- `naryAssociation`: kept if all `memberEnds` belong to `visibleClassIds` and length >= 3.
