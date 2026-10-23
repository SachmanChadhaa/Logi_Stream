"""Diagnostic ranking: the rules baseline (docs/BYOP.md, plan step 8).

Given the evidence from one code run -- bucket, per-test results, stderr, the
student's code and the session's earlier runs -- rank the likely causes and the
next debugging action for each.

WHAT THIS IS, AND WHAT IT IS NOT
  * A transparent, deterministic rules baseline. Every candidate carries the
    evidence that produced it, quoted from real output, so the tutor (and the
    "Under the hood" panel) can show *why*.
  * The reference point an XGBoost ranker must beat. `features()` emits the
    versioned, flat feature vector that ranker will be trained on once labelled
    outcomes exist. No model is trained yet, and nothing here claims one is.
  * Scores are rule weights for ORDERING ONLY. They are not probabilities and
    are never labelled as such.
  * Advisory. The tutor decides relevance; nothing here edits code or runs
    anything.

Pure functions over plain dicts, so the whole thing is unit-tested without a
sandbox, an LLM or a database.
"""
from __future__ import annotations

import hashlib
import re
from typing import Any

RANKER_VERSION = "rules-v1"
FEATURE_SCHEMA_VERSION = "diag-features-v1"
MAX_CANDIDATES = 3

# the sandbox writes the student's file as solution.py; harness lines follow it
_TRACE_LINE_RE = re.compile(r'File "[^"]*solution\.py", line (\d+)')
_EXC_RE = re.compile(r"^(\w+(?:Error|Exception|Interrupt|Exit))\b:?\s*(.*)$", re.MULTILINE)
_NAME_ERROR_RE = re.compile(r"name '([^']+)' is not defined")


def code_sha(code: str) -> str:
    return hashlib.sha256((code or "").encode("utf-8")).hexdigest()[:12]


# ---------------------------------------------------------------------------
# evidence extraction
# ---------------------------------------------------------------------------

def _all_stderr(execution: dict[str, Any]) -> str:
    return "\n".join((t.get("stderr") or "") for t in execution.get("tests") or [])


def exception_of(stderr: str) -> tuple[str | None, str]:
    """The LAST exception line of a traceback: (type, message)."""
    found = _EXC_RE.findall(stderr or "")
    if not found:
        return None, ""
    etype, msg = found[-1]
    return etype, msg.strip()


def error_line(stderr: str, student_code: str) -> tuple[int | None, str]:
    """(line number, source text) of the deepest frame inside the student's own code.

    Frames past the end of the student's code are the appended harness, which
    the student did not write, so they are skipped.
    """
    lines = (student_code or "").splitlines()
    hits = [int(n) for n in _TRACE_LINE_RE.findall(stderr or "")]
    for n in reversed(hits):
        if 1 <= n <= len(lines):
            return n, lines[n - 1].strip()
    # SyntaxError reports the line differently: '  File "...", line N' still
    # matches above; anything else gives no line
    return None, ""


def _nested_loop_depth(code: str) -> int:
    """Deepest nesting of for/while loops, by indentation. Crude and honest about it."""
    stack: list[int] = []
    deepest = 0
    for raw in (code or "").splitlines():
        if not raw.strip() or raw.lstrip().startswith("#"):
            continue
        indent = len(raw) - len(raw.lstrip())
        while stack and indent <= stack[-1]:
            stack.pop()
        if re.match(r"\s*(for|while)\b", raw):
            stack.append(indent)
            deepest = max(deepest, len(stack))
    return deepest


def _norm_ws(s: str | None) -> str:
    return re.sub(r"\s+", "", s or "")


def _failing_public(execution: dict[str, Any]) -> list[dict[str, Any]]:
    return [t for t in execution.get("tests") or []
            if t.get("is_public") and not t.get("passed") and t.get("expected") is not None]


# ---------------------------------------------------------------------------
# features (the XGBoost contract)
# ---------------------------------------------------------------------------

