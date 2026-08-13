//! Wallet-independent native orchestration for Monero Enthusiast V1.

use community_search_core::{
    normalize_query_text_v1, AdvertisingCatalogCore, AdvertisingPlacement, AdvertisingSelection,
    CatalogItem, CatalogItemKind, CommonQueryCore, CommunitySearchCore, CommunitySearchError,
    InstalledGeneration, InterestDomain, InterestSignal, InterestState, LocalQueryCache,
    LocalQueryEmbedding, LocalQuerySuggestion, MediaReference, ModelContract,
    PersonalizationUpdate, QuerySuggestion, RepetitionFingerprint, SearchFilters, SearchResult,
    DEFAULT_LOCAL_QUERY_CACHE_CAPACITY, HARRIER_QUERY_INSTRUCTION_V2,
};
#[cfg(feature = "native-harrier")]
use community_search_core::{
    HarrierArtifactManifest, HarrierArtifactTarget, V1_EMBEDDING_DIMENSION,
};
use ed25519_dalek::VerifyingKey;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    sync::{Mutex, MutexGuard},
};
use thiserror::Error;

const MAX_RESULTS: usize = 50;
const QUERY_CACHE_PRUNE_INTERVAL_MS: u64 = 24 * 60 * 60 * 1_000;
const INTEREST_STATE_FILE: &str = "local-interests.sealed";

#[derive(Debug, Error)]
pub enum CommunityRuntimeError {
    #[error(transparent)]
    Search(#[from] CommunitySearchError),
    #[error("the native Harrier runtime is unavailable in this build")]
    NativeUnavailable,
    #[error("the native Harrier runtime failed: {0}")]
    Native(String),
    #[error("the native Community runtime lock is unavailable")]
    LockUnavailable,
    #[error("the Community search request is invalid: {0}")]
    InvalidRequest(String),
}

pub type Result<T> = std::result::Result<T, CommunityRuntimeError>;

pub trait QueryEmbedder: Send {
    fn embed_prepared(&mut self, prepared_text: &str) -> Result<Vec<f32>>;
}

pub struct CommunityLocalCore<E: QueryEmbedder> {
    search: CommunitySearchCore,
    queries: CommonQueryCore,
    query_cache: Option<LocalQueryCache>,
    last_query_prune_ms: Mutex<u64>,
    advertising: AdvertisingCatalogCore,
    interests: Mutex<InterestState>,
    interest_storage: Option<InterestStorage>,
    embedder: Mutex<E>,
}

struct InterestStorage {
    path: PathBuf,
    key: [u8; 32],
}

impl<E: QueryEmbedder> CommunityLocalCore<E> {
    pub fn open(
        root: impl AsRef<Path>,
        expected_scope: impl Into<String>,
        catalog_verifying_key: VerifyingKey,
        embedder: E,
    ) -> Result<Self> {
        Self::open_with_scope(root, expected_scope, catalog_verifying_key, embedder)
    }

    pub fn open_with_scope(
        root: impl AsRef<Path>,
        expected_scope: impl Into<String>,
        catalog_verifying_key: VerifyingKey,
        embedder: E,
    ) -> Result<Self> {
        Self::open_with_keys(
            root,
            expected_scope,
            catalog_verifying_key,
            catalog_verifying_key,
            embedder,
        )
    }

    pub fn open_with_keys(
        root: impl AsRef<Path>,
        expected_scope: impl Into<String>,
        catalog_verifying_key: VerifyingKey,
        advertising_verifying_key: VerifyingKey,
        embedder: E,
    ) -> Result<Self> {
        Self::open_internal(
            root,
            expected_scope,
            catalog_verifying_key,
            advertising_verifying_key,
            None,
            embedder,
        )
    }

    pub fn open_with_keys_and_query_cache(
        root: impl AsRef<Path>,
        expected_scope: impl Into<String>,
        catalog_verifying_key: VerifyingKey,
        advertising_verifying_key: VerifyingKey,
        query_cache_key: [u8; 32],
        embedder: E,
    ) -> Result<Self> {
        Self::open_internal(
            root,
            expected_scope,
            catalog_verifying_key,
            advertising_verifying_key,
            Some(query_cache_key),
            embedder,
        )
    }

    fn open_internal(
        root: impl AsRef<Path>,
        expected_scope: impl Into<String>,
        catalog_verifying_key: VerifyingKey,
        advertising_verifying_key: VerifyingKey,
        query_cache_key: Option<[u8; 32]>,
        embedder: E,
    ) -> Result<Self> {
        let root = root.as_ref();
        let expected_scope = expected_scope.into();
        let interest_storage = query_cache_key.map(|key| InterestStorage {
            path: root.join(INTEREST_STATE_FILE),
            key,
        });
        let interests = match &interest_storage {
            Some(storage) if storage.path.exists() => {
                let mut state = InterestState::open_from_protected_storage(
                    &fs::read(&storage.path).map_err(|error| {
                        CommunityRuntimeError::Search(CommunitySearchError::Storage(format!(
                            "read local personalization state: {error}"
                        )))
                    })?,
                    &storage.key,
                )?;
                state.set_enabled(true);
                state
            }
            Some(_) => {
                let mut state = InterestState::default();
                state.set_enabled(true);
                state
            }
            None => InterestState::default(),
        };
        Ok(Self {
            search: CommunitySearchCore::open(root, expected_scope.clone(), catalog_verifying_key)?,
            queries: CommonQueryCore::open(
                root.join("common-queries"),
                expected_scope,
                catalog_verifying_key,
            )?,
            query_cache: query_cache_key
                .map(|key| {
                    LocalQueryCache::open(
                        root.join("local-query-cache"),
                        key,
                        DEFAULT_LOCAL_QUERY_CACHE_CAPACITY,
                    )
                })
                .transpose()?,
            last_query_prune_ms: Mutex::new(0),
            advertising: AdvertisingCatalogCore::open(
                root.join("advertising"),
                advertising_verifying_key,
            )?,
            interests: Mutex::new(interests),
            interest_storage,
            embedder: Mutex::new(embedder),
        })
    }

    pub fn install_catalog(
        &self,
        manifest_json: &[u8],
        payload_json: &[u8],
        now_ms: u64,
    ) -> Result<InstalledGeneration> {
        Ok(self.search.install(manifest_json, payload_json, now_ms)?)
    }

    pub fn active_generation(&self, now_ms: u64) -> Result<InstalledGeneration> {
        Ok(self.search.active_generation(now_ms)?)
    }

    pub fn install_query_catalog(
        &self,
        manifest_json: &[u8],
        payload_json: &[u8],
        now_ms: u64,
    ) -> Result<u64> {
        Ok(self.queries.install(manifest_json, payload_json, now_ms)?)
    }

    pub fn install_advertising_catalog(
        &self,
        response_json: &[u8],
        country: &str,
        placement: AdvertisingPlacement,
        now_ms: u64,
    ) -> Result<u64> {
        Ok(self
            .advertising
            .install(response_json, country, placement, now_ms)?)
    }

    pub fn advertisements(
        &self,
        request: &AdvertisingSelectionRequest,
        now_ms: u64,
    ) -> Result<Vec<AdvertisingSelection>> {
        request.validate()?;
        let interests = self
            .interests
            .lock()
            .map_err(|_| CommunityRuntimeError::LockUnavailable)?;
        Ok(self.advertising.select(
            &request.country,
            request.placement,
            request.limit,
            Some(&interests),
            now_ms,
        )?)
    }

    pub fn advertisements_json(&self, request_json: &[u8], now_ms: u64) -> Result<Vec<u8>> {
        let request: AdvertisingSelectionRequest =
            serde_json::from_slice(request_json).map_err(|error| {
                CommunityRuntimeError::InvalidRequest(format!(
                    "invalid advertising request JSON: {error}"
                ))
            })?;
        serde_json::to_vec(&self.advertisements(&request, now_ms)?).map_err(|error| {
            CommunityRuntimeError::InvalidRequest(format!(
                "advertising results could not be encoded: {error}"
            ))
        })
    }

    pub fn record_advertising_view(
        &self,
        request: &AdvertisingViewRequest,
        now_ms: u64,
    ) -> Result<bool> {
        request.validate()?;
        Ok(self.advertising.record_view(
            &request.country,
            request.placement,
            &request.campaign_id,
            now_ms,
        )?)
    }

    pub fn status(&self, now_ms: u64) -> Result<CommunityRuntimeStatus> {
        self.prune_query_cache_if_due(now_ms)?;
        let local_query_cache = self
            .query_cache
            .as_ref()
            .map(LocalQueryCache::status)
            .transpose()?;
        Ok(CommunityRuntimeStatus {
            catalog: self.search.active_generation(now_ms)?,
            query_sequence: self.queries.active_sequence(now_ms)?,
            local_query_entries: local_query_cache.as_ref().map_or(0, |value| value.entries),
            local_query_capacity: local_query_cache.as_ref().map_or(0, |value| value.capacity),
        })
    }

    pub fn suggestions(
        &self,
        request: &CommunitySuggestionRequest,
        now_ms: u64,
    ) -> Result<Vec<PublicQuerySuggestion>> {
        request.validate()?;
        let model = ModelContract::harrier_v1();
        self.prune_query_cache_if_due(now_ms)?;
        let local = self
            .query_cache
            .as_ref()
            .map(|cache| cache.suggest(&request.prefix, &request.language, &model, request.limit))
            .transpose()?
            .unwrap_or_default();
        let downloaded = match self.queries.suggest(
            &request.prefix,
            &request.language,
            &model,
            request.limit,
            now_ms,
        ) {
            Ok(value) => value,
            Err(CommunitySearchError::NoActiveGeneration) => Vec::new(),
            Err(error) => return Err(error.into()),
        };
        let mut seen = HashSet::new();
        let mut suggestions = Vec::with_capacity(request.limit);
        for suggestion in local {
            let key = (
                suggestion.normalized_text.clone(),
                suggestion.language.clone(),
            );
            if seen.insert(key) {
                suggestions.push(PublicQuerySuggestion::from(suggestion));
                if suggestions.len() == request.limit {
                    return Ok(suggestions);
                }
            }
        }
        for suggestion in downloaded {
            let key = (
                suggestion.normalized_text.clone(),
                suggestion.language.clone(),
            );
            if seen.insert(key) {
                suggestions.push(PublicQuerySuggestion::from(suggestion));
                if suggestions.len() == request.limit {
                    return Ok(suggestions);
                }
            }
        }
        Ok(suggestions)
    }

