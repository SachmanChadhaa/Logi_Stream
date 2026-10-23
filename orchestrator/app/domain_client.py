"""Client for the Java domain service (CLAUDE.md section 5.4).

Python never touches the sandbox or the database directly: it asks Java. That
boundary is the point of the architecture, so it is worth keeping clean.

The problem context is cached in-process per problem_id (section 6.2) so the
rubric stays out of graph state and out of every checkpoint.
"""
from __future__ import annotations

import logging
from typing import Any

import httpx

from app import config

log = logging.getLogger(__name__)

_context_cache: dict[str, dict[str, Any]] = {}
# custom problems make this cache unbounded in principle; a crude cap is enough
_CONTEXT_CACHE_MAX = 256


class DomainError(RuntimeError):
    """The domain service could not answer."""


class ProblemNotFound(DomainError):
    """No such problem -- or it is someone else's custom problem (same answer)."""


def _headers(trace_id: str | None = None, user_id: str | None = None) -> dict[str, str]:
    h = {"X-Internal-Token": config.INTERNAL_TOKEN}
    if trace_id:
        h["X-Trace-Id"] = trace_id
    if user_id:
        h["X-User-Id"] = user_id
    return h


def get_problem_context(
    problem_id: str,
    *,
    trace_id: str | None = None,
    user_id: str | None = None,
) -> dict[str, Any]:
    """Problem description + rubric. Cached; call clear_cache() after a reseed.

    Pass user_id to enforce ownership (session start does): Java answers 404 for
    someone else's custom problem, and the cache is bypassed so the check really
    happens. Problems are immutable once created, so the cached copy is safe for
    every later call within a session that already passed that check.
    """
    if user_id is None and problem_id in _context_cache:
        return _context_cache[problem_id]

    url = f"{config.DOMAIN_URL}/internal/problems/{problem_id}/context"
    try:
        r = httpx.get(url, headers=_headers(trace_id, user_id), timeout=20.0)
    except httpx.HTTPError as e:
        raise DomainError(f"cannot reach the domain service at {url}: {e}") from e

    if r.status_code == 404:
        raise ProblemNotFound(f"unknown problem: {problem_id}")
    if r.status_code != 200:
        raise DomainError(f"domain returned {r.status_code} for {url}: {r.text[:200]}")

    ctx = r.json()
    ctx.setdefault("kind", "curated")
    if len(_context_cache) >= _CONTEXT_CACHE_MAX:
        _context_cache.clear()
    _context_cache[problem_id] = ctx
    log.info("cached problem context problem=%s rubric_version=%s",
             problem_id, ctx.get("rubric_version"))
    return ctx


def execute(problem_id: str, source: str, *, trace_id: str | None = None) -> dict[str, Any]:
    """Run the student's code. Returns Java's full detail, hidden tests included.

    The caller is responsible for stripping hidden-test data before any of this
    reaches a SessionView (section 5.4).

    The timeout is generous because the sandbox runs every test in sequence; a
    TLE case alone burns its whole limit before returning.
    """
    url = f"{config.DOMAIN_URL}/internal/execute"
    payload = {"problem_id": problem_id, "language": "python", "source": source}
    try:
        r = httpx.post(url, json=payload, headers=_headers(trace_id), timeout=180.0)
    except httpx.HTTPError as e:
        raise DomainError(f"cannot reach the domain service at {url}: {e}") from e

    if r.status_code != 200:
        raise DomainError(f"domain returned {r.status_code} for {url}: {r.text[:200]}")
    return r.json()


def list_problems(user_id: str, *, trace_id: str | None = None) -> list[dict[str, Any]]:
    """Curated samples plus this user's own problems (summaries)."""
    url = f"{config.DOMAIN_URL}/internal/problems"
    try:
        r = httpx.get(url, headers=_headers(trace_id, user_id), timeout=20.0)
    except httpx.HTTPError as e:
        raise DomainError(f"cannot reach the domain service at {url}: {e}") from e
    if r.status_code != 200:
        raise DomainError(f"domain returned {r.status_code} for {url}: {r.text[:200]}")
    return r.json().get("problems", [])


def create_problem(user_id: str, body: dict[str, Any], *, trace_id: str | None = None) -> dict[str, Any]:
    """Store a custom problem owned by user_id; returns Java's view (with id)."""
    url = f"{config.DOMAIN_URL}/internal/problems"
    try:
        r = httpx.post(url, json=body, headers=_headers(trace_id, user_id), timeout=20.0)
    except httpx.HTTPError as e:
        raise DomainError(f"cannot reach the domain service at {url}: {e}") from e
    if r.status_code != 201:
        raise DomainError(f"domain returned {r.status_code} for {url}: {r.text[:200]}")
    return r.json()


def add_snapshot(problem_id: str, user_id: str, code: str, language: str,
                 *, trace_id: str | None = None) -> bool:
    """Record one version of the student's on-screen code. Best effort."""
    url = f"{config.DOMAIN_URL}/internal/problems/{problem_id}/snapshots"
    try:
        r = httpx.post(url, json={"code": code, "language": language},
                       headers=_headers(trace_id, user_id), timeout=10.0)
        return r.status_code == 200 and bool(r.json().get("stored"))
    except (httpx.HTTPError, ValueError) as e:
        log.warning("snapshot not stored for %s: %s", problem_id, e)
        return False


def clear_cache() -> None:
    _context_cache.clear()


def health() -> bool:
    try:
        return httpx.get(f"{config.DOMAIN_URL}/health", timeout=5.0).status_code == 200
    except httpx.HTTPError:
        return False
