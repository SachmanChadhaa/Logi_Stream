# PROGRESS — LogiStream 3-Day MVP

Task log, decisions and deviations. Updated after every task (see CLAUDE.md §1).

## Environment facts (established D1-T0, 2026-09-21)

| Fact | Value |
|---|---|
| Repo root | `G:\fsjp_project_completed` |
| Shell | **Git Bash (MINGW64)** — WSL2 has no Ubuntu distro, only the internal `docker-desktop` one (§0.1 fallback) |
| Docker | 29.8.0, Compose v5.5.1, daemon up, `CgroupVersion 2` |
| Node | v26.5.0 (npm 11.17.0) — OK (≥ 20) |
| Python (PATH) | 3.14.7 — used by the Java sandbox to run student code |
| Python (uv) | **3.11.15** via `uv` 0.11.32 — the orchestrator venv |
| Java | **Temurin 21.0.12.1 LTS** in `tools/jdk21`, pinned via `scripts/env.sh`. Machine default (26.0.2) untouched |
| Maven | **3.9.16** in `tools/maven` |
| Rust / cargo | **1.98.1** (rustup, per-user `~/.cargo`) |
| MSVC linker | **absent** — see the D2-T3 toolchain note. Day 1's "present" reading was wrong: it matched Git Bash's coreutils `link.exe`, not MSVC's |
| Package managers | `winget` 1.29.290, `choco` 2.7.3, `uv` 0.11.32 |
| `jq` | **not installed** — shell scripts parse JSON with `python` |

## Task log

| Task | Status | Notes |
|---|---|---|
| D1-T0 Toolchain and skeleton | ✅ DONE | Layout per §4, `.gitattributes` (LF), `.gitignore`, `.env.example`, `git init`. Toolchain bootstrapped portably. Verify: all version commands succeed; `git check-attr eol -- scripts/judge0_smoke.sh` → `lf`. |
| D1-T1 Judge0 → **local sandbox** | ✅ DONE (re-scoped) | Judge0 dropped on the human's instruction (zero budget). Replaced with a real local Python sandbox — see *Zero-budget pivot* below. `judge0/HOSTED.md` + `scripts/judge0_smoke.sh` retained as the swap-back path. |
| D1-T2 Postgres, schema, seed | ✅ DONE | `docker-compose.yml` (postgres:16 + litellm), `01_schema.sql` (§7.1), `generate_two_sum.py` → `02_seed.sql` (155 KB). Verify: `bash db/verify.sh` → **21/21 PASS**. |
| D1-T3 Java domain service | ✅ DONE | Spring Boot 3.5.16 / Java 21, JdbcTemplate, internal-token filter, trace-id filter, `Sandbox` seam with local + Judge0 implementations. Verify: `bash domain/verify.sh` → **12 passed, 0 failed, 0 skipped**; `mvn test` → **13/13**. |
| D1-T4 Python orchestrator core | ✅ DONE | uv venv on Python 3.11.15; verifier, LLM client, domain client, verdict cache, LOGIC-phase nodes, graph on `MemorySaver`, CLI harness. Verify: `uv run pytest` → **49/49**; `cli_harness.py --fixtures` → **6/6** (table below). |
| 🚦 Day 1 gate | ✅ **REACHED** | Reported to the human. |
| D2-T1 Code phase in graph | ✅ DONE | `execute_code`, `code_tutor`, `verify_code`, `finish`, `redact.py`, `view.py`; `code:`/`--flow`/`--tle` in the harness. Verify: `--flow` → full F1→F5 pass; `--tle` → F4b pass; `pytest` → **62/62**. |
| D2-T2 PostgresSaver + FastAPI | ✅ DONE | `checkpointer.py` (trap 4 settings), `main.py` (§5.3 endpoints, 401/404/409/422), `tracing.py`. Verify: `bash orchestrator/verify_api.sh` → **22 passed, 0 failed**, including the kill-and-restart persistence proof. `pytest` → **79/79**. |
| D2-T3 Rust gateway | ✅ DONE | Axum 0.8, mocked auth, sha256 thread derivation, 120 s reqwest timeout, CORS, trace propagation. Verify: `bash gateway/verify.sh` → **20 passed, 0 failed**; `cargo test` → **6/6**. Needed a three-layer Windows toolchain fix — see below. |
| D2-T4 Next.js UI | ✅ DONE | Next 16.3.5 / React 19 / Tailwind v4 / Monaco. Header + stepper, problem pane with accepted-logic tab, textarea → Monaco, floating Socratic chat, test drawer, **Under the hood**, busy bars with live seconds. Verify: full §10 flow driven in a real browser — F1 FAIL → F2 chat → refresh resumes → F3 PASS/unlock → F4 RUNTIME_ERROR → F5 ACCEPTED 5/5 → DONE. `tsc --noEmit` clean, `next build` clean. |
| 🚦 Day 2 gate | 🟡 ready for the human | All four D2 tasks verified. `demo/SCRIPT.md` has the click-by-click run. Needs three clean browser runs by the human. |
| D3-T1 Stretch | ⛔ SKIPPED (human decision, 2026-09-22) | The Day 2 gate's three browser runs had not been done, and §9 gates the stretch on them. Also: the LLM judge adds a third call per turn on a tier already returning 429, making the latency risk worse. Time went to hardening instead. |
| D3-T2 Demo tooling | ✅ DONE | `start.sh` (ordered, idempotent, starts Docker Desktop), `stop.sh` (`--all`, kills process trees, no `--volumes` by design), `healthcheck.sh` (11 checks; live LLM/exec opt-in), `prewarm.py`, `DEVIATIONS.md`, `SCRIPT.md`. Verify: healthcheck → **READY, 11 passed**. |
| D3-T3 Cold start test | ✅ DONE | `stop.sh --all` → `docker compose down -v` → `start.sh`. **Green from zero in 53 s.** Seed re-ran, sandbox ACCEPTED 5/5, cache correctly empty. |
| D3-T4 Pre-warm | ✅ DONE | Warms **both** cache kinds. Verify: `prewarm.py --check` → **all four fixtures served from cache**. Timings below. |
| D3-T5 Rehearsal support | ✅ DONE | `demo/rehearse.sh` drives F1→F5 through the gateway and times each beat; `demo/THURSDAY.md` is the morning checklist; `demo/SCRIPT.md` the click-by-click. Verify: **REHEARSAL GREEN, 5 beats, 65 s total**. |

