#!/usr/bin/env bash
# The night shift: work that needs Claude runs with the subscription
# (`claude -p`, never the paid API) while nobody is using the plan, and stops
# at the plan's usage limit, at NOCHE_HASTA (HH:MM) or after NOCHE_MAX stores.
# Today it reads the public stores' policy pages (base politicas); more tasks
# go in the queue below, in order. Run by the systemd user timer in
# scripts/systemd/ or by hand:
#
#   COMERCIOS_DATA=$HOME/agentes/datos-comercios apps/comercios/scripts/noche.sh
#
# Uses the plan: every Claude session of the account shares the same limit,
# so while it runs (and until the plan's window resets) the other sessions
# may hit the limit too. It does not take semanal.lock for the whole run,
# because the weekly job skips its run when that lock is held; it waits for a
# running weekly job to finish first, and its own writes are small (one row
# per store), with SQLite's busy timeout. NOCHE_NO_UPDATE=1 skips the move to
# origin/main (to try a branch).
set -Eeuo pipefail

main() {
  : "${COMERCIOS_DATA:?COMERCIOS_DATA: the local data folder}"
  local app repo day log args rc
  app="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  repo="$(cd "$app/../.." && pwd)"
  day="$(date +%F)"
  mkdir -p "$COMERCIOS_DATA/noche"
  log="$COMERCIOS_DATA/noche/$day.log"

  exec 8>"$COMERCIOS_DATA/noche.lock"
  if ! flock -n 8; then
    echo "otro turno de noche sigue corriendo" >&2
    exit 0
  fi
  exec > >(tee -a "$log") 2>&1
  TEE_PID=$!
  trap 'exec >&- 2>&-; wait "$TEE_PID" 2>/dev/null || true' EXIT
  trap 'echo "== $(date -Is) FALLÓ en la línea $LINENO"' ERR
  echo "== $(date -Is) turno de noche"

  # If the weekly job is running, wait for it (up to 4 h), then let the lock go at once.
  if ! flock -w 14400 "$COMERCIOS_DATA/semanal.lock" true; then
    echo "la actualización semanal sigue corriendo después de 4 h: no parto"
    exit 0
  fi

  if [ "${NOCHE_NO_UPDATE:-}" != "1" ]; then
    git -C "$repo" fetch -q origin main
    git -C "$repo" checkout -q --detach origin/main
    (cd "$repo" && pnpm install --frozen-lockfile --silent)
  fi
  echo "código: $(git -C "$repo" log --oneline -1)"

  cd "$app"
  args=()
  [ -n "${NOCHE_HASTA:-}" ] && args+=(--hasta "$NOCHE_HASTA")
  [ -n "${NOCHE_MAX:-}" ] && args+=(--max "$NOCHE_MAX")
  [ -n "${NOCHE_PARALELO:-}" ] && args+=(--paralelo "$NOCHE_PARALELO")

  # The queue, in order. Exit code 3 is the plan's limit: the rest waits for the next night.
  echo "== $(date -Is) políticas de las tiendas"
  rc=0
  npx tsx src/cli.ts base politicas "${args[@]}" || rc=$?
  if [ "$rc" -eq 3 ]; then
    echo "== $(date -Is) límite del plan: lo que queda sigue la próxima noche"
    exit 0
  fi
  [ "$rc" -eq 0 ] || exit "$rc"
  echo "== $(date -Is) listo"
}

main "$@"
