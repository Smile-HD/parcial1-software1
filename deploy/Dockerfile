# Dockerfile — Receta de build del monorepo. Produce DOS imágenes (targets):
#   app   → node con todo el repo instalado (corren api, collab-server, migrate)
#   caddy → imagen caddy con el dist del frontend adentro (solo archivos estáticos)
# Multi-stage: cada FROM ... AS abre una etapa; se puede copiar output de una
# a otra (--from) sin arrastrar toolchains → menos superficie, menos GB.

# ── Target: app — imagen de todo-el-repo para api, collab-server, migrate ──
# node:22-bookworm-slim = Debian 12 flaco + Node LTS. bookworm (no alpine):
# las deps nativas (p. ej. better-sqlite3) compilan/binnean mejor con glibc
# que con musl, y evita sorpresas de ABI en pnpm install.
FROM node:22-bookworm-slim AS app

WORKDIR /app

# Corepack: Node 22 ya no trae pnpm preinstalado; corepack lo instala en la
# versión EXACTA que fija el campo "packageManager" de package.json → build
# reproducible: el lockfile de CI/EC2 es el mismo binomio siempre.
RUN corepack enable && corepack prepare pnpm@11.22.0 --activate

# ── Capa 1: instalar dependencias ANTES de copiar el código ─────────────
# Truco clásico de caché de capas Docker: pnpm install solo se re-ejecuta
# si cambia package.json/lockfile — tocar una línea de TS no rompe el caché,
# así que los rebuilds del deploy son rápidos.
# COPY selectivo (no "COPY . ."): solo los manifests → cacheo fino.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json    apps/api/package.json
COPY apps/web/package.json    apps/web/package.json
COPY apps/collab-server/package.json apps/collab-server/package.json
COPY packages/                packages/

# --frozen-lockfile: si el lock y los package.json no calzan al 100%, falla
# el build en vez de "arreglarlo" instalando otras versiones. En deploy,
# determinismo > comodidad.
RUN pnpm install --frozen-lockfile

# ── Capa 2: ahora sí, el código fuente completo ─────────────────────────
# (respeta .dockerignore: node_modules, dist, .env, etc. NO entran)
COPY . .

# Env de build de Vite: se HORNEAN en el bundle JS (no son runtime).
# VITE_COLLAB_URL llega absoluto (wss://dominio/collab) porque el navegador
# del usuario no conoce la red interna de compose — necesita URL pública.
# ARG = valor en build time; ENV = deja visible el default para el runtime
# de este stage (los servers reales levantan su env desde compose, no de acá).
ARG VITE_API_URL=/api
ARG VITE_COLLAB_URL=
ENV VITE_API_URL=$VITE_API_URL VITE_COLLAB_URL=$VITE_COLLAB_URL

# Build del SPA React (Vite) → output en apps/web/dist (pure static).
# Solo se construye web: api y collab-server corren con tsx desde el fuente.
RUN pnpm --filter @app/web build

# ── Target: caddy — imagen final del frontend: Caddy + dist estático ─────
# Agarra la imagen oficial de Caddy y le copia SOLO el output del build.
# Resultado: un web server HTTPS con tu SPA adentro, sin Node, sin pnpm,
# sin fuente → superficie mínima. El compose construye ESTE target para
# el servicio caddy (antes usaba la imagen base pelada y /srv no existía:
# GET / devolvía 404 — bug arreglado en este cambio).
FROM caddy:2 AS caddy

# Copia SOLO el resultado del build (dist) del stage "app" → /srv, que es
# donde el Caddyfile apunta con "root * /srv".
COPY --from=app /app/apps/web/dist /srv
