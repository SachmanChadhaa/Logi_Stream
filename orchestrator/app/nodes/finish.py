"""Terminal node (CLAUDE.md section 6.3)."""
from __future__ import annotations

import logging
from typing import Any

from app.state import SessionState, message

log = logging.getLogger(__name__)

SUCCESS_MESSAGE = (
    "All tests passed. You described the algorithm in your own words first, then "
    "wrote code that does exactly that - which is the whole point."
)

# Honest about what "verified" means when the student wrote the tests.
CUSTOM_SUCCESS_MESSAGE = (
    "All {total} of your tests passed. That is verified against the tests you "
    "supplied - it is exactly as strong as those tests, so consider an edge case "
    "they do not cover."
)


def finish(state: SessionState) -> dict[str, Any]:
    execution = state.get("last_execution") or {}
    log.info("finish: session complete passed=%s/%s logic_attempts=%s code_attempts=%s",
             execution.get("passed"), execution.get("total"),
             (state.get("attempts") or {}).get("logic"),
             (state.get("attempts") or {}).get("code"))

    return {
        "phase": "DONE",
        "status": "SUCCESS",
        "messages": [message("system", "info",
                             CUSTOM_SUCCESS_MESSAGE.format(total=execution.get("total"))
                             if state.get("problem_kind") == "custom" else SUCCESS_MESSAGE)],
        "node_path": list(state.get("node_path") or []) + ["finish"],
    }