## D1-T4 fixture verdict table (the mini golden set)

`cd orchestrator && uv run python scripts/cli_harness.py --fixtures`

| Id | Verdict | Approach | Misconception | Cache hit | Result | Turn time |
|---|---|---|---|---|---|---|
| F1 | FAIL | – | `nested-loop` | false | ✅ OK | 36.0 s |
| F2 (chat) | *(carries F1)* | – | `nested-loop` | false | ✅ tutor replied | 18.9 s |
| F3 | PASS | `lookup-single-pass` | – | false | ✅ phase → CODE | 39.1 s |
| F3b | PASS | `sort-two-pointer` | – | false | ✅ phase → CODE | 54.9 s |
| F6 (`"use hashmap"`) | FAIL | – | – | false | ✅ OK | 92.1 s |
| F3c (F3 in a fresh thread) | PASS | `lookup-single-pass` | – | **true** | ✅ no LLM call for the verdict | 30.7 s |

Every delivered tutor turn was checked against all 9 `forbidden_terms_logic_tutor` — **zero leaks**.
F1's reply, in the student's own Hinglish register:

> *"Agar array mein 20,000 numbers hon, toh tumhara approach kitne pairs check karega aur kya har pair ko dekhna sach mein zaroori hai?"*

## Zero-budget pivot (2026-09-21, human directive)

The human is a student on a strict $0.00 budget: no card for RapidAPI, no minimum balance on
OpenRouter. Three changes resulted.

### 1. Judge0 → local Python sandbox

`Sandbox` is now an interface with two implementations, chosen by `EXECUTOR_MODE`:

| Mode | Implementation | Cost | Network |
|---|---|---|---|
| **`LOCAL`** (default) | `LocalPythonSandbox` — runs student code in a subprocess | $0 | none |
| `JUDGE0` | `Judge0Client` — hosted Judge0 CE | metered | required |

Both report **Judge0 status ids**, so `BucketMapper` and the entire §8 table are byte-identical
either way and all 13 unit tests still apply. The Judge0 client stays compiled and tested as the
documented swap-back path, which keeps the §3 "only the base URL and headers change" claim true.

**A correction to the directive as written.** The instruction specified
*"status 13 (Time Limit Exceeded)"*. Status 13 is Judge0's **Internal Error**; TLE is **status 5**.
Our own bucket table maps 13 → `INFRA_ERROR` → *"The sandbox failed; this attempt does not count"*,
which routes around the code tutor entirely and would have killed the F4b demo beat. A timeout
reports **status 5**.

**Why real execution rather than the regex mock.** It costs the same ($0), needs no network, and
produces genuine `SyntaxError`, `KeyError`, timeouts and wrong answers — so an examiner can type
arbitrary code during Q&A and get a truthful verdict, where a pattern-matcher would confidently
lie. It also means we are not violating §1.5 ("never fake the hard parts").

**Isolation — stated honestly.** `LocalPythonSandbox` is *not* a security sandbox. Student code
runs with the service's privileges. It has: a hard timeout with `destroyForcibly` on the process
tree, a fresh temp dir per run, no shell, `-I` isolated mode, and truncated output capture. That is
appropriate for a single-user local demo and nothing more. This belongs on the deviations slide.

### 2. LiteLLM proxy reintroduced

`ghcr.io/berriai/litellm:main-latest` on port 4000, config in `litellm_config.yaml`. The
orchestrator asks for `logistream-evaluator` / `logistream-tutor` and never names a vendor.

It is **load-bearing, not decorative**: OpenRouter's free tier throws 429 constantly, and the very
first call through the proxy failed over to the backup model. A rate limit on stage is
unrecoverable by hand; LiteLLM makes it automatic.

### 3. Model choice by evidence (trap 12 landed)

**`google/gemini-2.0-flash-exp:free` no longer exists on OpenRouter.** `scripts/model_bakeoff.py`
scores candidates against the real F1/F3/F3b/F6 fixtures:

| Model | Verdicts | Valid JSON | Avg | Role |
|---|---|---|---|---|
| `qwen/qwen3.8-27b:free` | **4/4** | **4/4** | 18.1 s | **primary** |
| `nvidia/nemotron-3-super-120b-a12b:free` | 3/4 | 3/4 | 7.6 s | fallback |
| `z-ai/glm-5.2:free` | 1/4 | 1/4 | 17.7 s | rate-limited out |
| `google/gemma-4-31b-it:free` | 0/4 | 0/4 | 16.6 s | rate-limited out |

## D2-T3 toolchain: three layers of Windows linker trouble

The gateway compiled on the first try but could not **link**. Three separate causes, none of
them Rust's fault, all fixed without admin rights:

| # | Symptom | Cause | Fix |
|---|---|---|---|
| 1 | `link: extra operand ...` | No Visual Studio C++ toolset exists on this machine. Rust's msvc target shells out to `link.exe`, which on Git Bash resolves to **coreutils' `/usr/bin/link.exe`** | Switched to `x86_64-pc-windows-gnu`, pinned in `gateway/rust-toolchain.toml` |
| 2 | `dlltool: Invalid bfd target` | An ancient MinGW at `G:\MINGW\bin` (ships `aclocal-1.4`) sits on the system PATH and shadowed rustup's tools | `scripts/env.sh` filters `/g/MINGW/bin` out of PATH **for this repo's shells only**; the system PATH is untouched |
| 3 | `dlltool.exe: CreateProcess` | rustup's self-contained set has `dlltool`/`ld`/`gcc` but **no assembler**, which `dlltool` itself invokes | Portable MinGW-w64 (winlibs UCRT) into `tools/mingw64`, added to `scripts/bootstrap_toolchain.sh` |

