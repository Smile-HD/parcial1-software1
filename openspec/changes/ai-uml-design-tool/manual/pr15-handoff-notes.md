# PR 15 — XMI 2.1 Importer: Handoff & Review Notes

> **Estado**: rama `feature/ai-uml-design-tool-pr15` con cambios sin commitear.
> Tests del adapter verdes. NO se levantó la stack ni se probó en la web.
> Esta nota es para revisar y decidir en otra PC.

## Resumen

PR 15 (XMI 2.1 importer) está implementado end-to-end: adapter (`packages/adapters-import/src/xmi21.ts`), ruta API (`apps/api/src/xmi-import.ts`), botón web (`apps/web/src/xmi/ImportXmiButton.tsx`) y cliente HTTP. Los tests del adapter pasan, pero la sesión se frenó antes de levantar Postgres + API + collab + web para probarlo manualmente con un `.xmi` real.

La rama tiene **scope mixto**: además del núcleo de PR 15, hay archivos de otros PRs/cambios que se filtraron acá. Resolver esto ANTES de commitear.

## Archivos del PR 15 (núcleo)

```
packages/adapters-import/src/xmi21.ts              NUEVO  parseXmiDocument + xmiToDeltaBatch
packages/adapters-import/src/xmi21-layout.ts       NUEVO  gridLayout + centerNaryDiamond
packages/adapters-import/src/index.ts              MOD    re-export
packages/adapters-import/package.json             MOD    + fast-xml-parser
packages/adapters-import/test/xmi21.test.ts       NUEVO
packages/adapters-import/test/xmi21-layout.test.ts NUEVO
packages/adapters-import/test/fixtures/ea-sample.xmi       NUEVO  (3 fixtures)
packages/adapters-import/test/fixtures/bad-version.xmi    NUEVO
packages/adapters-import/test/fixtures/malformed.xmi      NUEVO
apps/api/src/xmi-import.ts                         NUEVO  POST /diagrams/:id/import/xmi
apps/api/src/index.ts                              MOD    monta la ruta
apps/web/src/api/xmiApi.ts                         NUEVO  cliente HTTP
apps/web/src/xmi/ImportXmiButton.tsx               NUEVO  botón toolbar
apps/web/src/App.tsx                               MOD    monta <ImportXmiButton> en toolbar
apps/web/src/i18n.tsx                              MOD    textos
```

## Archivos fuera de scope (mezclados en la rama — decisión pendiente)

| Archivos | Pertenecen a | Acción sugerida |
|---|---|---|
| `apps/web/src/codegen/` + `apps/web/src/api/codegenApi.ts` | PR 14d (Generate Spring) | Cherry-pick a `feature/ai-uml-design-tool-pr14` o descartar |
| `packages/adapters-ai/src/retry-repairing-llm.ts` + `.test.ts` | Change `interpreter-llm-resilience` (SDD aparte) | Mover a su rama |
| `apps/api/src/interpreter.ts` + `interpreter.test.ts` (mod) | `interpreter-llm-resilience` | Mover a su rama |
| `openspec/changes/interpreter-llm-resilience/` | Change `interpreter-llm-resilience` | Mover a su rama |
| `.atl/skill-registry.md`, `openspec/config.yaml`, `pnpm-lock.yaml` | Housekeeping | Commitear aparte o descartar |

## Decisiones pendientes (en orden)

### 1. Scope mixto

Tres caminos posibles:
- **(a) Separar**: cherry-pick / mover los archivos que no son de PR 15 a sus respectivas ramas. Más limpio, pero requiere tiempo.
- **(b) Commitear todo junto**: un solo commit con mensaje tipo `feat(xmi): PR 15 + housekeeping` y aceptar que se reabre el scope. Más rápido.
- **(c) Descartar lo que no corresponde**: `git checkout --` en los archivos fuera de scope y borrar los untracked. Solo dejar el núcleo de PR 15.

**Recomendación**: (c) si se puede, (b) si urge commitear. (a) es lo correcto a futuro pero no urgente.

### 2. Confirm-gate (spec 15.6)

El spec dice: *"review-then-apply gate; commit as ONE atomic delta batch (xmi:R4)"*.

Lo que hace el código actual: el handler API devuelve los deltas al cliente y el botón los aplica directo al Y.Doc, sin pantalla de preview/confirm.

Justificación dejada en el handler: *"PendingDeltaStore es single-delta, import es N deltas"*.

**Decisión de producto a tomar**: ¿se documenta como excepción consciente del import (a diferencia del AI interpreter), o se implementa un review modal en el cliente antes de aplicar?

### 3. Web tests del botón

`ImportXmiButton.tsx` no tiene `.test.tsx` acompañándolo. Los tests del adapter (server-side) están, pero no hay test jsdom del wiring cliente: subir archivo → POST → aplicar deltas al Y.Doc → verlos en el canvas.

**Decisión**: ¿se agrega ahora (jsdom) o se deja para un follow-up?

### 4. tasks.md 15.1–15.7 sin check

Las subtasks siguen `[ ]` aunque los tests existen. Actualizar después de resolver el scope mixto (los checks van por PR, no por commit).

## Primer test a correr en la otra PC

```bash
pnpm --filter @app/adapters-import test
pnpm -r test
```

Los 3 fixtures (`ea-sample`, `bad-version`, `malformed`) cubren los escenarios del spec: import normal, versión inválida, XML malformado. Si pasan, el adapter está verde y el resto del trabajo es de integración UI/API.

## Probar end-to-end (cuando se decida)

```bash
# 1. Levantar Postgres (apps/api depende de él)
docker compose up -d postgres

# 2. En terminales separadas:
pnpm --filter @app/collab-server dev
pnpm --filter @app/api dev
pnpm --filter @app/web dev

# 3. Abrir http://localhost:5173
#    - Save un diagrama (genera id en hash)
#    - Click "Import XMI" en toolbar
#    - Seleccionar un .xmi real exportado de Enterprise Architect
#    - Verificar que aparece en el canvas
```

## Backlog para el final del change (NO ahora)

- **Bug codegen dependency** (mencionado al inicio de la sesión): el mapping table 3 de `packages/codegen/src/generate.ts` no tiene caso para `dependency` edges (PR 12b). El codegen los ignora silenciosamente. Decidir: warning explícito (consistente con `interface-endpoint-skipped`) u otro comportamiento.
- **PR 15b (XMI export)**: scope amendment 2026-09-05, tasks.md 15b.1–15b.5 ya redactadas pero SIN implementar. El round-trip test es la aceptación (export → re-import → idéntico).
- **PR 16, 16b, 17, 18, 19**: pendientes después de 15+15b.

## Spec de referencia

`openspec/changes/ai-uml-design-tool/specs/ea-xmi-importer/spec.md` — 5 escenarios RED + los del scope amendment 2026-08-31 (generalization, composition, `3..7`, n-ary, dependency, realization, abstract, interface).
