use async_trait::async_trait;
use axum::{
    extract::{DefaultBodyLimit, Path, Query, State},
    http::{header::AUTHORIZATION, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{delete, get, post},
    Json, Router,
};
use community_chat_report_core::{
    ChatReportDecision, ChatReportError, ChatReportOutcome, ChatReportQueueCase, ChatReportReceipt,
    ChatReportStore, VoluntaryChatReport,
};
use community_contact_core::{AcceptedContact, ContactError, ContactRequest, ContactStore};
use community_notification_core::{
    NotificationError, NotificationRegistration, NotificationStore, ProviderKind,
};
use community_publication_core::{
    ModerationQueueCase, ModeratorDecision, PublicContentDraft, PublicationError,
    PublicationRecord, PublicationStore, ScheduledAction, ScreeningAssessment, ScreeningOutcome,
};
use community_query_contribution_core::{
    QueryContributionCandidate, QueryContributionError, QueryContributionInput,
    QueryContributionReceipt, QueryContributionStore, QueryModerationDecision,
};
use community_search_core::{CatalogEmbeddingChunk, ModelContract};
use rand::{rngs::OsRng, RngCore};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, VecDeque},
    path::{Path as FilePath, PathBuf},
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};
use subtle::ConstantTimeEq;
use url::Url;
use zeroize::Zeroizing;

const MAX_REQUEST_BYTES: usize = 1024 * 1024;
const RATE_LIMIT_WINDOW_MS: u64 = 60_000;
const RATE_LIMIT_REQUESTS: usize = 90;

#[derive(Clone)]
pub struct ApiState {
    accounts: Arc<AccountStore>,
    publication: Arc<PublicationStore>,
    contacts: Arc<ContactStore>,
    chat_reports: Arc<ChatReportStore>,
    notifications: Arc<NotificationStore>,
    query_contributions: Option<Arc<QueryContributionStore>>,
    matrix_lifecycle: Option<Arc<dyn MatrixAccountLifecycle>>,
    matrix_provisioner: Option<Arc<dyn MatrixAccountProvisioner>>,
    matrix_provisioning: Arc<tokio::sync::Mutex<()>>,
    moderation_actions: Arc<tokio::sync::Mutex<()>>,
    internal_token_hash: [u8; 32],
    limiter: Arc<RateLimiter>,
}

impl ApiState {
    pub fn new(
        accounts: Arc<AccountStore>,
        publication: Arc<PublicationStore>,
        contacts: Arc<ContactStore>,
        chat_reports: Arc<ChatReportStore>,
        notifications: Arc<NotificationStore>,
        internal_token: &[u8],
    ) -> Result<Self, String> {
        if internal_token.len() < 32 {
            return Err("internal token must contain at least 32 bytes".to_owned());
        }
        Ok(Self {
            accounts,
            publication,
            contacts,
            chat_reports,
            notifications,
            query_contributions: None,
            matrix_lifecycle: None,
            matrix_provisioner: None,
            matrix_provisioning: Arc::new(tokio::sync::Mutex::new(())),
            moderation_actions: Arc::new(tokio::sync::Mutex::new(())),
            internal_token_hash: Sha256::digest(internal_token).into(),
            limiter: Arc::new(RateLimiter::default()),
        })
    }

    pub fn with_matrix_lifecycle(mut self, lifecycle: Arc<dyn MatrixAccountLifecycle>) -> Self {
        self.matrix_lifecycle = Some(lifecycle);
        self
    }

    pub fn with_query_contributions(
        mut self,
        query_contributions: Arc<QueryContributionStore>,
    ) -> Self {
        self.query_contributions = Some(query_contributions);
        self
    }

    pub fn with_matrix_provisioner(
        mut self,
        provisioner: Arc<dyn MatrixAccountProvisioner>,
    ) -> Self {
        self.matrix_provisioner = Some(provisioner);
        self
    }
}

#[async_trait]
pub trait MatrixAccountLifecycle: Send + Sync {
    async fn deactivate_and_erase(&self, matrix_user_id: &str) -> Result<(), String>;
    async fn set_locked(&self, matrix_user_id: &str, locked: bool) -> Result<(), String>;
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProvisionedMatrixAccount {
    pub matrix_user_id: String,
    pub homeserver: String,
}

#[async_trait]
pub trait MatrixAccountProvisioner: Send + Sync {
    async fn provision(
        &self,
        identity_id: &str,
        password: &str,
    ) -> Result<ProvisionedMatrixAccount, String>;
}

pub struct SynapseMatrixAccountLifecycle {
    admin_origin: Url,
    admin_token_file: PathBuf,
    provisioning: Option<MatrixProvisioningConfig>,
    client: reqwest::Client,
}

struct MatrixProvisioningConfig {
    homeserver: Url,
    server_name: String,
}

impl SynapseMatrixAccountLifecycle {
    pub fn new(admin_origin: &str, admin_token_file: PathBuf) -> Result<Self, String> {
        let admin_origin = validate_private_origin(admin_origin)?;
        let client = reqwest::Client::builder()
            .https_only(admin_origin.scheme() == "https")
            .redirect(reqwest::redirect::Policy::none())
            .timeout(std::time::Duration::from_secs(10))
            .user_agent("TEX8-Monero-Enthusiast-Identity-Lifecycle/0.1")
            .build()
            .map_err(|_| "Matrix lifecycle client could not be created".to_owned())?;
        drop(load_bounded_secret(&admin_token_file)?);
        Ok(Self {
            admin_origin,
            admin_token_file,
            provisioning: None,
            client,
        })
    }

    pub fn with_provisioning(
        mut self,
        homeserver: &str,
        server_name: &str,
    ) -> Result<Self, String> {
        let homeserver = validate_public_homeserver(homeserver)?;
        validate_matrix_server_name(server_name)?;
        self.provisioning = Some(MatrixProvisioningConfig {
            homeserver,
            server_name: server_name.to_owned(),
        });
        Ok(self)
    }
}

#[async_trait]
impl MatrixAccountLifecycle for SynapseMatrixAccountLifecycle {
    async fn deactivate_and_erase(&self, matrix_user_id: &str) -> Result<(), String> {
        let mut url = self.admin_origin.clone();
        url.path_segments_mut()
            .map_err(|_| "Matrix admin origin cannot be used as a base".to_owned())?
            .extend(["_synapse", "admin", "v1", "deactivate", matrix_user_id]);
        let token = load_bounded_secret(&self.admin_token_file)?;
        let response = self
            .client
            .post(url)
            .bearer_auth(token.as_str())
            .json(&serde_json::json!({"erase": true}))
            .send()
            .await
            .map_err(|_| "Matrix account deactivation failed".to_owned())?;
        if response.status().is_success() {
            Ok(())
        } else {
            Err(format!(
                "Matrix account deactivation returned HTTP {}",
                response.status().as_u16()
            ))
        }
    }

