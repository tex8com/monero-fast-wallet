//! Native Matrix E2EE boundary for Monero Enthusiast V1.

use matrix_sdk::{
    config::SyncSettings,
    encryption::{recovery::RecoveryState, EncryptionSettings},
    room::MessagesOptions,
    ruma::{
        events::{
            room::message::{MessageType, RoomMessageEventContent},
            AnySyncMessageLikeEvent, AnySyncTimelineEvent, SyncMessageLikeEvent,
        },
        EventId, OwnedEventId, OwnedRoomId, OwnedUserId, RoomId, UserId,
    },
    Client, Room,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, VecDeque},
    path::Path,
    sync::{Mutex, MutexGuard},
    time::{Duration, Instant},
};
use thiserror::Error;
use url::Url;
use zeroize::Zeroizing;

const MAX_MESSAGE_CHARACTERS: usize = 2_000;
const MAX_SESSION_JSON_BYTES: usize = 64 * 1024;
const SHORT_RATE_WINDOW: Duration = Duration::from_secs(10);
const LONG_RATE_WINDOW: Duration = Duration::from_secs(60 * 60);
const SHORT_RATE_LIMIT: usize = 5;
const LONG_RATE_LIMIT: usize = 60;
const MAX_PAGE_SIZE: usize = 100;
const MAX_PAGINATION_TOKEN_BYTES: usize = 4_096;

#[derive(Debug, Error)]
pub enum MatrixCoreError {
    #[error("Matrix configuration is invalid: {0}")]
    InvalidConfiguration(String),
    #[error("Matrix input is invalid: {0}")]
    InvalidInput(String),
    #[error("Matrix session is unavailable")]
    SessionUnavailable,
    #[error("Matrix room is not an encrypted one-to-one chat")]
    UnsafeRoom,
    #[error("Please wait before sending another message")]
    RateLimited,
    #[error("Matrix operation failed")]
    Matrix,
    #[error("Matrix local state is unavailable")]
    LockUnavailable,
}

pub type Result<T> = std::result::Result<T, MatrixCoreError>;

#[derive(Clone, Debug)]
pub struct MatrixClientConfig<'a> {
    pub homeserver: &'a str,
    /// SOCKS5h keeps the Onion hostname and destination inside Tor.
    pub proxy: Option<&'a str>,
    pub store_path: &'a Path,
    /// Random text generated and retained in native OS secure storage.
    pub store_passphrase: &'a str,
    /// HTTP is accepted only for Tor v3 Onion services or explicit loopback
    /// test configurations.
    pub allow_loopback_http_for_tests: bool,
}

pub struct MatrixE2eeClient {
    client: Client,
    send_limits: Mutex<HashMap<OwnedRoomId, VecDeque<Instant>>>,
}

pub struct MatrixLogin {
    pub client: MatrixE2eeClient,
    /// Persist only in native OS secure storage.
    pub session_json: Zeroizing<Vec<u8>>,
}

impl MatrixE2eeClient {
    pub async fn login(
        config: MatrixClientConfig<'_>,
        matrix_user_id: &str,
        password: &str,
        device_display_name: &str,
    ) -> Result<MatrixLogin> {
        validate_config(&config)?;
        let matrix_user_id: OwnedUserId = UserId::parse(matrix_user_id)
            .map_err(|_| MatrixCoreError::InvalidInput("Matrix user ID is invalid".to_owned()))?;
        validate_password(password)?;
        validate_device_name(device_display_name)?;
        let client = build_client(&config).await?;
        client
            .matrix_auth()
            .login_username(matrix_user_id.as_str(), password)
            .initial_device_display_name(device_display_name)
            .request_refresh_token()
            .send()
            .await
            .map_err(|_| MatrixCoreError::SessionUnavailable)?;
        let session = client
            .matrix_auth()
            .session()
            .ok_or(MatrixCoreError::SessionUnavailable)?;
        let session_json = serde_json::to_vec(&session)
            .map(Zeroizing::new)
            .map_err(|_| MatrixCoreError::SessionUnavailable)?;
        Ok(MatrixLogin {
            client: Self::from_client(client),
            session_json,
        })
    }

    pub async fn restore(config: MatrixClientConfig<'_>, session_json: &[u8]) -> Result<Self> {
        validate_config(&config)?;
        if session_json.is_empty() || session_json.len() > MAX_SESSION_JSON_BYTES {
            return Err(MatrixCoreError::InvalidInput(
                "session envelope length is invalid".to_owned(),
            ));
        }
        let session: matrix_sdk::authentication::matrix::MatrixSession =
            serde_json::from_slice(session_json)
                .map_err(|_| MatrixCoreError::SessionUnavailable)?;
        let client = build_client(&config).await?;
        client
            .restore_session(session)
            .await
            .map_err(|_| MatrixCoreError::SessionUnavailable)?;
        Ok(Self::from_client(client))
    }

    /// Re-export after login or token refresh and persist only through native
    /// secure storage. The JSON contains Matrix access credentials.
    pub fn session_json(&self) -> Result<Zeroizing<Vec<u8>>> {
        let session = self
            .client
            .matrix_auth()
            .session()
            .ok_or(MatrixCoreError::SessionUnavailable)?;
        serde_json::to_vec(&session)
            .map(Zeroizing::new)
            .map_err(|_| MatrixCoreError::SessionUnavailable)
    }

    pub async fn logout(&self) -> Result<()> {
        self.client
            .matrix_auth()
            .logout()
            .await
            .map_err(|_| MatrixCoreError::Matrix)?;
        Ok(())
    }

    fn from_client(client: Client) -> Self {
        Self {
            client,
            send_limits: Mutex::new(HashMap::new()),
        }
    }

