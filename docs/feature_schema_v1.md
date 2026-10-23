# feature_schema_v1

One fixed-length vector per session event, built by the orchestrator
(`orchestrator/app/features_v1.py`) and consumed by the Rust sidecar
(`intel/`: GRU temporal model + booster). This file is the spec; the golden
vector in `intel/tests/golden_v1.json` is checked by **both** test suites.

* 30 floats, every value in `[0, 1]`. One-hots, flags, clipped ratios.
* Slot order **is** the contract. Never reorder or repurpose a slot. Any
  change ships as `feature_schema_v2`, and the sidecar rejects a request
  whose `schema` field does not match its own.
* Never contains hidden-test data, code, or screen content — only counts,
  statuses and four boolean tags derived from the local VLM's text.

| # | name | meaning |
|---|---|---|
| 0 | `lang_python` | 1 if the session language is Python |
| 1–5 | `err_none`, `err_compile`, `err_runtime`, `err_failing_test`, `err_timeout` | one-hot error category of this run (`none` for non-run events, `ACCEPTED` and `NO_TESTS`) |
| 6 | `has_error_line` | the traceback points at a line of the student's own code |
| 7 | `exception_known` | an exception type was parsed from stderr |
| 8 | `pass_ratio` | passed / total (0 when there are no tests) |
| 9 | `n_tests_norm` | min(tests, 20) / 20 |
| 10 | `stdout_empty_on_fail` | first failing public test printed nothing |
| 11 | `format_only_mismatch` | output equals expected except for whitespace |
| 12 | `edit_size_norm` | changed lines / code lines, clipped |
| 13 | `changed_lines_norm` | min(changed lines since last run, 50) / 50 |
| 14 | `code_unchanged` | run event with code identical to the previous run |
| 15 | `dt_since_last_norm` | min(seconds since previous event, 600) / 600 |
| 16 | `attempt_norm` | min(previous runs, 20) / 20 |
| 17 | `same_bucket_streak_norm` | min(consecutive runs with this bucket, 5) / 5 |
| 18 | `recent_fail_rate` | failing fraction of the last 5 runs |
| 19 | `stage_custom` | 1 for a bring-your-own-problem session |
| 20–23 | `event_run`, `event_chat`, `event_observation`, `event_idle` | one-hot event kind (`idle` = chat after > 5 min silence) |
| 24 | `vlm_error_visible` | the local VLM read an error message on screen (with text) |
| 25 | `vlm_editing` | VLM: student appears to be editing |
| 26 | `vlm_terminal` | VLM: a terminal is in front |
| 27 | `vlm_offtask` | VLM: browser / other |
| 28 | `loop_nesting_norm` | min(loop nesting depth, 3) / 3 |
| 29 | `has_while_true` | code contains `while True` / `while 1` |

## Outputs (intel)

* **GRU** (`POST /v1/track`): new hidden state (32 floats — the temporal
  memory, stored in the LangGraph checkpoint, never in the sidecar),
  `state_scores` over `progressing | stuck | thrashing | idle`, and
  `cause_scores` over the cause groups
  `syntax | runtime | performance | output | logic | unverified`.
* **Booster** (`POST /v1/rank`): scores for the candidate cause ids the rules
  ranker produced (`features_v1.CAUSES`). Scores order candidates; they are
  **not probabilities**.

Everything trained on this schema so far is **synthetic-trained v0,
advisory, unvalidated**.
