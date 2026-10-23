//! An XGBoost-style gradient booster, in pure Rust (no native build).
//!
//! The same objective and the same mathematics as XGBoost's binary:logistic
//! with the `hist` tree method, written out so it can be read in one sitting:
//!
//!   per round:  p = sigmoid(margin),  g = p - y,  h = p (1 - p)
//!   leaf weight w* = -G / (H + lambda)
//!   split gain     = 1/2 [ GL^2/(HL+lambda) + GR^2/(HR+lambda) - G^2/(H+lambda) ] - gamma
//!   margin        += eta * tree(x)              (shrinkage)
//!
//! plus max depth, min child weight (sum of hessians), and optional row /
//! column subsampling. Splits are searched over up to MAX_BINS quantile bins
//! per feature (XGBoost's `hist`). One binary booster per cause, one-vs-rest:
//! the margin of each candidate's booster is its ranking score.
//!
//! LABEL: "XGBoost-style booster, Rust". Scores ORDER candidates; they are
//! margins, not probabilities, and are never reported as such.

use rand::rngs::StdRng;
use rand::seq::SliceRandom;
use rand::{Rng, SeedableRng};
use serde::{Deserialize, Serialize};

pub const MAX_BINS: usize = 32;
pub const MODEL_VERSION: &str = "booster-v0-synthetic";

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Params {
    pub rounds: usize,
    pub eta: f32,
    pub max_depth: usize,
    pub lambda: f32,
    pub gamma: f32,
    pub min_child_weight: f32,
    pub subsample: f32,
    pub colsample: f32,
    pub seed: u64,
}

