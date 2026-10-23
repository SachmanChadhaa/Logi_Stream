"""Bring-your-own-problem: state, diagnosis ranker, temporal memory, view, verifier.

All pure: no LLM, no sandbox, no database.
"""
from __future__ import annotations

from app import diagnostics, redact, verifier
from app.nodes.code_tutor import hint_level
from app.state import initial_state
from app.view import build_session_view

CODE = """\
def mean(xs):
    total = 0
    for x in xs:
        total += x
    return total / len(xs)

print(mean([]))
"""

ZERO_DIV = {
    "bucket": "RUNTIME_ERROR", "passed": 0, "total": 1,
    "tests": [{
        "index": 1, "label": "empty", "is_public": True, "passed": False,
        "status_description": "Runtime Error (NZEC)", "stdin": "", "expected": "0",
        "stdout": "",
        "stderr": 'Traceback (most recent call last):\n'
                  '  File "C:\\\\tmp\\\\solution.py", line 7, in <module>\n'
                  '    print(mean([]))\n'
                  '  File "C:\\\\tmp\\\\solution.py", line 5, in mean\n'
                  '    return total / len(xs)\n'
                  'ZeroDivisionError: division by zero',
    }],
}


def _wrong(stdout: str, expected: str) -> dict:
    return {
        "bucket": "WRONG_ANSWER", "passed": 0, "total": 2,
        "tests": [
            {"index": 1, "label": "basic", "is_public": True, "passed": False,
             "status_description": "Accepted", "stdin": "1 2", "expected": expected,
             "stdout": stdout, "stderr": ""},
            {"index": 2, "label": "secret", "is_public": False, "passed": False,
             "status_description": "Accepted", "stdin": "HIDDEN-IN", "expected": "HIDDEN-OUT",
             "stdout": "HIDDEN-GOT", "stderr": ""},
        ],
    }


# ---------------------------------------------------------------- state

def test_custom_session_starts_in_code_with_the_attempt_loaded():
    s = initial_state("custom-x", "u", "t", kind="custom", starter_code="print(1)")
    assert s["phase"] == "CODE" and s["status"] == "CODE_WRITE"
    assert s["problem_kind"] == "custom"
    assert s["user_code"] == "print(1)"
    assert s["run_history"] == [] and s["last_diagnosis"] is None


def test_curated_session_is_unchanged():
    s = initial_state("two-sum", "u", "t")
    assert s["phase"] == "LOGIC" and s["status"] == "LOGIC_WRITE"
    assert s["problem_kind"] == "curated"
    assert s["user_code"] == ""


# ------------------------------------------------------------ diagnosis

def test_runtime_error_points_at_the_students_own_line():
    d = diagnostics.rank(ZERO_DIV, CODE, [])
    top = d["candidates"][0]
    assert top["id"] == "division-by-zero"
    assert any("line 5: return total / len(xs)" in e for e in top["evidence"])
    assert any("ZeroDivisionError" in e for e in top["evidence"])
    assert d["ranker"] == diagnostics.RANKER_VERSION
    assert "not a probability" in d["score_kind"]


def test_error_line_skips_frames_in_the_appended_harness():
    stderr = 'File "x/solution.py", line 2, in f\nFile "x/solution.py", line 99, in <module>'
    assert diagnostics.error_line(stderr, "a\nb\nc")[0] == 2


def test_syntax_error():
    ex = {"bucket": "COMPILE_ERROR", "tests": [{"stderr": 'File "s/solution.py", line 1\n'
                                                          "    def f(\n"
                                                          "SyntaxError: '(' was never closed"}]}
    d = diagnostics.rank(ex, "def f(\n", [])
    assert d["candidates"][0]["id"] == "syntax"


def test_wrong_answer_rules():
    assert diagnostics.rank(_wrong("", "3"), "x", [])["candidates"][0]["id"] == "prints-nothing"
    assert diagnostics.rank(_wrong("None", "3"), "x", [])["candidates"][0]["id"] == "returns-none"
    assert diagnostics.rank(_wrong("[1,2]", "[1, 2]"), "x", [])["candidates"][0]["id"] == "output-format"
    assert diagnostics.rank(_wrong("debug\n3", "3"), "x", [])["candidates"][0]["id"] == "extra-output"
    assert diagnostics.rank(_wrong("4", "3"), "x", [])["candidates"][0]["id"] == "logic-wrong-on-case"


def test_diagnosis_never_contains_hidden_test_data():
    d = diagnostics.rank(_wrong("4", "3"), "x", [])
    blob = repr(d)
    assert "HIDDEN" not in blob