    async fn set_locked(&self, matrix_user_id: &str, locked: bool) -> Result<(), String> {
        let mut url = self.admin_origin.clone();
        url.path_segments_mut()
            .map_err(|_| "Matrix admin origin cannot be used as a base".to_owned())?
            .extend(["_synapse", "admin", "v2", "users", matrix_user_id]);
        let token = load_bounded_secret(&self.admin_token_file)?;
        let response = self
            .client
            .put(url)
            .bearer_auth(token.as_str())
            .json(&serde_json::json!({"locked": locked}))
            .send()
            .await
            .map_err(|_| "Matrix account lock update failed".to_owned())?;
        if response.status().is_success() {
            Ok(())
        } else {
            Err(format!(
                "Matrix account lock update returned HTTP {}",
                response.status().as_u16()
            ))
        }
    }
}

#[async_trait]
impl MatrixAccountProvisioner for SynapseMatrixAccountLifecycle {
    async fn provision(
        &self,
        identity_id: &str,
        password: &str,
    ) -> Result<ProvisionedMatrixAccount, String> {
        validate_matrix_password(password)?;
        let config = self
            .provisioning
            .as_ref()
            .ok_or_else(|| "Matrix account provisioning is not configured".to_owned())?;
        if !identity_id.starts_with("person_")
            || identity_id.len() != 39
            || !identity_id[7..]
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit())
        {
            return Err("Community identity cannot be used for Matrix".to_owned());
        }
        let matrix_user_id = format!("@{identity_id}:{}", config.server_name);
        let mut url = self.admin_origin.clone();
        url.path_segments_mut()
            .map_err(|_| "Matrix admin origin cannot be used as a base".to_owned())?
            .extend(["_synapse", "admin", "v2", "users", &matrix_user_id]);
        let token = load_bounded_secret(&self.admin_token_file)?;
        let response = self
            .client
            .put(url)
            .bearer_auth(token.as_str())
            .json(&serde_json::json!({
                "password": password,
                "logout_devices": false,
                "admin": false,
                "deactivated": false,
                "locked": false
            }))
            .send()
            .await
            .map_err(|_| "Matrix account provisioning failed".to_owned())?;
        if !matches!(response.status().as_u16(), 200 | 201) {
            return Err(format!(
                "Matrix account provisioning returned HTTP {}",
                response.status().as_u16()
            ));
        }
        Ok(ProvisionedMatrixAccount {
            matrix_user_id,
            homeserver: config.homeserver.as_str().trim_end_matches('/').to_owned(),
        })
    }
}

pub fn router(state: ApiState) -> Router {
    public_router(state.clone()).merge(internal_router(state))
}

pub fn public_router(state: ApiState) -> Router {
    Router::new()
        .route("/", get(project_info))
        .route("/healthz", get(health))
        .route("/v2/identities", post(create_identity))
        .route("/v2/identity/delete", post(delete_identity))
        .route("/v2/account/status", get(account_status))
        .route("/v2/query-contributions", post(contribute_query))
        .route("/v2/matrix/provision", post(provision_matrix_identity))
        .route("/v2/content", get(list_own_content).post(submit_content))
        .route(
            "/v2/content/{public_id}",
            get(content_status).post(resubmit_content),
        )
        .route(
            "/v2/content/{public_id}/{revision}",
            delete(withdraw_content),
        )
        .route(
            "/v2/content/{public_id}/{revision}/reports",
            post(report_content),
        )
        .route("/v2/moderation/outcomes", get(moderation_outcomes))
        .route("/v2/moderation/cases/{case_id}/appeals", post(appeal_case))
        .route("/v2/contacts", get(accepted_contacts))
        .route("/v2/contacts/{peer_id}/requests", post(request_contact))
        .route("/v2/contacts/requests", get(pending_contact_requests))
        .route(
            "/v2/contacts/requests/{request_id}/accept",
            post(accept_contact),
        )
        .route(
            "/v2/contacts/requests/{request_id}/decline",
            post(decline_contact),
        )
        .route("/v2/contacts/{peer_id}", get(resolve_contact))
        .route("/v2/contacts/{peer_id}/block", post(block_contact))
        .route(
            "/v2/contacts/{peer_id}/chat-reports",
            post(report_selected_chat_message),
        )
        .route(
            "/v2/moderation/chat-reports/{case_id}",
            get(chat_report_outcome),
        )
        .route(
            "/v2/moderation/chat-reports/{case_id}/appeals",
            post(appeal_chat_report),
        )
        .route(
            "/v2/notifications/installations",
            get(notification_registrations).post(register_notification),
        )
        .route(
            "/v2/notifications/installations/{installation_id}",
            delete(remove_notification),
        )
        .layer(DefaultBodyLimit::max(MAX_REQUEST_BYTES))
        .with_state(state)
}

pub fn internal_router(state: ApiState) -> Router {
    Router::new()
        .route("/internal/healthz", get(health))
        .route(
            "/internal/v2/content/{public_id}/{revision}/screening",
            post(internal_record_screening),
        )
        .route(
            "/internal/v2/moderation/cases/{case_id}/decision",
            post(internal_moderate),
        )
        .route(
            "/internal/v2/moderation/cases",
            get(internal_moderation_queue),
        )
        .route(
            "/internal/v2/moderation/cases/{case_id}/acknowledge",
            post(internal_acknowledge_moderation),
        )
        .route(
            "/internal/v2/moderation/chat-reports",
            get(internal_chat_report_queue),
        )
        .route(
            "/internal/v2/moderation/chat-reports/{case_id}/acknowledge",
            post(internal_acknowledge_chat_report),
        )
        .route(
            "/internal/v2/moderation/chat-reports/{case_id}/decision",
            post(internal_decide_chat_report),
        )
        .route(
            "/internal/v2/content/{public_id}/{revision}/publish",
            post(internal_publish),
        )
        .route("/internal/v2/scheduled/run", post(internal_run_scheduled))
        .route(
            "/internal/v2/scheduled/{delivery_id}/acknowledge",
            post(internal_acknowledge_scheduled_delivery),
        )
        .route(
            "/internal/v2/identities/{identity_id}/matrix",
            post(internal_register_matrix_identity),
        )
        .route(
            "/internal/v2/notifications/administrators/{administrator_id}",
            post(internal_register_administrator_notification),
        )
        .route(
            "/internal/v2/query-contributions/candidates",
            get(internal_query_contribution_candidates),
        )
        .route(
            "/internal/v2/query-contributions/{query_id}/decision",
            post(internal_decide_query_contribution),
        )
        .route(
            "/internal/v2/query-contributions/catalog-delta",
            get(internal_query_catalog_delta),
        )
        .route(
            "/internal/v2/query-contributions/catalog-acknowledge",
            post(internal_acknowledge_query_catalog),
        )
        .layer(DefaultBodyLimit::max(MAX_REQUEST_BYTES))
        .with_state(state)
}

pub struct AccountStore {
    connection: Mutex<Connection>,
}

impl AccountStore {
    pub fn open(path: impl AsRef<FilePath>) -> Result<Self, String> {
        let path = path.as_ref();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let connection = Connection::open(path).map_err(|error| error.to_string())?;
        Self::from_connection(connection)
    }

    pub fn in_memory() -> Result<Self, String> {
        Self::from_connection(Connection::open_in_memory().map_err(|error| error.to_string())?)
    }

    fn from_connection(connection: Connection) -> Result<Self, String> {
        connection
            .execute_batch(
                "
                PRAGMA trusted_schema = OFF;
                PRAGMA journal_mode = DELETE;
                CREATE TABLE IF NOT EXISTS account (
                    identity_id TEXT PRIMARY KEY,
                    token_hash BLOB NOT NULL UNIQUE,
                    created_at_ms INTEGER NOT NULL,
                    deleted_at_ms INTEGER,
                    suspended_at_ms INTEGER,
                    suspended_case_id TEXT
                ) STRICT;
                ",
            )
            .map_err(|error| error.to_string())?;
        ensure_account_column(&connection, "suspended_at_ms", "INTEGER")?;
        ensure_account_column(&connection, "suspended_case_id", "TEXT")?;
        Ok(Self {
            connection: Mutex::new(connection),
        })
    }