impl Default for Params {
    fn default() -> Self {
        Self {
            rounds: 60,
            eta: 0.2,
            max_depth: 4,
            lambda: 1.0,
            gamma: 0.0,
            min_child_weight: 1.0,
            subsample: 0.9,
            colsample: 0.9,
            seed: 7,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Node {
    /// -1 for a leaf
    pub feat: i32,
    pub thr: f32,
    pub left: u32,
    pub right: u32,
    pub value: f32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Tree {
    pub nodes: Vec<Node>,
}

impl Tree {
    pub fn predict(&self, x: &[f32]) -> f32 {
        let mut i = 0usize;
        loop {
            let n = &self.nodes[i];
            if n.feat < 0 {
                return n.value;
            }
            i = if x[n.feat as usize] < n.thr { n.left as usize } else { n.right as usize };
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Binary {
    pub base_margin: f32,
    pub trees: Vec<Tree>,
}

impl Binary {
    pub fn margin(&self, x: &[f32], eta: f32) -> f32 {
        self.base_margin + eta * self.trees.iter().map(|t| t.predict(x)).sum::<f32>()
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Booster {
    pub version: String,
    pub schema: String,
    pub n_features: usize,
    pub classes: Vec<String>,
    pub params: Params,
    /// one per class; None when the class never appeared as a positive
    pub models: Vec<Option<Binary>>,
}

impl Booster {
    /// Margin per class. A class with no model gets -inf: it was never seen.
    pub fn scores(&self, x: &[f32]) -> Vec<f32> {
        self.models
            .iter()
            .map(|m| m.as_ref().map_or(f32::NEG_INFINITY, |b| b.margin(x, self.params.eta)))
            .collect()
    }
}

fn sigmoid(z: f32) -> f32 {
    1.0 / (1.0 + (-z).exp())
}

/// Quantile bin edges per feature, from the training data.
pub fn bin_edges(rows: &[Vec<f32>], n_features: usize) -> Vec<Vec<f32>> {
    (0..n_features)
        .map(|f| {
            let mut v: Vec<f32> = rows.iter().map(|r| r[f]).collect();
            v.sort_by(|a, b| a.partial_cmp(b).unwrap());
            v.dedup();
            if v.len() <= MAX_BINS {
                // midpoints between distinct values: exact for discrete features
                v.windows(2).map(|w| (w[0] + w[1]) / 2.0).collect()
            } else {
                (1..MAX_BINS)
                    .map(|q| v[q * v.len() / MAX_BINS])
                    .collect::<Vec<_>>()
            }
        })
        .collect()
}

fn bin_of(edges: &[f32], x: f32) -> usize {
    edges.partition_point(|e| x >= *e)
}

struct Ctx<'a> {
    bins: &'a [Vec<u8>], // [row][feature]
    edges: &'a [Vec<f32>],
    g: &'a [f32],
    h: &'a [f32],
    p: &'a Params,
    cols: Vec<usize>,
}

fn leaf(g: f32, h: f32, lambda: f32) -> f32 {
    -g / (h + lambda)
}

fn score(g: f32, h: f32, lambda: f32) -> f32 {
    g * g / (h + lambda)
}

fn build(ctx: &Ctx, rows: &[usize], depth: usize, nodes: &mut Vec<Node>) -> u32 {
    let (gs, hs) = rows.iter().fold((0f32, 0f32), |(a, b), &r| (a + ctx.g[r], b + ctx.h[r]));
    let me = nodes.len() as u32;
    nodes.push(Node { feat: -1, thr: 0.0, left: 0, right: 0, value: leaf(gs, hs, ctx.p.lambda) });
    if depth >= ctx.p.max_depth || rows.len() < 2 {
        return me;
    }

    let parent = score(gs, hs, ctx.p.lambda);
    let mut best: Option<(f32, usize, usize)> = None; // gain, feature, bin
    for &f in &ctx.cols {
        let nb = ctx.edges[f].len() + 1;
        if nb < 2 {
            continue;
        }
        let mut hg = vec![0f32; nb];
        let mut hh = vec![0f32; nb];
        for &r in rows {
            let b = ctx.bins[r][f] as usize;
            hg[b] += ctx.g[r];
            hh[b] += ctx.h[r];
        }
        let (mut gl, mut hl) = (0f32, 0f32);
        for b in 0..nb - 1 {
            gl += hg[b];
            hl += hh[b];
            let (gr, hr) = (gs - gl, hs - hl);
            if hl < ctx.p.min_child_weight || hr < ctx.p.min_child_weight {
                continue;
            }
            let gain = 0.5 * (score(gl, hl, ctx.p.lambda) + score(gr, hr, ctx.p.lambda) - parent)
                - ctx.p.gamma;
            if gain > 1e-6 && best.is_none_or(|(bg, _, _)| gain > bg) {
                best = Some((gain, f, b));
            }
        }
    }

    let Some((_, f, b)) = best else { return me };
    let (l, r): (Vec<usize>, Vec<usize>) = rows.iter().partition(|&&i| (ctx.bins[i][f] as usize) <= b);
    let thr = ctx.edges[f][b];
    let left = build(ctx, &l, depth + 1, nodes);
    let right = build(ctx, &r, depth + 1, nodes);
    nodes[me as usize] = Node { feat: f as i32, thr, left, right, value: 0.0 };
    me
}

/// Train one binary:logistic booster.
pub fn train_binary(
    bins: &[Vec<u8>],
    edges: &[Vec<f32>],
    rows: &[Vec<f32>],
    y: &[f32],
    p: &Params,
    seed: u64,
) -> Binary {
    let n = y.len();
    let pos = y.iter().sum::<f32>().clamp(0.5, n as f32 - 0.5);
    let base_margin = (pos / (n as f32 - pos)).ln();
    let mut margin = vec![base_margin; n];
    let mut rng = StdRng::seed_from_u64(seed);
    let n_features = edges.len();
    let mut trees = Vec::with_capacity(p.rounds);

    for _ in 0..p.rounds {
        let (mut g, mut h) = (vec![0f32; n], vec![0f32; n]);
        for i in 0..n {
            let pi = sigmoid(margin[i]);
            g[i] = pi - y[i];
            h[i] = (pi * (1.0 - pi)).max(1e-6);
        }
        let sample: Vec<usize> = (0..n).filter(|_| rng.random::<f32>() < p.subsample).collect();
        let mut cols: Vec<usize> = (0..n_features).collect();
        cols.shuffle(&mut rng);
        cols.truncate(((n_features as f32 * p.colsample).ceil() as usize).max(1));
        let ctx = Ctx { bins, edges, g: &g, h: &h, p, cols };
        let mut nodes = vec![];
        build(&ctx, &sample, 0, &mut nodes);
        let tree = Tree { nodes };
        for i in 0..n {
            margin[i] += p.eta * tree.predict(&rows[i]);
        }
        trees.push(tree);
    }
    Binary { base_margin, trees }
}

/// One-vs-rest over `classes`. `labels[i]` is the true class of row i.
pub fn train(
    rows: &[Vec<f32>],
    labels: &[usize],
    classes: &[&str],
    schema: &str,
    p: &Params,
) -> Booster {
    let n_features = rows.first().map_or(0, |r| r.len());
    let edges = bin_edges(rows, n_features);
    let bins: Vec<Vec<u8>> = rows
        .iter()
        .map(|r| (0..n_features).map(|f| bin_of(&edges[f], r[f]) as u8).collect())
        .collect();
    let models = (0..classes.len())
        .map(|k| {
            let y: Vec<f32> = labels.iter().map(|&l| (l == k) as i32 as f32).collect();
            if y.iter().all(|v| *v == 0.0) {
                None
            } else {
                Some(train_binary(&bins, &edges, rows, &y, p, p.seed.wrapping_add(k as u64)))
            }
        })
        .collect();
    Booster {
        version: MODEL_VERSION.into(),
        schema: schema.into(),
        n_features,
        classes: classes.iter().map(|s| s.to_string()).collect(),
        params: p.clone(),
        models,
    }
}
