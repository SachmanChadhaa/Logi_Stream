"""Graph state (CLAUDE.md section 6.2).

Plain JSON-serialisable types only -- this is checkpointed to Postgres on Day 2,
and anything exotic in here becomes a serialisation bug at the worst moment.

Note what is deliberately absent: the problem description and rubric. They are
fetched from Java via domain_client and cached in-process per problem_id, so the
checkpoint stays small and a rubric edit does not need a state migration.
"""
from __future__ import annotations

import operator
from typing import Annotated, Any, Literal, TypedDict

Phase = Literal["LOGIC", "CODE", "DONE"]
# curated: a seeded problem with a rubric, so the logic gate applies (two-sum).
# custom:  bring-your-own-problem. No rubric exists, so there is no logic gate:
#          the session starts in CODE with the editor open and the tutor ready.
ProblemKind = Literal["curated", "custom"]
Status = Literal["LOGIC_WRITE", "LOGIC_CHAT", "CODE_WRITE", "CODE_CHAT", "SUCCESS"]
EventType = Literal["logic", "chat", "code"]


class SessionState(TypedDict, total=False):
    problem_id: str
    user_id: str
    thread_id: str
    problem_kind: ProblemKind

    phase: Phase
    status: Status

    pending_event: dict[str, Any] | None      # {type, text}
    user_logic: str
    user_code: str
    accepted_logic: str | None
    logic_summary: dict[str, Any] | None

    last_eval: dict[str, Any] | None
    last_execution: dict[str, Any] | None     # full Java detail, Python-side only
    last_diagnosis: dict[str, Any] | None     # diagnostics.rank() of the last run
    # Temporal memory: one compact record per run (diagnostics.history_entry),
    # newest last, capped. Lets the tutor say what changed since the last run.
    run_history: list[dict[str, Any]]

    attempts: dict[str, int]                  # {"logic": int, "code": int}

    draft: str | None                         # tutor draft awaiting verification
    regenerations: int
    verifier_rejections: list[dict[str, str]]
    fallback_used: bool

    node_path: list[str]                      # reset at each await_input

    # the only reducer: messages accumulate, everything else is last-write-wins
    messages: Annotated[list[dict[str, Any]], operator.add]


def initial_state(
    problem_id: str,
    user_id: str,
    thread_id: str,
    *,
    kind: ProblemKind = "curated",
    starter_code: str = "",
) -> SessionState:
    custom = kind == "custom"
    return {
        "problem_id": problem_id,
        "user_id": user_id,
        "thread_id": thread_id,
        "problem_kind": kind,
        "phase": "CODE" if custom else "LOGIC",
        "status": "CODE_WRITE" if custom else "LOGIC_WRITE",
        "pending_event": None,
        "user_logic": "",
        # a custom problem may arrive with the student's current attempt
        "user_code": starter_code if custom else "",
        "accepted_logic": None,
        "logic_summary": None,
        "last_eval": None,
        "last_execution": None,
        "last_diagnosis": None,
        "run_history": [],
        "attempts": {"logic": 0, "code": 0},
        "draft": None,
        "regenerations": 0,
        "verifier_rejections": [],
        "fallback_used": False,
        "node_path": [],
        "messages": [],
    }


def message(role: str, kind: str, text: str) -> dict[str, Any]:
    """One transcript entry. ts is ISO-8601 UTC, as the SessionView contract says."""
    from datetime import datetime, timezone
    return {
        "role": role,
        "kind": kind,
        "text": text,
        "ts": datetime.now(timezone.utc).isoformat(),
    }
