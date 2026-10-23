"""Environment configuration for the orchestrator.

Everything is read from the environment (CLAUDE.md section 1.8). The start
scripts do `set -a; source .env; set +a` before launching uvicorn.
"""
from __future__ import annotations

import os


def _int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except ValueError:
        return default


def _float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, default))
    except ValueError:
        return default


# --- LLM -------------------------------------------------------------------
# LLM_BASE_URL points at the LiteLLM proxy by default. LiteLLM is an
# OpenAI-compatible endpoint, so nothing in the code changes when it is
# bypassed -- set LLM_BASE_URL back to https://openrouter.ai/api/v1 and put the
# OpenRouter key in LLM_API_KEY.
LLM_BASE_URL = os.environ.get("LLM_BASE_URL", "http://localhost:4000/v1")
LLM_API_KEY = (
    os.environ.get("LITELLM_MASTER_KEY")
    or os.environ.get("OPENROUTER_API_KEY")
    or "sk-not-set"
)
LLM_MODEL_EVALUATOR = os.environ.get("LLM_MODEL_EVALUATOR", "logistream-evaluator")
LLM_MODEL_TUTOR = os.environ.get("LLM_MODEL_TUTOR", "logistream-tutor")
LLM_TIMEOUT_S = _float("LLM_TIMEOUT_S", 150.0)   # cold local model after a VLM swap: ~76 s
# Reasoning ("thinking") on local models: off unless LLM_THINK=1.
LLM_THINK = os.environ.get("LLM_THINK", "0").lower() in ("1", "true", "yes")

# --- graph behaviour -------------------------------------------------------
FLAG_CONFIDENCE_THRESHOLD = _float("FLAG_CONFIDENCE_THRESHOLD", 0.6)
MAX_REGENERATIONS = _int("MAX_REGENERATIONS", 2)

# --- services --------------------------------------------------------------
DOMAIN_URL = os.environ.get("DOMAIN_URL", "http://localhost:8080")
INTERNAL_TOKEN = os.environ.get("INTERNAL_TOKEN", "dev-internal-token-change-me")
ORCHESTRATOR_PORT = _int("ORCHESTRATOR_PORT", 8001)
DATABASE_URL = os.environ.get(
    "DATABASE_URL", "postgresql://logistream:logistream@localhost:5432/logistream"
)
