//! feature_schema_v1 — the Rust half of the contract (docs/feature_schema_v1.md).
//!
//! Python builds the vector (`orchestrator/app/features_v1.py`); this side only
//! validates and consumes it. Both sides are pinned to the same golden file,
//! `tests/golden_v1.json`, so a reordered or renamed slot fails a test on each
//! side rather than silently feeding the models garbage.

pub const SCHEMA: &str = "feature_schema_v1";
pub const DIM: usize = 30;

pub const FEATURES: [&str; DIM] = [
    "lang_python",
    "err_none",
    "err_compile",
    "err_runtime",
    "err_failing_test",
    "err_timeout",
    "has_error_line",
    "exception_known",
    "pass_ratio",
    "n_tests_norm",
    "stdout_empty_on_fail",
    "format_only_mismatch",
    "edit_size_norm",
    "changed_lines_norm",
    "code_unchanged",
    "dt_since_last_norm",
    "attempt_norm",
    "same_bucket_streak_norm",
    "recent_fail_rate",
    "stage_custom",
    "event_run",
    "event_chat",
    "event_observation",
    "event_idle",
    "vlm_error_visible",
    "vlm_editing",
    "vlm_terminal",
    "vlm_offtask",
    "loop_nesting_norm",
    "has_while_true",
];

/// Index of a named slot. Panics on a typo, which is what tests want.
pub fn idx(name: &str) -> usize {
    FEATURES
        .iter()
        .position(|f| *f == name)
        .unwrap_or_else(|| panic!("unknown feature {name}"))
}

pub const STUDENT_STATES: [&str; 4] = ["progressing", "stuck", "thrashing", "idle"];
pub const CAUSE_GROUPS: [&str; 6] = ["syntax", "runtime", "performance", "output", "logic", "unverified"];

/// Booster label space = the rules ranker's candidate ids (diagnostics.py).
pub const CAUSES: [&str; 22] = [
    "syntax",
    "undefined-name",
    "missing-key",
    "index-out-of-range",
    "type-mismatch",
    "uses-none",
    "missing-attribute",
    "bad-conversion",
    "division-by-zero",
    "unbounded-recursion",
    "reads-too-much-input",
    "module-unavailable",
    "runtime-crash",
    "too-slow",
    "possible-infinite-loop",
    "prints-nothing",
    "returns-none",
    "output-format",
    "extra-output",
    "logic-wrong-on-case",
    "unverified",
    "unchanged-code",
];

pub fn cause_index(id: &str) -> Option<usize> {
    CAUSES.iter().position(|c| *c == id)
}

/// The cause group a fine-grained cause belongs to (GRU output space).
pub fn group_of(cause: usize) -> usize {
    match CAUSES[cause] {
        "syntax" => 0,
        "too-slow" | "possible-infinite-loop" => 2,
        "prints-nothing" | "returns-none" | "output-format" | "extra-output" => 3,
        "logic-wrong-on-case" | "unchanged-code" => 4,
        "unverified" => 5,
        _ => 1,
    }
}

#[derive(Debug, PartialEq)]
pub enum VectorError {
    WrongDim(usize),
    NotFinite(usize),
}

/// Reject anything that is not a finite DIM-vector; clip into [0, 1].
pub fn validate(v: &[f32]) -> Result<Vec<f32>, VectorError> {
    if v.len() != DIM {
        return Err(VectorError::WrongDim(v.len()));
    }
    v.iter()
        .enumerate()
        .map(|(i, x)| {
            if x.is_finite() {
                Ok(x.clamp(0.0, 1.0))
            } else {
                Err(VectorError::NotFinite(i))
            }
        })
        .collect()
}
