# What we cut, and why — LogiStream MVP

Slide-ready. Every row is a deliberate decision with the seam that makes it
reversible, not a corner we hoped nobody would notice.

## The headline

**Three days, one problem, one happy path — end to end through four services.**
Everything below was cut to protect that, and each cut leaves a named seam.

---

## Deviations from the full specification

| # | Full spec | What we built | The seam back |
|---|---|---|---|
| 1 | Supabase JWT validated at the edge | Mocked auth: a fixed demo user in Rust | Auth is **one extractor** in the gateway. The `thread_id` is still derived for real — `sha256(user_id + ":" + problem_id)` — and a client-supplied one is ignored. |
| 2 | Supabase Postgres | Local Postgres 16 container | Same SQL, same `DATABASE_URL`. |
| 3 | Infisical runtime secrets | `.env` file | Everything already reads environment variables. |
| 4 | LiteLLM proxy | **Built — not cut.** Kept because the free tier needs it. | — |
| 5 | SSE with status heartbeats | Plain request/response + a busy state with a live seconds counter | Response shape unchanged. |
| 6 | Translation / Syntax / Runtime tutors | One code tutor with the failure bucket in its prompt | The bucket mapping already exists; splitting it is a routing change. |
| 7 | Deterministic **and** LLM-judge verifier | Deterministic verifier only | The judge is an extra check in the same node. |
| 8 | Multi-language submissions | Python only | `language` is already a request field, validated and rejected for anything else. |
| 9 | Spring Data JPA | Spring `JdbcTemplate` | Repository layer only. Avoids jsonb mapping pain. |
| 10 | Self-hosted Judge0 | **Local subprocess sandbox** | `Sandbox` is an interface. `EXECUTOR_MODE=JUDGE0` swaps the hosted client back in; it is still compiled and unit-tested. |
| 11 | Offline CrewAI content pipeline | Hand-seeded Two Sum | The seed format **is** the pipeline's output format. |
| 12 | Review queue / transcripts | `FLAGGED` verdicts are logged, not queued | The log line marks exactly where the queue goes. |
| 13 | All services in docker-compose | Infra in compose; app services on the host | All URLs are environment variables. |

---

## The three decisions worth defending

### 1. Judge0 → a local sandbox that really executes

Judge0's sandbox needs cgroup v1; this machine is Docker Desktop on cgroup v2.
The hosted API was the plan, but it needs a credit card and this is a zero-budget
student project. A metered third-party sandbox on a free tier is also a live-demo
liability.

So execution runs in a subprocess here. **Not a mock** — real `SyntaxError`, real
`KeyError`, a real timeout that really kills the process, real wrong answers. An
examiner can type arbitrary code during Q&A and get a truthful verdict, which a
pattern-matching mock could not survive.

It reports **Judge0's own status ids**, so the entire bucket-mapping table and its
13 unit tests are unchanged, and swapping Judge0 back in touches one class.

**Say the limitation out loud:** this is not a security sandbox. Student code runs
with the service's privileges. It has a hard timeout with forced kill of the
process tree, a fresh temp directory per run, no shell, `-I` isolated mode and
truncated output capture — appropriate for a single-user local demo and nothing
more. Real isolation is a container per run.

### 2. LiteLLM came back, because it earns its place

The spec deferred LiteLLM. We reinstated it — not for the slide, but because the
free tier makes it load-bearing:

- The orchestrator asks for `logistream-evaluator` and `logistream-tutor`. It
  never names a vendor. Swapping providers is one file.
- **Round-robin across three API keys**, because free-tier limits are per key.
- **A model fallback underneath**, because keys do not help when the *model* is
  limited.

Both layers were needed. Measured on the morning of the demo: the primary model
returned 429 on all three keys simultaneously, and the fallback answered. With
keys alone, every one of those requests would have failed.

### 3. The tutor is *prevented* from answering, not asked not to

This is the product claim, and it is enforced in code rather than in a prompt.
Every tutor turn passes a deterministic verifier before a student can see it:
code fences, code-shaped lines, the rubric's forbidden vocabulary, and length.
A rejected draft is regenerated; after the limit it falls back to a canned
Socratic question. **Unverified text is never delivered.**

It fires in practice, not just in tests. During the end-to-end run the code
tutor's first draft was 161 words against a 160-word limit, was rejected, and the
regeneration was delivered — visible in the "Under the hood" panel as
`regenerations 1` and in the node path as `code_tutor → verify_code → code_tutor
→ verify_code`.

Hidden test data is stripped **twice**: once before the browser, and once before
the tutor's own context window. A model that has seen the hidden inputs will
eventually quote them.

---

## Bring-your-own-problem branch (2026-10-23)

| # | Original plan | What the branch does | Why |
|---|---|---|---|
| B1 | Free OpenRouter models via LiteLLM | LiteLLM → **local Ollama** `logistream-qwen3` (qwen3-14b, 8k ctx, thinking off) | Free models withdrawn; owner chose local. OpenRouter stays as backup group. |
| B2 | Everything on the laptop | UI on **Vercel**, backend on the laptop behind a **Cloudflare quick tunnel** | Public demo URL with zero hosting cost. Passcode + CORS list + rate limit guard the tunnel. |
| B3 | `sess_<uuid>` per custom problem (brief default) | Server-minted, owner-bound `custom-<uuid>` problem id; thread still `sha256(user:problem)` | Same properties; no session route changed. |
| B4 | Rust booster ranks causes | Booster runs in **shadow mode**; rules-v1 orders | It loses to the rules on held-out synthetic data; promotion is metrics-gated. |
| B5 | Services bind 127.0.0.1 | Default 0.0.0.0 with `*_BIND` overrides | `localhost` → v4-only listener costs ~2 s per call on Windows. |
| B6 | Vision model in the cloud | **Local only** Qwen2.5-VL 3B; non-local `OLLAMA_URL` refuses to start | Brief: no external screenshot API; frames never stored. |

All `intel/` models are **synthetic-trained v0, advisory, unvalidated**; scores are not probabilities.

---

## Known limitations, stated plainly

| Limitation | Impact | Why it is acceptable here |
|---|---|---|
| Not a security sandbox | Untrusted code could harm the host | Single-user local demo with fixed fixtures |
| Free-tier LLM latency, 15–90 s per turn | Visible waits | Caches make the scripted beats fast; the UI shows a live counter |
| One problem, one language | No breadth | Depth over breadth was the explicit goal |
| Mocked auth | No real users | The identity derivation is real and tested |
| Verdict quality depends on a free model | Occasional misjudgement | Model chosen by measured bake-off, not by guess |

---

## What is real, and tested

| | |
|---|---|
| Services | 4 (Next.js · Rust/Axum · Python/FastAPI+LangGraph · Java/Spring) + Postgres + LiteLLM |
| Automated tests | **85** Python · **13** Java · **6** Rust |
| Verify scripts | `db` 21 · `domain` 12 · `orchestrator` 22 · `gateway` 20 — all green |
| Session durability | Proven by killing the orchestrator mid-conversation; the transcript survived |
| Identity | `thread_id` derived server-side; client-supplied ids ignored, asserted three ways |
| Tracing | One `X-Trace-Id` followed across browser → Rust → Python → Java |