    /// Performs one bounded sync. Applications schedule this from their native
    /// lifecycle and use generic pushes only as a wake signal.
    pub async fn sync_once(&self, timeout: Duration) -> Result<()> {
        let timeout = timeout.clamp(Duration::from_secs(1), Duration::from_secs(30));
        self.client
            .sync_once(SyncSettings::default().timeout(timeout))
            .await
            .map_err(|_| MatrixCoreError::Matrix)?;
        Ok(())
    }

    pub async fn create_or_get_direct_room(&self, peer: &str) -> Result<OwnedRoomId> {
        let peer: OwnedUserId = UserId::parse(peer)
            .map_err(|_| MatrixCoreError::InvalidInput("peer ID is invalid".to_owned()))?;
        if self.client.user_id().is_some_and(|own| own == peer) {
            return Err(MatrixCoreError::InvalidInput(
                "a direct room requires another user".to_owned(),
            ));
        }
        let room = if let Some(room) = self.client.get_dm_room(&peer) {
            room
        } else {
            self.client
                .create_dm(&peer)
                .await
                .map_err(|_| MatrixCoreError::Matrix)?
        };
        self.require_safe_direct_room(&room).await?;
        Ok(room.room_id().to_owned())
    }

    pub async fn send_text(&self, room_id: &str, body: &str) -> Result<OwnedEventId> {
        validate_message(body)?;
        let room = self.room(room_id)?;
        self.require_safe_direct_room(&room).await?;
        self.reserve_send(room.room_id())?;
        let response = room
            .send(RoomMessageEventContent::text_plain(body))
            .await
            .map_err(|_| MatrixCoreError::Matrix)?;
        Ok(response.response.event_id)
    }

    pub async fn text_messages(
        &self,
        room_id: &str,
        from: Option<&str>,
        limit: usize,
    ) -> Result<MatrixMessagePage> {
        if limit == 0 || limit > MAX_PAGE_SIZE {
            return Err(MatrixCoreError::InvalidInput(
                "message page size must be between 1 and 100".to_owned(),
            ));
        }
        if from.is_some_and(|value| {
            value.is_empty()
                || value.len() > MAX_PAGINATION_TOKEN_BYTES
                || value.chars().any(char::is_control)
        }) {
            return Err(MatrixCoreError::InvalidInput(
                "message pagination token is invalid".to_owned(),
            ));
        }
        let room = self.room(room_id)?;
        self.require_safe_direct_room(&room).await?;
        let mut options = MessagesOptions::backward().from(from);
        options.limit = limit.try_into().map_err(|_| {
            MatrixCoreError::InvalidInput("message page size is invalid".to_owned())
        })?;
        let page = room
            .messages(options)
            .await
            .map_err(|_| MatrixCoreError::Matrix)?;
        let own_user = self
            .client
            .user_id()
            .ok_or(MatrixCoreError::SessionUnavailable)?;
        let messages = page
            .chunk
            .iter()
            .filter_map(|event| text_message_from_event(event, own_user))
            .collect();
        Ok(MatrixMessagePage {
            messages,
            next: page.end,
        })
    }

    /// Loads exactly one event for a voluntary report preview. The application
    /// must show this DTO verbatim and obtain explicit confirmation before it
    /// sends it to the separate moderation intake.
    pub async fn selected_message_for_report(
        &self,
        room_id: &str,
        event_id: &str,
    ) -> Result<SelectedMessageReport> {
        let room = self.room(room_id)?;
        self.require_safe_direct_room(&room).await?;
        let event_id = EventId::parse(event_id)
            .map_err(|_| MatrixCoreError::InvalidInput("message event ID is invalid".to_owned()))?;
        let event = room
            .event(&event_id, None)
            .await
            .map_err(|_| MatrixCoreError::Matrix)?;
        let own_user = self
            .client
            .user_id()
            .ok_or(MatrixCoreError::SessionUnavailable)?;
        let message =
            text_message_from_event(&event, own_user).ok_or(MatrixCoreError::InvalidInput(
                "the selected event is not a decrypted text message".to_owned(),
            ))?;
        Ok(SelectedMessageReport {
            room_id: room.room_id().to_string(),
            event_id: message.event_id,
            sender_id: message.sender_id,
            body: message.body,
            timestamp_ms: message.timestamp_ms,
        })
    }

    pub async fn block_user(&self, peer: &str) -> Result<()> {
        let peer: OwnedUserId = UserId::parse(peer)
            .map_err(|_| MatrixCoreError::InvalidInput("peer ID is invalid".to_owned()))?;
        self.client
            .account()
            .ignore_user(&peer)
            .await
            .map_err(|_| MatrixCoreError::Matrix)
    }

    pub async fn unblock_user(&self, peer: &str) -> Result<()> {
        let peer: OwnedUserId = UserId::parse(peer)
            .map_err(|_| MatrixCoreError::InvalidInput("peer ID is invalid".to_owned()))?;
        self.client
            .account()
            .unignore_user(&peer)
            .await
            .map_err(|_| MatrixCoreError::Matrix)
    }

    /// Returns a recovery key for one-time display. The caller must never log
    /// it or place it in renderer-persistent storage.
    pub async fn enable_recovery(&self, passphrase: Option<&str>) -> Result<Zeroizing<String>> {
        if passphrase.is_some_and(|value| value.chars().count() < 12) {
            return Err(MatrixCoreError::InvalidInput(
                "recovery passphrase must contain at least 12 characters".to_owned(),
            ));
        }
        let encryption = self.client.encryption();
        let recovery = encryption.recovery();
        let enable = recovery.enable().wait_for_backups_to_upload();
        let key = match passphrase {
            Some(value) => enable.with_passphrase(value).await,
            None => enable.await,
        }
        .map_err(|_| MatrixCoreError::Matrix)?;
        Ok(Zeroizing::new(key))
    }

