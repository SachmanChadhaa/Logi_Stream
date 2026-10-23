"""The diagnostic step of the tutor graph (CLAUDE_CODE_BRIEF step 4).

Runs after every code run, chat (code phase) and screen observation, and does
the brief's loop in one deterministic node -- no LLM call in here:

    gather evidence   -> the run result, the code diff, the latest observations
    interpret context -> feature_schema_v1 vector; GRU step in the Rust sidecar
                         (temporal memory: hidden state in, hidden state out)
    rank diagnoses    -> rules-v1 always; the Rust booster reorders them when
                         available. Rules candidates carry the evidence.
    choose strategy   -> clarify / point-to-evidence / narrow-down / name-the-defect
    verify            -> "verified" only ever comes from the NEXT executed run
    update temporal   -> events, hypotheses, next action, rolling summary

At most MAX_ITERATIONS passes per turn. The second pass only happens when the
top candidate has no evidence of its own and a current screen observation can
supply some.

Every external call (intel) is optional and time-boxed; on failure the node
records ranker=rules-v1 and carries on.
"""
from __future__ import annotations

import logging
from typing import Any

from app import diagnostics, features_v1, intel_client, temporal, tracing
from app.nodes.code_tutor import hint_level
from app.state import SessionState

log = logging.getLogger(__name__)

MAX_ITERATIONS = 2
MAX_RUN_HISTORY = 20
RULES = diagnostics.RANKER_VERSION
BOOSTED = "rust-gru-booster-v0 synthetic"
# The booster scored every candidate but was NOT allowed to reorder them: on
# held-out synthetic scenarios it ranked worse than the rules (intel decides
# this from its own metrics file and says so in every /v1/rank reply).
SHADOW = "rules-v1 (+ rust booster shadow)"


def _gru_step(t: dict[str, Any], vector: list[float]) -> dict[str, Any] | None:
    out = intel_client.track(vector, (t.get("gru") or {}).get("hidden"),
                             trace_id=tracing.get_trace_id())
    if out is None:
        return None
    t["gru"] = {"hidden": out["hidden"], "model_version": out.get("model_version")}
    t["student_state"] = {
        "label": out.get("state_label"),
        "scores": out.get("state_scores") or {},
        "model_version": out.get("model_version"),
    }
    return out


def _rerank(diagnosis: dict[str, Any], vector: list[float], gru: dict[str, Any] | None) -> str:
    """Score the evidence-backed rules candidates with the booster.

    The booster never ADDS a cause the rules did not find: a candidate without
    evidence is a guess, and the tutor is told to label guesses. It REORDERS
    them only when the sidecar says it was promoted (it beat the rules on
    held-out scenarios); otherwise the scores ride along in shadow mode and the
    rules order stands. Returns the ranker label that produced the order.
    """
    cands = diagnosis.get("candidates") or []
    if not cands:
        return RULES
    out = intel_client.rank(vector, gru, [c["id"] for c in cands], trace_id=tracing.get_trace_id())
    if out is None:
        return RULES
    scores = {r["id"]: float(r["score"]) for r in out["ranked"] if "id" in r}
    for c in cands:
        if c["id"] in scores:
            c["model_score"] = round(scores[c["id"]], 3)
    diagnosis["model_version"] = out.get("model_version")
    if not out.get("promoted"):
        return SHADOW
    cands.sort(key=lambda c: -scores.get(c["id"], float("-inf")))
    return BOOSTED


