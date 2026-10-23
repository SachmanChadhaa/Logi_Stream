"""Hidden-test redaction (CLAUDE.md sections 5.2, 5.4, 6.3).

Java returns full detail for every test, hidden ones included, because it trusts
Python. Python is where that trust stops. There are two consumers and they get
different amounts:

    strip_for_view()      -> the browser. Hidden tests keep label + pass/fail +
                             status and nothing else.
    summarize_for_tutor() -> the code tutor LLM. Same redaction, because a model
                             that has seen the hidden inputs will quote them back
                             to the student sooner or later.

Both are pure functions over Java's response so they can be unit-tested against
a fixture without running anything.
"""
from __future__ import annotations

from typing import Any

MAX_STDERR_EXCERPT = 1200


def _excerpt(text: str | None, limit: int = MAX_STDERR_EXCERPT) -> str:
    if not text:
        return ""
    text = text.strip()
    return text if len(text) <= limit else text[:limit] + "\n...[truncated]"


def strip_for_view(execution: dict[str, Any] | None) -> dict[str, Any] | None:
    """Java's execute response -> the `last_execution` block of a SessionView.

    A hidden test contributes its label, whether it passed, and its status. Its
    stdin, expected output and the student's stdout for it never leave this
    function.
    """
    if not execution:
        return None

    tests = []
    for t in execution.get("tests", []) or []:
        is_public = bool(t.get("is_public"))
        row: dict[str, Any] = {
            "index": t.get("index"),
            "label": t.get("label"),
            "is_public": is_public,
            "passed": bool(t.get("passed")),
            "status": t.get("status_description"),
            "time": t.get("time"),
            # stderr is the student's own traceback, so it is safe either way --
            # but it is truncated so a runaway trace cannot flood the UI
            "stderr_excerpt": _excerpt(t.get("stderr")),
        }
        if is_public:
            row["stdin"] = t.get("stdin")
            row["expected"] = t.get("expected")
            row["stdout"] = t.get("stdout")
        tests.append(row)

    return {
        "bucket": execution.get("bucket"),
        "passed": execution.get("passed", 0),
        "total": execution.get("total", 0),
        "tests": tests,
    }


def summarize_for_tutor(execution: dict[str, Any] | None) -> str:
    """Java's execute response -> the text the code tutor is allowed to see.

    Public tests are shown in full: the student can already see them, so the
    tutor may reason about concrete values. Hidden tests are reduced to a label
    and an outcome, which is enough to say "your code fails on negative numbers"
    without ever revealing what those numbers are.
    """
    if not execution:
        return "(no execution results)"

    lines = [
        f"BUCKET: {execution.get('bucket')}",
        f"PASSED: {execution.get('passed')}/{execution.get('total')}",
        "",
        "PER-TEST RESULTS",
    ]

    for t in execution.get("tests", []) or []:
        mark = "PASS" if t.get("passed") else "FAIL"
        status = t.get("status_description") or ""
        if t.get("is_public"):
            lines.append(f"- [{mark}] test {t.get('index')} '{t.get('label')}' ({status}) [public]")
            lines.append(f"    input    : {t.get('stdin')}")
            expected = t.get("expected")
            lines.append("    expected : (none -- no tests, nothing compared)" if expected is None
                         else f"    expected : {expected}")
            lines.append(f"    got      : {(t.get('stdout') or '').strip() or '(nothing)'}")
        else:
            # label and outcome only -- never the data
            lines.append(f"- [{mark}] test {t.get('index')} '{t.get('label')}' ({status}) [hidden]")

        err = _excerpt(t.get("stderr"), 600)
        if err:
            lines.append(f"    error    : {err}")

    return "\n".join(lines)


def first_failing_public_test(execution: dict[str, Any] | None) -> dict[str, Any] | None:
    """The concrete example the tutor should point the student at, if there is one."""
    for t in (execution or {}).get("tests", []) or []:
        if t.get("is_public") and not t.get("passed"):
            return t
    return None
