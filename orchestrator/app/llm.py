"""OpenAI-compatible LLM client with strict JSON parsing (CLAUDE.md section 6.3).

Points at the LiteLLM proxy by default; LiteLLM speaks the OpenAI API, so the
same code works against OpenRouter directly by changing LLM_BASE_URL.

The contract that matters here: a model that returns malformed JSON gets exactly
one retry with a blunter instruction, and if that also fails we raise. We never
silently default a verdict to PASS or FAIL (trap 11) -- a wrong verdict looks
like a working product, which is far worse than an error.
"""
from __future__ import annotations

import json
import logging
import re
import time
from typing import Any, TypeVar

from openai import OpenAI
from pydantic import BaseModel, ValidationError

from app import config

log = logging.getLogger(__name__)

T = TypeVar("T", bound=BaseModel)

_client: OpenAI | None = None


def client() -> OpenAI:
    global _client
    if _client is None:
        _client = OpenAI(
            base_url=config.LLM_BASE_URL,
            api_key=config.LLM_API_KEY,
            timeout=config.LLM_TIMEOUT_S,
            max_retries=0,   # retries are explicit here, never hidden
        )
    return _client


class LLMError(RuntimeError):
    """Raised when the model could not be made to produce usable output."""


_FENCE_RE = re.compile(r"```(?:json)?\s*(.*?)\s*```", re.DOTALL)
_THINK_RE = re.compile(r"<think>.*?(</think>|$)", re.DOTALL | re.IGNORECASE)


def extract_json(text: str) -> str:
    """Pull a JSON object out of a model response.

    Small models wrap JSON in fences or add a sentence before it even when told
    not to. This is presentation noise, not a parse failure, so it is stripped
    before the retry is spent.
    """
    if not text:
        raise LLMError("model returned an empty response")

    fenced = _FENCE_RE.search(text)
    if fenced:
        text = fenced.group(1)

    text = text.strip()
    if text.startswith("{") and text.endswith("}"):
        return text

    # fall back to the outermost balanced braces
    start = text.find("{")
    end = text.rfind("}")
    if start >= 0 and end > start:
        return text[start:end + 1]

    raise LLMError(f"no JSON object in response: {text[:200]!r}")


def complete(
    *,
    model: str,
    system: str,
    user: str,
    temperature: float = 0.0,
    max_tokens: int | None = None,
) -> str:
    """One plain completion. Returns the message content."""
    t0 = time.perf_counter()
    resp = client().chat.completions.create(
        model=model,
        temperature=temperature,
        max_tokens=max_tokens,
        # Local qwen3 "thinks" by default: measured 80 s and 301 tokens for a
        # one-line question, vs 5 s and 15 tokens with thinking off. LiteLLM
        # forwards this to Ollama; other providers ignore it (drop_params).
        extra_body=None if config.LLM_THINK else {"think": False},
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
    )
    took = time.perf_counter() - t0
    # Reasoning models (local qwen3 via Ollama) may prepend a <think> block.
    # It is the model's scratchpad, never meant for a student, and it would
    # also break JSON parsing -- so it is removed before anything else sees it.
    content = _THINK_RE.sub("", resp.choices[0].message.content or "").strip()
    log.info("llm model=%s took=%.1fs chars=%d", model, took, len(content))
    if not content:
        raise LLMError(f"model {model} returned an empty message")
    return content


def complete_json(
    *,
    model: str,
    system: str,
    user: str,
    schema: type[T],
    temperature: float = 0.0,
    max_tokens: int | None = None,
) -> T:
    """Completion parsed into a pydantic model, with exactly one repair retry.

    On the second failure this raises rather than guessing (trap 11).
    """
    attempts: list[str] = []

    for attempt in (1, 2):
        sys_prompt = system
        usr_prompt = user
        if attempt == 2:
            sys_prompt = system + "\n\nReturn valid JSON only. No prose, no code fences."
            usr_prompt = (
                user
                + "\n\nYour previous reply could not be parsed as JSON. "
                  "Return ONLY the JSON object, starting with { and ending with }."
            )

        raw = complete(
            model=model,
            system=sys_prompt,
            user=usr_prompt,
            temperature=temperature,
            max_tokens=max_tokens,
        )

        try:
            return schema.model_validate_json(extract_json(raw))
        except (LLMError, ValidationError, json.JSONDecodeError) as e:
            attempts.append(f"attempt {attempt}: {type(e).__name__}: {e}")
            log.warning("llm json parse failed (attempt %d/2) model=%s: %s", attempt, model, e)

    raise LLMError(
        f"model {model} did not return valid {schema.__name__} JSON after 2 attempts:\n"
        + "\n".join(attempts)
    )


def describe() -> dict[str, Any]:
    """Used by /health and the CLI banner so the wiring is visible."""
    return {
        "base_url": config.LLM_BASE_URL,
        "evaluator": config.LLM_MODEL_EVALUATOR,
        "tutor": config.LLM_MODEL_TUTOR,
    }
