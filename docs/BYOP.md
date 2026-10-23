# Bring-your-own-problem + screen-aware Socratic tutor — handoff

Branch `feature/bring-your-own-problem` (local only; nothing pushed, merged or
deployed). Built to `CLAUDE_CODE_BRIEF (1).md` (v2) on top of
`CLAUDE_IMPLEMENTATION_PLAN.md`. All seven steps of the brief's build order
were done; nothing was cut. What is *not* verified is listed in §9.

| Commit | Content |
|---|---|
| `d0030b9` | Step 2: custom problems, stdin/stdout execution, custom tutor, rules ranker |
| `d1a7cfc` | Steps 3–4 backend: passcode/CORS/rate limit, temporal memory, feature schema v1, diagnose node, observer endpoints |
| `0f4ba59` | Steps 4–5 UI: on-screen assistant (PiP), screen observer capture |
| `2d0b85e` | Local LLM via Ollama (owner decision), think off, timeouts |
| `274fd82` | Steps 6–7: Rust `intel/` sidecar, GRU + booster, training, eval, xgboost cross-check |

Rollback: `git switch main` (the branch is local only). The schema change is
additive, so no database rollback is needed.

---

## 1. What a student can do now

1. Open the UI → passcode screen when `DEMO_PASSCODE` is set → **Bring your own
   problem** form (statement, constraints, examples, Python, current attempt,
   optional stdin → expected-stdout tests). **Try a sample problem → Two Sum**
   stays as the reliable fallback, with its logic gate unchanged.
2. A custom session starts in one free-form phase: chat and code at any time,
   no rubric, no logic gate.
3. Runs go through the existing Java sandbox. Buckets: `ACCEPTED`,
   `WRONG_ANSWER`, `TLE`, `COMPILE_ERROR`, `RUNTIME_ERROR`, `INFRA_ERROR`, and
   **`NO_TESTS`** ("ran, not verified") when the problem has no tests;
   unsupported languages are rejected with 422.
4. Every run is diagnosed (rules ranker with quoted evidence; Rust GRU +
   booster alongside), recorded in temporal memory, and answered by the same
   Socratic tutor, which must label **Verified:** vs **Hypothesis:**.
5. **Assistant** opens an always-on-top Chrome Document Picture-in-Picture
   panel (in-page panel elsewhere): orb, "Try saying…" chips, latest reply,
   `+` attach, typed input, opt-in voice, capture status. Same conversation.
6. **Share screen** (opt-in, browser picker) samples the student's own IDE
   about every 15 s and on run/error; frames go to the laptop's **local**
   Ollama vision model and only a short text observation is kept.

## 2. Architecture (no new services except `intel/`)

```
web (Next.js, Vercel or :3000) ──► gateway (Rust :8000)  passcode · CORS list · rate limits
                                       ├─► orchestrator (FastAPI + LangGraph :8001)
                                       │     ├─ diagnose node ──► intel (Rust :8003, optional, 2 s timeout)
                                       │     ├─ tutor nodes ──► LiteLLM :4000 ──► Ollama logistream-qwen3 (local)
                                       │     └─ observe ──► Ollama qwen2.5vl:3b (local only)
                                       └─► domain (Java :8080) ──► local Python subprocess
```

Graph (custom and curated share it):

```
await_input ─(code)──► execute_code ─INFRA─► await_input
                            └──► diagnose ─ACCEPTED─► finish
                                     └──► code_tutor ⇄ verify_code ─► await_input
await_input ─(chat, CODE)──► diagnose ─► code_tutor ⇄ verify_code ─► await_input
await_input ─(observe)─────► diagnose ─────────────────────────────► await_input
(Two Sum LOGIC path unchanged: evaluate_logic / logic_tutor / summarize_logic)
```

`diagnose` is deterministic and never calls the LLM: gather evidence →
feature vector → GRU step → rank (rules; booster scores) → strategy → temporal
update, with at most 2 passes per turn.

## 3. API changes (all additive)

