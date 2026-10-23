#!/usr/bin/env bash
# D1-T3 verify for the Java domain service (CLAUDE.md section 9).
# Re-runnable:  bash domain/verify.sh
#
# Starts the service if it is not already up, runs the checks, and stops it
# again only if it started it.
#
# With the default EXECUTOR_MODE=LOCAL this costs nothing and needs no network:
# the five execution checks run real python subprocesses on this host. Set
# EXECUTOR_MODE=JUDGE0 to exercise the hosted sandbox instead, which does cost
# quota; without a key those five checks are SKIPPED (not faked).
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

[ -f .env ] && { set -a; . ./.env; set +a; }
. scripts/env.sh

BASE="http://localhost:8080"
TOKEN="${INTERNAL_TOKEN:-dev-internal-token-change-me}"
LOG="$ROOT/demo/logs/domain-verify.log"
STARTED_BY_US=0
PID=""

pass=0; fail=0; skip=0
ok()   { printf '  PASS  %s\n' "$1"; pass=$((pass+1)); }
no()   { printf '  FAIL  %s\n' "$1"; fail=$((fail+1)); }
skipd(){ printf '  SKIP  %s\n' "$1"; skip=$((skip+1)); }

cleanup() {
  if [ "$STARTED_BY_US" = "1" ] && [ -n "$PID" ]; then
    echo; echo "stopping the service we started (pid $PID)"
    kill "$PID" 2>/dev/null
    wait "$PID" 2>/dev/null
  fi
}
trap cleanup EXIT

# ------------------------------------------------------------------ start up

mkdir -p "$ROOT/demo/logs"
if curl -sf --max-time 3 "$BASE/health" >/dev/null 2>&1; then
  echo "domain service already running on :8080"
else
  JAR=$(ls -1 "$ROOT"/domain/target/domain-*.jar 2>/dev/null | grep -v original | head -1)
  if [ -z "$JAR" ]; then
    echo "building domain service..."
    (cd "$ROOT/domain" && mvn -q -B -DskipTests package) || { echo "BUILD FAILED"; exit 1; }
    JAR=$(ls -1 "$ROOT"/domain/target/domain-*.jar | grep -v original | head -1)
  fi
  echo "starting $JAR (log: ${LOG#$ROOT/})"
  java -jar "$JAR" > "$LOG" 2>&1 &
  PID=$!
  STARTED_BY_US=1
  for i in $(seq 1 60); do
    curl -sf --max-time 2 "$BASE/health" >/dev/null 2>&1 && { echo "healthy after ${i}s"; break; }
    kill -0 "$PID" 2>/dev/null || { echo "SERVICE DIED - last 30 log lines:"; tail -30 "$LOG"; exit 1; }
    sleep 1
  done
  curl -sf --max-time 2 "$BASE/health" >/dev/null 2>&1 || {
    echo "SERVICE NEVER BECAME HEALTHY - last 30 log lines:"; tail -30 "$LOG"; exit 1; }
fi

PY=python; command -v python >/dev/null 2>&1 || PY=python3

echo
echo "=== D1-T3 verify: domain service ==="
echo

# ------------------------------------------------------- 1. public endpoints

echo "[public API]"
curl -s --max-time 10 "$BASE/health" -o /tmp/ls_health.json -w '%{http_code}' > /tmp/ls_code
[ "$(cat /tmp/ls_code)" = "200" ] && ok "GET /health -> 200" || no "GET /health -> $(cat /tmp/ls_code)"

curl -s --max-time 10 "$BASE/problems/two-sum" -o /tmp/ls_problem.json -w '%{http_code}' > /tmp/ls_code
if [ "$(cat /tmp/ls_code)" = "200" ]; then
  ok "GET /problems/two-sum -> 200"
  RES=$($PY - /tmp/ls_problem.json <<'PYEOF'
import json, sys
d = json.load(open(sys.argv[1], encoding="utf-8"))
raw = open(sys.argv[1], encoding="utf-8").read()
problems = []
for leaked in ("rubric", "harness_python", "hidden_tests", "tests", "rubric_version"):
    if leaked in d:
        problems.append("leaks field " + leaked)
for term in ("misconception", "socratic_counter", "forbidden_terms", "expected_output"):
    if term in raw:
        problems.append("body contains " + term)
for required in ("id", "title", "description", "examples", "starter_code", "language"):
    if required not in d:
        problems.append("missing field " + required)
if d.get("language") != "python":
    problems.append("language is %r" % d.get("language"))
print("OK" if not problems else "BAD " + "; ".join(problems))
PYEOF
)
  [ "$RES" = "OK" ] && ok "  ...carries no rubric and no hidden tests" || no "  ...${RES#BAD }"
else
  no "GET /problems/two-sum -> $(cat /tmp/ls_code)"
fi

curl -s --max-time 10 "$BASE/problems/nope" -o /dev/null -w '%{http_code}' > /tmp/ls_code
[ "$(cat /tmp/ls_code)" = "404" ] && ok "GET /problems/nope -> 404" || no "unknown problem -> $(cat /tmp/ls_code)"

# ------------------------------------------------------ 2. internal endpoints

echo
echo "[internal API auth]"
CODE=$(curl -s --max-time 10 -o /dev/null -w '%{http_code}' \
  -X POST "$BASE/internal/execute" -H 'Content-Type: application/json' \
  -d '{"problem_id":"two-sum","language":"python","source":"def two_sum(a,b): pass"}')
