# Runbook de despliegue — System A (AWS, host único)

Topología: **una sola EC2** corre todo el stack con Docker Compose. El
frontend, la API, el servidor colaborativo y Postgres viven en esa máquina;
Route 53 pone el nombre y Caddy pone HTTPS automáticamente.

> **Decisión de arquitectura (sept 2026, revisada):** se abandonó DuckDNS. El
> nombre público es el **hostname que AWS le asigna a la propia EC2**
> (`ec2-<ip-invertida>.<region>.compute.amazonaws.com`), derivado de la
> Elastic IP y resuelto por la infra de DNS de AWS. **$0 y 100% dentro del
> Free Tier** — no se compra dominio, no se configura Route 53. (Route 53 +
> dominio propio queda como OPCIÓN puramente estética; ver "Costo".)
>
> Se **mantiene TLS gestionado por Caddy/Let's Encrypt**: no es capricho — el
> micrófono (`getUserMedia`, ver `apps/web/src/voice/recorder.ts`) está
> bloqueado por los navegadores fuera de un *secure context* (HTTPS o
> localhost). Sin HTTPS no hay notas de voz remotas. Y Let's Encrypt emite un
> certificado perfectamente válido para el hostname de la EC2 (el ACME
> HTTP-01 validation usa el puerto 80): hostname que resuelve + 80/443
> abiertos = certificado gratis, de confianza y autorrenovable.

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

- Cuenta AWS con créditos del plan gratuito vigente ($100 iniciales + hasta
  $100 más explorando; se agotan o la cuenta se cierra sola a los 6 meses —
  ver "Cierre limpio").
- EC2 `t4g.small`, Ubuntu 24.04 ARM64, ~20 GB gp3.
- Security Group: ingreso **22 (SSH), 80 y 443 desde 0.0.0.0/0** nada más.
  Postgres (5432) JAMÁS expuesto: los containers se hablan por la red interna.
- **Elastic IP asignada a la instancia** — obligatoria, no opcional: el
  hostname público deriva de ella, así que sin EIP no hay nombre estable.
  Mientras la instancia está corriendo no suma costo (la cuota IPv4 se paga
  igual haya o no EIP; lo que sí hay que liberar es la EIP al apagar
  definitivamente).
- **Nombre público** (una de dos, la primera es gratis y alcanza para todo):
  1. **El hostname público de la EC2** (default, $0), ej.
     `ec2-3-88-20-45.us-east-1.compute.amazonaws.com`. Ya resuelve apenas se
     asocia la Elastic IP — no se compra ni configura nada. Es el que usa
     este runbook.
  2. **Opcional, solo estética:** dominio propio registrado en Route 53 con
     registro A → Elastic IP. Da una URL linda para la entrega; el deploy
     funciona exactamente igual con la opción 1.

## Bringing up (orden D9 actualizado)

1. **Gate: DNS antes del primer up** — `nslookup <PUBLIC_DOMAIN>` debe
   devolver la IP pública *antes* de cualquier `docker compose up`; si no,
   ACME no emite certificado. Con el hostname de la EC2 esto es instantáneo
   (lo publica AWS al asociar la Elastic IP). Si usaste dominio propio en
   Route 53, verificar también en `https://dns.google` (cachés de resolvers
   ajenos).
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

Precios verificados en las páginas oficiales (aws.amazon.com/route53/pricing y
aws.amazon.com/free, sept 2026).

| Ítem | USD/mes aprox. | ¿Lo cubren los créditos? |
|---|---|---|
| EC2 t4g.small 24/7 | ~12.30 | Sí (gasto de servicio) |
| EBS 20 GB gp3 | ~1.60 | Sí |
| IPv4 pública + Elastic IP | ~3.60 | Sí (se paga igual con o sin EIP) |
| **Hostname público de la EC2** | **$0** | **Infra de AWS, ya está incluido** |
| Route 53 hosted zone | ~0.50 | Solo si comprás dominio — opcional |
| Route 53 queries | ~0.40/millón | Opcional — despreciable |
| Dominio (solo URL linda) | ~1.10 | **NO** — pago de bolsillo, opcional |
| **Total ruta 100% free** | **~17.50/mes** | **Todo de créditos → ~5.7 meses con $100** |

> **✅ Conclusión del costo:** con la ruta gratis (hostname de la EC2) el
> deploy **no te cuesta un peso de tu bolsillo**. $100 te dan ~5.7 meses, y
> la cuenta se cierra sola a los 6 — sobra margen.

> **⚠️ Si igual querés dominio propio (opcional).** Textual, pricing de Route
> 53: *"You may not use Promotional Credit for any fees or charges for Route 53
> domain name registration."* El registro (~$10–12/año según TLD; [tabla por
> TLD](https://d32ze2gidvkk54.cloudfront.net/Amazon_Route_53_Domain_Registration_Pricing_20140731.pdf))
> **nunca** se paga con créditos. Por eso no es parte del plan base: es un
> lujo estético, no un requisito del deploy.

> **Cierre automático (a tu favor).** La cuenta Free se cierra sola a los
> 6 meses de creada o cuando se agotan los créditos, lo que pase primero. Es un
> "shutdown plan" forzado: aunque te olvides, no hay factura sorpresa. Igual
> agendá terminar la EC2 y **liberar la Elastic IP** antes — una EIP sin
> asociar también se cobra mientras queden créditos.

> **Trucos para no gastar de más.** (1) Los **health checks de hasta 50
> endpoints AWS son gratis**: agregá uno apuntando a la EC2 y tenés monitoreo
> de uptime sin costo extra. (2) Si llegado el caso jugás con Route 53, una
> hosted zone borrada dentro de las **12 horas** de creada no se cobra (solo
> las queries) — ideal para ensayar el flujo sin tocar el saldo. (3) El Free
> plan limita a **servicios seleccionados**; si alguno (p. ej. Route 53) no te
> deja crear el recurso, es que no está habilitado — con la ruta gratis ni lo
> tocás.