| Method | Path | Notes |
|---|---|---|
| GET | `/api/auth/check` | 200 when the passcode is right (or not required), 401 `passcode_required` |
| GET | `/api/problems` | curated + the caller's own |
| POST | `/api/problems` | create; Java validates (422 `{error, field}`), owner = resolved user |
| GET | `/api/problems/{id}` | owner-checked view (404 for someone else's) |
| POST | `/api/sessions/observe` | `{problem_id, image_b64, trigger, code_revision}` → SessionView; 503 "observer unavailable: …"; 3 MB cap; rate-limited |
| GET | `/api/observer/status` | `{available, model, model_present, ollama_version, detail}` |

Every `/api` route requires `X-Demo-Passcode` when `DEMO_PASSCODE` is set.
`CORS_ORIGIN` is a comma-separated allow-list (localhost:3000 always added).
Code runs and observations: `RUN_RATE_LIMIT_PER_MIN`,
`OBSERVE_RATE_LIMIT_PER_MIN` (default 12), keyed per passcode.

SessionView gains `problem_kind`, `diagnosis` (ranker, candidates with
evidence, rule score, booster `model_score`, iterations), `temporal` (summary,
code revision, events with `stale`, hypotheses, next action, ranker, student
state) and `debug.run_history`. The GRU hidden vector never leaves the server.

Orchestrator internal: `POST /sessions/{thread}/observe`, `GET /observer/status`.
Intel internal: `GET /health`, `POST /v1/track`, `POST /v1/rank`.

## 4. Identity and isolation

* The browser keeps a random `anon-<uuid>` in localStorage and sends it as
  `X-Demo-User`; auth is still the MVP mock. The gateway derives the thread as
  `sha256(user:problem)` and never accepts a client `thread_id`.
* A custom problem id is an opaque, server-minted `custom-<uuid>`, bound to its
  owner: the brief's default was a `sess_<uuid>` per custom problem. The
  properties are the same (opaque, server-minted, user-bound, client cannot
  pick the thread); minting it on the problem row let every existing session
  route stay unchanged. Two Sum keeps its derived id.
* One graph turn per thread at a time (per-thread lock); an observation that
  arrives mid-turn is skipped with 409.

## 5. Temporal memory and the observer

* `state["temporal"]` in the LangGraph checkpoint: rolling deterministic
  summary, the last 20 events (`run` / `chat` / `observation`), code revision,
  open hypotheses, next action, ranker, student state, GRU hidden state. Reset
  clears it. No image is ever in state: Python calls Ollama *before* resuming
  the graph and only the returned text enters it.
* Staleness: an observation records the code revision the browser had when it
  captured the frame. After a newer run it is shown as "seen earlier" and the
  prompt says not to treat it as current. Verified live: three observations
  turned stale the moment a run happened.
* Local-only: `OLLAMA_URL` must be localhost/127.0.0.1/::1 or the orchestrator
  refuses to start; there is no cloud vision path. Frames are validated
  (JPEG/PNG, ≤ 2.5 MB) and one VLM call runs at a time.

## 6. Rust `intel/` (synthetic-trained v0, advisory, unvalidated)

* `features.rs` — schema v1 (`docs/feature_schema_v1.md`), shared with Python
  through `intel/tests/golden_v1.json`, checked by both test suites.
* `gru.rs` — burn 0.18 (NdArray CPU, autodiff; built fine on the GNU target).
  30 → GRU(32) → student state (4) + cause group (6). Truncated BPTT, window 8.
* `booster.rs` — XGBoost-style, pure Rust: g = p − y, h = p(1 − p),
  w* = −G/(H + λ), gain with γ, shrinkage, depth, min child weight, row/column
  subsampling, 32-bin histograms, one-vs-rest over 22 causes.
* `synth.rs` — seeded scenarios (progressing, stuck, thrashing, idle,
  recovering); split by scenario, every 5th scenario group held out.
* `intel-train` → `intel/models/` (git-ignored; `start.sh` trains on first run,
  ~90 s, deterministic). `intel-serve` is stateless.

Held-out results (`intel/models/metrics-v0.json`, `xgb_crosscheck.json`):

| Task | Rules baseline | Rust model | real XGBoost 3.4.1 |
|---|---|---|---|
| Student state, accuracy / macro-F1 | 0.637 / 0.648 | **GRU 0.921 / 0.922** | – |
| Cause ranking, top-1 (2,096 cases) | **0.990** | booster 0.973 | 0.974 |
| Cause ranking, real-choice top-1 (552) | **0.964** | booster 0.899 | 0.900 |
| Cause ranking, macro-F1 | **0.994** | booster 0.895 | 0.895 |
| Top-1 agreement Rust vs XGBoost | | 99.8% | |

**Read this honestly.** The labels are generated by rules, so the models
mostly relearn rules. The GRU "beats" a simple state heuristic on states the
scenario script defines; that says nothing about real students. The booster
loses to the rules on cause ranking, so it runs in **shadow mode**: its
scores are shown, but it may reorder only if `metrics-v0.json` says it beat
the rules on held-out real-choice cases. The ranker label shown is
`rules-v1 (+ rust booster shadow)`; it would read
`rust-gru-booster-v0 synthetic` only after a promotion. Scores are never
called probabilities.

Fallbacks verified: `intel` down → `ranker=rules-v1`, no student state,
tutoring unchanged; missing/corrupt/mismatched model files → 503 for that
endpoint, rules fallback (Rust tests).

## 7. LLM: local Ollama (owner decision, 2026-10-23)

The free OpenRouter models were withdrawn (primary "unavailable for free",
backup 404). LiteLLM now routes `logistream-evaluator` / `logistream-tutor` to
`logistream-qwen3` (qwen3-14b with an 8k context,
`ollama/Modelfile.logistream-qwen3`); OpenRouter stays as the backup group.
`think: false` is sent (80 s → 5 s on a short turn). Measured on the RTX 5050
8 GB: VLM 3.1–3.2 s per frame (2.9 GB, 100% GPU); text model 10 GB, 42% on
CPU; a tutor turn takes 12–28 s warm and ~66–85 s right after Ollama swapped
the vision model out (the two do not fit in VRAM together). Timeouts: LLM
150 s, gateway upstream 170 s.

## 8. Tests and checks (2026-10-23)

| Check | Result |
|---|---|
| `orchestrator: uv run pytest` | **120 passed** |
| `intel: cargo test --release` | **14 passed** |
| `gateway: cargo test` | **11 passed** |
| `domain: mvn test` | **22 passed** |
| `web: tsc --noEmit`, `next build` | clean; `/` prerenders static |
| `python -I demo/verify_byop.py` (real local LLM) | **41/41** |
| Public-mode gateway (passcode, CORS list, rate limit) | verified live on a second gateway instance |
| Observer through gateway → Ollama | verified live (synthetic terminal frame; error read correctly; quiet, text only) |
| `intel` down live | verified: rules fallback, tutor reply unchanged |
| Two Sum regression `demo/rehearse.sh` | GREEN, 5 beats, 78 s |
| `gateway/verify.sh` | 20 passed, 0 failed |

## 9. Not verified / known limitations

* **Document PiP in real Chrome is not verified.** The Claude browser pane
  exposes the API but would not open the window; the in-page fallback was
  verified there. Test in Chrome 116+ from a click on **Assistant**.
* **Real `getDisplayMedia` capture is not verified** (the embedded pane cannot
  share a screen). The pipeline behind it was verified with a synthetic frame.
* **Voice** (Web Speech) and read-aloud are not verified; both are opt-in and
  off by default. Chrome sends recognition audio to Google, and the panel says
  so.
* **The Vercel deploy and Cloudflare tunnel have not been run** — by design;
  the owner pushes and deploys (`demo/DEPLOY_VERCEL.md`). Quick tunnels cut
  responses at ~100 s, which a cold local turn can approach.
* Free-form Python only; `LocalPythonSandbox` is not a security sandbox.
* Custom problems cannot be deleted from the UI yet; reset clears a session.
* `X-Demo-User` is client-supplied (an unguessable random id per browser), so
  isolation is only as strong as the mocked auth.