def diagnose(state: SessionState) -> dict[str, Any]:
    event = state.get("pending_event") or {}
    etype = event.get("type")
    t = temporal.ensure(state.get("temporal"))
    node_path = list(state.get("node_path") or []) + ["diagnose"]
    kind = state.get("problem_kind") or "curated"
    history = list(state.get("run_history") or [])
    update: dict[str, Any] = {"node_path": node_path}
    dt = temporal.seconds_since(t.get("last_event_ts"))

    if etype == "code":
        execution = state.get("last_execution") or {}
        code = state.get("user_code", "")
        changed = temporal.changed_lines(t.get("last_run_code", ""), code)

        diagnosis = diagnostics.rank(execution, code, history, problem_kind=kind)
        vector = features_v1.build(
            event_kind="run", diag_features=diagnosis["features"], changed_lines=changed,
            code_lines=len(code.splitlines()), dt_since_last_s=dt, run_history=history,
            problem_kind=kind)

        ranker, iterations = RULES, 0
        for _ in range(MAX_ITERATIONS):
            iterations += 1
            gru = _gru_step(t, vector) if iterations == 1 else None
            ranker = _rerank(diagnosis, vector, gru) if iterations == 1 else ranker
            top = (diagnosis.get("candidates") or [None])[0]
            fresh_obs = [e for e in t["events"]
                         if e["kind"] == "observation" and not temporal.is_stale(e, t)]
            # second pass: the top cause has no evidence, but the screen might
            if top is not None and not top.get("evidence") and fresh_obs and iterations < MAX_ITERATIONS:
                top["evidence"].append(f"seen on screen (not verified): {fresh_obs[-1]['text'][:160]}")
                continue
            break

        diagnosis["ranker_used"] = ranker
        diagnosis["iterations"] = iterations
        entry = diagnostics.history_entry(execution, code, diagnosis, temporal.now_iso())
        history = (history + [entry])[-MAX_RUN_HISTORY:]

        # a run bumps the revision: older observations become "seen earlier"
        t["code_revision"] = int(t["code_revision"]) + 1
        t["last_run_code"] = code
        top = (diagnosis.get("candidates") or [None])[0]
        t = temporal.add_event(
            t, "run",
            f"{execution.get('bucket')} {execution.get('passed', 0)}/{execution.get('total', 0)}"
            + (f"; top cause {top['id']}" if top else "") + f"; {changed} line(s) changed",
            "sandbox")
        bucket = execution.get("bucket")
        t["hypotheses"] = [] if bucket == "ACCEPTED" else [
            c["cause"] for c in (diagnosis.get("candidates") or [])]
        t["next_action"] = top["next_action"] if top and bucket != "ACCEPTED" else None
        t["ranker"] = ranker
        update["last_diagnosis"] = diagnosis
        update["run_history"] = history
        log.info("diagnose run bucket=%s ranker=%s iterations=%d top=%s rev=%d",
                 bucket, ranker, iterations, top["id"] if top else None, t["code_revision"])

    elif etype == "observe":
        obs = event.get("observation") or {}
        vector = features_v1.build(event_kind="observation", dt_since_last_s=dt,
                                   run_history=history, problem_kind=kind,
                                   vlm_tags=obs.get("tags") or {})
        _gru_step(t, vector)
        t = temporal.add_event(t, "observation", obs.get("text") or event.get("text", ""), "screen",
                               code_revision=obs.get("code_revision"))
        log.info("diagnose observation rev=%d tags=%s", t["code_revision"], obs.get("tags"))

    else:  # chat
        vector = features_v1.build(event_kind="idle" if dt > 300 else "chat", dt_since_last_s=dt,
                                   run_history=history, problem_kind=kind)
        _gru_step(t, vector)
        t = temporal.add_event(t, "chat", event.get("text", ""), "student")

    t["summary"] = temporal.summarize(t, history)
    t["strategy"] = temporal.strategy(
        (state.get("last_execution") or {}).get("bucket") if history else None,
        hint_level(history), bool(history))
    update["temporal"] = t
    return update


def route_after_diagnose(state: SessionState) -> str:
    etype = (state.get("pending_event") or {}).get("type")
    if etype == "observe":
        return "await_input"            # the observer is quiet: no automatic tutor turn
    if etype == "code" and (state.get("last_execution") or {}).get("bucket") == "ACCEPTED":
        return "finish"
    return "code_tutor"
