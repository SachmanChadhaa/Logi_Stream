#!/usr/bin/env bash
# Stop everything this project started (CLAUDE.md D3-T2).
#   bash demo/stop.sh            stop the host services, leave containers up
#   bash demo/stop.sh --all      also stop postgres and litellm
#
# Deliberately does NOT take a -v / --volumes option. After D3-T4 the verdict
# cache and the checkpoints live in that volume, and wiping them the morning of
# the demo would silently make every turn slow again (CLAUDE.md trap 10). If you
# really mean it, type the docker command yourself.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

ALL=0
[ "${1:-}" = "--all" ] && ALL=1

BOLD=$'\033[1m'; DIM=$'\033[2m'; RESET=$'\033[0m'

kill_port() {  # kill_port <port> <name>
  local port="$1" name="$2" pid
  pid=$(powershell -NoProfile -Command \
    "(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue).OwningProcess" \
    2>/dev/null | tr -d '\r' | head -1)
  if [ -n "$pid" ]; then
    # //T kills the tree: uv and npm both spawn the real server as a child, so
    # killing only the parent leaves the port held
    taskkill //PID "$pid" //F //T >/dev/null 2>&1
    printf '  stopped %-14s (pid %s)\n' "$name" "$pid"
  else
    printf '  %s%-22s not running%s\n' "$DIM" "$name" "$RESET"
  fi
}

echo "${BOLD}LogiStream — stopping${RESET}"

# reverse of start order: nothing should be left talking to a dead upstream
kill_port 3000 "web"
kill_port 8000 "gateway"
kill_port 8001 "orchestrator"
kill_port "${INTEL_PORT:-8003}" "intel"
kill_port 8080 "domain"

if [ "$ALL" = "1" ]; then
  echo "  stopping containers..."
  docker compose stop >/dev/null 2>&1 && echo "  stopped postgres + litellm"
else
  echo "${DIM}  containers left running (use --all to stop them too)${RESET}"
fi

echo "${BOLD}done${RESET}"
