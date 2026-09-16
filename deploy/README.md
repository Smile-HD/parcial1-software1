# Runbook de despliegue — System A (AWS, host único)

Topología: **una sola EC2** corre todo el stack con Docker Compose. El
frontend, la API, el servidor colaborativo y Postgres viven en esa máquina;
Route 53 pone el nombre y Caddy pone HTTPS automáticamente.

> **Decisión de arquitectura (sept 2026):** se abandonó DuckDNS. El dominio
> ahora se registra y resuelve en **AWS Route 53** (requisito "solo AWS").
> Se **mantiene TLS gestionado por Caddy/Let's Encrypt**: no es capricho — el
> micrófono (`getUserMedia`, ver `apps/web/src/voice/recorder.ts`) está
> bloqueado por los navegadores fuera de un *secure context* (HTTPS o
> localhost). Sin HTTPS no hay notas de voz remotas. El ACME HTTP-01 usa el
> puerto 80, así que Route 53 + 80/443 abiertos = certificado gratis y
> autorrenovable.

## Mapa de archivos (qué hace cada uno)

| Archivo | Rol |
|---|---|
| `Dockerfile` | Receta de build multi-stage. Target `app`: imagen Node con todo el repo (api + collab + migrate). Target `caddy`: imagen Caddy con el `dist` del frontend en `/srv`. |
| `docker-compose.yml` | Orquesta los 5 servicios (postgres, migrate, api, collab-server, caddy): órdenes de arranque, healthchecks, variables. Único publicador de puertos: Caddy (80/443). |
| `Caddyfile` | Reglas de tráfico: `/api/*`→api, `/collab/*`→collab-server (con upgrade WebSocket), resto→frontend SPA con fallback a `index.html`. TLS automático por ser dominio real. |
| `.env` (NO versionado) | Secretos y dominio real. `PUBLIC_DOMAIN` alimenta a Caddy y al build de Vite. |
| `ec2-user-data.sh` | Bootstrap automático de la EC2 al nacer: instala Docker y crea 2 GiB de swap (evita OOM durante el build en 2 GB de RAM). |
| `smoke.sh` | Validación end-to-end: 3 GETs públicos (`/`, `/api/health`, `/collab/`). Si los tres dan 200, el circuito DNS→TLS→proxy→servicios funciona. |

## Prerrequisitos

- Cuenta AWS con créditos del plan gratuito vigente ($100–200, vencen a los
  6 meses de creada la cuenta — **agendar shutdown antes**, ver Cierre).
- EC2 `t4g.small`, Ubuntu 24.04 ARM64, ~20 GB gp3.
- Security Group: ingreso **22 (SSH), 80 y 443 desde 0.0.0.0/0** nada más.
  Postgres (5432) JAMÁS expuesto: los containers se hablan por la red interna.
- Elastic IP asignada a la instancia (si la matás, la IP reservada también
  se cobra: liberarla al apagar).
- Dominio comprado en **Route 53** con **registro A → Elastic IP** en su
  hosted zone. Propaga en segundos/minutos (vs los 5 min de DuckDNS).

## Bringing up (orden D9 actualizado)

1. **Gate: DNS antes del primer up** — `nslookup <PUBLIC_DOMAIN>` debe
   devolver la Elastic IP *antes* de cualquier `docker compose up`; si no,
   ACME no emite certificado. En Route 53 también verificar en
   `https://dns.google` (cachés de resolvers ajenos).
2. Clonar repo y rama en la instancia:
   ```bash
   git clone -b <branch> <repo-url> && cd <repo>/deploy
   ```
3. Crear `deploy/.env` con valores reales (gitignoreado — nunca al repo):
   ```bash
   cp ../.env.example .env   # y llenar: DATABASE_URL (password propio),
                             # PUBLIC_DOMAIN=mi.dominio.xyz, OPENAI_API_KEY...
   ```
   Si migraron desde el `.env` viejo: **borrar** `DUCKDNS_DOMAIN` y
   `DUCKDNS_TOKEN`, ya no existen.
4. Validar la config de compose (chequea sintaxis + interpolación, no levanta nada):
   ```bash
   docker compose config -q
   ```
5. Build + start (-d = background; sobrevive cerrar el SSH):
   ```bash
   docker compose up -d --build
   ```
   El primer build tarda varios minutos (instala deps, construye el SPA,
   y ahora también la imagen de caddy con el dist). Es normal.
6. Esperar a que todo esté `healthy` y correr el smoke:
   ```bash
   docker compose ps            # STATUS: healthy en api, collab, caddy
   bash smoke.sh https://<PUBLIC_DOMAIN>
   ```
7. Prueba manual final: abrir el dominio en el celular → grabar nota de voz
   (prueba micrófono/HTTPS) y editar el mismo diagrama desde dos dispositivos
   (prueba WebSocket colaborativo).

## Backup antes de cada deploy

```bash
docker compose exec -T postgres pg_dump -U <user> <db> > backup-$(date -u +%F).sql
```

## Restore

1. `docker compose down`
2. Borrar el volumen `pgdata`, levantar con el backup restaurado en un
   `pgdata` fresco (`psql < backup.sql` sobre la base vacía).

## Rollback

```bash
docker compose down
```
(detiene contenedores; `pgdata` NO se toca — los datos sobreviven).

## Cierre limpio (antes de que venzan los créditos AWS)

1. `docker compose exec -T postgres pg_dump ... > backup-final.sql` y
   **descargar el SQL localmente** (es la única copia de los datos de demo).
2. `docker compose down` → terminar la instancia EC2 → liberar la Elastic IP.
3. El dominio y la hosted zone de Route 53 se pueden conservar o cancelar
   desde la consola (costo: ~$0.50/mes + renovación anual del dominio).

## Desviaciones aceptadas

- **D6 (reemplazada)** — DuckDNS/curl-loop fue eliminado en favor de
  Route 53 (registro A estático). Desaparece el updater y su ventana de
  propagación de 5 minutos.
- **Fix de topología** — el servicio `caddy` del compose usaba la imagen
  base `caddy:2-alpine` **sin el `dist`** (el target `caddy` del Dockerfile
  estaba construido pero nadie lo consumía → `GET /` daba 404). Ahora el
  servicio construye `target: caddy`, que es lo que el README de topología
  siempre describió.
- **D10** — desviación de TDD estricto: los archivos de infra (Dockerfile,
  compose, Caddyfile, .dockerignore, user-data, smoke.sh, README) se
  validan con checks locales ejecutables (`docker compose config -q`,
  `docker compose build`, `bash -n`, corrida negativa de `bash smoke.sh`)
  + checklist on-instance. No hay unit tests de Dockerfile.

## Nota sobre fines de línea

`smoke.sh` y `ec2-user-data.sh` usan LF. Si tu editor o Git en Windows los
convierte a CRLF, revientan adentro del container / en EC2. Asegurar LF en
`.gitattributes` o correr `dos2unix` antes de deployar.

## Costo (para el acta del parcial)

| Ítem | USD/mes aprox. |
|---|---|
| EC2 t4g.small 24/7 | ~12.30 |
| EBS 20 GB gp3 | ~1.60 |
| IPv4 pública + Elastic IP | ~3.60 |
| Route 53 hosted zone | ~0.50 |
| Dominio (prorrateado) | ~1.10 |
| **Total** | **~19** → >5 meses cubiertos por $100 de créditos |
