use crate::{release_features, secure_store};
use community_matrix_core::{
    MatrixClientConfig, MatrixE2eeClient, MatrixMessagePage, SelectedMessageReport,
};
#[cfg(desktop_community_harrier)]
use community_runtime_core::{
    CommunityLocalCore, CommunitySearchRequest, CommunitySuggestionRequest, NativeHarrier,
    PublicQuerySuggestion, PublicSearchResult,
};
#[cfg(desktop_community_harrier)]
use ed25519_dalek::VerifyingKey;
use reqwest::{Client, Method, StatusCode, Url};
use serde::{Deserialize, Serialize};
#[cfg(desktop_community_harrier)]
use std::time::{SystemTime, UNIX_EPOCH};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::{AppHandle, Manager};
use unicode_normalization::UnicodeNormalization;
use zeroize::{Zeroize, Zeroizing};

const MAX_RESPONSE_BYTES: usize = 256 * 1024;
#[cfg(desktop_community_harrier)]
const MAX_CATALOG_MANIFEST_BYTES: usize = 1024 * 1024;
#[cfg(desktop_community_harrier)]
const MAX_CATALOG_BYTES: usize = 64 * 1024 * 1024;

pub struct CommunityV1State {
    http: Client,
    matrix: Mutex<Option<Arc<MatrixE2eeClient>>>,
    #[cfg(desktop_community_harrier)]
    search: Mutex<Option<CommunityLocalCore<NativeHarrier>>>,
}

