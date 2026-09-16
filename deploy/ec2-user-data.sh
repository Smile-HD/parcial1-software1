#!/usr/bin/env bash
# ec2-user-data.sh — Script de bootstrap de la instancia EC2 (D8).
# NO lo ejecutás vos: se lo pegás a AWS en "Advanced details → User data"
# al LANZAR la instancia, y EC2 lo corre una sola vez en el primer arranque,
# como root. Deja la máquina virgen lista para docker compose.
#
# ⚠️ Al pegar en AWS, la PRIMERA línea debe ser exactamente:
#      #!/bin/bash
#    Si no, EC2 no lo reconoce como script y lo ignora en silencio.
#
# set -euo pipefail → "modo estricto": cualquier error aborta (no sigue
# instalando sobre un sistema a medias).
set -euo pipefail

# ── Docker Engine + plugin Compose v2 desde los repos de Ubuntu ─────────
# docker.io = el paquete estable (evita el repo de Docker Inc: menos superficie,
# más reproducible para una entrega académica).
apt-get update
apt-get install -y docker.io docker-compose-v2

# Habilitar el daemon y arrancarlo ahora (systemd lo relanza en cada boot).
systemctl enable --now docker

# ── Swap de 2 GiB (D8) ──────────────────────────────────────────────────
# ¿Por qué? El t4g.small tiene 2 GB de RAM y el build de la imagen
# (pnpm install + vite build) puede picos mayores. Sin swap, el OOM-killer
# del kernel te mata el build en la etapa más cara y el error es horrible
# de diagnosticar. Con swap, aguanta (lento, pero termina).
# El "if ! swapon --show" lo hace idempotente: no duplica el swapfile si
# el script llegara a correr dos veces.
if ! swapon --show | grep -q '/swapfile'; then
  fallocate -l 2G /swapfile           # archivo de 2G (rápido, sin escribir datos)
  chmod 600 /swapfile                 # solo root: es memoria paginada, sensible
  mkswap /swapfile                    # darle formato de swap
  swapon /swapfile                    # activarlo ya
  # Registrar en fstab para que sobreviva reboots (swapon no es persistente):
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi
