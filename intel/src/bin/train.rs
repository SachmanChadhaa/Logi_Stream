//! intel-train: generate synthetic scenarios, train GRU + booster, evaluate on
//! held-out SCENARIOS against the rules baselines, save models and a report.
//!
//!   cargo run --release --bin intel-train -- [--out models] [--per-family 240]
//!                                             [--epochs 10] [--seed 42]
//!
//! Deterministic for a given seed. Prints, and writes to <out>/metrics-v0.json,
//! the comparison the brief asks for -- and the caveat that belongs next to it:
//! the labels come from rules, so these models mostly relearn the rules.

use std::io::Write;
use std::path::PathBuf;
use std::time::Instant;

use intel::booster::{self, Params};
use intel::features::{idx, CAUSES, CAUSE_GROUPS, SCHEMA, STUDENT_STATES};
use intel::gru::{self, argmax, TrainConfig, HIDDEN};
use intel::metrics::{accuracy, macro_f1, top_k};
use intel::synth::{self, Family, Sequence};
use intel::{booster_input, GruMeta, BOOSTER_FILE, GRU_META};
use serde_json::json;

fn arg(name: &str, default: &str) -> String {
    let args: Vec<String> = std::env::args().collect();
    args.iter()
        .position(|a| a == name)
        .and_then(|i| args.get(i + 1).cloned())
        .unwrap_or_else(|| default.to_string())
}

/// The rules baseline for student state: the heuristic a person would write.
fn rules_state(x: &[f32]) -> usize {
    let dt = x[idx("dt_since_last_norm")];
    if dt >= 0.47 || x[idx("event_idle")] > 0.5 || x[idx("vlm_offtask")] > 0.5 {
        3
    } else if x[idx("event_run")] > 0.5 && dt < 0.07 && x[idx("changed_lines_norm")] > 0.3 {
        2
    } else if x[idx("same_bucket_streak_norm")] >= 0.4 || x[idx("code_unchanged")] > 0.5 {
        1
    } else {
        0
    }
}

struct RankRow {
    x: Vec<f32>,
    label: usize,
    candidates: Vec<usize>,
    rules_order: Vec<usize>,
    family: Family,
}

fn rank_rows(model: &gru::TemporalGru<gru::Infer>, seqs: &[Sequence]) -> Vec<RankRow> {
    let mut out = vec![];
    for s in seqs {
        let steps = gru::replay(model, s);
        for (e, o) in s.events.iter().zip(&steps) {
            if let (Some(label), false) = (e.cause, e.candidates.is_empty()) {
                out.push(RankRow {
                    x: booster_input(&e.x, Some(&o.state_scores), Some(&o.cause_scores)),
                    label,
                    candidates: e.candidates.clone(),
                    rules_order: e.rules_order.clone(),
                    family: s.family,
                });
            }
        }
    }
    out
}