**Correction to the Day 1 environment note.** Day 1 recorded "MSVC linker present (Visual Studio 18)".
That was wrong: `command -v link.exe` matched Git Bash's coreutils `link.exe`. There is no MSVC
C++ toolset installed. The table above is what is actually true.

## Day 3 changes

### Summariser cache (approved on Day 2 — the Risk #1 fix)

§6.3 specified caching only the evaluator verdict. That left F3 — the *"editor unlocks"* beat —
still costing ~30 s on a verdict cache hit, because `summarize_logic` made its own LLM call.
Both are now cached. The kind is folded into the hash rather than added as a column, so this
needed **no schema migration** the day before the demo, and a verdict key cannot be served as a
summary. Six tests pin the namespacing.

### LiteLLM: three keys **and** a fallback

The working tree arrived with uncommitted edits adding three OpenRouter keys and round-robin —
a good instinct, since free-tier limits are per key. Two problems were fixed:

1. **`docker-compose.yml` was malformed.** Two YAML list items had been merged onto one line each
   (`- KEY_1=... - KEY_2=...`), which YAML reads as one bogus string rather than raising an error.
2. **The config had lost its safety settings** — master key, `drop_params`, the 120 s timeout
   (a free-tier turn has been measured past 90 s), and the model fallback.

**Keys and fallback are not alternatives, and this is not theoretical.** Measured on the morning
of 2026-09-22: `qwen/qwen3.8-27b:free` returned **429 on all three keys simultaneously**, and the
nemotron fallback answered. With three keys and no fallback, every one of those calls would have
failed. Both layers are now in place.

### Cold start (D3-T3)

| Step | Time |
|---|---|
| containers (postgres 3 s, litellm 19 s) | 22 s |
| java → python → rust → web | ~7 s |
| **total, from a wiped volume** | **53 s** |

### Pre-warm results (D3-T4) — the summariser cache paying off

| Fixture | Cold | Warm | Note |
|---|---|---|---|
| F1 | 41.7 s | **11.4 s** | verdict cached; the tutor reply is still live, by design |
| F6 | 36.7 s | **12.3 s** | same |
| **F3** | 16.2 s | **2.5 s** | verdict **and** summary cached |
| F3b | 27.4 s | **2.5 s** | verdict and summary cached |

F3 is the one that proves the Day 3 change. It triggers `summarize_logic`, and before the
summariser cache a verdict-cache hit on F3 still cost **30.7 s**. It is now 2.5 s — the same as
F3b, which is what "cached" should look like.

**F1 and F6 stay slow on purpose.** Their verdicts are cached, but the tutor's reply is generated
fresh and verified every time. Caching a tutor turn would mean shipping text that had not been
through the verifier for *this* conversation, which is the one thing the product must not do.

Also worth recording: these verdicts were produced by the **fallback** model (qwen was 429 on all
three keys at the time) and it still got all four right, including `sort-two-pointer` for F3b.

### Scripted rehearsal, post-prewarm (D3-T5)

`bash demo/rehearse.sh` — same path the browser takes, port 8000 only.

| Beat | Day 2 | Now | |
|---|---|---|---|
| F1 logic → FAIL | 14.1 s | **10 s** | verdict cached; tutor reply live |
| F2 chat | 22.7 s | **22 s** | tutor live, and the verifier regenerated once |
| F3 logic → PASS, unlock | 25.4 s | **1 s** | verdict + summary cached |
| F4 code → RUNTIME_ERROR | 67.6 s | **10 s** | execution local; code tutor live |
| F5 code → ACCEPTED, DONE | 0.8 s | **4 s** | execution only, no LLM |
| **total** | **130.5 s** | **65 s** | |

`regen=1` on F2 is the verifier rejecting a tutor draft and forcing a regeneration — it happens
often enough to be worth pointing at on stage.

## Findings for the human

