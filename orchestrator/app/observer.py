"""Screen observer: one downscaled frame -> local Ollama VLM -> short text.

GUARDRAILS (CLAUDE_CODE_BRIEF section 5), enforced here rather than trusted:
  * LOCAL ONLY. OLLAMA_URL must point at this machine (localhost / 127.0.0.1 /
    ::1). Anything else is refused at import time -- there is no code path to a
    cloud vision API, and no silent fallback to one.
  * The frame is never stored or logged. It lives for the duration of one HTTP
    call; only the returned text (and four boolean tags) go into the session.
  * One VLM call in flight at a time, process-wide: an 8 GB GPU runs one 3B
    vision model, and a queue of frames would only produce stale answers.
  * Failure is loud and harmless: callers get ObserverUnavailable with a reason,
    show "observer unavailable", and tutoring carries on without it.
"""
from __future__ import annotations

import base64
import binascii
import json
import logging
import os
import threading
import time
from typing import Any
from urllib.parse import urlparse

import httpx

log = logging.getLogger(__name__)

OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://localhost:11434").rstrip("/")
OLLAMA_VLM_MODEL = os.environ.get("OLLAMA_VLM_MODEL", "qwen2.5vl:3b")
OLLAMA_TIMEOUT_S = float(os.environ.get("OLLAMA_TIMEOUT_S", "60"))
MAX_IMAGE_BYTES = 2_500_000
MAX_TEXT = 300
MAX_PROBLEM_TITLE = 120
MAX_PROBLEM_STATEMENT = 1500

_LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1"}
_in_flight = threading.Lock()


class ObserverUnavailable(RuntimeError):
    """The local VLM could not produce an observation (down, missing, timeout)."""


class BadFrame(ValueError):
    """The uploaded frame is not a small JPEG/PNG."""


def _assert_local(url: str) -> None:
    host = (urlparse(url).hostname or "").lower()
    if host not in _LOCAL_HOSTS:
        raise RuntimeError(
            f"OLLAMA_URL must be local (localhost/127.0.0.1/::1), got host {host!r}. "
            "Screen frames never leave this machine.")


_assert_local(OLLAMA_URL)


PROMPT = """\
You are looking at ONE screenshot of a student's own coding screen (an editor, \
a terminal or a browser, possibly a practice site such as LeetCode, \
GeeksforGeeks or HackerRank). Describe only what is visible. Do not guess at \
code or text that is not visible. Do not give advice.

Return JSON only:
{"activity": "editing" | "terminal" | "browser" | "other",
 "error_visible": true | false,
 "error_text": "the visible error message, verbatim, max 120 chars, or empty",
 "problem_title": "the title of the coding problem shown on screen, verbatim, or empty if none is visible",
 "problem_statement": "that problem's visible statement, examples and constraints, copied verbatim, max 600 characters, or empty",
 "summary": "what the student appears to be doing, max 30 words"}"""


def decode_frame(image_b64: str) -> bytes:
    if not image_b64 or not isinstance(image_b64, str):
        raise BadFrame("image_b64 is required")
    if image_b64.startswith("data:"):
        image_b64 = image_b64.split(",", 1)[-1]
    try:
        raw = base64.b64decode(image_b64, validate=True)
    except (binascii.Error, ValueError) as e:
        raise BadFrame("image_b64 is not valid base64") from e
    if len(raw) > MAX_IMAGE_BYTES:
        raise BadFrame(f"frame is {len(raw)} bytes; downscale it (max {MAX_IMAGE_BYTES})")
    if not (raw.startswith(b"\xff\xd8\xff") or raw.startswith(b"\x89PNG\r\n\x1a\n")):
        raise BadFrame("frame must be a JPEG or PNG")
    return raw


