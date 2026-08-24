mod config;
mod database;
mod notification;
mod payment;
mod pricing;

use std::{collections::HashSet, sync::Arc, time::Duration};

use axum::{
    extract::{DefaultBodyLimit, Form, Path, State},
    http::{
        header::{
            AUTHORIZATION, CACHE_CONTROL, CONTENT_SECURITY_POLICY, CONTENT_TYPE, REFERRER_POLICY,
            X_CONTENT_TYPE_OPTIONS, X_FRAME_OPTIONS,
        },
        HeaderValue, StatusCode,
    },
    response::{Html, IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use curve25519_dalek::{constants::ED25519_BASEPOINT_POINT, scalar::Scalar};
use database::{ActiveCandidate, Database, JobRecord, NewOrder, OrderRecord, SearchGroupRecord};
use mfw_recipient_protocol::{AddressKind, PublicAddress};
use monero_address::{AddressType as MoneroAddressType, MoneroAddress, Network};
use notification::{GatewayNotificationBackend, NotificationBackend};
use payment::{PaymentBackend, WalletRpcPaymentBackend};
use pricing::{
    format_xmr, PricingCatalog, LIMITED_SEARCH_PREFIX_LENGTH, LIMITED_SEARCH_SECONDS,
    MAX_PRICED_PREFIX_LENGTH,
};
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

const MAX_PREFIX_CHARS: usize = MAX_PRICED_PREFIX_LENGTH;
const MAX_ONION_PREFIX_CHARS: usize = 24;
const MAX_PREFIXES_PER_ORDER: usize = 100;
const MONERO_BASE58: &str = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const ONION_BASE32: &str = "abcdefghijklmnopqrstuvwxyz234567";

pub fn router() -> Router {
    let state = AppState {
        database: Database::in_memory().expect("create preview database"),
        pricing: PricingCatalog::fixed(),
        payment: None,
        quote_ttl: Duration::from_secs(1800),
        required_confirmations: 10,
        worker_auth_hash: None,
        notification: None,
    };
    router_with_state(state)
}

pub async fn configured_router() -> anyhow::Result<Router> {
    let config = config::ServiceConfig::from_env()?;
    let database = Database::open(&config.database_path)?;
    let payment = Arc::new(WalletRpcPaymentBackend::connect(&config.payment).await?);
    let notification = config
        .notification
        .as_ref()
        .map(GatewayNotificationBackend::connect)
        .transpose()?
        .map(|backend| Arc::new(backend) as Arc<dyn NotificationBackend>);
    let state = AppState {
        database,
        pricing: config.pricing,
        payment: Some(payment),
        quote_ttl: config.quote_ttl,
        required_confirmations: config.required_confirmations,
        worker_auth_hash: config.worker_auth_hash,
        notification,
    };
    tokio::spawn(payment_monitor(state.clone(), config.payment_poll_interval));
    Ok(router_with_state(state))
}

#[derive(Clone)]
struct AppState {
    database: Database,
    pricing: PricingCatalog,
    payment: Option<Arc<dyn PaymentBackend>>,
    quote_ttl: Duration,
    required_confirmations: u64,
    worker_auth_hash: Option<[u8; 32]>,
    notification: Option<Arc<dyn NotificationBackend>>,
}

fn router_with_state(state: AppState) -> Router {
    Router::new()
        .route("/", get(index))
        .route("/healthz", get(healthz))
        .route("/v1/orders", post(prepare_order))
        .route("/api/v1/quotes", post(create_quote))
        .route("/api/v1/orders/{id}", get(get_order))
        .route("/api/v1/internal/pool", get(get_active_pool))
        .route(
            "/api/v1/internal/candidates/{id}/complete",
            post(complete_candidate),
        )
        .fallback(not_found)
        .layer(DefaultBodyLimit::max(8 * 1024))
        .with_state(state)
}

#[derive(Serialize)]
struct ActivePoolResponse {
    version: u8,
    active_prefix_slots: usize,
    maximum_prefix_slots: usize,
    candidates: Vec<ActiveCandidate>,
}

async fn get_active_pool(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
) -> Result<Response, ApiError> {
    require_worker_auth(&state, &headers)?;
    state
        .database
        .activate_queued_groups(now_epoch_seconds(), pricing::MAX_ACTIVE_PREFIX_SLOTS)
        .map_err(ApiError::internal)?;
    let candidates = state
        .database
        .active_candidates()
        .map_err(ApiError::internal)?;
    Ok(api_json(ActivePoolResponse {
        version: 1,
        active_prefix_slots: candidates.len(),
        maximum_prefix_slots: pricing::MAX_ACTIVE_PREFIX_SLOTS,
        candidates,
    }))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CompleteCandidateRequest {
    result_address: String,
    result_key_offset: String,
}

async fn complete_candidate(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: axum::http::HeaderMap,
    Json(input): Json<CompleteCandidateRequest>,
) -> Result<Response, ApiError> {
    require_worker_auth(&state, &headers)?;
    let source_address = state
        .database
        .active_candidates()
        .map_err(ApiError::internal)?
        .into_iter()
        .find(|candidate| candidate.id == id)
        .map(|candidate| candidate.public_address)
        .ok_or_else(|| ApiError::not_found("Not found."))?;
    if !valid_split_key_result(
        &source_address,
        &input.result_address,
        &input.result_key_offset,
    ) {
        return Err(ApiError::bad_request("The Vanity result is invalid."));
    }
    state
        .database
        .complete_candidate(
            &id,
            &input.result_address,
            &input.result_key_offset,
            now_epoch_seconds(),
        )
        .map_err(ApiError::internal)?;
    Ok(api_json(serde_json::json!({"accepted": true})))
}

fn require_worker_auth(state: &AppState, headers: &axum::http::HeaderMap) -> Result<(), ApiError> {
    let expected = state
        .worker_auth_hash
        .ok_or_else(|| ApiError::unavailable("The Vanity worker interface is not configured."))?;
    let supplied = headers
        .get("x-mfw-vanity-worker-auth")
        .and_then(|value| value.to_str().ok())
        .filter(|value| value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .ok_or_else(|| ApiError::not_found("Not found."))?;
    let supplied_hash: [u8; 32] = Sha256::digest(supplied.to_ascii_lowercase().as_bytes()).into();
    if !bool::from(supplied_hash.ct_eq(&expected)) {
        return Err(ApiError::not_found("Not found."));
    }
    Ok(())
}

async fn index() -> Response {
    secure_html(index_page())
}

async fn healthz() -> Response {
    let mut response = (StatusCode::OK, "ok\n").into_response();
    secure_headers(response.headers_mut());
    response
}

async fn not_found() -> Response {
    secure_html_with_status(
        StatusCode::NOT_FOUND,
        message_page("Not found", "This page does not exist."),
    )
}

#[derive(Deserialize)]
struct OrderInput {
    kind: String,
    prefix: String,
    public_address: Option<String>,
}

async fn prepare_order(State(state): State<AppState>, Form(input): Form<OrderInput>) -> Response {
    let prefix = input.prefix.trim();
    let maximum_length = if input.kind == "onion" {
        MAX_ONION_PREFIX_CHARS
    } else {
        MAX_PREFIX_CHARS
    };
    if prefix != input.prefix || prefix.is_empty() || prefix.chars().count() > maximum_length {
        let range_message = if input.kind == "onion" {
            "Use 1 to 24 valid characters, without spaces."
        } else {
            "Use 2 to 10 valid characters, without spaces."
        };
        return secure_html_with_status(
            StatusCode::BAD_REQUEST,
            message_page("Check the prefix", range_message),
        );
    }

    match input.kind.as_str() {
        "monero" if valid_monero_prefix(prefix) && valid_monero_primary_address(input.public_address.as_deref()) => {
            match create_order_record(
                &state,
                input.public_address.expect("validated public address"),
                vec![prefix.to_owned()],
                None,
            )
            .await
            {
                Ok(created) => secure_html(payment_page(&created.record, &created.status_token)),
                Err(error) => secure_html_with_status(
                    error.status,
                    message_page("Order unavailable", &escape_html(&error.public_message)),
                ),
            }
        }
        "monero" => secure_html_with_status(
            StatusCode::BAD_REQUEST,
            message_page("Check the Monero data", "Use a standard 95-character Monero mainnet primary address and a valid Monero Base58 prefix. Never enter a seed or private key."),
        ),
        "onion" if valid_onion_prefix(prefix) => secure_html(prepared_page(
            "Onion v3",
            prefix,
            "The Tor v3 prefix passed validation. For a trustless flow, the Onion key is generated only on your CLI or desktop device.",
            "A server worker must not deliver a private Onion key. This interface therefore prepares only local search and estimation.",
        )),
        "onion" => secure_html_with_status(
            StatusCode::BAD_REQUEST,
            message_page("Check the Onion prefix", "Use only lowercase a–z and digits 2–7, without .onion."),
        ),
        _ => secure_html_with_status(
            StatusCode::BAD_REQUEST,
            message_page("Invalid request", "The requested vanity type is not supported."),
        ),
    }
}

#[derive(Deserialize)]
struct QuoteRequest {
    version: u8,
    kind: String,
    network: String,
    public_address: String,
    prefixes: Vec<String>,
    notification: Option<NotificationTarget>,
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct NotificationTarget {
    installation_id: String,
    platform: String,
}

#[derive(Serialize)]
struct OrderResponse {
    version: u8,
    #[serde(skip_serializing_if = "Option::is_none")]
    status_token: Option<String>,
    status_deep_link: String,
    order: OrderView,
}

#[derive(Serialize)]
struct OrderView {
    id: String,
    status: String,
    network: String,
    public_address: String,
    prefixes: Vec<String>,
    price_atomic: String,
    price_xmr: String,
    list_price_atomic: String,
    discount_atomic: String,
    discount_xmr: String,
    payment_id: String,
    payment_address: String,
    created_at: i64,
    quote_expires_at: i64,
    required_confirmations: u64,
    observed_atomic: String,
    payment_txid: Option<String>,
    payment_height: Option<u64>,
    confirmations: u64,
    paid_at: Option<i64>,
    updated_at: i64,
    jobs: Vec<JobRecord>,
    search_groups: Vec<SearchGroupRecord>,
    active_prefix_slots: usize,
    maximum_prefix_slots: usize,
    contains_limited_search: bool,
    limited_search_seconds: Option<u64>,
    result_guaranteed: bool,
    non_refundable_after_start: bool,
}

impl OrderView {
    fn from_record(
        order: OrderRecord,
        jobs: Vec<JobRecord>,
        search_groups: Vec<SearchGroupRecord>,
        active_prefix_slots: usize,
    ) -> Self {
        let contains_limited_search = order
            .prefixes
            .iter()
            .any(|prefix| prefix.chars().count() == LIMITED_SEARCH_PREFIX_LENGTH);
        Self {
            id: order.id,
            status: order.status,
            network: order.network,
            public_address: order.public_address,
            prefixes: order.prefixes,
            price_atomic: order.price_atomic.to_string(),
            price_xmr: format_xmr(order.price_atomic),
            list_price_atomic: order.list_price_atomic.to_string(),
            discount_atomic: order.discount_atomic.to_string(),
            discount_xmr: format_xmr(order.discount_atomic),
            payment_id: order.payment_id,
            payment_address: order.payment_address,
            created_at: order.created_at,
            quote_expires_at: order.quote_expires_at,
            required_confirmations: order.required_confirmations,
            observed_atomic: order.observed_atomic.to_string(),
            payment_txid: order.payment_txid,
            payment_height: order.payment_height,
            confirmations: order.confirmations,
            paid_at: order.paid_at,
            updated_at: order.updated_at,
            contains_limited_search,
            limited_search_seconds: contains_limited_search.then_some(LIMITED_SEARCH_SECONDS),
            result_guaranteed: !contains_limited_search,
            non_refundable_after_start: contains_limited_search,
            jobs,
            search_groups,
            active_prefix_slots,
            maximum_prefix_slots: pricing::MAX_ACTIVE_PREFIX_SLOTS,
        }
    }
}

struct CreatedOrder {
    record: OrderRecord,
    status_token: String,
}

async fn create_quote(
    State(state): State<AppState>,
    Json(input): Json<QuoteRequest>,
) -> Result<Response, ApiError> {
    if input.version != 1 || input.kind != "monero" || input.network != "mainnet" {
        return Err(ApiError::bad_request(
            "Only Monero mainnet quote version 1 is supported.",
        ));
    }
    let created = create_order_record(
        &state,
        input.public_address,
        input.prefixes,
        input.notification,
    )
    .await?;
    Ok(api_json(order_response(
        &state,
        created.record,
        Some(created.status_token),
    )?))
}

async fn get_order(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: axum::http::HeaderMap,
) -> Result<Response, ApiError> {
    state
        .database
        .expire_quotes(now_epoch_seconds())
        .map_err(ApiError::internal)?;
    let status_token = bearer_token(&headers)?;
    let token_hash = hash_status_token(status_token);
    let order = state
        .database
        .get_authorized_order(&id, &token_hash)
        .map_err(ApiError::internal)?
        .ok_or_else(|| ApiError::not_found("Order not found."))?;
    Ok(api_json(order_response(&state, order, None)?))
}

fn order_response(
    state: &AppState,
    order: OrderRecord,
    status_token: Option<String>,
) -> Result<OrderResponse, ApiError> {
    let jobs = state
        .database
        .get_jobs(&order.id)
        .map_err(ApiError::internal)?;
    let search_groups = state
        .database
        .get_search_groups(&order.id)
        .map_err(ApiError::internal)?;
    let active_prefix_slots = state
        .database
        .active_prefix_slots()
        .map_err(ApiError::internal)?;
    let status_deep_link = format!("mfw://vanity/order/{}", order.id);
    Ok(OrderResponse {
        version: 1,
        status_token,
        status_deep_link,
        order: OrderView::from_record(order, jobs, search_groups, active_prefix_slots),
    })
}

async fn create_order_record(
    state: &AppState,
    public_address: String,
    prefixes: Vec<String>,
    notification: Option<NotificationTarget>,
) -> Result<CreatedOrder, ApiError> {
    validate_monero_order(&public_address, &prefixes)?;
    validate_notification_target(notification.as_ref())?;
    let quote = state.pricing.quote(&prefixes).map_err(|_| {
        ApiError::bad_request("No price is configured for one of these prefix lengths.")
    })?;
    let payment = state.payment.as_ref().ok_or_else(|| {
        ApiError::unavailable("The payment service is not configured yet. Please try again later.")
    })?;
    let mut payment_id_bytes = [0_u8; 8];
    OsRng.fill_bytes(&mut payment_id_bytes);
    let payment_id = hex::encode(payment_id_bytes);
    payment_id_bytes.fill(0);
    let payment_address = payment
        .invoice_address(&payment_id)
        .await
        .map_err(ApiError::internal)?;
    let created_at = now_epoch_seconds();
    let quote_expires_at = created_at
        .checked_add(i64::try_from(state.quote_ttl.as_secs()).map_err(ApiError::internal)?)
        .ok_or_else(|| ApiError::internal(anyhow::anyhow!("quote expiry overflow")))?;
    let id = uuid::Uuid::new_v4().to_string();
    let mut status_token_bytes = [0_u8; 32];
    OsRng.fill_bytes(&mut status_token_bytes);
    let status_token = hex::encode(status_token_bytes);
    status_token_bytes.fill(0);
    let status_token_hash = hash_status_token(&status_token);
    let (notification_installation_id, notification_platform) = notification
        .map(|target| (Some(target.installation_id), Some(target.platform)))
        .unwrap_or((None, None));
    state
        .database
        .insert_order(&NewOrder {
            id: id.clone(),
            public_address,
            prefixes,
            price_atomic: quote.total_atomic,
            list_price_atomic: quote.list_price_atomic,
            discount_atomic: quote.discount_atomic,
            payment_id,
            payment_address,
            created_at,
            quote_expires_at,
            required_confirmations: state.required_confirmations,
            status_token_hash,
            notification_installation_id,
            notification_platform,
        })
        .map_err(ApiError::internal)?;
    let record = state
        .database
        .get_order(&id)
        .map_err(ApiError::internal)?
        .ok_or_else(|| ApiError::internal(anyhow::anyhow!("created order disappeared")))?;
    Ok(CreatedOrder {
        record,
        status_token,
    })
}

fn validate_notification_target(target: Option<&NotificationTarget>) -> Result<(), ApiError> {
    let Some(target) = target else {
        return Ok(());
    };
    if !matches!(target.platform.as_str(), "android" | "ios" | "desktop")
        || target.installation_id.len() < 24
        || target.installation_id.len() > 128
        || !target
            .installation_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    {
        return Err(ApiError::bad_request(
            "The notification installation identifier is invalid.",
        ));
    }
    Ok(())
}

fn bearer_token(headers: &axum::http::HeaderMap) -> Result<&str, ApiError> {
    let value = headers
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .filter(|value| {
            value.len() == 64
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        })
        .ok_or_else(|| ApiError::not_found("Order not found."))?;
    Ok(value)
}

fn hash_status_token(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))
}

fn validate_monero_order(public_address: &str, prefixes: &[String]) -> Result<(), ApiError> {
    if !valid_monero_primary_address(Some(public_address)) {
        return Err(ApiError::bad_request(
            "Use a standard 95-character Monero mainnet primary address.",
        ));
    }
    if prefixes.is_empty() || prefixes.len() > MAX_PREFIXES_PER_ORDER {
        return Err(ApiError::bad_request(
            "Choose between 1 and 100 different prefixes.",
        ));
    }
    let mut unique = HashSet::with_capacity(prefixes.len());
    if prefixes.iter().any(|prefix| {
        prefix.trim() != prefix
            || prefix.chars().count() < 2
            || prefix.chars().count() > MAX_PREFIX_CHARS
            || !valid_monero_prefix(prefix)
            || !unique.insert(prefix.as_str())
    }) {
        return Err(ApiError::bad_request(
            "Prefixes must be unique, start with 4, and use 2 to 10 Monero Base58 characters.",
        ));
    }
    Ok(())
}

struct ApiError {
    status: StatusCode,
    public_message: String,
}

impl ApiError {
    fn bad_request(message: &str) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            public_message: message.to_owned(),
        }
    }

    fn not_found(message: &str) -> Self {
        Self {
            status: StatusCode::NOT_FOUND,
            public_message: message.to_owned(),
        }
    }

    fn unavailable(message: &str) -> Self {
        Self {
            status: StatusCode::SERVICE_UNAVAILABLE,
            public_message: message.to_owned(),
        }
    }

    fn internal(error: impl Into<anyhow::Error>) -> Self {
        eprintln!("mfw-vanity-service internal error: {:#}", error.into());
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            public_message: "The service could not complete this request.".to_owned(),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        #[derive(Serialize)]
        struct ErrorBody {
            error: String,
        }
        let mut response = (
            self.status,
            Json(ErrorBody {
                error: self.public_message,
            }),
        )
            .into_response();
        response
            .headers_mut()
            .insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
        response
            .headers_mut()
            .insert(X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
        response
    }
}

fn api_json(value: impl Serialize) -> Response {
    let mut response = Json(value).into_response();
    response
        .headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
        .headers_mut()
        .insert(X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    response
}

fn now_epoch_seconds() -> i64 {
    i64::try_from(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs(),
    )
    .unwrap_or(i64::MAX)
}

async fn payment_monitor(state: AppState, interval: Duration) {
    loop {
        let now = now_epoch_seconds();
        if let Err(error) = state.database.expire_quotes(now) {
            eprintln!("mfw-vanity-service quote expiry failed: {error:#}");
        }
        if let Err(error) = state.database.expire_limited_searches(now) {
            eprintln!("mfw-vanity-service limited-search expiry failed: {error:#}");
        }
        if let Err(error) = state
            .database
            .activate_queued_groups(now, pricing::MAX_ACTIVE_PREFIX_SLOTS)
        {
            eprintln!("mfw-vanity-service pool activation failed: {error:#}");
        }
        match state.database.monitored_payment_ids() {
            Ok(payment_ids) if !payment_ids.is_empty() => {
                let Some(payment) = state.payment.as_ref() else {
                    return;
                };
                match payment.poll(&payment_ids).await {
                    Ok(observations) => {
                        for observation in observations {
                            if let Err(error) = state.database.record_payment(&observation, now) {
                                eprintln!("mfw-vanity-service payment update failed: {error:#}");
                            }
                        }
                    }
                    Err(error) => eprintln!("mfw-vanity-service payment poll failed: {error:#}"),
                }
            }
            Ok(_) => {}
            Err(error) => eprintln!("mfw-vanity-service payment query failed: {error:#}"),
        }
        if let Some(notification) = state.notification.as_ref() {
            match state.database.pending_notifications(32) {
                Ok(pending) => {
                    for event in pending {
                        match notification.send(&event).await {
                            Ok(()) => {
                                if let Err(error) =
                                    state.database.mark_notification_sent(&event.id, now)
                                {
                                    eprintln!(
                                        "mfw-vanity-service notification ACK failed: {error:#}"
                                    );
                                }
                            }
                            Err(error) => eprintln!(
                                "mfw-vanity-service notification delivery deferred: {error:#}"
                            ),
                        }
                    }
                }
                Err(error) => {
                    eprintln!("mfw-vanity-service notification query failed: {error:#}")
                }
            }
        }
        tokio::time::sleep(interval).await;
    }
}

fn valid_monero_prefix(prefix: &str) -> bool {
    (2..=MAX_PREFIX_CHARS).contains(&prefix.chars().count())
        && prefix.starts_with('4')
        && prefix
            .chars()
            .all(|character| MONERO_BASE58.contains(character))
}

fn valid_onion_prefix(prefix: &str) -> bool {
    prefix
        .chars()
        .all(|character| ONION_BASE32.contains(character))
}

fn valid_monero_primary_address(value: Option<&str>) -> bool {
    let Some(value) = value else {
        return false;
    };
    let address = value.trim();
    if address != value || address.len() != 95 {
        return false;
    }
    let Ok(decoded) = MoneroAddress::from_str(Network::Mainnet, address) else {
        return false;
    };
    if *decoded.kind() != MoneroAddressType::Legacy {
        return false;
    }
    PublicAddress::new(
        AddressKind::Standard,
        decoded.spend().compress().to_bytes(),
        decoded.view().compress().to_bytes(),
    )
    .is_ok()
}

fn valid_split_key_result(source: &str, result: &str, offset_hex: &str) -> bool {
    if offset_hex.len() != 64
        || offset_hex
            .bytes()
            .any(|byte| !byte.is_ascii_hexdigit() || byte.is_ascii_uppercase())
    {
        return false;
    }
    let (Ok(source), Ok(result)) = (
        MoneroAddress::from_str(Network::Mainnet, source),
        MoneroAddress::from_str(Network::Mainnet, result),
    ) else {
        return false;
    };
    if *source.kind() != MoneroAddressType::Legacy
        || *result.kind() != MoneroAddressType::Legacy
        || source.view() != result.view()
    {
        return false;
    }
    let mut offset_bytes = [0_u8; 32];
    if hex::decode_to_slice(offset_hex, &mut offset_bytes).is_err() {
        return false;
    }
    let offset = Option::<Scalar>::from(Scalar::from_canonical_bytes(offset_bytes));
    offset_bytes.fill(0);
    let Some(offset) = offset.filter(|offset| *offset != Scalar::ZERO) else {
        return false;
    };
    source.spend() + offset * ED25519_BASEPOINT_POINT == result.spend()
}

fn secure_html(body: String) -> Response {
    secure_html_with_status(StatusCode::OK, body)
}

fn secure_html_with_status(status: StatusCode, body: String) -> Response {
    let mut response = (status, Html(body)).into_response();
    secure_headers(response.headers_mut());
    response
}

fn secure_headers(headers: &mut axum::http::HeaderMap) {
    headers.insert(
        CONTENT_SECURITY_POLICY,
        HeaderValue::from_static("default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"),
    );
    headers.insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(REFERRER_POLICY, HeaderValue::from_static("no-referrer"));
    headers.insert(X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    headers.insert(X_FRAME_OPTIONS, HeaderValue::from_static("DENY"));
    headers.insert(
        CONTENT_TYPE,
        HeaderValue::from_static("text/html; charset=utf-8"),
    );
}

fn index_page() -> String {
    format!(
        r#"<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>MFW Vanity Studio</title><style>{}</style></head>
<body>
  <main class="shell">
    <nav><a class="brand" href="/">MFW <span>Vanity Studio</span></a><span class="nav-note">Private by design · Tor-ready</span></nav>
    <section class="hero">
      <p class="eyebrow">MFW / PRIVATE ADDRESS TOOLING</p>
      <h1>One signature.<br><em>Your key stays yours.</em></h1>
      <p class="lede">Vanity search for Monero and Tor v3 — separate, transparent, and without tracking. This interface has no external scripts or fonts.</p>
      <div class="facts"><span><b>01</b> No seed</span><span><b>02</b> No tracking</span><span><b>03</b> Loopback + Tor</span></div>
    </section>
    <section class="how" aria-label="How the service works">
      <div class="section-heading"><p class="eyebrow">HOW IT WORKS</p><h2>Two public inputs.<br>One locally verified result.</h2></div>
      <ol class="steps">
        <li><b>01</b><div><h3>Choose a prefix</h3><p>For example <code>4MFW</code>. It is the beginning you want your new Monero address to have.</p></div></li>
        <li><b>02</b><div><h3>Paste your existing address</h3><p>Your normal public Monero address already contains the public key needed for the search. It cannot reveal your private key.</p></div></li>
        <li><b>03</b><div><h3>Verify locally in MFW</h3><p>After payment and search, MFW applies the result only on your device and checks the generated address before saving it.</p></div></li>
      </ol>
    </section>
    <section class="studio" aria-label="Prepare a vanity request">
      <article class="card monero">
        <div class="card-top"><p class="tag">MONERO</p><span class="dot"></span></div>
        <h2>Split-Key Vanity</h2>
        <p>Start with your existing public Monero address. No seed, private spend key, private view key, or wallet file is needed.</p>
        <form method="post" action="/v1/orders">
          <input type="hidden" name="kind" value="monero">
          <label><span><b>1</b> Desired vanity prefix</span><input name="prefix" required minlength="2" maxlength="10" pattern="4[1-9A-HJ-NP-Za-km-z]{{1,9}}" inputmode="text" autocomplete="off" placeholder="Example: 4MFW"></label>
          <label><span><b>2</b> Your Monero primary address <small>public · 95 characters</small></span><input name="public_address" required minlength="95" maxlength="95" pattern="4[1-9A-HJ-NP-Za-km-z]{{94}}" inputmode="text" spellcheck="false" autocomplete="off" placeholder="Paste your existing public Monero address"></label>
          <p class="input-help"><span>✓</span> This address contains only public information. It is used to derive the public spend key needed for the search.</p>
          <button type="submit">Continue securely <span>↗</span></button>
        </form>
        <p class="fine">V1 supports standard primary addresses. Your private key stays in MFW; final verification runs inside the wallet.</p>
      </article>
      <article class="card onion">
        <div class="card-top"><p class="tag">TOR V3</p><span class="dot"></span></div>
        <h2>Onion Vanity</h2>
        <p>Onion addresses are different: the private Onion key must stay yours from the first moment. Therefore this route runs locally in MFW.</p>
        <form method="post" action="/v1/orders">
          <input type="hidden" name="kind" value="onion">
          <label><span><b>1</b> Desired Onion prefix</span><input name="prefix" required maxlength="24" pattern="[a-z2-7]{{1,24}}" inputmode="text" autocomplete="off" placeholder="Example: mfw"></label>
          <p class="input-help"><span>✓</span> Valid characters: lowercase a–z and 2–7. Do not add <code>.onion</code>.</p>
          <div class="onion-explainer"><b>Creating a new Onion address</b><p>The prefix is all MFW needs. MFW generates and keeps the private Onion key locally. An existing Onion address cannot be changed, because its address is mathematically bound to its current private key.</p></div>
          <button type="submit">Prepare local search <span>↗</span></button>
        </form>
        <p class="fine">Base32, without <code>.onion</code>. Benchmark target: at least 1,000 parallel prefixes.</p>
      </article>
    </section>
    <section class="security">
      <div class="section-heading"><p class="eyebrow">WHY IT IS SAFE</p><h2>The service can search.<br>It cannot spend.</h2></div>
      <div class="security-grid">
        <article><span>MONERO</span><h3>Only your public address is shared</h3><p>A public address lets the worker calculate a matching public address. It does not contain the private spend key required to move funds.</p></article>
        <article><span>LOCAL PROOF</span><h3>MFW checks every result locally</h3><p>Your wallet independently rebuilds the address and confirms the requested prefix. A wrong or altered result is rejected before it is used.</p></article>
        <article><span>ONION</span><h3>Private Onion keys are never server keys</h3><p>Trustless Onion vanity generation happens locally. The server never creates, stores, or sends a private Onion key.</p></article>
      </div>
      <div class="protocol-line"><span>Public request</span><i></i><span>Paid search</span><i></i><span>Local verification</span></div>
    </section>
    <footer><span>MONERO FAST WALLET</span><span>NO ANALYTICS · NO THIRD-PARTY ASSETS</span></footer>
  </main>
</body></html>"#,
        style()
    )
}

fn prepared_page(kind: &str, prefix: &str, proof: &str, next: &str) -> String {
    message_page(
        "Safely prepared",
        &format!(
            "<span class=\"badge\">{}</span><h1>{}</h1><p class=\"lede\">{}</p><div class=\"result\"><b>Prefix</b><code>{}</code><b>Next security gate</b><p>{}</p></div><a class=\"back\" href=\"/\">← Back to the studio</a>",
            escape_html(kind),
            escape_html(kind),
            escape_html(proof),
            escape_html(prefix),
            escape_html(next)
        ),
    )
}

fn payment_page(order: &OrderRecord, status_token: &str) -> String {
    let prefixes = order
        .prefixes
        .iter()
        .map(|prefix| format!("<code>{}</code>", escape_html(prefix)))
        .collect::<Vec<_>>()
        .join(" ");
    let limited_notice = if order
        .prefixes
        .iter()
        .any(|prefix| prefix.chars().count() == LIMITED_SEARCH_PREFIX_LENGTH)
    {
        "<div class=\"result\"><b>60-day limited search</b><p>A 10-character match is not guaranteed. The fee pays for up to 60 days of GPU search and is non-refundable once generation starts.</p></div>"
    } else {
        ""
    };
    message_page(
        "Payment quote",
        &format!(
            "<span class=\"badge\">MONERO · QUOTE</span><h1>Pay {} XMR</h1><p class=\"lede\">Send the exact amount to this unique integrated address. The GPU jobs are queued only after the payment is unlocked and has {} confirmations.</p><div class=\"result\"><b>Prefixes</b><p>{}</p><b>Three-alternative group discount</b><p>{} XMR</p><b>Payment address</b><code>{}</code><b>Payment ID</b><code>{}</code><b>Order ID</b><code>{}</code><b>Status token</b><code>{}</code></div>{}<p class=\"fine\">Keep the status token private. The web page does not place it in a URL.</p>",
            escape_html(&format_xmr(order.price_atomic)),
            order.required_confirmations,
            prefixes,
            escape_html(&format_xmr(order.discount_atomic)),
            escape_html(&order.payment_address),
            escape_html(&order.payment_id),
            escape_html(&order.id),
            escape_html(status_token),
            limited_notice,
        ),
    )
}

fn message_page(title: &str, message: &str) -> String {
    format!(
        r#"<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>{}</title><style>{}</style></head><body><main class="shell narrow"><nav><a class="brand" href="/">MFW <span>Vanity Studio</span></a></nav><section class="message"><p class="eyebrow">MFW VANITY STUDIO</p><div>{}</div></section><footer><span>PRIVATE BY DESIGN</span><span>TOR-READY</span></footer></main></body></html>"#,
        escape_html(title),
        style(),
        message
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

fn style() -> &'static str {
    r#"
:root{--bg:#080706;--panel:#17100d;--panel-soft:#21140f;--ink:#fff5ed;--muted:#c9b7aa;--monero:#f26822;--monero-bright:#ff7a32;--ember:#b33c18;--line:rgba(242,104,34,.24)}
*{box-sizing:border-box}body{margin:0;background:radial-gradient(80rem 42rem at 50% -20%,#4e1e0f 0%,transparent 58%),var(--bg);color:var(--ink);font-family:ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;line-height:1.45}.shell{width:min(1180px,calc(100% - 40px));margin:auto;min-height:100vh;display:flex;flex-direction:column}.narrow{width:min(760px,calc(100% - 40px))}nav{display:flex;justify-content:space-between;align-items:center;padding:28px 0;border-bottom:1px solid var(--line)}.brand{color:var(--ink);font-weight:800;letter-spacing:.03em;text-decoration:none}.brand span{color:var(--monero);font-weight:500}.nav-note,.fine,small{color:var(--muted);font-size:.79rem}.hero{padding:100px 0 68px;max-width:800px}.eyebrow,.tag{margin:0 0 15px;font-size:.72rem;letter-spacing:.15em;color:var(--monero-bright);font-weight:800}.hero h1,.message h1{font-size:clamp(3.2rem,8vw,6.7rem);line-height:.96;letter-spacing:-.075em;margin:0 0 28px}.hero em{font-family:ui-serif,Georgia,serif;font-weight:400;color:#ffd5bd}.lede{font-size:clamp(1.02rem,2vw,1.22rem);color:var(--muted);max-width:680px}.facts{display:flex;gap:25px;flex-wrap:wrap;margin-top:35px;color:var(--muted);font-size:.82rem}.facts b{color:var(--monero-bright);margin-right:8px}.studio{display:grid;grid-template-columns:1fr 1fr;gap:18px}.card{padding:30px;background:linear-gradient(145deg,var(--panel-soft),var(--panel));border:1px solid var(--line);border-radius:20px;box-shadow:0 20px 60px rgba(0,0,0,.28)}.card-top{display:flex;justify-content:space-between;align-items:center}.dot{width:10px;height:10px;border-radius:50%;background:var(--monero-bright);box-shadow:0 0 18px var(--monero)}.onion .dot{background:#f6b28b;box-shadow:0 0 18px #f6b28b}.card h2{font-size:2rem;letter-spacing:-.055em;margin:8px 0}.card>p:not(.fine){color:var(--muted);min-height:78px}form{display:grid;gap:15px;margin-top:25px}label{display:grid;gap:7px;font-size:.84rem;font-weight:700}small{font-weight:400}input{min-width:0;width:100%;padding:14px;border:1px solid var(--line);border-radius:10px;background:#0d0907;color:var(--ink);font:inherit;outline:none}input:focus{border-color:var(--monero-bright);box-shadow:0 0 0 3px rgba(242,104,34,.16)}button,.back{margin-top:4px;border:0;border-radius:10px;background:var(--monero);color:#1b0a04;padding:14px 16px;text-align:left;font:inherit;font-weight:800;cursor:pointer;text-decoration:none;display:flex;justify-content:space-between}button:hover{background:var(--monero-bright)}.fine{min-height:38px;margin:21px 0 0}.protocol{margin:78px 0;padding:31px 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line);display:grid;grid-template-columns:.55fr 1fr;gap:22px}.protocol h2{letter-spacing:-.05em;font-size:1.65rem;margin:0}.protocol p{color:var(--muted);margin:8px 0}.protocol-line{grid-column:1/-1;display:flex;align-items:center;gap:12px;flex-wrap:wrap;font-size:.82rem;color:var(--muted)}.protocol-line i{height:1px;width:44px;background:var(--ember)}footer{margin-top:auto;display:flex;justify-content:space-between;gap:20px;padding:24px 0;color:var(--muted);font-size:.68rem;letter-spacing:.12em}.message{padding:120px 0;max-width:680px}.message h1{font-size:clamp(3.4rem,7vw,5.6rem)}.badge{display:inline-block;margin-bottom:20px;padding:6px 10px;border:1px solid var(--line);border-radius:99px;color:var(--monero-bright);font-size:.72rem;font-weight:800;letter-spacing:.1em}.result{margin:30px 0;padding:22px;border:1px solid var(--line);border-radius:16px;background:var(--panel)}.result b{display:block;color:var(--monero-bright);font-size:.73rem;letter-spacing:.11em;text-transform:uppercase;margin-bottom:6px}.result code{display:block;overflow-wrap:anywhere;margin-bottom:22px;color:var(--ink)}.result p{color:var(--muted);margin:0}.back{width:max-content;margin-top:27px;display:block}@media (max-width:720px){.shell{width:min(100% - 28px,1180px)}nav{padding:21px 0}.nav-note{display:none}.hero{padding:70px 0 46px}.studio{grid-template-columns:1fr}.card{padding:24px}.card>p:not(.fine){min-height:0}.protocol{grid-template-columns:1fr;margin:54px 0}.protocol-line{gap:9px}footer{font-size:.58rem}.message{padding:80px 0}}
.how,.security{margin:0 0 78px;padding:34px 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line)}.section-heading{display:grid;grid-template-columns:.55fr 1fr;gap:22px;align-items:start}.section-heading h2{margin:0;max-width:620px;font-size:clamp(2rem,4vw,3.45rem);line-height:1.02;letter-spacing:-.065em}.steps{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;list-style:none;padding:0;margin:34px 0 0}.steps li{min-height:190px;padding:20px;background:rgba(242,104,34,.055);border:1px solid var(--line);border-radius:14px}.steps li>b{display:block;color:var(--monero-bright);font-size:.74rem;letter-spacing:.11em}.steps h3,.security h3{margin:19px 0 7px;font-size:1rem;letter-spacing:-.02em}.steps p,.security p{margin:0;color:var(--muted);font-size:.88rem}.steps code{color:var(--ink)}label>span{display:flex;align-items:baseline;gap:7px}label b{display:inline-grid;place-items:center;width:18px;height:18px;border-radius:50%;background:var(--monero);color:#210c04;font-size:.68rem}.input-help{display:flex;gap:9px;margin:-3px 0 2px;color:var(--muted);font-size:.78rem;line-height:1.38}.input-help span{color:var(--monero-bright);font-weight:900}.security{margin-top:78px}.security-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-top:34px}.security-grid article{padding:22px;border-radius:14px;background:rgba(242,104,34,.055);border:1px solid var(--line)}.security-grid article>span{display:block;color:var(--monero-bright);font-size:.67rem;font-weight:800;letter-spacing:.13em}.security .protocol-line{display:flex;margin-top:29px}.protocol-line{grid-column:auto}@media (max-width:720px){.how,.security{margin-bottom:54px;padding:26px 0}.section-heading{grid-template-columns:1fr;gap:3px}.steps,.security-grid{grid-template-columns:1fr}.steps li{min-height:0}.security{margin-top:54px}.security .protocol-line{font-size:.7rem}}
.onion-explainer{padding:14px 15px;border-radius:10px;border-left:2px solid var(--monero);background:rgba(242,104,34,.08)}.onion-explainer>b{font-size:.8rem}.onion-explainer p{margin:5px 0 0;color:var(--muted);font-size:.77rem;line-height:1.42}
"#
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::Body, http::Request};
    use curve25519_dalek::{constants::ED25519_BASEPOINT_POINT, scalar::Scalar};
    use tower::ServiceExt;

    struct FakePaymentBackend;

    #[async_trait::async_trait]
    impl PaymentBackend for FakePaymentBackend {
        async fn invoice_address(&self, payment_id: &str) -> anyhow::Result<String> {
            Ok(format!("invoice-{payment_id}"))
        }

        async fn poll(
            &self,
            _payment_ids: &[String],
        ) -> anyhow::Result<Vec<database::PaymentObservation>> {
            Ok(Vec::new())
        }
    }

    fn public_address() -> String {
        MoneroAddress::new(
            Network::Mainnet,
            MoneroAddressType::Legacy,
            ED25519_BASEPOINT_POINT,
            ED25519_BASEPOINT_POINT * Scalar::from(2_u64),
        )
        .to_string()
    }

    #[test]
    fn only_public_monero_inputs_are_accepted() {
        assert!(valid_monero_prefix("4MFW"));
        assert!(!valid_monero_prefix("4MFW0"));
        assert!(!valid_monero_prefix("8MFW"));
        let address = public_address();
        assert!(valid_monero_primary_address(Some(&address)));
        assert!(!valid_monero_primary_address(Some("not-a-public-address")));
    }

    #[test]
    fn split_key_result_must_match_the_public_source_and_offset() {
        let source = MoneroAddress::new(
            Network::Mainnet,
            MoneroAddressType::Legacy,
            ED25519_BASEPOINT_POINT,
            ED25519_BASEPOINT_POINT * Scalar::from(2_u64),
        );
        let offset = Scalar::from(3_u64);
        let result = MoneroAddress::new(
            Network::Mainnet,
            MoneroAddressType::Legacy,
            source.spend() + offset * ED25519_BASEPOINT_POINT,
            source.view(),
        );
        assert!(valid_split_key_result(
            &source.to_string(),
            &result.to_string(),
            &hex::encode(offset.to_bytes()),
        ));
        assert!(!valid_split_key_result(
            &source.to_string(),
            &result.to_string(),
            &hex::encode(Scalar::from(4_u64).to_bytes()),
        ));
    }

    #[test]
    fn onion_prefixes_are_base32_only() {
        assert!(valid_onion_prefix("mfw27"));
        assert!(!valid_onion_prefix("mfw8"));
    }

    #[tokio::test]
    async fn index_has_privacy_headers() {
        let response = router()
            .oneshot(Request::builder().uri("/").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[CACHE_CONTROL], "no-store");
        assert!(response.headers().contains_key(CONTENT_SECURITY_POLICY));
    }

    #[tokio::test]
    async fn quote_api_stores_all_prefixes_and_returns_an_invoice() {
        let database = Database::in_memory().unwrap();
        let state = AppState {
            database: database.clone(),
            pricing: PricingCatalog::fixed(),
            payment: Some(Arc::new(FakePaymentBackend)),
            quote_ttl: Duration::from_secs(1800),
            required_confirmations: 10,
            worker_auth_hash: None,
            notification: None,
        };
        let body = serde_json::json!({
            "version": 1,
            "kind": "monero",
            "network": "mainnet",
            "public_address": public_address(),
            "prefixes": ["4MFW", "4TST"],
            "notification": {
                "installation_id": "mfw_test_0123456789abcdef0123456789abcdef",
                "platform": "android"
            }
        });
        let app = router_with_state(state);
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/quotes")
                    .header(CONTENT_TYPE, "application/json")
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), 16 * 1024)
            .await
            .unwrap();
        let response: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(response["order"]["price_atomic"], "1000000000");
        assert_eq!(response["order"]["discount_atomic"], "1000000000");
        assert_eq!(response["order"]["prefixes"].as_array().unwrap().len(), 2);
        assert_eq!(response["status_token"].as_str().unwrap().len(), 64);
        assert!(response["status_deep_link"]
            .as_str()
            .unwrap()
            .starts_with("mfw://vanity/order/"));
        assert!(response["order"]["payment_address"]
            .as_str()
            .unwrap()
            .starts_with("invoice-"));

        let order_id = response["order"]["id"].as_str().unwrap();
        let status_token = response["status_token"].as_str().unwrap();
        let unauthorized = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/api/v1/orders/{order_id}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(unauthorized.status(), StatusCode::NOT_FOUND);

        let authorized = app
            .oneshot(
                Request::builder()
                    .uri(format!("/api/v1/orders/{order_id}"))
                    .header(AUTHORIZATION, format!("Bearer {status_token}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(authorized.status(), StatusCode::OK);
        let body = axum::body::to_bytes(authorized.into_body(), 16 * 1024)
            .await
            .unwrap();
        let status: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(status["order"]["id"], order_id);
        assert!(status.get("status_token").is_none());
    }
}
