//! Synthetic training data: scripted session scenarios (seeded, documented).
//!
//! THE HONEST CAVEAT, up front. Every label here is produced by rules written
//! in this file -- the same kind of patterns `diagnostics.py` encodes. A model
//! trained on it can at best relearn those rules (plus whatever temporal
//! regularities the scenarios script in). It is "synthetic-trained v0,
//! advisory, unvalidated". Real labels need real, consented student sessions.
//!
//! Families (one sequence = one scenario instance):
//!   progressing  steady runs, moderate edits, errors resolve, ends ACCEPTED
//!   stuck        the same cause run after run, tiny or no edits, slow
//!   thrashing    rapid runs, big random edits, causes jumping around
//!   idle         long silences, chat / off-task observations, few runs
//!   recovering   stuck for a while, then a real fix -> progressing
//!
//! Each RUN event also records the candidate set the rules ranker would offer
//! (`candidates`) and its order (`rules_order`), so the booster and the rules
//! baseline are evaluated on exactly the same choice.

use rand::rngs::StdRng;
use rand::{Rng, SeedableRng};

use crate::features::{cause_index, group_of, idx, CAUSES, DIM};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Family {
    Progressing,
    Stuck,
    Thrashing,
    Idle,
    Recovering,
}

pub const FAMILIES: [Family; 5] = [
    Family::Progressing,
    Family::Stuck,
    Family::Thrashing,
    Family::Idle,
    Family::Recovering,
];

#[derive(Clone, Debug)]
pub struct Event {
    pub x: [f32; DIM],
    /// STUDENT_STATES index
    pub state: usize,
    /// CAUSE_GROUPS index carried forward from the latest run
    pub group: usize,
    /// true fine cause, for run events that failed
    pub cause: Option<usize>,
    /// what the rules ranker would offer, and in what order (best first)
    pub candidates: Vec<usize>,
    pub rules_order: Vec<usize>,
}

#[derive(Clone, Debug)]
pub struct Sequence {
    pub id: usize,
    pub family: Family,
    pub events: Vec<Event>,
}

/// diagnostics.py's rule weights, so the baseline here IS the rules ranker.
pub fn rule_weight(cause: usize, loop_nesting: f32) -> f32 {
    match CAUSES[cause] {
        "syntax" => 0.95,
        "possible-infinite-loop" => 0.75,
        "too-slow" => {
            if loop_nesting >= 0.66 {
                0.7
            } else {
                0.5
            }
        }
        "prints-nothing" | "returns-none" => 0.85,
        "output-format" | "extra-output" => 0.8,
        "logic-wrong-on-case" | "unverified" => 0.6,
        "unchanged-code" => 0.4,
        _ => 0.9, // runtime exceptions
    }
}

fn c(id: &str) -> usize {
    cause_index(id).expect("known cause")
}

const RUNTIME: [&str; 12] = [
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
];

struct Session {
    runs: Vec<usize>, // error category per run: 0 none,1 compile,2 runtime,3 failing,4 timeout
    last_cause: Option<usize>,
    group: usize,
    code_lines: f32,
    streak: usize,
    no_tests: bool,
    custom: bool,
}

#[derive(Clone, Copy)]
enum Kind {
    Run,
    Chat,
    Observation,
    Idle,
}

struct Step {
    kind: Kind,
    category: usize,
    cause: Option<usize>,
    changed: f32,
    dt: f32,
    unchanged: bool,
    pass_ratio: f32,
    stdout_empty: bool,
    format_only: bool,
    loops: f32,
    while_true: bool,
    vlm_error: bool,
    vlm_offtask: bool,
}