    pub fn clear_query_cache(&self) -> Result<()> {
        if let Some(cache) = &self.query_cache {
            cache.clear()?;
        }
        let mut interests = self
            .interests
            .lock()
            .map_err(|_| CommunityRuntimeError::LockUnavailable)?;
        interests.reset();
        interests.set_enabled(self.interest_storage.is_some());
        self.persist_interests(&interests)?;
        Ok(())
    }

    pub fn local_query_cache_status(
        &self,
    ) -> Result<Option<community_search_core::LocalQueryCacheStatus>> {
        self.query_cache
            .as_ref()
            .map(LocalQueryCache::status)
            .transpose()
            .map_err(Into::into)
    }

    pub fn search(
        &self,
        request: &CommunitySearchRequest,
        now_ms: u64,
    ) -> Result<Vec<SearchResult>> {
        request.validate()?;
        let model = ModelContract::harrier_v1();
        self.prune_query_cache_if_due(now_ms)?;
        let cached = self
            .query_cache
            .as_ref()
            .map(|cache| cache.lookup(&request.query, &request.language, &model))
            .transpose()?
            .flatten();
        let downloaded = if cached.is_none() {
            match self
                .queries
                .lookup(&request.query, &request.language, &model, now_ms)
            {
                Ok(value) => value,
                Err(CommunitySearchError::NoActiveGeneration) => None,
                Err(error) => return Err(error.into()),
            }
        } else {
            None
        };
        let query = if let Some(suggestion) = cached.or(downloaded) {
            suggestion.query
        } else {
            let prepared = prepare_query_v2(&request.query)?;
            let embedding = self.embedder()?.embed_prepared(&prepared)?;
            LocalQueryEmbedding { model, embedding }
        };
        let filters = SearchFilters {
            kinds: request.kinds.clone(),
            coarse_region: request.coarse_region.clone(),
            include_advertising: request.include_advertising,
        };
        let results = {
            let mut interests = self
                .interests
                .lock()
                .map_err(|_| CommunityRuntimeError::LockUnavailable)?;
            let fingerprint = event_fingerprint(&[
                "search_submitted",
                &request.language,
                &normalize_query_text_v1(&request.query)?,
            ])?;
            interests.record(
                request.interest_domain(),
                InterestSignal::SearchSubmitted,
                &fingerprint,
                &query.model,
                &query.embedding,
                now_ms,
            )?;
            self.persist_interests(&interests)?;
            self.search
                .search_personalized(&query, request.limit, &filters, &interests, now_ms)?
        };
        if let Some(cache) = &self.query_cache {
            cache.record(&request.query, &request.language, &query, now_ms)?;
        }
        Ok(results)
    }

    pub fn record_interest(
        &self,
        request: &CommunityInterestRequest,
        now_ms: u64,
    ) -> Result<PersonalizationUpdate> {
        request.validate()?;
        let item = self.search.interest_item(&request.public_id, now_ms)?;
        let signal = request.signal.to_core();
        let fingerprint = event_fingerprint(&[request.signal.as_str(), &request.public_id])?;
        let mut interests = self
            .interests
            .lock()
            .map_err(|_| CommunityRuntimeError::LockUnavailable)?;
        let update = interests.record(
            interest_domain(item.kind),
            signal,
            &fingerprint,
            &item.model,
            &item.embedding,
            now_ms,
        )?;
        self.persist_interests(&interests)?;
        Ok(update)
    }

    pub fn record_interest_json(&self, request_json: &[u8], now_ms: u64) -> Result<Vec<u8>> {
        let request: CommunityInterestRequest =
            serde_json::from_slice(request_json).map_err(|error| {
                CommunityRuntimeError::InvalidRequest(format!(
                    "invalid local interest event JSON: {error}"
                ))
            })?;
        let status = personalization_status(self.record_interest(&request, now_ms)?);
        serde_json::to_vec(&CommunityInterestResponse { status }).map_err(|error| {
            CommunityRuntimeError::InvalidRequest(format!(
                "local interest event response could not be encoded: {error}"
            ))
        })
    }

    fn persist_interests(&self, interests: &InterestState) -> Result<()> {
        let Some(storage) = &self.interest_storage else {
            return Ok(());
        };
        let sealed = interests.seal_for_protected_storage(&storage.key)?;
        let temporary = storage.path.with_extension("sealed.tmp");
        let previous = storage.path.with_extension("sealed.previous");
        fs::write(&temporary, sealed).map_err(|error| {
            CommunityRuntimeError::Search(CommunitySearchError::Storage(format!(
                "write local personalization state: {error}"
            )))
        })?;
        if storage.path.exists() {
            if previous.exists() {
                fs::remove_file(&previous).map_err(|error| {
                    CommunityRuntimeError::Search(CommunitySearchError::Storage(format!(
                        "remove stale local personalization backup: {error}"
                    )))
                })?;
            }
            fs::rename(&storage.path, &previous).map_err(|error| {
                CommunityRuntimeError::Search(CommunitySearchError::Storage(format!(
                    "backup local personalization state: {error}"
                )))
            })?;
        }
        if let Err(error) = fs::rename(&temporary, &storage.path) {
            if previous.exists() {
                let _ = fs::rename(&previous, &storage.path);
            }
            return Err(CommunityRuntimeError::Search(
                CommunitySearchError::Storage(format!(
                    "activate local personalization state: {error}"
                )),
            ));
        }
        if previous.exists() {
            fs::remove_file(&previous).map_err(|error| {
                CommunityRuntimeError::Search(CommunitySearchError::Storage(format!(
                    "remove local personalization backup: {error}"
                )))
            })?;
        }
        Ok(())
    }

    pub fn search_json(&self, request_json: &[u8], now_ms: u64) -> Result<Vec<u8>> {
        let request: CommunitySearchRequest =
            serde_json::from_slice(request_json).map_err(|error| {
                CommunityRuntimeError::InvalidRequest(format!("invalid JSON: {error}"))
            })?;
        let public_results: Vec<PublicSearchResult> = self
            .search(&request, now_ms)?
            .into_iter()
            .map(PublicSearchResult::from)
            .collect();
        serde_json::to_vec(&public_results).map_err(|error| {
            CommunityRuntimeError::InvalidRequest(format!(
                "search results could not be encoded: {error}"
            ))
        })
    }

    fn embedder(&self) -> Result<MutexGuard<'_, E>> {
        self.embedder
            .lock()
            .map_err(|_| CommunityRuntimeError::LockUnavailable)
    }

    fn prune_query_cache_if_due(&self, now_ms: u64) -> Result<()> {
        let Some(cache) = &self.query_cache else {
            return Ok(());
        };
        let mut last = self
            .last_query_prune_ms
            .lock()
            .map_err(|_| CommunityRuntimeError::LockUnavailable)?;
        if *last == 0 || now_ms.saturating_sub(*last) >= QUERY_CACHE_PRUNE_INTERVAL_MS {
            cache.prune(now_ms)?;
            *last = now_ms;
        }
        Ok(())
    }
}

/// Renderer-safe suggestion. The native query vector and normalized lookup
/// key deliberately never cross the mobile/desktop FFI boundary.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicQuerySuggestion {
    pub query_id: String,
    pub display_text: String,
    pub language: String,
    pub weight: f32,
}

impl From<QuerySuggestion> for PublicQuerySuggestion {
    fn from(value: QuerySuggestion) -> Self {
        Self {
            query_id: value.query_id,
            display_text: value.display_text,
            language: value.language,
            weight: value.weight,
        }
    }
}

impl From<LocalQuerySuggestion> for PublicQuerySuggestion {
    fn from(value: LocalQuerySuggestion) -> Self {
        Self {
            query_id: value.query_id,
            display_text: value.display_text,
            language: value.language,
            weight: value.weight,
        }
    }
}

/// Renderer-safe catalog item. Model provenance and embeddings are verified
/// and consumed inside Rust, but are not public product data.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicCatalogItem {
    pub public_id: String,
    pub revision: u64,
    pub owner_public_id: String,
    pub kind: CatalogItemKind,
    pub title: String,
    pub summary: String,
    pub roles: Vec<String>,
    pub categories: Vec<String>,
    pub languages: Vec<String>,
    pub coarse_region: Option<String>,
    pub radius_km: Option<u16>,
    pub media: Vec<MediaReference>,
    pub published_at_ms: u64,
    pub expires_at_ms: Option<u64>,
    pub sponsored: bool,
}

