"""Socratic logic tutor and its verification loop (CLAUDE.md sections 6.3, 6.4).

The tutor node writes a draft; verify_logic decides whether a student may see it.
Nothing else is allowed to append a tutor message in the LOGIC phase.
"""
from __future__ import annotations

import logging
from typing import Any

from app import config, domain_client, llm, verifier
from app.prompts.logic_tutor import LOGIC_TUTOR_SYSTEM, build_logic_tutor_user
from app.state import SessionState, message

log = logging.getLogger(__name__)


def logic_tutor(state: SessionState) -> dict[str, Any]:
    ctx = domain_client.get_problem_context(state["problem_id"])
    rubric = ctx["rubric"]
    last_eval = state.get("last_eval")

    counter = None
    if last_eval and last_eval.get("misconception_id"):
        counter = verifier.logic_fallback(rubric, last_eval["misconception_id"])

    regen = state.get("regenerations", 0)
    user = build_logic_tutor_user(
        title=ctx["title"],
        description=ctx["description"],
        student_logic=state.get("user_logic", ""),
        last_eval=last_eval,
        socratic_counter=counter,
        recent_messages=state.get("messages") or [],
    )

    if regen:
        # tell the model what it did wrong last time, or it repeats the mistake
        reasons = "; ".join(r["reason"] for r in (state.get("verifier_rejections") or [])[-3:])
        user += (
            f"\n\nYour previous attempt was REJECTED by an automatic checker for: {reasons}. "
            "Write a different question that does not do that."
        )

    node_path = list(state.get("node_path") or []) + ["logic_tutor"]
    try:
        draft = llm.complete(
            model=config.LLM_MODEL_TUTOR,
            system=LOGIC_TUTOR_SYSTEM,
            user=user,
            temperature=0.4,   # some variety, so a regeneration is not the same text
        )
    except Exception as e:                       # noqa: BLE001
        # same canned reply as an exhausted verify loop: a rubric-written
        # question, never an invented one, and flagged as a fallback
        log.error("logic_tutor LLM call failed, using the canned fallback: %s", str(e)[:300])
        draft = counter or verifier.logic_fallback(rubric, None)
        return {"draft": draft, "node_path": node_path, "fallback_used": True}

    log.info("logic_tutor drafted %d chars (regeneration %d)", len(draft), regen)
    return {"draft": draft, "node_path": node_path}


def verify_logic(state: SessionState) -> dict[str, Any]:
    """Gate every tutor turn. Unverified text is never delivered (section 6.4)."""
    ctx = domain_client.get_problem_context(state["problem_id"])
    rubric = ctx["rubric"]
    draft = state.get("draft") or ""

    result = verifier.verify_logic_draft(draft, rubric)
    node_path = list(state.get("node_path") or []) + ["verify_logic"]
    rejections = list(state.get("verifier_rejections") or [])

    if result.ok:
        log.info("verify_logic ACCEPTED the draft")
        return {
            "messages": [message("tutor", "hint", draft)],
            "draft": None,
            "node_path": node_path,
            "status": "LOGIC_CHAT",
        }

    rejections.extend(result.rejections)
    regen = state.get("regenerations", 0) + 1
    log.warning("verify_logic REJECTED draft (regeneration %d/%d): %s",
                regen, config.MAX_REGENERATIONS, result.reasons)

    if regen > config.MAX_REGENERATIONS:
        misconception = (state.get("last_eval") or {}).get("misconception_id")
        fallback = verifier.logic_fallback(rubric, misconception)
        log.warning("verify_logic exhausted regenerations - delivering the canned fallback")
        return {
            "messages": [message("tutor", "hint", fallback)],
            "draft": None,
            "regenerations": regen,
            "verifier_rejections": rejections,
            "fallback_used": True,
            "node_path": node_path,
            "status": "LOGIC_CHAT",
        }

    return {
        "regenerations": regen,
        "verifier_rejections": rejections,
        "node_path": node_path,
    }


def route_after_verify_logic(state: SessionState) -> str:
    """Regenerate while the draft is still pending, otherwise hand back control."""
    return "logic_tutor" if state.get("draft") else "await_input"
