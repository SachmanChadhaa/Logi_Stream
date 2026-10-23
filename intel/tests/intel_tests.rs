//! intel tests: schema contract, GRU determinism and persistence, booster
//! correctness, graceful model loading. No network, no trained files needed.

use intel::booster::{self, Params};
use intel::features::{self, CAUSES, DIM};
use intel::gru::{self, Infer, TemporalGru, HIDDEN};
use intel::{booster_input, load_models, synth, BOOSTER_DIM};
use serde_json::Value;

fn golden() -> Value {
    let raw = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/golden_v1.json")).unwrap();
    serde_json::from_str(&raw).unwrap()
}

fn model(seed: u64) -> TemporalGru<Infer> {
    use burn::tensor::backend::Backend;
    Infer::seed(seed);
    TemporalGru::<Infer>::new(&Default::default())
}

// ------------------------------------------------------------- schema

#[test]
fn golden_vector_matches_the_rust_schema() {
    let g = golden();
    assert_eq!(g["schema"], features::SCHEMA);
    assert_eq!(g["dim"].as_u64().unwrap() as usize, DIM);
    let names: Vec<&str> = g["features"].as_array().unwrap().iter().map(|v| v.as_str().unwrap()).collect();
    assert_eq!(names, features::FEATURES, "slot order is the contract");
    let causes: Vec<&str> = g["causes"].as_array().unwrap().iter().map(|v| v.as_str().unwrap()).collect();
    assert_eq!(causes, CAUSES);
    let v: Vec<f32> = g["vector"].as_array().unwrap().iter().map(|x| x.as_f64().unwrap() as f32).collect();
    // a valid Python vector passes validation unchanged
    assert_eq!(features::validate(&v).unwrap(), v);
}

#[test]
fn validation_rejects_bad_vectors() {
    assert_eq!(features::validate(&[0.0; 3]), Err(features::VectorError::WrongDim(3)));
    let mut v = vec![0.5; DIM];
    v[4] = f32::NAN;
    assert_eq!(features::validate(&v), Err(features::VectorError::NotFinite(4)));
    v[4] = 7.0;
    assert_eq!(features::validate(&v).unwrap()[4], 1.0, "clipped into [0,1]");
}

// ---------------------------------------------------------------- GRU

#[test]
fn gru_shapes_and_distributions() {
    let m = model(1);
    let out = gru::step(&m, &[0.1; DIM], None);
    assert_eq!(out.hidden.len(), HIDDEN);
    assert_eq!(out.state_scores.len(), 4);
    assert_eq!(out.cause_scores.len(), 6);
    assert!((out.state_scores.iter().sum::<f32>() - 1.0).abs() < 1e-4);
    assert!(out.hidden.iter().all(|h| h.is_finite() && h.abs() <= 1.0));
}

#[test]
fn identical_event_sequences_give_identical_hidden_states() {
    let m = model(2);
    let seq = &synth::generate(1, 9)[0];
    let a = gru::replay(&m, seq);
    let b = gru::replay(&m, seq);
    for (x, y) in a.iter().zip(&b) {
        assert_eq!(x.hidden, y.hidden);
    }
}

#[test]
fn hidden_state_survives_a_checkpoint_round_trip() {
    // what the orchestrator does: hidden -> JSON in the checkpoint -> back in
    let m = model(3);
    let seq = &synth::generate(1, 4)[1];
    let direct = gru::replay(&m, seq);

    let mut h: Option<Vec<f32>> = None;
    for (e, want) in seq.events.iter().zip(&direct) {
        let out = gru::step(&m, &e.x, h.as_deref());
        assert_eq!(out.hidden, want.hidden);
        let stored = serde_json::to_string(&out.hidden).unwrap(); // Python stores floats
        let as_f64: Vec<f64> = serde_json::from_str(&stored).unwrap();
        let back = serde_json::to_string(&as_f64).unwrap(); // and sends them back
        h = Some(serde_json::from_str(&back).unwrap());
    }
}

#[test]
fn hidden_state_carries_memory() {
    let m = model(5);
    let x = [0.3f32; DIM];
    let fresh = gru::step(&m, &x, None);
    let after = gru::step(&m, &x, Some(&fresh.hidden));
    assert_ne!(fresh.hidden, after.hidden, "the same event in a different history must differ");
}

