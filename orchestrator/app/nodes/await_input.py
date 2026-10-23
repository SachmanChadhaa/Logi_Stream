"""The interrupt node (CLAUDE.md section 6.1).

TRAP 3, and the single most important constraint in this file: on resume,
LangGraph re-executes the interrupted node FROM ITS FIRST LINE. Anything placed
before interrupt() runs twice -- once when the graph suspends and again when it
resumes. An LLM call there would be billed twice and, worse, could produce two
different drafts.

So this node contains nothing but interrupt() and writes that are safe to repeat.
No LLM calls, no HTTP, no database writes, no counters. If you are tempted to add
something here, put it in the node that routes out of here instead.
"""
from __future__ import annotations

import logging
from typing import Any

from langgraph.types import interrupt

from app.state import SessionState, message

log = logging.getLogger(__name__)


def await_input(state: SessionState) -> dict[str, Any]:
    # Everything before this line runs again on every resume. Keep it empty.
    event = interrupt({"awaiting": "student_event", "phase": state.get("phase")})

    etype = (event or {}).get("type", "")
    text = (event or {}).get("text", "")

    log.info("await_input resumed type=%s phase=%s chars=%d",
             etype, state.get("phase"), len(text))

    update: dict[str, Any] = {
        "pending_event": {"type": etype, "text": text},
        # node_path is reset here so the debug panel shows one turn, not the
        # whole session (section 6.2)
        "node_path": ["await_input"],
        # a fresh turn starts with a clean verification slate
        "regenerations": 0,
        "verifier_rejections": [],
        "fallback_used": False,
        "draft": None,
    }

    if etype == "logic":
        update["user_logic"] = text
        update["status"] = "LOGIC_WRITE"
        update["messages"] = [message("student", "logic", text)]
    elif etype == "code":
        update["user_code"] = text
        update["status"] = "CODE_WRITE"
        update["messages"] = [message("student", "code", text)]
    elif etype == "chat":
        update["status"] = "LOGIC_CHAT" if state.get("phase") == "LOGIC" else "CODE_CHAT"
        update["messages"] = [message("student", "chat", text)]
    elif etype == "observe":
        # A screen observation: the local VLM's short TEXT, never the image
        # (main.observe calls Ollama before resuming). Not a student message, and
        # the status is left alone -- the observer is quiet.
        update["pending_event"] = {"type": etype, "text": text,
                                   "observation": (event or {}).get("observation") or {}}

    return update


def route_after_input(state: SessionState) -> str:
    """Conditional edge on (event.type, phase) -- section 6.1."""
    event = state.get("pending_event") or {}
    etype = event.get("type")
    phase = state.get("phase")

    if etype == "logic" and phase == "LOGIC":
        return "evaluate_logic"
    if etype == "chat" and phase == "LOGIC":
        return "logic_tutor"
    if etype == "code" and phase == "CODE":
        return "execute_code"
    if etype == "chat" and phase == "CODE":
        return "diagnose"
    if etype == "observe" and phase in ("LOGIC", "CODE"):
        return "diagnose"

    # The API layer rejects invalid combinations with 409 before they get here,
    # so this is a genuine "should not happen". Going back to await_input is the
    # safe choice: it cannot corrupt the session.
    log.warning("unroutable event type=%s in phase=%s - returning to await_input", etype, phase)
    return "await_input"