fn pick_cause(rng: &mut StdRng, category: usize) -> (usize, bool, bool, f32, bool) {
    // -> (cause, stdout_empty, format_only, loop_nesting_norm, while_true)
    match category {
        1 => (c("syntax"), false, false, 0.0, false),
        2 => (c(RUNTIME[rng.random_range(0..RUNTIME.len())]), false, false, 0.33, false),
        4 => {
            if rng.random_bool(0.3) {
                (c("possible-infinite-loop"), false, false, 0.33, true)
            } else {
                (c("too-slow"), false, false, if rng.random_bool(0.85) { 0.66 } else { 0.33 }, false)
            }
        }
        3 => {
            let r: f32 = rng.random();
            if r < 0.2 {
                // the observable flag is right 85% of the time
                let truth = if rng.random_bool(0.85) { c("prints-nothing") } else { c("logic-wrong-on-case") };
                (truth, true, false, 0.33, false)
            } else if r < 0.35 {
                let truth = if rng.random_bool(0.85) { c("output-format") } else { c("logic-wrong-on-case") };
                (truth, false, true, 0.33, false)
            } else if r < 0.45 {
                // returns-none / extra-output: the rules see the output text, the
                // feature vector does not -- an honest blind spot for the models
                (c(if rng.random_bool(0.5) { "returns-none" } else { "extra-output" }), false, false, 0.33, false)
            } else {
                (c("logic-wrong-on-case"), false, false, 0.33, false)
            }
        }
        _ => (c("unverified"), false, false, 0.0, false),
    }
}

/// The candidate list diagnostics.rank() would produce for this run.
fn rules_candidates(s: &Step, true_cause: usize) -> Vec<usize> {
    let mut v = match s.category {
        1 => vec![c("syntax")],
        2 => vec![true_cause], // rules read the exception type straight from stderr
        4 => {
            let mut v = vec![];
            if s.while_true {
                v.push(c("possible-infinite-loop"));
            }
            v.push(c("too-slow"));
            v
        }
        3 => {
            let mut v = vec![];
            if s.stdout_empty {
                v.push(c("prints-nothing"));
            }
            if CAUSES[true_cause] == "returns-none" {
                v.push(c("returns-none"));
            }
            if s.format_only {
                v.push(c("output-format"));
            }
            if CAUSES[true_cause] == "extra-output" {
                v.push(c("extra-output"));
            }
            v.push(c("logic-wrong-on-case"));
            v
        }
        _ => vec![c("unverified")],
    };
    if s.unchanged && !v.contains(&c("unchanged-code")) {
        v.push(c("unchanged-code"));
    }
    v.truncate(3);
    if !v.contains(&true_cause) {
        // diagnostics.py keeps the top 3; the truth can fall off the end, which
        // is a real failure mode, so it is kept rather than patched in
    }
    v
}

fn vector(s: &Step, sess: &Session) -> [f32; DIM] {
    let mut x = [0f32; DIM];
    x[idx("lang_python")] = 1.0;
    let cat = if matches!(s.kind, Kind::Run) { s.category } else { 0 };
    x[idx("err_none") + cat] = 1.0;
    let run = matches!(s.kind, Kind::Run);
    x[idx("has_error_line")] = if run && (cat == 2) { 1.0 } else { 0.0 };
    x[idx("exception_known")] = if run && (cat == 1 || cat == 2) { 1.0 } else { 0.0 };
    x[idx("pass_ratio")] = if run { s.pass_ratio } else { 0.0 };
    x[idx("n_tests_norm")] = if run && !sess.no_tests { 0.25 } else { 0.0 };
    x[idx("stdout_empty_on_fail")] = (run && s.stdout_empty) as i32 as f32;
    x[idx("format_only_mismatch")] = (run && s.format_only) as i32 as f32;
    x[idx("edit_size_norm")] = (s.changed / sess.code_lines.max(1.0)).clamp(0.0, 1.0);
    x[idx("changed_lines_norm")] = (s.changed / 50.0).clamp(0.0, 1.0);
    x[idx("code_unchanged")] = (run && s.unchanged) as i32 as f32;
    x[idx("dt_since_last_norm")] = (s.dt / 600.0).clamp(0.0, 1.0);
    x[idx("attempt_norm")] = (sess.runs.len() as f32 / 20.0).clamp(0.0, 1.0);
    x[idx("same_bucket_streak_norm")] = (sess.streak as f32 / 5.0).clamp(0.0, 1.0);
    let recent: Vec<_> = sess.runs.iter().rev().take(5).collect();
    x[idx("recent_fail_rate")] = if recent.is_empty() {
        0.0
    } else {
        recent.iter().filter(|r| ***r != 0).count() as f32 / recent.len() as f32
    };
    x[idx("stage_custom")] = sess.custom as i32 as f32;
    let k = match s.kind {
        Kind::Run => 0,
        Kind::Chat => 1,
        Kind::Observation => 2,
        Kind::Idle => 3,
    };
    x[idx("event_run") + k] = 1.0;
    x[idx("vlm_error_visible")] = s.vlm_error as i32 as f32;
    x[idx("vlm_editing")] = (matches!(s.kind, Kind::Observation) && !s.vlm_offtask && !s.vlm_error) as i32 as f32;
    x[idx("vlm_terminal")] = (matches!(s.kind, Kind::Observation) && s.vlm_error) as i32 as f32;
    x[idx("vlm_offtask")] = s.vlm_offtask as i32 as f32;
    x[idx("loop_nesting_norm")] = s.loops;
    x[idx("has_while_true")] = s.while_true as i32 as f32;
    x
}

