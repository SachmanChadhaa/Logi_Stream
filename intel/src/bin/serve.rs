//! intel-serve: the stateless sidecar the orchestrator calls (2 s timeout).
//!
//!   GET  /health      {ok, schema, gru, booster, problems}
//!   POST /v1/track    {schema, features[30], hidden[32]|null}
//!                  -> {schema, hidden, state_label, state_scores{}, cause_scores{}, model_version}
//!   POST /v1/rank     {schema, features[30], state_scores?, cause_scores?, candidates[ids]}
//!                  -> {schema, ranked:[{id, score}], model_version, score_kind}
//!
//! Stateless by design: the hidden state arrives with the request and leaves
//! with the response; the LangGraph checkpoint is where it lives. A missing or
//! bad model file yields 503 for that endpoint, and the orchestrator falls back
//! to its rules ranker. Every /v1 call needs X-Internal-Token, like the other
//! internal services. Binds 127.0.0.1 by default: only the orchestrator calls it.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use axum::{
    extract::{Request, State},
    http::StatusCode,
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use intel::features::{self, CAUSE_GROUPS, SCHEMA, STUDENT_STATES};
use intel::gru::{self, argmax, HIDDEN};
use intel::{booster_input, load_models, Models};
use serde::Deserialize;
use serde_json::{json, Value};
use tracing::{info, warn};

struct App {
    // burn modules are Send but not Sync, hence the Mutex; a step is well under
    // a millisecond, so serialising requests costs nothing at demo scale
    models: Mutex<Models>,
    token: String,
    /// The booster may REORDER the rules ranking only if it beat the rules on
    /// held-out scenarios (metrics-v0.json, real-choice top-1). Otherwise it
    /// runs in shadow mode: scores are returned, the rules order stands.
    promoted: bool,
    promotion_evidence: Value,
}

type Shared = Arc<App>;

fn err(code: StatusCode, detail: impl Into<String>) -> Response {
    (code, Json(json!({ "detail": detail.into() }))).into_response()
}

fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

async fn require_token(State(app): State<Shared>, req: Request, next: Next) -> Response {
    let ok = req
        .headers()
        .get("x-internal-token")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|t| ct_eq(t.as_bytes(), app.token.as_bytes()));
    if !ok {
        return err(StatusCode::UNAUTHORIZED, "missing or invalid X-Internal-Token");
    }
    next.run(req).await
}

async fn health(State(app): State<Shared>) -> Json<Value> {
    let models = app.models.lock().unwrap_or_else(|e| e.into_inner());
    Json(json!({
        "ok": true,
        "schema": SCHEMA,
        "gru": models.gru.as_ref().map(|(_, m)| m.model_version.clone()),
        "booster": models.booster.as_ref().map(|b| b.version.clone()),
        "label": "synthetic-trained v0, advisory, unvalidated",
        "problems": models.problems,
        "booster_promoted": app.promoted,
        "promotion_evidence": app.promotion_evidence,
    }))
}

#[derive(Deserialize)]
struct TrackBody {
    schema: String,
    features: Vec<f32>,
    hidden: Option<Vec<f32>>,
}

async fn track(State(app): State<Shared>, Json(b): Json<TrackBody>) -> Response {
    if b.schema != SCHEMA {
        return err(StatusCode::UNPROCESSABLE_ENTITY, format!("schema {} != {SCHEMA}", b.schema));
    }
    let x = match features::validate(&b.features) {
        Ok(x) => x,
        Err(e) => return err(StatusCode::UNPROCESSABLE_ENTITY, format!("bad features: {e:?}")),
    };
    if let Some(h) = &b.hidden {
        if h.len() != HIDDEN || h.iter().any(|v| !v.is_finite()) {
            return err(StatusCode::UNPROCESSABLE_ENTITY, format!("hidden must be {HIDDEN} finite floats"));
        }
    }
    let models = app.models.lock().unwrap_or_else(|e| e.into_inner());
    let Some((model, meta)) = &models.gru else {
        return err(StatusCode::SERVICE_UNAVAILABLE, "no GRU model loaded");
    };
    let out = gru::step(model, &x, b.hidden.as_deref());
    let named = |names: &[&str], v: &[f32]| -> BTreeMap<String, f32> {
        names.iter().zip(v).map(|(n, s)| (n.to_string(), (*s * 1000.0).round() / 1000.0)).collect()
    };
    Json(json!({
        "schema": SCHEMA,
        "hidden": out.hidden,
        "state_label": STUDENT_STATES[argmax(&out.state_scores)],
        "state_scores": named(&STUDENT_STATES, &out.state_scores),
        "cause_scores": named(&CAUSE_GROUPS, &out.cause_scores),
        "model_version": meta.model_version,
    }))
    .into_response()
}

