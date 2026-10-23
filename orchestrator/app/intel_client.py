"""Client for the Rust `intel/` sidecar (temporal GRU + XGBoost-style booster).

Strictly advisory and strictly optional. Every call has a 2 s timeout, and ANY
failure -- sidecar down, timeout, bad JSON, schema-version mismatch, no model
file -- returns None. The caller then uses the rules ranker and records
`ranker=rules-v1`. A session never waits on, or fails because of, this module.

The sidecar is stateless: the GRU hidden state comes from and goes back to the
LangGraph checkpoint (state["temporal"]["gru"]).
"""
from __future__ import annotations

import logging
import os
from typing import Any

import httpx

from app import config, features_v1

log = logging.getLogger(__name__)

INTEL_URL = os.environ.get("INTEL_URL", "http://localhost:8002")
INTEL_TIMEOUT_S = float(os.environ.get("INTEL_TIMEOUT_S", "2.0"))
INTEL_ENABLED = os.environ.get("INTEL_ENABLED", "1") not in ("0", "false", "no")


def _post(path: str, payload: dict[str, Any], trace_id: str | None) -> dict[str, Any] | None:
    if not INTEL_ENABLED:
        return None
    headers = {"X-Internal-Token": config.INTERNAL_TOKEN}
    if trace_id:
        headers["X-Trace-Id"] = trace_id
    try:
        r = httpx.post(f"{INTEL_URL}{path}", json=payload, headers=headers, timeout=INTEL_TIMEOUT_S)
    except httpx.HTTPError as e:
        log.info("intel %s unavailable (%s) - falling back to rules", path, type(e).__name__)
        return None
    if r.status_code != 200:
        log.warning("intel %s returned %s: %s - falling back to rules", path, r.status_code, r.text[:200])
        return None
    try:
        body = r.json()
    except ValueError:
        log.warning("intel %s returned non-JSON - falling back to rules", path)
        return None
    if body.get("schema") != features_v1.SCHEMA_VERSION:
        log.warning("intel %s schema mismatch (%s) - falling back to rules", path, body.get("schema"))
        return None
    return body


def track(
    vector: list[float],
    hidden: list[float] | None,
    *,
    trace_id: str | None = None,
) -> dict[str, Any] | None:
    """One GRU step. -> {hidden, state_scores{label:score}, state_label,
    cause_scores{cause:score}, model_version} or None."""
    if len(vector) != features_v1.DIM:
        log.error("intel track: vector has %d dims, schema needs %d", len(vector), features_v1.DIM)
        return None
    body = _post("/v1/track", {"schema": features_v1.SCHEMA_VERSION, "features": vector,
                               "hidden": hidden}, trace_id)
    if body is None or not isinstance(body.get("hidden"), list):
        return None
    return body


def rank(
    vector: list[float],
    gru: dict[str, Any] | None,
    candidates: list[str],
    *,
    trace_id: str | None = None,
) -> dict[str, Any] | None:
    """Booster ranking. -> {ranked:[{id, score}], model_version} or None."""
    body = _post("/v1/rank", {
        "schema": features_v1.SCHEMA_VERSION,
        "features": vector,
        "state_scores": (gru or {}).get("state_scores"),
        "cause_scores": (gru or {}).get("cause_scores"),
        "candidates": candidates,
    }, trace_id)
    if body is None or not isinstance(body.get("ranked"), list):
        return None
    return body


def health() -> dict[str, Any] | None:
    try:
        r = httpx.get(f"{INTEL_URL}/health", timeout=INTEL_TIMEOUT_S)
        return r.json() if r.status_code == 200 else None
    except (httpx.HTTPError, ValueError):
        return None
