//! LogiStream `intel`: advisory diagnostics for the tutor (CLAUDE_CODE_BRIEF 6-7).
//!
//!   features  feature_schema_v1, shared with Python via tests/golden_v1.json
//!   gru       temporal GRU (burn): hidden state = session memory
//!   booster   XGBoost-style gradient booster, pure Rust
//!   synth     seeded synthetic scenarios (the only training data so far)
//!   metrics   top-k, macro-F1
//!
//! Everything trained here is "synthetic-trained v0, advisory, unvalidated".
//! The labels come from rules, so the models mostly relearn the rules. The
//! orchestrator treats this service as optional and falls back to its own
//! rules ranker whenever it is down, slow, or has no models.

pub mod booster;
pub mod features;
pub mod gru;
pub mod metrics;
pub mod synth;

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

pub const GRU_FILE: &str = "gru-v0.mpk";
pub const GRU_META: &str = "gru-v0.json";
pub const BOOSTER_FILE: &str = "booster-v0.json";

/// Booster input = feature vector + GRU state scores + GRU cause-group scores.
pub const BOOSTER_DIM: usize = features::DIM + 4 + 6;

pub fn booster_input(x: &[f32], state_scores: Option<&[f32]>, cause_scores: Option<&[f32]>) -> Vec<f32> {
    let mut v = Vec::with_capacity(BOOSTER_DIM);
    v.extend_from_slice(x);
    // without the GRU, a neutral uniform prior -- the same thing the booster
    // sees for an untrained GRU, so a missing GRU degrades gracefully
    v.extend(state_scores.map_or(vec![0.25; 4], |s| s.to_vec()));
    v.extend(cause_scores.map_or(vec![1.0 / 6.0; 6], |s| s.to_vec()));
    v
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct GruMeta {
    pub model_version: String,
    pub schema: String,
    pub hidden: usize,
    pub seed: u64,
    pub trained_on: String,
}

pub struct Models {
    pub gru: Option<(gru::TemporalGru<gru::Infer>, GruMeta)>,
    pub booster: Option<booster::Booster>,
    pub problems: Vec<String>,
}

/// Load whatever valid models exist in `dir`. Never panics: a missing, corrupt
/// or version-mismatched file is reported in `problems` and simply not used.
pub fn load_models(dir: &Path) -> Models {
    let mut problems = vec![];

    let gru = (|| -> Result<_, String> {
        let meta_raw = std::fs::read_to_string(dir.join(GRU_META)).map_err(|e| format!("{GRU_META}: {e}"))?;
        let meta: GruMeta = serde_json::from_str(&meta_raw).map_err(|e| format!("{GRU_META}: {e}"))?;
        if meta.schema != features::SCHEMA || meta.hidden != gru::HIDDEN {
            return Err(format!("{GRU_META}: schema {} / hidden {} does not match this build", meta.schema, meta.hidden));
        }
        let path: PathBuf = dir.join(GRU_FILE);
        let model = gru::load(&path.with_extension("")).map_err(|e| format!("{GRU_FILE}: {e}"))?;
        Ok((model, meta))
    })();
    let gru = gru.map_err(|e| problems.push(e)).ok();

    let booster = (|| -> Result<_, String> {
        let raw = std::fs::read_to_string(dir.join(BOOSTER_FILE)).map_err(|e| format!("{BOOSTER_FILE}: {e}"))?;
        let b: booster::Booster = serde_json::from_str(&raw).map_err(|e| format!("{BOOSTER_FILE}: {e}"))?;
        if b.schema != features::SCHEMA || b.n_features != BOOSTER_DIM || b.models.len() != features::CAUSES.len() {
            return Err(format!("{BOOSTER_FILE}: schema/shape does not match this build"));
        }
        Ok(b)
    })();
    let booster = booster.map_err(|e| problems.push(e)).ok();

    Models { gru, booster, problems }
}