def features(
    execution: dict[str, Any] | None,
    student_code: str,
    run_history: list[dict[str, Any]] | None,
    *,
    language: str = "python",
    problem_kind: str = "curated",
) -> dict[str, Any]:
    """Flat, versioned features for one run. Only add fields; never repurpose one.

    Hidden-test data never appears here: only counts and statuses, so a future
    training set cannot leak hidden inputs either.
    """
    execution = execution or {}
    history = run_history or []
    stderr = _all_stderr(execution)
    etype, _ = exception_of(stderr)
    line_no, _ = error_line(stderr, student_code)
    tests = execution.get("tests") or []
    failing_public = _failing_public(execution)
    first_fail = failing_public[0] if failing_public else None

    stdout_fail = (first_fail or {}).get("stdout") or ""
    expected_fail = (first_fail or {}).get("expected") or ""

    prev = history[-1] if history else None
    sha = code_sha(student_code)
    bucket = execution.get("bucket")

    streak = 0
    for h in reversed(history):
        if h.get("bucket") == bucket:
            streak += 1
        else:
            break

    return {
        "schema": FEATURE_SCHEMA_VERSION,
        "language": language,
        "problem_kind": problem_kind,
        "bucket": bucket,
        "exception_type": etype,
        "has_error_line": line_no is not None,
        "n_tests": len(tests),
        "n_passed": int(execution.get("passed") or 0),
        "pass_ratio": (execution.get("passed") or 0) / max(1, execution.get("total") or 0),
        "n_public_failing": len(failing_public),
        "stdout_empty_on_fail": bool(first_fail) and not stdout_fail.strip(),
        "stdout_is_none_on_fail": bool(first_fail) and stdout_fail.strip() == "None",
        "format_only_mismatch": bool(first_fail) and _norm_ws(stdout_fail) == _norm_ws(expected_fail)
                                and stdout_fail.strip() != expected_fail.strip(),
        "expected_contained_in_stdout": bool(first_fail) and bool(expected_fail.strip())
                                        and expected_fail.strip() in stdout_fail
                                        and stdout_fail.strip() != expected_fail.strip(),
        "code_lines": len((student_code or "").splitlines()),
        "loop_nesting": _nested_loop_depth(student_code),
        "has_while_true": bool(re.search(r"while\s+(True|1)\s*:", student_code or "")),
        "run_index": len(history) + 1,
        "code_changed_since_last_run": prev is None or prev.get("code_sha") != sha,
        "same_bucket_streak": streak,
    }


# ---------------------------------------------------------------------------
# the rules
# ---------------------------------------------------------------------------

def _cand(cid: str, cause: str, action: str, score: float, evidence: list[str]) -> dict[str, Any]:
    return {"id": cid, "cause": cause, "next_action": action,
            "score": round(score, 2), "evidence": [e for e in evidence if e]}


_EXCEPTION_RULES: dict[str, tuple[str, str, str]] = {
    "NameError": ("undefined-name", "A name is used before it is defined (or is misspelt).",
                  "Find where that name is first assigned, and check its spelling and scope."),
    "KeyError": ("missing-key", "A lookup asked for a key that is not there.",
                 "Before that lookup, check whether the key can be missing on this input."),
    "IndexError": ("index-out-of-range", "An index went past the end of a sequence.",
                   "Print the index and the length just before the failing line; look for an off-by-one."),
    "TypeError": ("type-mismatch", "A value has a different type than the code assumes.",
                  "Print type(...) of each operand on the failing line."),
    "AttributeError": ("missing-attribute", "A method or attribute is used on a value that does not have it.",
                       "Check what type that value really is at that point -- often None."),
    "ValueError": ("bad-conversion", "A conversion or unpacking got a value it cannot handle.",
                   "Print the raw value just before the conversion; check how the input is split."),
    "ZeroDivisionError": ("division-by-zero", "A division by zero happened.",
                          "Find which input makes the divisor zero and decide what should happen then."),
    "RecursionError": ("unbounded-recursion", "The recursion never reaches its base case.",
                       "Trace the arguments of each call on a tiny input: do they move toward the base case?"),
    "EOFError": ("reads-too-much-input", "The program tried to read more input than it was given.",
                 "Compare how many lines your code reads with the input format in the statement."),
    "ModuleNotFoundError": ("module-unavailable", "An import is not available in the sandbox.",
                            "Use only the standard library."),
    "ImportError": ("module-unavailable", "An import is not available in the sandbox.",
                    "Use only the standard library."),
}