impl From<CatalogItem> for PublicCatalogItem {
    fn from(value: CatalogItem) -> Self {
        let sponsored = value.sponsorship.is_some();
        Self {
            public_id: value.public_id,
            revision: value.revision,
            owner_public_id: value.owner_public_id,
            kind: value.kind,
            title: value.title,
            summary: value.summary,
            roles: value.roles,
            categories: value.categories,
            languages: value.languages,
            coarse_region: value.coarse_region,
            radius_km: value.radius_km,
            media: value.media,
            published_at_ms: value.published_at_ms,
            expires_at_ms: value.expires_at_ms,
            sponsored,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicSearchResult {
    pub item: PublicCatalogItem,
    pub semantic_distance: f32,
    pub personal_adjustment: f32,
    pub combined_score: f32,
}

impl From<SearchResult> for PublicSearchResult {
    fn from(value: SearchResult) -> Self {
        Self {
            item: PublicCatalogItem::from(value.item),
            semantic_distance: value.semantic_distance,
            personal_adjustment: value.personal_adjustment,
            combined_score: value.combined_score,
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CommunitySearchRequest {
    pub query: String,
    #[serde(default = "default_language")]
    pub language: String,
    #[serde(default = "default_limit")]
    pub limit: usize,
    #[serde(default)]
    pub kinds: Vec<CatalogItemKind>,
    #[serde(default)]
    pub coarse_region: Option<String>,
    #[serde(default)]
    pub include_advertising: bool,
}

impl CommunitySearchRequest {
    fn validate(&self) -> Result<()> {
        if self.limit == 0 || self.limit > MAX_RESULTS {
            return Err(CommunityRuntimeError::InvalidRequest(
                "result limit must be between 1 and 50".to_owned(),
            ));
        }
        validate_language(&self.language)?;
        Ok(())
    }

    fn interest_domain(&self) -> InterestDomain {
        if !self.kinds.is_empty() && self.kinds.iter().all(|kind| *kind == CatalogItemKind::News) {
            InterestDomain::News
        } else if !self.kinds.is_empty()
            && self
                .kinds
                .iter()
                .all(|kind| *kind == CatalogItemKind::Advertisement)
        {
            InterestDomain::Advertising
        } else {
            InterestDomain::Discovery
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CommunityInterestSignal {
    ContentOpened,
    LongerLocalView,
    ContactRequested,
    SavedLocally,
    MoreLikeThis,
    LessLikeThis,
    Hidden,
}

impl CommunityInterestSignal {
    fn as_str(self) -> &'static str {
        match self {
            Self::ContentOpened => "content_opened",
            Self::LongerLocalView => "longer_local_view",
            Self::ContactRequested => "contact_requested",
            Self::SavedLocally => "saved_locally",
            Self::MoreLikeThis => "more_like_this",
            Self::LessLikeThis => "less_like_this",
            Self::Hidden => "hidden",
        }
    }

    fn to_core(self) -> InterestSignal {
        match self {
            Self::ContentOpened => InterestSignal::ContentOpened,
            Self::LongerLocalView => InterestSignal::LongerLocalView,
            Self::ContactRequested => InterestSignal::ContactRequested,
            Self::SavedLocally => InterestSignal::SavedLocally,
            Self::MoreLikeThis => InterestSignal::MoreLikeThis,
            Self::LessLikeThis => InterestSignal::LessLikeThis,
            Self::Hidden => InterestSignal::Hidden,
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CommunityInterestRequest {
    pub public_id: String,
    pub signal: CommunityInterestSignal,
}

impl CommunityInterestRequest {
    fn validate(&self) -> Result<()> {
        if self.public_id.is_empty() || self.public_id.len() > 128 {
            return Err(CommunityRuntimeError::InvalidRequest(
                "local interest event public id is invalid".to_owned(),
            ));
        }
        Ok(())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CommunityInterestResponse {
    status: &'static str,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CommunitySuggestionRequest {
    pub prefix: String,
    #[serde(default = "default_language")]
    pub language: String,
    #[serde(default = "default_suggestion_limit")]
    pub limit: usize,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct AdvertisingSelectionRequest {
    pub country: String,
    pub placement: AdvertisingPlacement,
    #[serde(default = "default_advertising_limit")]
    pub limit: usize,
}

impl AdvertisingSelectionRequest {
    fn validate(&self) -> Result<()> {
        if self.limit == 0 || self.limit > 20 {
            return Err(CommunityRuntimeError::InvalidRequest(
                "advertising result limit must be between 1 and 20".to_owned(),
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct AdvertisingViewRequest {
    pub country: String,
    pub placement: AdvertisingPlacement,
    pub campaign_id: String,
}

impl AdvertisingViewRequest {
    fn validate(&self) -> Result<()> {
        if self.campaign_id.is_empty() || self.campaign_id.len() > 128 {
            return Err(CommunityRuntimeError::InvalidRequest(
                "advertising campaign id is invalid".to_owned(),
            ));
        }
        Ok(())
    }
}

impl CommunitySuggestionRequest {
    fn validate(&self) -> Result<()> {
        normalize_query_text_v1(&self.prefix)?;
        validate_language(&self.language)?;
        if self.limit == 0 || self.limit > 20 {
            return Err(CommunityRuntimeError::InvalidRequest(
                "suggestion limit must be between 1 and 20".to_owned(),
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommunityRuntimeStatus {
    pub catalog: InstalledGeneration,
    pub query_sequence: u64,
    pub local_query_entries: usize,
    pub local_query_capacity: usize,
}

fn default_limit() -> usize {
    20
}

fn default_suggestion_limit() -> usize {
    8
}

fn default_advertising_limit() -> usize {
    1
}

fn default_language() -> String {
    "en".to_owned()
}

fn interest_domain(kind: CatalogItemKind) -> InterestDomain {
    match kind {
        CatalogItemKind::News => InterestDomain::News,
        CatalogItemKind::Advertisement => InterestDomain::Advertising,
        CatalogItemKind::Profile
        | CatalogItemKind::Post
        | CatalogItemKind::ServiceListing
        | CatalogItemKind::ProductListing => InterestDomain::Discovery,
    }
}

fn event_fingerprint(parts: &[&str]) -> Result<RepetitionFingerprint> {
    let mut digest = Sha256::new();
    digest.update(b"com.tex8.monerowallet.community-interest-event.v1\0");
    for part in parts {
        digest.update((part.len() as u64).to_le_bytes());
        digest.update(part.as_bytes());
    }
    let bytes = digest.finalize();
    let mut encoded = String::with_capacity(64);
    for byte in bytes {
        use std::fmt::Write as _;
        write!(&mut encoded, "{byte:02x}").expect("writing to String cannot fail");
    }
    Ok(RepetitionFingerprint::from_hex(encoded)?)
}

fn personalization_status(update: PersonalizationUpdate) -> &'static str {
    match update {
        PersonalizationUpdate::Applied => "applied",
        PersonalizationUpdate::Disabled => "disabled",
        PersonalizationUpdate::RepetitionCapped => "repetition_capped",
        PersonalizationUpdate::ExcludedSafetyAction => "excluded_safety_action",
        PersonalizationUpdate::ModelResetAndApplied => "model_reset_and_applied",
    }
}

fn validate_language(value: &str) -> Result<()> {
    if value.is_empty()
        || value.len() > 16
        || value
            .bytes()
            .any(|byte| !(byte.is_ascii_alphanumeric() || byte == b'-'))
    {
        return Err(CommunityRuntimeError::InvalidRequest(
            "search language is invalid".to_owned(),
        ));
    }
    Ok(())
}

pub fn prepare_query_v2(query: &str) -> Result<String> {
    let normalized = normalize_query_text_v1(query)?;
    Ok(format!("{HARRIER_QUERY_INSTRUCTION_V2}{normalized}"))
}

#[cfg(feature = "native-harrier")]
mod native {
    use super::*;
    use std::{borrow::Cow, ffi::c_void};

    const HARRIER_OK: i32 = 0;
    const HARRIER_DIMENSION: usize = 640;

    unsafe extern "C" {
        fn tex8_community_harrier_create_v1() -> *mut c_void;
        fn tex8_community_harrier_destroy_v1(handle: *mut c_void);
        fn tex8_community_harrier_load_verified_v1(
            handle: *mut c_void,
            pte_path: *const u8,
            pte_path_len: usize,
            tokenizer_path: *const u8,
            tokenizer_path_len: usize,
        ) -> i32;
        fn tex8_community_harrier_embed_prepared_v1(
            handle: *mut c_void,
            prepared_text: *const u8,
            prepared_text_len: usize,
            output: *mut f32,
            output_len: usize,
        ) -> i32;
        fn tex8_community_harrier_last_error_v1(
            handle: *mut c_void,
            output: *mut u8,
            output_len: *mut usize,
        ) -> i32;
    }

    pub struct NativeHarrier {
        handle: *mut c_void,
    }

    // The C++ handle has its own mutex and this Rust owner never aliases its
    // mutable operations without the enclosing CommunityLocalCore mutex.
    unsafe impl Send for NativeHarrier {}

    impl NativeHarrier {
        #[allow(clippy::too_many_arguments)]
        pub fn load_verified_xnnpack(
            manifest_json: &[u8],
            pte_path: impl AsRef<Path>,
            tokenizer_path: impl AsRef<Path>,
            conformance_report_path: impl AsRef<Path>,
            artifact_verifying_key: &VerifyingKey,
        ) -> Result<Self> {
            let pte_path = pte_path.as_ref();
            let tokenizer_path = tokenizer_path.as_ref();
            let manifest = HarrierArtifactManifest::parse_and_verify_files(
                manifest_json,
                pte_path,
                tokenizer_path,
                conformance_report_path,
                artifact_verifying_key,
            )?;
            if manifest.unsigned.target != HarrierArtifactTarget::XnnpackA8w8 {
                return Err(CommunityRuntimeError::Native(
                    "the portable native adapter accepts only the verified XNNPACK A8W8 artifact"
                        .to_owned(),
                ));
            }

            let pte_bytes = platform_path_bytes(pte_path)?;
            let tokenizer_bytes = platform_path_bytes(tokenizer_path)?;
            // SAFETY: the function has no preconditions and returns an opaque
            // uniquely owned handle or null.
            let handle = unsafe { tex8_community_harrier_create_v1() };
            if handle.is_null() {
                return Err(CommunityRuntimeError::Native(
                    "native Harrier allocation failed".to_owned(),
                ));
            }
            // SAFETY: both path buffers remain alive for the duration of the
            // call and the non-null handle is uniquely owned here.
            let status = unsafe {
                tex8_community_harrier_load_verified_v1(
                    handle,
                    pte_bytes.as_ptr(),
                    pte_bytes.len(),
                    tokenizer_bytes.as_ptr(),
                    tokenizer_bytes.len(),
                )
            };
            if status != HARRIER_OK {
                let error = native_error(handle);
                // SAFETY: ownership has not been transferred.
                unsafe { tex8_community_harrier_destroy_v1(handle) };
                return Err(CommunityRuntimeError::Native(error));
            }
            Ok(Self { handle })
        }
    }

    impl QueryEmbedder for NativeHarrier {
        fn embed_prepared(&mut self, prepared_text: &str) -> Result<Vec<f32>> {
            let mut output = vec![0_f32; HARRIER_DIMENSION];
            // SAFETY: the input and exact-size output buffers remain valid for
            // the call; the enclosing Rust mutex provides unique access.
            let status = unsafe {
                tex8_community_harrier_embed_prepared_v1(
                    self.handle,
                    prepared_text.as_ptr(),
                    prepared_text.len(),
                    output.as_mut_ptr(),
                    output.len(),
                )
            };
            if status != HARRIER_OK {
                return Err(CommunityRuntimeError::Native(native_error(self.handle)));
            }
            Ok(output)
        }
    }

    impl Drop for NativeHarrier {
        fn drop(&mut self) {
            // SAFETY: this type uniquely owns the handle and drops it once.
            unsafe { tex8_community_harrier_destroy_v1(self.handle) };
        }
    }

    fn native_error(handle: *mut c_void) -> String {
        let mut required = 0_usize;
        // SAFETY: size query with a live handle and valid length pointer.
        if unsafe {
            tex8_community_harrier_last_error_v1(handle, std::ptr::null_mut(), &mut required)
        } != HARRIER_OK
            || required <= 1
            || required > 4096
        {
            return "native Harrier operation failed".to_owned();
        }
        let mut bytes = vec![0_u8; required];
        // SAFETY: the allocated buffer is at least `required` bytes.
        if unsafe {
            tex8_community_harrier_last_error_v1(handle, bytes.as_mut_ptr(), &mut required)
        } != HARRIER_OK
        {
            return "native Harrier operation failed".to_owned();
        }
        if bytes.last() == Some(&0) {
            bytes.pop();
        }
        String::from_utf8(bytes).unwrap_or_else(|_| "native Harrier operation failed".to_owned())
    }

    #[cfg(unix)]
    fn platform_path_bytes(path: &Path) -> Result<Cow<'_, [u8]>> {
        use std::os::unix::ffi::OsStrExt;
        let bytes = path.as_os_str().as_bytes();
        if bytes.is_empty() || bytes.contains(&0) {
            return Err(CommunityRuntimeError::InvalidRequest(
                "native asset path is invalid".to_owned(),
            ));
        }
        Ok(Cow::Borrowed(bytes))
    }

    #[cfg(not(unix))]
    fn platform_path_bytes(path: &Path) -> Result<Cow<'_, [u8]>> {
        let value = path.to_str().ok_or_else(|| {
            CommunityRuntimeError::InvalidRequest("native asset path is not valid UTF-8".to_owned())
        })?;
        if value.is_empty() || value.as_bytes().contains(&0) {
            return Err(CommunityRuntimeError::InvalidRequest(
                "native asset path is invalid".to_owned(),
            ));
        }
        Ok(Cow::Borrowed(value.as_bytes()))
    }

    const _: () = assert!(HARRIER_DIMENSION == V1_EMBEDDING_DIMENSION);
}

#[cfg(feature = "native-harrier")]
pub use native::NativeHarrier;

/// Forces the native C ABI into an aggregate mobile static library.
///
/// Mobile packages link one Rust archive containing Matrix and the local
/// catalog runtime so Rust's standard library is not duplicated.
#[cfg(feature = "native-harrier")]
pub fn native_link_anchor_v1() -> usize {
    ffi::tex8_community_runtime_link_anchor_v1()
}

#[cfg(feature = "native-harrier")]
mod ffi {
    use super::*;
    use std::{
        ptr, slice,
        sync::{Mutex, MutexGuard},
    };

    const STATUS_OK: i32 = 0;
    const STATUS_INVALID_ARGUMENT: i32 = 1;
    const STATUS_VERIFICATION_FAILED: i32 = 2;
    const STATUS_OPERATION_FAILED: i32 = 3;
    const MAX_ERROR_BYTES: usize = 4096;
    const MAX_REQUEST_BYTES: usize = 64 * 1024;
    const MAX_CATALOG_MANIFEST_BYTES: usize = 1024 * 1024;
    const MAX_ADVERTISING_CATALOG_BYTES: usize = 8 * 1024 * 1024;

    #[allow(non_camel_case_types)]
    pub struct tex8_community_runtime_handle {
        core: Mutex<CommunityLocalCore<NativeHarrier>>,
        last_error: Mutex<String>,
    }

    #[no_mangle]
    pub unsafe extern "C" fn tex8_community_runtime_create_v1(
        storage_root: *const u8,
        storage_root_len: usize,
        catalog_scope: *const u8,
        catalog_scope_len: usize,
        catalog_verifying_key: *const u8,
        catalog_verifying_key_len: usize,
        advertising_verifying_key: *const u8,
        advertising_verifying_key_len: usize,
        artifact_verifying_key: *const u8,
        artifact_verifying_key_len: usize,
        query_cache_key: *const u8,
        query_cache_key_len: usize,
        artifact_manifest_json: *const u8,
        artifact_manifest_json_len: usize,
        pte_path: *const u8,
        pte_path_len: usize,
        tokenizer_path: *const u8,
        tokenizer_path_len: usize,
        conformance_report_path: *const u8,
        conformance_report_path_len: usize,
        handle_output: *mut *mut tex8_community_runtime_handle,
        error_output: *mut u8,
        error_output_len: *mut usize,
    ) -> i32 {
        if handle_output.is_null() {
            return STATUS_INVALID_ARGUMENT;
        }
        // SAFETY: the caller supplied a non-null output pointer.
        unsafe { *handle_output = ptr::null_mut() };
        let result = (|| {
            let storage_root = ffi_utf8(storage_root, storage_root_len, 4096, "storage root")?;
            let catalog_scope = ffi_utf8(catalog_scope, catalog_scope_len, 128, "catalog scope")?;
            let manifest = ffi_bytes(
                artifact_manifest_json,
                artifact_manifest_json_len,
                MAX_CATALOG_MANIFEST_BYTES,
                "artifact manifest",
            )?;
            let pte_path = ffi_utf8(pte_path, pte_path_len, 4096, "PTE path")?;
            let tokenizer_path =
                ffi_utf8(tokenizer_path, tokenizer_path_len, 4096, "tokenizer path")?;
            let report_path = ffi_utf8(
                conformance_report_path,
                conformance_report_path_len,
                4096,
                "conformance report path",
            )?;
            let catalog_key =
                ffi_verifying_key(catalog_verifying_key, catalog_verifying_key_len, "catalog")?;
            let advertising_key = ffi_verifying_key(
                advertising_verifying_key,
                advertising_verifying_key_len,
                "advertising catalog",
            )?;
            let artifact_key = ffi_verifying_key(
                artifact_verifying_key,
                artifact_verifying_key_len,
                "artifact",
            )?;
            let query_cache_key =
                ffi_secret_key(query_cache_key, query_cache_key_len, "query cache")?;
            let harrier = NativeHarrier::load_verified_xnnpack(
                manifest,
                Path::new(pte_path),
                Path::new(tokenizer_path),
                Path::new(report_path),
                &artifact_key,
            )?;
            let core = CommunityLocalCore::open_with_keys_and_query_cache(
                Path::new(storage_root),
                catalog_scope,
                catalog_key,
                advertising_key,
                query_cache_key,
                harrier,
            )?;
            Ok::<_, CommunityRuntimeError>(Box::new(tex8_community_runtime_handle {
                core: Mutex::new(core),
                last_error: Mutex::new(String::new()),
            }))
        })();
        match result {
            Ok(handle) => {
                // SAFETY: ownership of the Box is transferred to the caller.
                unsafe { *handle_output = Box::into_raw(handle) };
                write_message("", error_output, error_output_len);
                STATUS_OK
            }
            Err(error) => {
                write_message(&sanitized_error(&error), error_output, error_output_len);
                status_for_error(&error)
            }
        }
    }

    #[no_mangle]
    pub unsafe extern "C" fn tex8_community_runtime_destroy_v1(
        handle: *mut tex8_community_runtime_handle,
    ) {
        if !handle.is_null() {
            // SAFETY: the C contract transfers the exact pointer returned by
            // create and calls destroy once.
            drop(unsafe { Box::from_raw(handle) });
        }
    }

    #[no_mangle]
    pub unsafe extern "C" fn tex8_community_runtime_install_catalog_v1(
        handle: *mut tex8_community_runtime_handle,
        manifest_json: *const u8,
        manifest_json_len: usize,
        payload_json: *const u8,
        payload_json_len: usize,
        now_ms: u64,
    ) -> i32 {
        let Some(handle) = handle.as_ref() else {
            return STATUS_INVALID_ARGUMENT;
        };
        let result = (|| {
            let manifest = ffi_bytes(
                manifest_json,
                manifest_json_len,
                MAX_CATALOG_MANIFEST_BYTES,
                "catalog manifest",
            )?;
            let payload = ffi_bytes(
                payload_json,
                payload_json_len,
                community_search_core::MAX_CATALOG_BYTES,
                "catalog payload",
            )?;
            lock(&handle.core)?.install_catalog(manifest, payload, now_ms)?;
            Ok(())
        })();
        finish(handle, result)
    }

    #[no_mangle]
    pub unsafe extern "C" fn tex8_community_runtime_install_query_catalog_v1(
        handle: *mut tex8_community_runtime_handle,
        manifest_json: *const u8,
        manifest_json_len: usize,
        payload_json: *const u8,
        payload_json_len: usize,
        now_ms: u64,
    ) -> i32 {
        let Some(handle) = handle.as_ref() else {
            return STATUS_INVALID_ARGUMENT;
        };
        let result = (|| {
            let manifest = ffi_bytes(
                manifest_json,
                manifest_json_len,
                MAX_CATALOG_MANIFEST_BYTES,
                "query catalog manifest",
            )?;
            let payload = ffi_bytes(
                payload_json,
                payload_json_len,
                community_search_core::MAX_CATALOG_BYTES,
                "query catalog payload",
            )?;
            lock(&handle.core)?.install_query_catalog(manifest, payload, now_ms)?;
            Ok(())
        })();
        finish(handle, result)
    }

    #[no_mangle]
    pub unsafe extern "C" fn tex8_community_runtime_install_advertising_catalog_v1(
        handle: *mut tex8_community_runtime_handle,
        response_json: *const u8,
        response_json_len: usize,
        country: *const u8,
        country_len: usize,
        placement: *const u8,
        placement_len: usize,
        now_ms: u64,
    ) -> i32 {
        let Some(handle) = handle.as_ref() else {
            return STATUS_INVALID_ARGUMENT;
        };
        let result = (|| {
            let response = ffi_bytes(
                response_json,
                response_json_len,
                MAX_ADVERTISING_CATALOG_BYTES,
                "advertising catalog",
            )?;
            let country = ffi_utf8(country, country_len, 2, "advertising country")?;
            let placement = ffi_advertising_placement(ffi_utf8(
                placement,
                placement_len,
                16,
                "advertising placement",
            )?)?;
            lock(&handle.core)?
                .install_advertising_catalog(response, country, placement, now_ms)?;
            Ok(())
        })();
        finish(handle, result)
    }

    #[no_mangle]
    pub unsafe extern "C" fn tex8_community_runtime_status_v1(
        handle: *mut tex8_community_runtime_handle,
        now_ms: u64,
        result_output: *mut *mut u8,
        result_output_len: *mut usize,
    ) -> i32 {
        with_output(handle, result_output, result_output_len, |core| {
            serde_json::to_vec(&core.status(now_ms)?).map_err(|error| {
                CommunityRuntimeError::InvalidRequest(format!(
                    "runtime status could not be encoded: {error}"
                ))
            })
        })
    }

    #[no_mangle]
    pub unsafe extern "C" fn tex8_community_runtime_suggestions_v1(
        handle: *mut tex8_community_runtime_handle,
        request_json: *const u8,
        request_json_len: usize,
        now_ms: u64,
        result_output: *mut *mut u8,
        result_output_len: *mut usize,
    ) -> i32 {
        let Some(handle) = handle.as_ref() else {
            return STATUS_INVALID_ARGUMENT;
        };
        let result = (|| {
            let request_bytes = ffi_bytes(
                request_json,
                request_json_len,
                MAX_REQUEST_BYTES,
                "suggestion request",
            )?;
            let request: CommunitySuggestionRequest = serde_json::from_slice(request_bytes)
                .map_err(|error| {
                    CommunityRuntimeError::InvalidRequest(format!(
                        "invalid suggestion JSON: {error}"
                    ))
                })?;
            let encoded = serde_json::to_vec(&lock(&handle.core)?.suggestions(&request, now_ms)?)
                .map_err(|error| {
                CommunityRuntimeError::InvalidRequest(format!(
                    "suggestions could not be encoded: {error}"
                ))
            })?;
            transfer_output(encoded, result_output, result_output_len)
        })();
        finish(handle, result)
    }

    #[no_mangle]
    pub unsafe extern "C" fn tex8_community_runtime_search_v1(
        handle: *mut tex8_community_runtime_handle,
        request_json: *const u8,
        request_json_len: usize,
        now_ms: u64,
        result_output: *mut *mut u8,
        result_output_len: *mut usize,
    ) -> i32 {
        let Some(handle) = handle.as_ref() else {
            return STATUS_INVALID_ARGUMENT;
        };
        let result = (|| {
            let request = ffi_bytes(
                request_json,
                request_json_len,
                MAX_REQUEST_BYTES,
                "search request",
            )?;
            let encoded = lock(&handle.core)?.search_json(request, now_ms)?;
            transfer_output(encoded, result_output, result_output_len)
        })();
        finish(handle, result)
    }

    #[no_mangle]
    pub unsafe extern "C" fn tex8_community_runtime_record_interest_v1(
        handle: *mut tex8_community_runtime_handle,
        request_json: *const u8,
        request_json_len: usize,
        now_ms: u64,
        result_output: *mut *mut u8,
        result_output_len: *mut usize,
    ) -> i32 {
        let Some(handle) = handle.as_ref() else {
            return STATUS_INVALID_ARGUMENT;
        };
        let result = (|| {
            let request = ffi_bytes(
                request_json,
                request_json_len,
                MAX_REQUEST_BYTES,
                "local interest event",
            )?;
            let encoded = lock(&handle.core)?.record_interest_json(request, now_ms)?;
            transfer_output(encoded, result_output, result_output_len)
        })();
        finish(handle, result)
    }

    #[no_mangle]
    pub unsafe extern "C" fn tex8_community_runtime_clear_query_cache_v1(
        handle: *mut tex8_community_runtime_handle,
    ) -> i32 {
        let Some(handle) = handle.as_ref() else {
            return STATUS_INVALID_ARGUMENT;
        };
        let result = (|| lock(&handle.core)?.clear_query_cache())();
        finish(handle, result)
    }

    #[no_mangle]
    pub unsafe extern "C" fn tex8_community_runtime_advertisements_v1(
        handle: *mut tex8_community_runtime_handle,
        request_json: *const u8,
        request_json_len: usize,
        now_ms: u64,
        result_output: *mut *mut u8,
        result_output_len: *mut usize,
    ) -> i32 {
        let Some(handle) = handle.as_ref() else {
            return STATUS_INVALID_ARGUMENT;
        };
        let result = (|| {
            let request = ffi_bytes(
                request_json,
                request_json_len,
                MAX_REQUEST_BYTES,
                "advertising selection request",
            )?;
            let encoded = lock(&handle.core)?.advertisements_json(request, now_ms)?;
            transfer_output(encoded, result_output, result_output_len)
        })();
        finish(handle, result)
    }

    #[no_mangle]
    pub unsafe extern "C" fn tex8_community_runtime_record_advertising_view_v1(
        handle: *mut tex8_community_runtime_handle,
        request_json: *const u8,
        request_json_len: usize,
        now_ms: u64,
    ) -> i32 {
        let Some(handle) = handle.as_ref() else {
            return STATUS_INVALID_ARGUMENT;
        };
        let result = (|| {
            let request = ffi_bytes(
                request_json,
                request_json_len,
                MAX_REQUEST_BYTES,
                "advertising view request",
            )?;
            let request: AdvertisingViewRequest =
                serde_json::from_slice(request).map_err(|error| {
                    CommunityRuntimeError::InvalidRequest(format!(
                        "invalid advertising view JSON: {error}"
                    ))
                })?;
            lock(&handle.core)?.record_advertising_view(&request, now_ms)?;
            Ok(())
        })();
        finish(handle, result)
    }

    #[no_mangle]
    pub unsafe extern "C" fn tex8_community_runtime_free_buffer_v1(
        buffer: *mut u8,
        buffer_len: usize,
    ) {
        if !buffer.is_null() && buffer_len > 0 {
            let raw = ptr::slice_from_raw_parts_mut(buffer, buffer_len);
            // SAFETY: search transfers a Box<[u8]> with this pointer/length.
            drop(unsafe { Box::from_raw(raw) });
        }
    }

    #[no_mangle]
    pub unsafe extern "C" fn tex8_community_runtime_last_error_v1(
        handle: *mut tex8_community_runtime_handle,
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

    #[no_mangle]
    pub extern "C" fn tex8_community_runtime_link_anchor_v1() -> usize {
        tex8_community_runtime_create_v1 as *const () as usize
            ^ tex8_community_runtime_destroy_v1 as *const () as usize
            ^ tex8_community_runtime_install_catalog_v1 as *const () as usize
            ^ tex8_community_runtime_install_query_catalog_v1 as *const () as usize
            ^ tex8_community_runtime_install_advertising_catalog_v1 as *const () as usize
            ^ tex8_community_runtime_status_v1 as *const () as usize
            ^ tex8_community_runtime_suggestions_v1 as *const () as usize
            ^ tex8_community_runtime_search_v1 as *const () as usize
            ^ tex8_community_runtime_record_interest_v1 as *const () as usize
            ^ tex8_community_runtime_clear_query_cache_v1 as *const () as usize
            ^ tex8_community_runtime_advertisements_v1 as *const () as usize
            ^ tex8_community_runtime_record_advertising_view_v1 as *const () as usize
            ^ tex8_community_runtime_free_buffer_v1 as *const () as usize
            ^ tex8_community_runtime_last_error_v1 as *const () as usize
    }

    fn ffi_bytes<'a>(
        pointer: *const u8,
        length: usize,
        maximum: usize,
        label: &str,
    ) -> Result<&'a [u8]> {
        if pointer.is_null() || length == 0 || length > maximum {
            return Err(CommunityRuntimeError::InvalidRequest(format!(
                "{label} length is invalid"
            )));
        }
        // SAFETY: the FFI contract requires a readable `length`-byte buffer
        // which remains valid for this call.
        Ok(unsafe { slice::from_raw_parts(pointer, length) })
    }

    fn ffi_utf8<'a>(
        pointer: *const u8,
        length: usize,
        maximum: usize,
        label: &str,
    ) -> Result<&'a str> {
        let bytes = ffi_bytes(pointer, length, maximum, label)?;
        std::str::from_utf8(bytes).map_err(|_| {
            CommunityRuntimeError::InvalidRequest(format!("{label} is not valid UTF-8"))
        })
    }

    fn ffi_verifying_key(pointer: *const u8, length: usize, label: &str) -> Result<VerifyingKey> {
        let bytes = ffi_bytes(pointer, length, 32, label)?;
        let array: [u8; 32] = bytes.try_into().map_err(|_| {
            CommunityRuntimeError::InvalidRequest(format!(
                "{label} verification key must be 32 bytes"
            ))
        })?;
        VerifyingKey::from_bytes(&array).map_err(|_| {
            CommunityRuntimeError::InvalidRequest(format!("{label} verification key is invalid"))
        })
    }

    fn ffi_secret_key(pointer: *const u8, length: usize, label: &str) -> Result<[u8; 32]> {
        let bytes = ffi_bytes(pointer, length, 32, label)?;
        bytes.try_into().map_err(|_| {
            CommunityRuntimeError::InvalidRequest(format!("{label} key must be 32 bytes"))
        })
    }

    fn ffi_advertising_placement(value: &str) -> Result<AdvertisingPlacement> {
        match value {
            "news" => Ok(AdvertisingPlacement::News),
            "community" => Ok(AdvertisingPlacement::Community),
            "catalog" => Ok(AdvertisingPlacement::Catalog),
            _ => Err(CommunityRuntimeError::InvalidRequest(
                "advertising placement is invalid".to_owned(),
            )),
        }
    }

    fn lock<T>(value: &Mutex<T>) -> Result<MutexGuard<'_, T>> {
        value
            .lock()
            .map_err(|_| CommunityRuntimeError::LockUnavailable)
    }

    fn with_output(
        handle: *mut tex8_community_runtime_handle,
        result_output: *mut *mut u8,
        result_output_len: *mut usize,
        callback: impl FnOnce(&CommunityLocalCore<NativeHarrier>) -> Result<Vec<u8>>,
    ) -> i32 {
        let Some(handle) = (unsafe { handle.as_ref() }) else {
            return STATUS_INVALID_ARGUMENT;
        };
        let result = (|| {
            let core = lock(&handle.core)?;
            transfer_output(callback(&core)?, result_output, result_output_len)
        })();
        finish(handle, result)
    }

    fn transfer_output(
        encoded: Vec<u8>,
        result_output: *mut *mut u8,
        result_output_len: *mut usize,
    ) -> Result<()> {
        if result_output.is_null() || result_output_len.is_null() {
            return Err(CommunityRuntimeError::InvalidRequest(
                "Community output pointer is invalid".to_owned(),
            ));
        }
        let mut boxed = encoded.into_boxed_slice();
        let length = boxed.len();
        if length == 0 {
            return Err(CommunityRuntimeError::InvalidRequest(
                "Community output is empty".to_owned(),
            ));
        }
        let pointer = boxed.as_mut_ptr();
        std::mem::forget(boxed);
        // SAFETY: ownership of this exact boxed slice is transferred to C.
        unsafe {
            *result_output = pointer;
            *result_output_len = length;
        }
        Ok(())
    }

    fn finish(handle: &tex8_community_runtime_handle, result: Result<()>) -> i32 {
        match result {
            Ok(()) => set_error(handle, STATUS_OK, ""),
            Err(error) => {
                let status = status_for_error(&error);
                set_error(handle, status, &sanitized_error(&error))
            }
        }
    }

    fn set_error(handle: &tex8_community_runtime_handle, status: i32, message: &str) -> i32 {
        let Ok(mut error) = handle.last_error.lock() else {
            return STATUS_OPERATION_FAILED;
        };
        error.clear();
        error.push_str(message);
        status
    }

    fn status_for_error(error: &CommunityRuntimeError) -> i32 {
        match error {
            CommunityRuntimeError::InvalidRequest(_) => STATUS_INVALID_ARGUMENT,
            CommunityRuntimeError::Search(
                CommunitySearchError::InvalidSignature
                | CommunitySearchError::PayloadHashMismatch
                | CommunitySearchError::ScopeMismatch
                | CommunitySearchError::PolicyExpired
                | CommunitySearchError::SequenceMismatch
                | CommunitySearchError::ModelMismatch
                | CommunitySearchError::InvalidCatalog(_),
            ) => STATUS_VERIFICATION_FAILED,
            _ => STATUS_OPERATION_FAILED,
        }
    }

    fn sanitized_error(error: &CommunityRuntimeError) -> String {
        let mut value = error.to_string();
        value.truncate(MAX_ERROR_BYTES.saturating_sub(1));
        value
    }

    fn write_message(message: &str, output: *mut u8, output_len: *mut usize) -> i32 {
        if output_len.is_null() {
            return STATUS_INVALID_ARGUMENT;
        }
        let required = message.len() + 1;
        // SAFETY: output_len was validated.
        let available = unsafe { *output_len };
        if output.is_null() {
            // SAFETY: output_len was validated.
            unsafe { *output_len = required };
            return STATUS_OK;
        }
        if available < required {
            // SAFETY: output_len was validated.
            unsafe { *output_len = required };
            return STATUS_INVALID_ARGUMENT;
        }
        // SAFETY: caller provided at least `required` writable bytes.
        unsafe {
            ptr::copy_nonoverlapping(message.as_ptr(), output, message.len());
            *output.add(message.len()) = 0;
            *output_len = required;
        }
        STATUS_OK
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
    use chrono::{DateTime, SecondsFormat, Utc};
    use community_search_core::{
        normalize_query_text_v1, AdvertisingCampaign, AdvertisingCampaignStatus,
        AdvertisingCatalog, AdvertisingKind, AdvertisingLabel, CatalogEmbeddingChunk,
        CatalogEmbeddingSource, CatalogItem, CatalogPayload, CatalogSnapshot, QueryCatalogEntry,
        QueryCatalogPayload, QueryCatalogSnapshot, SignedAdvertisingCatalog, SignedCatalogPackage,
        SignedQueryCatalogPackage, QUERY_NORMALIZATION_VERSION, V1_EMBEDDING_DIMENSION,
    };
    use ed25519_dalek::{Signer, SigningKey};
    use rand::rngs::OsRng;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };

    const NOW: u64 = 1_800_000_000_000;

    struct MustNotEmbed;

    impl QueryEmbedder for MustNotEmbed {
        fn embed_prepared(&mut self, _prepared_text: &str) -> Result<Vec<f32>> {
            Err(CommunityRuntimeError::Native(
                "the native embedder must not run for a signed common query".to_owned(),
            ))
        }
    }

    struct CountingEmbedder(Arc<AtomicUsize>);

    impl QueryEmbedder for CountingEmbedder {
        fn embed_prepared(&mut self, _prepared_text: &str) -> Result<Vec<f32>> {
            self.0.fetch_add(1, Ordering::SeqCst);
            Ok(unit_vector())
        }
    }

    struct FixedEmbedder(Vec<f32>);

    impl QueryEmbedder for FixedEmbedder {
        fn embed_prepared(&mut self, _prepared_text: &str) -> Result<Vec<f32>> {
            Ok(self.0.clone())
        }
    }

    fn unit_vector() -> Vec<f32> {
        unit_vector_axis(0)
    }

    fn unit_vector_axis(axis: usize) -> Vec<f32> {
        let mut value = vec![0.0; V1_EMBEDDING_DIMENSION];
        value[axis] = 1.0;
        value
    }

    fn timestamp(value: u64) -> String {
        DateTime::<Utc>::from_timestamp_millis(i64::try_from(value).unwrap())
            .unwrap()
            .to_rfc3339_opts(SecondsFormat::Millis, true)
    }

    fn signed_advertising_catalog(signing_key: &SigningKey) -> Vec<u8> {
        let catalog = AdvertisingCatalog {
            catalog_scope_id: "ads:US:news".to_owned(),
            jurisdiction_review_ids: vec!["review-v1".to_owned()],
            policy_version: "advertising-v1".to_owned(),
            generation: 1,
            generated_at: timestamp(NOW),
            expires_at: timestamp(NOW + 10 * 60 * 1_000),
            campaigns: vec![AdvertisingCampaign {
                campaign_id: "campaign-one".to_owned(),
                content_revision: 1,
                advertiser_id: "advertiser-one".to_owned(),
                advertiser_display_name: "Example Hardware Company".to_owned(),
                paid_by_id: "payer-one".to_owned(),
                paid_by_display_name: "Example Hardware Company".to_owned(),
                kind: AdvertisingKind::OrdinaryProduct,
                placement: AdvertisingPlacement::News,
                title: "Protect your hardware wallet".to_owned(),
                body: "Learn about a reviewed hardware wallet product.".to_owned(),
                destination_url: "https://example.com/hardware".to_owned(),
                media_url: Some("https://cdn.tex8.com/ads/hardware.webp".to_owned()),
                starts_at: timestamp(NOW - 1_000),
                ends_at: timestamp(NOW + 24 * 60 * 60 * 1_000),
                eligible_categories: vec!["hardware".to_owned()],
                eligible_regions: vec!["US".to_owned()],
                placement_weight: 50,
                frequency_cap: 1,
                sponsorship_label: AdvertisingLabel::Advertisement,
                embedding_model: None,
                embedding: None,
                status: AdvertisingCampaignStatus::Approved,
                created_at: timestamp(NOW - 60_000),
                reviewed_at: Some(timestamp(NOW - 30_000)),
                jurisdiction_review_id: Some("review-v1".to_owned()),
            }],
        };
        let bytes = serde_json::to_vec(&catalog).unwrap();
        serde_json::to_vec(&SignedAdvertisingCatalog {
            catalog,
            signed_catalog: BASE64.encode(&bytes),
            algorithm: "Ed25519".to_owned(),
            signing_key_id: "advertising-test-key".to_owned(),
            signing_public_key: BASE64.encode(signing_key.verifying_key().as_bytes()),
            signature: BASE64.encode(signing_key.sign(&bytes).to_bytes()),
        })
        .unwrap()
    }

    #[test]
    fn query_preparation_is_normalized_and_frozen() {
        let prepared = prepare_query_v2("  PRIVACY\u{00a0}Tools  ").expect("query");
        assert_eq!(
            prepared,
            format!("{HARRIER_QUERY_INSTRUCTION_V2}privacy tools")
        );
        assert!(!prepared.contains("Monero community"));
    }

    #[test]
    fn query_preparation_rejects_controls_and_empty_text() {
        assert!(prepare_query_v2("").is_err());
        assert!(prepare_query_v2("hello\u{0007}world").is_err());
    }

    #[test]
    fn request_rejects_unbounded_results() {
        let request = CommunitySearchRequest {
            query: "privacy".to_owned(),
            language: "en".to_owned(),
            limit: 51,
            kinds: Vec::new(),
            coarse_region: None,
            include_advertising: false,
        };
        assert!(request.validate().is_err());
    }

    #[test]
    fn signed_advertising_stays_native_and_frequency_cap_survives_renderer_calls() {
        let directory = tempfile::tempdir().unwrap();
        let catalog_signer = SigningKey::generate(&mut OsRng);
        let advertising_signer = SigningKey::generate(&mut OsRng);
        let core = CommunityLocalCore::open_with_keys(
            directory.path(),
            "global-v1",
            catalog_signer.verifying_key(),
            advertising_signer.verifying_key(),
            MustNotEmbed,
        )
        .unwrap();
        core.install_advertising_catalog(
            &signed_advertising_catalog(&advertising_signer),
            "US",
            AdvertisingPlacement::News,
            NOW,
        )
        .unwrap();
        let request = br#"{"country":"US","placement":"news","limit":1}"#;
        let selected = core.advertisements_json(request, NOW).unwrap();
        let selected: serde_json::Value = serde_json::from_slice(&selected).unwrap();
        assert_eq!(selected.as_array().unwrap().len(), 1);
        assert!(selected[0].get("embedding").is_none());
        assert!(selected[0].get("embeddingModel").is_none());
        assert_eq!(selected[0]["paidByDisplayName"], "Example Hardware Company");

        assert!(core
            .record_advertising_view(
                &AdvertisingViewRequest {
                    country: "US".to_owned(),
                    placement: AdvertisingPlacement::News,
                    campaign_id: "campaign-one".to_owned(),
                },
                NOW,
            )
            .unwrap());
        let after_cap: serde_json::Value =
            serde_json::from_slice(&core.advertisements_json(request, NOW).unwrap()).unwrap();
        assert!(after_cap.as_array().unwrap().is_empty());
    }

    #[test]
    fn signed_common_query_bypasses_native_inference_and_searches_locally() {
        let directory = tempfile::tempdir().unwrap();
        let signer = SigningKey::generate(&mut OsRng);
        let core = CommunityLocalCore::open(
            directory.path(),
            "global-v1",
            signer.verifying_key(),
            MustNotEmbed,
        )
        .unwrap();
        let model = ModelContract::harrier_v1();
        let catalog = CatalogPayload::Snapshot(CatalogSnapshot {
            schema_version: 1,
            catalog_scope_id: "global-v1".to_owned(),
            sequence: 1,
            model: model.clone(),
            items: vec![CatalogItem {
                public_id: "profile-one".to_owned(),
                revision: 1,
                owner_public_id: "person-one".to_owned(),
                kind: CatalogItemKind::Profile,
                title: "Privacy engineer".to_owned(),
                summary: "Builds private local-first software.".to_owned(),
                roles: vec!["engineer".to_owned()],
                categories: vec!["privacy".to_owned()],
                languages: vec!["en".to_owned()],
                coarse_region: None,
                radius_km: None,
                media: Vec::new(),
                published_at_ms: NOW - 10_000,
                expires_at_ms: None,
                moderation_decision_id: "decision-one".to_owned(),
                sponsorship: None,
                model: model.clone(),
                embedding: unit_vector(),
                embedding_chunks: vec![CatalogEmbeddingChunk {
                    source: CatalogEmbeddingSource::Description,
                    ordinal: 0,
                    embedding: unit_vector(),
                }],
            }],
            tombstones: Vec::new(),
        });
        let signed_catalog = SignedCatalogPackage::create(
            &catalog,
            &signer,
            "review-v1",
            "policy-v1",
            NOW - 1_000,
            NOW + 60_000,
        )
        .unwrap();
        core.install_catalog(
            &signed_catalog.manifest_json,
            &signed_catalog.payload_json,
            NOW,
        )
        .unwrap();
        assert_eq!(
            core.install_catalog(
                &signed_catalog.manifest_json,
                &signed_catalog.payload_json,
                NOW,
            )
            .unwrap()
            .sequence,
            1
        );

        let query_catalog = QueryCatalogPayload::Snapshot(QueryCatalogSnapshot {
            schema_version: 1,
            catalog_scope_id: "global-v1".to_owned(),
            sequence: 1,
            normalization_version: QUERY_NORMALIZATION_VERSION.to_owned(),
            model: model.clone(),
            entries: vec![QueryCatalogEntry {
                query_id: "privacy-query".to_owned(),
                revision: 1,
                normalized_text: normalize_query_text_v1("Privacy").unwrap(),
                display_text: "Privacy".to_owned(),
                language: "en".to_owned(),
                weight: 1.0,
                model,
                embedding: unit_vector(),
            }],
            tombstones: Vec::new(),
        });
        let signed_queries = SignedQueryCatalogPackage::create(
            &query_catalog,
            &signer,
            "review-v1",
            "policy-v1",
            NOW - 1_000,
            NOW + 60_000,
        )
        .unwrap();
        core.install_query_catalog(
            &signed_queries.manifest_json,
            &signed_queries.payload_json,
            NOW,
        )
        .unwrap();
        assert_eq!(
            core.install_query_catalog(
                &signed_queries.manifest_json,
                &signed_queries.payload_json,
                NOW,
            )
            .unwrap(),
            1
        );

        let results = core
            .search(
                &CommunitySearchRequest {
                    query: "  PRIVACY  ".to_owned(),
                    language: "en".to_owned(),
                    limit: 5,
                    kinds: Vec::new(),
                    coarse_region: None,
                    include_advertising: false,
                },
                NOW,
            )
            .unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].item.public_id, "profile-one");
        let public_json = core
            .search_json(
                br#"{"query":"privacy","language":"en","limit":5,"kinds":[],"includeAdvertising":false}"#,
                NOW,
            )
            .unwrap();
        let public_text = std::str::from_utf8(&public_json).unwrap();
        assert!(!public_text.contains("\"embedding\""));
        assert!(!public_text.contains("\"model\""));
        assert!(public_text.contains("\"ownerPublicId\":\"person-one\""));
        let suggestions = serde_json::to_string(
            &core
                .suggestions(
                    &CommunitySuggestionRequest {
                        prefix: "pri".to_owned(),
                        language: "en".to_owned(),
                        limit: 5,
                    },
                    NOW,
                )
                .unwrap(),
        )
        .unwrap();
        assert!(!suggestions.contains("\"embedding\""));
        assert!(!suggestions.contains("\"model\""));
        assert!(!suggestions.contains("\"normalizedText\""));
        let status = core.status(NOW).unwrap();
        assert_eq!(status.catalog.sequence, 1);
        assert_eq!(status.query_sequence, 1);

        // A process restart does not require a network refresh while both
        // signed generations are still complete and valid on disk.
        drop(core);
        let reopened = CommunityLocalCore::open(
            directory.path(),
            "global-v1",
            signer.verifying_key(),
            MustNotEmbed,
        )
        .unwrap();
        let reopened_status = reopened.status(NOW + 1).unwrap();
        assert_eq!(reopened_status.catalog.sequence, 1);
        assert_eq!(reopened_status.query_sequence, 1);
        assert_eq!(
            reopened
                .suggestions(
                    &CommunitySuggestionRequest {
                        prefix: "pri".to_owned(),
                        language: "en".to_owned(),
                        limit: 5,
                    },
                    NOW + 1,
                )
                .unwrap()[0]
                .display_text,
            "Privacy"
        );
    }

    #[test]
    fn renderer_search_keeps_only_the_best_vector_hit_per_listing() {
        let directory = tempfile::tempdir().unwrap();
        let signer = SigningKey::generate(&mut OsRng);
        let core = CommunityLocalCore::open(
            directory.path(),
            "global-v1",
            signer.verifying_key(),
            MustNotEmbed,
        )
        .unwrap();
        let model = ModelContract::harrier_v1();
        let mut repeated = CatalogItem {
            public_id: "repeated-listing".to_owned(),
            revision: 1,
            owner_public_id: "person-repeated".to_owned(),
            kind: CatalogItemKind::ProductListing,
            title: "Repeated vector listing".to_owned(),
            summary: "One product with several independently ranked text vectors.".to_owned(),
            roles: Vec::new(),
            categories: vec!["privacy".to_owned()],
            languages: vec!["en".to_owned()],
            coarse_region: None,
            radius_km: None,
            media: Vec::new(),
            published_at_ms: NOW - 1_000,
            expires_at_ms: Some(NOW + 30_000),
            moderation_decision_id: "decision-repeated".to_owned(),
            sponsorship: None,
            model: model.clone(),
            embedding: unit_vector(),
            embedding_chunks: Vec::new(),
        };
        repeated.embedding_chunks = (0..16)
            .map(|ordinal| CatalogEmbeddingChunk {
                source: CatalogEmbeddingSource::Description,
                ordinal,
                embedding: unit_vector(),
            })
            .collect();
        let mut items = vec![repeated];
        items.extend((0..25).map(|index| CatalogItem {
            public_id: format!("distinct-listing-{index:02}"),
            revision: 1,
            owner_public_id: format!("person-{index:02}"),
            kind: CatalogItemKind::ProductListing,
            title: format!("Distinct listing {index:02}"),
            summary: "A distinct product result.".to_owned(),
            roles: Vec::new(),
            categories: vec!["privacy".to_owned()],
            languages: vec!["en".to_owned()],
            coarse_region: None,
            radius_km: None,
            media: Vec::new(),
            published_at_ms: NOW - 1_000,
            expires_at_ms: Some(NOW + 30_000),
            moderation_decision_id: format!("decision-{index:02}"),
            sponsorship: None,
            model: model.clone(),
            embedding: unit_vector_axis(index + 1),
            embedding_chunks: Vec::new(),
        }));
        let catalog = CatalogPayload::Snapshot(CatalogSnapshot {
            schema_version: 1,
            catalog_scope_id: "global-v1".to_owned(),
            sequence: 1,
            model: model.clone(),
            items,
            tombstones: Vec::new(),
        });
        let signed_catalog = SignedCatalogPackage::create(
            &catalog,
            &signer,
            "review-v1",
            "policy-v1",
            NOW - 1_000,
            NOW + 60_000,
        )
        .unwrap();
        core.install_catalog(
            &signed_catalog.manifest_json,
            &signed_catalog.payload_json,
            NOW,
        )
        .unwrap();
        let query_catalog = QueryCatalogPayload::Snapshot(QueryCatalogSnapshot {
            schema_version: 1,
            catalog_scope_id: "global-v1".to_owned(),
            sequence: 1,
            normalization_version: QUERY_NORMALIZATION_VERSION.to_owned(),
            model: model.clone(),
            entries: vec![QueryCatalogEntry {
                query_id: "privacy-query".to_owned(),
                revision: 1,
                normalized_text: normalize_query_text_v1("Privacy").unwrap(),
                display_text: "Privacy".to_owned(),
                language: "en".to_owned(),
                weight: 1.0,
                model,
                embedding: unit_vector(),
            }],
            tombstones: Vec::new(),
        });
        let signed_queries = SignedQueryCatalogPackage::create(
            &query_catalog,
            &signer,
            "review-v1",
            "policy-v1",
            NOW - 1_000,
            NOW + 60_000,
        )
        .unwrap();
        core.install_query_catalog(
            &signed_queries.manifest_json,
            &signed_queries.payload_json,
            NOW,
        )
        .unwrap();

        let encoded = core
            .search_json(
                br#"{"query":"privacy","language":"en","limit":25,"kinds":["product_listing"],"includeAdvertising":false}"#,
                NOW,
            )
            .unwrap();
        let results: serde_json::Value = serde_json::from_slice(&encoded).unwrap();
        let results = results.as_array().unwrap();

        assert_eq!(results.len(), 25);
        assert_eq!(
            results[0]["item"]["publicId"].as_str(),
            Some("repeated-listing")
        );
        assert_eq!(
            results
                .iter()
                .filter(|result| {
                    result["item"]["publicId"].as_str() == Some("repeated-listing")
                })
                .count(),
            1
        );
    }

    #[test]
    fn entered_query_is_cached_suggested_and_reused_without_inference() {
        let directory = tempfile::tempdir().unwrap();
        let signer = SigningKey::generate(&mut OsRng);
        let calls = Arc::new(AtomicUsize::new(0));
        let core = CommunityLocalCore::open_with_keys_and_query_cache(
            directory.path(),
            "global-v1",
            signer.verifying_key(),
            signer.verifying_key(),
            [0x71; 32],
            CountingEmbedder(calls.clone()),
        )
        .unwrap();
        let model = ModelContract::harrier_v1();
        let catalog = CatalogPayload::Snapshot(CatalogSnapshot {
            schema_version: 1,
            catalog_scope_id: "global-v1".to_owned(),
            sequence: 1,
            model: model.clone(),
            items: vec![CatalogItem {
                public_id: "service-one".to_owned(),
                revision: 1,
                owner_public_id: "person-one".to_owned(),
                kind: CatalogItemKind::ServiceListing,
                title: "Private software consulting".to_owned(),
                summary: "Local-first product development.".to_owned(),
                roles: Vec::new(),
                categories: vec!["software".to_owned()],
                languages: vec!["en".to_owned()],
                coarse_region: None,
                radius_km: None,
                media: Vec::new(),
                published_at_ms: NOW - 1_000,
                expires_at_ms: Some(NOW + 30_000),
                moderation_decision_id: "decision-one".to_owned(),
                sponsorship: None,
                model,
                embedding: unit_vector(),
                embedding_chunks: Vec::new(),
            }],
            tombstones: Vec::new(),
        });
        let signed = SignedCatalogPackage::create(
            &catalog,
            &signer,
            "review-v1",
            "policy-v1",
            NOW - 1_000,
            NOW + 60_000,
        )
        .unwrap();
        core.install_catalog(&signed.manifest_json, &signed.payload_json, NOW)
            .unwrap();
        let request = CommunitySearchRequest {
            query: "Custom privacy consultant".to_owned(),
            language: "en".to_owned(),
            limit: 5,
            kinds: Vec::new(),
            coarse_region: None,
            include_advertising: false,
        };

        assert_eq!(core.search(&request, NOW).unwrap().len(), 1);
        assert_eq!(calls.load(Ordering::SeqCst), 1);

        // The private cache survives a normal app restart with the same
        // platform-protected key and avoids a second model invocation.
        drop(core);
        let core = CommunityLocalCore::open_with_keys_and_query_cache(
            directory.path(),
            "global-v1",
            signer.verifying_key(),
            signer.verifying_key(),
            [0x71; 32],
            CountingEmbedder(calls.clone()),
        )
        .unwrap();
        assert_eq!(core.search(&request, NOW + 1).unwrap().len(), 1);
        assert_eq!(calls.load(Ordering::SeqCst), 1);

        let suggestions = core
            .suggestions(
                &CommunitySuggestionRequest {
                    prefix: "custom pri".to_owned(),
                    language: "en".to_owned(),
                    limit: 8,
                },
                NOW + 1,
            )
            .unwrap();
        assert_eq!(suggestions.len(), 1);
        assert_eq!(suggestions[0].display_text, "Custom privacy consultant");
        assert!(suggestions[0].query_id.starts_with("local:"));
        let cache_status = core.local_query_cache_status().unwrap().unwrap();
        assert_eq!(cache_status.entries, 1);
        assert_eq!(cache_status.capacity, DEFAULT_LOCAL_QUERY_CACHE_CAPACITY);

        core.clear_query_cache().unwrap();
        assert!(core
            .suggestions(
                &CommunitySuggestionRequest {
                    prefix: "custom pri".to_owned(),
                    language: "en".to_owned(),
                    limit: 8,
                },
                NOW + 2,
            )
            .unwrap()
            .is_empty());
        assert_eq!(core.search(&request, NOW + 2).unwrap().len(), 1);
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn local_interest_is_encrypted_persisted_and_reranks_after_restart() {
        let directory = tempfile::tempdir().unwrap();
        let signer = SigningKey::generate(&mut OsRng);
        let model = ModelContract::harrier_v1();
        let make_item = |public_id: &str, axis: usize| CatalogItem {
            public_id: public_id.to_owned(),
            revision: 1,
            owner_public_id: format!("person-{public_id}"),
            kind: CatalogItemKind::ServiceListing,
            title: format!("Service {public_id}"),
            summary: "A locally personalized catalog test service.".to_owned(),
            roles: Vec::new(),
            categories: vec!["test".to_owned()],
            languages: vec!["en".to_owned()],
            coarse_region: None,
            radius_km: None,
            media: Vec::new(),
            published_at_ms: NOW - 1_000,
            expires_at_ms: Some(NOW + 60_000),
            moderation_decision_id: format!("decision-{public_id}"),
            sponsorship: None,
            model: model.clone(),
            embedding: unit_vector_axis(axis),
            embedding_chunks: Vec::new(),
        };
        let catalog = CatalogPayload::Snapshot(CatalogSnapshot {
            schema_version: 1,
            catalog_scope_id: "global-v1".to_owned(),
            sequence: 1,
            model: model.clone(),
            items: vec![make_item("service-a", 0), make_item("service-b", 1)],
            tombstones: Vec::new(),
        });
        let signed = SignedCatalogPackage::create(
            &catalog,
            &signer,
            "review-v1",
            "policy-v1",
            NOW - 1_000,
            NOW + 60_000,
        )
        .unwrap();
        let key = [0x42; 32];
        let core = CommunityLocalCore::open_with_keys_and_query_cache(
            directory.path(),
            "global-v1",
            signer.verifying_key(),
            signer.verifying_key(),
            key,
            FixedEmbedder(unit_vector_axis(2)),
        )
        .unwrap();
        core.install_catalog(&signed.manifest_json, &signed.payload_json, NOW)
            .unwrap();
        assert_eq!(
            core.record_interest(
                &CommunityInterestRequest {
                    public_id: "service-b".to_owned(),
                    signal: CommunityInterestSignal::ContentOpened,
                },
                NOW,
            )
            .unwrap(),
            PersonalizationUpdate::Applied
        );
        let sealed = fs::read(directory.path().join(INTEREST_STATE_FILE)).unwrap();
        assert!(!sealed
            .windows("service-b".len())
            .any(|window| window == b"service-b"));
        drop(core);

        let reopened = CommunityLocalCore::open_with_keys_and_query_cache(
            directory.path(),
            "global-v1",
            signer.verifying_key(),
            signer.verifying_key(),
            key,
            FixedEmbedder(unit_vector_axis(2)),
        )
        .unwrap();
        let results = reopened
            .search(
                &CommunitySearchRequest {
                    query: "unrelated local query".to_owned(),
                    language: "en".to_owned(),
                    limit: 2,
                    kinds: vec![CatalogItemKind::ServiceListing],
                    coarse_region: None,
                    include_advertising: false,
                },
                NOW + 1,
            )
            .unwrap();
        assert_eq!(results[0].item.public_id, "service-b");
        assert!(results[0].personal_adjustment > results[1].personal_adjustment);
    }
}
