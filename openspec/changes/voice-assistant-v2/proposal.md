# Voice Assistant v2 — Full CRUD by Voice with Local AI

## Problem

The generated Spring Boot backend has an assistant endpoint (`POST /api/assistant`)
that only supports **LIST** and **COUNT** actions. CREATE is a stub that doesn't
actually create anything. DELETE and UPDATE don't exist.

For the parcial demo, the assistant must support **all 5 CRUD actions by voice**
from a Flutter app: list, count, create, delete, update — in Spanish and English.

The local AI (Ollama + `qwen2.5:1.5b`) is configured but requires manual installation.
The generated backend should auto-provision Ollama and the model so the demo "just works".

## Scope

All changes are in `packages/codegen` (the generator) and `templates/spring-backend/`
(the Handlebars templates). We do NOT modify the generated backend by hand — we modify
the **generator** so every generated backend gets these capabilities.

---

## Design

### 1. Expanded Intent Model

Current:
```java
record Intent(Action action, String entityName)
// Action: LIST, COUNT, CREATE
```

Proposed:
```java
record Intent(Action action, String entityName, Long id,
              Map<String, String> fields)
// Action: LIST, COUNT, CREATE, DELETE, UPDATE
```

- `id` — required for DELETE and UPDATE (e.g. "delete product **3**")
- `fields` — key-value pairs for CREATE and UPDATE (e.g. `{name: "Laptop", price: "500"}`)

### 2. Classification Cascade: Ollama First, IntentMatcher Fallback

```
User text
   │
   ├─1─► Ollama (primary) — handles ALL actions including complex ones
   │        └── success → execute intent
   │
   └─2─► IntentMatcher (fallback) — only when Ollama is unreachable
            └── deterministic keyword + regex parsing
            └── covers: LIST, COUNT, DELETE (with ID regex)
            └── UPDATE/CREATE with fields: returns "unavailable"
```

**Rationale**: Ollama understands Spanish, English, extracts IDs and fields from
natural language, and resolves entity names. The IntentMatcher is a deterministic
safety net that keeps LIST/COUNT/DELETE working when Ollama is down.

IntentMatcher new keyword tables (for fallback only):

| Keyword (en)     | Keyword (es)            | Action |
|------------------|-------------------------|--------|
| list, show       | dame, mostrá, listá     | LIST   |
| count, how many  | cuántos, cuantos        | COUNT  |
| delete, remove   | eliminá, borrá, elimina | DELETE |
| update, modify   | modificá, cambiá        | UPDATE (needs Ollama for fields) |
| create, add, new | creá, nuevo, agregar    | CREATE (needs Ollama for fields) |

ID extraction via regex: first `\d+` in the text.

### 3. Spanish Entity Map: Dynamic Instead of Hardcoded

Current problem: `SPANISH_ENTITIES` is hardcoded with `"producto"→"Product"` etc.
If the diagram has `Vehiculo` or `Factura`, it doesn't match.

Solution: **remove the hardcoded map entirely**.

- **Ollama (primary)**: gets the full `knownEntities` list in its prompt and
  resolves any language to the correct entity name.
- **IntentMatcher (fallback)**: English path matches dynamically against
  `knownEntities`. For Spanish, naive normalization: strip common suffixes
  (`-s`, `-es`) and compare case-insensitively.

### 4. Ollama Prompt Expansion

Current prompt asks for: `{"action":"...", "entity":"..."}`

Proposed structured output schema:
```json
{
  "action": "list|count|create|delete|update",
  "entity": "...",
  "id": 3,
  "fields": {"name": "Laptop", "price": "500"}
}
```

The prompt includes the known entities AND their field schemas so Ollama can:
- Resolve entity names in any language to the Java class name
- Extract field names and values for CREATE/UPDATE
- Extract the target ID for DELETE/UPDATE

Since Ollama is now the **primary** path, the prompt quality matters more.
The system prompt will include:
- The list of known entities with their fields and types
- Clear instructions for each action
- Example inputs/outputs for reliability

### 5. AssistantController Execution Logic

New switch branches:

```
DELETE → service.findById(id) check → service.deleteById(id)
UPDATE → service.findById(id) → apply field values → service.save(entity)
CREATE → construct entity from fields map → service.save(entity)
```

For UPDATE/CREATE, field values are applied via a generated
`applyFields(entity, Map<String, String>)` method per entity (type-aware).

> **Decision**: Generated `applyFields()` is preferred over reflection. Each entity
> template gets a static method that maps field names to setters with type conversion.
> This is safe, fast, and doesn't need `--add-opens` flags.

