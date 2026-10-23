"""Code tutor and its verification loop (CLAUDE.md sections 6.3, 6.4).

One tutor node for both session kinds (docs/BYOP.md). A curated session keeps
its original prompt, built around the logic the student already had accepted; a
custom session has no accepted logic, so it gets the custom prompt, which works
from the student's own statement, the rules-based diagnosis and the run history.
Both go through the same verify_code gate.
"""
from __future__ import annotations

import logging
from typing import Any

from app import config, diagnostics, domain_client, llm, redact, verifier
from app.prompts.code_tutor import CODE_TUTOR_SYSTEM, build_code_tutor_user
from app.prompts.custom_tutor import CUSTOM_TUTOR_SYSTEM, build_custom_tutor_user
from app.state import SessionState, message

log = logging.getLogger(__name__)


def hint_level(run_history: list[dict[str, Any]] | None) -> int:
    """1-3: how many runs in a row ended on the same diagnosed cause.

    Escalation is earned by being stuck on the SAME thing; a new failure starts
    back at a gentle question.
    """
    history = run_history or []
    if not history:
        return 1
    top = history[-1].get("top_cause")
    streak = 0
    for h in reversed(history):
        if h.get("top_cause") == top:
            streak += 1
        else:
            break
    return max(1, min(3, streak))


def code_tutor(state: SessionState) -> dict[str, Any]:
    ctx = domain_client.get_problem_context(state["problem_id"])
    execution = state.get("last_execution")
    custom = state.get("problem_kind") == "custom"
    bucket = (execution or {}).get("bucket", "NOT_RUN" if custom else "UNKNOWN")

    # the tutor sees redacted results: hidden tests are label + outcome only, so
    # the model cannot quote a hidden input back to the student (section 5.4)
    results_summary = redact.summarize_for_tutor(execution)
    code = state.get("user_code", "")

    regen = state.get("regenerations", 0)
    if custom:
        system = CUSTOM_TUTOR_SYSTEM
        history = state.get("run_history") or []
        # the newest history entry IS the last run; "earlier runs" excludes it
        earlier = history[:-1] if execution else history
        user = build_custom_tutor_user(
            title=ctx.get("title", ""),
            statement=ctx.get("description", ""),
            constraints=ctx.get("constraints") or "",
            examples=ctx.get("examples") or [],
            language=ctx.get("language") or "python",
            bucket=bucket,
            results_summary=results_summary,
            student_code=code,
            diagnosis=state.get("last_diagnosis") if execution else None,
            history_summary=diagnostics.describe_history(earlier, diagnostics.code_sha(code)),
            hint_level=hint_level(history) if execution else 1,
            recent_messages=state.get("messages") or [],
        )
    else:
        system = CODE_TUTOR_SYSTEM
        user = build_code_tutor_user(
            title=ctx["title"],
            bucket=bucket,
            results_summary=results_summary,
            student_code=code,
            logic_summary=state.get("logic_summary"),
            recent_messages=state.get("messages") or [],
        )

    if regen:
        reasons = "; ".join(r["reason"] for r in (state.get("verifier_rejections") or [])[-3:])
        user += (
            f"\n\nYour previous attempt was REJECTED by an automatic checker for: {reasons}. "
            "Write a different explanation that does not do that."
        )

    node_path = list(state.get("node_path") or []) + ["code_tutor"]
    try:
        draft = llm.complete(
            model=config.LLM_MODEL_TUTOR,
            system=system,
            user=user,
            temperature=0.4,
        )
    except Exception as e:                       # noqa: BLE001
        # The run already happened and its result is real. An LLM outage must
        # not throw that evidence away behind a 500, so the student gets a
        # deterministic hint from the diagnosis instead -- still verified below.
        log.error("code_tutor LLM call failed, using the diagnostic fallback: %s", str(e)[:300])
        draft = diagnostics.fallback_hint(execution, state.get("last_diagnosis") if execution else None)
        return {"draft": draft, "node_path": node_path, "fallback_used": True}

    log.info("code_tutor drafted %d chars for bucket=%s kind=%s (regeneration %d)",
             len(draft), bucket, state.get("problem_kind") or "curated", regen)
    return {"draft": draft, "node_path": node_path}


def verify_code(state: SessionState) -> dict[str, Any]:
    """Gate every code-phase tutor turn (section 6.4)."""
    ctx = domain_client.get_problem_context(state["problem_id"])
    rubric = ctx.get("rubric") or {}
    draft = state.get("draft") or ""

    # the student's own function names count as entrypoints too, so a custom
    # problem without a rubric is still protected against a rewritten function
    result = verifier.verify_code_draft(
        draft, rubric, verifier.defined_functions(state.get("user_code", "")))
    node_path = list(state.get("node_path") or []) + ["verify_code"]
    rejections = list(state.get("verifier_rejections") or [])

    if result.ok:
        log.info("verify_code ACCEPTED the draft")
        return {
            "messages": [message("tutor", "hint", draft)],
            "draft": None,
            "node_path": node_path,
            "status": "CODE_CHAT",
        }

    rejections.extend(result.rejections)
    regen = state.get("regenerations", 0) + 1
    log.warning("verify_code REJECTED draft (regeneration %d/%d): %s",
                regen, config.MAX_REGENERATIONS, result.reasons)

    if regen > config.MAX_REGENERATIONS:
        fallback = verifier.code_fallback()
        log.warning("verify_code exhausted regenerations - delivering the canned fallback")
        return {
            "messages": [message("tutor", "hint", fallback)],
            "draft": None,
            "regenerations": regen,
            "verifier_rejections": rejections,
            "fallback_used": True,
            "node_path": node_path,
            "status": "CODE_CHAT",
        }

    return {
        "regenerations": regen,
        "verifier_rejections": rejections,
        "node_path": node_path,
    }


def route_after_verify_code(state: SessionState) -> str:
    return "code_tutor" if state.get("draft") else "await_input"