[ "$CODE" = "401" ] && ok "POST /internal/execute without a token -> 401" \
                    || no "POST /internal/execute without a token -> $CODE (expected 401)"

CODE=$(curl -s --max-time 10 -o /dev/null -w '%{http_code}' \
  -H "X-Internal-Token: definitely-wrong" "$BASE/internal/problems/two-sum/context")
[ "$CODE" = "401" ] && ok "GET /internal/.../context with a wrong token -> 401" \
                    || no "wrong token -> $CODE (expected 401)"

curl -s --max-time 10 -H "X-Internal-Token: $TOKEN" \
  "$BASE/internal/problems/two-sum/context" -o /tmp/ls_ctx.json -w '%{http_code}' > /tmp/ls_code
if [ "$(cat /tmp/ls_code)" = "200" ]; then
  RES=$($PY - /tmp/ls_ctx.json <<'PYEOF'
import json, sys
d = json.load(open(sys.argv[1], encoding="utf-8"))
bad = [f for f in ("id", "title", "description", "rubric", "rubric_version", "starter_code") if f not in d]
if not bad:
    r = d["rubric"]
    if r.get("entrypoint") != "two_sum":
        bad.append("rubric entrypoint is %r" % r.get("entrypoint"))
    if len(r.get("forbidden_terms_logic_tutor", [])) != 9:
        bad.append("forbidden_terms has %d entries" % len(r.get("forbidden_terms_logic_tutor", [])))
print("OK" if not bad else "BAD " + "; ".join(bad))
PYEOF
)
  [ "$RES" = "OK" ] && ok "GET /internal/.../context with the token -> rubric present" \
                    || no "context payload: ${RES#BAD }"
else
  no "GET /internal/.../context with the token -> $(cat /tmp/ls_code)"
fi

# ------------------------------------------------------------ 3. execution

echo
echo "[execution: local python sandbox]"

if true; then
  run_case() {  # run_case <label> <fixture> <expected-bucket> [expected-passed]
    local label="$1" fixture="$2" expected="$3" expect_passed="${4:-}"
    $PY - "$fixture" /tmp/ls_exec_req.json <<'PYEOF'
import json, sys
src = open(sys.argv[1], encoding="utf-8").read()
json.dump({"problem_id": "two-sum", "language": "python", "source": src},
          open(sys.argv[2], "w", encoding="utf-8"))
PYEOF
    local t0 t1
    t0=$(date +%s)
    curl -s --max-time 180 -X POST "$BASE/internal/execute" \
      -H 'Content-Type: application/json' -H "X-Internal-Token: $TOKEN" \
      --data-binary @/tmp/ls_exec_req.json -o /tmp/ls_exec.json
    t1=$(date +%s)

    local got
    got=$($PY - /tmp/ls_exec.json "$expected" "$expect_passed" <<'PYEOF'
import json, sys
try:
    d = json.load(open(sys.argv[1], encoding="utf-8"))
except Exception as e:
    print("BAD unparseable response: %s" % e); raise SystemExit(0)
if "bucket" not in d:
    print("BAD %s" % json.dumps(d)[:200]); raise SystemExit(0)
want, want_passed = sys.argv[2], sys.argv[3]
msgs = []
if d["bucket"] != want:
    msgs.append("bucket=%s (wanted %s)" % (d["bucket"], want))
if want_passed and str(d.get("passed")) != want_passed:
    msgs.append("passed=%s/%s (wanted %s)" % (d.get("passed"), d.get("total"), want_passed))
# hidden tests must still carry full detail here: Python strips them, not Java
if len(d.get("tests", [])) != 5:
    msgs.append("%d test results" % len(d.get("tests", [])))
print("OK %s %s/%s" % (d["bucket"], d.get("passed"), d.get("total")) if not msgs
      else "BAD " + "; ".join(msgs))
PYEOF
)
    if [ "${got:0:2}" = "OK" ]; then
      ok "$(printf '%-24s -> %s  (%ss)' "$label" "${got#OK }" "$((t1-t0))")"
    else
      no "$(printf '%-24s    %s' "$label" "${got#BAD }")"
      $PY -c "import json,sys;d=json.load(open('/tmp/ls_exec.json',encoding='utf-8'));[print('        test %s %-24s status=%s passed=%s %s'%(t['index'],t['label'],t.get('status_description'),t['passed'],(t.get('stderr') or '')[:90].replace(chr(10),' '))) for t in d.get('tests',[])]" 2>/dev/null
    fi
  }

  run_case "correct solution"  demo/fixtures/code_correct.py        ACCEPTED      5
  run_case "nested loop"       demo/fixtures/code_tle.py            TLE
  run_case "missing colon"     demo/fixtures/code_syntax_error.py   COMPILE_ERROR
  run_case "unguarded lookup"  demo/fixtures/code_runtime_error.py  RUNTIME_ERROR
  run_case "returns values"    demo/fixtures/code_returns_values.py WRONG_ANSWER

  echo
  echo "  sandbox in use:"
  grep -o 'execution sandbox: .*' "$LOG" 2>/dev/null | tail -1 | sed 's/^/    /' || true
  echo "  billed upstream requests per run (0 means nothing metered was called):"
  grep -o 'requests=[0-9]*' "$LOG" 2>/dev/null | tail -5 | sed 's/^/    /' || true
fi

echo
echo "=== D1-T3 VERIFY: $pass passed, $fail failed, $skip skipped ==="
exit "$fail"