### 6. Ollama Auto-Provisioning

#### 6a. Docker path (docker-compose)

Add Ollama as a service in the generated `docker-compose.yml`:

```yaml
ollama:
  image: ollama/ollama:latest
  ports:
    - "11434:11434"
  volumes:
    - ollama_data:/root/.ollama

ollama-init:
  image: ollama/ollama:latest
  depends_on:
    - ollama
  entrypoint: ["sh", "-c", "sleep 5 && ollama pull qwen2.5:1.5b"]
```

With this, `docker-compose up` starts everything including the model download.
The app service gets `ASSISTANT_OLLAMA_URL: http://ollama:11434`.

#### 6b. Non-Docker path (local dev)

On Spring Boot startup, an `OllamaProvisioner` bean:

1. **Health check**: `GET http://127.0.0.1:11434/` — if unreachable, log a warning
   and switch to IntentMatcher-only mode.
2. **Model check**: `GET http://127.0.0.1:11434/api/tags` — search for the model.
3. **Auto-pull**: if model is missing, `POST http://127.0.0.1:11434/api/pull`
   with `{"name": "qwen2.5:1.5b"}`. Log progress. This is a ~1GB download that
   happens once.
4. **Status endpoint**: `GET /api/assistant/status` returns
   `{ollama: true/false, model: "qwen2.5:1.5b", ready: true/false}` so the
   Flutter app can show the user whether the AI is available.

> **Note**: Installing the Ollama binary itself is NOT automated. It requires
> OS-specific commands and elevated permissions. The README documents the one-line
> install command per OS. Everything after that is automatic.

### 7. Graceful Degradation

| Ollama state        | Behavior |
|---------------------|----------|
| Running + model OK  | **Full CRUD by voice** — Ollama classifies everything |
| Running, no model   | Auto-pull → Full CRUD after download completes |
| Not running / not installed | **IntentMatcher fallback**: LIST, COUNT, DELETE (with ID regex). UPDATE/CREATE return `outcome: "unavailable"` with message to install Ollama. |

The assistant NEVER crashes because of Ollama. The `outcome` field tells the
Flutter app what happened so it can inform the user.

---

## Files to Modify

### Templates (Handlebars)

| File | Change |
|------|--------|
| `assistant-engine.hbs` | Add DELETE, UPDATE to Action enum. Add `id`, `fields` to Intent record. |
| `intent-matcher.hbs` | Add DELETE/UPDATE keywords. Add ID regex extraction. Remove hardcoded `SPANISH_ENTITIES`. Add naive normalization. |
| `ollama-engine.hbs` | Expand JSON schema in prompt. Add field schema context. |
| `assistant-controller.hbs` | Add DELETE/UPDATE/CREATE execution. Add `applyFields` dispatch. Add `/status` endpoint. |
| `audit-log.hbs` | No changes needed (already generic). |
| `docker-compose.hbs` | Add `ollama` + `ollama-init` services. |
| `entity.hbs` | **[NEW section]** Generate `applyFields(Map<String,String>)` static method. |
| `application-properties.hbs` | Add `assistant.auto-pull=true` property. |

### Templates (New)

| File | Purpose |
|------|---------|
| `ollama-provisioner.hbs` | **[NEW]** `@Component` that runs on startup: health check, model check, auto-pull. |

### Generator (`packages/codegen`)

| File | Change |
|------|--------|
| `generate.ts` | Pass entity field schemas to the assistant model so templates can render field-aware logic. |
| `generate.ts` | Register `ollama-provisioner` in file emission. |

---

## Risks

| Risk | Mitigation |
|------|------------|
| Ollama pull takes too long on slow connections | Status endpoint tells Flutter to show a progress indicator. Backend works without it. |
| `qwen2.5:1.5b` misclassifies complex UPDATE commands | IntentMatcher handles the simple cases. Ollama is the fallback. Worst case: `outcome: "canned"`. |
| Docker-in-Docker for Ollama GPU access | Ollama CPU mode works fine for a 1.5B model. No GPU needed. |
| `applyFields` type conversion fails (e.g. "abc" for Integer) | Catch `NumberFormatException` etc., return `outcome: "refused"` with a clear message. |

---

## Out of Scope

- Flutter app (separate task)
- Voice-to-text (handled by Flutter's `speech_to_text` package, not the backend)
- Remote/cloud AI endpoints (the constraint is LOCAL only)
- Installing Ollama binary automatically (requires OS-specific elevated permissions)