#[derive(Deserialize)]
struct RankBody {
    schema: String,
    features: Vec<f32>,
    state_scores: Option<BTreeMap<String, f32>>,
    cause_scores: Option<BTreeMap<String, f32>>,
    candidates: Vec<String>,
}

fn ordered(names: &[&str], m: &Option<BTreeMap<String, f32>>) -> Option<Vec<f32>> {
    m.as_ref().map(|m| names.iter().map(|n| m.get(*n).copied().unwrap_or(0.0)).collect())
}

async fn rank(State(app): State<Shared>, Json(b): Json<RankBody>) -> Response {
    if b.schema != SCHEMA {
        return err(StatusCode::UNPROCESSABLE_ENTITY, format!("schema {} != {SCHEMA}", b.schema));
    }
    let x = match features::validate(&b.features) {
        Ok(x) => x,
        Err(e) => return err(StatusCode::UNPROCESSABLE_ENTITY, format!("bad features: {e:?}")),
    };
    let models = app.models.lock().unwrap_or_else(|e| e.into_inner());
    let Some(booster) = &models.booster else {
        return err(StatusCode::SERVICE_UNAVAILABLE, "no booster model loaded");
    };
    let input = booster_input(
        &x,
        ordered(&STUDENT_STATES, &b.state_scores).as_deref(),
        ordered(&CAUSE_GROUPS, &b.cause_scores).as_deref(),
    );
    let scores = booster.scores(&input);
    let mut ranked: Vec<(String, f32)> = b
        .candidates
        .iter()
        .filter_map(|c| features::cause_index(c).map(|i| (c.clone(), scores[i])))
        .collect();
    // unknown candidate ids are dropped rather than guessed at
    ranked.sort_by(|a, z| z.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    Json(json!({
        "schema": SCHEMA,
        "ranked": ranked.iter().map(|(id, s)| json!({"id": id, "score": if s.is_finite() { *s } else { -99.0 }}))
                        .collect::<Vec<_>>(),
        "model_version": booster.version,
        "promoted": app.promoted,
        "score_kind": "booster margin (ordering only, not a probability)",
    }))
    .into_response()
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .init();

    let dir = PathBuf::from(std::env::var("INTEL_MODELS_DIR").unwrap_or_else(|_| "models".into()));
    let models = load_models(&dir);
    for p in &models.problems {
        warn!("model not loaded: {p}");
    }
    info!(
        "intel models: gru={} booster={} (synthetic-trained v0, advisory)",
        models.gru.is_some(),
        models.booster.is_some()
    );

    // promotion is decided by the evaluation that trained the model, not by hope
    let metrics: Value = std::fs::read_to_string(dir.join("metrics-v0.json"))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(Value::Null);
    let rc = &metrics["cause_ranking_test"]["real_choice_top1"];
    let (b_top1, r_top1) = (rc["booster"].as_f64(), rc["rules"].as_f64());
    let promoted = matches!((b_top1, r_top1), (Some(b), Some(r)) if b > r);
    info!("booster promoted={promoted} (held-out real-choice top-1: booster {b_top1:?} vs rules {r_top1:?})");

    let app = Arc::new(App {
        promoted,
        promotion_evidence: json!({"real_choice_top1_booster": b_top1, "real_choice_top1_rules": r_top1}),
        models: Mutex::new(models),
        token: std::env::var("INTERNAL_TOKEN").unwrap_or_else(|_| "dev-internal-token-change-me".into()),
    });

    let v1 = Router::new()
        .route("/v1/track", post(track))
        .route("/v1/rank", post(rank))
        .route_layer(middleware::from_fn_with_state(app.clone(), require_token));
    let router = Router::new().route("/health", get(health)).merge(v1).with_state(app);

    let bind = std::env::var("INTEL_BIND").unwrap_or_else(|_| "127.0.0.1".into());
    let port = std::env::var("INTEL_PORT").unwrap_or_else(|_| "8003".into());
    let addr = format!("{bind}:{port}");
    let listener = tokio::net::TcpListener::bind(&addr).await.unwrap_or_else(|e| panic!("cannot bind {addr}: {e}"));
    info!("intel listening on {addr}");
    axum::serve(listener, router)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await
        .expect("server error");
}
