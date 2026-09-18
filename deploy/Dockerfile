# Dockerfile — Receta de build del monorepo. Produce DOS imágenes (targets):
#   app   → node con todo el repo instalado (corren api, collab-server, migrate)
#   nginx → imagen nginx con cert autofirmado + el dist del frontend adentro
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

# ── Target: nginx — imagen final del frontend: nginx + dist estático + cert ─
# Reemplaza al target `caddy` original: nginx con cert autofirmado es
# predecible, mientras que Caddy + tls internal + Alpine nos dio un
# TLS alert internal error sin causa clara en el handshake.
#
# El cert autofirmado se genera acá mismo al build (en runtime el container
# ya arranca con el cert listo, no hay generación lazy ni storage que
# pueda quedar inconsistente).
#   -subj "/CN=..."        → nombre del cert (no importa el valor, los
#                             navegadores solo validan que esté firmado
#                             por una CA, y el usuario lo acepta igual).
#   -days 365              → válido por 1 año, alcanza de sobra para el
#                             parcial (y se puede rebuildear la imagen).
FROM nginx:1.27-alpine AS nginx

# openssl NO viene en nginx:alpine (la imagen base es muy flaca). Lo
# instalamos explícitamente para generar el cert autofirmado al build.
# Es ~1 MB extra, vale la pena frente al dolor de un cert que no se genera.
RUN apk add --no-cache openssl \
    && mkdir -p /etc/nginx/certs \
    && openssl req -x509 -nodes -newkey rsa:2048 \
       -keyout /etc/nginx/certs/key.pem \
       -out    /etc/nginx/certs/cert.pem \
       -days 365 \
       -subj "/CN=localhost"

# Copia la config de nginx y el dist de Vite (generado en el stage "app").
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=app /app/apps/web/dist /usr/share/nginx/html
