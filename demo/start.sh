#!/usr/bin/env bash
# Bring the whole stack up, in order (CLAUDE.md D3-T2).
#   bash demo/start.sh
#
# Idempotent: anything already healthy is left alone, so it is safe to run twice
# if you are not sure what is up. Logs land in demo/logs/.
#
# Order matters. Postgres holds the checkpoints and the cache; LiteLLM is the
# orchestrator's only LLM endpoint; Java owns the sandbox; Python needs both;
# Rust needs Python and Java; the UI needs Rust.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [ ! -f .env ]; then
  echo "STOP: .env is missing. Copy .env.example and fill in the OpenRouter keys."
  exit 2
fi
set -a; . ./.env; set +a
. scripts/env.sh

LOGS="$ROOT/demo/logs"
mkdir -p "$LOGS"

BOLD=$'\033[1m'; DIM=$'\033[2m'; GREEN=$'\033[32m'; RED=$'\033[31m'; RESET=$'\033[0m'

step()  { printf '%s==>%s %s\n' "$BOLD" "$RESET" "$1"; }
ok()    { printf '    %sok%s   %s\n' "$GREEN" "$RESET" "$1"; }
die()   { printf '    %sFAIL%s %s\n' "$RED" "$RESET" "$1"; exit 1; }

# wait_http <url> <seconds> <name>
wait_http() {
  local url="$1" limit="$2" name="$3" i
  for ((i = 1; i <= limit; i++)); do
    curl -sf --max-time 2 "$url" >/dev/null 2>&1 && { ok "$name (${i}s)"; return 0; }
    sleep 1
  done
  return 1
}

listener_pid() {  # listener_pid <port>
  powershell -NoProfile -Command \
    "(Get-NetTCPConnection -LocalPort $1 -State Listen -ErrorAction SilentlyContinue).OwningProcess" \
    2>/dev/null | tr -d '\r' | head -1
}

T0=$(date +%s)
echo "${BOLD}LogiStream — starting${RESET}"
echo "${DIM}logs: demo/logs/${RESET}"
echo

# ---------------------------------------------------------------- 1. docker
step "docker engine"
if ! docker info >/dev/null 2>&1; then
  echo "    docker is not running; trying to start Docker Desktop..."
  DD="$LOCALAPPDATA/Programs/DockerDesktop/Docker Desktop.exe"
  if [ -f "$DD" ]; then
    powershell -NoProfile -Command "Start-Process '$(cygpath -w "$DD")'" >/dev/null 2>&1
    for i in $(seq 1 120); do
      docker info >/dev/null 2>&1 && break
      sleep 2
    done
  fi
  docker info >/dev/null 2>&1 || die "docker did not start - open Docker Desktop yourself and re-run"
fi
ok "engine up"

# ------------------------------------------------------ 2. postgres + litellm
step "containers (postgres, litellm)"
docker compose up -d >/dev/null 2>&1 || die "docker compose up failed"
for c in logistream-postgres logistream-litellm; do
  for i in $(seq 1 90); do
    st=$(docker inspect -f '{{.State.Health.Status}}' "$c" 2>/dev/null || echo none)
    [ "$st" = "healthy" ] && { ok "$c (${i}s)"; break; }
    [ "$i" = "90" ] && die "$c never became healthy - docker logs $c"
    sleep 1
  done
done

# ------------------------------------------------------------------ 3. java
step "domain service (java, :8080)"
if curl -sf --max-time 2 http://localhost:8080/health >/dev/null 2>&1; then
  ok "already running"
else
  JAR=$(ls -1 "$ROOT"/domain/target/domain-*.jar 2>/dev/null | grep -v original | head -1)
  # rebuild when any source is newer than the jar, so a stale build never runs
  if [ -n "$JAR" ] && [ -n "$(find "$ROOT/domain/src" "$ROOT/domain/pom.xml" -newer "$JAR" -type f 2>/dev/null | head -1)" ]; then
    echo "    sources changed since the last build; rebuilding..."
    JAR=""
  fi
  if [ -z "$JAR" ]; then
    echo "    building..."
    (cd "$ROOT/domain" && mvn -q -B -DskipTests package) || die "maven build failed"
    JAR=$(ls -1 "$ROOT"/domain/target/domain-*.jar | grep -v original | head -1)
  fi
  ( nohup java -jar "$JAR" > "$LOGS/domain.log" 2>&1 < /dev/null & )
  wait_http http://localhost:8080/health 60 "healthy" || {
    tail -25 "$LOGS/domain.log"; die "java never became healthy"; }
fi

# ---------------------------------------------------------------- 4. python
step "orchestrator (python, :8001)"
if curl -sf --max-time 2 http://localhost:8001/health >/dev/null 2>&1; then
  ok "already running"
else
  ( cd "$ROOT/orchestrator" && nohup uv run uvicorn app.main:app \
      --host "${ORCHESTRATOR_BIND:-0.0.0.0}" --port 8001 > "$LOGS/orchestrator.log" 2>&1 < /dev/null & )
  wait_http http://localhost:8001/health 90 "healthy" || {
    tail -25 "$LOGS/orchestrator.log"; die "orchestrator never became healthy"; }
fi

# ------------------------------------------------------------------ 5. rust
step "gateway (rust, :8000)"
if curl -sf --max-time 2 http://localhost:8000/health >/dev/null 2>&1; then
  ok "already running"
else
  BIN="$ROOT/gateway/target/release/logistream-gateway.exe"
  [ -x "$BIN" ] || BIN="$ROOT/gateway/target/release/logistream-gateway"
  if [ ! -x "$BIN" ] || [ -n "$(find "$ROOT/gateway/src" "$ROOT/gateway/Cargo.toml" -newer "$BIN" -type f 2>/dev/null | head -1)" ]; then
    echo "    building..."
    (cd "$ROOT/gateway" && cargo build --release) || die "cargo build failed"
  fi
  ( cd "$ROOT/gateway" && nohup "$BIN" > "$LOGS/gateway.log" 2>&1 < /dev/null & )
  wait_http http://localhost:8000/health 30 "healthy" || {
    tail -25 "$LOGS/gateway.log"; die "gateway never became healthy"; }
fi

# -------------------------------------------------------------------- 6. web
step "web (next, :3000)"
if curl -sf --max-time 2 http://localhost:3000 >/dev/null 2>&1; then
  ok "already running"
else
  [ -d "$ROOT/web/node_modules" ] || {
    echo "    npm install (first run only)..."
    (cd "$ROOT/web" && npm install >/dev/null 2>&1) || die "npm install failed"; }
  ( cd "$ROOT/web" && nohup npm run dev > "$LOGS/web.log" 2>&1 < /dev/null & )
  wait_http http://localhost:3000 90 "healthy" || {
    tail -25 "$LOGS/web.log"; die "next never became healthy"; }
fi

T1=$(date +%s)
echo
echo "${BOLD}up in $((T1 - T0))s${RESET}"
printf '  %-22s %s\n' "UI"            "http://localhost:3000"
printf '  %-22s %s\n' "gateway"       "http://localhost:8000"
printf '  %-22s %s\n' "orchestrator"  "http://localhost:8001"
printf '  %-22s %s\n' "domain"        "http://localhost:8080"
printf '  %-22s %s\n' "litellm"       "http://localhost:4000"
echo
echo "${DIM}next: bash demo/healthcheck.sh   then open the UI and press Reset${RESET}"
