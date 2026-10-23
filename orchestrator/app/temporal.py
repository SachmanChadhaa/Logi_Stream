"""Temporal memory for a session (CLAUDE_CODE_BRIEF step 4).

Lives in the LangGraph checkpoint as `state["temporal"]`, so it survives a
restart and is cleared by reset with everything else. Plain JSON only.

    {
      "summary": str,                      # rolling, deterministic, one paragraph
      "code_revision": int,                # +1 per code run
      "latest_observation_ts": str | None,
      "events": [ {ts, kind, text, code_revision, source} ],   # last MAX_EVENTS
      "hypotheses": [str],                 # unresolved: top ranked causes, open
      "next_action": str | None,
      "ranker": "rules-v1" | "rust-gru-booster-v0 synthetic",
      "student_state": {label, scores, model_version} | None,
      "gru": {"hidden": [float] | None, "model_version": str | None},
      "last_run_code": str,                # for the edit-size feature only
      "last_event_ts": str | None,
    }

STALENESS. A screen observation records the code revision it was seen
against. Once a newer run exists, the observation is "seen earlier": the view
marks it stale and the tutor is told never to treat it as current. Structured
sandbox evidence always wins over pixels.

Never stores a screenshot -- only the short text the local VLM returned.
"""
from __future__ import annotations

import difflib
from datetime import datetime, timezone
from typing import Any

MAX_EVENTS = 20
MAX_EVENT_TEXT = 400


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def empty() -> dict[str, Any]:
    return {
        "summary": "",
        "code_revision": 0,
        "latest_observation_ts": None,
        "events": [],
        "hypotheses": [],
        "next_action": None,
        "ranker": "rules-v1",
        "student_state": None,
        "gru": {"hidden": None, "model_version": None},
        "last_run_code": "",
        "last_event_ts": None,
    }


def ensure(temporal: dict[str, Any] | None) -> dict[str, Any]:
    """A full temporal dict, also for sessions checkpointed before it existed."""
    t = empty()
    t.update(temporal or {})
    return t


def seconds_since(ts: str | None, now: str | None = None) -> float:
    if not ts:
        return 0.0
    try:
        a = datetime.fromisoformat(ts)
        b = datetime.fromisoformat(now) if now else datetime.now(timezone.utc)
        return max(0.0, (b - a).total_seconds())
    except ValueError:
        return 0.0


def changed_lines(before: str, after: str) -> int:
    """Lines added or removed between two versions of the student's code."""
    diff = difflib.ndiff((before or "").splitlines(), (after or "").splitlines())
    return sum(1 for d in diff if d[:1] in "+-")


def add_event(
    temporal: dict[str, Any],
    kind: str,
    text: str,
    source: str,
    ts: str | None = None,
    code_revision: int | None = None,
) -> dict[str, Any]:
    """Returns a NEW temporal dict with the event appended (and capped).

    code_revision defaults to the current one; an observation passes the
    revision the browser had when it CAPTURED the frame, so a frame taken before
    a run is stale even if it is interpreted after it."""
    t = ensure(temporal)
    ts = ts or now_iso()
    rev = t["code_revision"] if code_revision is None else min(int(code_revision), int(t["code_revision"]))
    ev = {
        "ts": ts,
        "kind": kind,
        "text": (text or "")[:MAX_EVENT_TEXT],
        "code_revision": rev,
        "source": source,
    }
    t["events"] = (list(t["events"]) + [ev])[-MAX_EVENTS:]
    t["last_event_ts"] = ts
    if kind == "observation":
        t["latest_observation_ts"] = ts
    return t


def is_stale(event: dict[str, Any], temporal: dict[str, Any]) -> bool:
    """An observation seen against an older code revision than the latest run."""
    return (event.get("kind") == "observation"
            and int(event.get("code_revision", 0)) < int(temporal.get("code_revision", 0)))


def summarize(temporal: dict[str, Any], run_history: list[dict[str, Any]] | None) -> str:
    """Deterministic rolling summary. No LLM: it must be cheap, stable and true."""
    t = ensure(temporal)
    history = run_history or []
    parts: list[str] = []
    if history:
        last = history[-1]
        verdict = ("verified by tests" if last.get("verified") and last.get("bucket") == "ACCEPTED"
                   else "not verified (no tests)" if last.get("bucket") == "NO_TESTS"
                   else f"{last.get('passed')}/{last.get('total')} tests")
        parts.append(f"{len(history)} run(s); latest {last.get('bucket')} ({verdict}).")
        streak = 0
        for h in reversed(history):
            if h.get("top_cause") == last.get("top_cause"):
                streak += 1
            else:
                break
        if last.get("top_cause") and streak > 1:
            parts.append(f"Same diagnosed cause '{last.get('top_cause')}' {streak} runs in a row.")
    else:
        parts.append("No code run yet.")
    obs = [e for e in t["events"] if e["kind"] == "observation"]
    if obs:
        fresh = [e for e in obs if not is_stale(e, t)]
        parts.append(f"{len(obs)} screen observation(s), {len(fresh)} current.")
    if t.get("student_state"):
        parts.append(f"Student state (advisory model): {t['student_state'].get('label')}.")
    return " ".join(parts)


def strategy(bucket: str | None, hint_level: int, has_run: bool) -> str:
    """Which tutoring move fits: a label the prompt and the UI both show."""
    if not has_run:
        return "clarify-plan"
    if bucket == "NO_TESTS":
        return "suggest-tests"
    if bucket == "ACCEPTED":
        return "consolidate"
    return {1: "point-to-evidence", 2: "narrow-down", 3: "name-the-defect"}.get(hint_level, "point-to-evidence")


def for_view(temporal: dict[str, Any] | None) -> dict[str, Any] | None:
    """The browser-safe projection. Drops the GRU hidden vector and last code."""
    if not temporal:
        return None
    t = ensure(temporal)
    return {
        "summary": t["summary"],
        "code_revision": t["code_revision"],
        "latest_observation_ts": t["latest_observation_ts"],
        "events": [dict(e, stale=is_stale(e, t)) for e in t["events"]],
        "hypotheses": list(t["hypotheses"]),
        "next_action": t["next_action"],
        "ranker": t["ranker"],
        "student_state": t["student_state"],
    }


def for_prompt(temporal: dict[str, Any] | None) -> str:
    """Compact text for the tutor prompt, with staleness spelled out."""
    t = ensure(temporal)
    lines = [f"SUMMARY: {t['summary'] or '(none)'}"]
    for e in t["events"][-8:]:
        tag = "SEEN ON SCREEN EARLIER (a newer run exists; do not treat as current)" \
            if is_stale(e, t) else ("SEEN ON SCREEN" if e["kind"] == "observation" else e["source"].upper())
        lines.append(f"- {e['ts']} [{e['kind']}, rev {e['code_revision']}, {tag}] {e['text']}")
    if t.get("student_state"):
        lines.append(f"ADVISORY STUDENT STATE: {t['student_state'].get('label')} "
                     f"(model {t['student_state'].get('model_version')}, unvalidated)")
    return "\n".join(lines)
