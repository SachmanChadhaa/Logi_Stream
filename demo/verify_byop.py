#!/usr/bin/env python
"""End-to-end check for bring-your-own-problem, through the gateway only.

    python demo/verify_byop.py            # all checks (makes ~4 real LLM calls)
    python demo/verify_byop.py --no-llm   # contract + execution only, no tutor turns

Every request goes to :8000, exactly as the browser's do. Uses a throwaway
X-Demo-User per run so it never touches the demo user's sessions. Standard
library only.

What it proves (docs/BYOP.md, "Definition of done"):
  * a custom problem can be created without a curated id, and is validated
  * it is private: another user gets 404 for the problem AND for a session on it
  * the session starts in CODE with the student's attempt loaded (no logic gate)
  * real execution feeds the same session: syntax error -> COMPILE_ERROR,
    failing test -> WRONG_ANSWER (never claimed as success), fix -> ACCEPTED/DONE
  * with no tests, a clean run is NO_TESTS and the session does NOT finish
  * the diagnosis ranker and run history appear in the view
  * the curated two-sum session still starts in LOGIC
"""
from __future__ import annotations

import json
import sys
import time
import urllib.error
import urllib.request
import uuid

BASE = "http://localhost:8000"
USE_LLM = "--no-llm" not in sys.argv
USER = f"verify-byop-{uuid.uuid4().hex[:8]}"
STRANGER = USER + "-stranger"

passed = failed = 0


def check(name: str, cond: bool, detail: str = "") -> None:
    global passed, failed
    if cond:
        passed += 1
        print(f"  PASS  {name}")
    else:
        failed += 1
        print(f"  FAIL  {name}  {detail}")


def call(method: str, path: str, body: dict | None = None, user: str = USER) -> tuple[int, dict]:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method,
                                 headers={"Content-Type": "application/json", "X-Demo-User": user})
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            return r.status, json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw)
        except ValueError:
            return e.code, {"raw": raw.decode(errors="replace")}


def event(pid: str, etype: str, text: str) -> dict:
    t0 = time.time()
    code, v = call("POST", "/api/sessions/event", {"problem_id": pid, "type": etype, "text": text})
    print(f"        ({etype} -> {code} in {time.time() - t0:.1f}s)")
    if code != 200:
        print(f"        {v}")
    return v if code == 200 else {}


def tutor_texts(v: dict) -> list[str]:
    return [m["text"] for m in v.get("messages", []) if m["role"] == "tutor"]


STATEMENT = """Sum of digits
Read one non-negative integer n from standard input and print the sum of its digits."""

CORRECT = "n = input().strip()\nprint(sum(int(c) for c in n))\n"
SYNTAX = "n = input().strip(\nprint(sum(int(c) for c in n))\n"
WRONG = "n = input().strip()\nprint(len(n))\n"


