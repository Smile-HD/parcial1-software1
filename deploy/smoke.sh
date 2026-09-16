#!/usr/bin/env bash
# smoke.sh — Prueba end-to-end del stack desplegado ("¿sobrevivió el humo?").
# No mira procesos locales: hace GETs REALS contra la URL pública, así prueba
# el circuito completo: DNS → Caddy (TLS) → proxy por path → servicio → (BD).
# Sale 200 en los tres = la app es accesible para un usuario de verdad.
#
# Uso:   bash smoke.sh https://<tu-dominio-route53>
# Exit != 0 ante CUALQUIER fallo (task 2.1 RED→GREEN: host inalcanzable debe
# salir distinto de 0 — lo usamos así en el checklist de validación local).
set -euo pipefail

BASE_URL="${1:?Usage: smoke.sh https://tu-dominio.example.com}"
FAIL=0

# check <etiqueta> <url>: pide la URL y espera un 200 exacto.
#   -o /dev/null     → descartar el body (solo nos importa el status)
#   -w '%{http_code}' → imprimir SOLO el código HTTP
#   --max-time 10    → cortar si cuelga (un healthcheck colgado también es un fallo)
#   || true          → no abortar el script con un conexión rechazada;
#                      queremos que siga probando las otras dos rutas
check() {
  local label="$1" url="$2"
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$url" || true)
  if [ "$code" = "200" ]; then
    echo "OK  $label  ($code)"
  else
    echo "FAIL $label  (expected 200, got $code)"
    FAIL=1
  fi
}

# Los 3 caminos críticos: frontend, API, websocket (por HTTP; el upgrade
# websocket real se prueba en el navegador con dos pestañas).
check "GET /"           "$BASE_URL/"
check "GET /api/health" "$BASE_URL/api/health"
check "GET /collab/"    "$BASE_URL/collab/"

if [ "$FAIL" -ne 0 ]; then
  echo "SMOKE FAILED"
  exit 1
fi

echo "ALL CHECKS PASSED"
exit 0
