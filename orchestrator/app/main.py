"""Orchestrator HTTP API (CLAUDE.md section 5.3).

Internal service: only the Rust gateway talks to it, and every endpoint except
/health demands X-Internal-Token.

Sync endpoints (`def`, not `async def`) against the sync graph, exactly as
section 6.5 specifies. FastAPI runs them in a threadpool, which is the right
shape here anyway because a graph turn spends most of its time blocked on an
LLM call.
"""
from __future__ import annotations

import logging
import threading
from contextlib import asynccontextmanager
from typing import Any

from fastapi import Depends, FastAPI, Header, HTTPException, Request, Response
from langgraph.types import Command
from pydantic import BaseModel

from app import config, domain_client, llm, observer, tracing
from app.checkpointer import build_checkpointer, close_checkpointer
from app.graph import build_graph
from app.state import initial_state
from app.view import build_session_view

log = logging.getLogger(__name__)

_graph = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _graph
    tracing.configure_logging()

    checkpointer = build_checkpointer()
    _graph = build_graph(checkpointer)

    log.info("orchestrator ready: llm=%s domain=%s", llm.describe(), config.DOMAIN_URL)
    yield
    close_checkpointer()


app = FastAPI(title="LogiStream orchestrator", lifespan=lifespan)


# --------------------------------------------------------------------------
# cross-cutting
# --------------------------------------------------------------------------

@app.middleware("http")
async def trace_middleware(request: Request, call_next):
    tid = tracing.set_trace_id(request.headers.get(tracing.HEADER))
    response = await call_next(request)
    response.headers[tracing.HEADER] = tid
    return response


def require_token(x_internal_token: str | None = Header(default=None)) -> None:
    """Section 5.3: every endpoint except /health requires the internal token."""
    if x_internal_token != config.INTERNAL_TOKEN:
        log.warning("rejected request: missing or invalid %s", "X-Internal-Token")
        raise HTTPException(status_code=401, detail="missing or invalid X-Internal-Token")


def graph():
    if _graph is None:                           # pragma: no cover - lifespan guarantees it
        raise HTTPException(status_code=503, detail="graph not ready")
    return _graph


# --------------------------------------------------------------------------
# request bodies
# --------------------------------------------------------------------------

class StartBody(BaseModel):
    problem_id: str
    user_id: str | None = None


class EventBody(BaseModel):
    type: str
    text: str


class ObserveBody(BaseModel):
    image_b64: str
    trigger: str | None = None          # "interval" | "run" | "error" | "manual"
    code_revision: int | None = None    # the run revision the browser had when it captured


# One graph turn per thread at a time. Two concurrent invokes on the same
# checkpoint thread would race; an observation arriving mid-tutor-turn is simply
# skipped (the next sample will catch up), while events wait their turn.
_thread_locks: dict[str, threading.Lock] = {}
_locks_guard = threading.Lock()


def _lock_for(thread_id: str) -> threading.Lock:
    with _locks_guard:
        return _thread_locks.setdefault(thread_id, threading.Lock())


# --------------------------------------------------------------------------
# endpoints
# --------------------------------------------------------------------------

@app.get("/health")
def health() -> dict[str, Any]:
    return {
        "ok": True,
        "llm": llm.describe(),
        "domain_healthy": domain_client.health(),
    }


@app.post("/sessions/{thread_id}/start", dependencies=[Depends(require_token)])
def start(thread_id: str, body: StartBody) -> dict[str, Any]:
    """Resume an existing session, or begin a new one (section 5.3).

    Resuming is the default on purpose: a browser refresh must land back in the
    same conversation, and that is the checkpointing story the demo shows off.
    """
    g = graph()
    cfg = {"configurable": {"thread_id": thread_id}}

    snapshot = g.get_state(cfg)
    if snapshot.values:
        log.info("start: resuming existing session thread=%s phase=%s",
                 thread_id, snapshot.values.get("phase"))
        return _view(g, cfg, thread_id)

    user_id = body.user_id or "demo-user"

    # Ownership is checked here, once, before a thread exists: Java returns 404
    # for an unknown id and for someone else's custom problem alike.
    try:
        ctx = domain_client.get_problem_context(
            body.problem_id, trace_id=tracing.get_trace_id(), user_id=user_id)
    except domain_client.ProblemNotFound:
        raise HTTPException(status_code=404, detail=f"unknown problem: {body.problem_id}")
    except domain_client.DomainError as e:
        raise HTTPException(status_code=502, detail=str(e))

    kind = "custom" if ctx.get("kind") == "custom" else "curated"
    log.info("start: new session thread=%s problem=%s kind=%s user=%s",
             thread_id, body.problem_id, kind, user_id)
    # runs until the interrupt in await_input
    g.invoke(initial_state(body.problem_id, user_id, thread_id,
                           kind=kind, starter_code=ctx.get("starter_code") or ""), cfg)
    return _view(g, cfg, thread_id)


