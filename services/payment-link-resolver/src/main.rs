use anyhow::{anyhow, Context, Result};
use axum::{
    body::Body,
    extract::{DefaultBodyLimit, Path, State},
    http::{header, HeaderValue, Method, Request, StatusCode},
    middleware::{self, Next},
    response::{Html, IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use chacha20poly1305::{
    aead::{Aead, KeyInit, OsRng},
    XChaCha20Poly1305, XNonce,
};
use rand_core::RngCore;
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    env, fs,
    fs::OpenOptions,
    io::Write,
    net::SocketAddr,
    path::{Path as FilePath, PathBuf},
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::net::TcpListener;
use url::Url;

const DEFAULT_TTL_SECONDS: u64 = 7 * 24 * 60 * 60;
const MAX_TTL_SECONDS: u64 = 30 * 24 * 60 * 60;
const MAX_RECORDS: usize = 100_000;
const MAX_BODY_BYTES: usize = 2 * 1024;
const MAX_URI_BYTES: usize = 1_024;
const DATABASE_VERSION: u32 = 1;
const ANDROID_PACKAGE: &str = "com.tex8.monerowallet";
const APPLE_APP_ID: &str = "F98729Y989.com.tex8.monerowallet";
const ANDROID_RELEASE_SHA256: &str =
    "3F:C2:E6:A6:7A:07:D2:9B:C3:DC:B9:6B:D7:6B:69:86:C2:DB:8C:40:91:D6:0B:76:EB:D5:FE:88:FC:70:23:6E";

#[derive(Clone)]
struct AppState {
    store: Arc<EncryptedPaymentStore>,
    public_origin: String,
    android_install_url: String,
    ios_install_url: String,
    desktop_install_url: String,
    ttl_ms: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct PaymentRecord {
    id: String,
    uri: String,
    created_at: u64,
    expires_at: u64,
}

#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredRecords {
    #[serde(default)]
    payment_requests: Vec<PaymentRecord>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SealedDatabase {
    version: u32,
    nonce: String,
    ciphertext: String,
}

struct EncryptedPaymentStore {
    path: PathBuf,
    cipher: XChaCha20Poly1305,
    records: Mutex<BTreeMap<String, PaymentRecord>>,
}

impl EncryptedPaymentStore {
    fn open(path: impl Into<PathBuf>, key: [u8; 32]) -> Result<Self> {
        let path = path.into();
        let cipher = XChaCha20Poly1305::new((&key).into());
        let stored = if path.exists() {
            read_database(&path, &cipher)?
        } else {
            StoredRecords::default()
        };
        Ok(Self {
            path,
            cipher,
            records: Mutex::new(
                stored
                    .payment_requests
                    .into_iter()
                    .map(|record| (record.id.clone(), record))
                    .collect(),
            ),
        })
    }

    fn create(&self, uri: String, now: u64, ttl_ms: u64) -> Result<PaymentRecord> {
        let mut records = self
            .records
            .lock()
            .map_err(|_| anyhow!("payment store lock poisoned"))?;
        records.retain(|_, record| record.expires_at > now);
        if records.len() >= MAX_RECORDS {
            return Err(anyhow!("payment storage capacity reached"));
        }

        let id = (0..8)
            .find_map(|_| {
                let mut random = [0u8; 16];
                OsRng.fill_bytes(&mut random);
                let candidate = URL_SAFE_NO_PAD.encode(random);
                (!records.contains_key(&candidate)).then_some(candidate)
            })
            .ok_or_else(|| anyhow!("could not allocate payment request id"))?;
        let record = PaymentRecord {
            id: id.clone(),
            uri,
            created_at: now,
            expires_at: now.saturating_add(ttl_ms),
        };
        records.insert(id, record.clone());
        self.persist(&records)?;
        Ok(record)
    }

    fn get(&self, id: &str, now: u64) -> Result<Option<PaymentRecord>> {
        if !valid_request_id(id) {
            return Ok(None);
        }
        let records = self
            .records
            .lock()
            .map_err(|_| anyhow!("payment store lock poisoned"))?;
        Ok(records
            .get(id)
            .filter(|record| record.expires_at > now)
            .cloned())
    }

    fn persist(&self, records: &BTreeMap<String, PaymentRecord>) -> Result<()> {
        let plaintext = serde_json::to_vec(&StoredRecords {
            payment_requests: records.values().cloned().collect(),
        })?;
        let mut nonce = [0u8; 24];
        OsRng.fill_bytes(&mut nonce);
        let ciphertext = self
            .cipher
            .encrypt(XNonce::from_slice(&nonce), plaintext.as_ref())
            .map_err(|_| anyhow!("encrypt payment database"))?;
        let serialized = serde_json::to_vec_pretty(&SealedDatabase {
            version: DATABASE_VERSION,
            nonce: URL_SAFE_NO_PAD.encode(nonce),
            ciphertext: URL_SAFE_NO_PAD.encode(ciphertext),
        })?;
        atomic_replace(&self.path, &serialized)
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CreatePaymentRequest {
    uri: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PaymentResponse {
    id: String,
    url: String,
    uri: String,
    expires_at: u64,
}

#[derive(Serialize)]
struct HealthResponse {
    ok: bool,
}

#[derive(Serialize)]
struct ErrorResponse {
    error: &'static str,
}

#[derive(Debug)]
enum ApiError {
    BadRequest,
    NotFound,
    Capacity,
    Internal,
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, error) = match self {
            Self::BadRequest => (StatusCode::BAD_REQUEST, "invalid payment request"),
            Self::NotFound => (
                StatusCode::NOT_FOUND,
                "payment request not found or expired",
            ),
            Self::Capacity => (
                StatusCode::SERVICE_UNAVAILABLE,
                "payment request service is full",
            ),
            Self::Internal => (StatusCode::INTERNAL_SERVER_ERROR, "internal service error"),
        };
        (status, Json(ErrorResponse { error })).into_response()
    }
}

fn app(state: AppState) -> Router {
    Router::new()
        .route("/healthz", get(healthz))
        .route("/v1/payment-requests", post(create_payment_request))
        .route("/v1/payment-requests/{id}", get(resolve_payment_request))
        .route("/pay/{id}", get(payment_page))
        .route("/.well-known/assetlinks.json", get(android_asset_links))
        .route(
            "/.well-known/apple-app-site-association",
            get(apple_app_site_association),
        )
        .layer(DefaultBodyLimit::max(MAX_BODY_BYTES))
        .layer(middleware::from_fn(response_headers))
        .with_state(state)
}

#[tokio::main]
async fn main() -> Result<()> {
    let bind: SocketAddr = env::var("PAYMENT_LINK_BIND")
        .unwrap_or_else(|_| "127.0.0.1:8098".to_owned())
        .parse()
        .context("parse PAYMENT_LINK_BIND")?;
    let database_path =
        env::var("PAYMENT_LINK_DB").unwrap_or_else(|_| "./payment-links.json.enc".to_owned());
    let key = parse_key(
        &env::var("PAYMENT_LINK_STORAGE_KEY")
            .context("PAYMENT_LINK_STORAGE_KEY must be a 32-byte hex or base64url key")?,
    )?;
    let public_origin = https_origin(
        &env::var("PAYMENT_LINK_PUBLIC_ORIGIN")
            .unwrap_or_else(|_| "https://xmr.tex8.com".to_owned()),
    )?;
    let android_install_url = https_url(
        &env::var("PAYMENT_LINK_ANDROID_INSTALL_URL")
            .unwrap_or_else(|_| "https://tex8.com/xmr/".to_owned()),
    )?;
    let ios_install_url = https_url(
        &env::var("PAYMENT_LINK_IOS_INSTALL_URL").unwrap_or_else(|_| {
            "https://github.com/tex8com/monero-fast-wallet/releases".to_owned()
        }),
    )?;
    let desktop_install_url = https_url(
        &env::var("PAYMENT_LINK_DESKTOP_INSTALL_URL").unwrap_or_else(|_| {
            "https://github.com/tex8com/monero-fast-wallet/releases".to_owned()
        }),
    )?;
    let ttl_seconds = env::var("PAYMENT_LINK_TTL_SECONDS")
        .ok()
        .map(|value| value.parse::<u64>())
        .transpose()
        .context("parse PAYMENT_LINK_TTL_SECONDS")?
        .unwrap_or(DEFAULT_TTL_SECONDS)
        .clamp(60, MAX_TTL_SECONDS);
    let state = AppState {
        store: Arc::new(EncryptedPaymentStore::open(database_path, key)?),
        public_origin,
        android_install_url,
        ios_install_url,
        desktop_install_url,
        ttl_ms: ttl_seconds.saturating_mul(1_000),
    };
    let listener = TcpListener::bind(bind).await?;
    eprintln!("payment-link-resolver listening on {bind}");
    axum::serve(listener, app(state))
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    Ok(())
}

async fn healthz() -> Json<HealthResponse> {
    Json(HealthResponse { ok: true })
}

async fn create_payment_request(
    State(state): State<AppState>,
    Json(input): Json<CreatePaymentRequest>,
) -> Result<(StatusCode, Json<PaymentResponse>), ApiError> {
    let uri = canonical_payment_uri(&input.uri).ok_or(ApiError::BadRequest)?;
    let record = state
        .store
        .create(uri, now_ms(), state.ttl_ms)
        .map_err(|error| {
            if error.to_string().contains("capacity") {
                ApiError::Capacity
            } else {
                eprintln!("payment-link create failed: {error:#}");
                ApiError::Internal
            }
        })?;
    Ok((StatusCode::CREATED, Json(payment_response(&state, record))))
}

async fn resolve_payment_request(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<PaymentResponse>, ApiError> {
    let record = state
        .store
        .get(&id, now_ms())
        .map_err(|error| {
            eprintln!("payment-link resolve failed: {error:#}");
            ApiError::Internal
        })?
        .ok_or(ApiError::NotFound)?;
    Ok(Json(payment_response(&state, record)))
}

async fn payment_page(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Html<String>, ApiError> {
    let record = state
        .store
        .get(&id, now_ms())
        .map_err(|error| {
            eprintln!("payment-link page failed: {error:#}");
            ApiError::Internal
        })?
        .ok_or(ApiError::NotFound)?;
    let parsed = parse_payment_uri(&record.uri).ok_or(ApiError::Internal)?;
    Ok(Html(payment_html(&state, &record, &parsed)))
}

async fn android_asset_links() -> Json<serde_json::Value> {
    Json(serde_json::json!([{
        "relation": ["delegate_permission/common.handle_all_urls"],
        "target": {
            "namespace": "android_app",
            "package_name": ANDROID_PACKAGE,
            "sha256_cert_fingerprints": [ANDROID_RELEASE_SHA256]
        }
    }]))
}

async fn apple_app_site_association() -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "applinks": {
            "details": [{
                "appIDs": [APPLE_APP_ID],
                "components": [{ "/": "/pay/*", "comment": "Monero payment links" }]
            }]
        }
    }))
}

async fn response_headers(request: Request<Body>, next: Next) -> Response {
    if request.method() == Method::OPTIONS {
        let mut response = StatusCode::NO_CONTENT.into_response();
        add_public_headers(response.headers_mut());
        return response;
    }
    let mut response = next.run(request).await;
    add_public_headers(response.headers_mut());
    response
}

fn add_public_headers(headers: &mut axum::http::HeaderMap) {
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_ORIGIN,
        HeaderValue::from_static("*"),
    );
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_METHODS,
        HeaderValue::from_static("GET, POST, OPTIONS"),
    );
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_HEADERS,
        HeaderValue::from_static("content-type"),
    );
    headers.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(
            "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        ),
    );
}