    pub async fn recover(&self, recovery_key_or_passphrase: &str) -> Result<()> {
        if recovery_key_or_passphrase.trim().is_empty() {
            return Err(MatrixCoreError::InvalidInput(
                "recovery input is empty".to_owned(),
            ));
        }
        self.client
            .encryption()
            .recovery()
            .recover(recovery_key_or_passphrase)
            .await
            .map_err(|_| MatrixCoreError::Matrix)
    }

    pub fn recovery_state(&self) -> MatrixRecoveryStatus {
        match self.client.encryption().recovery().state() {
            RecoveryState::Enabled => MatrixRecoveryStatus::Enabled,
            RecoveryState::Incomplete => MatrixRecoveryStatus::Incomplete,
            RecoveryState::Unknown => MatrixRecoveryStatus::Unknown,
            RecoveryState::Disabled => MatrixRecoveryStatus::Disabled,
        }
    }

    fn room(&self, room_id: &str) -> Result<Room> {
        let room_id = RoomId::parse(room_id)
            .map_err(|_| MatrixCoreError::InvalidInput("room ID is invalid".to_owned()))?;
        self.client
            .get_room(&room_id)
            .ok_or(MatrixCoreError::InvalidInput(
                "room is not available locally".to_owned(),
            ))
    }

    async fn require_safe_direct_room(&self, room: &Room) -> Result<()> {
        if !room
            .is_direct()
            .await
            .map_err(|_| MatrixCoreError::Matrix)?
            || room.active_members_count() != 2
            || !room
                .latest_encryption_state()
                .await
                .map_err(|_| MatrixCoreError::Matrix)?
                .is_encrypted()
        {
            return Err(MatrixCoreError::UnsafeRoom);
        }
        Ok(())
    }

    fn reserve_send(&self, room_id: &RoomId) -> Result<()> {
        let now = Instant::now();
        let mut all_limits = lock(&self.send_limits)?;
        let samples = all_limits.entry(room_id.to_owned()).or_default();
        while samples
            .front()
            .is_some_and(|created| now.duration_since(*created) >= LONG_RATE_WINDOW)
        {
            samples.pop_front();
        }
        let short_count = samples
            .iter()
            .rev()
            .take_while(|created| now.duration_since(**created) < SHORT_RATE_WINDOW)
            .count();
        if short_count >= SHORT_RATE_LIMIT || samples.len() >= LONG_RATE_LIMIT {
            return Err(MatrixCoreError::RateLimited);
        }
        samples.push_back(now);
        Ok(())
    }
}

