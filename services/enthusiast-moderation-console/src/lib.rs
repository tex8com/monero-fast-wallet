use argon2::{
    password_hash::{PasswordHash, PasswordVerifier},
    Argon2,
};
use axum::{
    extract::{DefaultBodyLimit, Form, Path, State},
    http::{
        header::{
            CACHE_CONTROL, CONTENT_SECURITY_POLICY, COOKIE, HOST, REFERRER_POLICY, SET_COOKIE,
        },
        HeaderMap, HeaderValue, StatusCode,
    },
    response::{Html, IntoResponse, Redirect, Response},
    routing::{get, post},
    Router,
};
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};
use subtle::ConstantTimeEq;
use url::Url;
use zeroize::{Zeroize, Zeroizing};

const SESSION_COOKIE: &str = "__Host-tex8_moderation";
const SESSION_LIFETIME_MS: u64 = 30 * 60 * 1_000;
const MAX_SESSIONS: usize = 16;
const MAX_LOGIN_FAILURES: usize = 8;
const LOGIN_WINDOW_MS: u64 = 15 * 60 * 1_000;

#[derive(Clone)]
pub struct ConsoleState {
    inner: Arc<ConsoleInner>,
}

struct ConsoleInner {
    upstream: Url,
    internal_token: Zeroizing<String>,
    password_hash: Zeroizing<String>,
    moderator_id: String,
    client: reqwest::Client,
    sessions: Mutex<HashMap<[u8; 32], Session>>,
    login_failures: Mutex<Vec<u64>>,
}

#[derive(Clone)]
struct Session {
    expires_at_ms: u64,
    csrf_token: String,
}

impl ConsoleState {
    pub fn new(
        upstream: &str,
        internal_token: String,
        password_hash: String,
        moderator_id: String,
    ) -> Result<Self, String> {
        if internal_token.len() < 32 {
            return Err("internal token must contain at least 32 bytes".to_owned());
        }
        validate_password_hash(&password_hash)?;
        validate_identifier(&moderator_id).map_err(|_| "moderator id is invalid".to_owned())?;
        let upstream = validate_upstream(upstream)?;
        let client = reqwest::Client::builder()
            .https_only(upstream.scheme() == "https")
            .redirect(reqwest::redirect::Policy::none())
            .timeout(std::time::Duration::from_secs(10))
            .user_agent("TEX8-Monero-Enthusiast-Moderation/0.1")
            .build()
            .map_err(|_| "moderation HTTP client could not be created".to_owned())?;
        Ok(Self {
            inner: Arc::new(ConsoleInner {
                upstream,
                internal_token: Zeroizing::new(internal_token),
                password_hash: Zeroizing::new(password_hash),
                moderator_id,
                client,
                sessions: Mutex::new(HashMap::new()),
                login_failures: Mutex::new(Vec::new()),
            }),
        })
    }
}

pub fn router(state: ConsoleState) -> Router {
    Router::new()
        .route("/", get(show_console))
        .route("/login", post(login))
        .route("/logout", post(logout))
        .route("/cases/{case_id}/acknowledge", post(acknowledge_case))
        .route("/cases/{case_id}/decision", post(decide_case))
        .route(
            "/chat-reports/{case_id}/acknowledge",
            post(acknowledge_chat_report),
        )
        .route("/chat-reports/{case_id}/decision", post(decide_chat_report))
        .fallback(not_found)
        .layer(DefaultBodyLimit::max(8 * 1024))
        .with_state(state)
}

async fn show_console(State(state): State<ConsoleState>, headers: HeaderMap) -> Response {
    if let Some(location) = canonical_localhost_url(&headers) {
        let mut response = Redirect::temporary(&location).into_response();
        secure_headers(response.headers_mut());
        return response;
    }
    let Some(session) = authenticated_session(&state, &headers) else {
        return secure_html(login_page(None));
    };
    let (publication_cases, chat_reports) =
        tokio::join!(fetch_queue(&state), fetch_chat_report_queue(&state));
    match (publication_cases, chat_reports) {
        (Ok(cases), Ok(chat_reports)) => {
            secure_html(queue_page(&cases, &chat_reports, &session.csrf_token))
        }
        _ => secure_html(queue_error_page(&session.csrf_token)),
    }
}