fn payment_response(state: &AppState, record: PaymentRecord) -> PaymentResponse {
    PaymentResponse {
        url: format!("{}/pay/{}", state.public_origin, record.id),
        id: record.id,
        uri: record.uri,
        expires_at: record.expires_at,
    }
}

#[derive(Debug, PartialEq, Eq)]
struct ParsedPaymentUri {
    address: String,
    amount: Option<String>,
    recipient_name: Option<String>,
    description: Option<String>,
}

fn canonical_payment_uri(input: &str) -> Option<String> {
    let parsed = parse_payment_uri(input)?;
    let mut query = Vec::new();
    if let Some(amount) = parsed.amount {
        query.push(format!("tx_amount={}", encode_query(&amount)));
    }
    if let Some(name) = parsed.recipient_name {
        query.push(format!("recipient_name={}", encode_query(&name)));
    }
    if let Some(description) = parsed.description {
        query.push(format!("tx_description={}", encode_query(&description)));
    }
    Some(format!(
        "monero:{}{}",
        parsed.address,
        if query.is_empty() {
            String::new()
        } else {
            format!("?{}", query.join("&"))
        }
    ))
}

fn parse_payment_uri(input: &str) -> Option<ParsedPaymentUri> {
    let raw = input.trim();
    if raw.len() > MAX_URI_BYTES || !raw.starts_with("monero:") || raw.contains('#') {
        return None;
    }
    let parsed = Url::parse(raw).ok()?;
    if parsed.scheme() != "monero" || !parsed.cannot_be_a_base() {
        return None;
    }
    let address = parsed.path().to_owned();
    if !matches!(address.len(), 95 | 106)
        || !address.bytes().all(|byte| {
            matches!(byte,
                b'1'..=b'9' | b'A'..=b'H' | b'J'..=b'N' | b'P'..=b'Z' |
                b'a'..=b'k' | b'm'..=b'z')
        })
    {
        return None;
    }

    let mut result = ParsedPaymentUri {
        address,
        amount: None,
        recipient_name: None,
        description: None,
    };
    for (key, value) in parsed.query_pairs() {
        let value = value.into_owned();
        match key.as_ref() {
            "tx_amount" if result.amount.is_none() && valid_amount(&value) => {
                result.amount = Some(value)
            }
            "recipient_name"
                if result.recipient_name.is_none()
                    && !value.trim().is_empty()
                    && !value.chars().any(char::is_control)
                    && value.chars().count() <= 80 =>
            {
                result.recipient_name = Some(value.trim().to_owned())
            }
            "tx_description"
                if result.description.is_none()
                    && !value.trim().is_empty()
                    && !value.chars().any(char::is_control)
                    && value.chars().count() <= 120 =>
            {
                result.description = Some(value.trim().to_owned())
            }
            _ => return None,
        }
    }
    Some(result)
}

