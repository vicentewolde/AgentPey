#!/usr/bin/env bash
# The weekly refresh of agentpey.com/chile: re-reads every public catalogue,
# rebuilds the guides and the brand pages, loads them into the panel's
# Postgres and tells the IndexNow engines. Run by the systemd user timer in
# scripts/systemd/, from a checkout used only for this (it moves itself to
# origin/main first), with the data outside any checkout:
#
#   COMERCIOS_DATA=$HOME/agentes/datos-comercios AGENTPEY_ENV=$HOME/agentes/AgentPay/.env.local apps/comercios/scripts/semanal.sh
#
# AGENTPEY_ENV is the file with DATABASE_URL, read by setup-postgres.ts and
# never printed: the job runs whatever is on origin/main with the admin
# connection, so a change to apps/comercios runs here the next Sunday.
# setup-postgres refuses a publish that drops more than 30% of the stores or
# brands. SEMANAL_NO_UPDATE=1 skips the move to origin/main (to try a
# branch). Uses no AI model: no plan usage.
set -Eeuo pipefail

# Everything is inside main, so bash has read the whole file before git checkout changes it.
main() {
  : "${COMERCIOS_DATA:?COMERCIOS_DATA: the local data folder}"
  : "${AGENTPEY_ENV:?AGENTPEY_ENV: the .env.local with DATABASE_URL}"
  local app repo day log
  app="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  repo="$(cd "$app/../.." && pwd)"
  day="$(date +%F)"
  mkdir -p "$COMERCIOS_DATA/semanal"
  log="$COMERCIOS_DATA/semanal/$day.log"

  exec 9>"$COMERCIOS_DATA/semanal.lock"
  if ! flock -n 9; then
    echo "otra actualización semanal sigue corriendo" >&2
    exit 0
  fi
  exec > >(tee -a "$log") 2>&1
  TEE_PID=$!
  # Let tee write the last lines before systemd ends the unit.
  trap 'exec >&- 2>&-; wait "$TEE_PID" 2>/dev/null || true' EXIT
  trap 'echo "== $(date -Is) FALLÓ en la línea $LINENO; los pasos siguientes no corrieron"' ERR
  echo "== $(date -Is) actualización semanal"

  if [ "${SEMANAL_NO_UPDATE:-}" != "1" ]; then
    git -C "$repo" fetch -q origin main
    git -C "$repo" checkout -q --detach origin/main
    (cd "$repo" && pnpm install --frozen-lockfile --silent)
    echo "código: $(git -C "$repo" log --oneline -1)"
  fi

  cd "$app"
  echo "== $(date -Is) lectura de catálogos"
  npx tsx src/cli.ts base ingest --todas
  echo "== $(date -Is) guías y marcas"
  npx tsx src/cli.ts base guia
  echo "== $(date -Is) publicación en la base del panel"
  npx tsx scripts/setup-postgres.ts --env "$AGENTPEY_ENV" --solo-importar --guias --max-caida 30
  echo "== $(date -Is) aviso a los buscadores"
  # The engines sometimes refuse the first call while they re-check the key file.
  npx tsx src/cli.ts base indexnow || { sleep 120; npx tsx src/cli.ts base indexnow; }
  echo "== $(date -Is) listo"
}

main "$@"