def rank(
    execution: dict[str, Any] | None,
    student_code: str,
    run_history: list[dict[str, Any]] | None = None,
    *,
    language: str = "python",
    problem_kind: str = "curated",
) -> dict[str, Any]:
    """Ranked candidate causes for one run, each with quoted evidence."""
    execution = execution or {}
    f = features(execution, student_code, run_history,
                 language=language, problem_kind=problem_kind)
    bucket = f["bucket"]
    stderr = _all_stderr(execution)
    etype, emsg = exception_of(stderr)
    line_no, line_src = error_line(stderr, student_code)
    where = f"line {line_no}: {line_src}" if line_no else ""
    exc = f"{etype}: {emsg}".strip(": ") if etype else ""

    out: list[dict[str, Any]] = []

    if bucket == "COMPILE_ERROR":
        out.append(_cand("syntax", "Python could not parse the file.",
                         "Look at the reported line and the one just above it: a missing colon, "
                         "bracket or mismatched indentation.", 0.95, [exc, where]))

    elif bucket == "RUNTIME_ERROR":
        cid, cause, action = _EXCEPTION_RULES.get(
            etype or "", ("runtime-crash", "The program crashed while running.",
                          "Read the last line of the traceback, then the line it points at."))
        if etype == "TypeError" and "NoneType" in emsg:
            cid, cause, action = ("uses-none", "A value is None where the code expects something else.",
                                  "Find what produced that None -- often a function that falls off "
                                  "its end without returning.")
        out.append(_cand(cid, cause, action, 0.9, [exc, where]))
        if etype == "NameError":
            m = _NAME_ERROR_RE.search(emsg)
            if m:
                out[-1]["evidence"].append(f"undefined name: {m.group(1)}")

    elif bucket == "TLE":
        ev = []
        if f["loop_nesting"] >= 2:
            ev.append(f"loops nested {f['loop_nesting']} deep")
        if f["has_while_true"]:
            ev.append("contains `while True`")
        if f["has_while_true"]:
            out.append(_cand("possible-infinite-loop", "A loop may never terminate.",
                             "Check that every path through the loop changes the condition or breaks.",
                             0.75, ev))
        out.append(_cand("too-slow", "The approach does too much work for the input size.",
                         "Estimate how many steps your loops take on the largest allowed input.",
                         0.7 if f["loop_nesting"] >= 2 else 0.5, ev))

    elif bucket == "WRONG_ANSWER":
        fp = _failing_public(execution)
        first = fp[0] if fp else None
        case_ev = (f"test '{first.get('label')}': expected {str(first.get('expected')).strip()!r}, "
                   f"got {(first.get('stdout') or '').strip()!r}") if first else ""
        if f["stdout_empty_on_fail"]:
            out.append(_cand("prints-nothing", "The program produced no output.",
                             "Check that the answer is actually printed, and that the function is called.",
                             0.85, [case_ev]))
        if f["stdout_is_none_on_fail"]:
            out.append(_cand("returns-none", "The answer printed is None.",
                             "Find the path through your function that ends without a return.",
                             0.85, [case_ev]))
        if f["format_only_mismatch"]:
            out.append(_cand("output-format", "The values look right but the format differs.",
                             "Compare spacing, brackets and separators character by character.",
                             0.8, [case_ev]))
        if f["expected_contained_in_stdout"]:
            out.append(_cand("extra-output", "The right answer is there, plus extra output.",
                             "Remove debug prints, or anything printed besides the answer.",
                             0.8, [case_ev]))
        out.append(_cand("logic-wrong-on-case", "The code runs but computes the wrong result for some input.",
                         "Trace your code by hand on the first failing example and find the first "
                         "step where it differs from what you expect.",
                         0.6 if first else 0.5, [case_ev]))

    elif bucket == "NO_TESTS":
        runs = execution.get("tests") or []
        stdout = (runs[0].get("stdout") or "").strip() if runs else ""
        out.append(_cand("unverified", "The program ran, but there were no tests, so nothing is verified.",
                         "Add a test with an input and its expected output, or check the output by hand "
                         "against a worked example.", 0.6,
                         [f"output: {stdout[:120]!r}" if stdout else "no output was printed"]))

    if (bucket not in (None, "ACCEPTED", "INFRA_ERROR")
            and not f["code_changed_since_last_run"]):
        out.append(_cand("unchanged-code", "This is the same code as the previous run.",
                         "Change one thing based on the evidence, then run again.", 0.4,
                         ["code identical to the previous run"]))

    out.sort(key=lambda c: -c["score"])
    return {
        "ranker": RANKER_VERSION,
        "score_kind": "rule weight (ordering only, not a probability)",
        "bucket": bucket,
        "candidates": out[:MAX_CANDIDATES],
        "features": f,
    }