- **🔴 Turn latency is the new Risk #1.** Free-tier turns measured **18.9 s – 92.1 s**; CLAUDE.md
  budgeted 20–40 s. F6 at 92 s would be a painful silence on stage. Mitigations available, in order
  of value: (a) D3-T4 pre-warm — already proven, `cache_hit: true` works; (b) **also cache the
  summariser**, since F3c still cost 30.7 s on a verdict cache hit because `summarize_logic` makes
  its own LLM call; (c) keep the UI's live seconds counter prominent so the wait is legible.
  Recommend (a) + (b) on Day 3.
- **Free-tier 429s are frequent.** Two of four bake-off candidates were rate-limited out entirely.
  LiteLLM failover covers this, but back-to-back demo runs may still stall. The verdict cache is
  the real defence.
- **§6.4 gap closed** with the two approved narrow patterns, plus five false-positive guards
  asserting that ordinary tutoring prose ("Return the indices, not the values.") still passes.

## Open blockers

*(none)*

## Decisions

- **2026-09-21 · Shell = Git Bash.** §0.1 prefers WSL2 (Ubuntu); `wsl -l -v` lists only
  `docker-desktop`. Git Bash is the documented fallback. All repo scripts stay bash.
- **2026-09-21 · Toolchain is repo-pinned, not machine-installed.** winget has no Apache Maven
  package and its Temurin package is machine-scope (needs UAC, unavailable from this shell), so
  `scripts/bootstrap_toolchain.sh` downloads Temurin 21 and Maven 3.9.16 into `tools/` and installs
  rustup per-user. `scripts/env.sh` puts them on PATH and sets `JAVA_HOME`. No admin rights needed,
  and the Thursday demo cannot be broken by a machine-wide JDK change.
- **2026-09-21 · Orchestrator Python = 3.11.15 (uv-managed), not the PATH 3.14.7.** 3.11 is what
  the LangGraph / psycopg / pydantic wheel ecosystem is proven against.
- **2026-09-21 · The Java service runs in UTC.** pgjdbc puts the JVM's default zone id in the
  connection startup packet. On this host that is the legacy alias `Asia/Calcutta`, which
  `postgres:16`'s tzdata does not carry (only `Asia/Kolkata`), so **every** connection failed with
  `FATAL: invalid value for parameter "TimeZone"` before any query ran. `DomainApplication` pins the
  default zone to UTC in a static block; log timestamps carry a `Z` suffix.
- **2026-09-21 · Bucket mapping is a pure function.** `BucketMapper` is static and takes
  already-scored results, so all §8 rules — including the Python-`SyntaxError`-as-status-11
  reclassification — are unit-tested with no sandbox at all.
- **2026-09-21 · Test 5 uniqueness proven two ways.** The generator asserts `count_pairs == 1`;
  `db/verify.sh` independently re-derives it in SQL over all ~200M pairs. Measured: single-pass
  0.003 s, nested loop ~7 s against `cpu_time_limit=2`.
- **2026-09-21 · The verdict cache degrades to a no-op.** If Postgres is unreachable the cache logs
  a warning and continues. A cache outage must never take a session down mid-demo.

## Deviations from CLAUDE.md

| # | Deviation | Why | Impact |
|---|---|---|---|
| 1 | Shell is Git Bash, not WSL2 Ubuntu | No Ubuntu distro installed; §0.1 names Git Bash as the fallback | None. |
| 2 | Toolchain installed portably under `tools/` | winget has no Maven package; its Temurin needs UAC | None, and better: `JAVA_HOME` is per-repo, machine default untouched. |
| 3 | Orchestrator Python is 3.11.15, not the PATH 3.14.7 | Wheel-ecosystem maturity | None. |
| 4 | **Judge0 replaced by a local subprocess sandbox** | Zero budget; a metered third-party sandbox is a live-demo liability | Execution is real, free and offline. Not a security sandbox — **goes on the deviations slide**. |
| 5 | **LiteLLM reintroduced** (CLAUDE.md §3 had deferred it) | Free-tier 429s need automatic failover | Positive: restores the full-spec component and decouples model names from vendors. |
| 6 | Models are free-tier OpenRouter, not paid | Zero budget | Slower turns (18–92 s) and occasional 429s. See Risk #1 above. |
| 7 | §6.4 code-line rules tightened with two extra patterns | Human-approved 2026-09-21 | Closes the colonless `return [` / `import x` gap; guarded against prose false positives. |
| 8 | **Bring-your-own-problem** (`feature/bring-your-own-problem`, 2026-10-23) | Human brief `CLAUDE_IMPLEMENTATION_PLAN.md` | Additive contract changes to §5.1/5.2/5.4 (new problem routes, `problem_kind`, `diagnosis`, `run_history`, `NO_TESTS` bucket). Custom problems skip the logic gate (no rubric). Full write-up: `docs/BYOP.md`. |

