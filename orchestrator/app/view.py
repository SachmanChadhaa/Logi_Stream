"""SessionView builder (CLAUDE.md section 5.2).

The single place where internal state becomes something a browser may see. Two
rules are enforced here and nowhere else:

  * hidden-test inputs, expected outputs and stdout are stripped (via redact)
  * the evaluator's free-text `rationale` never appears -- it is logged
    server-side only

Built from `graph.get_state(config).values`, never from the return value of
`invoke` (section 5.3).
"""
from __future__ import annotations

from typing import Any

from app import redact

# exactly the keys section 5.2 allows out of last_eval; `rationale` is absent
# on purpose and a test asserts it stays that way
_EVAL_FIELDS = (
    "verdict",
    "matched_approach",
    "missing_steps",
    "violated_invariants",
    "misconception_id",
    "confidence",
    "cache_hit",
)


def _eval_for_view(last_eval: dict[str, Any] | None) -> dict[str, Any] | None:
    if not last_eval:
        return None
    return {k: last_eval.get(k) for k in _EVAL_FIELDS}


def _diagnosis_for_view(diagnosis: dict[str, Any] | None) -> dict[str, Any] | None:
    """Ranked causes with their evidence. The feature vector stays server-side:
    it is training data for the future ranker, not something a student needs."""
    if not diagnosis:
        return None
    return {k: diagnosis.get(k) for k in ("ranker", "score_kind", "bucket", "candidates")}


def build_session_view(
    values: dict[str, Any],
    *,
    thread_id: str,
    trace_id: str | None = None,
) -> dict[str, Any]:
    values = values or {}

    return {
        "thread_id": thread_id,
        "problem_id": values.get("problem_id"),
        # additive fields (docs/BYOP.md); curated clients can ignore them
        "problem_kind": values.get("problem_kind") or "curated",
        "diagnosis": _diagnosis_for_view(values.get("last_diagnosis")),
        "phase": values.get("phase", "LOGIC"),
        "status": values.get("status", "LOGIC_WRITE"),
        "attempts": values.get("attempts") or {"logic": 0, "code": 0},
        "accepted_logic": values.get("accepted_logic"),
        "messages": values.get("messages") or [],
        "last_eval": _eval_for_view(values.get("last_eval")),
        "last_execution": redact.strip_for_view(values.get("last_execution")),
        "debug": {
            "trace_id": trace_id,
            "last_node_path": values.get("node_path") or [],
            "regenerations": values.get("regenerations", 0),
            "verifier_rejections": values.get("verifier_rejections") or [],
            "fallback_used": bool(values.get("fallback_used")),
            "run_history": values.get("run_history") or [],
        },
    }
