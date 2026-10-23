//! The temporal model: a GRU over the session's event stream (burn, CPU).
//!
//! Input: one feature_schema_v1 vector per event. The hidden state (HIDDEN
//! floats) IS the session's temporal memory. The sidecar never keeps it: the
//! orchestrator sends the previous hidden state with each event and stores the
//! new one in the LangGraph checkpoint, so a restart loses nothing and two
//! students can never share state.
//!
//! Outputs per step: student-state logits (progressing / stuck / thrashing /
//! idle) and cause-group logits. Both feed the booster.
//!
//! Trained with truncated BPTT on synthetic scenarios (synth.rs):
//! "synthetic-trained v0, advisory, unvalidated".

use burn::backend::{Autodiff, NdArray};
use burn::module::AutodiffModule;
use burn::nn::gru::{Gru, GruConfig};
use burn::nn::loss::CrossEntropyLossConfig;
use burn::nn::{Linear, LinearConfig};
use burn::optim::{AdamConfig, GradientsParams, Optimizer};
use burn::prelude::*;
use burn::record::{FullPrecisionSettings, NamedMpkFileRecorder};
use burn::tensor::activation::softmax;

use crate::features::{CAUSE_GROUPS, DIM, STUDENT_STATES};
use crate::synth::Sequence;

pub const HIDDEN: usize = 32;
pub const MODEL_VERSION: &str = "gru-v0-synthetic";

pub type Infer = NdArray<f32>;
pub type Train = Autodiff<Infer>;

#[derive(Module, Debug)]
pub struct TemporalGru<B: Backend> {
    gru: Gru<B>,
    state_head: Linear<B>,
    cause_head: Linear<B>,
}

impl<B: Backend> TemporalGru<B> {
    pub fn new(device: &B::Device) -> Self {
        Self {
            gru: GruConfig::new(DIM, HIDDEN, true).init(device),
            state_head: LinearConfig::new(HIDDEN, STUDENT_STATES.len()).init(device),
            cause_head: LinearConfig::new(HIDDEN, CAUSE_GROUPS.len()).init(device),
        }
    }

    /// [batch, time, DIM] (+ initial hidden [batch, HIDDEN]) ->
    /// (hidden states [batch, time, HIDDEN], state logits, cause logits)
    pub fn forward(
        &self,
        x: Tensor<B, 3>,
        h0: Option<Tensor<B, 2>>,
    ) -> (Tensor<B, 3>, Tensor<B, 3>, Tensor<B, 3>) {
        let hs = self.gru.forward(x, h0);
        let s = self.state_head.forward(hs.clone());
        let c = self.cause_head.forward(hs.clone());
        (hs, s, c)
    }
}

/// One inference step, as /v1/track does it.
pub struct StepOut {
    pub hidden: Vec<f32>,
    pub state_scores: Vec<f32>,
    pub cause_scores: Vec<f32>,
}

pub fn step(model: &TemporalGru<Infer>, x: &[f32], hidden: Option<&[f32]>) -> StepOut {
    let device = Default::default();
    let xt = Tensor::<Infer, 1>::from_floats(x, &device).reshape([1, 1, DIM]);
    let h0 = hidden.map(|h| Tensor::<Infer, 1>::from_floats(h, &device).reshape([1, HIDDEN]));
    let (hs, s, c) = model.forward(xt, h0);
    let hidden: Vec<f32> = hs.reshape([HIDDEN]).into_data().to_vec().expect("f32");
    let state_scores: Vec<f32> = softmax(s.reshape([1, STUDENT_STATES.len()]), 1)
        .reshape([STUDENT_STATES.len()])
        .into_data()
        .to_vec()
        .expect("f32");
    let cause_scores: Vec<f32> = softmax(c.reshape([1, CAUSE_GROUPS.len()]), 1)
        .reshape([CAUSE_GROUPS.len()])
        .into_data()
        .to_vec()
        .expect("f32");
    StepOut { hidden, state_scores, cause_scores }
}

/// Run a whole sequence step by step, carrying the hidden state exactly as the
/// orchestrator will (one call per event). Used for evaluation and to produce
/// the booster's inputs.
pub fn replay(model: &TemporalGru<Infer>, seq: &Sequence) -> Vec<StepOut> {
    let mut h: Option<Vec<f32>> = None;
    seq.events
        .iter()
        .map(|e| {
            let out = step(model, &e.x, h.as_deref());
            h = Some(out.hidden.clone());
            out
        })
        .collect()
}

pub struct TrainConfig {
    pub epochs: usize,
    pub window: usize,
    pub lr: f64,
    pub seed: u64,
}

/// Truncated BPTT: each sequence is cut into windows of `window` steps; the
/// hidden state flows from one window into the next but is DETACHED, so
/// gradients never cross a window boundary.
pub fn train(train: &[Sequence], cfg: &TrainConfig) -> (TemporalGru<Infer>, Vec<f32>) {
    let device = Default::default();
    Train::seed(cfg.seed);
    let mut model = TemporalGru::<Train>::new(&device);
    let mut optim = AdamConfig::new().init();
    let ce = CrossEntropyLossConfig::new().init(&device);
    let mut losses = Vec::with_capacity(cfg.epochs);

    for _epoch in 0..cfg.epochs {
        let mut total = 0.0f32;
        let mut n = 0usize;
        for seq in train {
            let mut h: Option<Tensor<Train, 2>> = None;
            for chunk in seq.events.chunks(cfg.window) {
                let t = chunk.len();
                let flat: Vec<f32> = chunk.iter().flat_map(|e| e.x).collect();
                let x = Tensor::<Train, 1>::from_floats(flat.as_slice(), &device).reshape([1, t, DIM]);
                let ys = Tensor::<Train, 1, Int>::from_ints(
                    chunk.iter().map(|e| e.state as i32).collect::<Vec<_>>().as_slice(),
                    &device,
                );
                let yc = Tensor::<Train, 1, Int>::from_ints(
                    chunk.iter().map(|e| e.group as i32).collect::<Vec<_>>().as_slice(),
                    &device,
                );
                let (hs, s, c) = model.forward(x, h.clone());
                let loss = ce.forward(s.reshape([t, STUDENT_STATES.len()]), ys)
                    + ce.forward(c.reshape([t, CAUSE_GROUPS.len()]), yc) * 0.5;
                total += loss.clone().into_scalar();
                n += 1;
                let grads = GradientsParams::from_grads(loss.backward(), &model);
                model = optim.step(cfg.lr, model, grads);
                // carry the state forward, cut the gradient (truncated BPTT)
                h = Some(hs.slice([0..1, t - 1..t]).reshape([1, HIDDEN]).detach());
            }
        }
        losses.push(total / n.max(1) as f32);
    }
    (model.valid(), losses)
}

pub fn save(model: &TemporalGru<Infer>, path: &std::path::Path) -> Result<(), String> {
    model
        .clone()
        .save_file(path.to_path_buf(), &NamedMpkFileRecorder::<FullPrecisionSettings>::new())
        .map_err(|e| e.to_string())
}

pub fn load(path: &std::path::Path) -> Result<TemporalGru<Infer>, String> {
    let device = Default::default();
    TemporalGru::<Infer>::new(&device)
        .load_file(path.to_path_buf(), &NamedMpkFileRecorder::<FullPrecisionSettings>::new(), &device)
        .map_err(|e| e.to_string())
}

pub fn argmax(v: &[f32]) -> usize {
    v.iter()
        .enumerate()
        .max_by(|a, b| a.1.partial_cmp(b.1).unwrap_or(std::cmp::Ordering::Equal))
        .map(|(i, _)| i)
        .unwrap_or(0)
}