impl CommunityV1State {
    pub fn new() -> Result<Self, String> {
        let http = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(15))
            .user_agent("TEX8-Monero-Enthusiast-Desktop/0.1")
            .proxy(crate::tor_transport::proxy()?)
            .build()
            .map_err(|_| "The private Community network client could not be created.".to_owned())?;
        Ok(Self {
            http,
            matrix: Mutex::new(None),
            #[cfg(desktop_community_harrier)]
            search: Mutex::new(None),
        })
    }

    pub async fn status(&self, app: &AppHandle) -> CommunityV1Status {
        let Some(config) = release_features::monero_enthusiast_v1_config() else {
            return CommunityV1Status::unavailable(
                "Private Community is not enabled in this release.",
            );
        };
        let packaged =
            native_search_linked() && verified_resources_present(app, &config).unwrap_or(false);
        if !packaged {
            return CommunityV1Status::unavailable(
                "The verified local discovery runtime is not packaged.",
            );
        }
        let identity_exists = secure_store::load_community_v1_account()
            .map(|account| account.is_some())
            .unwrap_or(false);
        let session_exists = secure_store::load_community_v1_matrix_session()
            .map(|session| session.is_some())
            .unwrap_or(false);
        let matrix_ready = session_exists
            && self
                .matrix
                .lock()
                .map(|matrix| matrix.is_some())
                .unwrap_or(false);
        let catalog_ready = self.catalog_ready();
        CommunityV1Status {
            packaged,
            ready: packaged && identity_exists && matrix_ready && catalog_ready,
            identity_exists,
            catalog_ready,
            matrix_ready,
            reason: if !packaged {
                "The verified local discovery files are not packaged.".to_owned()
            } else if !identity_exists {
                "Create an optional Community profile to begin.".to_owned()
            } else if !matrix_ready {
                "Private chat needs to be opened on this device.".to_owned()
            } else {
                "The signed local catalog has not been activated.".to_owned()
            },
        }
    }

    pub async fn initialize(&self, app: &AppHandle) -> Result<CommunityV1Status, String> {
        let config = require_config(app)?;
        self.initialize_runtime(app, &config).await?;
        if secure_store::load_community_v1_account()?.is_some() {
            self.start(app).await?;
            return Ok(self.status(app).await);
        }

        let identity_url = endpoint(&config.api_origin, "v2/identities")?;
        let created: CreateIdentityResponse = checked_json(
            self.http
                .post(identity_url)
                .send()
                .await
                .map_err(|_| "The Community profile could not be created.".to_owned())?,
        )
        .await?;
        validate_identity(&created.identity_id, &created.access_token)?;

        let mut matrix_password = random_hex_secret()?;
        let provision_result = self
            .provision_and_login(app, &config, &created, &matrix_password)
            .await;
        matrix_password.zeroize();
        let (matrix_user_id, homeserver, session_json) = match provision_result {
            Ok(value) => value,
            Err(error) => {
                let _ = self.delete_remote_identity(&config, &created).await;
                return Err(error);
            }
        };
        let account = StoredCommunityAccount {
            identity_id: created.identity_id.clone(),
            access_token: created.access_token.clone(),
            matrix_user_id,
            homeserver,
        };
        let encoded = serde_json::to_string(&account)
            .map_err(|_| "The Community profile could not be protected.".to_owned())?;
        if let Err(error) = secure_store::store_community_v1_matrix_session(session_json) {
            self.clear_session();
            let _ = self.delete_remote_identity(&config, &created).await;
            return Err(error);
        }
        if let Err(error) = secure_store::store_community_v1_account(encoded) {
            self.clear_session();
            let _ = secure_store::delete_community_v1_matrix_session();
            let _ = self.delete_remote_identity(&config, &created).await;
            return Err(error);
        }
        Ok(self.status(app).await)
    }

    pub async fn start(&self, app: &AppHandle) -> Result<(), String> {
        let config = require_config(app)?;
        self.initialize_runtime(app, &config).await?;
        let Some(mut account_json) = secure_store::load_community_v1_account()? else {
            return Err("No Community profile exists on this device.".to_owned());
        };
        let account: StoredCommunityAccount = serde_json::from_str(&account_json)
            .map_err(|_| "The saved Community profile is invalid.".to_owned())?;
        account_json.zeroize();
        if account.homeserver != config.matrix_homeserver {
            return Err("The saved private-chat server does not match this release.".to_owned());
        }
        let Some(mut session_json) = secure_store::load_community_v1_matrix_session()? else {
            return Err("The private chat session is unavailable.".to_owned());
        };
        let store_key = Zeroizing::new(secure_store::ensure_community_v1_matrix_store_key()?);
        let store_path = matrix_store_path(app)?;
        let client = MatrixE2eeClient::restore(
            MatrixClientConfig {
                homeserver: &config.matrix_homeserver,
                proxy: Some(crate::tor_transport::TOR_SOCKS_PROXY),
                store_path: &store_path,
                store_passphrase: store_key.as_str(),
                allow_loopback_http_for_tests: false,
            },
            session_json.as_bytes(),
        )
        .await
        .map_err(|_| "The private chat session could not be opened.".to_owned())?;
        session_json.zeroize();
        client
            .sync_once(Duration::from_secs(5))
            .await
            .map_err(|_| "Private chat is temporarily offline.".to_owned())?;
        let refreshed = client
            .session_json()
            .map_err(|_| "The private chat session could not be refreshed.".to_owned())?;
        secure_store::store_community_v1_matrix_session(
            String::from_utf8(refreshed.to_vec())
                .map_err(|_| "The private chat session is invalid.".to_owned())?,
        )?;
        *self
            .matrix
            .lock()
            .map_err(|_| "Private chat state is busy.".to_owned())? = Some(Arc::new(client));
        Ok(())
    }

    pub async fn account_status(&self, app: &AppHandle) -> Result<CommunityAccountStatus, String> {
        let config = require_config(app)?;
        self.authorized_json(&config, Method::GET, &["v2", "account", "status"], None)
            .await
    }

    pub async fn contribute_query(
        &self,
        app: &AppHandle,
        query: &str,
        language: &str,
    ) -> Result<CommunityQueryContributionResult, String> {
        let query = normalize_contribution_query(query);
        validate_language(language)?;
        if !safe_contribution_query(&query) {
            return Ok(CommunityQueryContributionResult {
                accepted: false,
                duplicate: false,
                eligible_for_review: false,
                filtered: true,
            });
        }
        let config = require_config(app)?;
        let receipt: CommunityQueryContributionReceipt = self
            .authorized_json(
                &config,
                Method::POST,
                &["v2", "query-contributions"],
                Some(serde_json::json!({
                    "submissionId": random_query_submission_id()?,
                    "query": query,
                    "language": language,
                    "modelId": "harrier-oss-v1-270m-community-v1",
                    "queryPromptVersion": "community-query-v2",
                })),
            )
            .await?;
        Ok(CommunityQueryContributionResult {
            accepted: receipt.accepted,
            duplicate: receipt.duplicate,
            eligible_for_review: receipt.eligible_for_review,
            filtered: false,
        })
    }

    #[cfg(desktop_community_harrier)]
    pub async fn search(
        &self,
        app: &AppHandle,
        request: serde_json::Value,
    ) -> Result<Vec<CommunityV1SearchResult>, String> {
        let config = require_config(app)?;
        self.initialize_runtime(app, &config).await?;
        let request: CommunitySearchRequest = serde_json::from_value(request)
            .map_err(|_| "The local Community search request is invalid.".to_owned())?;
        let runtime = self
            .search
            .lock()
            .map_err(|_| "Local Community search is busy.".to_owned())?;
        let runtime = runtime
            .as_ref()
            .ok_or_else(|| "Local Community search is not ready.".to_owned())?;
        runtime
            .search(&request, now_ms())
            .map(|results| results.into_iter().map(PublicSearchResult::from).collect())
            .map_err(|_| "Local Community search could not be completed.".to_owned())
    }

    #[cfg(not(desktop_community_harrier))]
    pub async fn search(
        &self,
        _app: &AppHandle,
        _request: serde_json::Value,
    ) -> Result<Vec<CommunityV1SearchResult>, String> {
        Err("Local Community search is not packaged for this desktop build.".to_owned())
    }

    #[cfg(desktop_community_harrier)]
    pub async fn suggestions(
        &self,
        app: &AppHandle,
        request: serde_json::Value,
    ) -> Result<Vec<CommunityV1QuerySuggestion>, String> {
        let config = require_config(app)?;
        self.initialize_runtime(app, &config).await?;
        let request: CommunitySuggestionRequest = serde_json::from_value(request)
            .map_err(|_| "The local search suggestion request is invalid.".to_owned())?;
        let runtime = self
            .search
            .lock()
            .map_err(|_| "Local Community search is busy.".to_owned())?;
        let runtime = runtime
            .as_ref()
            .ok_or_else(|| "Local Community search is not ready.".to_owned())?;
        runtime
            .suggestions(&request, now_ms())
            .map_err(|_| "Local search suggestions could not be loaded.".to_owned())
    }

    #[cfg(not(desktop_community_harrier))]
    pub async fn suggestions(
        &self,
        _app: &AppHandle,
        _request: serde_json::Value,
    ) -> Result<Vec<CommunityV1QuerySuggestion>, String> {
        Err("Local Community search is not packaged for this desktop build.".to_owned())
    }

    pub fn clear_search_history(&self) -> Result<(), String> {
        #[cfg(desktop_community_harrier)]
        {
            let runtime = self
                .search
                .lock()
                .map_err(|_| "Local Community search is busy.".to_owned())?;
            let runtime = runtime
                .as_ref()
                .ok_or_else(|| "Local Community search is not ready.".to_owned())?;
            return runtime
                .clear_query_cache()
                .map_err(|_| "Local search history could not be cleared.".to_owned());
        }
        #[cfg(not(desktop_community_harrier))]
        Err("Local Community search is not packaged for this desktop build.".to_owned())
    }

    pub async fn register_notification(
        &self,
        app: &AppHandle,
        installation_id: &str,
        provider: &str,
        token: &str,
    ) -> Result<serde_json::Value, String> {
        validate_public_identifier("notification installation", installation_id)?;
        if provider != "apns" {
            return Err(
                "Community notifications currently require APNs on desktop macOS.".to_owned(),
            );
        }
        if token.len() != 64
            || !token
                .bytes()
                .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
        {
            return Err("The Community notification token is invalid.".to_owned());
        }
        let config = require_config(app)?;
        self.authorized_json(
            &config,
            Method::POST,
            &["v2", "notifications", "installations"],
            Some(serde_json::json!({
                "installationId": installation_id,
                "provider": provider,
                "token": token,
            })),
        )
        .await
    }

    pub async fn chat_report_outcome(
        &self,
        app: &AppHandle,
        case_id: &str,
    ) -> Result<CommunityModerationOutcome, String> {
        validate_public_identifier("moderation case", case_id)?;
        let config = require_config(app)?;
        self.authorized_json(
            &config,
            Method::GET,
            &["v2", "moderation", "chat-reports", case_id],
            None,
        )
        .await
    }

    pub async fn appeal_chat_report(
        &self,
        app: &AppHandle,
        case_id: &str,
        reason: &str,
    ) -> Result<(), String> {
        validate_public_identifier("moderation case", case_id)?;
        validate_public_text("appeal reason", reason, 1, 2_000)?;
        let config = require_config(app)?;
        let url = endpoint_segments(
            &config.api_origin,
            &["v2", "moderation", "chat-reports", case_id, "appeals"],
        )?;
        let response = self
            .authorized_request(
                &url,
                Method::POST,
                Some(serde_json::json!({"reason": reason})),
            )?
            .send()
            .await
            .map_err(|_| "The appeal could not be submitted.".to_owned())?;
        checked_empty(response).await
    }

    pub async fn content_moderation_outcomes(
        &self,
        app: &AppHandle,
    ) -> Result<Vec<CommunityContentModerationOutcome>, String> {
        let config = require_config(app)?;
        self.authorized_json(
            &config,
            Method::GET,
            &["v2", "moderation", "outcomes"],
            None,
        )
        .await
    }

    pub async fn appeal_content_moderation(
        &self,
        app: &AppHandle,
        case_id: &str,
        reason: &str,
    ) -> Result<(), String> {
        validate_public_identifier("moderation case", case_id)?;
        validate_public_text("appeal reason", reason, 1, 2_000)?;
        let config = require_config(app)?;
        let url = endpoint_segments(
            &config.api_origin,
            &["v2", "moderation", "cases", case_id, "appeals"],
        )?;
        let response = self
            .authorized_request(
                &url,
                Method::POST,
                Some(serde_json::json!({"reason": reason})),
            )?
            .send()
            .await
            .map_err(|_| "The appeal could not be submitted.".to_owned())?;
        checked_empty(response).await
    }

    pub async fn submit_content(
        &self,
        app: &AppHandle,
        draft: CommunityContentDraft,
    ) -> Result<serde_json::Value, String> {
        draft.validate()?;
        let config = require_config(app)?;
        self.authorized_json(
            &config,
            Method::POST,
            &["v2", "content"],
            Some(
                serde_json::to_value(draft)
                    .map_err(|_| "The public Community entry could not be prepared.".to_owned())?,
            ),
        )
        .await
    }

    pub async fn resubmit_content(
        &self,
        app: &AppHandle,
        public_id: &str,
        draft: CommunityContentDraft,
    ) -> Result<serde_json::Value, String> {
        validate_public_identifier("public entry", public_id)?;
        draft.validate()?;
        let config = require_config(app)?;
        self.authorized_json(
            &config,
            Method::POST,
            &["v2", "content", public_id],
            Some(
                serde_json::to_value(draft)
                    .map_err(|_| "The public Community entry could not be prepared.".to_owned())?,
            ),
        )
        .await
    }

    pub async fn content_status(
        &self,
        app: &AppHandle,
        public_id: &str,
    ) -> Result<serde_json::Value, String> {
        validate_public_identifier("public entry", public_id)?;
        let config = require_config(app)?;
        self.authorized_json(&config, Method::GET, &["v2", "content", public_id], None)
            .await
    }

    pub async fn list_content(&self, app: &AppHandle) -> Result<Vec<serde_json::Value>, String> {
        let config = require_config(app)?;
        self.authorized_json(&config, Method::GET, &["v2", "content"], None)
            .await
    }

    pub async fn request_contact(
        &self,
        app: &AppHandle,
        peer_id: &str,
    ) -> Result<CommunityContactRequest, String> {
        validate_person_id(peer_id)?;
        let config = require_config(app)?;
        self.authorized_json(
            &config,
            Method::POST,
            &["v2", "contacts", peer_id, "requests"],
            Some(serde_json::json!({})),
        )
        .await
    }

    pub async fn pending_contacts(
        &self,
        app: &AppHandle,
    ) -> Result<Vec<CommunityContactRequest>, String> {
        let config = require_config(app)?;
        self.authorized_json(&config, Method::GET, &["v2", "contacts", "requests"], None)
            .await
    }

    pub async fn accepted_contacts(
        &self,
        app: &AppHandle,
    ) -> Result<Vec<CommunityChatDescriptor>, String> {
        let config = require_config(app)?;
        let contacts: Vec<AcceptedCommunityContact> = self
            .authorized_json(&config, Method::GET, &["v2", "contacts"], None)
            .await?;
        Ok(contacts
            .into_iter()
            .map(|contact| CommunityChatDescriptor {
                peer_id: contact.peer_id,
                matrix_user_id: contact.matrix_user_id,
                room_id: String::new(),
            })
            .collect())
    }

    pub async fn respond_contact(
        &self,
        app: &AppHandle,
        request_id: &str,
        accept: bool,
    ) -> Result<Option<CommunityContactRequest>, String> {
        validate_public_identifier("contact request", request_id)?;
        let config = require_config(app)?;
        let action = if accept { "accept" } else { "decline" };
        let url = endpoint_segments(
            &config.api_origin,
            &["v2", "contacts", "requests", request_id, action],
        )?;
        let response = self
            .authorized_request(&url, Method::POST, Some(serde_json::json!({})))?
            .send()
            .await
            .map_err(|_| "The contact request could not be updated.".to_owned())?;
        if accept {
            Ok(Some(checked_json(response).await?))
        } else {
            checked_empty(response).await?;
            Ok(None)
        }
    }

    pub async fn open_chat(
        &self,
        app: &AppHandle,
        peer_id: &str,
    ) -> Result<CommunityChatDescriptor, String> {
        validate_person_id(peer_id)?;
        let config = require_config(app)?;
        let accepted: AcceptedCommunityContact = self
            .authorized_json(&config, Method::GET, &["v2", "contacts", peer_id], None)
            .await?;
        let matrix = self.matrix_client()?;
        let room_id = matrix
            .create_or_get_direct_room(&accepted.matrix_user_id)
            .await
            .map_err(|_| "The private conversation could not be opened.".to_owned())?;
        Ok(CommunityChatDescriptor {
            peer_id: accepted.peer_id,
            matrix_user_id: accepted.matrix_user_id,
            room_id: room_id.to_string(),
        })
    }

    pub async fn messages(
        &self,
        app: &AppHandle,
        room_id: &str,
        from: Option<&str>,
        limit: usize,
    ) -> Result<MatrixMessagePage, String> {
        require_config(app)?;
        self.matrix_client()?
            .text_messages(room_id, from, limit)
            .await
            .map_err(|_| "Private messages could not be loaded.".to_owned())
    }

    pub async fn send_message(
        &self,
        app: &AppHandle,
        room_id: &str,
        body: &str,
    ) -> Result<String, String> {
        require_config(app)?;
        Ok(self
            .matrix_client()?
            .send_text(room_id, body)
            .await
            .map_err(|error| error.to_string())?
            .to_string())
    }

    pub async fn report_preview(
        &self,
        app: &AppHandle,
        room_id: &str,
        event_id: &str,
    ) -> Result<SelectedMessageReport, String> {
        require_config(app)?;
        self.matrix_client()?
            .selected_message_for_report(room_id, event_id)
            .await
            .map_err(|_| "The selected message could not be prepared for review.".to_owned())
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn report_message(
        &self,
        app: &AppHandle,
        peer_id: &str,
        room_id: &str,
        event_id: &str,
        reason: &str,
        illegal_content_notice: bool,
        confirmed_exact_message: bool,
    ) -> Result<CommunityCaseReceipt, String> {
        validate_person_id(peer_id)?;
        if !confirmed_exact_message {
            return Err("Review and confirm the exact selected message first.".to_owned());
        }
        let config = require_config(app)?;
        // Fetch the event again below the renderer boundary. The renderer may
        // choose a room/event and write a reason, but it cannot replace the
        // plaintext or minimum Matrix evidence sent to moderation.
        let selected_message = self
            .matrix_client()?
            .selected_message_for_report(room_id, event_id)
            .await
            .map_err(|_| "The selected message could not be verified.".to_owned())?;
        self.authorized_json(
            &config,
            Method::POST,
            &["v2", "contacts", peer_id, "chat-reports"],
            Some(serde_json::json!({
                "selectedMessage": selected_message,
                "reason": reason,
                "illegalContentNotice": illegal_content_notice,
                "confirmedExactMessage": true
            })),
        )
        .await
    }

    pub async fn block_contact(&self, app: &AppHandle, peer_id: &str) -> Result<(), String> {
        validate_person_id(peer_id)?;
        let config = require_config(app)?;
        let accepted: AcceptedCommunityContact = self
            .authorized_json(&config, Method::GET, &["v2", "contacts", peer_id], None)
            .await?;
        self.matrix_client()?
            .block_user(&accepted.matrix_user_id)
            .await
            .map_err(|_| "The private-chat block could not be applied.".to_owned())?;
        let url = endpoint_segments(&config.api_origin, &["v2", "contacts", peer_id, "block"])?;
        let response = self
            .authorized_request(&url, Method::POST, Some(serde_json::json!({})))?
            .send()
            .await
            .map_err(|_| "The Community profile could not be blocked.".to_owned())?;
        checked_empty(response).await
    }

    pub async fn delete_identity(&self, app: &AppHandle) -> Result<(), String> {
        let config = require_config(app)?;
        let Some(mut account_json) = secure_store::load_community_v1_account()? else {
            return Ok(());
        };
        let account: StoredCommunityAccount = serde_json::from_str(&account_json)
            .map_err(|_| "The saved Community profile is invalid.".to_owned())?;
        account_json.zeroize();
        self.delete_remote_identity(
            &config,
            &CreateIdentityResponse {
                identity_id: account.identity_id.clone(),
                access_token: account.access_token.clone(),
            },
        )
        .await?;
        let client = self
            .matrix
            .lock()
            .map_err(|_| "Private chat state is busy.".to_owned())?
            .take();
        if let Some(client) = client {
            let _ = client.logout().await;
        }
        secure_store::delete_community_v1_matrix_session()?;
        secure_store::delete_community_v1_matrix_store_key()?;
        #[cfg(desktop_community_harrier)]
        {
            self.search
                .lock()
                .map_err(|_| "Local Community search is busy.".to_owned())?
                .take();
        }
        secure_store::delete_community_v1_search_store_key()?;
        secure_store::delete_community_v1_account()?;
        let store = matrix_store_path(app)?;
        match std::fs::remove_dir_all(&store) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err("The local private chat store could not be removed.".to_owned()),
        }
        let search_store = search_store_path(app)?;
        match std::fs::remove_dir_all(&search_store) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err("The local private search store could not be removed.".to_owned()),
        }
        Ok(())
    }

    #[cfg(desktop_community_harrier)]
    async fn initialize_runtime(
        &self,
        app: &AppHandle,
        config: &release_features::MoneroEnthusiastV1Config,
    ) -> Result<(), String> {
        if self.catalog_ready() {
            return Ok(());
        }
        let resources = verified_resource_paths(app, config)?;
        let artifact_manifest = std::fs::read(&resources.artifact_manifest)
            .map_err(|_| "The verified local discovery manifest is unavailable.".to_owned())?;
        if artifact_manifest.len() > MAX_CATALOG_MANIFEST_BYTES {
            return Err("The verified local discovery manifest is too large.".to_owned());
        }
        let catalog_key = verifying_key(&config.catalog_verifying_key_hex, "catalog")?;
        let advertising_key =
            verifying_key(&config.advertising_verifying_key_hex, "advertising catalog")?;
        let artifact_key = verifying_key(&config.artifact_verifying_key_hex, "artifact")?;
        let harrier = NativeHarrier::load_verified_xnnpack(
            &artifact_manifest,
            &resources.pte,
            &resources.tokenizer,
            &resources.conformance,
            &artifact_key,
        )
        .map_err(|_| "The verified local discovery model could not be opened.".to_owned())?;
        let store = search_store_path(app)?;
        std::fs::create_dir_all(&store)
            .map_err(|_| "The local Community search store is unavailable.".to_owned())?;
        let query_cache_key = secure_store::ensure_community_v1_search_store_key()?;
        let runtime = CommunityLocalCore::open_with_keys_and_query_cache(
            &store,
            config.catalog_scope.clone(),
            catalog_key,
            advertising_key,
            query_cache_key,
            harrier,
        )
        .map_err(|_| "The local Community search store could not be opened.".to_owned())?;

        let now = now_ms();
        let scope = percent_encode_path_segment(&config.catalog_scope)?;
        if let (Ok(manifest), Ok(payload)) = (
            self.download_catalog_asset(
                &config.catalog_origin,
                &format!("v1/catalogs/{scope}/current/manifest.json"),
                MAX_CATALOG_MANIFEST_BYTES,
            )
            .await,
            self.download_catalog_asset(
                &config.catalog_origin,
                &format!("v1/catalogs/{scope}/current/catalog.json"),
                MAX_CATALOG_BYTES,
            )
            .await,
        ) {
            runtime
                .install_catalog(&manifest, &payload, now)
                .map_err(|_| "The signed Community catalog was rejected.".to_owned())?;
        }
        if let (Ok(manifest), Ok(payload)) = (
            self.download_catalog_asset(
                &config.catalog_origin,
                &format!("v1/queries/{scope}/current/manifest.json"),
                MAX_CATALOG_MANIFEST_BYTES,
            )
            .await,
            self.download_catalog_asset(
                &config.catalog_origin,
                &format!("v1/queries/{scope}/current/queries.json"),
                MAX_CATALOG_BYTES,
            )
            .await,
        ) {
            runtime
                .install_query_catalog(&manifest, &payload, now)
                .map_err(|_| "The signed Community query catalog was rejected.".to_owned())?;
        }
        runtime.status(now).map_err(|_| {
            "No complete, signed Community catalog is available on this computer.".to_owned()
        })?;
        *self
            .search
            .lock()
            .map_err(|_| "Local Community search is busy.".to_owned())? = Some(runtime);
        Ok(())
    }

    #[cfg(not(desktop_community_harrier))]
    async fn initialize_runtime(
        &self,
        _app: &AppHandle,
        _config: &release_features::MoneroEnthusiastV1Config,
    ) -> Result<(), String> {
        Err("Local Community search is not packaged for this desktop build.".to_owned())
    }

    #[cfg(desktop_community_harrier)]
    async fn download_catalog_asset(
        &self,
        origin: &str,
        path: &str,
        maximum_bytes: usize,
    ) -> Result<Vec<u8>, String> {
        let url = endpoint(origin, path)?;
        let mut response = self
            .http
            .get(url)
            .send()
            .await
            .map_err(|_| "The signed Community catalog could not be downloaded.".to_owned())?;
        if !response.status().is_success()
            || response
                .content_length()
                .is_some_and(|length| length > maximum_bytes as u64)
        {
            return Err("The signed Community catalog is unavailable.".to_owned());
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| "The signed Community catalog could not be read.".to_owned())?
        {
            if bytes.len().saturating_add(chunk.len()) > maximum_bytes {
                return Err("The signed Community catalog is too large.".to_owned());
            }
            bytes.extend_from_slice(&chunk);
        }
        Ok(bytes)
    }

    fn catalog_ready(&self) -> bool {
        #[cfg(desktop_community_harrier)]
        {
            return self
                .search
                .lock()
                .ok()
                .and_then(|runtime| {
                    runtime
                        .as_ref()
                        .map(|runtime| runtime.status(now_ms()).is_ok())
                })
                .unwrap_or(false);
        }
        #[cfg(not(desktop_community_harrier))]
        false
    }

    async fn provision_and_login(
        &self,
        app: &AppHandle,
        config: &release_features::MoneroEnthusiastV1Config,
        identity: &CreateIdentityResponse,
        matrix_password: &str,
    ) -> Result<(String, String, String), String> {
        let provision_url = endpoint(&config.api_origin, "v2/matrix/provision")?;
        let provisioned: ProvisionMatrixResponse = checked_json(
            self.http
                .post(provision_url)
                .bearer_auth(&identity.access_token)
                .json(&serde_json::json!({"password": matrix_password}))
                .send()
                .await
                .map_err(|_| "Private chat could not be created.".to_owned())?,
        )
        .await?;
        if provisioned.homeserver != config.matrix_homeserver
            || !provisioned.matrix_user_id.starts_with('@')
            || provisioned.matrix_user_id.len() > 255
        {
            return Err("The private chat account response is invalid.".to_owned());
        }
        let store_key = Zeroizing::new(secure_store::ensure_community_v1_matrix_store_key()?);
        let store_path = matrix_store_path(app)?;
        let login = MatrixE2eeClient::login(
            MatrixClientConfig {
                homeserver: &config.matrix_homeserver,
                proxy: Some(crate::tor_transport::TOR_SOCKS_PROXY),
                store_path: &store_path,
                store_passphrase: store_key.as_str(),
                allow_loopback_http_for_tests: false,
            },
            &provisioned.matrix_user_id,
            matrix_password,
            "Monero Fast Wallet Desktop",
        )
        .await
        .map_err(|_| "Private chat could not be opened.".to_owned())?;
        let session_json = String::from_utf8(login.session_json.to_vec())
            .map_err(|_| "The private chat session is invalid.".to_owned())?;
        *self
            .matrix
            .lock()
            .map_err(|_| "Private chat state is busy.".to_owned())? = Some(Arc::new(login.client));
        Ok((
            provisioned.matrix_user_id,
            provisioned.homeserver,
            session_json,
        ))
    }

    async fn delete_remote_identity(
        &self,
        config: &release_features::MoneroEnthusiastV1Config,
        identity: &CreateIdentityResponse,
    ) -> Result<(), String> {
        let delete_url = endpoint(&config.api_origin, "v2/identity/delete")?;
        let response = self
            .http
            .post(delete_url)
            .bearer_auth(&identity.access_token)
            .json(&serde_json::json!({
                "confirmation": "DELETE MY COMMUNITY PROFILE"
            }))
            .send()
            .await
            .map_err(|_| "The Community profile could not be deleted.".to_owned())?;
        if response.status() == StatusCode::NO_CONTENT {
            Ok(())
        } else {
            Err("The Community profile could not be deleted.".to_owned())
        }
    }

    pub fn clear_session(&self) {
        if let Ok(mut matrix) = self.matrix.lock() {
            *matrix = None;
        }
        #[cfg(desktop_community_harrier)]
        if let Ok(mut search) = self.search.lock() {
            *search = None;
        }
    }

    fn matrix_client(&self) -> Result<Arc<MatrixE2eeClient>, String> {
        self.matrix
            .lock()
            .map_err(|_| "Private chat state is busy.".to_owned())?
            .clone()
            .ok_or_else(|| "Open private chat on this device first.".to_owned())
    }

    async fn authorized_json<T: for<'de> Deserialize<'de>>(
        &self,
        config: &release_features::MoneroEnthusiastV1Config,
        method: Method,
        segments: &[&str],
        body: Option<serde_json::Value>,
    ) -> Result<T, String> {
        let url = endpoint_segments(&config.api_origin, segments)?;
        let response = self
            .authorized_request(&url, method, body)?
            .send()
            .await
            .map_err(|_| "The Community service is temporarily unavailable.".to_owned())?;
        checked_json(response).await
    }

    fn authorized_request(
        &self,
        url: &Url,
        method: Method,
        body: Option<serde_json::Value>,
    ) -> Result<reqwest::RequestBuilder, String> {
        let account = stored_account()?;
        let request = self
            .http
            .request(method, url.clone())
            .bearer_auth(account.access_token.as_str());
        Ok(match body {
            Some(body) => request.json(&body),
            None => request,
        })
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommunityV1Status {
    pub packaged: bool,
    pub ready: bool,
    pub identity_exists: bool,
    pub catalog_ready: bool,
    pub matrix_ready: bool,
    pub reason: String,
}

#[cfg(desktop_community_harrier)]
pub type CommunityV1SearchResult = PublicSearchResult;
#[cfg(not(desktop_community_harrier))]
pub type CommunityV1SearchResult = serde_json::Value;

#[cfg(desktop_community_harrier)]
pub type CommunityV1QuerySuggestion = PublicQuerySuggestion;
#[cfg(not(desktop_community_harrier))]
pub type CommunityV1QuerySuggestion = serde_json::Value;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CommunityAccountStatus {
    pub identity_id: String,
    pub suspended: bool,
    pub suspension_case_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct CommunityQueryContributionReceipt {
    accepted: bool,
    duplicate: bool,
    eligible_for_review: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommunityQueryContributionResult {
    pub accepted: bool,
    pub duplicate: bool,
    pub eligible_for_review: bool,
    pub filtered: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "snake_case")]
pub enum CommunityContentKind {
    Profile,
    Post,
    ServiceListing,
    ProductListing,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CommunityMediaReference {
    pub media_id: String,
    pub sha256: String,
    pub content_type: String,
    pub width: u32,
    pub height: u32,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CommunityContentDraft {
    pub kind: CommunityContentKind,
    pub title: String,
    pub summary: String,
    #[serde(default)]
    pub roles: Vec<String>,
    #[serde(default)]
    pub categories: Vec<String>,
    #[serde(default)]
    pub languages: Vec<String>,
    pub coarse_region: Option<String>,
    pub radius_km: Option<u16>,
    #[serde(default)]
    pub media: Vec<CommunityMediaReference>,
}

impl CommunityContentDraft {
    fn validate(&self) -> Result<(), String> {
        validate_public_text("title", &self.title, 1, 120)?;
        validate_public_text("summary", &self.summary, 1, 2_000)?;
        validate_public_list("roles", &self.roles, 16, 64)?;
        validate_public_list("categories", &self.categories, 16, 64)?;
        validate_public_list("languages", &self.languages, 12, 16)?;
        if self.languages.is_empty() {
            return Err("Choose at least one language for the public entry.".to_owned());
        }
        match (&self.coarse_region, self.radius_km) {
            (None, None) | (Some(_), Some(5 | 10 | 25)) => {}
            _ => return Err("Approximate location requires a 5, 10, or 25 km area.".to_owned()),
        }
        if self.media.len() > 8 {
            return Err("A public entry can contain at most 8 media items.".to_owned());
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CommunityContactRequest {
    pub request_id: String,
    pub requester_id: String,
    pub recipient_id: String,
    pub status: String,
    pub created_at_ms: u64,
    pub responded_at_ms: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CommunityChatDescriptor {
    pub peer_id: String,
    pub matrix_user_id: String,
    pub room_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CommunityCaseReceipt {
    pub case_id: String,
    pub status: String,
    pub created_at_ms: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CommunityModerationOutcome {
    pub case_id: String,
    pub status: String,
    pub decision: Option<String>,
    pub decision_reason: Option<String>,
    pub resolved_at_ms: Option<u64>,
    pub appeal_pending: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CommunityContentModerationOutcome {
    pub case_id: String,
    pub public_id: String,
    pub revision: u64,
    pub source: String,
    pub status: String,
    pub decision: Option<String>,
    pub decision_reason: Option<String>,
    pub resolved_at_ms: Option<u64>,
    pub appeal_pending: bool,
    pub affected_author: bool,
}

impl CommunityV1Status {
    fn unavailable(reason: &str) -> Self {
        Self {
            packaged: false,
            ready: false,
            identity_exists: false,
            catalog_ready: false,
            matrix_ready: false,
            reason: reason.to_owned(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct CreateIdentityResponse {
    identity_id: String,
    access_token: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProvisionMatrixResponse {
    matrix_user_id: String,
    homeserver: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredCommunityAccount {
    identity_id: String,
    access_token: String,
    matrix_user_id: String,
    homeserver: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct AcceptedCommunityContact {
    peer_id: String,
    matrix_user_id: String,
}

impl Drop for StoredCommunityAccount {
    fn drop(&mut self) {
        self.access_token.zeroize();
    }
}

impl Drop for CreateIdentityResponse {
    fn drop(&mut self) {
        self.access_token.zeroize();
    }
}

fn require_config(app: &AppHandle) -> Result<release_features::MoneroEnthusiastV1Config, String> {
    release_features::monero_enthusiast_v1_config()
        .filter(|config| {
            native_search_linked() && verified_resources_present(app, config).unwrap_or(false)
        })
        .ok_or_else(|| {
            "The verified private Community runtime is not available in this release.".to_owned()
        })
}

fn native_search_linked() -> bool {
    cfg!(desktop_community_harrier)
}

#[cfg_attr(not(desktop_community_harrier), allow(dead_code))]
struct CommunityResourcePaths {
    artifact_manifest: PathBuf,
    pte: PathBuf,
    tokenizer: PathBuf,
    conformance: PathBuf,
}

fn verified_resources_present(
    app: &AppHandle,
    config: &release_features::MoneroEnthusiastV1Config,
) -> Result<bool, String> {
    verified_resource_paths(app, config).map(|_| true)
}

fn verified_resource_paths(
    app: &AppHandle,
    config: &release_features::MoneroEnthusiastV1Config,
) -> Result<CommunityResourcePaths, String> {
    let root = app
        .path()
        .resource_dir()
        .map_err(|_| "The application resource directory is unavailable.".to_owned())?;
    let canonical_root = root
        .canonicalize()
        .map_err(|_| "The application resource directory is unavailable.".to_owned())?;
    let resolve = |relative: &str| -> Result<PathBuf, String> {
        let candidate = root.join(relative);
        let metadata = std::fs::symlink_metadata(&candidate)
            .map_err(|_| "A verified local discovery file is missing.".to_owned())?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err("A verified local discovery file is unsafe.".to_owned());
        }
        let canonical = candidate
            .canonicalize()
            .map_err(|_| "A local discovery file is unavailable.".to_owned())?;
        if !canonical.starts_with(&canonical_root) {
            return Err("A verified local discovery file is unsafe.".to_owned());
        }
        Ok(canonical)
    };
    Ok(CommunityResourcePaths {
        artifact_manifest: resolve(&config.artifact_manifest_resource)?,
        pte: resolve(&config.pte_resource)?,
        tokenizer: resolve(&config.tokenizer_resource)?,
        conformance: resolve(&config.conformance_resource)?,
    })
}

#[cfg(desktop_community_harrier)]
fn verifying_key(value: &str, label: &str) -> Result<VerifyingKey, String> {
    let bytes =
        hex::decode(value).map_err(|_| format!("The {label} verification key is invalid."))?;
    let bytes: [u8; 32] = bytes
        .try_into()
        .map_err(|_| format!("The {label} verification key is invalid."))?;
    VerifyingKey::from_bytes(&bytes)
        .map_err(|_| format!("The {label} verification key is invalid."))
}

#[cfg(desktop_community_harrier)]
fn percent_encode_path_segment(value: &str) -> Result<String, String> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("The Community catalog scope is invalid.".to_owned());
    }
    Ok(value.to_owned())
}

#[cfg(desktop_community_harrier)]
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

fn endpoint(origin: &str, path: &str) -> Result<Url, String> {
    let mut url =
        Url::parse(origin).map_err(|_| "The Community service address is invalid.".to_owned())?;
    url.path_segments_mut()
        .map_err(|_| "The Community service address is invalid.".to_owned())?
        .extend(path.split('/'));
    Ok(url)
}

fn endpoint_segments(origin: &str, segments: &[&str]) -> Result<Url, String> {
    let mut url =
        Url::parse(origin).map_err(|_| "The Community service address is invalid.".to_owned())?;
    {
        let mut path = url
            .path_segments_mut()
            .map_err(|_| "The Community service address is invalid.".to_owned())?;
        path.clear();
        for segment in segments {
            if segment.is_empty() {
                return Err("The Community request path is invalid.".to_owned());
            }
            path.push(segment);
        }
    }
    Ok(url)
}

async fn checked_json<T: for<'de> Deserialize<'de>>(
    mut response: reqwest::Response,
) -> Result<T, String> {
    if !response.status().is_success() {
        return Err("The Community service rejected the request.".to_owned());
    }
    if response
        .content_length()
        .is_some_and(|size| size > u64::try_from(MAX_RESPONSE_BYTES).unwrap_or(u64::MAX))
    {
        return Err("The Community service response is too large.".to_owned());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "The Community service response could not be read.".to_owned())?
    {
        if bytes.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
            return Err("The Community service response is too large.".to_owned());
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes)
        .map_err(|_| "The Community service response is invalid.".to_owned())
}

async fn checked_empty(response: reqwest::Response) -> Result<(), String> {
    if response.status().is_success() {
        Ok(())
    } else {
        Err("The Community service rejected the request.".to_owned())
    }
}

fn stored_account() -> Result<StoredCommunityAccount, String> {
    let Some(mut account_json) = secure_store::load_community_v1_account()? else {
        return Err("No Community profile exists on this device.".to_owned());
    };
    let account = serde_json::from_str(&account_json)
        .map_err(|_| "The saved Community profile is invalid.".to_owned())?;
    account_json.zeroize();
    Ok(account)
}

fn validate_identity(identity_id: &str, access_token: &str) -> Result<(), String> {
    if !identity_id.starts_with("person_")
        || identity_id.len() != 39
        || !identity_id[7..]
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
        || access_token.len() != 64
        || !access_token.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err("The Community profile response is invalid.".to_owned());
    }
    Ok(())
}

fn validate_person_id(value: &str) -> Result<(), String> {
    if value.starts_with("person_")
        && value.len() == 39
        && value[7..].bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        Ok(())
    } else {
        Err("The Community profile identifier is invalid.".to_owned())
    }
}

fn validate_public_identifier(label: &str, value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 255
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
    {
        return Err(format!("The {label} identifier is invalid."));
    }
    Ok(())
}

fn validate_public_text(
    label: &str,
    value: &str,
    minimum: usize,
    maximum: usize,
) -> Result<(), String> {
    let count = value.chars().count();
    if value.trim() != value
        || count < minimum
        || count > maximum
        || value.chars().any(|character| character.is_control())
    {
        return Err(format!("The public {label} is invalid."));
    }
    Ok(())
}

fn validate_public_list(
    label: &str,
    values: &[String],
    maximum_items: usize,
    maximum_characters: usize,
) -> Result<(), String> {
    if values.len() > maximum_items {
        return Err(format!("The public {label} list is too long."));
    }
    for value in values {
        validate_public_text(label, value, 1, maximum_characters)?;
    }
    Ok(())
}

fn random_hex_secret() -> Result<String, String> {
    let mut bytes = [0_u8; 32];
    getrandom::getrandom(&mut bytes)
        .map_err(|_| "A private chat credential could not be generated.".to_owned())?;
    let encoded = hex::encode(bytes);
    bytes.zeroize();
    Ok(encoded)
}

fn random_query_submission_id() -> Result<String, String> {
    let mut bytes = [0_u8; 24];
    getrandom::getrandom(&mut bytes)
        .map_err(|_| "A private query submission ID could not be generated.".to_owned())?;
    let identifier = format!("query-submission_{}", hex::encode(bytes));
    bytes.zeroize();
    Ok(identifier)
}

fn normalize_contribution_query(value: &str) -> String {
    value
        .nfkc()
        .collect::<String>()
        .to_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn validate_language(value: &str) -> Result<(), String> {
    if value.len() < 2
        || value.len() > 16
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        return Err("Community query language is invalid.".to_owned());
    }
    Ok(())
}

fn safe_contribution_query(value: &str) -> bool {
    if value.is_empty() || value.chars().count() > 160 {
        return false;
    }
    if ["http://", "https://", "www.", ".onion", "mailto:"]
        .iter()
        .any(|marker| value.contains(marker))
        || value.contains('@')
    {
        return false;
    }
    let words = value.split_whitespace().collect::<Vec<_>>();
    if (12..=25).contains(&words.len())
        && words.iter().all(|word| {
            let token = trim_contribution_token(word);
            (2..=20).contains(&token.chars().count()) && token.chars().all(char::is_alphabetic)
        })
    {
        return false;
    }
    !words.iter().any(|word| {
        let token = trim_contribution_token(word);
        let length = token.chars().count();
        let digit_count = token.chars().filter(char::is_ascii_digit).count();
        length > 64
            || (length == 64 && token.bytes().all(|byte| byte.is_ascii_hexdigit()))
            || ((90..=110).contains(&length)
                && token.bytes().all(|byte| {
                    b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz".contains(&byte)
                }))
            || (digit_count >= 7
                && token.chars().all(|character| {
                    character.is_ascii_digit() || matches!(character, '+' | '(' | ')' | '.' | '-')
                }))
    })
}

fn trim_contribution_token(value: &str) -> &str {
    value.trim_matches(|character| {
        matches!(
            character,
            ',' | '.' | ';' | ':' | '!' | '?' | '(' | ')' | '[' | ']' | '{' | '}' | '"' | '\''
        )
    })
}

fn matrix_store_path(app: &AppHandle) -> Result<PathBuf, String> {
    let path = app
        .path()
        .app_local_data_dir()
        .map_err(|_| "Private application storage is unavailable.".to_owned())?
        .join("community-v1")
        .join("matrix");
    for existing in path.ancestors().take(3) {
        if let Ok(metadata) = std::fs::symlink_metadata(existing) {
            if metadata.file_type().is_symlink() {
                return Err("Private chat storage is unsafe.".to_owned());
            }
        }
    }
    std::fs::create_dir_all(&path)
        .map_err(|_| "Private chat storage could not be created.".to_owned())?;
    if std::fs::symlink_metadata(&path)
        .map(|metadata| metadata.file_type().is_symlink() || !metadata.is_dir())
        .unwrap_or(true)
    {
        return Err("Private chat storage is unsafe.".to_owned());
    }
    Ok(path)
}

fn search_store_path(app: &AppHandle) -> Result<PathBuf, String> {
    let path = app
        .path()
        .app_local_data_dir()
        .map_err(|_| "Private application storage is unavailable.".to_owned())?
        .join("community-v1")
        .join("catalog");
    for existing in path.ancestors().take(3) {
        if let Ok(metadata) = std::fs::symlink_metadata(existing) {
            if metadata.file_type().is_symlink() {
                return Err("Local Community search storage is unsafe.".to_owned());
            }
        }
    }
    std::fs::create_dir_all(&path)
        .map_err(|_| "Local Community search storage could not be created.".to_owned())?;
    if std::fs::symlink_metadata(&path)
        .map(|metadata| metadata.file_type().is_symlink() || !metadata.is_dir())
        .unwrap_or(true)
    {
        return Err("Local Community search storage is unsafe.".to_owned());
    }
    Ok(path)
}

#[cfg(test)]
mod query_contribution_tests {
    use super::{
        normalize_contribution_query, random_query_submission_id, safe_contribution_query,
    };

    #[test]
    fn query_contribution_is_normalized_and_private_identifiers_are_blocked() {
        assert_eq!(
            normalize_contribution_query("  PRIVACY   Friendly Ｓｈｏｐ "),
            "privacy friendly shop"
        );
        assert!(safe_contribution_query("privacy friendly shopping"));
        assert!(!safe_contribution_query("contact alice@example.org"));
        assert!(!safe_contribution_query(&format!(
            "transaction {}",
            "ab".repeat(32)
        )));
        assert!(!safe_contribution_query(
            "alpha bravo cactus delta echo forest garden harbor island jungle kilo lemon"
        ));
    }

    #[test]
    fn query_submission_identifier_is_unlinkable_and_shape_bounded() {
        let first = random_query_submission_id().expect("first ID");
        let second = random_query_submission_id().expect("second ID");
        assert_ne!(first, second);
        assert!(first.starts_with("query-submission_"));
        assert_eq!(first.len(), 65);
        assert!(first[17..]
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()));
    }
}