def test_tle_notices_nested_loops():
    code = "for i in a:\n    for j in a:\n        pass\n"
    d = diagnostics.rank({"bucket": "TLE", "tests": []}, code, [])
    assert d["candidates"][0]["id"] == "too-slow"
    assert "loops nested 2 deep" in d["candidates"][0]["evidence"]


def test_no_tests_is_never_reported_as_correct():
    ex = {"bucket": "NO_TESTS", "passed": 0, "total": 0,
          "tests": [{"index": 1, "is_public": True, "passed": False, "stdout": "42\n",
                     "expected": None, "stderr": ""}]}
    d = diagnostics.rank(ex, "print(42)", [])
    assert d["candidates"][0]["id"] == "unverified"
    entry = diagnostics.history_entry(ex, "print(42)", d, "ts")
    assert entry["verified"] is False


def test_unchanged_code_is_noticed():
    first = diagnostics.history_entry(ZERO_DIV, CODE, diagnostics.rank(ZERO_DIV, CODE, []), "t1")
    d = diagnostics.rank(ZERO_DIV, CODE, [first])
    assert "unchanged-code" in [c["id"] for c in d["candidates"]] or \
        d["features"]["code_changed_since_last_run"] is False
    assert d["features"]["same_bucket_streak"] == 1


def test_features_are_versioned_and_flat():
    f = diagnostics.features(ZERO_DIV, CODE, [])
    assert f["schema"] == diagnostics.FEATURE_SCHEMA_VERSION
    assert all(not isinstance(v, (dict, list)) for v in f.values())


# -------------------------------------------------------- temporal memory

def test_history_summary_and_hint_escalation():
    e = diagnostics.history_entry(ZERO_DIV, CODE, diagnostics.rank(ZERO_DIV, CODE, []), "t")
    assert hint_level([]) == 1
    assert hint_level([e]) == 1
    assert hint_level([e, e]) == 2
    assert hint_level([e, e, e, e]) == 3
    other = dict(e, top_cause="syntax")
    assert hint_level([e, e, other]) == 1, "a new failure starts gently again"
    text = diagnostics.describe_history([e], diagnostics.code_sha(CODE))
    assert "RUNTIME_ERROR" in text and "identical" in text


# ------------------------------------------------------------------ view

def test_view_exposes_kind_and_diagnosis_but_not_features():
    s = initial_state("custom-x", "u", "t", kind="custom")
    s["last_diagnosis"] = diagnostics.rank(ZERO_DIV, CODE, [])
    v = build_session_view(s, thread_id="t")
    assert v["problem_kind"] == "custom"
    assert v["diagnosis"]["candidates"]
    assert "features" not in v["diagnosis"]
    assert v["debug"]["run_history"] == []


def test_tutor_summary_says_when_nothing_was_compared():
    ex = {"bucket": "NO_TESTS", "passed": 0, "total": 0,
          "tests": [{"index": 1, "label": "run", "is_public": True, "passed": False,
                     "status_description": "Ran", "stdin": "", "expected": None,
                     "stdout": "42", "stderr": ""}]}
    assert "nothing compared" in redact.summarize_for_tutor(ex)


# ----------------------------------------------------- LLM-down fallback

def test_fallback_hint_carries_the_evidence_and_passes_the_verifier():
    d = diagnostics.rank(ZERO_DIV, CODE, [])
    hint = diagnostics.fallback_hint(ZERO_DIV, d)
    assert hint.startswith("Verified: RUNTIME_ERROR, 0/1")
    assert "Hypothesis:" in hint and "line 5" in hint
    assert verifier.verify_code_draft(hint, {}, verifier.defined_functions(CODE)).ok


def test_fallback_hint_never_calls_no_tests_correct():
    ex = {"bucket": "NO_TESTS", "passed": 0, "total": 0, "tests": []}
    assert "nothing about its output is verified" in diagnostics.fallback_hint(ex, None)
    assert verifier.verify_code_draft(diagnostics.fallback_hint(None, None), {}).ok


# -------------------------------------------------------------- verifier

def test_students_own_function_names_are_protected():
    draft = "Try this:\ndef mean(xs):\n    return 0"
    assert verifier.verify_code_draft(draft, {}).ok
    r = verifier.verify_code_draft(draft, {}, verifier.defined_functions(CODE))
    assert not r.ok and "def mean" in r.reasons[0]


def test_defined_functions():
    assert verifier.defined_functions(CODE) == ["mean"]
    assert verifier.defined_functions("") == []
