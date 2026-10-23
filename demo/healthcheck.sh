#!/usr/bin/env bash
# Pre-demo health check (CLAUDE.md D3-T2).
#   bash demo/healthcheck.sh           cheap checks only
#   bash demo/healthcheck.sh --llm     also spend ONE real LLM call
#   bash demo/healthcheck.sh --exec    also run ONE real sandbox execution
#   bash demo/healthcheck.sh --full    both
#
# The live checks are opt-in on purpose. CLAUDE.md made the Judge0 smoke opt-in
# because it burned metered quota; execution is free now, but an LLM call still
# consumes free-tier rate-limit headroom, and burning it 60 seconds before you
# present is exactly the wrong trade.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
[ -f .env ] && { set -a; . ./.env; set +a; }

WANT_LLM=0; WANT_EXEC=0
for arg in "$@"; do
  case "$arg" in
    --llm)   WANT_LLM=1 ;;
    --exec)  WANT_EXEC=1 ;;
    --full)  WANT_LLM=1; WANT_EXEC=1 ;;
  esac
done

PY=python; command -v python >/dev/null 2>&1 || PY=python3
BOLD=$'\033[1m'; GREEN=$'\033[32m'; RED=$'\033[31m'; YELLOW=$'\033[33m'; DIM=$'\033[2m'; RESET=$'\033[0m'

pass=0; fail=0; warn=0
ok()   { printf '  %sok  %s %s\n'   "$GREEN"  "$RESET" "$1"; pass=$((pass+1)); }
no()   { printf '  %sFAIL%s %s\n'   "$RED"    "$RESET" "$1"; fail=$((fail+1)); }
warn() { printf '  %swarn%s %s\n'   "$YELLOW" "$RESET" "$1"; warn=$((warn+1)); }

echo "${BOLD}LogiStream — health check${RESET}"
echo

# --------------------------------------------------------------- 1. services
echo "${BOLD}services${RESET}"
check_http() {  # check_http <name> <url>
  if curl -sf --max-time 5 "$2" >/dev/null 2>&1; then ok "$1"; else no "$1 ($2)"; fi
}
if docker inspect -f '{{.State.Health.Status}}' logistream-postgres 2>/dev/null | grep -q healthy; then
  ok "postgres      :5432"
else
  no "postgres      :5432 (container not healthy)"
fi
if docker inspect -f '{{.State.Health.Status}}' logistream-litellm 2>/dev/null | grep -q healthy; then
  ok "litellm       :4000"
else
  no "litellm       :4000 (container not healthy)"
fi
check_http "domain (java) :8080" http://localhost:8080/health
check_http "orchestrator  :8001" http://localhost:8001/health
check_http "intel (rust)  :8003" http://127.0.0.1:${INTEL_PORT:-8003}/health
check_http "ollama        :11434" http://127.0.0.1:11434/api/version
if curl -s --max-time 5 http://localhost:8000/api/observer/status ${DEMO_PASSCODE:+-H "X-Demo-Passcode: $DEMO_PASSCODE"}      | grep -q '"available":true'; then
  ok "screen observer: local vision model ready"
else
  no "screen observer unavailable (ollama down or model not pulled) - tutoring still works"
fi
check_http "gateway       :8000" http://localhost:8000/health
check_http "web (next)    :3000" http://localhost:3000

# ------------------------------------------------------------------ 2. data
echo
echo "${BOLD}data${RESET}"
PROBLEM=$(curl -s --max-time 10 http://localhost:8000/api/problems/two-sum 2>/dev/null)
if echo "$PROBLEM" | grep -q '"title"'; then
  ok "problem two-sum reachable through the gateway"
  echo "$PROBLEM" | grep -q 'rubric' && no "  the public payload LEAKS the rubric" \
                                     || ok "  no rubric in the public payload"
else
  no "problem two-sum not reachable through the gateway"
fi

CACHED=$(docker compose exec -T postgres psql -U logistream -d logistream -At \
  -c "SELECT count(*) FROM orch.verdict_cache;" 2>/dev/null | tr -d '\r')
if [ -n "$CACHED" ]; then
  if [ "$CACHED" -ge 4 ] 2>/dev/null; then
    ok "verdict cache warm ($CACHED entries)"
  else
    warn "verdict cache has only ${CACHED:-0} entries - run: uv run python demo/prewarm.py"
  fi
else
  no "cannot read the verdict cache"
fi

THREADS=$(docker compose exec -T postgres psql -U logistream -d logistream -At \
  -c "SELECT count(DISTINCT thread_id) FROM checkpoints;" 2>/dev/null | tr -d '\r')
[ -n "$THREADS" ] && ok "checkpoint table present ($THREADS thread(s))" \
                  || no "checkpoint table missing - the orchestrator has never started"

# -------------------------------------------------------------- 3. live llm
echo
echo "${BOLD}llm${RESET}"
if [ "$WANT_LLM" = "1" ]; then
  RES=$(curl -s --max-time 120 http://localhost:4000/v1/chat/completions \
    -H "Authorization: Bearer ${LITELLM_MASTER_KEY:-sk-logistream-dev}" \
    -H 'Content-Type: application/json' \
    -d '{"model":"logistream-evaluator","messages":[{"role":"user","content":"Reply with exactly: OK"}],"temperature":0}' \
    | $PY -c "
import json,sys
try: d=json.load(sys.stdin)
except Exception: print('BAD unparseable'); raise SystemExit
if 'error' in d: print('BAD ' + json.dumps(d['error'])[:120])
else: print('OK ' + str(d.get('model')))
" 2>/dev/null)
  case "$RES" in
    OK*) ok "one real call succeeded, served by ${RES#OK }" ;;
    *)   no "live LLM call failed: ${RES#BAD }" ;;
  esac
else
  printf '  %sskip%s live LLM call (use --llm; it spends free-tier headroom)\n' "$DIM" "$RESET"
fi

# ------------------------------------------------------------- 4. live exec
echo
echo "${BOLD}sandbox${RESET}"
if [ "$WANT_EXEC" = "1" ]; then
  RES=$(curl -s --max-time 120 -X POST http://localhost:8080/internal/execute \
    -H 'Content-Type: application/json' \
    -H "X-Internal-Token: ${INTERNAL_TOKEN:-dev-internal-token-change-me}" \
    -d "$($PY -c "
import json
print(json.dumps({'problem_id':'two-sum','language':'python',
                  'source':open('demo/fixtures/code_correct.py',encoding='utf-8').read()}))
")" | $PY -c "
import json,sys
try: d=json.load(sys.stdin)
except Exception: print('BAD unparseable'); raise SystemExit
print(('OK %s %s/%s' % (d.get('bucket'), d.get('passed'), d.get('total')))
      if d.get('bucket')=='ACCEPTED' else 'BAD ' + json.dumps(d)[:120])
" 2>/dev/null)
  case "$RES" in
    OK*) ok "correct solution runs: ${RES#OK }" ;;
    *)   no "sandbox execution failed: ${RES#BAD }" ;;
  esac
else
  printf '  %sskip%s live execution (use --exec; free, but takes ~3s)\n' "$DIM" "$RESET"
fi

echo
if [ "$fail" -eq 0 ] && [ "$warn" -eq 0 ]; then
  echo "${GREEN}${BOLD}READY${RESET}  $pass checks passed"
elif [ "$fail" -eq 0 ]; then
  echo "${YELLOW}${BOLD}READY (with $warn warning(s))${RESET}  $pass checks passed"
else
  echo "${RED}${BOLD}NOT READY${RESET}  $fail failed, $warn warning(s), $pass passed"
fi
exit "$fail"