async fn login(State(state): State<ConsoleState>, Form(mut input): Form<LoginInput>) -> Response {
    let now = now_ms();
    if !reserve_login_attempt(&state, now) {
        input.password.zeroize();
        return (
            StatusCode::TOO_MANY_REQUESTS,
            secure_html(login_page(Some(
                "Too many attempts. Wait 15 minutes and try again.",
            ))),
        )
            .into_response();
    }
    let password = Zeroizing::new(std::mem::take(&mut input.password));
    let password_hash = Zeroizing::new(state.inner.password_hash.to_string());
    let valid = tokio::task::spawn_blocking(move || {
        PasswordHash::new(&password_hash)
            .ok()
            .and_then(|hash| {
                Argon2::default()
                    .verify_password(password.as_bytes(), &hash)
                    .ok()
            })
            .is_some()
    })
    .await
    .unwrap_or(false);
    if !valid {
        return (
            StatusCode::UNAUTHORIZED,
            secure_html(login_page(Some("The password is incorrect."))),
        )
            .into_response();
    }
    clear_login_failures(&state);
    let (raw_token, _) = create_session(&state, now);
    let mut response = Redirect::to("/").into_response();
    let cookie = format!(
        "{SESSION_COOKIE}={raw_token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age={}",
        SESSION_LIFETIME_MS / 1_000
    );
    if let Ok(value) = HeaderValue::from_str(&cookie) {
        response.headers_mut().insert(SET_COOKIE, value);
    }
    secure_headers(response.headers_mut());
    response
}

async fn logout(
    State(state): State<ConsoleState>,
    headers: HeaderMap,
    Form(input): Form<CsrfInput>,
) -> Response {
    if let Some((session_hash, session)) = authenticated_session_with_hash(&state, &headers) {
        if constant_time_text_eq(&session.csrf_token, &input.csrf_token) {
            if let Ok(mut sessions) = state.inner.sessions.lock() {
                sessions.remove(&session_hash);
            }
        }
    }
    let mut response = Redirect::to("/").into_response();
    response.headers_mut().insert(
        SET_COOKIE,
        HeaderValue::from_static(
            "__Host-tex8_moderation=deleted; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0",
        ),
    );
    secure_headers(response.headers_mut());
    response
}

async fn acknowledge_case(
    State(state): State<ConsoleState>,
    headers: HeaderMap,
    Path(case_id): Path<String>,
    Form(input): Form<CsrfInput>,
) -> Response {
    if authorize_form(&state, &headers, &input.csrf_token).is_none()
        || validate_identifier(&case_id).is_err()
    {
        return StatusCode::NOT_FOUND.into_response();
    }
    let result = state
        .inner
        .client
        .post(upstream_url(
            &state,
            &format!("/internal/v2/moderation/cases/{case_id}/acknowledge"),
        ))
        .bearer_auth(state.inner.internal_token.as_str())
        .json(&serde_json::json!({"moderatorId": state.inner.moderator_id}))
        .send()
        .await;
    redirect_after_internal(result).await
}

async fn decide_case(
    State(state): State<ConsoleState>,
    headers: HeaderMap,
    Path(case_id): Path<String>,
    Form(input): Form<DecisionInput>,
) -> Response {
    if authorize_form(&state, &headers, &input.csrf_token).is_none()
        || validate_identifier(&case_id).is_err()
        || !matches!(
            input.decision.as_str(),
            "approve" | "reject" | "keep_visible" | "hide" | "remove" | "reinstate"
        )
        || input.reason.trim() != input.reason
        || input.reason.is_empty()
        || input.reason.chars().count() > 2_000
        || input.reason.chars().any(char::is_control)
    {
        return StatusCode::BAD_REQUEST.into_response();
    }
    let result = state
        .inner
        .client
        .post(upstream_url(
            &state,
            &format!("/internal/v2/moderation/cases/{case_id}/decision"),
        ))
        .bearer_auth(state.inner.internal_token.as_str())
        .json(&serde_json::json!({
            "moderatorId": state.inner.moderator_id,
            "decision": input.decision,
            "reason": input.reason
        }))
        .send()
        .await;
    redirect_after_internal(result).await
}