fn valid_amount(value: &str) -> bool {
    let mut parts = value.split('.');
    let whole = parts.next().unwrap_or_default();
    let fraction = parts.next();
    if whole.is_empty()
        || whole.len() > 20
        || !whole.bytes().all(|byte| byte.is_ascii_digit())
        || fraction.is_some_and(|digits| {
            digits.is_empty()
                || digits.len() > 12
                || !digits.bytes().all(|byte| byte.is_ascii_digit())
        })
        || parts.next().is_some()
    {
        return false;
    }

    let whole_atomic = whole
        .parse::<u64>()
        .ok()
        .and_then(|amount| amount.checked_mul(1_000_000_000_000));
    let fraction_atomic = fraction
        .unwrap_or_default()
        .parse::<u64>()
        .unwrap_or_default()
        .checked_mul(10u64.pow(12 - fraction.map(str::len).unwrap_or_default() as u32));
    whole_atomic
        .zip(fraction_atomic)
        .and_then(|(whole, fraction)| whole.checked_add(fraction))
        .is_some_and(|atomic| atomic > 0)
}

fn valid_request_id(value: &str) -> bool {
    value.len() == 22
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn encode_query(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        if byte.is_ascii_alphanumeric()
            || matches!(
                byte,
                b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')'
            )
        {
            encoded.push(char::from(*byte));
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

fn payment_html(state: &AppState, record: &PaymentRecord, parsed: &ParsedPaymentUri) -> String {
    let amount = parsed
        .amount
        .as_deref()
        .unwrap_or("Amount chosen in wallet");
    let note = parsed.description.as_deref().unwrap_or("No payment note");
    let short_address = format!(
        "{}…{}",
        &parsed.address[..10],
        &parsed.address[parsed.address.len() - 8..]
    );
    let request_url = format!("{}/pay/{}", state.public_origin, record.id);
    let android_install_url = android_install_url(&state.android_install_url, &record.id);
    format!(
        r##"<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <meta name="theme-color" content="#090711">
  <meta name="robots" content="noindex,nofollow,noarchive">
  <title>Monero payment request</title>
  <style>
    :root {{ color-scheme: dark; --orange:#ff6b21; --panel:#151121; --line:#372b48; --muted:#b8afc4; }}
    * {{ box-sizing:border-box }} body {{ margin:0; min-height:100vh; display:grid; place-items:center; padding:24px; background:radial-gradient(circle at 50% 0,#28183d 0,#090711 48%); color:#faf7ff; font-family:Inter,ui-sans-serif,system-ui,-apple-system,sans-serif }}
    main {{ width:min(100%,520px); padding:30px; border:1px solid var(--line); border-radius:24px; background:rgba(21,17,33,.96); box-shadow:0 24px 80px #0009 }}
    .logo {{ width:58px;height:58px;display:grid;place-items:center;border-radius:17px;background:linear-gradient(145deg,#ff7c24,#e94d00);font-size:28px;font-weight:900 }}
    .eyebrow {{ margin:22px 0 7px;color:#ff9a5c;font-size:12px;font-weight:850;letter-spacing:.1em;text-transform:uppercase }}
    h1 {{ margin:0 0 22px;font-size:clamp(28px,8vw,40px);line-height:1.05 }}
    dl {{ margin:0;display:grid;gap:12px }} .row {{ padding:14px 16px;border:1px solid var(--line);border-radius:14px;background:#0e0b17 }}
    dt {{ color:var(--muted);font-size:12px;font-weight:750 }} dd {{ margin:4px 0 0;font-size:17px;font-weight:750;overflow-wrap:anywhere }}
    .actions {{ display:grid;gap:11px;margin-top:22px }} a {{ min-height:52px;display:flex;align-items:center;justify-content:center;border-radius:14px;color:white;font-weight:850;text-decoration:none }}
    .open {{ background:linear-gradient(135deg,#ff741d,#e84d00) }} .install {{ border:1px solid #50405f;background:#211a2c }}
    .hint {{ margin:18px 0 0;color:var(--muted);font-size:13px;line-height:1.55 }} .privacy {{ color:#8f849b;font-size:11px }}
  </style>
</head>
<body>
  <main>
    <div class="logo" aria-hidden="true">M</div>
    <p class="eyebrow">Monero Fast Wallet</p>
    <h1>Payment request</h1>
    <dl>
      <div class="row"><dt>Amount</dt><dd>{amount} {currency}</dd></div>
      <div class="row"><dt>Address</dt><dd>{address}</dd></div>
      <div class="row"><dt>Note</dt><dd>{note}</dd></div>
    </dl>
    <div class="actions">
      <a class="open" id="open-wallet" href="{uri}">Open wallet</a>
      <a class="install" data-install href="{android}">Install on Android</a>
      <a class="install" data-install href="{ios}">Install on iPhone / iPad</a>
      <a class="install" data-install href="{desktop}">Install on computer</a>
    </div>
    <p class="hint">The wallet fills in the address and amount. You still review and confirm the payment yourself.</p>
    <p class="privacy">This link expires automatically. Never enter a seed, private key, wallet password or Ledger secret on a website.</p>
  </main>
  <script>
    (() => {{
      const key = 'mfw.pendingPaymentLink.v1';
      const waiting = 'mfw.paymentInstallerReturn.v1';
      const request = {request_json};
      const uri = {uri_json};
      document.querySelectorAll('[data-install]').forEach((link) => link.addEventListener('click', () => {{
        try {{ localStorage.setItem(key, request); sessionStorage.setItem(waiting, String(Date.now())); }} catch (_) {{}}
      }}));
      let lastAttempt = 0;
      const resume = () => {{
        let started = 0;
        try {{ started = Number(sessionStorage.getItem(waiting) || 0); }} catch (_) {{}}
        if (!started || Date.now() - started < 1500 || Date.now() - lastAttempt < 2500) return;
        lastAttempt = Date.now();
        window.location.href = uri;
      }};
      window.addEventListener('focus', resume);
      window.addEventListener('pageshow', resume);
      document.addEventListener('visibilitychange', () => {{ if (!document.hidden) resume(); }});
      document.getElementById('open-wallet').addEventListener('click', () => {{
        try {{ localStorage.removeItem(key); sessionStorage.removeItem(waiting); }} catch (_) {{}}
      }});
    }})();
  </script>
</body>
</html>"##,
        amount = html_escape(amount),
        currency = if parsed.amount.is_some() { "XMR" } else { "" },
        address = html_escape(&short_address),
        note = html_escape(note),
        uri = html_escape(&record.uri),
        android = html_escape(&android_install_url),
        ios = html_escape(&state.ios_install_url),
        desktop = html_escape(&state.desktop_install_url),
        request_json = serde_json::to_string(&request_url).unwrap_or_else(|_| "\"\"".to_owned()),
        uri_json = serde_json::to_string(&record.uri).unwrap_or_else(|_| "\"\"".to_owned()),
    )
}

fn android_install_url(base: &str, request_id: &str) -> String {
    let Ok(mut url) = Url::parse(base) else {
        return base.to_owned();
    };
    if url.host_str() == Some("play.google.com") && valid_request_id(request_id) {
        url.query_pairs_mut()
            .append_pair("referrer", &format!("payment_request_id={request_id}"));
    }
    url.into()
}

fn html_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

fn parse_key(value: &str) -> Result<[u8; 32]> {
    let trimmed = value.trim();
    let decoded = if trimmed.len() == 64 && trimmed.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        hex::decode(trimmed)?
    } else {
        URL_SAFE_NO_PAD.decode(trimmed)?
    };
    decoded
        .try_into()
        .map_err(|_| anyhow!("storage key must decode to exactly 32 bytes"))
}

fn read_database(path: &FilePath, cipher: &XChaCha20Poly1305) -> Result<StoredRecords> {
    let sealed: SealedDatabase = serde_json::from_slice(
        &fs::read(path).with_context(|| format!("read payment database {}", path.display()))?,
    )?;
    if sealed.version != DATABASE_VERSION {
        return Err(anyhow!("unsupported payment database version"));
    }
    let nonce = URL_SAFE_NO_PAD.decode(sealed.nonce)?;
    let ciphertext = URL_SAFE_NO_PAD.decode(sealed.ciphertext)?;
    let plaintext = cipher
        .decrypt(XNonce::from_slice(&nonce), ciphertext.as_ref())
        .map_err(|_| anyhow!("decrypt payment database"))?;
    Ok(serde_json::from_slice(&plaintext)?)
}

fn atomic_replace(path: &FilePath, contents: &[u8]) -> Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| anyhow!("payment database path has no parent"))?;
    fs::create_dir_all(parent)?;
    let mut random = [0u8; 8];
    OsRng.fill_bytes(&mut random);
    let temporary = parent.join(format!(".payment-links-{}.tmp", hex::encode(random)));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temporary)?;
    file.write_all(contents)?;
    file.sync_all()?;
    drop(file);
    let result = fs::rename(&temporary, path);
    if result.is_err() && temporary.exists() {
        let _ = fs::remove_file(&temporary);
    }
    result?;
    Ok(())
}

fn https_origin(value: &str) -> Result<String> {
    let url = Url::parse(value)?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || url.username() != ""
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
    {
        return Err(anyhow!("public origin must be an exact HTTPS origin"));
    }
    Ok(value.trim_end_matches('/').to_owned())
}

fn https_url(value: &str) -> Result<String> {
    let url = Url::parse(value)?;
    if url.scheme() != "https" || url.host_str().is_none() || value.len() > 500 {
        return Err(anyhow!("install URL must use HTTPS"));
    }
    Ok(value.to_owned())
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::to_bytes;
    use axum::http::Request;
    use tower::ServiceExt;

    fn address() -> String {
        format!("4{}", "1".repeat(94))
    }

    fn test_state(path: PathBuf) -> AppState {
        AppState {
            store: Arc::new(EncryptedPaymentStore::open(path, [7u8; 32]).unwrap()),
            public_origin: "https://xmr.tex8.com".to_owned(),
            android_install_url: "https://tex8.com/xmr/".to_owned(),
            ios_install_url: "https://example.com/ios".to_owned(),
            desktop_install_url: "https://example.com/desktop".to_owned(),
            ttl_ms: 60_000,
        }
    }

    #[test]
    fn canonicalizes_and_bounds_monero_payment_uris() {
        let uri = format!(
            "monero:{}?tx_description=Invoice%20%26%201&tx_amount=1.230000000001",
            address()
        );
        let canonical = canonical_payment_uri(&uri).unwrap();
        assert_eq!(
            canonical,
            format!(
                "monero:{}?tx_amount=1.230000000001&tx_description=Invoice%20%26%201",
                address()
            )
        );
        assert!(
            canonical_payment_uri(&format!("monero:{}?tx_amount=1.0000000000001", address()))
                .is_none()
        );
        assert!(canonical_payment_uri(&format!("monero:{}?tx_amount=0", address())).is_none());
        assert!(canonical_payment_uri(&format!(
            "monero:{}?tx_amount=18446744.073709551616",
            address()
        ))
        .is_none());
        assert!(canonical_payment_uri(&format!(
            "monero:{}?tx_amount=18446744.073709551615",
            address()
        ))
        .is_some());
        assert!(canonical_payment_uri(&format!("monero:{}?tx_amount=1", "4".repeat(94))).is_none());
        assert!(canonical_payment_uri(&format!("monero:{}?unknown=x", address())).is_none());
        assert!(
            canonical_payment_uri(&format!("monero:{}?recipient_name=Alice%0ABob", address()))
                .is_none()
        );
        assert!(canonical_payment_uri("https://example.com").is_none());
    }

    #[test]
    fn adds_only_the_opaque_id_to_google_play_install_referrer() {
        let id = "AbCdEfGhIjKlMnOpQrStUv";
        assert_eq!(
            android_install_url(
                "https://play.google.com/store/apps/details?id=com.tex8.monerowallet",
                id,
            ),
            "https://play.google.com/store/apps/details?id=com.tex8.monerowallet&referrer=payment_request_id%3DAbCdEfGhIjKlMnOpQrStUv"
        );
        assert_eq!(
            android_install_url("https://tex8.com/xmr/", id),
            "https://tex8.com/xmr/"
        );
    }

    #[test]
    fn encrypted_store_persists_without_plaintext_payment_details() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("payments.enc");
        let uri = format!(
            "monero:{}?tx_amount=2.5&tx_description=Private+order",
            address()
        );
        let store = EncryptedPaymentStore::open(&path, [9u8; 32]).unwrap();
        let created = store.create(uri.clone(), 100, 1_000).unwrap();
        let raw = String::from_utf8_lossy(&fs::read(&path).unwrap()).to_string();
        assert!(!raw.contains(&address()));
        assert!(!raw.contains("Private order"));

        let reopened = EncryptedPaymentStore::open(&path, [9u8; 32]).unwrap();
        assert_eq!(reopened.get(&created.id, 101).unwrap().unwrap().uri, uri);
        assert!(reopened.get(&created.id, 1_100).unwrap().is_none());
    }

    #[tokio::test]
    async fn creates_resolves_and_renders_payment_request() {
        let directory = tempfile::tempdir().unwrap();
        let state = test_state(directory.path().join("payments.enc"));
        let service = app(state);
        let uri = format!("monero:{}?tx_amount=0.25&tx_description=Coffee", address());
        let response = service
            .clone()
            .oneshot(
                Request::post("/v1/payment-requests")
                    .header("content-type", "application/json")
                    .body(Body::from(serde_json::json!({ "uri": uri }).to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::CREATED);
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let created: PaymentResponse = serde_json::from_slice(&body).unwrap();
        assert!(created.url.starts_with("https://xmr.tex8.com/pay/"));

        let resolved = service
            .clone()
            .oneshot(
                Request::get(format!("/v1/payment-requests/{}", created.id))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resolved.status(), StatusCode::OK);

        let page = service
            .oneshot(
                Request::get(format!("/pay/{}", created.id))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let html = String::from_utf8(
            to_bytes(page.into_body(), usize::MAX)
                .await
                .unwrap()
                .to_vec(),
        )
        .unwrap();
        assert!(html.contains("0.25 XMR"));
        assert!(html.contains("Coffee"));
        assert!(html.contains("mfw.pendingPaymentLink.v1"));
        assert!(html.contains("You still review and confirm"));
    }

    #[tokio::test]
    async fn publishes_mobile_association_contracts() {
        let directory = tempfile::tempdir().unwrap();
        let service = app(test_state(directory.path().join("payments.enc")));
        let android = service
            .clone()
            .oneshot(
                Request::get("/.well-known/assetlinks.json")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let body = to_bytes(android.into_body(), usize::MAX).await.unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json[0]["target"]["package_name"], ANDROID_PACKAGE);
        assert_eq!(
            json[0]["target"]["sha256_cert_fingerprints"][0],
            ANDROID_RELEASE_SHA256
        );

        let apple = service
            .oneshot(
                Request::get("/.well-known/apple-app-site-association")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let body = to_bytes(apple.into_body(), usize::MAX).await.unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json["applinks"]["details"][0]["appIDs"][0], APPLE_APP_ID);
    }
}
