# OpenSpec Change: Robust Vision Reader

This change hardens the image import feature to accurately extract UML diagrams from:
1. **Hand-drawn sketches & whiteboards**: handles loose lines, handwritten text, and hand-drawn arrowheads.
2. **Software-exported diagrams**: handles 3-compartment class boxes, visibility notation (`+`, `-`, `#`, `~`), types, methods, and relationship semantics from draw.io, StarUML, PlantUML, Enterprise Architect, Lucidchart, and Miro.

### Key Deliverables
- Enriched multimodal prompt with full UML structural coverage.
- Resilient JSON extraction and markdown fence stripping.
- Symbolic name-to-UUID resolution and UUID repair (`repairModelIdentifiers`).
- Bounded retry loop for schema self-correction.
- Frontend review cascade filtering to prevent orphan relationships when classes are dropped.
