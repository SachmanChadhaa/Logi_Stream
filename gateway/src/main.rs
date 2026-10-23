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

use std::time::Duration;

use axum::{
    Json, Router,
    body::Bytes,
    extract::{Path, State},
    http::{HeaderMap, HeaderName, HeaderValue, StatusCode},
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

#[derive(Clone)]
struct AppState {
    http: reqwest::Client,
    orchestrator_url: String,
    domain_url: String,
    internal_token: String,
    demo_user_id: String,
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
    };

    // The browser sends X-Demo-User and reads X-Trace-Id, so both must be
    // allowed through the preflight or the POSTs fail with an opaque CORS error
    // (trap 6).
    let cors = CorsLayer::new()
        .allow_origin(
            cors_origin
                .parse::<HeaderValue>()
                .map(tower_http::cors::AllowOrigin::exact)
                .unwrap_or_else(|_| tower_http::cors::AllowOrigin::any()),
        )
        .allow_methods(Any)
        .allow_headers(Any)
        .expose_headers([HeaderName::from_static(TRACE_HEADER)]);

    // Axum 0.8 path params are `/{id}`; the 0.7 `/:id` syntax panics at
    // startup rather than failing to compile (trap 5).
    let app = Router::new()
        .route("/health", get(health))
        .route("/api/problems", get(list_problems).post(create_problem))
        .route("/api/problems/{problem_id}", get(get_problem))
        .route("/api/sessions/start", post(start_session))
        .route("/api/sessions/event", post(session_event))
        .route("/api/sessions/reset", post(reset_session))
        .route("/api/sessions/{problem_id}", get(get_session))
        .layer(cors)
        .layer(tower_http::trace::TraceLayer::new_for_http())
        .with_state(state.clone());

    let addr = format!("{bind}:{port}");
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .unwrap_or_else(|e| panic!("cannot bind {addr}: {e}"));

    info!(
        "gateway listening on {addr} -> orchestrator {} / domain {} (cors: {cors_origin})",
        state.orchestrator_url, state.domain_url
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
}