async fn acknowledge_chat_report(
    State(state): State<ConsoleState>,
    headers: HeaderMap,
    Path(case_id): Path<String>,
    Form(input): Form<CsrfInput>,
) -> Response {
    if authorize_form(&state, &headers, &input.csrf_token).is_none()
        || validate_identifier(&case_id).is_err()
    {
        return StatusCode::NOT_FOUND.into_response();
    }
    let result = state
        .inner
        .client
        .post(upstream_url(
            &state,
            &format!("/internal/v2/moderation/chat-reports/{case_id}/acknowledge"),
        ))
        .bearer_auth(state.inner.internal_token.as_str())
        .json(&serde_json::json!({"moderatorId": state.inner.moderator_id}))
        .send()
        .await;
    redirect_after_internal(result).await
}

async fn decide_chat_report(
    State(state): State<ConsoleState>,
    headers: HeaderMap,
    Path(case_id): Path<String>,
    Form(input): Form<DecisionInput>,
) -> Response {
    if authorize_form(&state, &headers, &input.csrf_token).is_none()
        || validate_identifier(&case_id).is_err()
        || !matches!(
            input.decision.as_str(),
            "dismiss" | "warn_sender" | "suspend_sender"
        )
        || input.reason.trim() != input.reason
        || input.reason.is_empty()
        || input.reason.chars().count() > 2_000
        || input.reason.chars().any(char::is_control)
    {
        return StatusCode::BAD_REQUEST.into_response();
    }
    let result = state
        .inner
        .client
        .post(upstream_url(
            &state,
            &format!("/internal/v2/moderation/chat-reports/{case_id}/decision"),
        ))
        .bearer_auth(state.inner.internal_token.as_str())
        .json(&serde_json::json!({
            "moderatorId": state.inner.moderator_id,
            "decision": input.decision,
            "reason": input.reason
        }))
        .send()
        .await;
    redirect_after_internal(result).await
}

async fn redirect_after_internal(result: Result<reqwest::Response, reqwest::Error>) -> Response {
    match result {
        Ok(response) if response.status().is_success() => Redirect::to("/").into_response(),
        _ => StatusCode::BAD_GATEWAY.into_response(),
    }
}

async fn fetch_queue(state: &ConsoleState) -> Result<Vec<ModerationQueueCase>, ()> {
    let response = state
        .inner
        .client
        .get(upstream_url(
            state,
            "/internal/v2/moderation/cases?limit=100",
        ))
        .bearer_auth(state.inner.internal_token.as_str())
        .send()
        .await
        .map_err(|_| ())?;
    if !response.status().is_success() {
        return Err(());
    }
    response.json().await.map_err(|_| ())
}

async fn fetch_chat_report_queue(state: &ConsoleState) -> Result<Vec<ChatReportQueueCase>, ()> {
    let response = state
        .inner
        .client
        .get(upstream_url(
            state,
            "/internal/v2/moderation/chat-reports?limit=100",
        ))
        .bearer_auth(state.inner.internal_token.as_str())
        .send()
        .await
        .map_err(|_| ())?;
    if !response.status().is_success() {
        return Err(());
    }
    response.json().await.map_err(|_| ())
}

fn upstream_url(state: &ConsoleState, path: &str) -> Url {
    state
        .inner
        .upstream
        .join(path.trim_start_matches('/'))
        .expect("validated internal API path")
}