def parse_reply(content: str) -> dict[str, Any]:
    """Model JSON -> {text, tags}. Tolerant of fences; never invents an error."""
    s = (content or "").strip()
    if s.startswith("```"):
        s = s.strip("`")
        s = s[s.find("{"):] if "{" in s else s
    try:
        d = json.loads(s[s.find("{"): s.rfind("}") + 1] if "{" in s else s)
    except ValueError as e:
        raise ObserverUnavailable(f"VLM returned non-JSON: {content[:120]!r}") from e
    activity = str(d.get("activity") or "other").lower()
    error_text = str(d.get("error_text") or "").strip()[:120]
    error_visible = bool(d.get("error_visible")) and bool(error_text)
    summary = str(d.get("summary") or "").strip()
    # a problem the student is reading (e.g. on a practice site). Screen text is
    # DATA: it is shown to the student and only becomes a session if they click.
    title = " ".join(str(d.get("problem_title") or "").split())[:MAX_PROBLEM_TITLE]
    statement = str(d.get("problem_statement") or "").strip()[:MAX_PROBLEM_STATEMENT]
    problem = {"title": title, "statement": statement} if title else None
    text = summary + (f" Error visible on screen: {error_text}" if error_visible else "")
    if problem:
        text = f"{text} Problem on screen: {title}."
    return {
        "text": text.strip()[:MAX_TEXT] or "(nothing recognisable on screen)",
        "problem": problem,
        "tags": {
            "error_visible": error_visible,
            "editing": activity == "editing",
            "terminal": activity == "terminal",
            "offtask": activity in ("browser", "other"),
        },
    }


def interpret(image_b64: str) -> dict[str, Any]:
    """One frame -> {text, tags, model, latency_ms}. Raises BadFrame / ObserverUnavailable."""
    raw = decode_frame(image_b64)
    if not _in_flight.acquire(blocking=False):
        raise ObserverUnavailable("busy: one observation is already being interpreted")
    t0 = time.monotonic()
    try:
        r = httpx.post(f"{OLLAMA_URL}/api/chat", timeout=OLLAMA_TIMEOUT_S, json={
            "model": OLLAMA_VLM_MODEL,
            "stream": False,
            "format": "json",
            "keep_alive": "15m",
            "options": {"temperature": 0, "num_predict": 450},
            "messages": [{"role": "user", "content": PROMPT,
                          "images": [base64.b64encode(raw).decode("ascii")]}],
        })
    except httpx.TimeoutException as e:
        raise ObserverUnavailable(f"VLM timed out after {OLLAMA_TIMEOUT_S:.0f}s") from e
    except httpx.HTTPError as e:
        raise ObserverUnavailable(f"Ollama is not reachable at {OLLAMA_URL}") from e
    finally:
        _in_flight.release()
        del raw  # the frame is gone after this call either way

    if r.status_code == 404:
        raise ObserverUnavailable(f"model {OLLAMA_VLM_MODEL} is not pulled "
                                  f"(run: ollama pull {OLLAMA_VLM_MODEL})")
    if r.status_code != 200:
        msg = r.text[:200]
        if "memory" in msg.lower():
            raise ObserverUnavailable("the GPU ran out of memory for the vision model")
        raise ObserverUnavailable(f"Ollama returned {r.status_code}: {msg}")
    try:
        content = r.json()["message"]["content"]
    except (ValueError, KeyError, TypeError) as e:
        raise ObserverUnavailable("unexpected Ollama response shape") from e

    out = parse_reply(content)
    out["model"] = OLLAMA_VLM_MODEL
    out["latency_ms"] = int((time.monotonic() - t0) * 1000)
    log.info("observer: %d ms, tags=%s", out["latency_ms"], out["tags"])
    return out


def status() -> dict[str, Any]:
    """Honest availability for the UI. Never raises."""
    out: dict[str, Any] = {"available": False, "model": OLLAMA_VLM_MODEL,
                           "model_present": False, "ollama_version": None, "detail": ""}
    try:
        v = httpx.get(f"{OLLAMA_URL}/api/version", timeout=3.0)
        out["ollama_version"] = v.json().get("version") if v.status_code == 200 else None
        tags = httpx.get(f"{OLLAMA_URL}/api/tags", timeout=3.0).json().get("models", [])
    except (httpx.HTTPError, ValueError):
        out["detail"] = f"Ollama is not running at {OLLAMA_URL}"
        return out
    names = {m.get("name") for m in tags} | {m.get("model") for m in tags}
    want = OLLAMA_VLM_MODEL if ":" in OLLAMA_VLM_MODEL else f"{OLLAMA_VLM_MODEL}:latest"
    out["model_present"] = want in names
    if not out["model_present"]:
        out["detail"] = f"model not pulled: ollama pull {OLLAMA_VLM_MODEL}"
        return out
    out["available"] = True
    out["detail"] = "local vision model ready"
    return out