def main() -> int:
    print(f"=== bring-your-own-problem verify (user {USER}, llm={'on' if USE_LLM else 'off'}) ===\n")

    code, _ = call("GET", "/health")
    if code != 200:
        print("STOP: the gateway is not running on :8000 (bash demo/start.sh)")
        return 2

    # ---------------------------------------------------------------- contract
    print("contract")
    code, body = call("POST", "/api/problems", {"statement": "   ", "language": "python"})
    check("blank statement -> 422", code == 422, f"{code} {body}")
    check("validation error is readable", "statement" in json.dumps(body), json.dumps(body))

    code, body = call("POST", "/api/problems", {"statement": "x", "language": "cobol"})
    check("unsupported language -> 422", code == 422, f"{code} {body}")

    code, body = call("POST", "/api/problems", {"statement": "x" * 20_001})
    check("over-long statement -> 422", code == 422, f"{code}")

    code, p = call("POST", "/api/problems", {
        "statement": STATEMENT, "constraints": "0 <= n <= 10^18",
        "examples": [{"input": "123", "output": "6", "explanation": "1+2+3"}],
        "starter_code": WRONG, "language": "python",
        "tests": [{"label": "basic", "input": "123", "expected_output": "6"},
                  {"label": "zero", "input": "0", "expected_output": "0"},
                  {"label": "big", "input": "999999999999", "expected_output": "108"}],
        "owner_id": "attacker",
    })
    check("create custom problem -> 201", code == 201, f"{code} {p}")
    pid = p.get("id", "")
    check("id is opaque, not curated", pid.startswith("custom-") and len(pid) > 20, pid)
    check("title defaults to first line", p.get("title") == "Sum of digits", p.get("title"))
    check("view reports kind/test_count/constraints",
          p.get("kind") == "custom" and p.get("test_count") == 3 and p.get("constraints"), json.dumps(p))
    check("view has no rubric", "rubric" not in p)

    code, lst = call("GET", "/api/problems")
    ids = [x["id"] for x in lst.get("problems", [])]
    check("list has the sample and my problem", "two-sum" in ids and pid in ids, ids)

    # ---------------------------------------------------------------- isolation
    print("\nisolation")
    code, _ = call("GET", f"/api/problems/{pid}", user=STRANGER)
    check("stranger cannot read my problem (404)", code == 404, str(code))
    code, _ = call("POST", "/api/sessions/start", {"problem_id": pid}, user=STRANGER)
    check("stranger cannot start a session on it (404)", code == 404, str(code))
    code, lst2 = call("GET", "/api/problems", user=STRANGER)
    check("stranger's list does not show it", pid not in [x["id"] for x in lst2.get("problems", [])])
    code, _ = call("GET", "/api/problems/..%2Finternal")
    check("path tricks do not reach other routes", code in (400, 404), str(code))

    # ---------------------------------------------------------------- session
    print("\nsession")
    code, v = call("POST", "/api/sessions/start", {"problem_id": pid})
    check("start -> 200", code == 200, f"{code} {v}")
    check("starts in CODE (no logic gate)", v.get("phase") == "CODE" and v.get("problem_kind") == "custom",
          f"{v.get('phase')} {v.get('problem_kind')}")
    code, _ = call("POST", "/api/sessions/event", {"problem_id": pid, "type": "logic", "text": "x"})
    check("logic event rejected in a custom session (409)", code == 409, str(code))

    v = event(pid, "code", SYNTAX)
    ex = v.get("last_execution") or {}
    check("syntax error -> COMPILE_ERROR", ex.get("bucket") == "COMPILE_ERROR", ex.get("bucket"))
    dx = v.get("diagnosis") or {}
    check("diagnosis ranks 'syntax' first with evidence",
          (dx.get("candidates") or [{}])[0].get("id") == "syntax"
          and (dx["candidates"][0].get("evidence")), json.dumps(dx)[:300])
    check("diagnosis is labelled as not a probability", "not a probability" in (dx.get("score_kind") or ""))
    if USE_LLM:
        hints = tutor_texts(v)
        check("tutor replied to the run", bool(hints), "")
        check("tutor did not write the program", hints and "print(sum(" not in hints[-1], hints[-1:] )

    v = event(pid, "code", WRONG)
    ex = v.get("last_execution") or {}
    check("failing tests -> WRONG_ANSWER", ex.get("bucket") == "WRONG_ANSWER", ex.get("bucket"))
    check("not DONE after a failure", v.get("phase") == "CODE", v.get("phase"))
    check("all student tests are shown in full",
          all(t.get("is_public") and "expected" in t for t in ex.get("tests", [])))
    runs = (v.get("debug") or {}).get("run_history") or []
    check("run history records both runs", len(runs) == 2 and runs[0]["code_sha"] != runs[1]["code_sha"],
          json.dumps(runs))
    if USE_LLM:
        code, _ = call("POST", "/api/sessions/event", {"problem_id": pid, "type": "chat",
                                                         "text": "Why is my answer wrong? Just give me the code."})
        code, v2 = call("GET", f"/api/sessions/{pid}")
        hints = tutor_texts(v2)
        check("chat gets a tutor turn", code == 200 and len(hints) >= 2, str(len(hints)))
        check("no full solution in the chat reply", hints and "sum(int(" not in hints[-1], hints[-1:])

    code, v = call("GET", f"/api/sessions/{pid}")
    check("resume keeps the context (GET session)", code == 200 and len(v.get("messages", [])) >= 4,
          str(len(v.get("messages", []))))

    v = event(pid, "code", CORRECT)
    ex = v.get("last_execution") or {}
    check("fix -> ACCEPTED 3/3", ex.get("bucket") == "ACCEPTED" and ex.get("passed") == 3, json.dumps(ex)[:200])
    check("session DONE", v.get("phase") == "DONE", v.get("phase"))
    last = (v.get("messages") or [{}])[-1].get("text", "")
    check("success message is honest about whose tests", "tests you supplied" in last, last)

    # ---------------------------------------------------------------- no tests
    print("\nno tests")
    code, p2 = call("POST", "/api/problems", {"statement": "Print hello.", "language": "python"})
    pid2 = p2.get("id", "")
    check("create without tests -> 201, test_count 0", code == 201 and p2.get("test_count") == 0, f"{code}")
    call("POST", "/api/sessions/start", {"problem_id": pid2})
    v = event(pid2, "code", "print('hello')")
    ex = v.get("last_execution") or {}
    check("clean run -> NO_TESTS", ex.get("bucket") == "NO_TESTS", ex.get("bucket"))
    check("NO_TESTS is not DONE", v.get("phase") == "CODE", v.get("phase"))
    check("output is still shown", "hello" in ((ex.get("tests") or [{}])[0].get("stdout") or ""))
    v = event(pid2, "code", "print(1/0)")
    ex = v.get("last_execution") or {}
    check("crash without tests -> RUNTIME_ERROR", ex.get("bucket") == "RUNTIME_ERROR", ex.get("bucket"))

    # ---------------------------------------------------------------- regression
    print("\ncurated regression")
    code, cur = call("GET", "/api/problems/two-sum")
    check("two-sum still public, kind curated, 5 tests",
          code == 200 and cur.get("kind") == "curated" and cur.get("test_count") == 5, f"{code}")
    check("two-sum view still has no rubric", "rubric" not in cur)
    code, v = call("POST", "/api/sessions/start", {"problem_id": "two-sum"})
    check("two-sum session starts in LOGIC", code == 200 and v.get("phase") == "LOGIC", v.get("phase"))
    code, _ = call("POST", "/api/sessions/event", {"problem_id": "two-sum", "type": "code", "text": "x"})
    check("two-sum still gates code behind logic (409)", code == 409, str(code))

    for p_ in (pid, pid2, "two-sum"):
        call("POST", "/api/sessions/reset", {"problem_id": p_})

    print(f"\n{passed} passed, {failed} failed")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