fn create_session(state: &ConsoleState, now_ms: u64) -> (String, String) {
    let mut token = [0u8; 32];
    let mut csrf = [0u8; 32];
    OsRng.fill_bytes(&mut token);
    OsRng.fill_bytes(&mut csrf);
    let raw_token = hex::encode(token);
    let csrf_token = hex::encode(csrf);
    let token_hash: [u8; 32] = Sha256::digest(raw_token.as_bytes()).into();
    if let Ok(mut sessions) = state.inner.sessions.lock() {
        sessions.retain(|_, session| session.expires_at_ms > now_ms);
        if sessions.len() >= MAX_SESSIONS {
            if let Some(oldest) = sessions
                .iter()
                .min_by_key(|(_, session)| session.expires_at_ms)
                .map(|(key, _)| *key)
            {
                sessions.remove(&oldest);
            }
        }
        sessions.insert(
            token_hash,
            Session {
                expires_at_ms: now_ms.saturating_add(SESSION_LIFETIME_MS),
                csrf_token: csrf_token.clone(),
            },
        );
    }
    (raw_token, csrf_token)
}

fn authenticated_session(state: &ConsoleState, headers: &HeaderMap) -> Option<Session> {
    authenticated_session_with_hash(state, headers).map(|(_, session)| session)
}

fn authenticated_session_with_hash(
    state: &ConsoleState,
    headers: &HeaderMap,
) -> Option<([u8; 32], Session)> {
    let raw = cookie(headers, SESSION_COOKIE)?;
    if raw.len() != 64 || !raw.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    let token_hash: [u8; 32] = Sha256::digest(raw.as_bytes()).into();
    let now = now_ms();
    let mut sessions = state.inner.sessions.lock().ok()?;
    sessions.retain(|_, session| session.expires_at_ms > now);
    sessions
        .get(&token_hash)
        .cloned()
        .map(|session| (token_hash, session))
}

fn authorize_form(state: &ConsoleState, headers: &HeaderMap, csrf_token: &str) -> Option<Session> {
    let session = authenticated_session(state, headers)?;
    constant_time_text_eq(&session.csrf_token, csrf_token).then_some(session)
}

fn cookie<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers
        .get(COOKIE)?
        .to_str()
        .ok()?
        .split(';')
        .map(str::trim)
        .find_map(|entry| entry.strip_prefix(&format!("{name}=")))
}

/*
 * Browsers accept Secure cookies on the trustworthy `localhost` origin, while
 * numeric loopback aliases are inconsistent. Canonicalize the entry page
 * before rendering the login form. This preserves the __Host- cookie contract
 * and prevents a repeated-login loop.
 */
fn canonical_localhost_url(headers: &HeaderMap) -> Option<String> {
    let authority = headers.get(HOST)?.to_str().ok()?;
    let port = if authority == "127.0.0.1" || authority == "[::1]" {
        ""
    } else if let Some(port) = authority.strip_prefix("127.0.0.1:") {
        checked_port(port)?
    } else {
        let port = authority.strip_prefix("[::1]:")?;
        checked_port(port)?
    };
    Some(if port.is_empty() {
        "http://localhost/".to_owned()
    } else {
        format!("http://localhost:{port}/")
    })
}

fn checked_port(port: &str) -> Option<&str> {
    let parsed = port.parse::<u16>().ok()?;
    (parsed != 0 && parsed.to_string() == port).then_some(port)
}

fn reserve_login_attempt(state: &ConsoleState, now_ms: u64) -> bool {
    let Ok(mut failures) = state.inner.login_failures.lock() else {
        return false;
    };
    failures.retain(|timestamp| now_ms.saturating_sub(*timestamp) <= LOGIN_WINDOW_MS);
    if failures.len() >= MAX_LOGIN_FAILURES {
        return false;
    }
    failures.push(now_ms);
    true
}

fn clear_login_failures(state: &ConsoleState) {
    if let Ok(mut failures) = state.inner.login_failures.lock() {
        failures.clear();
    }
}

fn constant_time_text_eq(left: &str, right: &str) -> bool {
    left.len() == right.len() && bool::from(left.as_bytes().ct_eq(right.as_bytes()))
}

