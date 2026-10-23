"""Graph wiring (CLAUDE.md section 6.1).

One long-running graph per session. Every student action is a resume of the
interrupt in await_input, which is why the whole conversation survives a service
restart once PostgresSaver is in.

    START -> await_input --(logic)--> evaluate_logic --PASS/FLAGGED--> summarize_logic -> await_input
                 |                          '--FAIL--> logic_tutor <=> verify_logic ---> await_input
                 |--(chat, LOGIC)---------------------> logic_tutor <=> verify_logic --> await_input
                 |--(code)--> execute_code --INFRA_ERROR--(system message, no tutor)--> await_input
                 |                 '--> diagnose --ACCEPTED--> finish -> END
                 |                         '--other--> code_tutor <=> verify_code ------> await_input
                 |--(chat, CODE)--> diagnose --> code_tutor <=> verify_code ------------> await_input
                 '--(observe)-----> diagnose -----------------------------------------> await_input

diagnose (CLAUDE_CODE_BRIEF step 4) is deterministic: rules ranker, the optional
Rust GRU/booster sidecar, temporal memory. It never calls the LLM, so an
observation never costs a tutor turn.
"""
from __future__ import annotations

import logging

from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import END, START, StateGraph

from app.nodes.await_input import await_input, route_after_input
from app.nodes.code_tutor import code_tutor, route_after_verify_code, verify_code
from app.nodes.diagnose import diagnose, route_after_diagnose
from app.nodes.evaluate_logic import evaluate_logic, route_after_eval
from app.nodes.execute_code import execute_code, route_after_execute
from app.nodes.finish import finish
from app.nodes.logic_tutor import logic_tutor, route_after_verify_logic, verify_logic
from app.nodes.summarize_logic import summarize_logic
from app.state import SessionState

log = logging.getLogger(__name__)


def build_graph(checkpointer=None):
    g = StateGraph(SessionState)

    g.add_node("await_input", await_input)
    g.add_node("evaluate_logic", evaluate_logic)
    g.add_node("logic_tutor", logic_tutor)
    g.add_node("verify_logic", verify_logic)
    g.add_node("summarize_logic", summarize_logic)
    g.add_node("execute_code", execute_code)
    g.add_node("diagnose", diagnose)
    g.add_node("code_tutor", code_tutor)
    g.add_node("verify_code", verify_code)
    g.add_node("finish", finish)

    g.add_edge(START, "await_input")

    g.add_conditional_edges(
        "await_input",
        route_after_input,
        {
            "evaluate_logic": "evaluate_logic",
            "logic_tutor": "logic_tutor",
            "execute_code": "execute_code",
            "diagnose": "diagnose",
            "await_input": "await_input",
        },
    )

    # ---- logic phase
    g.add_conditional_edges(
        "evaluate_logic",
        route_after_eval,
        {"summarize_logic": "summarize_logic", "logic_tutor": "logic_tutor"},
    )
    g.add_edge("logic_tutor", "verify_logic")
    g.add_conditional_edges(
        "verify_logic",
        route_after_verify_logic,
        {"logic_tutor": "logic_tutor", "await_input": "await_input"},
    )
    g.add_edge("summarize_logic", "await_input")

    # ---- code phase
    g.add_conditional_edges(
        "execute_code",
        route_after_execute,
        {"diagnose": "diagnose", "await_input": "await_input"},
    )
    g.add_conditional_edges(
        "diagnose",
        route_after_diagnose,
        {"finish": "finish", "code_tutor": "code_tutor", "await_input": "await_input"},
    )
    g.add_edge("code_tutor", "verify_code")
    g.add_conditional_edges(
        "verify_code",
        route_after_verify_code,
        {"code_tutor": "code_tutor", "await_input": "await_input"},
    )
    g.add_edge("finish", END)

    if checkpointer is None:
        # MemorySaver keeps the CLI harness free of Postgres, so interrupt/resume
        # bugs stay separated from persistence bugs (section 12).
        checkpointer = MemorySaver()

    return g.compile(checkpointer=checkpointer)


__all__ = ["build_graph", "END"]