@app.post("/sessions/{thread_id}/event", dependencies=[Depends(require_token)])
def event(thread_id: str, body: EventBody) -> dict[str, Any]:
    g = graph()
    cfg = {"configurable": {"thread_id": thread_id}}

    snapshot = g.get_state(cfg)
    if not snapshot.values:
        raise HTTPException(status_code=404, detail="no such session; call start first")

    _validate_event(body, snapshot.values)

    log.info("event: thread=%s type=%s phase=%s chars=%d",
             thread_id, body.type, snapshot.values.get("phase"), len(body.text))

    with _lock_for(thread_id):
        g.invoke(Command(resume={"type": body.type, "text": body.text}), cfg)
    return _view(g, cfg, thread_id)


@app.get("/observer/status", dependencies=[Depends(require_token)])
def observer_status() -> dict[str, Any]:
    return observer.status()


@app.post("/sessions/{thread_id}/observe", dependencies=[Depends(require_token)])
def observe(thread_id: str, body: ObserveBody) -> dict[str, Any]:
    """One screen frame -> local VLM -> a text observation in the session.

    The VLM runs BEFORE the graph is touched, so the image never enters graph
    state or a checkpoint; only the returned text does. If the VLM fails, the
    session is left exactly as it was and the caller gets 503 with the reason.
    """
    g = graph()
    cfg = {"configurable": {"thread_id": thread_id}}
    snapshot = g.get_state(cfg)
    if not snapshot.values:
        raise HTTPException(status_code=404, detail="no such session; call start first")
    if snapshot.values.get("phase") == "DONE":
        raise HTTPException(status_code=409, detail="this session is finished")

    try:
        obs = observer.interpret(body.image_b64)
    except observer.BadFrame as e:
        raise HTTPException(status_code=422, detail=str(e))
    except observer.ObserverUnavailable as e:
        log.warning("observe: observer unavailable thread=%s: %s", thread_id, e)
        raise HTTPException(status_code=503, detail=f"observer unavailable: {e}")

    current_rev = int((snapshot.values.get("temporal") or {}).get("code_revision", 0))
    rev = current_rev if body.code_revision is None else min(int(body.code_revision), current_rev)
    lock = _lock_for(thread_id)
    if not lock.acquire(blocking=False):
        raise HTTPException(status_code=409, detail="session busy; observation skipped")
    try:
        g.invoke(Command(resume={
            "type": "observe",
            "text": obs["text"],
            "observation": {"text": obs["text"], "tags": obs["tags"], "code_revision": rev,
                            "problem": obs.get("problem"),
                            "trigger": body.trigger, "model": obs["model"],
                            "latency_ms": obs["latency_ms"]},
        }), cfg)
    finally:
        lock.release()
    log.info("observe: thread=%s trigger=%s rev=%d latency=%dms",
             thread_id, body.trigger, rev, obs["latency_ms"])
    return _view(g, cfg, thread_id)


@app.post("/sessions/{thread_id}/reset", dependencies=[Depends(require_token)])
def reset(thread_id: str) -> dict[str, Any]:
    g = graph()
    log.info("reset: deleting checkpoints for thread=%s", thread_id)
    with _lock_for(thread_id):
        g.checkpointer.delete_thread(thread_id)
    return {"ok": True}


@app.get("/sessions/{thread_id}", dependencies=[Depends(require_token)])
def get_session(thread_id: str) -> dict[str, Any]:
    g = graph()
    cfg = {"configurable": {"thread_id": thread_id}}
    if not g.get_state(cfg).values:
        raise HTTPException(status_code=404, detail="no such session")
    return _view(g, cfg, thread_id)


# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------

def _view(g, cfg: dict[str, Any], thread_id: str) -> dict[str, Any]:
    # section 5.3: build the view from get_state, never from invoke's return value
    return build_session_view(
        g.get_state(cfg).values,
        thread_id=thread_id,
        trace_id=tracing.get_trace_id(),
    )


def _validate_event(body: EventBody, values: dict[str, Any]) -> None:
    """Section 5.3 event validation: 422 for empty text, 409 for the wrong phase."""
    if not body.text or not body.text.strip():
        raise HTTPException(status_code=422, detail="text must not be empty")

    phase = values.get("phase", "LOGIC")

    if phase == "DONE":
        raise HTTPException(
            status_code=409,
            detail="this session is finished; reset it to start again",
        )

    allowed = {
        "LOGIC": {"logic", "chat"},
        "CODE": {"code", "chat"},
    }.get(phase, set())

    if body.type not in allowed:
        raise HTTPException(
            status_code=409,
            detail=(f"event type '{body.type}' is not allowed in phase {phase}; "
                    f"allowed here: {', '.join(sorted(allowed))}"),
        )


@app.exception_handler(Exception)
async def unhandled(request: Request, exc: Exception) -> Response:
    """Never leak a stack trace to the caller, but always log one."""
    log.exception("unhandled error on %s %s", request.method, request.url.path)
    from fastapi.responses import JSONResponse
    # the exception text can carry upstream bodies (provider errors, ids): log only
    return JSONResponse(status_code=500, content={
        "detail": f"internal error ({type(exc).__name__}); details are in the orchestrator log"})
