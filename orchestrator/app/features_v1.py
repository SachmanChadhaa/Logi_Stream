"""feature_schema_v1: one fixed-length float vector per session event.

The contract between Python (which builds the vector) and the Rust `intel/`
sidecar (the GRU and the booster, which consume it). The spec lives in
docs/feature_schema_v1.md and a golden vector in intel/tests/golden_v1.json is
checked by BOTH test suites, so the two sides cannot drift silently.

Rules:
  * the order of FEATURES is the vector layout -- never reorder or repurpose a
    slot; a change means feature_schema_v2
  * every value is a float in [0, 1] (one-hots, flags, clipped ratios)
  * no hidden-test data and no raw code or screen content ever enters a vector
"""
from __future__ import annotations

from typing import Any

SCHEMA_VERSION = "feature_schema_v1"

ERROR_CATEGORIES = ("none", "compile", "runtime", "failing_test", "timeout")

# GRU outputs (intel/): student state, and coarse cause groups
STUDENT_STATES = ("progressing", "stuck", "thrashing", "idle")
CAUSE_GROUPS = ("syntax", "runtime", "performance", "output", "logic", "unverified")

# Booster label space: the rules ranker's candidate ids (diagnostics.py)
CAUSES = (
    "syntax", "undefined-name", "missing-key", "index-out-of-range", "type-mismatch",
    "uses-none", "missing-attribute", "bad-conversion", "division-by-zero",
    "unbounded-recursion", "reads-too-much-input", "module-unavailable", "runtime-crash",
    "too-slow", "possible-infinite-loop", "prints-nothing", "returns-none",
    "output-format", "extra-output", "logic-wrong-on-case", "unverified", "unchanged-code",
)
EVENT_KINDS = ("run", "chat", "observation", "idle")

# bucket -> error category
_BUCKET_CATEGORY = {
    "ACCEPTED": "none",
    "NO_TESTS": "none",
    "COMPILE_ERROR": "compile",
    "RUNTIME_ERROR": "runtime",
    "WRONG_ANSWER": "failing_test",
    "TLE": "timeout",
}

FEATURES: tuple[str, ...] = (
    "lang_python",
    *(f"err_{c}" for c in ERROR_CATEGORIES),       # 1..5
    "has_error_line",
    "exception_known",
    "pass_ratio",
    "n_tests_norm",
    "stdout_empty_on_fail",
    "format_only_mismatch",
    "edit_size_norm",
    "changed_lines_norm",
    "code_unchanged",
    "dt_since_last_norm",
    "attempt_norm",
    "same_bucket_streak_norm",
    "recent_fail_rate",
    "stage_custom",
    *(f"event_{k}" for k in EVENT_KINDS),          # 20..23
    "vlm_error_visible",
    "vlm_editing",
    "vlm_terminal",
    "vlm_offtask",
    "loop_nesting_norm",
    "has_while_true",
)
DIM = len(FEATURES)            # 30
assert DIM == 30


def _clip(x: float) -> float:
    return 0.0 if x < 0 else 1.0 if x > 1 else float(x)


def error_category(bucket: str | None) -> str:
    return _BUCKET_CATEGORY.get(bucket or "", "none")


def build(
    *,
    event_kind: str,
    diag_features: dict[str, Any] | None = None,
    changed_lines: int = 0,
    code_lines: int = 0,
    dt_since_last_s: float = 0.0,
    run_history: list[dict[str, Any]] | None = None,
    problem_kind: str = "curated",
    language: str = "python",
    vlm_tags: dict[str, bool] | None = None,
) -> list[float]:
    """The vector for one event. `diag_features` is diagnostics.features() for a
    run event (None for chat/observation/idle events)."""
    f = diag_features or {}
    history = run_history or []
    tags = vlm_tags or {}
    cat = error_category(f.get("bucket")) if event_kind == "run" else "none"

    recent = history[-5:]
    fail_rate = (sum(1 for h in recent if h.get("bucket") not in ("ACCEPTED", "NO_TESTS"))
                 / len(recent)) if recent else 0.0

    v: dict[str, float] = {
        "lang_python": 1.0 if language == "python" else 0.0,
        **{f"err_{c}": 1.0 if c == cat else 0.0 for c in ERROR_CATEGORIES},
        "has_error_line": 1.0 if f.get("has_error_line") else 0.0,
        "exception_known": 1.0 if f.get("exception_type") else 0.0,
        "pass_ratio": _clip(f.get("pass_ratio") or 0.0),
        "n_tests_norm": _clip((f.get("n_tests") or 0) / 20),
        "stdout_empty_on_fail": 1.0 if f.get("stdout_empty_on_fail") else 0.0,
        "format_only_mismatch": 1.0 if f.get("format_only_mismatch") else 0.0,
        "edit_size_norm": _clip(changed_lines / max(1, code_lines)),
        "changed_lines_norm": _clip(changed_lines / 50),
        "code_unchanged": 1.0 if (event_kind == "run" and not f.get("code_changed_since_last_run", True))
        else 0.0,
        "dt_since_last_norm": _clip(dt_since_last_s / 600),
        "attempt_norm": _clip(len(history) / 20),
        "same_bucket_streak_norm": _clip((f.get("same_bucket_streak") or 0) / 5),
        "recent_fail_rate": _clip(fail_rate),
        "stage_custom": 1.0 if problem_kind == "custom" else 0.0,
        **{f"event_{k}": 1.0 if k == event_kind else 0.0 for k in EVENT_KINDS},
        "vlm_error_visible": 1.0 if tags.get("error_visible") else 0.0,
        "vlm_editing": 1.0 if tags.get("editing") else 0.0,
        "vlm_terminal": 1.0 if tags.get("terminal") else 0.0,
        "vlm_offtask": 1.0 if tags.get("offtask") else 0.0,
        "loop_nesting_norm": _clip((f.get("loop_nesting") or 0) / 3),
        "has_while_true": 1.0 if f.get("has_while_true") else 0.0,
    }
    return [round(v[name], 6) for name in FEATURES]