## BYOP (2026-10-23) — status (v2 brief `CLAUDE_CODE_BRIEF (1).md`)

Full handoff: `docs/BYOP.md`. Branch `feature/bring-your-own-problem`, **local commits only** (never pushed, merged or deployed).

| Item | Status |
|---|---|
| Step 2 — custom problems, stdin/stdout runs, `NO_TESTS` = "ran, not verified", custom tutor (single free-form phase) | ✅ `d0030b9` |
| Step 3 — demo passcode on every `/api`, CORS allow-list, run/observe rate limits | ✅ `d1a7cfc`, verified live on a second gateway |
| Step 4 — temporal memory in the checkpoint, feature schema v1, deterministic `diagnose` node (≤ 2 passes) | ✅ `d1a7cfc` |
| Step 5 — on-screen assistant (Document PiP + in-page fallback), opt-in screen capture → local Qwen2.5-VL 3B | ✅ `0f4ba59`; PiP / getDisplayMedia / voice **not verified in real Chrome** |
| LLM outage → **local Ollama** `logistream-qwen3` (owner decision), `think: false`, 8k context | ✅ `2d0b85e` |
| Steps 6–7 — Rust `intel/` sidecar: burn GRU + XGBoost-style booster, synthetic v0, xgboost cross-check | ✅ `274fd82`; booster in **shadow mode** (loses to rules on held-out data) |
| Vercel deploy + Cloudflare tunnel | ⏳ runbook only (`demo/DEPLOY_VERCEL.md`); the owner runs it |

### Final checks (2026-10-23)

| Check | Result |
|---|---|
| `orchestrator: uv run pytest` | 120 passed |
| `intel: cargo test --release` | 14 passed |
| `gateway: cargo test` | 11 passed |
| `domain: mvn test` | 22 passed |
| `web: tsc --noEmit`, `next build` | clean |
| `demo/verify_byop.py` (real local LLM) | 41/41 |
| `demo/rehearse.sh` (Two Sum regression) | GREEN, 5 beats, 78 s (F1 10 s · F2 8 s · F3 0 s · F4 51 s · F5 3 s) |
| `gateway/verify.sh` | 20 passed, 0 failed |

Measured: VLM 3.1–3.2 s/frame (2.9 GB, 100% GPU); text model 10 GB (42% CPU), tutor turn 12–28 s warm, ~66–85 s after a VLM swap.

## 2026-10-24 — Judge0 removed, screen problems in depth, no repeat loops, README + Colab

| Item | Status |
|---|---|
| Hosted Judge0 removed (Java package, config, env, smoke script, docs) | ✅ mvn 24 passed |
| `app.problems` + `source`, `source_site`, `insights`; new `app.solve_snapshots` (idempotent migration) | ✅ applied on the live DB |
| `/api/problems/from-screen`: LLM analysis (examples, constraints, signature, complexity, test inputs) + storage | ✅ pytest 135 |
| Assistant: fresh look before questions, hint escalation on repeats, "already said", test-input suggestions, "reading your code" line | ✅ |
| `README.md` (architecture, flows, data model, ML, API, running, tests) | ✅ |
| `notebooks/LogiStream_GRU_XGBoost.ipynb` (+ generator) | ✅ executed locally |
| Live vision on this laptop's GPU | ❌ GPU fault (`@@@@` replies); verified on CPU via `OLLAMA_VLM_NUM_GPU=0`; reboot needed |