fn validate_upstream(value: &str) -> Result<Url, String> {
    let url = Url::parse(value).map_err(|_| "internal API origin is invalid".to_owned())?;
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
        || url.host_str().is_none()
        || !matches!(url.scheme(), "http" | "https")
    {
        return Err("internal API origin is invalid".to_owned());
    }
    if url.scheme() == "http" && !matches!(url.host_str(), Some("127.0.0.1" | "::1" | "localhost"))
    {
        return Err("plaintext internal API is allowed only on loopback".to_owned());
    }
    Ok(url)
}

fn validate_password_hash(value: &str) -> Result<(), String> {
    let parsed =
        PasswordHash::new(value).map_err(|_| "moderator password hash is invalid".to_owned())?;
    let memory_kib = parsed.params.get_decimal("m").unwrap_or_default();
    let iterations = parsed.params.get_decimal("t").unwrap_or_default();
    let lanes = parsed.params.get_decimal("p").unwrap_or_default();
    if parsed.algorithm.as_str() != "argon2id"
        || parsed.version != Some(19)
        || !(65_536..=1_048_576).contains(&memory_kib)
        || !(3..=10).contains(&iterations)
        || !(1..=16).contains(&lanes)
        || parsed.salt.is_none()
        || parsed.hash.is_none()
    {
        return Err(
            "moderator password verifier must use Argon2id v19 with at least 64 MiB and 3 iterations"
                .to_owned(),
        );
    }
    Ok(())
}

fn validate_identifier(value: &str) -> Result<(), ()> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
    {
        return Err(());
    }
    Ok(())
}

fn secure_html(body: String) -> Response {
    let mut response = Html(body).into_response();
    secure_headers(response.headers_mut());
    response
}

fn secure_headers(headers: &mut HeaderMap) {
    headers.insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(REFERRER_POLICY, HeaderValue::from_static("no-referrer"));
    headers.insert(
        CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(
            "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
        ),
    );
    headers.insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
}

async fn not_found() -> StatusCode {
    StatusCode::NOT_FOUND
}

fn login_page(error: Option<&str>) -> String {
    let error = error
        .map(|message| format!("<p class=\"error\">{}</p>", escape_html(message)))
        .unwrap_or_default();
    format!(
        "{HTML_START}<main><h1>Moderation</h1><p>Sign in to review Community reports.</p>{error}<form method=\"post\" action=\"/login\"><label>Password<input name=\"password\" type=\"password\" autocomplete=\"current-password\" required autofocus></label><button type=\"submit\">Sign in</button></form></main>{HTML_END}"
    )
}

fn queue_error_page(csrf: &str) -> String {
    format!(
        "{HTML_START}<main><h1>Moderation</h1><p class=\"error\">The moderation service is temporarily unavailable.</p>{}</main>{HTML_END}",
        logout_form(csrf)
    )
}

fn queue_page(
    cases: &[ModerationQueueCase],
    chat_reports: &[ChatReportQueueCase],
    csrf: &str,
) -> String {
    let cards = if cases.is_empty() && chat_reports.is_empty() {
        "<p class=\"empty\">No cases are waiting.</p>".to_owned()
    } else {
        let mut cards = chat_reports
            .iter()
            .map(|case| chat_report_card(case, csrf))
            .collect::<Vec<_>>();
        cards.extend(cases.iter().map(|case| case_card(case, csrf)));
        cards.join("")
    };
    format!(
        "{HTML_START}<main><header><div><p class=\"eyebrow\">Monero Enthusiast</p><h1>Moderation queue</h1></div>{}</header>{cards}</main>{HTML_END}",
        logout_form(csrf)
    )
}

