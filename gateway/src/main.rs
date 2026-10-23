//! LogiStream gateway (CLAUDE.md section 5.1).
//!
//! The only thing the browser talks to. Its jobs are small and all of them
//! matter:
//!
//!   * mock the auth that Supabase would do, but derive identity for real
//!   * compute `thread_id` server-side and NEVER accept one from the client
//!   * generate and propagate `X-Trace-Id` so one request is followable across
//!     four services
//!   * proxy to Python and Java with a timeout long enough for a tutor turn
//!
//! The thread derivation is the security-relevant part. A client that could
//! choose its own `thread_id` could read anyone's session, so any `thread_id`
//! arriving in a body or header is ignored outright.
//!
//! PUBLIC DEMO MODE (docs/BYOP.md, demo/DEPLOY_VERCEL.md). When the UI is on
//! Vercel and this gateway sits behind a Cloudflare tunnel, three more guards
//! apply, because behind it is a subprocess "sandbox" that is NOT a security
//! sandbox:
//!   * DEMO_PASSCODE: every /api call must carry X-Demo-Passcode
//!   * CORS_ORIGIN: a comma-separated allow-list (plus localhost:3000)
//!   * a per-passcode rate limit on code runs and screen observations

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::{
    Json, Router,
    body::Bytes,
    extract::{DefaultBodyLimit, Path, Request, State},
    http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tower_http::cors::{Any, CorsLayer};
use tracing::{info, warn};

const TRACE_HEADER: &str = "x-trace-id";
const INTERNAL_TOKEN_HEADER: &str = "x-internal-token";
const USER_HEADER: &str = "x-user-id";
const DEMO_USER_HEADER: &str = "x-demo-user";
const PASSCODE_HEADER: &str = "x-demo-passcode";

/// A downscaled JPEG frame as base64 is well under this; anything bigger is
/// either a full-resolution frame the browser should have shrunk, or abuse.
const MAX_OBSERVE_BODY: usize = 3 * 1024 * 1024;

#[derive(Clone)]
struct AppState {
    http: reqwest::Client,
    orchestrator_url: String,
    domain_url: String,
    internal_token: String,
    demo_user_id: String,
    /// None = local development, no passcode required (logged loudly at startup)
    passcode: Option<String>,
    limiter: Arc<RateLimiter>,
}

// ------------------------------------------------------------ rate limiting

/// Sliding-window limiter, in memory. One gateway process serves one demo, so
/// nothing fancier is needed; a restart resets it, which is fine.
struct RateLimiter {
    window: Duration,
    runs_per_window: usize,
    observes_per_window: usize,
    hits: Mutex<HashMap<String, VecDeque<Instant>>>,
}

impl RateLimiter {
    fn new(runs_per_min: usize, observes_per_min: usize) -> Self {
        Self {
            window: Duration::from_secs(60),
            runs_per_window: runs_per_min,
            observes_per_window: observes_per_min,
            hits: Mutex::new(HashMap::new()),
        }
    }

    /// Ok(()) and records the hit, or Err(seconds until a slot frees up).
    fn check(&self, key: &str, limit: usize, now: Instant) -> Result<(), u64> {
        let mut hits = self.hits.lock().unwrap_or_else(|e| e.into_inner());
        let q = hits.entry(key.to_string()).or_default();
        while q.front().is_some_and(|t| now.duration_since(*t) >= self.window) {
            q.pop_front();
        }
        if q.len() >= limit {
            let oldest = *q.front().expect("non-empty when at limit");
            let wait = self.window.saturating_sub(now.duration_since(oldest));
            return Err(wait.as_secs().max(1));
        }
        q.push_back(now);
        Ok(())
    }
}

/// Rate-limit key: per passcode, as the brief specifies. Without a passcode
/// (local dev) everything shares one bucket.
fn limiter_key(headers: &HeaderMap, kind: &str) -> String {
    let pass = headers
        .get(PASSCODE_HEADER)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("local");
    // never keep the passcode itself as a map key
    let mut h = Sha256::new();
    h.update(pass.as_bytes());
    format!("{kind}:{}", &hex::encode(h.finalize())[..16])
}

fn too_many(retry_after: u64, what: &str) -> Response {
    let mut res = (
        StatusCode::TOO_MANY_REQUESTS,
        Json(json!({ "detail": format!("too many {what}; try again in {retry_after}s") })),
    )
        .into_response();
    if let Ok(v) = HeaderValue::from_str(&retry_after.to_string()) {
        res.headers_mut().insert("retry-after", v);
    }
    res
}

// ---------------------------------------------------------------- passcode

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Middleware on every /api route. CORS preflights never reach it (the CORS
/// layer sits outside and answers OPTIONS itself), and /health is not under it.
async fn require_passcode(State(state): State<AppState>, req: Request, next: Next) -> Response {
    if let Some(expected) = &state.passcode {
        if req.method() != Method::OPTIONS {
            let ok = req
                .headers()
                .get(PASSCODE_HEADER)
                .and_then(|v| v.to_str().ok())
                .is_some_and(|got| constant_time_eq(got.as_bytes(), expected.as_bytes()));
            if !ok {
                warn!(path = %req.uri().path(), "rejected: missing or wrong demo passcode");
                return (
                    StatusCode::UNAUTHORIZED,
                    Json(json!({ "detail": "passcode required", "code": "passcode_required" })),
                )
                    .into_response();
            }
        }
    }
    next.run(req).await
}

/// Lets the UI check a passcode before showing anything. The middleware has
/// already accepted it by the time this runs.
async fn auth_check(State(state): State<AppState>) -> impl IntoResponse {
    Json(json!({ "ok": true, "passcode_required": state.passcode.is_some() }))
}

// ---------------------------------------------------------------- identity

/// `thread_id = hex(sha256(user_id + ":" + problem_id))` (section 5.1).
///
/// Deterministic so a returning student lands back in the same session, and
/// derived here so the client cannot pick one.
fn derive_thread_id(user_id: &str, problem_id: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(user_id.as_bytes());
    hasher.update(b":");
    hasher.update(problem_id.as_bytes());
    hex::encode(hasher.finalize())
}

/// The mocked auth extractor. Supabase JWT validation goes exactly here, and
/// nothing downstream has to change when it does (section 3).
fn resolve_user(headers: &HeaderMap, state: &AppState) -> String {
    headers
        .get(DEMO_USER_HEADER)
        .and_then(|v| v.to_str().ok())
        .filter(|s| !s.trim().is_empty())
        .map(|s| s.to_string())
        .unwrap_or_else(|| state.demo_user_id.clone())
}

fn resolve_trace_id(headers: &HeaderMap) -> String {
    headers
        .get(TRACE_HEADER)
        .and_then(|v| v.to_str().ok())
        .filter(|s| !s.trim().is_empty())
        .map(|s| s.to_string())
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string())
}

// ----------------------------------------------------------------- bodies

#[derive(Deserialize)]
struct StartBody {
    problem_id: String,
    // Note what is absent: thread_id. Serde ignores unknown fields, so a client
    // sending {"thread_id": "attacker"} is silently and harmlessly ignored --
    // which is the behaviour gateway/verify.sh asserts.
}

#[derive(Deserialize)]
struct EventBody {
    problem_id: String,
    #[serde(rename = "type")]
    event_type: String,
    text: String,
}

#[derive(Deserialize)]
struct ResetBody {
    problem_id: String,
}

// ---------------------------------------------------------------- handlers

async fn health() -> impl IntoResponse {
    Json(json!({ "ok": true, "service": "logistream-gateway" }))
}

/// A problem's browser-safe view. Goes through Java's internal route with the
/// resolved user, because a student's own problem is private: Java returns 404
/// for anyone but its owner. Curated samples are visible to everyone.
async fn get_problem(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(problem_id): Path<String>,
) -> Response {
    let trace_id = resolve_trace_id(&headers);
    let user_id = resolve_user(&headers, &state);
    let url = format!(
        "{}/internal/problems/{}/view",
        state.domain_url,
        encode_path_segment(&problem_id)
    );
    info!(trace_id = %trace_id, problem_id = %problem_id, "GET problem");
    proxy(&state, reqwest::Method::GET, &url, None, &trace_id, Some(&user_id)).await
}

/// Curated samples plus this user's own problems.
async fn list_problems(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let trace_id = resolve_trace_id(&headers);
    let user_id = resolve_user(&headers, &state);
    let url = format!("{}/internal/problems", state.domain_url);
    info!(trace_id = %trace_id, user_id = %user_id, "list problems");
    proxy(&state, reqwest::Method::GET, &url, None, &trace_id, Some(&user_id)).await
}

/// Bring your own problem. The body is passed through for Java to validate
/// (Java owns the limits); the owner is the resolved user, sent as a header,
/// so nothing in the body can create a problem on someone else's behalf.
async fn create_problem(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let trace_id = resolve_trace_id(&headers);
    let user_id = resolve_user(&headers, &state);
    if !body.is_object() {
        return (
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(json!({ "detail": "body must be a JSON object" })),
        )
            .into_response();
    }
    info!(trace_id = %trace_id, user_id = %user_id, "create problem");
    let url = format!("{}/internal/problems", state.domain_url);
    proxy(
        &state,
        reqwest::Method::POST,
        &url,
        Some(body),
        &trace_id,
        Some(&user_id),
    )
    .await
}

/// Problem ids end up in an upstream URL path. Curated ids and `custom-<uuid>`
/// only ever use [A-Za-z0-9-_], so anything else is percent-encoded rather than
/// trusted to stay inside its path segment.
fn encode_path_segment(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

async fn start_session(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<StartBody>,
) -> Response {
    let trace_id = resolve_trace_id(&headers);
    let user_id = resolve_user(&headers, &state);
    let thread_id = derive_thread_id(&user_id, &body.problem_id);

    info!(trace_id = %trace_id, user_id = %user_id, thread_id = %thread_id, "start session");

    let url = format!("{}/sessions/{}/start", state.orchestrator_url, thread_id);
    let payload = json!({ "problem_id": body.problem_id, "user_id": user_id });
    proxy(
        &state,
        reqwest::Method::POST,
        &url,
        Some(payload),
        &trace_id,
        Some(&user_id),
    )
    .await
}

async fn session_event(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<EventBody>,
) -> Response {
    let trace_id = resolve_trace_id(&headers);
    let user_id = resolve_user(&headers, &state);
    let thread_id = derive_thread_id(&user_id, &body.problem_id);

    // code runs execute student code on this laptop: rate-limited per passcode
    if body.event_type == "code" {
        let key = limiter_key(&headers, "run");
        if let Err(wait) = state
            .limiter
            .check(&key, state.limiter.runs_per_window, Instant::now())
        {
            warn!(trace_id = %trace_id, "run rate limit hit");
            return too_many(wait, "code runs");
        }
    }

    info!(
        trace_id = %trace_id, thread_id = %thread_id,
        event_type = %body.event_type, chars = body.text.len(),
        "session event"
    );

    let url = format!("{}/sessions/{}/event", state.orchestrator_url, thread_id);
    let payload = json!({ "type": body.event_type, "text": body.text });
    proxy(
        &state,
        reqwest::Method::POST,
        &url,
        Some(payload),
        &trace_id,
        Some(&user_id),
    )
    .await
}

async fn reset_session(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<ResetBody>,
) -> Response {
    let trace_id = resolve_trace_id(&headers);
    let user_id = resolve_user(&headers, &state);
    let thread_id = derive_thread_id(&user_id, &body.problem_id);

    info!(trace_id = %trace_id, thread_id = %thread_id, "reset session");

    let url = format!("{}/sessions/{}/reset", state.orchestrator_url, thread_id);
    proxy(
        &state,
        reqwest::Method::POST,
        &url,
        Some(json!({})),
        &trace_id,
        Some(&user_id),
    )
    .await
}

async fn get_session(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(problem_id): Path<String>,
) -> Response {
    let trace_id = resolve_trace_id(&headers);
    let user_id = resolve_user(&headers, &state);
    let thread_id = derive_thread_id(&user_id, &problem_id);

    info!(trace_id = %trace_id, thread_id = %thread_id, "get session");

    let url = format!("{}/sessions/{}", state.orchestrator_url, thread_id);
    proxy(
        &state,
        reqwest::Method::GET,
        &url,
        None,
        &trace_id,
        Some(&user_id),
    )
    .await
}

/// One screen observation (docs/BYOP.md, observer). The frame is passed
/// through to Python, which sends it to LOCAL Ollama only and keeps nothing but
/// a short text observation. The gateway never stores or logs the image.
async fn observe(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let trace_id = resolve_trace_id(&headers);
    let user_id = resolve_user(&headers, &state);
    let Some(problem_id) = body.get("problem_id").and_then(|v| v.as_str()) else {
        return (
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(json!({ "detail": "problem_id is required" })),
        )
            .into_response();
    };
    let thread_id = derive_thread_id(&user_id, problem_id);

    let key = limiter_key(&headers, "observe");
    if let Err(wait) = state
        .limiter
        .check(&key, state.limiter.observes_per_window, Instant::now())
    {
        return too_many(wait, "screen observations");
    }

    let image_chars = body.get("image_b64").and_then(|v| v.as_str()).map_or(0, str::len);
    info!(trace_id = %trace_id, thread_id = %thread_id, image_chars, "observe");

    // forward only the fields Python needs; anything else the client sent
    // (a thread_id, say) is dropped here
    let payload = json!({
        "image_b64": body.get("image_b64"),
        "trigger": body.get("trigger"),
        "code_revision": body.get("code_revision"),
    });
    let url = format!("{}/sessions/{}/observe", state.orchestrator_url, thread_id);
    proxy(&state, reqwest::Method::POST, &url, Some(payload), &trace_id, Some(&user_id)).await
}

/// Is the local VLM reachable, and which model? Lets the UI say "observer
/// unavailable" honestly before the student turns capture on.
async fn observer_status(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let trace_id = resolve_trace_id(&headers);
    let url = format!("{}/observer/status", state.orchestrator_url);
    proxy(&state, reqwest::Method::GET, &url, None, &trace_id, None).await
}

// ------------------------------------------------------------------ proxy

/// Forwards one request upstream and passes the response back unchanged.
///
/// Upstream status codes are preserved deliberately: Python's 409 for "you
/// cannot submit code during the logic phase" is a real, readable message and
/// the UI shows it to the student. Flattening everything to 500 here would
/// throw that away.
async fn proxy(
    state: &AppState,
    method: reqwest::Method,
    url: &str,
    body: Option<Value>,
    trace_id: &str,
    user_id: Option<&str>,
) -> Response {
    let mut req = state
        .http
        .request(method, url)
        .header(INTERNAL_TOKEN_HEADER, &state.internal_token)
        .header(TRACE_HEADER, trace_id);

    if let Some(uid) = user_id {
        req = req.header(USER_HEADER, uid);
    }
    if let Some(payload) = body {
        req = req.json(&payload);
    }

    match req.send().await {
        Ok(upstream) => {
            let status = StatusCode::from_u16(upstream.status().as_u16())
                .unwrap_or(StatusCode::BAD_GATEWAY);
            let mut bytes = upstream.bytes().await.unwrap_or_else(|_| Bytes::new());

            // Java says {"error": ...}, Python says {"detail": ...}. The UI reads
            // `detail`, so an error body without one gets it copied in. Success
            // bodies are passed through byte for byte.
            if !status.is_success() {
                if let Ok(Value::Object(mut obj)) = serde_json::from_slice::<Value>(&bytes) {
                    if !obj.contains_key("detail") {
                        if let Some(err) = obj.get("error").cloned() {
                            obj.insert("detail".into(), err);
                            bytes = Bytes::from(Value::Object(obj).to_string());
                        }
                    }
                }
            }

            let mut response = Response::builder()
                .status(status)
                .header("content-type", "application/json");

            if let (Ok(name), Ok(value)) = (
                HeaderName::try_from(TRACE_HEADER),
                HeaderValue::from_str(trace_id),
            ) {
                response = response.header(name, value);
            }

            response.body(bytes.into()).unwrap_or_else(|_| {
                (StatusCode::INTERNAL_SERVER_ERROR, "response build failed").into_response()
            })
        }
        Err(e) => {
            // a timeout here is almost always a slow tutor turn, so say so
            warn!(trace_id = %trace_id, url = %url, error = %e, "upstream request failed");
            let status = if e.is_timeout() {
                StatusCode::GATEWAY_TIMEOUT
            } else {
                StatusCode::BAD_GATEWAY
            };
            let mut res = (
                status,
                Json(json!({
                    "detail": format!("upstream request failed: {e}"),
                    "trace_id": trace_id,
                })),
            )
                .into_response();
            if let Ok(value) = HeaderValue::from_str(trace_id) {
                res.headers_mut()
                    .insert(HeaderName::from_static(TRACE_HEADER), value);
            }
            res
        }
    }
}

// ------------------------------------------------------------------- main

/// The configured origins plus local dev, de-duplicated, invalid ones skipped.
fn allowed_origins(configured: &str) -> Vec<HeaderValue> {
    let mut out: Vec<HeaderValue> = Vec::new();
    for o in configured
        .split(',')
        .map(|s| s.trim().trim_end_matches('/'))
        .chain(["http://localhost:3000", "http://127.0.0.1:3000"])
        .filter(|s| !s.is_empty())
    {
        match o.parse::<HeaderValue>() {
            Ok(v) if !out.contains(&v) => out.push(v),
            Ok(_) => {}
            Err(_) => warn!(origin = %o, "ignoring an unparsable CORS origin"),
        }
    }
    out
}

fn env_or(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_string())
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,tower_http=info".into()),
        )
        .init();

    let port: u16 = env_or("GATEWAY_PORT", "8000").parse().unwrap_or(8000);
    // Everything behind this gateway, student code execution included, is meant
    // for one local user. GATEWAY_BIND=127.0.0.1 locks it to loopback (then use
    // 127.0.0.1, not localhost, in the URLs: on Windows a localhost call to a
    // v4-only listener first spends ~2s failing on ::1).
    let bind = env_or("GATEWAY_BIND", "0.0.0.0");
    let cors_origin = env_or("CORS_ORIGIN", "http://localhost:3000");
    let passcode = std::env::var("DEMO_PASSCODE")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let runs_per_min: usize = env_or("RUN_RATE_LIMIT_PER_MIN", "12").parse().unwrap_or(12);
    let observes_per_min: usize = env_or("OBSERVE_RATE_LIMIT_PER_MIN", "12").parse().unwrap_or(12);

    let state = AppState {
        // reqwest has NO overall timeout unless you set one (trap 8). A tutor
        // turn on the free tier has been measured at over 90s, so 120s it is.
        http: reqwest::Client::builder()
            .timeout(Duration::from_secs(120))
            .build()
            .expect("failed to build http client"),
        orchestrator_url: env_or("ORCHESTRATOR_URL", "http://localhost:8001"),
        domain_url: env_or("DOMAIN_URL_FOR_GATEWAY", "http://localhost:8080"),
        internal_token: env_or("INTERNAL_TOKEN", "dev-internal-token-change-me"),
        demo_user_id: env_or("DEMO_USER_ID", "demo-user"),
        passcode: passcode.clone(),
        limiter: Arc::new(RateLimiter::new(runs_per_min, observes_per_min)),
    };

    if passcode.is_none() {
        warn!(
            "DEMO_PASSCODE is not set: /api is OPEN. Fine on localhost; never put this \
             behind a public tunnel without it (demo/DEPLOY_VERCEL.md)"
        );
    }

    // The browser sends X-Demo-User and reads X-Trace-Id, so both must be
    // allowed through the preflight or the POSTs fail with an opaque CORS error
    // (trap 6).
    //
    // CORS_ORIGIN may list several origins (comma-separated), e.g. the Vercel
    // deployment plus a preview URL. Local dev origins are always allowed. An
    // unparsable entry is skipped, never widened to "any".
    let origins = allowed_origins(&cors_origin);
    let cors = CorsLayer::new()
        .allow_origin(tower_http::cors::AllowOrigin::list(origins.clone()))
        .allow_methods(Any)
        .allow_headers(Any)
        .expose_headers([HeaderName::from_static(TRACE_HEADER)]);

    // Axum 0.8 path params are `/{id}`; the 0.7 `/:id` syntax panics at
    // startup rather than failing to compile (trap 5).
    let api = Router::new()
        .route("/api/auth/check", get(auth_check))
        .route("/api/observer/status", get(observer_status))
        .route(
            "/api/sessions/observe",
            post(observe).layer(DefaultBodyLimit::max(MAX_OBSERVE_BODY)),
        )
        .route("/api/problems", get(list_problems).post(create_problem))
        .route("/api/problems/{problem_id}", get(get_problem))
        .route("/api/sessions/start", post(start_session))
        .route("/api/sessions/event", post(session_event))
        .route("/api/sessions/reset", post(reset_session))
        .route("/api/sessions/{problem_id}", get(get_session))
        .route_layer(middleware::from_fn_with_state(state.clone(), require_passcode));

    let app = Router::new()
        .route("/health", get(health))
        .merge(api)
        .layer(cors)
        .layer(tower_http::trace::TraceLayer::new_for_http())
        .with_state(state.clone());

    let addr = format!("{bind}:{port}");
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .unwrap_or_else(|e| panic!("cannot bind {addr}: {e}"));

    info!(
        "gateway listening on {addr} -> orchestrator {} / domain {} (cors: {:?}, passcode: {})",
        state.orchestrator_url,
        state.domain_url,
        origins,
        if state.passcode.is_some() { "required" } else { "OFF" }
    );

    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
            info!("shutting down");
        })
        .await
        .expect("server error");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn thread_id_is_stable_and_matches_sha256() {
        let a = derive_thread_id("demo-user", "two-sum");
        let b = derive_thread_id("demo-user", "two-sum");
        assert_eq!(a, b, "derivation must be deterministic");
        assert_eq!(a.len(), 64, "hex sha256 is 64 chars");
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn different_users_get_different_threads() {
        assert_ne!(
            derive_thread_id("demo-user", "two-sum"),
            derive_thread_id("other", "two-sum")
        );
    }

    #[test]
    fn different_problems_get_different_threads() {
        assert_ne!(
            derive_thread_id("demo-user", "two-sum"),
            derive_thread_id("demo-user", "three-sum")
        );
    }

    #[test]
    fn separator_prevents_collisions() {
        // without the ":" these two would hash identically
        assert_ne!(
            derive_thread_id("ab", "c"),
            derive_thread_id("a", "bc"),
            "the ':' separator must make the concatenation unambiguous"
        );
    }

    #[test]
    fn start_body_ignores_a_client_supplied_thread_id() {
        let body: StartBody =
            serde_json::from_str(r#"{"problem_id":"two-sum","thread_id":"attacker"}"#)
                .expect("unknown fields must be ignored, not rejected");
        assert_eq!(body.problem_id, "two-sum");
        // there is no field to read it into, so it cannot reach the orchestrator
    }

    #[test]
    fn event_body_ignores_a_client_supplied_thread_id() {
        let body: EventBody = serde_json::from_str(
            r#"{"problem_id":"two-sum","type":"logic","text":"hi","thread_id":"attacker"}"#,
        )
        .expect("unknown fields must be ignored");
        assert_eq!(body.problem_id, "two-sum");
        assert_eq!(body.event_type, "logic");
    }

    #[test]
    fn path_segments_cannot_escape() {
        assert_eq!(encode_path_segment("two-sum"), "two-sum");
        assert_eq!(
            encode_path_segment("custom-0f8e1c2a-aaaa-bbbb-cccc-1234567890ab"),
            "custom-0f8e1c2a-aaaa-bbbb-cccc-1234567890ab"
        );
        assert_eq!(encode_path_segment("../internal"), "%2E%2E%2Finternal");
        assert_eq!(encode_path_segment("a?b#c"), "a%3Fb%23c");
    }

    #[test]
    fn rate_limiter_blocks_then_frees_up() {
        let l = RateLimiter::new(2, 1);
        let t0 = Instant::now();
        assert!(l.check("k", 2, t0).is_ok());
        assert!(l.check("k", 2, t0).is_ok());
        let wait = l.check("k", 2, t0).expect_err("third hit inside the window is refused");
        assert!(wait >= 1 && wait <= 60);
        assert!(l.check("other", 2, t0).is_ok(), "keys are independent");
        assert!(l.check("k", 2, t0 + Duration::from_secs(61)).is_ok(), "window slides");
    }

    #[test]
    fn passcode_compare() {
        assert!(constant_time_eq(b"abc", b"abc"));
        assert!(!constant_time_eq(b"abc", b"abd"));
        assert!(!constant_time_eq(b"abc", b"abcd"));
    }

    #[test]
    fn cors_list_always_has_localhost_and_never_any() {
        let o = allowed_origins("https://logistream.vercel.app/, not a header\u{0}, ");
        assert!(o.contains(&HeaderValue::from_static("https://logistream.vercel.app")));
        assert!(o.contains(&HeaderValue::from_static("http://localhost:3000")));
        assert!(!o.iter().any(|v| v == "*"));
        assert_eq!(o.len(), 3);
    }

    #[test]
    fn limiter_key_never_contains_the_passcode() {
        let mut h = HeaderMap::new();
        h.insert(PASSCODE_HEADER, HeaderValue::from_static("hunter2"));
        let k = limiter_key(&h, "run");
        assert!(k.starts_with("run:") && !k.contains("hunter2"));
    }
}
