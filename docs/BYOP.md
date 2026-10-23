# Bring-your-own-problem (BYOP) — design, contract and status

Branch: `feature/bring-your-own-problem`. Implements the demo-critical half of
`CLAUDE_IMPLEMENTATION_PLAN.md` (steps 1–6, 10–12) plus the rules baseline of the
diagnostic ranker (step 8) and run-level temporal memory (part of step 7). The
screen observer and local VLM are **not built yet** — see *Not done* below.

The Level 2 / Level 3 direction is unchanged: local VLM via Ollama, temporal
state, an XGBoost ranker that complements (never replaces) the model, and the
existing LangGraph tutor as the only tutor.

---

## 1. Audit findings (step 1)

| Area | Finding before this change |
|---|---|
| Frontend | `web/app/page.tsx` hard-coded `PROBLEM_ID = "two-sum"`; the only entry path. |
| Gateway | Problem id is free-form in every body; `thread_id = sha256(user:problem)` — already problem-agnostic. `GET /api/problems/{id}` called Java's **public** route with no user. Bound `0.0.0.0`. |
| Orchestrator | Every session started in `LOGIC`; the only way to the editor was passing the rubric-driven `evaluate_logic`. Nodes read `ctx["rubric"]` unconditionally. |
| Java | `app.problems` had no owner or kind. `ExecutionService` threw if a problem had no tests. The harness was two-sum specific (function call), but stored per problem. Bound to all interfaces while running arbitrary code via `LocalPythonSandbox` (not a security sandbox). |
| DB | Init scripts run only on an empty volume; the demo volume must never be wiped (CLAUDE.md D3-T4), so a migration cannot live in `db/init/`. |
| Ollama / GPU | Ollama 0.32.7 installed, one text model (`qwen3-14b-64k`), no VLM pulled. RTX 5050 Laptop, 8 GB VRAM. |

Baseline before any edit: `pytest` 85/85, `mvn test` 13/13, `cargo test` 6/6, `tsc --noEmit` clean.

## 2. Product flow

* `/` — landing page. **Bring your own problem** form (primary) + *Try a sample
  problem* (Two Sum) + *Your problems*.
* `/?problem=<id>` — a session. Refresh resumes it (checkpointing unchanged).
* **Curated** problems (two-sum) keep the logic-first gate exactly as before.
* **Custom** problems start in `CODE` with the student's attempt in the editor.
  There is no rubric, so there is no logic gate; the tutor is available from the
  first turn (chat) and after every run.

## 3. Contract changes (all additive / backward compatible)