    fn create(&self, now_ms: u64) -> Result<(String, String), ApiError> {
        let identity_id = random_id("person");
        let mut token = [0u8; 32];
        OsRng.fill_bytes(&mut token);
        let encoded_token = hex::encode(token);
        let token_hash = Sha256::digest(encoded_token.as_bytes());
        self.connection
            .lock()
            .map_err(|_| ApiError::Internal)?
            .execute(
                "INSERT INTO account(identity_id, token_hash, created_at_ms)
                 VALUES (?1, ?2, ?3)",
                params![
                    identity_id,
                    token_hash.as_slice(),
                    to_sql_i64(now_ms).map_err(|_| ApiError::BadRequest(
                        "Current time is outside the supported range.".to_owned()
                    ))?
                ],
            )
            .map_err(|_| ApiError::Internal)?;
        Ok((identity_id, encoded_token))
    }

    fn authenticate(&self, token: &str) -> Result<Option<AuthenticatedAccount>, ApiError> {
        if token.len() != 64 || !token.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Ok(None);
        }
        let token_hash = Sha256::digest(token.as_bytes());
        self.connection
            .lock()
            .map_err(|_| ApiError::Internal)?
            .query_row(
                "SELECT identity_id, suspended_case_id FROM account
                 WHERE token_hash = ?1 AND deleted_at_ms IS NULL",
                [token_hash.as_slice()],
                |row| {
                    Ok(AuthenticatedAccount {
                        identity_id: row.get(0)?,
                        suspended_case_id: row.get(1)?,
                    })
                },
            )
            .optional()
            .map_err(|_| ApiError::Internal)
    }

    fn active(&self, identity_id: &str) -> Result<bool, ApiError> {
        self.connection
            .lock()
            .map_err(|_| ApiError::Internal)?
            .query_row(
                "SELECT 1 FROM account
                 WHERE identity_id = ?1 AND deleted_at_ms IS NULL
                   AND suspended_at_ms IS NULL",
                [identity_id],
                |_| Ok(()),
            )
            .optional()
            .map(|value| value.is_some())
            .map_err(|_| ApiError::Internal)
    }

    fn delete(&self, identity_id: &str) -> Result<(), ApiError> {
        let changed = self
            .connection
            .lock()
            .map_err(|_| ApiError::Internal)?
            .execute(
                "DELETE FROM account
                 WHERE identity_id = ?1 AND deleted_at_ms IS NULL",
                [identity_id],
            )
            .map_err(|_| ApiError::Internal)?;
        if changed == 1 {
            Ok(())
        } else {
            Err(ApiError::NotFound)
        }
    }

    fn suspend(&self, identity_id: &str, case_id: &str, now_ms: u64) -> Result<(), ApiError> {
        let changed = self
            .connection
            .lock()
            .map_err(|_| ApiError::Internal)?
            .execute(
                "UPDATE account
                 SET suspended_at_ms = ?1, suspended_case_id = ?2
                 WHERE identity_id = ?3 AND deleted_at_ms IS NULL
                   AND suspended_at_ms IS NULL",
                params![
                    to_sql_i64(now_ms).map_err(|_| ApiError::Internal)?,
                    case_id,
                    identity_id
                ],
            )
            .map_err(|_| ApiError::Internal)?;
        if changed == 1 {
            Ok(())
        } else {
            Err(ApiError::Conflict)
        }
    }

    fn unsuspend_if_case(&self, identity_id: &str, case_id: &str) -> Result<bool, ApiError> {
        self.connection
            .lock()
            .map_err(|_| ApiError::Internal)?
            .execute(
                "UPDATE account
                 SET suspended_at_ms = NULL, suspended_case_id = NULL
                 WHERE identity_id = ?1 AND suspended_case_id = ?2
                   AND deleted_at_ms IS NULL",
                params![identity_id, case_id],
            )
            .map(|changed| changed == 1)
            .map_err(|_| ApiError::Internal)
    }

    fn suspension_case(&self, identity_id: &str) -> Result<Option<String>, ApiError> {
        self.connection
            .lock()
            .map_err(|_| ApiError::Internal)?
            .query_row(
                "SELECT suspended_case_id FROM account
                 WHERE identity_id = ?1 AND deleted_at_ms IS NULL",
                [identity_id],
                |row| row.get(0),
            )
            .optional()
            .map(|value| value.flatten())
            .map_err(|_| ApiError::Internal)
    }
}

struct AuthenticatedAccount {
    identity_id: String,
    suspended_case_id: Option<String>,
}

fn ensure_account_column(
    connection: &Connection,
    column_name: &str,
    column_type: &str,
) -> Result<(), String> {
    let mut statement = connection
        .prepare("PRAGMA table_info(account)")
        .map_err(|error| error.to_string())?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|error| error.to_string())?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    drop(statement);
    if columns.iter().any(|column| column == column_name) {
        return Ok(());
    }
    if !matches!(column_name, "suspended_at_ms" | "suspended_case_id")
        || !matches!(column_type, "INTEGER" | "TEXT")
    {
        return Err("unsupported account migration".to_owned());
    }
    connection
        .execute_batch(&format!(
            "ALTER TABLE account ADD COLUMN {column_name} {column_type};"
        ))
        .map_err(|error| error.to_string())
}

async fn health() -> Json<HealthResponse> {
    Json(HealthResponse { ok: true })
}

async fn project_info() -> Json<ProjectInfo> {
    Json(ProjectInfo {
        service: "Monero Enthusiast V1",
        privacy:
            "Public discovery catalogs are signed and searched locally. This API has no wallet, online-search, ranking, payment, exchange, or plaintext-chat endpoint.",
        version: env!("CARGO_PKG_VERSION"),
    })
}

async fn create_identity(
    State(state): State<ApiState>,
) -> Result<(StatusCode, Json<CreateIdentityResponse>), ApiError> {
    let (identity_id, access_token) = state.accounts.create(now_ms())?;
    Ok((
        StatusCode::CREATED,
        Json(CreateIdentityResponse {
            identity_id,
            access_token,
        }),
    ))
}

async fn account_status(
    State(state): State<ApiState>,
    headers: HeaderMap,
) -> Result<Json<AccountStatusResponse>, ApiError> {
    let account = authenticate_account(&state, &headers)?;
    Ok(Json(AccountStatusResponse {
        identity_id: account.identity_id,
        suspended: account.suspended_case_id.is_some(),
        suspension_case_id: account.suspended_case_id,
    }))
}

async fn contribute_query(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(request): Json<QueryContributionInput>,
) -> Result<(StatusCode, Json<QueryContributionReceipt>), ApiError> {
    let identity = authenticate_user(&state, &headers)?;
    let store = state
        .query_contributions
        .as_ref()
        .ok_or(ApiError::Unavailable)?;
    let receipt = store
        .contribute(&identity, &request, now_ms())
        .map_err(ApiError::from_query_contribution)?;
    Ok((StatusCode::ACCEPTED, Json(receipt)))
}