fn main() {
    let out = PathBuf::from(arg("--out", "models"));
    let per_family: usize = arg("--per-family", "240").parse().unwrap();
    let epochs: usize = arg("--epochs", "10").parse().unwrap();
    let seed: u64 = arg("--seed", "42").parse().unwrap();
    std::fs::create_dir_all(&out).expect("create output dir");
    let t0 = Instant::now();

    // ------------------------------------------------------------- data
    let all = synth::generate(per_family, seed);
    let (train, test) = synth::split(all, 5);
    let n_ev = |v: &[Sequence]| v.iter().map(|s| s.events.len()).sum::<usize>();
    println!(
        "synthetic scenarios: {} train / {} test sequences ({} / {} events), split by scenario",
        train.len(),
        test.len(),
        n_ev(&train),
        n_ev(&test)
    );

    // -------------------------------------------------------------- GRU
    let cfg = TrainConfig { epochs, window: 8, lr: 3e-3, seed };
    let (model, losses) = gru::train(&train, &cfg);
    println!("GRU trained: {} epochs, loss {:.3} -> {:.3} ({:.0}s)", epochs, losses[0],
             losses[losses.len() - 1], t0.elapsed().as_secs_f32());
    gru::save(&model, &out.join("gru-v0")).expect("save GRU");
    let meta = GruMeta {
        model_version: gru::MODEL_VERSION.into(),
        schema: SCHEMA.into(),
        hidden: HIDDEN,
        seed,
        trained_on: format!("synthetic scenarios, {per_family} per family, seed {seed}"),
    };
    std::fs::write(out.join(GRU_META), serde_json::to_string_pretty(&meta).unwrap()).unwrap();

    // state eval: GRU vs rules heuristic, on held-out scenarios
    let (mut yt, mut yg, mut yr) = (vec![], vec![], vec![]);
    let (mut ct, mut cg) = (vec![], vec![]);
    for s in &test {
        for (e, o) in s.events.iter().zip(gru::replay(&model, s)) {
            yt.push(e.state);
            yg.push(argmax(&o.state_scores));
            yr.push(rules_state(&e.x));
            ct.push(e.group);
            cg.push(argmax(&o.cause_scores));
        }
    }
    let state = json!({
        "gru":   {"accuracy": accuracy(&yt, &yg), "macro_f1": macro_f1(&yt, &yg, STUDENT_STATES.len())},
        "rules": {"accuracy": accuracy(&yt, &yr), "macro_f1": macro_f1(&yt, &yr, STUDENT_STATES.len())},
        "cause_group_gru": {"accuracy": accuracy(&ct, &cg), "macro_f1": macro_f1(&ct, &cg, CAUSE_GROUPS.len())},
    });

    // ---------------------------------------------------------- booster
    let tr = rank_rows(&model, &train);
    let te = rank_rows(&model, &test);
    let xs: Vec<Vec<f32>> = tr.iter().map(|r| r.x.clone()).collect();
    let ys: Vec<usize> = tr.iter().map(|r| r.label).collect();
    let params = Params::default();
    let tb = Instant::now();
    let b = booster::train(&xs, &ys, &CAUSES, SCHEMA, &params);
    println!("booster trained: {} rows, {} classes, {:.0}s", xs.len(), CAUSES.len(), tb.elapsed().as_secs_f32());
    std::fs::write(out.join(BOOSTER_FILE), serde_json::to_string(&b).unwrap()).unwrap();

    let booster_order = |r: &RankRow| {
        let s = b.scores(&r.x);
        let mut c = r.candidates.clone();
        c.sort_by(|a, z| s[*z].partial_cmp(&s[*a]).unwrap_or(std::cmp::Ordering::Equal));
        c
    };
    let eval = |rows: &[RankRow]| {
        let rules: Vec<(usize, Vec<usize>)> = rows.iter().map(|r| (r.label, r.rules_order.clone())).collect();
        let boost: Vec<(usize, Vec<usize>)> = rows.iter().map(|r| (r.label, booster_order(r))).collect();
        let y: Vec<usize> = rows.iter().map(|r| r.label).collect();
        let pr: Vec<usize> = rules.iter().map(|(_, o)| o[0]).collect();
        let pb: Vec<usize> = boost.iter().map(|(_, o)| o[0]).collect();
        let unrestricted: Vec<usize> = rows.iter().map(|r| argmax(&b.scores(&r.x))).collect();
        let multi = rows.iter().filter(|r| r.candidates.len() > 1).count();
        // the cases where ordering matters at all (a single candidate is trivially top-1)
        let pick = |v: &Vec<(usize, Vec<usize>)>| -> Vec<(usize, Vec<usize>)> {
            v.iter().zip(rows).filter(|(_, r)| r.candidates.len() > 1).map(|(c, _)| c.clone()).collect()
        };
        let (rules_multi, boost_multi) = (pick(&rules), pick(&boost));
        json!({
            "cases": rows.len(),
            "cases_with_a_real_choice": multi,
            "real_choice_top1": {"rules": top_k(&rules_multi, 1), "booster": top_k(&boost_multi, 1)},
            "rules":   {"top1": top_k(&rules, 1), "top3": top_k(&rules, 3), "macro_f1": macro_f1(&y, &pr, CAUSES.len())},
            "booster": {"top1": top_k(&boost, 1), "top3": top_k(&boost, 3), "macro_f1": macro_f1(&y, &pb, CAUSES.len()),
                        "unrestricted_top1_over_all_22_causes": accuracy(&y, &unrestricted)},
        })
    };
    let by_family: serde_json::Value = synth::FAMILIES
        .iter()
        .map(|f| {
            let rows: Vec<RankRow> = te
                .iter()
                .filter(|r| r.family == *f)
                .map(|r| RankRow { x: r.x.clone(), label: r.label, candidates: r.candidates.clone(),
                                   rules_order: r.rules_order.clone(), family: r.family })
                .collect();
            (format!("{f:?}"), eval(&rows))
        })
        .collect::<serde_json::Map<_, _>>()
        .into();

    let report = json!({
        "label": "synthetic-trained v0, advisory, unvalidated",
        "caveat": "Labels are generated by rules (src/synth.rs). Models trained on them mostly \
                   relearn those rules; these numbers say nothing about real students.",
        "schema": SCHEMA,
        "seed": seed,
        "split": "by scenario (whole sequences), every 5th scenario group held out",
        "gru": {"model_version": gru::MODEL_VERSION, "hidden": HIDDEN, "epochs": epochs,
                "loss_first": losses[0], "loss_last": losses[losses.len() - 1]},
        "student_state_test": state,
        "cause_ranking_test": eval(&te),
        "cause_ranking_test_by_family": by_family,
        "booster_params": params,
        "seconds": t0.elapsed().as_secs_f32(),
    });
    std::fs::write(out.join("metrics-v0.json"), serde_json::to_string_pretty(&report).unwrap()).unwrap();

    // same rows for the real-xgboost cross-check (scripts/xgb_crosscheck.py)
    for (name, rows) in [("data_train.csv", &tr), ("data_test.csv", &te)] {
        let mut f = std::fs::File::create(out.join(name)).unwrap();
        let header: Vec<String> = (0..rows[0].x.len()).map(|i| format!("f{i}")).collect();
        writeln!(f, "label,candidates,rules_top,rust_top,{}", header.join(",")).unwrap();
        for r in rows.iter() {
            let c: Vec<String> = r.candidates.iter().map(|x| x.to_string()).collect();
            let xs: Vec<String> = r.x.iter().map(|v| format!("{v:.6}")).collect();
            writeln!(f, "{},{},{},{},{}", r.label, c.join("|"), r.rules_order[0], booster_order(r)[0],
                     xs.join(",")).unwrap();
        }
    }

    println!("\n{}", serde_json::to_string_pretty(&json!({
        "student_state_test": report["student_state_test"],
        "cause_ranking_test": report["cause_ranking_test"],
    })).unwrap());
    println!("\nsynthetic-trained v0, advisory, unvalidated: labels come from rules, so the models mostly relearn them.");
    println!("saved to {} in {:.0}s", out.display(), t0.elapsed().as_secs_f32());
}