#[test]
fn gru_save_load_round_trip() {
    let dir = std::env::temp_dir().join(format!("intel-test-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let m = model(6);
    gru::save(&m, &dir.join("g")).unwrap();
    let back = gru::load(&dir.join("g")).unwrap();
    let a = gru::step(&m, &[0.2; DIM], None);
    let b = gru::step(&back, &[0.2; DIM], None);
    assert_eq!(a.hidden, b.hidden);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn short_training_reduces_loss() {
    let (train, _) = synth::split(synth::generate(10, 1), 5);
    let (_, losses) = gru::train(&train, &gru::TrainConfig { epochs: 3, window: 8, lr: 3e-3, seed: 1 });
    assert!(losses[2] < losses[0], "loss should fall: {losses:?}");
}

// ------------------------------------------------------------ booster

#[test]
fn booster_learns_a_two_feature_interaction() {
    // y = a XOR b: not linearly separable; needs depth-2 trees. The four groups
    // are unbalanced on purpose: with perfectly balanced XOR every first split
    // has zero gain and a greedy learner (XGBoost included) never starts.
    let mut rows: Vec<Vec<f32>> = vec![];
    for (a, b, n) in [(0.0, 0.0, 100), (0.0, 1.0, 50), (1.0, 0.0, 150), (1.0, 1.0, 100)] {
        rows.extend(std::iter::repeat_n(vec![a, b, 0.5], n));
    }
    let labels: Vec<usize> = rows.iter().map(|r| ((r[0] > 0.5) ^ (r[1] > 0.5)) as usize).collect();
    let p = Params { rounds: 30, subsample: 1.0, colsample: 1.0, ..Params::default() };
    let b = booster::train(&rows, &labels, &["zero", "one"], "test", &p);
    for (r, y) in rows.iter().zip(&labels) {
        let s = b.scores(r);
        assert_eq!((s[1] > s[0]) as usize, *y);
    }
}

#[test]
fn leaf_weights_follow_the_xgboost_formula() {
    // one round, depth 0: the single leaf must be -G/(H+lambda) at p=base
    let rows = vec![vec![0.0]; 4];
    let labels = vec![1, 1, 1, 0];
    let p = Params { rounds: 1, max_depth: 0, lambda: 1.0, subsample: 1.0, colsample: 1.0, ..Params::default() };
    let b = booster::train(&rows, &labels, &["neg", "pos"], "test", &p);
    let m = b.models[1].as_ref().unwrap();
    let base = m.base_margin;
    let pr = 1.0 / (1.0 + (-base).exp());
    let g: f32 = labels.iter().map(|&y| pr - (y == 1) as i32 as f32).sum();
    let h: f32 = 4.0 * pr * (1.0 - pr);
    assert!((m.trees[0].nodes[0].value - (-g / (h + 1.0))).abs() < 1e-5);
}

#[test]
fn booster_json_round_trip() {
    let rows: Vec<Vec<f32>> = (0..50).map(|i| vec![(i % 5) as f32 / 5.0]).collect();
    let labels: Vec<usize> = rows.iter().map(|r| (r[0] > 0.4) as usize).collect();
    let b = booster::train(&rows, &labels, &["a", "b"], "test", &Params { rounds: 5, ..Params::default() });
    let back: booster::Booster = serde_json::from_str(&serde_json::to_string(&b).unwrap()).unwrap();
    assert_eq!(b.scores(&[0.8]), back.scores(&[0.8]));
}

// ------------------------------------------------------------- loading

#[test]
fn missing_or_corrupt_models_are_reported_not_fatal() {
    let dir = std::env::temp_dir().join(format!("intel-empty-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let m = load_models(&dir);
    assert!(m.gru.is_none() && m.booster.is_none());
    assert_eq!(m.problems.len(), 2);

    std::fs::write(dir.join(intel::BOOSTER_FILE), "{not json").unwrap();
    std::fs::write(dir.join(intel::GRU_META), r#"{"model_version":"x","schema":"feature_schema_v0","hidden":32,"seed":1,"trained_on":"t"}"#).unwrap();
    let m = load_models(&dir);
    assert!(m.gru.is_none() && m.booster.is_none(), "corrupt / mismatched files are not used");
    assert!(m.problems.iter().any(|p| p.contains("schema")));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn booster_input_degrades_without_the_gru() {
    let v = booster_input(&[0.0; DIM], None, None);
    assert_eq!(v.len(), BOOSTER_DIM);
    assert!((v[DIM..DIM + 4].iter().sum::<f32>() - 1.0).abs() < 1e-6);
}