/// State label for one step, from the family script (with a little noise).
fn label(family: Family, step: usize, sess: &Session, s: &Step, recovered: bool) -> usize {
    match family {
        Family::Progressing => 0,
        Family::Stuck => {
            if sess.streak >= 2 || step >= 3 {
                1
            } else {
                0
            }
        }
        Family::Thrashing => {
            if step >= 2 {
                2
            } else {
                0
            }
        }
        Family::Idle => {
            if s.dt > 280.0 || matches!(s.kind, Kind::Idle) || s.vlm_offtask {
                3
            } else {
                0
            }
        }
        Family::Recovering => {
            if recovered {
                0
            } else if sess.streak >= 2 || step >= 3 {
                1
            } else {
                0
            }
        }
    }
}

pub fn generate(n_per_family: usize, seed: u64) -> Vec<Sequence> {
    let mut rng = StdRng::seed_from_u64(seed);
    let mut out = Vec::new();
    let mut id = 0;
    for _ in 0..n_per_family {
        for &family in &FAMILIES {
            out.push(sequence(&mut rng, id, family));
            id += 1;
        }
    }
    out
}

fn sequence(rng: &mut StdRng, id: usize, family: Family) -> Sequence {
    let len = rng.random_range(10..=22);
    let mut sess = Session {
        runs: vec![],
        last_cause: None,
        group: 5,
        code_lines: rng.random_range(8.0..40.0),
        streak: 0,
        no_tests: rng.random_bool(0.15),
        custom: rng.random_bool(0.6),
    };
    let stuck_cat = rng.random_range(1..=4usize);
    let fix_at = rng.random_range(5..len.max(6));
    let mut events = Vec::with_capacity(len);
    let mut pass = 0.0f32;

    for step in 0..len {
        let recovered = family == Family::Recovering && step >= fix_at;
        let fam = if recovered { Family::Progressing } else { family };

        // event kind
        let r: f32 = rng.random();
        let kind = match fam {
            Family::Idle => {
                if r < 0.25 {
                    Kind::Run
                } else if r < 0.45 {
                    Kind::Chat
                } else if r < 0.75 {
                    Kind::Observation
                } else {
                    Kind::Idle
                }
            }
            Family::Thrashing => {
                if r < 0.85 {
                    Kind::Run
                } else {
                    Kind::Observation
                }
            }
            _ => {
                if r < 0.65 {
                    Kind::Run
                } else if r < 0.85 {
                    Kind::Chat
                } else {
                    Kind::Observation
                }
            }
        };

        let dt = match fam {
            Family::Thrashing => rng.random_range(4.0..40.0),
            Family::Stuck | Family::Recovering => rng.random_range(110.0..500.0),
            Family::Idle => rng.random_range(200.0..600.0),
            Family::Progressing => rng.random_range(40.0..240.0),
        };

        let mut s = Step {
            kind,
            category: 0,
            cause: None,
            changed: 0.0,
            dt,
            unchanged: false,
            pass_ratio: 0.0,
            stdout_empty: false,
            format_only: false,
            loops: 0.0,
            while_true: false,
            vlm_error: false,
            vlm_offtask: false,
        };

        match kind {
            Kind::Run => {
                s.category = match fam {
                    Family::Stuck => {
                        if rng.random_bool(0.9) {
                            stuck_cat
                        } else {
                            rng.random_range(1..=4)
                        }
                    }
                    Family::Thrashing => rng.random_range(1..=4),
                    Family::Progressing => {
                        if step + 1 >= len || (recovered && step >= fix_at + 2) || rng.random_bool(0.25) {
                            0
                        } else {
                            rng.random_range(1..=4)
                        }
                    }
                    Family::Idle => rng.random_range(0..=4),
                    Family::Recovering => stuck_cat,
                };
                if s.category == 0 && sess.no_tests {
                    s.cause = Some(c("unverified"));
                } else if s.category != 0 {
                    let (cause, empty, fmt, loops, wt) = if fam == Family::Stuck
                        && sess.last_cause.is_some()
                        && rng.random_bool(0.8)
                    {
                        let lc = sess.last_cause.unwrap();
                        let cat = match group_of(lc) {
                            0 => 1,
                            1 => 2,
                            2 => 4,
                            5 => 0,
                            _ => 3,
                        };
                        if cat == s.category {
                            let empty = CAUSES[lc] == "prints-nothing";
                            let fmt = CAUSES[lc] == "output-format";
                            let wt = CAUSES[lc] == "possible-infinite-loop";
                            (lc, empty, fmt, if group_of(lc) == 2 { 0.66 } else { 0.33 }, wt)
                        } else {
                            pick_cause(rng, s.category)
                        }
                    } else {
                        pick_cause(rng, s.category)
                    };
                    s.cause = Some(cause);
                    s.stdout_empty = empty;
                    s.format_only = fmt;
                    s.loops = loops;
                    s.while_true = wt;
                }
                s.changed = match fam {
                    Family::Thrashing => rng.random_range(15.0..50.0),
                    Family::Stuck => {
                        if rng.random_bool(0.45) {
                            0.0
                        } else {
                            rng.random_range(1.0..3.0)
                        }
                    }
                    _ => rng.random_range(2.0..15.0),
                };
                s.unchanged = s.changed < 0.5 && !sess.runs.is_empty();
                pass = match s.category {
                    0 => 1.0,
                    3 => (pass + rng.random_range(0.0..0.3)).min(0.8),
                    _ => 0.0,
                };
                s.pass_ratio = if sess.no_tests { 0.0 } else { pass };
            }
            Kind::Observation => {
                s.vlm_error = sess.runs.last().is_some_and(|r| *r != 0) && rng.random_bool(0.6);
                s.vlm_offtask = fam == Family::Idle && rng.random_bool(0.6);
            }
            _ => {}
        }

        // streak counts runs in a row with the same category, as Python does
        if matches!(kind, Kind::Run) {
            if sess.runs.last() == Some(&s.category) {
                sess.streak += 1;
            } else {
                sess.streak = 1;
            }
        }

        let x = vector(&s, &sess);
        let mut state = label(family, step, &sess, &s, recovered);
        if rng.random_bool(0.05) {
            state = rng.random_range(0..4); // label noise: real labels are noisy too
        }

        let (candidates, rules_order) = match (kind, s.cause) {
            (Kind::Run, Some(cause)) if s.category != 0 || sess.no_tests => {
                let cands = rules_candidates(&s, cause);
                let mut order = cands.clone();
                order.sort_by(|a, b| {
                    rule_weight(*b, s.loops)
                        .partial_cmp(&rule_weight(*a, s.loops))
                        .unwrap()
                });
                (cands, order)
            }
            _ => (vec![], vec![]),
        };

        if matches!(kind, Kind::Run) {
            sess.runs.push(s.category);
            if let Some(cause) = s.cause {
                sess.last_cause = Some(cause);
                sess.group = group_of(cause);
            } else {
                sess.last_cause = None;
            }
        }

        events.push(Event {
            x,
            state,
            group: sess.group,
            cause: if matches!(kind, Kind::Run) { s.cause } else { None },
            candidates,
            rules_order,
        });
    }

    Sequence { id, family, events }
}

/// Split by SCENARIO (whole sequences), never by row: every event of a session
/// lands on the same side, so the test set measures generalisation to unseen
/// sessions rather than memorised neighbours.
pub fn split(seqs: Vec<Sequence>, test_every: usize) -> (Vec<Sequence>, Vec<Sequence>) {
    let mut train = vec![];
    let mut test = vec![];
    for s in seqs {
        if (s.id / FAMILIES.len()) % test_every == 0 {
            test.push(s);
        } else {
            train.push(s);
        }
    }
    (train, test)
}
