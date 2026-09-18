# Tasks: Robust Vision Reader

## Phase 1: Adapters AI — Vision Resilience & Normalization

- [x] 1.1 TDD RED `packages/adapters-ai/src/vision.test.ts`: Test parsing of markdown-fenced responses (````json ... ````).
- [x] 1.2 TDD RED `packages/adapters-ai/src/vision.test.ts`: Test non-UUID placeholder IDs repair and reference normalization (class names as relation endpoints).
- [x] 1.3 TDD RED `packages/adapters-ai/src/vision.test.ts`: Test full extraction including members and relationships.
- [x] 1.4 TDD RED `packages/adapters-ai/src/vision.test.ts`: Test self-healing retry on initial invalid response.
- [x] 1.5 TDD GREEN `packages/adapters-ai/src/vision.ts`: Implement `cleanAndExtractJson`, reference resolution, ID repair, default positioning, prompt expansion (sketches + digital software diagrams), and bounded retry loop.

## Phase 2: Web Client — Cascade Deletion & Review

- [x] 2.1 TDD RED `apps/web/src/photo/ImportPhotoButton.test.tsx`: Test that dropping a class in the review modal cascades and prunes dependent members and relationships without throwing `ClassNotFound`.
- [x] 2.2 TDD GREEN `apps/web/src/photo/ImportPhotoButton.tsx`: Implement cascade filtering for members and all relationship types when classes are dropped.
- [x] 2.3 `apps/web/src/photo/PhotoReviewModal.tsx`: Render summary badges/counts of attributes, methods, and relationships detected for each class.

## Phase 3: Verification

- [x] 3.1 Run tests: `pnpm --filter @app/adapters-ai test`
- [x] 3.2 Run tests: `pnpm --filter @app/web test src/photo`
- [x] 3.3 Verify type-checking: `pnpm --filter @app/adapters-ai test` and `pnpm --filter @app/web test src/photo`
