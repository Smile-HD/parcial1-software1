# Mobile Test Client (`mobile-test-client/`)

> **Propósito**: Cliente externo y liviano para verificar y demostrar el funcionamiento del backend Spring Boot generado (System B) y su asistente de IA local (`offline-ai-assistant`), cumpliendo la especificación `specs/mobile-test-client/spec.md`.
> **No Generado**: Este cliente reside fuera del motor de generación de código (`spring-codegen`), excluido de los paquetes de pnpm.

---

## 1. Características Implementadas

| Requisito | Descripción | Implementación |
|-----------|-------------|----------------|
| **mobile:R1** | Cliente explícitamente no generado | Ubicado en `mobile-test-client/`, aislado de `packages/codegen`. |
| **mobile:R2** | Ciclo completo de CRUD en backend Spring Boot | `CustomerService` (List, Get, Create, Update, Delete) + reporte explícito si el backend está caído (no muestra datos obsoletos). |
| **mobile:R3** | Asistente IA offline con degradación | `AssistantService` (`POST /api/assistant`), soporta respuestas ejecutadas (`executed`) y respuestas de capacidad enlatadas (`canned`) verbatim. |
| **mobile:R4** | Endpoint configurable en tiempo de ejecución | `ApiConfig` permite retarget sin recompilar (localhost, emulador `10.0.2.2`, o IP de red local). |
| **mobile:R5** | Alcance mínimo | Solo 3 pantallas: Configuración, CRUD Clientes, y Asistente IA. |

---

## 2. Ejecución y Pruebas

### 2.1 Suite de Tests Unitarios (TDD Estricto)
Para ejecutar la suite completa de 19 tests automatizados (modelos, servicios HTTP mock, manejo de errores de conexión):

```bash
cd mobile-test-client
dart test
```

### 2.2 Ejecución del Harness de Demostración CLI
Puedes probar de inmediato la conectividad y el ciclo CRUD + Asistente directamente por consola contra el backend Spring Boot (por defecto `http://localhost:8080`):

```bash
cd mobile-test-client
dart run bin/demo_client.dart
```

O apuntando a una IP LAN específica:
```bash
dart run bin/demo_client.dart http://192.168.0.147:8080
```

### 2.3 Ejecución con Flutter (Web / Desktop / Móvil)
Si tienes Flutter instalado en el entorno:

```bash
cd mobile-test-client
flutter run -d chrome
```

---

## 3. Guion Ensayado de la Demostración (Examen)

1. **Paso 1: Demostrar backend caído**
   - Ejecutar `dart run bin/demo_client.dart` o abrir la app con el backend apagado.
   - **Resultado esperado**: Mensaje explícito `[EXPECTED ERROR SURFACE] Cannot connect to backend at http://localhost:8080: El equipo remoto rechazó la conexión de red` (cumple `mobile:R2`).
2. **Paso 2: Iniciar backend generado**
   - En una terminal separada, arrancar el backend generado con `./mvnw spring-boot:run` (o el jar en `:8080`).
3. **Paso 3: Ciclo CRUD completo**
   - Ejecutar el cliente. Crear un cliente `Examen Student`.
   - Listar para ver el nuevo registro con su ID asignado.
   - Actualizar el nombre a `Examen Student (Actualizado)`.
   - Eliminar el registro y verificar que el servidor responde 404 en lecturas posteriores.
4. **Paso 4: Asistente IA Offline - Consulta de dominio**
   - Enviar la consulta: `"list customers"`.
   - **Resultado esperado**: El Asistente responde con `outcome: executed`, `action: list`, devolviendo la lista de clientes.
5. **Paso 5: Asistente IA Offline - Consulta no mapeable (Canned fallback)**
   - Enviar la consulta: `"borrar toda la base de datos"` o `"hazme un café"`.
   - **Resultado esperado**: El Asistente rechaza especulaciones y devuelve verbatim la respuesta de capacidades (`outcome: canned`):
     `"I can help you with: list records (e.g. 'list customers'), count records, or create a record."`

---

## 4. Matriz de Fallbacks de la Propuesta (Demo Hardening)

Ante cualquier imprevisto durante la presentación o defensa, el sistema cuenta con los siguientes peldaños de contingencia verificados:

| Componente | Flujo Principal | Peldaño de Contingencia (Fallback) |
|------------|-----------------|-----------------------------------|
| **Intérprete IA (Diagrama)** | OpenAI Structured Outputs en vivo | FakeLlm determinista integrado en `@app/adapters-ai` (100% offline, zero network) o video pregrabado. |
| **Colaboración Real-time** | Servidor WebSocket Yjs en `:1234` | Script de 2 navegadores concurrentes o sincronización en memoria verificada en `collab.test.ts`. |
| **Importador de Fotos** | Modelo multimodal visión | Fixture dorada limpia (`golden-whiteboard.png`) validada end-to-end con `FakeVisionAdapter`. |
| **XMI Enterprise Architect** | Export/Import dinámico de XMI 2.1 | Muestra real de EA (`ea-real-export2.xmi`) incluida en fixtures con round-trip verificado. |
| **Asistente IA Offline** | Inferencia local con Ollama (`qwen2.5:1.5b`) | `IntentMatcher` determinista bilingüe (código Java puro sin dependencias) y respuesta enlatada verbatim. |
| **Generación de Código** | Generación en caliente vía HTTP `/generate` | Backend Spring Boot pregenerado y probado en `golden/`. |
| **Cliente de Pruebas** | App Flutter (Web / Android) | Harness CLI `dart run bin/demo_client.dart` o solicitudes HTTP directas vía cURL / Swagger / REST. |