### Gateway (browser-facing)

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/problems` | **new** → `{problems:[{id,title,kind,language,created_at}]}`: curated + the caller's own |
| `POST` | `/api/problems` | **new** → 201 + problem view. Body below. Owner = resolved user (never the body) |
| `GET` | `/api/problems/{id}` | now via Java `/internal/problems/{id}/view` with `X-User-Id`; 404 for someone else's problem |

All session endpoints are unchanged. `thread_id` derivation is unchanged and
still never accepted from the client.

```json
POST /api/problems
{
  "title": "optional, ≤120",
  "statement": "required, ≤20000",
  "constraints": "optional, ≤4000",
  "examples": [{"input": "...", "output": "...", "explanation": "optional"}],   // ≤10
  "starter_code": "optional, ≤50000 — starter code or current attempt",
  "language": "python",                                                        // only python today
  "tests": [{"label": "optional", "input": "stdin", "expected_output": "stdout"}] // ≤20, each ≤20000
}
```

Validation is in Java (`CustomProblemValidator`): 422 with `{error, field}`
(the gateway copies `error` into `detail` for the UI). Cap: 100 problems/user.

Problem view gains `kind` (`curated|custom`), `constraints`, `test_count`.

### Execution model for custom problems

The program reads **stdin** and prints its answer; each test is
`(stdin, expected stdout)`, compared after `strip()` exactly like curated tests.
Student-written tests are stored as public (nothing to hide). If there are **no
tests**, Java runs the program once on empty input and returns bucket
**`NO_TESTS`** with `passed/total = 0/0` — errors still map to
`COMPILE_ERROR`/`RUNTIME_ERROR`/`TLE`, but a clean run is never `ACCEPTED` and the
session never reaches `DONE` on it.

### SessionView additions

* `problem_kind`: `curated | custom`
* `diagnosis`: `{ranker, score_kind, bucket, candidates:[{id, cause, next_action, score, evidence[]}]}` or null
* `debug.run_history`: `[{ts, bucket, passed, total, code_sha, top_cause, verified}]`

### Schema

`domain/src/main/resources/schema-byop.sql`, applied by Spring at every startup
(idempotent `ALTER … ADD COLUMN IF NOT EXISTS`): `kind`, `owner_id`, `language`,
`constraints_text`, `created_at` on `app.problems`. Existing rows default to
`curated`. **No volume wipe needed.**

## 4. Orchestrator

* `initial_state(..., kind, starter_code)`: custom → `phase=CODE`, `user_code=starter`.
* `start` checks ownership once (Java 404 → 404) before creating the thread.
* `execute_code` → `diagnostics.rank()` (rules baseline) + one `run_history`
  record per run (cap 20; infra failures are not recorded).
* `code_tutor` picks the prompt by kind. The custom prompt
  (`prompts/custom_tutor.py`) treats the statement as **untrusted data**, must
  label claims **Verified:** vs **Hypothesis:**, must never call a `NO_TESTS` run
  correct, and escalates hints 1→3 only when runs keep failing on the same cause.
* `verify_code` additionally treats every function the student defined as an
  entrypoint the tutor may not redefine (custom problems have no rubric
  entrypoint). Word and code-block limits are unchanged.
* `finish` for custom: *"verified against the tests you supplied"*.

## 5. Diagnostic ranker (step 8) — baseline only

`orchestrator/app/diagnostics.py`, `RANKER_VERSION = rules-v1`.

* Rules over the actual evidence: exception type + the failing line **in the
  student's own code** (harness frames skipped), empty/None/format-only/extra
  output on the first failing public test, loop nesting for TLE, unchanged code
  since the previous run, and "unverified" for `NO_TESTS`.
* Scores are rule weights for **ordering only** and are labelled
  `"rule weight (ordering only, not a probability)"` in the API and UI.
* `features()` emits the versioned flat feature vector
  (`diag-features-v1`) an XGBoost ranker will train on. It contains counts and
  statuses only — never hidden-test data — and stays server-side.
* **XGBoost is not trained.** No labelled outcomes exist yet. Plan: log feature
  vectors + the student's next-run outcome (opt-in), label "did the top
  candidate's next_action precede a fix", split by problem, compare NDCG@3 /
  top-1 against `rules-v1`, and ship only if it beats it. Rules remain the
  fallback whenever the model is missing.

## 6. Security / privacy notes

* Custom problems are private (owner check on view, context-at-start, list).
  Ids are `custom-<uuid4>`.
* Bind addresses are now configurable (`GATEWAY_BIND`, `ORCHESTRATOR_BIND`,
  `DOMAIN_BIND`) but **default to all interfaces, as before**. Defaulting them
  to 127.0.0.1 was tried and reverted: on Windows every `localhost` call to a
  v4-only listener first spends ~2 s failing on `::1` (measured: orchestrator
  `/health` 0.25 s → 2.3 s), which broke `start.sh`'s health probe and slowed
  every turn. To lock down, set all three to `127.0.0.1` **and** change every
  `localhost` URL in `.env` to `127.0.0.1`. `LocalPythonSandbox` is still
  **not** a security sandbox: custom problems make arbitrary code execution
  more obvious, not new. Do not expose this stack publicly.
* Auth is still the mocked demo user (`X-Demo-User` override). Privacy between
  users is only as strong as that mock.
* *Reset* clears a session's conversation, runs and history (checkpoint delete).
  Deleting a custom problem is not implemented yet.

## 7. Tests

| Suite | Result |
|---|---|
| `orchestrator: uv run pytest` | 103 passed (18 new in `tests/test_byop.py`) |
| `domain: mvn test` | 22 passed (`CustomProblemValidatorTest` 7, `BucketMapperTest` +2) |
| `gateway: cargo test` | 7 passed (+ path-segment encoding) |
| `web: npx tsc --noEmit` | clean |
| `python -I demo/verify_byop.py --no-llm` | **37/37** end to end through :8000 (2026-10-23) |
| Browser (built-in pane) | landing → create problem with 1 test → session at `?problem=custom-…` → run → WRONG_ANSWER row, tutor hint with real evidence, Under-the-hood diagnosis + run history |

### LLM outage found during verification (pre-existing, not caused by BYOP)

On 2026-10-23 every LLM call failed: OpenRouter reports the primary
`qwen/qwen3.8-27b:free` *"is unavailable for free"* and the backup
(Nvidia-hosted) returns 404. This breaks **every** tutor/evaluator turn,
including the curated two-sum logic phase. `litellm_config.yaml` needs a new
model choice (re-run `orchestrator/scripts/model_bakeoff.py`) — a budget
decision left to the human.

What changed because of it: `code_tutor` no longer turns an LLM failure into a
500 that hides the run's result. It delivers `diagnostics.fallback_hint()` —
*Verified:* bucket and counts, *Hypothesis:* the top ranked cause with its
evidence, *Next:* its action — marked as coming from the automatic diagnosis,
sets `fallback_used`, and still passes through `verify_code`. The verify run
above exercised exactly this path; the LLM-written custom tutor turns are
**not yet verified live**. `evaluate_logic` is unchanged and still fails loudly
(it must never default a verdict).

## 8. Not done yet (Level 2 / Level 3, in plan order)

1. **Screen observer** — visible, pausable capture in the UI (`getDisplayMedia`
   with a persistent indicator), sampled every N s + on run/error events,
   downscaled, never stored raw by default.
2. **Ollama VLM** — pull a vision model (Qwen2.5-VL 3B candidate; check it fits
   8 GB alongside nothing else and measure latency), add an `interpret_context`
   step that turns a frame + previous summary into a compact observation with a
   timestamp. Disabled/“manual” fallback if Ollama is down; never a cloud API.
3. **Observation merge** — observations join `run_history` as a second event
   kind; stale ones (older than the latest run) are marked and cannot override
   sandbox results.
4. **XGBoost** — as in §5, once data exists.

## 9. Rollback

Everything is on the feature branch. To roll back: `git switch main`. The schema
change is additive; old code ignores the new columns, so no DB rollback is
needed. Custom rows can be removed with
`DELETE FROM app.hidden_tests WHERE problem_id LIKE 'custom-%'; DELETE FROM app.problems WHERE kind='custom';`.
