#!/usr/bin/env bash
# Crea .env a partir de .env.example y genera la clave de la base de datos. No toca un .env que ya exista.
#
#   bash scripts/crear-env.sh
#   DOMAIN=pizarra.tudominio.com bash scripts/crear-env.sh
#   DOMAIN=pizarra.tudominio.com JUNTO_A_DM_ENGINE=1 bash scripts/crear-env.sh   # comparte el HTTPS de DM Engine
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -f .env ]; then
  echo "Ya existe .env: no lo toco. Si quieres empezar de cero, muévelo a otro sitio y vuelve a ejecutar."
  exit 1
fi
command -v openssl >/dev/null || { echo "Falta openssl."; exit 1; }

cp .env.example .env
chmod 600 .env
set_var() { # nombre valor: sustituye la línea de esa variable
  local tmp
  tmp=$(mktemp)
  NAME="$1" VALUE="$2" awk 'BEGIN{FS=OFS="="} $1==ENVIRON["NAME"] {print ENVIRON["NAME"] "=" ENVIRON["VALUE"]; next} {print}' .env > "$tmp"
  mv "$tmp" .env
  chmod 600 .env
}

set_var POSTGRES_PASSWORD "$(openssl rand -hex 24)"
if [ -n "${DOMAIN:-}" ]; then set_var DOMAIN "$DOMAIN"; fi
if [ "${JUNTO_A_DM_ENGINE:-}" = "1" ]; then
  set_var COMPOSE_PROFILES ""
  printf 'COMPOSE_FILE=docker-compose.yml:docker-compose.junto-a-dm-engine.yml\n' >> .env
fi

echo "Creado .env."
grep -q '^DOMAIN=$' .env && echo "Falta por rellenar en .env: DOMAIN (nano .env)"
exit 0