TUTOR_UNAVAILABLE_NOTE = "(The AI tutor is unavailable right now; this hint comes from the automatic diagnosis.)"


def fallback_hint(execution: dict[str, Any] | None, diagnosis: dict[str, Any] | None) -> str:
    """A tutor turn that needs no LLM, for when the LLM is down.

    Built only from what the sandbox showed and the rules ranker, so the run's
    evidence still reaches the student instead of being lost behind a 500. Short
    and code-free, so it passes verify_code like any other draft.
    """
    if not execution:
        return ("The AI tutor is unavailable right now. Run your code to get an "
                "automatic diagnosis of what happens, or try again in a minute.")

    bucket = execution.get("bucket")
    if bucket == "NO_TESTS":
        verified = "Verified: your program ran, but there are no tests, so nothing about its output is verified."
    else:
        verified = (f"Verified: {bucket}, {execution.get('passed', 0)}/{execution.get('total', 0)} "
                    "tests passed.")

    parts = [verified]
    top = ((diagnosis or {}).get("candidates") or [None])[0]
    if top:
        # the exception and the line it points at, when both exist
        ev = "; ".join((top.get("evidence") or [])[:2])
        parts.append(f"Hypothesis: {top.get('cause')}" + (f" Evidence: {ev}" if ev else ""))
        parts.append(f"Next: {top.get('next_action')}")
    parts.append(TUTOR_UNAVAILABLE_NOTE)
    return "\n".join(parts)


def history_entry(
    execution: dict[str, Any],
    student_code: str,
    diagnosis: dict[str, Any] | None,
    ts: str,
) -> dict[str, Any]:
    """One compact temporal-memory record per run. No test data, no full code."""
    top = ((diagnosis or {}).get("candidates") or [{}])[0]
    return {
        "ts": ts,
        "bucket": execution.get("bucket"),
        "passed": execution.get("passed", 0),
        "total": execution.get("total", 0),
        "code_sha": code_sha(student_code),
        "top_cause": top.get("id"),
        "verified": execution.get("bucket") in ("ACCEPTED", "WRONG_ANSWER", "TLE",
                                                "RUNTIME_ERROR", "COMPILE_ERROR")
                    and (execution.get("total") or 0) > 0,
    }


def describe_history(history: list[dict[str, Any]] | None, current_sha: str | None = None) -> str:
    """Prompt-ready summary of earlier runs: what changed, what happened."""
    if not history:
        return "(this is the first run)"
    lines = []
    for i, h in enumerate(history[-5:], start=max(1, len(history) - 4)):
        lines.append(f"- run {i} at {h.get('ts')}: {h.get('bucket')} "
                     f"{h.get('passed')}/{h.get('total')}, top cause {h.get('top_cause') or '-'}, "
                     f"code {h.get('code_sha')}")
    if current_sha and history[-1].get("code_sha") == current_sha:
        lines.append("NOTE: the current code is identical to the last run.")
    return "\n".join(lines)