fn chat_report_card(case: &ChatReportQueueCase, csrf: &str) -> String {
    let acknowledged = case
        .acknowledged_by
        .as_deref()
        .map(|value| format!("Acknowledged by {}", escape_html(value)))
        .unwrap_or_else(|| "Not acknowledged".to_owned());
    let notice = if case.illegal_content_notice {
        "Illegal-content notice"
    } else {
        "Chat report"
    };
    let appeal = case
        .appeal_reason
        .as_deref()
        .map(|value| format!("<p><strong>Appeal:</strong> {}</p>", escape_html(value)))
        .unwrap_or_default();
    format!(
        "<article><p class=\"eyebrow\">{notice} · one selected E2EE message</p><h2>Voluntary message report</h2><p><strong>Reason:</strong> {}</p><blockquote>{}</blockquote>{appeal}<details><summary>Minimum Matrix evidence</summary><p>Sender: <code>{}</code></p><p>Event: <code>{}</code></p><p>Timestamp: {}</p><p>Reporter: <code>{}</code> · peer: <code>{}</code></p></details><p class=\"meta\">{acknowledged}</p><form method=\"post\" action=\"/chat-reports/{}/acknowledge\"><input type=\"hidden\" name=\"csrfToken\" value=\"{csrf}\"><button type=\"submit\">Acknowledge</button></form><form method=\"post\" action=\"/chat-reports/{}/decision\"><input type=\"hidden\" name=\"csrfToken\" value=\"{csrf}\"><label>Decision<select name=\"decision\"><option value=\"dismiss\">Dismiss / reverse suspension</option><option value=\"warn_sender\">Warn sender / lift suspension</option><option value=\"suspend_sender\">Suspend sender / uphold suspension</option></select></label><label>Reason<textarea name=\"reason\" maxlength=\"2000\" required></textarea></label><button type=\"submit\">Save chat decision</button></form></article>",
        escape_html(&case.reason),
        escape_html(&case.selected_message.body),
        escape_html(&case.selected_message.sender_id),
        escape_html(&case.selected_message.event_id),
        case.selected_message.timestamp_ms,
        escape_html(&case.reporter_public_id),
        escape_html(&case.peer_public_id),
        escape_html(&case.case_id),
        escape_html(&case.case_id),
    )
}

fn case_card(case: &ModerationQueueCase, csrf: &str) -> String {
    let evidence = case
        .private_evidence
        .as_deref()
        .map(escape_html)
        .unwrap_or_else(|| "No private report text.".to_owned());
    let appeal = case
        .appeal_reason
        .as_deref()
        .map(|value| format!("<p><strong>Appeal:</strong> {}</p>", escape_html(value)))
        .unwrap_or_default();
    let title = escape_html(&case.content.draft.title);
    let summary = escape_html(&case.content.draft.summary);
    let acknowledged = case
        .acknowledged_by
        .as_deref()
        .map(|value| format!("Acknowledged by {}", escape_html(value)))
        .unwrap_or_else(|| "Not acknowledged".to_owned());
    format!(
        "<article><p class=\"eyebrow\">{} · revision {}</p><h2>{title}</h2><p>{summary}</p><details><summary>Report and review details</summary><p>{evidence}</p>{appeal}<p>Policy: {} · confidence: {}</p></details><p class=\"meta\">{acknowledged}</p><form method=\"post\" action=\"/cases/{}/acknowledge\"><input type=\"hidden\" name=\"csrfToken\" value=\"{csrf}\"><button type=\"submit\">Acknowledge</button></form><form method=\"post\" action=\"/cases/{}/decision\"><input type=\"hidden\" name=\"csrfToken\" value=\"{csrf}\"><label>Decision<select name=\"decision\"><option value=\"approve\">Approve</option><option value=\"reject\">Reject</option><option value=\"keep_visible\">Keep visible</option><option value=\"hide\">Hide</option><option value=\"remove\">Remove</option><option value=\"reinstate\">Reinstate</option></select></label><label>Reason<textarea name=\"reason\" maxlength=\"2000\" required></textarea></label><button type=\"submit\">Save decision</button></form></article>",
        escape_html(&case.source),
        case.revision,
        escape_html(case.triggered_policy.as_deref().unwrap_or("not recorded")),
        case.confidence.map(|value| format!("{value:.2}")).unwrap_or_else(|| "not recorded".to_owned()),
        escape_html(&case.case_id),
        escape_html(&case.case_id),
    )
}