async fn delete_identity(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(request): Json<DeleteIdentityRequest>,
) -> Result<StatusCode, ApiError> {
    let identity = authenticate_account(&state, &headers)?.identity_id;
    if request.confirmation != "DELETE MY COMMUNITY PROFILE" {
        return Err(ApiError::BadRequest(
            "Enter the exact deletion confirmation.".to_owned(),
        ));
    }
    if let Some(matrix_user_id) = state
        .contacts
        .matrix_identity(&identity)
        .map_err(ApiError::from_contact)?
    {
        let lifecycle = state
            .matrix_lifecycle
            .as_ref()
            .ok_or(ApiError::Unavailable)?;
        lifecycle
            .deactivate_and_erase(matrix_user_id.as_str())
            .await
            .map_err(|_| ApiError::Unavailable)?;
    }
    state
        .publication
        .delete_owner(&identity, now_ms())
        .map_err(ApiError::from_publication)?;
    state
        .chat_reports
        .delete_reporter(&identity, now_ms())
        .map_err(ApiError::from_chat_report)?;
    state
        .contacts
        .delete_identity(&identity, now_ms())
        .map_err(ApiError::from_contact)?;
    state
        .notifications
        .remove_all_identity(&identity)
        .map_err(ApiError::from_notification)?;
    state.accounts.delete(&identity)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn provision_matrix_identity(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(mut request): Json<ProvisionMatrixRequest>,
) -> Result<(StatusCode, Json<ProvisionMatrixResponse>), ApiError> {
    let identity = authenticate_user(&state, &headers)?;
    let password = Zeroizing::new(std::mem::take(&mut request.password));
    validate_matrix_password(password.as_str()).map_err(ApiError::BadRequest)?;
    let provisioner = state
        .matrix_provisioner
        .as_ref()
        .ok_or(ApiError::Unavailable)?;
    // Provisioning is rare. Serializing this short administrative operation
    // closes the same-identity race without holding a SQLite lock over await.
    let _provisioning = state.matrix_provisioning.lock().await;
    if state
        .contacts
        .matrix_identity(&identity)
        .map_err(ApiError::from_contact)?
        .is_some()
    {
        return Err(ApiError::Conflict);
    }
    let account = provisioner
        .provision(&identity, password.as_str())
        .await
        .map_err(|_| ApiError::Unavailable)?;
    state
        .contacts
        .register_matrix_identity(&identity, &account.matrix_user_id, now_ms())
        .map_err(ApiError::from_contact)?;
    Ok((
        StatusCode::CREATED,
        Json(ProvisionMatrixResponse {
            matrix_user_id: account.matrix_user_id,
            homeserver: account.homeserver,
        }),
    ))
}

async fn submit_content(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(draft): Json<PublicContentDraft>,
) -> Result<(StatusCode, Json<PublicationRecord>), ApiError> {
    let identity = authenticate_user(&state, &headers)?;
    let record = state
        .publication
        .submit(&identity, draft, now_ms())
        .map_err(ApiError::from_publication)?;
    Ok((StatusCode::ACCEPTED, Json(record)))
}

async fn list_own_content(
    State(state): State<ApiState>,
    headers: HeaderMap,
) -> Result<Json<Vec<PublicationRecord>>, ApiError> {
    let identity = authenticate_user(&state, &headers)?;
    Ok(Json(
        state
            .publication
            .records_for_owner(&identity, 100)
            .map_err(ApiError::from_publication)?,
    ))
}

async fn resubmit_content(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path(public_id): Path<String>,
    Json(draft): Json<PublicContentDraft>,
) -> Result<(StatusCode, Json<PublicationRecord>), ApiError> {
    let identity = authenticate_user(&state, &headers)?;
    let record = state
        .publication
        .resubmit(&identity, &public_id, draft, now_ms())
        .map_err(ApiError::from_publication)?;
    Ok((StatusCode::ACCEPTED, Json(record)))
}

async fn content_status(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path(public_id): Path<String>,
) -> Result<Json<PublicationRecord>, ApiError> {
    let identity = authenticate_user(&state, &headers)?;
    let record = state
        .publication
        .latest(&public_id)
        .map_err(ApiError::from_publication)?;
    if record.owner_public_id != identity {
        return Err(ApiError::NotFound);
    }
    Ok(Json(record))
}

async fn withdraw_content(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path((public_id, revision)): Path<(String, u64)>,
) -> Result<StatusCode, ApiError> {
    let identity = authenticate_user(&state, &headers)?;
    state
        .publication
        .withdraw(&identity, &public_id, revision, now_ms())
        .map_err(ApiError::from_publication)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn report_content(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path((public_id, revision)): Path<(String, u64)>,
    Json(request): Json<ReportRequest>,
) -> Result<(StatusCode, Json<CaseResponse>), ApiError> {
    let identity = authenticate_user(&state, &headers)?;
    let case = state
        .publication
        .report(
            &identity,
            &public_id,
            revision,
            &request.reason,
            request.illegal_content_notice,
            now_ms(),
        )
        .map_err(ApiError::from_publication)?;
    Ok((
        StatusCode::ACCEPTED,
        Json(CaseResponse {
            case_id: case.case_id,
            status: case.status,
        }),
    ))
}

async fn appeal_case(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path(case_id): Path<String>,
    Json(request): Json<AppealRequest>,
) -> Result<StatusCode, ApiError> {
    let identity = authenticate_user(&state, &headers)?;
    state
        .publication
        .appeal(&identity, &case_id, &request.reason, now_ms())
        .map_err(ApiError::from_publication)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn moderation_outcomes(
    State(state): State<ApiState>,
    headers: HeaderMap,
) -> Result<Json<Vec<community_publication_core::ModerationOutcome>>, ApiError> {
    let identity = authenticate_user(&state, &headers)?;
    Ok(Json(
        state
            .publication
            .moderation_outcomes_for_actor(&identity, 100)
            .map_err(ApiError::from_publication)?,
    ))
}

async fn request_contact(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path(peer_id): Path<String>,
) -> Result<(StatusCode, Json<ContactRequest>), ApiError> {
    let identity = authenticate_user(&state, &headers)?;
    if !state.accounts.active(&peer_id)? {
        return Err(ApiError::NotFound);
    }
    let request = state
        .contacts
        .request(&identity, &peer_id, now_ms())
        .map_err(ApiError::from_contact)?;
    Ok((StatusCode::ACCEPTED, Json(request)))
}

async fn accepted_contacts(
    State(state): State<ApiState>,
    headers: HeaderMap,
) -> Result<Json<Vec<AcceptedContact>>, ApiError> {
    let identity = authenticate_user(&state, &headers)?;
    Ok(Json(
        state
            .contacts
            .accepted_for(&identity)
            .map_err(ApiError::from_contact)?,
    ))
}

async fn pending_contact_requests(
    State(state): State<ApiState>,
    headers: HeaderMap,
) -> Result<Json<Vec<ContactRequest>>, ApiError> {
    let identity = authenticate_user(&state, &headers)?;
    Ok(Json(
        state
            .contacts
            .pending_for(&identity)
            .map_err(ApiError::from_contact)?,
    ))
}

async fn accept_contact(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path(request_id): Path<String>,
) -> Result<Json<ContactRequest>, ApiError> {
    let identity = authenticate_user(&state, &headers)?;
    Ok(Json(
        state
            .contacts
            .respond(&identity, &request_id, true, now_ms())
            .map_err(ApiError::from_contact)?,
    ))
}

async fn decline_contact(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path(request_id): Path<String>,
) -> Result<StatusCode, ApiError> {
    let identity = authenticate_user(&state, &headers)?;
    state
        .contacts
        .respond(&identity, &request_id, false, now_ms())
        .map_err(ApiError::from_contact)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn resolve_contact(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path(peer_id): Path<String>,
) -> Result<Json<AcceptedContact>, ApiError> {
    let identity = authenticate_user(&state, &headers)?;
    Ok(Json(
        state
            .contacts
            .resolve_accepted(&identity, &peer_id)
            .map_err(ApiError::from_contact)?,
    ))
}

async fn block_contact(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path(peer_id): Path<String>,
) -> Result<StatusCode, ApiError> {
    let identity = authenticate_user(&state, &headers)?;
    state
        .contacts
        .block(&identity, &peer_id, now_ms())
        .map_err(ApiError::from_contact)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn report_selected_chat_message(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path(peer_id): Path<String>,
    Json(report): Json<VoluntaryChatReport>,
) -> Result<(StatusCode, Json<ChatReportReceipt>), ApiError> {
    let identity = authenticate_user(&state, &headers)?;
    let accepted = state
        .contacts
        .resolve_accepted(&identity, &peer_id)
        .map_err(ApiError::from_contact)?;
    if accepted.matrix_user_id != report.selected_message.sender_id {
        // Hide whether the supplied Matrix identifier belongs to somebody
        // else. A selected-message report is valid only for this accepted
        // peer and never for arbitrary Matrix users.
        return Err(ApiError::NotFound);
    }
    let receipt = state
        .chat_reports
        .submit(&identity, &peer_id, &report, now_ms())
        .map_err(ApiError::from_chat_report)?;
    Ok((StatusCode::ACCEPTED, Json(receipt)))
}

async fn chat_report_outcome(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path(case_id): Path<String>,
) -> Result<Json<ChatReportOutcome>, ApiError> {
    let account = authenticate_account(&state, &headers)?;
    Ok(Json(
        state
            .chat_reports
            .outcome_for_actor(&case_id, &account.identity_id)
            .map_err(ApiError::from_chat_report)?,
    ))
}

async fn appeal_chat_report(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path(case_id): Path<String>,
    Json(request): Json<AppealRequest>,
) -> Result<StatusCode, ApiError> {
    let account = authenticate_account(&state, &headers)?;
    if account.suspended_case_id.as_deref() != Some(case_id.as_str()) {
        return Err(ApiError::NotFound);
    }
    state
        .chat_reports
        .appeal(&case_id, &account.identity_id, &request.reason, now_ms())
        .map_err(ApiError::from_chat_report)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn register_notification(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(request): Json<RegisterNotificationRequest>,
) -> Result<(StatusCode, Json<NotificationRegistration>), ApiError> {
    let identity = authenticate_user(&state, &headers)?;
    let registration = state
        .notifications
        .register_identity(
            &identity,
            &request.installation_id,
            request.provider,
            &request.token,
            now_ms(),
        )
        .map_err(ApiError::from_notification)?;
    Ok((StatusCode::CREATED, Json(registration)))
}

async fn notification_registrations(
    State(state): State<ApiState>,
    headers: HeaderMap,
) -> Result<Json<Vec<NotificationRegistration>>, ApiError> {
    let identity = authenticate_user(&state, &headers)?;
    Ok(Json(
        state
            .notifications
            .identity_registrations(&identity)
            .map_err(ApiError::from_notification)?,
    ))
}

async fn remove_notification(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path(installation_id): Path<String>,
) -> Result<StatusCode, ApiError> {
    let identity = authenticate_user(&state, &headers)?;
    if !state
        .notifications
        .remove_identity(&identity, &installation_id)
        .map_err(ApiError::from_notification)?
    {
        return Err(ApiError::NotFound);
    }
    Ok(StatusCode::NO_CONTENT)
}

async fn internal_record_screening(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path((public_id, revision)): Path<(String, u64)>,
    Json(request): Json<ScreeningRequest>,
) -> Result<(StatusCode, Json<CaseResponse>), ApiError> {
    authenticate_internal(&state, &headers)?;
    let case = state
        .publication
        .record_screening(
            &public_id,
            revision,
            &ScreeningAssessment {
                model_version: request.model_version,
                rules_version: request.rules_version,
                confidence: request.confidence,
                triggered_policy: request.triggered_policy,
                outcome: request.outcome.into_core(),
                optional_wording_suggestion: request.optional_wording_suggestion,
            },
            now_ms(),
        )
        .map_err(ApiError::from_publication)?;
    Ok((
        StatusCode::ACCEPTED,
        Json(CaseResponse {
            case_id: case.case_id,
            status: case.status,
        }),
    ))
}

async fn internal_moderate(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path(case_id): Path<String>,
    Json(request): Json<ModerationDecisionRequest>,
) -> Result<Json<PublicationRecord>, ApiError> {
    authenticate_internal(&state, &headers)?;
    let record = state
        .publication
        .moderate(
            &case_id,
            &request.moderator_id,
            request.decision.into_core(),
            &request.reason,
            now_ms(),
        )
        .map_err(ApiError::from_publication)?;
    Ok(Json(record))
}

async fn internal_moderation_queue(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Query(query): Query<ModerationQueueQuery>,
) -> Result<Json<Vec<ModerationQueueCase>>, ApiError> {
    authenticate_internal(&state, &headers)?;
    Ok(Json(
        state
            .publication
            .moderation_queue(query.limit.unwrap_or(50))
            .map_err(ApiError::from_publication)?,
    ))
}

async fn internal_acknowledge_moderation(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path(case_id): Path<String>,
    Json(request): Json<ModerationAcknowledgeRequest>,
) -> Result<StatusCode, ApiError> {
    authenticate_internal(&state, &headers)?;
    state
        .publication
        .acknowledge_moderation_case(&case_id, &request.moderator_id, now_ms())
        .map_err(ApiError::from_publication)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn internal_chat_report_queue(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Query(query): Query<ModerationQueueQuery>,
) -> Result<Json<Vec<ChatReportQueueCase>>, ApiError> {
    authenticate_internal(&state, &headers)?;
    Ok(Json(
        state
            .chat_reports
            .queue(query.limit.unwrap_or(50))
            .map_err(ApiError::from_chat_report)?,
    ))
}

async fn internal_acknowledge_chat_report(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path(case_id): Path<String>,
    Json(request): Json<ModerationAcknowledgeRequest>,
) -> Result<StatusCode, ApiError> {
    authenticate_internal(&state, &headers)?;
    state
        .chat_reports
        .acknowledge(&case_id, &request.moderator_id, now_ms())
        .map_err(ApiError::from_chat_report)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn internal_decide_chat_report(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path(case_id): Path<String>,
    Json(request): Json<ChatReportDecisionRequest>,
) -> Result<StatusCode, ApiError> {
    authenticate_internal(&state, &headers)?;
    let _actions = state.moderation_actions.lock().await;
    let peer_id = state
        .chat_reports
        .reported_peer(&case_id)
        .map_err(ApiError::from_chat_report)?;
    let existing_suspension = state.accounts.suspension_case(&peer_id)?;
    if existing_suspension
        .as_deref()
        .is_some_and(|value| value != case_id)
    {
        return Err(ApiError::Conflict);
    }
    let decision = request.decision.into_core();
    let should_suspend = decision == ChatReportDecision::SuspendSender;
    let was_suspended = existing_suspension.as_deref() == Some(case_id.as_str());
    let matrix_user_id = if should_suspend || was_suspended {
        Some(
            state
                .contacts
                .matrix_identity(&peer_id)
                .map_err(ApiError::from_contact)?
                .ok_or(ApiError::Unavailable)?,
        )
    } else {
        None
    };
    let lifecycle = if matrix_user_id.is_some() {
        Some(
            state
                .matrix_lifecycle
                .as_ref()
                .ok_or(ApiError::Unavailable)?,
        )
    } else {
        None
    };
    let now = now_ms();
    let mut changed_suspension = false;

    if should_suspend && !was_suspended {
        lifecycle
            .expect("lifecycle exists with Matrix identity")
            .set_locked(
                matrix_user_id
                    .as_deref()
                    .expect("Matrix identity exists for suspension"),
                true,
            )
            .await
            .map_err(|_| ApiError::Unavailable)?;
        if let Err(error) = state.accounts.suspend(&peer_id, &case_id, now) {
            let _ = lifecycle
                .expect("lifecycle exists with Matrix identity")
                .set_locked(
                    matrix_user_id
                        .as_deref()
                        .expect("Matrix identity exists for suspension rollback"),
                    false,
                )
                .await;
            return Err(error);
        }
        changed_suspension = true;
    } else if !should_suspend && was_suspended {
        lifecycle
            .expect("lifecycle exists with Matrix identity")
            .set_locked(
                matrix_user_id
                    .as_deref()
                    .expect("Matrix identity exists for reinstatement"),
                false,
            )
            .await
            .map_err(|_| ApiError::Unavailable)?;
        if !state.accounts.unsuspend_if_case(&peer_id, &case_id)? {
            let _ = lifecycle
                .expect("lifecycle exists with Matrix identity")
                .set_locked(
                    matrix_user_id
                        .as_deref()
                        .expect("Matrix identity exists for reinstatement rollback"),
                    true,
                )
                .await;
            return Err(ApiError::Conflict);
        }
        changed_suspension = true;
    }

    let result = state
        .chat_reports
        .decide(
            &case_id,
            &request.moderator_id,
            decision,
            &request.reason,
            now,
        )
        .map_err(ApiError::from_chat_report);
    if let Err(error) = result {
        if changed_suspension {
            if should_suspend {
                let _ = state.accounts.unsuspend_if_case(&peer_id, &case_id);
                let _ = lifecycle
                    .expect("lifecycle exists with Matrix identity")
                    .set_locked(
                        matrix_user_id
                            .as_deref()
                            .expect("Matrix identity exists for rollback"),
                        false,
                    )
                    .await;
            } else {
                let _ = lifecycle
                    .expect("lifecycle exists with Matrix identity")
                    .set_locked(
                        matrix_user_id
                            .as_deref()
                            .expect("Matrix identity exists for rollback"),
                        true,
                    )
                    .await;
                let _ = state.accounts.suspend(&peer_id, &case_id, now);
            }
        }
        return Err(error);
    }
    Ok(StatusCode::NO_CONTENT)
}

async fn internal_publish(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path((public_id, revision)): Path<(String, u64)>,
    Json(request): Json<PublishRequest>,
) -> Result<Json<PublicationRecord>, ApiError> {
    authenticate_internal(&state, &headers)?;
    let record = state
        .publication
        .publish_with_embedding_chunks(
            &public_id,
            revision,
            &request.model,
            &request.embedding,
            &request.embedding_chunks,
            now_ms(),
        )
        .map_err(ApiError::from_publication)?;
    Ok(Json(record))
}

async fn internal_run_scheduled(
    State(state): State<ApiState>,
    headers: HeaderMap,
) -> Result<Json<ScheduledResponse>, ApiError> {
    authenticate_internal(&state, &headers)?;
    let actions = state
        .publication
        .run_scheduled(now_ms())
        .map_err(ApiError::from_publication)?;
    Ok(Json(ScheduledResponse {
        actions: actions
            .into_iter()
            .map(ScheduledActionResponse::from)
            .collect(),
    }))
}

async fn internal_acknowledge_scheduled_delivery(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path(delivery_id): Path<String>,
    Json(request): Json<ScheduledDeliveryAcknowledgeRequest>,
) -> Result<StatusCode, ApiError> {
    authenticate_internal(&state, &headers)?;
    state
        .publication
        .acknowledge_scheduled_delivery(&delivery_id, &request.actor_id, now_ms())
        .map_err(ApiError::from_publication)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn internal_register_matrix_identity(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path(identity_id): Path<String>,
    Json(request): Json<RegisterMatrixIdentityRequest>,
) -> Result<StatusCode, ApiError> {
    authenticate_internal(&state, &headers)?;
    if !state.accounts.active(&identity_id)? {
        return Err(ApiError::NotFound);
    }
    state
        .contacts
        .register_matrix_identity(&identity_id, &request.matrix_user_id, now_ms())
        .map_err(ApiError::from_contact)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn internal_register_administrator_notification(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path(administrator_id): Path<String>,
    Json(request): Json<RegisterNotificationRequest>,
) -> Result<(StatusCode, Json<NotificationRegistration>), ApiError> {
    authenticate_internal(&state, &headers)?;
    let registration = state
        .notifications
        .register_administrator(
            &administrator_id,
            &request.installation_id,
            request.provider,
            &request.token,
            now_ms(),
        )
        .map_err(ApiError::from_notification)?;
    Ok((StatusCode::CREATED, Json(registration)))
}

async fn internal_query_contribution_candidates(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Query(query): Query<QueryContributionCandidateQuery>,
) -> Result<Json<Vec<QueryContributionCandidate>>, ApiError> {
    authenticate_internal(&state, &headers)?;
    let store = state
        .query_contributions
        .as_ref()
        .ok_or(ApiError::Unavailable)?;
    let candidates = store
        .review_candidates(query.limit.unwrap_or(100), now_ms())
        .map_err(ApiError::from_query_contribution)?;
    Ok(Json(candidates))
}

async fn internal_decide_query_contribution(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path(query_id): Path<String>,
    Json(request): Json<QueryContributionDecisionRequest>,
) -> Result<StatusCode, ApiError> {
    authenticate_internal(&state, &headers)?;
    let store = state
        .query_contributions
        .as_ref()
        .ok_or(ApiError::Unavailable)?;
    store
        .moderate(
            &query_id,
            &request.moderator_id,
            &request.reason,
            request.decision,
            request.embedding.as_deref(),
            now_ms(),
        )
        .map_err(ApiError::from_query_contribution)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn internal_query_catalog_delta(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Query(query): Query<QueryCatalogDeltaQuery>,
) -> Result<Json<community_search_core::QueryCatalogPayload>, ApiError> {
    authenticate_internal(&state, &headers)?;
    let store = state
        .query_contributions
        .as_ref()
        .ok_or(ApiError::Unavailable)?;
    let payload = store
        .catalog_delta(
            &query.catalog_scope_id,
            query.from_sequence,
            query.to_sequence,
            query.limit.unwrap_or(10_000),
        )
        .map_err(ApiError::from_query_contribution)?;
    Ok(Json(payload))
}

async fn internal_acknowledge_query_catalog(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(request): Json<QueryCatalogAcknowledgeRequest>,
) -> Result<StatusCode, ApiError> {
    authenticate_internal(&state, &headers)?;
    let store = state
        .query_contributions
        .as_ref()
        .ok_or(ApiError::Unavailable)?;
    store
        .acknowledge_published(&request.query_ids, request.sequence, now_ms())
        .map_err(ApiError::from_query_contribution)?;
    Ok(StatusCode::NO_CONTENT)
}

fn authenticate_user(state: &ApiState, headers: &HeaderMap) -> Result<String, ApiError> {
    let account = authenticate_account(state, headers)?;
    if account.suspended_case_id.is_some() {
        return Err(ApiError::Suspended);
    }
    Ok(account.identity_id)
}

fn authenticate_account(
    state: &ApiState,
    headers: &HeaderMap,
) -> Result<AuthenticatedAccount, ApiError> {
    let token = bearer_token(headers).ok_or(ApiError::Unauthorized)?;
    let account = state
        .accounts
        .authenticate(token)?
        .ok_or(ApiError::Unauthorized)?;
    if !state.limiter.allow(&account.identity_id, now_ms()) {
        return Err(ApiError::RateLimited);
    }
    Ok(account)
}

fn authenticate_internal(state: &ApiState, headers: &HeaderMap) -> Result<(), ApiError> {
    let token = bearer_token(headers).ok_or(ApiError::Unauthorized)?;
    let candidate: [u8; 32] = Sha256::digest(token.as_bytes()).into();
    if bool::from(candidate.ct_eq(&state.internal_token_hash)) {
        Ok(())
    } else {
        Err(ApiError::Unauthorized)
    }
}

fn bearer_token(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(AUTHORIZATION)?
        .to_str()
        .ok()?
        .strip_prefix("Bearer ")
}

#[derive(Default)]
struct RateLimiter {
    requests: Mutex<HashMap<String, VecDeque<u64>>>,
}

impl RateLimiter {
    fn allow(&self, identity: &str, now_ms: u64) -> bool {
        let Ok(mut requests) = self.requests.lock() else {
            return false;
        };
        let entries = requests.entry(identity.to_owned()).or_default();
        while entries
            .front()
            .is_some_and(|timestamp| now_ms.saturating_sub(*timestamp) > RATE_LIMIT_WINDOW_MS)
        {
            entries.pop_front();
        }
        if entries.len() >= RATE_LIMIT_REQUESTS {
            return false;
        }
        entries.push_back(now_ms);
        true
    }
}

#[derive(Debug)]
enum ApiError {
    BadRequest(String),
    Unauthorized,
    Suspended,
    NotFound,
    Conflict,
    RateLimited,
    Unavailable,
    Internal,
}

impl ApiError {
    fn from_query_contribution(error: QueryContributionError) -> Self {
        match error {
            QueryContributionError::Invalid(message) => Self::BadRequest(message),
            QueryContributionError::NotFound => Self::NotFound,
            QueryContributionError::InvalidState => Self::Conflict,
            QueryContributionError::Storage => Self::Internal,
        }
    }

    fn from_publication(error: PublicationError) -> Self {
        match error {
            PublicationError::Invalid(message) => Self::BadRequest(message),
            PublicationError::NotFound => Self::NotFound,
            PublicationError::InvalidState => Self::Conflict,
            PublicationError::Unauthorized => Self::NotFound,
            PublicationError::Storage(_) | PublicationError::Encryption => Self::Internal,
        }
    }

    fn from_contact(error: ContactError) -> Self {
        match error {
            ContactError::Invalid(message) => Self::BadRequest(message),
            ContactError::NotFound | ContactError::Unauthorized => Self::NotFound,
            ContactError::Conflict => Self::Conflict,
            ContactError::Storage(_) | ContactError::Encryption => Self::Internal,
        }
    }

    fn from_notification(error: NotificationError) -> Self {
        match error {
            NotificationError::Invalid(message) => Self::BadRequest(message),
            NotificationError::NotFound => Self::NotFound,
            NotificationError::Storage(_) | NotificationError::Encryption => Self::Internal,
        }
    }

    fn from_chat_report(error: ChatReportError) -> Self {
        match error {
            ChatReportError::Invalid(message) => Self::BadRequest(message),
            ChatReportError::NotFound => Self::NotFound,
            ChatReportError::Conflict => Self::Conflict,
            ChatReportError::Storage | ChatReportError::Encryption => Self::Internal,
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, code, message) = match self {
            Self::BadRequest(message) => (StatusCode::BAD_REQUEST, "bad_request", message),
            Self::Unauthorized => (
                StatusCode::UNAUTHORIZED,
                "unauthorized",
                "The access credential is invalid.".to_owned(),
            ),
            Self::Suspended => (
                StatusCode::FORBIDDEN,
                "community_suspended",
                "This Community profile is temporarily suspended. You can still view the decision, appeal it, or delete the profile.".to_owned(),
            ),
            Self::NotFound => (
                StatusCode::NOT_FOUND,
                "not_found",
                "The requested record was not found.".to_owned(),
            ),
            Self::Conflict => (
                StatusCode::CONFLICT,
                "invalid_state",
                "The requested action is not available in the current state.".to_owned(),
            ),
            Self::RateLimited => (
                StatusCode::TOO_MANY_REQUESTS,
                "rate_limited",
                "Please wait before trying again.".to_owned(),
            ),
            Self::Unavailable => (
                StatusCode::SERVICE_UNAVAILABLE,
                "temporarily_unavailable",
                "The requested Community operation is temporarily unavailable.".to_owned(),
            ),
            Self::Internal => (
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal_error",
                "The Community service could not complete the request.".to_owned(),
            ),
        };
        (status, Json(ErrorResponse { code, message })).into_response()
    }
}

#[derive(Serialize)]
struct HealthResponse {
    ok: bool,
}

#[derive(Serialize)]
struct ProjectInfo {
    service: &'static str,
    privacy: &'static str,
    version: &'static str,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateIdentityResponse {
    identity_id: String,
    access_token: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AccountStatusResponse {
    identity_id: String,
    suspended: bool,
    suspension_case_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DeleteIdentityRequest {
    confirmation: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ProvisionMatrixRequest {
    password: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProvisionMatrixResponse {
    matrix_user_id: String,
    homeserver: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ReportRequest {
    reason: String,
    #[serde(default)]
    illegal_content_notice: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AppealRequest {
    reason: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct RegisterMatrixIdentityRequest {
    matrix_user_id: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct RegisterNotificationRequest {
    installation_id: String,
    provider: ProviderKind,
    token: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CaseResponse {
    case_id: String,
    status: String,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
enum ScreeningOutcomeRequest {
    Clear,
    WordingOnly,
    Ambiguous,
    DangerousOrProhibited,
}

impl ScreeningOutcomeRequest {
    fn into_core(self) -> ScreeningOutcome {
        match self {
            Self::Clear => ScreeningOutcome::Clear,
            Self::WordingOnly => ScreeningOutcome::WordingOnly,
            Self::Ambiguous => ScreeningOutcome::Ambiguous,
            Self::DangerousOrProhibited => ScreeningOutcome::DangerousOrProhibited,
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ScreeningRequest {
    model_version: String,
    rules_version: String,
    confidence: f32,
    triggered_policy: String,
    outcome: ScreeningOutcomeRequest,
    optional_wording_suggestion: Option<String>,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
enum ModeratorDecisionRequestValue {
    Approve,
    Reject,
    KeepVisible,
    Hide,
    Remove,
    Reinstate,
}

impl ModeratorDecisionRequestValue {
    fn into_core(self) -> ModeratorDecision {
        match self {
            Self::Approve => ModeratorDecision::Approve,
            Self::Reject => ModeratorDecision::Reject,
            Self::KeepVisible => ModeratorDecision::KeepVisible,
            Self::Hide => ModeratorDecision::Hide,
            Self::Remove => ModeratorDecision::Remove,
            Self::Reinstate => ModeratorDecision::Reinstate,
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ModerationDecisionRequest {
    moderator_id: String,
    decision: ModeratorDecisionRequestValue,
    reason: String,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
enum ChatReportDecisionRequestValue {
    Dismiss,
    WarnSender,
    SuspendSender,
}

impl ChatReportDecisionRequestValue {
    fn into_core(self) -> ChatReportDecision {
        match self {
            Self::Dismiss => ChatReportDecision::Dismiss,
            Self::WarnSender => ChatReportDecision::WarnSender,
            Self::SuspendSender => ChatReportDecision::SuspendSender,
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ChatReportDecisionRequest {
    moderator_id: String,
    decision: ChatReportDecisionRequestValue,
    reason: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ModerationQueueQuery {
    limit: Option<usize>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct QueryContributionCandidateQuery {
    limit: Option<usize>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct QueryContributionDecisionRequest {
    moderator_id: String,
    decision: QueryModerationDecision,
    reason: String,
    #[serde(default)]
    embedding: Option<Vec<f32>>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct QueryCatalogDeltaQuery {
    catalog_scope_id: String,
    from_sequence: u64,
    to_sequence: u64,
    limit: Option<usize>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct QueryCatalogAcknowledgeRequest {
    sequence: u64,
    query_ids: Vec<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ModerationAcknowledgeRequest {
    moderator_id: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ScheduledDeliveryAcknowledgeRequest {
    actor_id: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct PublishRequest {
    model: ModelContract,
    embedding: Vec<f32>,
    #[serde(default)]
    embedding_chunks: Vec<CatalogEmbeddingChunk>,
}

#[derive(Serialize)]
#[serde(tag = "action", rename_all = "snake_case")]
enum ScheduledActionResponse {
    ListingExpiryReminder {
        delivery_id: String,
        public_id: String,
        revision: u64,
        owner_public_id: String,
    },
    ListingExpired {
        public_id: String,
        revision: u64,
    },
    ModerationQueueAlert {
        delivery_id: String,
        case_id: String,
    },
    ModerationOverdue {
        delivery_id: String,
        case_id: String,
    },
    ModerationOutcomeNotice {
        delivery_id: String,
        case_id: String,
        recipient_public_id: String,
    },
}

impl From<ScheduledAction> for ScheduledActionResponse {
    fn from(value: ScheduledAction) -> Self {
        match value {
            ScheduledAction::ListingExpiryReminder {
                delivery_id,
                public_id,
                revision,
                owner_public_id,
            } => Self::ListingExpiryReminder {
                delivery_id,
                public_id,
                revision,
                owner_public_id,
            },
            ScheduledAction::ListingExpired {
                public_id,
                revision,
            } => Self::ListingExpired {
                public_id,
                revision,
            },
            ScheduledAction::ModerationQueueAlert {
                delivery_id,
                case_id,
            } => Self::ModerationQueueAlert {
                delivery_id,
                case_id,
            },
            ScheduledAction::ModerationOverdue {
                delivery_id,
                case_id,
            } => Self::ModerationOverdue {
                delivery_id,
                case_id,
            },
            ScheduledAction::ModerationOutcomeNotice {
                delivery_id,
                case_id,
                recipient_public_id,
            } => Self::ModerationOutcomeNotice {
                delivery_id,
                case_id,
                recipient_public_id,
            },
        }
    }
}

#[derive(Serialize)]
struct ScheduledResponse {
    actions: Vec<ScheduledActionResponse>,
}

#[derive(Serialize)]
struct ErrorResponse {
    code: &'static str,
    message: String,
}

fn random_id(prefix: &str) -> String {
    let mut bytes = [0u8; 16];
    OsRng.fill_bytes(&mut bytes);
    format!("{prefix}_{}", hex::encode(bytes))
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

fn to_sql_i64(value: u64) -> Result<i64, ()> {
    i64::try_from(value).map_err(|_| ())
}

fn validate_private_origin(value: &str) -> Result<Url, String> {
    let url = Url::parse(value).map_err(|_| "Matrix admin origin is invalid".to_owned())?;
    let loopback_http =
        url.scheme() == "http" && matches!(url.host_str(), Some("127.0.0.1" | "::1" | "localhost"));
    if (url.scheme() != "https" && !loopback_http)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
    {
        return Err("Matrix admin origin must be HTTPS or loopback HTTP".to_owned());
    }
    Ok(url)
}

fn validate_public_homeserver(value: &str) -> Result<Url, String> {
    let url = Url::parse(value).map_err(|_| "Matrix homeserver is invalid".to_owned())?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
    {
        return Err("Matrix homeserver must be an HTTPS origin".to_owned());
    }
    Ok(url)
}

fn validate_matrix_server_name(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 255
        || value.bytes().any(|byte| {
            !(byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b':' | b'[' | b']'))
        })
        || Url::parse(&format!("https://{value}/"))
            .ok()
            .and_then(|url| url.host_str().map(str::to_owned))
            .is_none()
    {
        return Err("Matrix server name is invalid".to_owned());
    }
    Ok(())
}

fn validate_matrix_password(value: &str) -> Result<(), String> {
    if !(32..=256).contains(&value.len())
        || value.chars().any(char::is_whitespace)
        || value.chars().any(char::is_control)
    {
        return Err(
            "Matrix device password must contain 32 to 256 characters without whitespace"
                .to_owned(),
        );
    }
    Ok(())
}

fn load_bounded_secret(path: &FilePath) -> Result<Zeroizing<String>, String> {
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|_| "Matrix admin token is unavailable".to_owned())?;
    if metadata.file_type().is_symlink()
        || !metadata.file_type().is_file()
        || metadata.len() > 16_384
    {
        return Err("Matrix admin token must be a bounded regular file".to_owned());
    }
    let value = std::fs::read_to_string(path)
        .map_err(|_| "Matrix admin token could not be read".to_owned())?;
    let value = value.trim();
    if value.len() < 32 || value.len() > 16_384 || value.chars().any(char::is_whitespace) {
        return Err("Matrix admin token is invalid".to_owned());
    }
    Ok(Zeroizing::new(value.to_owned()))
}

pub fn parse_hex_32(value: &str, label: &str) -> Result<[u8; 32], String> {
    let decoded = hex::decode(value.trim()).map_err(|_| format!("{label} must be hexadecimal"))?;
    decoded
        .try_into()
        .map_err(|_| format!("{label} must contain exactly 32 bytes"))
}
