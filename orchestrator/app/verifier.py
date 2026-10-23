"""Deterministic verification of tutor drafts (CLAUDE.md section 6.4).

This is the component that makes the product claim true: the tutor is not
*asked* to avoid giving the answer, it is *prevented* from doing so. Every draft
an LLM produces passes through here before a student can see it. Unverified text
is never delivered.

Deliberately has no LLM in it and no dependencies beyond the standard library,
so it is fast, free and fully unit-testable. The Day 3 stretch adds an LLM judge
as an *extra* check in the same node -- it never replaces these rules.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

MAX_WORDS_LOGIC = 120
MAX_WORDS_CODE = 160
MAX_CODE_BLOCK_LINES = 3

CODE_FENCE = "```"

# A line that is a python statement opening a block: "for each number:" is fine
# prose, "for i in range(n):" is not.
CODE_LINE_RE = re.compile(
    r"^\s*(def|for|while|if|elif|return|import|class)\b.*:\s*$",
    re.MULTILINE,
)

# The giveaway assignments: `seen = {}`, `d = dict()`, `s = set()`, `xs = []`.
EMPTY_CONTAINER_ASSIGN_RE = re.compile(r"\w+\s*=\s*(\{\}|\[\]|dict\(|set\()")

# Two constructs that name the mechanism outright.
IN_RANGE_RE = re.compile(r"in range\(")
DOT_GET_RE = re.compile(r"\.get\(")

# Approved addition to section 6.4 (human, 2026-09-21). The specified regex above
# requires a trailing colon, so a bare `return [i, j]` or `import json` on its own
# line slipped through. These two patterns are deliberately narrow: they require a
# bracket/paren directly after `return`, and a bare `import <name>` on a line of its
# own, so ordinary prose like "Return the indices, not the values." is untouched.
BARE_RETURN_RE = re.compile(r"^\s*return\s*[\[\(]", re.MULTILINE)
BARE_IMPORT_RE = re.compile(r"^\s*import\s+\w+\s*$", re.MULTILINE)


@dataclass
class VerificationResult:
    """Outcome of verifying one draft."""

    ok: bool
    rejections: list[dict[str, str]] = field(default_factory=list)

    @property
    def reasons(self) -> list[str]:
        return [r["reason"] for r in self.rejections]

    def __bool__(self) -> bool:
        return self.ok


def _reject(rejections: list[dict[str, str]], reason: str) -> None:
    rejections.append({"reason": reason})


def word_count(text: str) -> int:
    return len(text.split())


def find_forbidden_terms(text: str, terms: list[str]) -> list[str]:
    """Case-insensitive, word-boundary matches of any rubric forbidden term.

    Word boundaries matter: a draft saying "the mapping" is fine, one saying
    "a map" when "hash map" is forbidden should not trip, and "dictionary"
    must not be found inside an unrelated longer word.
    """
    found = []
    for term in terms:
        if not term.strip():
            continue
        pattern = r"\b" + re.escape(term.strip()) + r"\b"
        if re.search(pattern, text, re.IGNORECASE):
            found.append(term)
    return found


def _longest_code_run(text: str) -> int:
    """Longest run of consecutive lines that read as code rather than prose.

    Used only in the code phase, where the tutor is allowed to quote a line or
    two of the student's own code but not to hand back a working function.
    """
    longest = 0
    run = 0
    in_fence = False

    for line in text.splitlines():
        stripped = line.strip()

        if stripped.startswith(CODE_FENCE):
            in_fence = not in_fence
            # the fence markers themselves do not count as code lines
            if not in_fence:
                longest = max(longest, run)
                run = 0
            continue

        if in_fence:
            if stripped:
                run += 1
                longest = max(longest, run)
            continue

        if _looks_like_code_line(line) or BARE_RETURN_RE.match(line) or BARE_IMPORT_RE.match(line):
            run += 1
            longest = max(longest, run)
        else:
            run = 0

    return longest


def _looks_like_code_line(line: str) -> bool:
    stripped = line.strip()
    if not stripped:
        return False
    if CODE_LINE_RE.match(line):
        return True
    if EMPTY_CONTAINER_ASSIGN_RE.search(line):
        return True
    if IN_RANGE_RE.search(line) or DOT_GET_RE.search(line):
        return True
    # `seen[x] = i`, `nums[i] + nums[j] == target`
    if re.search(r"\w+\[[^\]]*\]\s*(=[^=]|==)", line):
        return True
    return False


def verify_logic_draft(draft: str, rubric: dict[str, Any]) -> VerificationResult:
    """Verify a logic-phase tutor turn.

    The logic tutor must ask one guiding question in the student's own register.
    It must never name the approach or the data structure, never write code, and
    never lay out the steps in order.
    """
    rejections: list[dict[str, str]] = []
    text = draft or ""

    if not text.strip():
        _reject(rejections, "draft is empty")
        return VerificationResult(False, rejections)

    if CODE_FENCE in text:
        _reject(rejections, "draft contains a code fence")

    if CODE_LINE_RE.search(text):
        _reject(rejections, "draft contains a code-like statement line")

    if BARE_RETURN_RE.search(text):
        _reject(rejections, "draft contains a bare 'return [' or 'return ('")

    if BARE_IMPORT_RE.search(text):
        _reject(rejections, "draft contains a bare import statement")

    if EMPTY_CONTAINER_ASSIGN_RE.search(text):
        _reject(rejections, "draft assigns an empty container (gives away the data structure)")

    if IN_RANGE_RE.search(text):
        _reject(rejections, "draft contains 'in range(' ")

    if DOT_GET_RE.search(text):
        _reject(rejections, "draft contains '.get(' ")

    forbidden = find_forbidden_terms(text, rubric.get("forbidden_terms_logic_tutor", []))
    if forbidden:
        _reject(rejections, "draft names forbidden term(s): " + ", ".join(sorted(set(forbidden))))

    words = word_count(text)
    if words > MAX_WORDS_LOGIC:
        _reject(rejections, f"draft is {words} words, limit is {MAX_WORDS_LOGIC}")

    return VerificationResult(not rejections, rejections)


_DEF_NAME_RE = re.compile(r"^\s*def\s+([A-Za-z_]\w*)", re.MULTILINE)


def defined_functions(student_code: str) -> list[str]:
    """Function names the student defined. A custom problem has no rubric
    entrypoint, so these stand in for it: the tutor must not redefine them."""
    return sorted(set(_DEF_NAME_RE.findall(student_code or "")))


def verify_code_draft(
    draft: str,
    rubric: dict[str, Any],
    extra_entrypoints: list[str] | None = None,
) -> VerificationResult:
    """Verify a code-phase tutor turn.

    Here the tutor may quote a short piece of the student's own code and name the
    broken construct -- but it must not write the solution or the full corrected
    function.
    """
    rejections: list[dict[str, str]] = []
    text = draft or ""

    if not text.strip():
        _reject(rejections, "draft is empty")
        return VerificationResult(False, rejections)

    entrypoints = [e for e in [rubric.get("entrypoint"), *(extra_entrypoints or [])] if e]
    for entrypoint in dict.fromkeys(entrypoints):
        if re.search(r"\bdef\s+" + re.escape(entrypoint) + r"\b", text):
            _reject(rejections, f"draft defines the entrypoint 'def {entrypoint}'")

    run = _longest_code_run(text)
    if run > MAX_CODE_BLOCK_LINES:
        _reject(rejections,
                f"draft contains a {run}-line code block, limit is {MAX_CODE_BLOCK_LINES}")

    words = word_count(text)
    if words > MAX_WORDS_CODE:
        _reject(rejections, f"draft is {words} words, limit is {MAX_WORDS_CODE}")

    return VerificationResult(not rejections, rejections)


# --------------------------------------------------------------------------
# fallbacks
# --------------------------------------------------------------------------

GENERIC_LOGIC_FALLBACK = (
    "Walk me through what happens on a small example, step by step."
)

GENERIC_CODE_FALLBACK = (
    "Run your function by hand on the first failing public example and compare "
    "each step with your logic."
)


def logic_fallback(rubric: dict[str, Any], misconception_id: str | None) -> str:
    """Canned reply used once MAX_REGENERATIONS is exhausted.

    Prefers the rubric's own socratic_counter for the diagnosed misconception,
    because it is already written in the student's register.
    """
    if misconception_id:
        for m in rubric.get("misconceptions", []):
            if m.get("id") == misconception_id and m.get("socratic_counter"):
                return m["socratic_counter"]
    return GENERIC_LOGIC_FALLBACK


def code_fallback() -> str:
    return GENERIC_CODE_FALLBACK