fn logout_form(csrf: &str) -> String {
    format!(
        "<form method=\"post\" action=\"/logout\"><input type=\"hidden\" name=\"csrfToken\" value=\"{}\"><button class=\"quiet\" type=\"submit\">Sign out</button></form>",
        escape_html(csrf)
    )
}

fn escape_html(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

const HTML_START: &str = r#"<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Moderation</title><style>
:root{font:16px system-ui;color-scheme:dark;background:#0b0810;color:#f8f5fb}body{margin:0}main{max-width:760px;margin:0 auto;padding:32px 20px}header{display:flex;justify-content:space-between;gap:20px;align-items:start}h1{font-size:2rem;margin:.2rem 0 1.5rem}h2{margin:.3rem 0}.eyebrow{font-size:.75rem;text-transform:uppercase;letter-spacing:.12em;color:#c9b8d8}.error{color:#ffadad}.empty,article{border:1px solid #403448;border-radius:16px;padding:20px;background:#17111d}article{margin:16px 0}.meta{color:#b9acbf}form{display:grid;gap:12px;margin-top:16px}label{display:grid;gap:6px}input,textarea,select,button{font:inherit;border-radius:10px;border:1px solid #574861;padding:12px;background:#100b14;color:inherit}textarea{min-height:90px;resize:vertical}button{background:#f17a37;color:#160b05;border:0;font-weight:700;cursor:pointer}.quiet{background:#2a2230;color:#fff}details{margin-top:12px}
</style></head><body>"#;
const HTML_END: &str = "</body></html>";

#[derive(Deserialize)]
struct LoginInput {
    password: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CsrfInput {
    csrf_token: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DecisionInput {
    csrf_token: String,
    decision: String,
    reason: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ModerationQueueCase {
    case_id: String,
    public_id: String,
    revision: u64,
    source: String,
    status: String,
    created_at_ms: u64,
    acknowledged_at_ms: Option<u64>,
    acknowledged_by: Option<String>,
    illegal_content_notice: bool,
    reporter_public_id: Option<String>,
    private_evidence: Option<String>,
    appeal_reason: Option<String>,
    model_version: Option<String>,
    rules_version: Option<String>,
    confidence: Option<f32>,
    triggered_policy: Option<String>,
    content: PublicationRecord,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PublicationRecord {
    public_id: String,
    revision: u64,
    owner_public_id: String,
    draft: PublicContentDraft,
    status: String,
    created_at_ms: u64,
    published_at_ms: Option<u64>,
    expires_at_ms: Option<u64>,
    moderation_decision_id: Option<String>,
    wording_suggestion: Option<String>,
    reminder_sent_at_ms: Option<u64>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PublicContentDraft {
    kind: String,
    title: String,
    summary: String,
    roles: Vec<String>,
    categories: Vec<String>,
    languages: Vec<String>,
    coarse_region: Option<String>,
    radius_km: Option<u16>,
    media: Vec<serde_json::Value>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChatReportQueueCase {
    case_id: String,
    reporter_public_id: String,
    peer_public_id: String,
    status: String,
    created_at_ms: u64,
    acknowledged_at_ms: Option<u64>,
    acknowledged_by: Option<String>,
    illegal_content_notice: bool,
    selected_message: SelectedChatMessage,
    reason: String,
    appeal_reason: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SelectedChatMessage {
    room_id: String,
    event_id: String,
    sender_id: String,
    body: String,
    timestamp_ms: u64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::{to_bytes, Body},
        http::{
            header::{CONTENT_TYPE, LOCATION},
            Request,
        },
    };
    use tower::ServiceExt;

    #[test]
    fn only_loopback_may_use_plain_http() {
        assert!(validate_upstream("http://127.0.0.1:8091/").is_ok());
        assert!(validate_upstream("http://localhost:8091/").is_ok());
        assert!(validate_upstream("http://example.com/").is_err());
        assert!(validate_upstream("https://moderation.example.com/").is_ok());
        assert!(validate_upstream("https://example.com/path").is_err());
    }

    #[test]
    fn html_escapes_untrusted_content() {
        assert_eq!(
            escape_html("<script>'\"&"),
            "&lt;script&gt;&#39;&quot;&amp;"
        );
    }

    #[test]
    fn weak_or_wrong_password_verifiers_fail_closed() {
        assert!(validate_password_hash(
            "$argon2id$v=19$m=65536,t=3,p=1$Q2hhbmdlTWU$H5zL0utNfy8WHeO17NrMGfb9cpLwGkGMLOHnS9wmwNc"
        )
        .is_ok());
        assert!(validate_password_hash(
            "$argon2id$v=19$m=4096,t=1,p=1$Q2hhbmdlTWU$H5zL0utNfy8WHeO17NrMGfb9cpLwGkGMLOHnS9wmwNc"
        )
        .is_err());
        assert!(validate_password_hash(
            "$argon2i$v=19$m=65536,t=3,p=1$Q2hhbmdlTWU$H5zL0utNfy8WHeO17NrMGfb9cpLwGkGMLOHnS9wmwNc"
        )
        .is_err());
    }

    #[test]
    fn numeric_loopback_is_canonicalized_before_secure_cookie_login() {
        let mut headers = HeaderMap::new();
        headers.insert(HOST, HeaderValue::from_static("127.0.0.1:8092"));
        assert_eq!(
            canonical_localhost_url(&headers).as_deref(),
            Some("http://localhost:8092/")
        );
        headers.insert(HOST, HeaderValue::from_static("[::1]:8092"));
        assert_eq!(
            canonical_localhost_url(&headers).as_deref(),
            Some("http://localhost:8092/")
        );
        headers.insert(HOST, HeaderValue::from_static("localhost:8092"));
        assert_eq!(canonical_localhost_url(&headers), None);
        headers.insert(HOST, HeaderValue::from_static("example.com:8092"));
        assert_eq!(canonical_localhost_url(&headers), None);
        headers.insert(HOST, HeaderValue::from_static("127.0.0.1:08092"));
        assert_eq!(canonical_localhost_url(&headers), None);
    }

    #[tokio::test]
    async fn browser_is_redirected_then_keeps_one_secure_localhost_session() {
        use argon2::{
            password_hash::{PasswordHasher, SaltString},
            Algorithm, Params, Version,
        };

        let password = "correct horse battery staple";
        let salt = SaltString::encode_b64(b"0123456789abcdef").unwrap();
        let password_hash = Argon2::new(
            Algorithm::Argon2id,
            Version::V0x13,
            Params::new(65_536, 3, 1, None).unwrap(),
        )
        .hash_password(password.as_bytes(), &salt)
        .unwrap()
        .to_string();
        let state = ConsoleState::new(
            "http://127.0.0.1:9/",
            "a".repeat(64),
            password_hash,
            "test-moderator".to_owned(),
        )
        .unwrap();
        let app = router(state);
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/")
                    .header(HOST, "127.0.0.1:8092")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::TEMPORARY_REDIRECT);
        assert_eq!(
            response.headers().get(LOCATION).unwrap(),
            "http://localhost:8092/"
        );

        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/login")
                    .header(HOST, "localhost:8092")
                    .header(CONTENT_TYPE, "application/x-www-form-urlencoded")
                    .body(Body::from(format!(
                        "password={}",
                        password.replace(' ', "+")
                    )))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::SEE_OTHER);
        let set_cookie = response
            .headers()
            .get(SET_COOKIE)
            .unwrap()
            .to_str()
            .unwrap()
            .to_owned();
        assert!(set_cookie.starts_with("__Host-tex8_moderation="));
        assert!(set_cookie.contains("; HttpOnly; Secure; SameSite=Strict;"));
        let cookie = set_cookie.split(';').next().unwrap();

        let response = app
            .oneshot(
                Request::builder()
                    .uri("/")
                    .header(HOST, "localhost:8092")
                    .header(COOKIE, cookie)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), 64 * 1024).await.unwrap();
        let body = String::from_utf8(body.to_vec()).unwrap();
        assert!(body.contains("temporarily unavailable"));
        assert!(!body.contains("Sign in to review"));
    }
}
