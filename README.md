# LogiStream

**A Socratic coding tutor that makes students think before they type, and an
on-screen agent that watches them solve problems anywhere — without ever handing
over the answer.**

[![Open the ML notebook in Colab](https://colab.research.google.com/assets/colab-badge.svg)](https://colab.research.google.com/github/SachmanChadhaa/Logi_Stream/blob/main/notebooks/LogiStream_GRU_XGBoost.ipynb)

LogiStream started as a three-day MVP with one rule: *describe your algorithm in
plain English (or Hinglish) before you are allowed to write code*. Wrong logic is
answered by a tutor that is **structurally prevented** from giving the solution:
every reply is checked by a deterministic verifier before a student sees it.

It has since grown into a tutor for **any** problem — typed in, or **read off the
student's screen** while they work on GeeksforGeeks, LeetCode or their own editor
— backed by five services, a local vision model, a local language model, and two
small machine-learning models written in Rust.

---

## Contents

1. [What a student can do](#1-what-a-student-can-do)
2. [What is new](#2-what-is-new)
3. [Architecture](#3-architecture)
4. [How a request flows](#4-how-a-request-flows)
5. [The tutor graph (LangGraph)](#5-the-tutor-graph-langgraph)
6. [The on-screen agent, in depth](#6-the-on-screen-agent-in-depth)
7. [Data model](#7-data-model)
8. [Diagnosis and the Rust ML sidecar (GRU + XGBoost)](#8-diagnosis-and-the-rust-ml-sidecar-gru--xgboost)
9. [Honesty and safety guarantees](#9-honesty-and-safety-guarantees)
10. [Public API](#10-public-api)
11. [Running it locally](#11-running-it-locally)
12. [Testing](#12-testing)
13. [Repository layout](#13-repository-layout)
14. [Known limitations](#14-known-limitations)

---

## 1. What a student can do

| Mode | How it works |
|---|---|
| **Sample problem (Two Sum)** | Logic-first gate. Write the algorithm in words → an evaluator grades it against a rubric (approaches, invariants, known misconceptions) → wrong logic gets one Socratic question at a time → correct logic unlocks the editor → code runs against hidden tests → failures go to a code tutor that explains in terms of the student's *own accepted logic*. |
| **Bring your own problem** | Paste any exercise (statement, constraints, examples, optional stdin → stdout tests). One free-form phase: chat and run any time. Runs without tests are labelled **"ran, not verified"**, never "correct". |
| **On-screen assistant** | An always-on-top panel (Chrome Picture-in-Picture) with a Siri-style orb. Share a window and it reads the **problem** and the **code you are writing** on any site, offers **"Tutor me on this"**, reviews your code as a *hypothesis*, suggests **test inputs worth trying**, and answers questions about the code *as it is now*. Optional voice input and read-aloud. |

Every tutor reply separates **Verified:** (what actually ran and was checked)
from **Hypothesis:** (what it suspects), and ends with a question — never a fix.

---

## 2. What is new

Compared with the original MVP (one problem, hosted Judge0, cloud LLM, light UI):

| Area | New |
|---|---|
| **Problems** | Bring-your-own-problem: create, validate (Java), own (per-browser identity), run with stdin/stdout tests; `NO_TESTS` bucket for unverified runs. |
| **On-screen agent** | Opt-in screen capture → **local** vision model (Qwen2.5-VL 3B via Ollama). Reads the visible problem *and* transcribes the student's code line by line (a dedicated copy-only pass that keeps mistakes such as duplicated lines). Frames are never stored. |
| **Screen problems in the database** | "Tutor me on this" stores the problem **in depth**: statement, examples (input / output / explanation), constraints, function signature, expected time and space complexity, output format, 4–6 suggested edge-case test inputs with reasons, and **every distinct version of the student's code** seen while solving (`app.solve_snapshots`). |
| **No repetition, no loops** | A fresh look at the screen before every question; asking again about unchanged code escalates the hint level (1 → 3); the prompt lists what was already said; the verifier rejects word-for-word repeats; `Verified:` is downgraded to `Hypothesis (not run):` when nothing has executed. |
| **Temporal memory** | Per-session memory in the LangGraph checkpoint: rolling summary, last 20 events, code revision, open hypotheses, next action, student state, GRU hidden state. Screen observations go **stale** after a newer run. |
| **Diagnosis** | Deterministic `diagnose` node: rules-v1 ranker with quoted evidence, feature schema v1 (30 numbers), at most two passes. |
| **Rust `intel/` sidecar** | A GRU (burn) for student state and an XGBoost-style booster written from scratch in Rust, cross-checked against real xgboost (99.8 % agreement). Synthetic-trained v0, advisory, **shadow mode**. Explained step by step in the [Colab notebook](notebooks/LogiStream_GRU_XGBoost.ipynb). |
| **Local LLM** | LiteLLM → local Ollama `qwen3:8b` (8k context, thinking off; fits an 8 GB GPU). OpenRouter kept only as a backup group. |
| **Public-demo guards** | Demo passcode on every `/api` call, CORS allow-list, per-passcode rate limits; Vercel UI + Cloudflare tunnel runbook. |
| **UI** | Cursor Dark theme, Lucide icons, Monaco `cursor-dark` editor theme, Siri-style animated orb, status-bar "Under the hood" panel. |
| **Removed** | The hosted **Judge0** integration (client, config, smoke script, env vars). All code runs in the local Python sandbox. |

---

## 3. Architecture

```mermaid
flowchart LR
    subgraph Browser
        UI["Next.js UI<br/>(Vercel or :3000)"]
        PIP["On-screen assistant<br/>Document PiP"]
        CAP["getDisplayMedia<br/>frames, 1600 px JPEG"]
    end
    UI --> GW
    PIP --> GW
    CAP --> GW
    GW["Rust gateway :8000<br/>Axum 0.8<br/>passcode · CORS · rate limits<br/>thread_id = sha256(user:problem)"]
    GW --> ORCH["Python orchestrator :8001<br/>FastAPI + LangGraph<br/>PostgresSaver checkpoints"]
    GW --> DOM["Java domain :8080<br/>Spring Boot · JdbcTemplate"]
    ORCH --> DOM
    ORCH -->|"2 s timeout,<br/>rules fallback"| INTEL["Rust intel :8003<br/>GRU + booster"]
    ORCH --> LLM["LiteLLM :4000"] --> OLL["Ollama :11434<br/>qwen3:8b (text)<br/>qwen2.5vl:3b (vision)<br/>Vulkan backend"]
    ORCH -->|frames, local only| OLL
    DOM --> SBX["Local Python sandbox<br/>(subprocess)"]
    DOM --> PG[("Postgres 16<br/>app.* and checkpoints")]
    ORCH --> PG
```

| Service | Tech | Port | Owns |
|---|---|---|---|
| `web/` | Next.js 16, React 19, Tailwind v4, Monaco, lucide-react | 3000 | UI, PiP assistant, screen capture |
| `gateway/` | Rust, Axum 0.8, reqwest | 8000 | the only public entry point; identity, thread derivation, guards |
| `orchestrator/` | Python 3.11, FastAPI, LangGraph | 8001 | tutor graph, verifier, diagnosis, observer, temporal memory |
| `domain/` | Java 17, Spring Boot 3, JdbcTemplate | 8080 | problems, tests, execution, screen-problem storage |
| `intel/` | Rust, burn 0.18, axum | 8003 | GRU student-state model, booster cause ranker |
| Postgres | 16 (Docker) | 5432 | `app` schema (Java), `orch` cache, LangGraph checkpoints |
| LiteLLM | Docker | 4000 | model routing and failover |
| Ollama | native | 11434 | local text and vision models |

**Identity.** Auth is still the MVP mock: each browser keeps a random
`anon-<uuid>` and sends it as `X-Demo-User`. The gateway derives
`thread_id = sha256(user_id + ":" + problem_id)` and **ignores any thread id a
client sends**. Custom problems are owner-checked on every read.

---

## 4. How a request flows

### Running code

```mermaid
sequenceDiagram
    participant B as Browser
    participant G as Gateway
    participant O as Orchestrator (graph)
    participant J as Java
    participant S as Sandbox
    B->>G: POST /api/sessions/event {type: code}
    G->>O: /sessions/{thread}/event (+ trace id, user)
    O->>J: /internal/execute
    J->>S: run each test (timeouts, fresh temp dir)
    S-->>J: exit codes, stdout, stderr
    J-->>O: bucket + per-test results (hidden tests included)
    O->>O: diagnose (rules + intel) → code_tutor → verify_code
    O-->>B: SessionView (hidden tests stripped)
```

### "Tutor me on this" (a problem seen on screen)

```mermaid
sequenceDiagram
    participant B as Browser (sharing GfG tab)
    participant G as Gateway
    participant O as Orchestrator
    participant V as Ollama vision
    participant L as Ollama text
    participant J as Java + Postgres
    loop every ~15 s, and before every question
        B->>G: POST /api/sessions/observe (frame)
        G->>O: observe
        O->>V: 1) summary + problem title/statement (JSON)
        O->>V: 2) copy-only code transcription (line-numbered)
        O->>O: diagnose: screen_problem, screen_code, snapshot
    end
    B->>G: POST /api/problems/from-screen {current problem_id}
    G->>O: /problems/from-screen {thread}
    O->>L: analyse: examples, constraints, signature, complexity, test inputs
    O->>J: POST /internal/problems (source=screen, insights)
    J-->>B: new problem id → new session; capture keeps running
```

The screen text never comes from the browser request: the server takes it from
the session's own memory.

---

## 5. The tutor graph (LangGraph)

```mermaid
stateDiagram-v2
    [*] --> await_input
    await_input --> evaluate_logic: logic (Two Sum)
    evaluate_logic --> summarize_logic: PASS / FLAGGED
    evaluate_logic --> logic_tutor: FAIL
    logic_tutor --> verify_logic
    verify_logic --> logic_tutor: rejected (≤ 2 regenerations)
    verify_logic --> await_input: delivered
    summarize_logic --> await_input: editor unlocks
    await_input --> execute_code: code
    execute_code --> await_input: INFRA_ERROR
    execute_code --> diagnose
    await_input --> diagnose: chat (code phase) / observe
    diagnose --> finish: ACCEPTED
    diagnose --> await_input: observe (quiet: no tutor turn)
    diagnose --> code_tutor
    code_tutor --> verify_code
    verify_code --> code_tutor: rejected
    verify_code --> await_input: delivered
    finish --> [*]
```

* `await_input` contains **only** `interrupt()` — LangGraph re-runs an
  interrupted node from its first line on resume, so nothing with a side effect
  may sit before it.
* The session is one long-running graph; every student action is a resume.
  Checkpoints live in Postgres, so a refresh or a server restart resumes the
  conversation exactly.
* **Verifier** (`verifier.py`, deterministic, unit-tested). Logic phase rejects
  code fences, code-like lines, rubric-forbidden terms ("hashmap", "two
  pointer", …) and replies over 120 words. Code phase rejects the entrypoint's
  definition, code blocks over 3 lines, replies over 160 words, word-for-word
  repeats of the previous reply, and turns `Verified:` into
  `Hypothesis (not run):` when nothing has executed. After two rejections a
  canned Socratic fallback is delivered; unverified text never is.
* **Fallbacks.** If the LLM is down, the code tutor delivers a deterministic hint
  built from the diagnosis, and the logic tutor delivers the rubric's own
  Socratic question — both flagged `fallback_used`.

---

## 6. The on-screen agent, in depth

```mermaid
flowchart TD
    A["Share screen (user click,<br/>browser picker)"] --> B["Sample every 15 s<br/>skip if 160×90 thumbnail unchanged<br/>never skip > 45 s"]
    Q["Student asks a question"] --> F["Fresh look first<br/>(no skip)"]
    B --> V1
    F --> V1["Vision pass 1 (JSON):<br/>activity, error text,<br/>problem title + statement,<br/>code visible? language"]
    V1 -->|code visible| V2["Vision pass 2 (copy-only):<br/>N| line, keeps mistakes"]
    V1 --> D["diagnose"]
    V2 --> D
    D --> P{"title == session's<br/>problem?"}
    P -->|no| O["screen_problem → card:<br/>'Tutor me on this'"]
    P -->|yes| S["screen_code → tutor prompt<br/>new version → app.solve_snapshots"]
```

* **Two vision passes.** Asked to put code inside its JSON summary, the 3B model
  "tidied" it — it silently dropped a duplicated `int max = arr[0];`, the very
  bug the tutor should see. Asked separately to pair each line with the editor's
  line number, it copies faithfully. Frames go up at 1600 px because at 1024 px
  it misread `arr[0]` as `0`.
* **Code from another site in another language** (e.g. C on GeeksforGeeks) is
  reviewed *in its own language*, quoted by line number, and always as a
  hypothesis — this app can only execute Python.
* **Staleness.** An observation records the code revision it was captured at;
  after a newer run it is shown as "seen earlier" and the prompt says not to
  treat it as current.
* **Seamless switch.** Capture and the PiP window live above the per-problem
  session, so switching problems re-points the capture instead of ending it.
* **Privacy.** Local only: `OLLAMA_URL` must be localhost or the orchestrator
  refuses to start. Frames are validated (JPEG/PNG, ≤ 2.5 MB), one VLM call at a
  time, never written to disk or the checkpoint; only short text is kept.
  Capture is visible, pausable and stops with the browser's own "Stop sharing".
* **GPU faults are named.** If the vision model answers `@@@@` (Ollama's CUDA
  backend on an RTX 5050), the observer says so and how to fix it instead of a
  parse error. `OLLAMA_VLM_NUM_GPU=0` runs vision on the CPU as an emergency
  fallback (~1–2 min per frame). See "GPU notes" in §11.

---

## 7. Data model

```mermaid
erDiagram
    PROBLEMS ||--o{ HIDDEN_TESTS : "has"
    PROBLEMS ||--o{ SOLVE_SNAPSHOTS : "code seen while solving"
    PROBLEMS {
        text id PK "two-sum | custom-uuid"
        text title
        text description
        jsonb examples "input, output, explanation"
        text starter_code
        jsonb rubric "curated only"
        text kind "curated | custom"
        text owner_id
        text language
        text constraints_text
        text source "curated | form | screen"
        text source_site
        jsonb insights "signature, time/space complexity, output format, test_inputs, analysed_by"
        timestamptz created_at
    }
    HIDDEN_TESTS {
        text problem_id FK
        int idx
        text label
        bool is_public
        text stdin
        text expected_output
    }
    SOLVE_SNAPSHOTS {
        bigserial id PK
        text problem_id FK
        text owner_id
        text language
        text code
        text code_sha "unique per problem+owner"
        timestamptz captured_at
    }
    VERDICT_CACHE {
        text cache_key PK
        text problem_id
        jsonb verdict
    }
```

`db/init/` creates the base schema on an empty volume; all later columns and
tables are idempotent `ALTER … IF NOT EXISTS` statements in
`domain/src/main/resources/schema-byop.sql`, run by Spring at every start, so
an existing demo database is upgraded in place and never wiped.

---

## 8. Diagnosis and the Rust ML sidecar (GRU + XGBoost)

**Open the notebook:**
[`notebooks/LogiStream_GRU_XGBoost.ipynb`](notebooks/LogiStream_GRU_XGBoost.ipynb) ·
[**Run it in Colab**](https://colab.research.google.com/github/SachmanChadhaa/Logi_Stream/blob/main/notebooks/LogiStream_GRU_XGBoost.ipynb)
— diagrams, equations, a worked gain example, a from-scratch booster checked
against real xgboost, GRU training with truncated BPTT, confusion matrices,
hidden-state trajectories, feature importance and the shadow-mode gate.

1. **Rules first.** `diagnostics.py` ranks up to three candidate causes for a
   run (22 cause ids: `syntax`, `missing-key`, `too-slow`, `prints-nothing`,
   `logic-wrong-on-case`, …), each with quoted evidence from stderr, tests and
   the code.
2. **Feature schema v1.** Every event becomes 30 numbers in `[0, 1]`
   (`docs/feature_schema_v1.md`); Python and Rust are checked against one golden
   vector.
3. **GRU** (`intel/src/gru.rs`, burn): 30 → GRU(32) → student state (4) and
   cause group (6). Its hidden state is stored in the session checkpoint, so the
   sidecar itself is stateless.
4. **Booster** (`intel/src/booster.rs`, pure Rust): 22 one-vs-rest tree
   ensembles with second-order gradients, `w* = −G/(H+λ)`, split gain with γ,
   32-bin histograms, subsampling; input = 30 features + GRU's 4 + 6 scores.

| Held-out (synthetic) | Rules | Rust model | real xgboost |
|---|---|---|---|
| Student state accuracy | 0.637 (heuristic) | **GRU 0.921** | – |
| Cause real-choice top-1 | **0.964** | booster 0.899 | 0.900 |

The booster loses to the rules, so it runs in **shadow mode**: scores are shown,
the rules keep the order. It may reorder only if held-out metrics say it won,
and never adds a cause the rules did not find. If `intel` is down, everything
falls back to `rules-v1` within 2 s.

The Colab notebook re-implements both models in PyTorch / xgboost on its own
synthetic sessions, so its numbers differ from the Rust run above (its last
execution: GRU 0.962 vs heuristic 0.893 state accuracy; booster real-choice
top-1 0.921 vs rules 0.981, so it, too, ends in shadow mode). All of these are
synthetic-data results, not validation on real students, and the scores are
rankings, not probabilities.

---

## 9. Honesty and safety guarantees

* The tutor **never writes the solution**: enforced by the verifier, not just the
  prompt. Statements and screen text are treated as data (prompt-injection
  resistant), and the tutor is told to ignore instructions inside them.
* **Verified vs Hypothesis** is enforced: nothing is called verified unless it
  ran in the sandbox and was compared.
* ML outputs are labelled **synthetic-trained v0, advisory, unvalidated**; scores
  are never called probabilities.
* The local Python sandbox is **not a security sandbox** (timeouts, a fresh temp
  directory, no shell, `python -I`, output caps). The public path is protected
  only by the passcode, the CORS allow-list and rate limits.
* Errors shown to students never include upstream bodies (provider messages,
  account ids); full details stay in the server logs, tied together by one
  `X-Trace-Id` across every service.
* No secrets in git: everything is read from `.env` (see `.env.example`).

---

## 10. Public API

Everything the browser calls goes through the gateway. When `DEMO_PASSCODE` is
set, every `/api` call needs `X-Demo-Passcode`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | liveness |
| GET | `/api/auth/check` | 200, or 401 `passcode_required` |
| GET | `/api/problems` | curated samples + your own problems |
| POST | `/api/problems` | create your own problem (422 `{error, field}` on bad input) |
| POST | `/api/problems/from-screen` | `{problem_id}` → store the problem seen on screen in that session, in depth; returns `{id, reused}` |
| GET | `/api/problems/{id}` | browser-safe view (no rubric, no hidden tests), incl. `source`, `insights`, `snapshot_count` |
| POST | `/api/sessions/start` | `{problem_id}` → SessionView (resumes if it exists) |
| POST | `/api/sessions/event` | `{problem_id, type: logic \| chat \| code, text}` |
| POST | `/api/sessions/observe` | `{problem_id, image_b64, trigger, code_revision}` (3 MB cap, rate-limited) |
| POST | `/api/sessions/reset` | `{problem_id}` |
| GET | `/api/sessions/{problem_id}` | current SessionView |
| GET | `/api/observer/status` | is the local vision model ready |

The `SessionView` contract (phase, status, messages, last evaluation, last
execution with hidden tests stripped, diagnosis, temporal memory, debug trace) is
specified in `CLAUDE.md` §5.2 and extended additively in `docs/BYOP.md`.

---

## 11. Running it locally

**Prerequisites:** Docker Desktop, Git Bash (Windows), Node ≥ 20, Java 17 +
Maven, Rust (GNU toolchain), Python 3.11 via `uv`, and Ollama with:

```bash
ollama pull qwen3:8b
```

```bash
ollama create logistream-qwen3-8b -f ollama/Modelfile.logistream-qwen3-8b
```

```bash
ollama pull qwen2.5vl:3b
```

**GPU notes (8 GB cards, tested on an RTX 5050 laptop GPU, Ollama 0.32.7).**
Measured on 2026-10-24:

| Setup | Result |
|---|---|
| CUDA backend, `qwen2.5vl:3b` with an image | every answer `@@@@` (text-only prompts are fine) |
| CUDA backend, `qwen3-14b` (needs ~10.8 GB, split GPU+CPU) | crash: `MUL_MAT failed`, `0xc0000409` |
| Vulkan, `qwen3-14b` split | works, ~5 tok/s (tutor reply ~106 s) |
| **Vulkan, `qwen3:8b`** (6.2 GB, all on GPU) | **~23 tok/s (tutor reply ~6–30 s)** |
| **Vulkan, `qwen2.5vl:3b`** | **reads the test frame's 9 code lines exactly, ~8 s warm** |
| Vulkan, `qwen3-vl:4b` | empty answers (all output goes to "thinking"), 3–5 min a frame |

So on this machine Ollama must run on **Vulkan**. `demo/start.sh` passes
`OLLAMA_LLM_LIBRARY=vulkan` from `.env` to the `ollama serve` it starts, and
restarts one it started earlier on another backend. The Ollama tray app reads
Windows user environment variables instead; set them once and restart the app:

```bash
setx OLLAMA_LLM_LIBRARY vulkan
```

```bash
setx OLLAMA_VULKAN 1
```

On GPUs where CUDA works, leave `OLLAMA_LLM_LIBRARY` empty.

**Configure:** copy `.env.example` to `.env` and fill it in (never commit `.env`).

**Start everything** (from Git Bash; in VS Code, set the default terminal profile
to *Git Bash* first — plain `bash` in PowerShell starts WSL):

```bash
bash demo/start.sh
```

```bash
bash demo/healthcheck.sh
```

Then open **http://localhost:3000** in **Chrome** (Picture-in-Picture, screen
capture and voice are Chrome features). `start.sh` rebuilds anything whose
sources changed, trains the `intel` models on first run (~90 s), and writes logs
to `demo/logs/`.

```bash
bash demo/stop.sh
```

**Public demo** (UI on Vercel, backend on this laptop behind a Cloudflare quick
tunnel): see [`demo/DEPLOY_VERCEL.md`](demo/DEPLOY_VERCEL.md).

---

## 12. Testing

| Suite | Command | Result |
|---|---|---|
| Orchestrator (graph, verifier, observer, temporal, screen problems) | `cd orchestrator && uv run pytest` | 135 passed |
| Java (bucket mapping, validation incl. screen insights) | `cd domain && mvn test` | 24 passed |
| Gateway (passcode, CORS, rate limit, identity) | `cd gateway && cargo test` | 11 passed |
| Intel (features, GRU, booster, metrics) | `cd intel && cargo test --release` | 14 passed |
| Web | `cd web && npx tsc --noEmit && npx next build` | clean |
| End to end, Two Sum | `bash demo/rehearse.sh`, `bash gateway/verify.sh` | green |
| End to end, bring your own problem | `python -I demo/verify_byop.py` | 41 / 41 |

---

## 13. Repository layout

```
CLAUDE.md               MVP contract (original), PROGRESS.md task log
db/                     schema + Two Sum seed generator
domain/                 Java: problems, validation, execution, screen-problem storage
orchestrator/           Python: LangGraph tutor, verifier, diagnostics, observer, temporal memory
  app/nodes/            await_input, evaluate_logic, logic_tutor, summarize_logic,
                        execute_code, diagnose, code_tutor, finish
  app/screen_problems.py  in-depth analysis + storage of problems read off the screen
gateway/                Rust: the public API, identity, guards
intel/                  Rust: GRU + booster, synthetic data, training, serving
web/                    Next.js UI, on-screen assistant, screen capture
notebooks/              GRU + XGBoost explained (Colab), and its generator
demo/                   start/stop/healthcheck, rehearsal, fixtures, deploy runbook
docs/                   BYOP handoff, feature schema v1
ollama/                 Modelfile for the 8k-context tutor model
```

---

## 14. Known limitations

* Mocked auth: identities are anonymous per browser.
* Only Python executes; other languages on screen are reviewed, not run.
* The vision model is 3B and runs on an 8 GB laptop GPU: it can misread small
  text, and the GPU cannot hold it and the 8B text model at once, so Ollama
  swaps them (a few extra seconds on the first turn after a swap).
* The ML models are trained on scripted, synthetic sessions and are not
  validated on real students.
* Picture-in-Picture, screen capture and Web Speech need Chrome.