async fn build_client(config: &MatrixClientConfig<'_>) -> Result<Client> {
    let passphrase = Zeroizing::new(config.store_passphrase.to_owned());
    let mut builder = Client::builder()
        .homeserver_url(config.homeserver)
        // SDK defaults retry transient failures without a total limit. Wallet
        // UI and CI must fail visibly instead of waiting forever.
        .request_config(
            RequestConfig::new()
                .timeout(Duration::from_secs(20))
                .max_retry_time(Duration::from_secs(30)),
        )
        .sqlite_store(config.store_path, Some(passphrase.as_str()))
        .with_encryption_settings(EncryptionSettings {
            // Login must remain a bounded authentication operation. Recovery
            // and cross-signing are explicitly enabled by the user later.
            auto_enable_cross_signing: false,
            auto_enable_backups: false,
            ..Default::default()
        })
        .handle_refresh_tokens();
    if let Some(proxy) = config.proxy {
        let http = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .proxy(reqwest::Proxy::all(proxy).map_err(|_| MatrixCoreError::InvalidConfiguration(
                "Tor proxy URL is invalid".to_owned(),
            ))?)
            .build()
            .map_err(|_| MatrixCoreError::InvalidConfiguration(
                "Tor proxy could not be created".to_owned(),
            ))?;
        builder = builder.http_client(http);
    }
    let build = builder.build();
    tokio::time::timeout(MATRIX_NETWORK_OPERATION_TIMEOUT, build)
        .await
        .map_err(|_| MatrixCoreError::MatrixStage("client initialization timeout"))?
        .map_err(|_| MatrixCoreError::MatrixStage("client initialization"))
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MatrixRecoveryStatus {
    Unknown,
    Disabled,
    Incomplete,
    Enabled,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatrixTextMessage {
    pub event_id: String,
    pub sender_id: String,
    pub body: String,
    pub timestamp_ms: u64,
    pub sent_by_me: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatrixMessagePage {
    pub messages: Vec<MatrixTextMessage>,
    pub next: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectedMessageReport {
    pub room_id: String,
    pub event_id: String,
    pub sender_id: String,
    pub body: String,
    pub timestamp_ms: u64,
}

fn validate_config(config: &MatrixClientConfig<'_>) -> Result<()> {
    let homeserver = Url::parse(config.homeserver).map_err(|_| {
        MatrixCoreError::InvalidConfiguration("homeserver URL is invalid".to_owned())
    })?;
    let onion = homeserver.scheme() == "http"
        && homeserver.host_str().is_some_and(|host| {
            host.len() == 62
                && host.ends_with(".onion")
                && host[..56].bytes().all(|byte| matches!(byte, b'a'..=b'z' | b'2'..=b'7'))
        })
        && config.proxy.is_some();
    let secure = homeserver.scheme() == "https" || onion;
    let loopback_test = config.allow_loopback_http_for_tests
        && homeserver.scheme() == "http"
        && homeserver
            .host_str()
            .is_some_and(|host| host == "localhost" || host == "127.0.0.1" || host == "::1");
    if !secure && !loopback_test {
        return Err(MatrixCoreError::InvalidConfiguration(
            "production homeserver must use HTTPS or Tor v3 Onion".to_owned(),
        ));
    }
    if homeserver.username() != ""
        || homeserver.password().is_some()
        || homeserver.query().is_some()
        || homeserver.fragment().is_some()
    {
        return Err(MatrixCoreError::InvalidConfiguration(
            "homeserver URL contains unsupported credentials or parameters".to_owned(),
        ));
    }
    if let Some(proxy) = config.proxy {
        let proxy = Url::parse(proxy).map_err(|_| {
            MatrixCoreError::InvalidConfiguration("Tor proxy URL is invalid".to_owned())
        })?;
        if proxy.scheme() != "socks5h"
            || !matches!(proxy.host_str(), Some("127.0.0.1") | Some("::1") | Some("localhost"))
            || proxy.port().is_none()
            || proxy.username() != ""
            || proxy.password().is_some()
            || !matches!(proxy.path(), "" | "/")
            || proxy.query().is_some()
            || proxy.fragment().is_some()
        {
            return Err(MatrixCoreError::InvalidConfiguration(
                "Tor proxy URL is invalid".to_owned(),
            ));
        }
    }
    if config.store_path.as_os_str().is_empty() || config.store_passphrase.chars().count() < 32 {
        return Err(MatrixCoreError::InvalidConfiguration(
            "encrypted Matrix store configuration is incomplete".to_owned(),
        ));
    }
    Ok(())
}

fn validate_message(body: &str) -> Result<()> {
    let count = body.chars().count();
    if !(1..=MAX_MESSAGE_CHARACTERS).contains(&count)
        || body
            .chars()
            .any(|character| character.is_control() && !matches!(character, '\n' | '\t'))
    {
        return Err(MatrixCoreError::InvalidInput(
            "message must contain 1 to 2,000 safe text characters".to_owned(),
        ));
    }
    Ok(())
}

fn text_message_from_event(
    event: &matrix_sdk::deserialized_responses::TimelineEvent,
    own_user: &UserId,
) -> Option<MatrixTextMessage> {
    // A message event without encryption information was visible to the
    // homeserver and is never surfaced by this E2EE-only Core.
    event.encryption_info()?;
    let event_id = event.event_id()?.to_string();
    let sender = event.sender()?;
    let parsed: AnySyncTimelineEvent = event.raw().deserialize().ok()?;
    let AnySyncTimelineEvent::MessageLike(AnySyncMessageLikeEvent::RoomMessage(
        SyncMessageLikeEvent::Original(message),
    )) = parsed
    else {
        return None;
    };
    let MessageType::Text(text) = message.content.msgtype else {
        return None;
    };
    validate_message(&text.body).ok()?;
    let timestamp_ms = event.timestamp()?.get().into();
    Some(MatrixTextMessage {
        event_id,
        sender_id: sender.to_string(),
        body: text.body,
        timestamp_ms,
        sent_by_me: sender == own_user,
    })
}

fn validate_password(password: &str) -> Result<()> {
    if !(32..=256).contains(&password.len())
        || password.chars().any(char::is_whitespace)
        || password.chars().any(char::is_control)
    {
        return Err(MatrixCoreError::InvalidInput(
            "Matrix device password must contain 32 to 256 characters without whitespace"
                .to_owned(),
        ));
    }
    Ok(())
}

fn validate_device_name(value: &str) -> Result<()> {
    if value.trim() != value
        || !(1..=64).contains(&value.chars().count())
        || value.chars().any(char::is_control)
    {
        return Err(MatrixCoreError::InvalidInput(
            "Matrix device name is invalid".to_owned(),
        ));
    }
    Ok(())
}

fn lock<T>(value: &Mutex<T>) -> Result<MutexGuard<'_, T>> {
    value.lock().map_err(|_| MatrixCoreError::LockUnavailable)
}

mod ffi {
    use super::*;
    use std::{
        path::PathBuf,
        ptr, slice,
        sync::{Mutex, MutexGuard},
    };
    use tokio::runtime::Runtime;
    use zeroize::Zeroize;

    const STATUS_OK: i32 = 0;
    const STATUS_INVALID_ARGUMENT: i32 = 1;
    const STATUS_SESSION_UNAVAILABLE: i32 = 2;
    const STATUS_RATE_LIMITED: i32 = 3;
    const STATUS_UNSAFE_ROOM: i32 = 4;
    const STATUS_OPERATION_FAILED: i32 = 5;
    const MAX_INPUT_BYTES: usize = 64 * 1024;
    const MAX_PATH_BYTES: usize = 4_096;
    const MAX_ERROR_BYTES: usize = 4_096;

    #[allow(non_camel_case_types)]
    pub struct tex8_community_matrix_handle {
        runtime: Runtime,
        homeserver: String,
        proxy: Option<String>,
        store_path: PathBuf,
        store_passphrase: Zeroizing<String>,
        allow_loopback_http_for_tests: bool,
        client: Mutex<Option<MatrixE2eeClient>>,
        operation: Mutex<()>,
        last_error: Mutex<String>,
    }

    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn tex8_community_matrix_create_v1(
        homeserver: *const u8,
        homeserver_len: usize,
        store_path: *const u8,
        store_path_len: usize,
        store_passphrase: *const u8,
        store_passphrase_len: usize,
        proxy: *const u8,
        proxy_len: usize,
        allow_loopback_http_for_tests: bool,
        handle_output: *mut *mut tex8_community_matrix_handle,
        error_output: *mut u8,
        error_output_len: *mut usize,
    ) -> i32 {
        if handle_output.is_null() {
            return STATUS_INVALID_ARGUMENT;
        }
        // SAFETY: the caller supplied a writable handle output pointer.
        unsafe { *handle_output = ptr::null_mut() };
        let result = (|| {
            let homeserver =
                ffi_utf8(homeserver, homeserver_len, MAX_INPUT_BYTES, "homeserver")?.to_owned();
            let store_path = PathBuf::from(ffi_utf8(
                store_path,
                store_path_len,
                MAX_PATH_BYTES,
                "store path",
            )?);
            let store_passphrase = Zeroizing::new(
                ffi_utf8(
                    store_passphrase,
                    store_passphrase_len,
                    256,
                    "store passphrase",
                )?
                .to_owned(),
            );
            let proxy = if proxy_len == 0 {
                None
            } else {
                Some(ffi_utf8(proxy, proxy_len, 256, "Tor proxy")?.to_owned())
            };
            let config = MatrixClientConfig {
                homeserver: &homeserver,
                proxy: proxy.as_deref(),
                store_path: &store_path,
                store_passphrase: store_passphrase.as_str(),
                allow_loopback_http_for_tests,
            };
            validate_config(&config)?;
            let runtime = Runtime::new().map_err(|_| MatrixCoreError::Matrix)?;
            Ok::<_, MatrixCoreError>(Box::new(tex8_community_matrix_handle {
                runtime,
                homeserver,
                proxy,
                store_path,
                store_passphrase,
                allow_loopback_http_for_tests,
                client: Mutex::new(None),
                operation: Mutex::new(()),
                last_error: Mutex::new(String::new()),
            }))
        })();
        match result {
            Ok(handle) => {
                // SAFETY: ownership of the Box is transferred to the caller.
                unsafe { *handle_output = Box::into_raw(handle) };
                write_message("", error_output, error_output_len)
            }
            Err(error) => {
                write_message(&error.to_string(), error_output, error_output_len);
                status_for_error(&error)
            }
        }
    }

    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn tex8_community_matrix_destroy_v1(
        handle: *mut tex8_community_matrix_handle,
    ) {
        if !handle.is_null() {
            // SAFETY: the C contract returns the exact create pointer once.
            drop(unsafe { Box::from_raw(handle) });
        }
    }

    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn tex8_community_matrix_login_v1(
        handle: *mut tex8_community_matrix_handle,
        matrix_user_id: *const u8,
        matrix_user_id_len: usize,
        password: *const u8,
        password_len: usize,
        device_name: *const u8,
        device_name_len: usize,
        session_output: *mut *mut u8,
        session_output_len: *mut usize,
    ) -> i32 {
        let Some(handle) = handle.as_ref() else {
            return STATUS_INVALID_ARGUMENT;
        };
        if prepare_output(session_output, session_output_len).is_err() {
            return set_error(handle, STATUS_INVALID_ARGUMENT, "output pointer is invalid");
        }
        let result = (|| {
            let _operation = operation(handle)?;
            let user = ffi_utf8(
                matrix_user_id,
                matrix_user_id_len,
                MAX_INPUT_BYTES,
                "Matrix user ID",
            )?;
            let password = Zeroizing::new(
                ffi_utf8(password, password_len, 256, "Matrix password")?.to_owned(),
            );
            let device = ffi_utf8(device_name, device_name_len, 256, "device name")?;
            let config = config(handle);
            let login = handle.runtime.block_on(MatrixE2eeClient::login(
                config,
                user,
                password.as_str(),
                device,
            ))?;
            let session = login.session_json.to_vec();
            *client(handle)? = Some(login.client);
            transfer_buffer(session, session_output, session_output_len)
        })();
        finish(handle, result)
    }

    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn tex8_community_matrix_restore_v1(
        handle: *mut tex8_community_matrix_handle,
        session_json: *const u8,
        session_json_len: usize,
    ) -> i32 {
        let Some(handle) = handle.as_ref() else {
            return STATUS_INVALID_ARGUMENT;
        };
        let result = (|| {
            let _operation = operation(handle)?;
            let session = ffi_bytes(
                session_json,
                session_json_len,
                MAX_INPUT_BYTES,
                "Matrix session",
            )?;
            let restored = handle
                .runtime
                .block_on(MatrixE2eeClient::restore(config(handle), session))?;
            *client(handle)? = Some(restored);
            Ok(())
        })();
        finish(handle, result)
    }

    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn tex8_community_matrix_export_session_v1(
        handle: *mut tex8_community_matrix_handle,
        session_output: *mut *mut u8,
        session_output_len: *mut usize,
    ) -> i32 {
        let Some(handle) = handle.as_ref() else {
            return STATUS_INVALID_ARGUMENT;
        };
        if prepare_output(session_output, session_output_len).is_err() {
            return set_error(handle, STATUS_INVALID_ARGUMENT, "output pointer is invalid");
        }
        let result = (|| {
            let _operation = operation(handle)?;
            let clients = client(handle)?;
            let active = clients
                .as_ref()
                .ok_or(MatrixCoreError::SessionUnavailable)?;
            transfer_buffer(
                active.session_json()?.to_vec(),
                session_output,
                session_output_len,
            )
        })();
        finish(handle, result)
    }

    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn tex8_community_matrix_sync_once_v1(
        handle: *mut tex8_community_matrix_handle,
        timeout_ms: u64,
    ) -> i32 {
        with_client(handle, |handle, client| {
            handle
                .runtime
                .block_on(client.sync_once(Duration::from_millis(timeout_ms.clamp(1_000, 30_000))))
        })
    }

    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn tex8_community_matrix_create_direct_room_v1(
        handle: *mut tex8_community_matrix_handle,
        peer: *const u8,
        peer_len: usize,
        room_output: *mut *mut u8,
        room_output_len: *mut usize,
    ) -> i32 {
        with_client_output(handle, room_output, room_output_len, |handle, client| {
            let peer = ffi_utf8(peer, peer_len, MAX_INPUT_BYTES, "Matrix peer")?;
            let room = handle
                .runtime
                .block_on(client.create_or_get_direct_room(peer))?;
            Ok(room.to_string().into_bytes())
        })
    }

    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn tex8_community_matrix_send_text_v1(
        handle: *mut tex8_community_matrix_handle,
        room_id: *const u8,
        room_id_len: usize,
        body: *const u8,
        body_len: usize,
        event_output: *mut *mut u8,
        event_output_len: *mut usize,
    ) -> i32 {
        with_client_output(handle, event_output, event_output_len, |handle, client| {
            let room = ffi_utf8(room_id, room_id_len, MAX_INPUT_BYTES, "room ID")?;
            let body = ffi_utf8(body, body_len, MAX_INPUT_BYTES, "message")?;
            let event = handle.runtime.block_on(client.send_text(room, body))?;
            Ok(event.to_string().into_bytes())
        })
    }

    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn tex8_community_matrix_messages_v1(
        handle: *mut tex8_community_matrix_handle,
        room_id: *const u8,
        room_id_len: usize,
        from: *const u8,
        from_len: usize,
        limit: usize,
        result_output: *mut *mut u8,
        result_output_len: *mut usize,
    ) -> i32 {
        with_client_output(
            handle,
            result_output,
            result_output_len,
            |handle, client| {
                let room = ffi_utf8(room_id, room_id_len, MAX_INPUT_BYTES, "room ID")?;
                let from = ffi_optional_utf8(from, from_len, MAX_INPUT_BYTES, "page token")?;
                let page = handle
                    .runtime
                    .block_on(client.text_messages(room, from, limit))?;
                serde_json::to_vec(&page).map_err(|_| MatrixCoreError::Matrix)
            },
        )
    }

    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn tex8_community_matrix_selected_report_v1(
        handle: *mut tex8_community_matrix_handle,
        room_id: *const u8,
        room_id_len: usize,
        event_id: *const u8,
        event_id_len: usize,
        result_output: *mut *mut u8,
        result_output_len: *mut usize,
    ) -> i32 {
        with_client_output(
            handle,
            result_output,
            result_output_len,
            |handle, client| {
                let room = ffi_utf8(room_id, room_id_len, MAX_INPUT_BYTES, "room ID")?;
                let event = ffi_utf8(event_id, event_id_len, MAX_INPUT_BYTES, "event ID")?;
                let selected = handle
                    .runtime
                    .block_on(client.selected_message_for_report(room, event))?;
                serde_json::to_vec(&selected).map_err(|_| MatrixCoreError::Matrix)
            },
        )
    }

    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn tex8_community_matrix_set_blocked_v1(
        handle: *mut tex8_community_matrix_handle,
        peer: *const u8,
        peer_len: usize,
        blocked: bool,
    ) -> i32 {
        with_client(handle, |handle, client| {
            let peer = ffi_utf8(peer, peer_len, MAX_INPUT_BYTES, "Matrix peer")?;
            if blocked {
                handle.runtime.block_on(client.block_user(peer))
            } else {
                handle.runtime.block_on(client.unblock_user(peer))
            }
        })
    }

    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn tex8_community_matrix_enable_recovery_v1(
        handle: *mut tex8_community_matrix_handle,
        passphrase: *const u8,
        passphrase_len: usize,
        recovery_output: *mut *mut u8,
        recovery_output_len: *mut usize,
    ) -> i32 {
        with_client_output(
            handle,
            recovery_output,
            recovery_output_len,
            |handle, client| {
                let passphrase =
                    ffi_optional_utf8(passphrase, passphrase_len, 256, "recovery passphrase")?;
                let recovery = handle
                    .runtime
                    .block_on(client.enable_recovery(passphrase))?;
                Ok(recovery.as_bytes().to_vec())
            },
        )
    }

    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn tex8_community_matrix_recover_v1(
        handle: *mut tex8_community_matrix_handle,
        recovery: *const u8,
        recovery_len: usize,
    ) -> i32 {
        with_client(handle, |handle, client| {
            let recovery = Zeroizing::new(
                ffi_utf8(recovery, recovery_len, MAX_INPUT_BYTES, "recovery input")?.to_owned(),
            );
            handle.runtime.block_on(client.recover(recovery.as_str()))
        })
    }

    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn tex8_community_matrix_recovery_status_v1(
        handle: *mut tex8_community_matrix_handle,
        result_output: *mut *mut u8,
        result_output_len: *mut usize,
    ) -> i32 {
        with_client_output(
            handle,
            result_output,
            result_output_len,
            |_handle, client| {
                serde_json::to_vec(&client.recovery_state()).map_err(|_| MatrixCoreError::Matrix)
            },
        )
    }

    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn tex8_community_matrix_logout_v1(
        handle: *mut tex8_community_matrix_handle,
    ) -> i32 {
        let Some(handle) = handle.as_ref() else {
            return STATUS_INVALID_ARGUMENT;
        };
        let result = (|| {
            let _operation = operation(handle)?;
            let mut clients = client(handle)?;
            let active = clients
                .as_ref()
                .ok_or(MatrixCoreError::SessionUnavailable)?;
            handle.runtime.block_on(active.logout())?;
            *clients = None;
            Ok(())
        })();
        finish(handle, result)
    }

    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn tex8_community_matrix_free_buffer_v1(
        buffer: *mut u8,
        buffer_len: usize,
    ) {
        if !buffer.is_null() && buffer_len > 0 {
            let raw = ptr::slice_from_raw_parts_mut(buffer, buffer_len);
            // SAFETY: output functions transfer this exact boxed slice.
            let mut owned = unsafe { Box::from_raw(raw) };
            owned.zeroize();
        }
    }

    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn tex8_community_matrix_last_error_v1(
        handle: *mut tex8_community_matrix_handle,
        output: *mut u8,
        output_len: *mut usize,
    ) -> i32 {
        let Some(handle) = handle.as_ref() else {
            return STATUS_INVALID_ARGUMENT;
        };
        let Ok(error) = handle.last_error.lock() else {
            return STATUS_OPERATION_FAILED;
        };
        write_message(&error, output, output_len)
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn tex8_community_matrix_link_anchor_v1() -> usize {
        let anchor = tex8_community_matrix_create_v1 as *const () as usize
            ^ tex8_community_matrix_destroy_v1 as *const () as usize
            ^ tex8_community_matrix_restore_v1 as *const () as usize
            ^ tex8_community_matrix_sync_once_v1 as *const () as usize
            ^ tex8_community_matrix_send_text_v1 as *const () as usize;
        #[cfg(feature = "community-runtime")]
        {
            return anchor ^ community_runtime_core::native_link_anchor_v1();
        }
        #[cfg(not(feature = "community-runtime"))]
        anchor
    }

    fn config(handle: &tex8_community_matrix_handle) -> MatrixClientConfig<'_> {
        MatrixClientConfig {
            homeserver: &handle.homeserver,
            proxy: handle.proxy.as_deref(),
            store_path: &handle.store_path,
            store_passphrase: handle.store_passphrase.as_str(),
            allow_loopback_http_for_tests: handle.allow_loopback_http_for_tests,
        }
    }

    fn with_client(
        handle: *mut tex8_community_matrix_handle,
        callback: impl FnOnce(&tex8_community_matrix_handle, &MatrixE2eeClient) -> Result<()>,
    ) -> i32 {
        let Some(handle) = (unsafe { handle.as_ref() }) else {
            return STATUS_INVALID_ARGUMENT;
        };
        let result = (|| {
            let _operation = operation(handle)?;
            let clients = client(handle)?;
            let active = clients
                .as_ref()
                .ok_or(MatrixCoreError::SessionUnavailable)?;
            callback(handle, active)
        })();
        finish(handle, result)
    }

    fn with_client_output(
        handle: *mut tex8_community_matrix_handle,
        output: *mut *mut u8,
        output_len: *mut usize,
        callback: impl FnOnce(&tex8_community_matrix_handle, &MatrixE2eeClient) -> Result<Vec<u8>>,
    ) -> i32 {
        let Some(handle) = (unsafe { handle.as_ref() }) else {
            return STATUS_INVALID_ARGUMENT;
        };
        if prepare_output(output, output_len).is_err() {
            return set_error(handle, STATUS_INVALID_ARGUMENT, "output pointer is invalid");
        }
        let result = (|| {
            let _operation = operation(handle)?;
            let clients = client(handle)?;
            let active = clients
                .as_ref()
                .ok_or(MatrixCoreError::SessionUnavailable)?;
            transfer_buffer(callback(handle, active)?, output, output_len)
        })();
        finish(handle, result)
    }

    fn prepare_output(output: *mut *mut u8, output_len: *mut usize) -> std::result::Result<(), ()> {
        if output.is_null() || output_len.is_null() {
            return Err(());
        }
        // SAFETY: both output pointers were validated.
        unsafe {
            *output = ptr::null_mut();
            *output_len = 0;
        }
        Ok(())
    }

    fn transfer_buffer(bytes: Vec<u8>, output: *mut *mut u8, output_len: *mut usize) -> Result<()> {
        if bytes.is_empty() || output.is_null() || output_len.is_null() {
            return Err(MatrixCoreError::Matrix);
        }
        let mut boxed = bytes.into_boxed_slice();
        let length = boxed.len();
        let pointer = boxed.as_mut_ptr();
        std::mem::forget(boxed);
        // SAFETY: the caller provided writable pointer/length outputs.
        unsafe {
            *output = pointer;
            *output_len = length;
        }
        Ok(())
    }

    fn operation(handle: &tex8_community_matrix_handle) -> Result<MutexGuard<'_, ()>> {
        handle
            .operation
            .lock()
            .map_err(|_| MatrixCoreError::LockUnavailable)
    }

    fn client(
        handle: &tex8_community_matrix_handle,
    ) -> Result<MutexGuard<'_, Option<MatrixE2eeClient>>> {
        handle
            .client
            .lock()
            .map_err(|_| MatrixCoreError::LockUnavailable)
    }

    fn ffi_bytes<'a>(
        pointer: *const u8,
        length: usize,
        maximum: usize,
        label: &str,
    ) -> Result<&'a [u8]> {
        if pointer.is_null() || length == 0 || length > maximum {
            return Err(MatrixCoreError::InvalidInput(format!(
                "{label} length is invalid"
            )));
        }
        // SAFETY: the C contract requires a readable `length`-byte buffer.
        Ok(unsafe { slice::from_raw_parts(pointer, length) })
    }

    fn ffi_utf8<'a>(
        pointer: *const u8,
        length: usize,
        maximum: usize,
        label: &str,
    ) -> Result<&'a str> {
        let bytes = ffi_bytes(pointer, length, maximum, label)?;
        std::str::from_utf8(bytes)
            .map_err(|_| MatrixCoreError::InvalidInput(format!("{label} is not valid UTF-8")))
    }

    fn ffi_optional_utf8<'a>(
        pointer: *const u8,
        length: usize,
        maximum: usize,
        label: &str,
    ) -> Result<Option<&'a str>> {
        if pointer.is_null() && length == 0 {
            return Ok(None);
        }
        ffi_utf8(pointer, length, maximum, label).map(Some)
    }

    fn finish(handle: &tex8_community_matrix_handle, result: Result<()>) -> i32 {
        match result {
            Ok(()) => set_error(handle, STATUS_OK, ""),
            Err(error) => set_error(handle, status_for_error(&error), &error.to_string()),
        }
    }

    fn status_for_error(error: &MatrixCoreError) -> i32 {
        match error {
            MatrixCoreError::InvalidConfiguration(_) | MatrixCoreError::InvalidInput(_) => {
                STATUS_INVALID_ARGUMENT
            }
            MatrixCoreError::SessionUnavailable => STATUS_SESSION_UNAVAILABLE,
            MatrixCoreError::UnsafeRoom => STATUS_UNSAFE_ROOM,
            MatrixCoreError::RateLimited => STATUS_RATE_LIMITED,
            MatrixCoreError::Matrix | MatrixCoreError::LockUnavailable => STATUS_OPERATION_FAILED,
        }
    }

    fn set_error(handle: &tex8_community_matrix_handle, status: i32, message: &str) -> i32 {
        let Ok(mut error) = handle.last_error.lock() else {
            return STATUS_OPERATION_FAILED;
        };
        error.clear();
        error.push_str(message);
        status
    }

    fn write_message(message: &str, output: *mut u8, output_len: *mut usize) -> i32 {
        if output_len.is_null() || message.len() + 1 > MAX_ERROR_BYTES {
            return STATUS_INVALID_ARGUMENT;
        }
        let required = message.len() + 1;
        // SAFETY: output_len was validated.
        let capacity = unsafe { *output_len };
        // SAFETY: output_len was validated and remains writable.
        unsafe { *output_len = required };
        if output.is_null() {
            return STATUS_OK;
        }
        if capacity < required {
            return STATUS_INVALID_ARGUMENT;
        }
        // SAFETY: the caller promises `capacity` writable bytes.
        unsafe {
            ptr::copy_nonoverlapping(message.as_ptr(), output, message.len());
            *output.add(message.len()) = 0;
        }
        STATUS_OK
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ptr;

    #[test]
    fn production_homeserver_requires_https_and_no_embedded_credentials() {
        let directory = tempfile::tempdir().expect("tempdir");
        let valid = MatrixClientConfig {
            homeserver: "https://matrix.example",
            proxy: None,
            store_path: directory.path(),
            store_passphrase: "0123456789abcdef0123456789abcdef",
            allow_loopback_http_for_tests: false,
        };
        assert!(validate_config(&valid).is_ok());
        assert!(validate_config(&MatrixClientConfig {
            homeserver: "http://matrix.example",
            ..valid.clone()
        })
        .is_err());
        assert!(validate_config(&MatrixClientConfig {
            homeserver: "https://user:pass@matrix.example",
            ..valid
        })
        .is_err());
    }

    #[test]
    fn loopback_http_is_test_only() {
        let directory = tempfile::tempdir().expect("tempdir");
        let config = MatrixClientConfig {
            homeserver: "http://127.0.0.1:8008",
            proxy: None,
            store_path: directory.path(),
            store_passphrase: "0123456789abcdef0123456789abcdef",
            allow_loopback_http_for_tests: true,
        };
        assert!(validate_config(&config).is_ok());
    }

    #[test]
    fn onion_homeserver_requires_a_loopback_socks5h_proxy() {
        let directory = tempfile::tempdir().expect("tempdir");
        let onion = MatrixClientConfig {
            homeserver:
                "http://fastrelayrpcf3hbc4qvykjgbpwpmcuq5dpcsdxoe7gwfh2zxdib3eid.onion",
            proxy: Some("socks5h://127.0.0.1:9050"),
            store_path: directory.path(),
            store_passphrase: "0123456789abcdef0123456789abcdef",
            allow_loopback_http_for_tests: false,
        };
        assert!(validate_config(&onion).is_ok());
        assert!(validate_config(&MatrixClientConfig {
            proxy: None,
            ..onion
        })
        .is_err());
    }

    #[test]
    fn message_contract_is_plain_bounded_text_only() {
        assert!(validate_message("Hello").is_ok());
        assert!(validate_message("").is_err());
        assert!(validate_message(&"x".repeat(MAX_MESSAGE_CHARACTERS + 1)).is_err());
        assert!(validate_message("unsafe\u{0007}text").is_err());
    }

    #[test]
    fn login_secrets_and_device_names_are_bounded() {
        assert!(validate_password("matrix-device-password-with-32-chars").is_ok());
        assert!(validate_password("too-short").is_err());
        assert!(validate_password(&format!("{} ", "x".repeat(32))).is_err());
        assert!(validate_device_name("Roland's iPhone").is_ok());
        assert!(validate_device_name(" leading-space").is_err());
    }

    #[test]
    fn c_abi_validates_configuration_before_returning_a_handle() {
        let directory = tempfile::tempdir().expect("tempdir");
        let store = directory.path().to_string_lossy();
        let passphrase = b"0123456789abcdef0123456789abcdef";
        let secure = b"https://matrix.example";
        let mut handle = ptr::null_mut();
        let mut required = 0_usize;
        // SAFETY: all byte buffers and output pointers remain valid for the
        // duration of the call.
        let status = unsafe {
            super::ffi::tex8_community_matrix_create_v1(
                secure.as_ptr(),
                secure.len(),
                store.as_bytes().as_ptr(),
                store.len(),
                passphrase.as_ptr(),
                passphrase.len(),
                ptr::null(),
                0,
                false,
                &mut handle,
                ptr::null_mut(),
                &mut required,
            )
        };
        assert_eq!(status, 0);
        assert!(!handle.is_null());
        // SAFETY: this is the exact live pointer returned above.
        unsafe { super::ffi::tex8_community_matrix_destroy_v1(handle) };

        let insecure = b"http://matrix.example";
        handle = ptr::null_mut();
        required = 0;
        // SAFETY: all byte buffers and output pointers remain valid for the
        // duration of the call.
        let status = unsafe {
            super::ffi::tex8_community_matrix_create_v1(
                insecure.as_ptr(),
                insecure.len(),
                store.as_bytes().as_ptr(),
                store.len(),
                passphrase.as_ptr(),
                passphrase.len(),
                ptr::null(),
                0,
                false,
                &mut handle,
                ptr::null_mut(),
                &mut required,
            )
        };
        assert_eq!(status, 1);
        assert!(handle.is_null());
        assert!(required > 1);
    }
}
