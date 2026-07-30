use crate::{
    model::{validate_embedding, validate_identifier, validate_text},
    CommunitySearchError, InterestDomain, InterestState, ModelContract, Result,
    HARRIER_V1_MODEL_ID, V1_EMBEDDING_DIMENSION,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use chrono::{DateTime, Utc};
use ed25519_dalek::{Signature, VerifyingKey};
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
};
use url::Url;

const DATABASE_FILE: &str = "advertising.sqlite3";
const MAX_SIGNED_CATALOG_BYTES: usize = 8 * 1024 * 1024;
const MAX_CAMPAIGNS: usize = 10_000;
const DAY_MS: u64 = 24 * 60 * 60 * 1_000;
const MAX_CATALOG_VALIDITY_MS: u64 = 15 * 60 * 1_000;
const MAX_CAMPAIGN_DURATION_MS: u64 = 30 * DAY_MS;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AdvertisingKind {
    OrdinaryProduct,
    OrdinaryService,
    NewsSponsorship,
    CryptoExchange,
    CryptoInvestment,
    CryptoYield,
    Gambling,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AdvertisingPlacement {
    News,
    Community,
    Catalog,
}

impl AdvertisingPlacement {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::News => "news",
            Self::Community => "community",
            Self::Catalog => "catalog",
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AdvertisingLabel {
    Advertisement,
    Sponsored,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AdvertisingCampaignStatus {
    Draft,
    Approved,
    Withdrawn,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AdvertisingCampaign {
    pub campaign_id: String,
    pub content_revision: u64,
    pub advertiser_id: String,
    pub advertiser_display_name: String,
    pub paid_by_id: String,
    pub paid_by_display_name: String,
    pub kind: AdvertisingKind,
    pub placement: AdvertisingPlacement,
    pub title: String,
    pub body: String,
    pub destination_url: String,
    pub media_url: Option<String>,
    pub starts_at: String,
    pub ends_at: String,
    pub eligible_categories: Vec<String>,
    pub eligible_regions: Vec<String>,
    pub placement_weight: u16,
    pub frequency_cap: u16,
    pub sponsorship_label: AdvertisingLabel,
    pub embedding_model: Option<String>,
    pub embedding: Option<Vec<f32>>,
    pub status: AdvertisingCampaignStatus,
    pub created_at: String,
    pub reviewed_at: Option<String>,
    pub jurisdiction_review_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AdvertisingCatalog {
    pub catalog_scope_id: String,
    pub jurisdiction_review_ids: Vec<String>,
    pub policy_version: String,
    pub generation: u64,
    pub generated_at: String,
    pub expires_at: String,
    pub campaigns: Vec<AdvertisingCampaign>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SignedAdvertisingCatalog {
    pub catalog: AdvertisingCatalog,
    pub signed_catalog: String,
    pub algorithm: String,
    pub signing_key_id: String,
    pub signing_public_key: String,
    pub signature: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AdvertisingSelectionReason {
    ContextualPlacement,
    LocalInterests,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdvertisingSelection {
    pub campaign_id: String,
    pub content_revision: u64,
    pub advertiser_id: String,
    pub advertiser_display_name: String,
    pub paid_by_id: String,
    pub paid_by_display_name: String,
    pub title: String,
    pub body: String,
    pub destination_url: String,
    pub media_url: Option<String>,
    pub eligible_categories: Vec<String>,
    pub sponsorship_label: AdvertisingLabel,
    pub starts_at_ms: u64,
    pub ends_at_ms: u64,
    pub frequency_cap: u16,
    pub selection_reason: AdvertisingSelectionReason,
}

pub struct AdvertisingCatalogCore {
    database_path: PathBuf,
    verifying_key: VerifyingKey,
}

impl AdvertisingCatalogCore {
    pub fn open(root: impl AsRef<Path>, verifying_key: VerifyingKey) -> Result<Self> {
        fs::create_dir_all(root.as_ref())
            .map_err(|error| storage("create advertising catalog directory", error))?;
        let database_path = root.as_ref().join(DATABASE_FILE);
        let database = open_database(&database_path)?;
        initialize_database(&database)?;
        Ok(Self {
            database_path,
            verifying_key,
        })
    }

    pub fn install(
        &self,
        response_json: &[u8],
        expected_country: &str,
        expected_placement: AdvertisingPlacement,
        now_ms: u64,
    ) -> Result<u64> {
        if response_json.is_empty() || response_json.len() > MAX_SIGNED_CATALOG_BYTES {
            return invalid("signed advertising response size is invalid");
        }
        let response: SignedAdvertisingCatalog = serde_json::from_slice(response_json)
            .map_err(|error| invalid_error(format!("advertising response is invalid: {error}")))?;
        if response.algorithm != "Ed25519" {
            return invalid("advertising signature algorithm is invalid");
        }
        validate_identifier("advertising signing key id", &response.signing_key_id, 80)?;
        let public_key = BASE64
            .decode(&response.signing_public_key)
            .map_err(|_| invalid_error("advertising public key is invalid"))?;
        if public_key.as_slice() != self.verifying_key.as_bytes() {
            return Err(CommunitySearchError::InvalidSignature);
        }
        let signed_catalog = BASE64
            .decode(&response.signed_catalog)
            .map_err(|_| invalid_error("signed advertising catalog is invalid"))?;
        if signed_catalog.is_empty() || signed_catalog.len() > MAX_SIGNED_CATALOG_BYTES {
            return invalid("signed advertising catalog size is invalid");
        }
        let signature = BASE64
            .decode(&response.signature)
            .ok()
            .and_then(|bytes| Signature::from_slice(&bytes).ok())
            .ok_or(CommunitySearchError::InvalidSignature)?;
        self.verifying_key
            .verify_strict(&signed_catalog, &signature)
            .map_err(|_| CommunitySearchError::InvalidSignature)?;
        let catalog: AdvertisingCatalog =
            serde_json::from_slice(&signed_catalog).map_err(|error| {
                invalid_error(format!("signed advertising JSON is invalid: {error}"))
            })?;
        if catalog != response.catalog {
            return Err(CommunitySearchError::PayloadHashMismatch);
        }
        let country = validate_country(expected_country)?;
        validate_catalog(&catalog, &country, expected_placement, now_ms)?;
        let scope = expected_scope(&country, expected_placement);
        let payload_hash = hex::encode(Sha256::digest(&signed_catalog));

        let mut database = open_database(&self.database_path)?;
        let transaction = database
            .transaction()
            .map_err(|error| storage("begin advertising catalog installation", error))?;
        let current = transaction
            .query_row(
                "SELECT generation, payload_sha256
                 FROM advertising_catalog WHERE scope = ?1",
                [&scope],
                |row| Ok((row.get::<_, u64>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()
            .map_err(|error| storage("read active advertising generation", error))?;
        if let Some((generation, current_hash)) = current {
            if generation == catalog.generation && current_hash == payload_hash {
                return Ok(generation);
            }
            if catalog.generation <= generation {
                return Err(CommunitySearchError::SequenceMismatch);
            }
        }

        transaction
            .execute(
                "DELETE FROM advertising_campaign WHERE scope = ?1",
                [&scope],
            )
            .map_err(|error| storage("replace advertising campaigns", error))?;
        for campaign in &catalog.campaigns {
            transaction
                .execute(
                    "INSERT INTO advertising_campaign(
                       scope, campaign_id, starts_at_ms, ends_at_ms,
                       placement_weight, frequency_cap, campaign_json
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                    params![
                        scope,
                        campaign.campaign_id,
                        timestamp_ms(&campaign.starts_at)?,
                        timestamp_ms(&campaign.ends_at)?,
                        campaign.placement_weight,
                        campaign.frequency_cap,
                        serde_json::to_string(campaign).map_err(|error| {
                            invalid_error(format!(
                                "advertising campaign could not be encoded: {error}"
                            ))
                        })?,
                    ],
                )
                .map_err(|error| storage("store advertising campaign", error))?;
        }
        transaction
            .execute(
                "INSERT INTO advertising_catalog(
                   scope, generation, generated_at_ms, expires_at_ms,
                   policy_version, payload_sha256
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT(scope) DO UPDATE SET
                   generation = excluded.generation,
                   generated_at_ms = excluded.generated_at_ms,
                   expires_at_ms = excluded.expires_at_ms,
                   policy_version = excluded.policy_version,
                   payload_sha256 = excluded.payload_sha256",
                params![
                    scope,
                    catalog.generation,
                    timestamp_ms(&catalog.generated_at)?,
                    timestamp_ms(&catalog.expires_at)?,
                    catalog.policy_version,
                    payload_hash,
                ],
            )
            .map_err(|error| storage("activate advertising catalog", error))?;
        transaction
            .execute(
                "DELETE FROM advertising_view
                 WHERE scope = ?1 AND campaign_id NOT IN (
                   SELECT campaign_id FROM advertising_campaign WHERE scope = ?1
                 )",
                [&scope],
            )
            .map_err(|error| storage("prune advertising frequency state", error))?;
        transaction
            .commit()
            .map_err(|error| storage("commit advertising catalog", error))?;
        Ok(catalog.generation)
    }

    pub fn select(
        &self,
        country: &str,
        placement: AdvertisingPlacement,
        limit: usize,
        interests: Option<&InterestState>,
        now_ms: u64,
    ) -> Result<Vec<AdvertisingSelection>> {
        if limit == 0 || limit > 20 {
            return invalid("advertising result limit must be between 1 and 20");
        }
        let country = validate_country(country)?;
        let scope = expected_scope(&country, placement);
        let database = open_database(&self.database_path)?;
        let expires_at_ms = database
            .query_row(
                "SELECT expires_at_ms FROM advertising_catalog WHERE scope = ?1",
                [&scope],
                |row| row.get::<_, u64>(0),
            )
            .optional()
            .map_err(|error| storage("read advertising catalog expiry", error))?
            .ok_or(CommunitySearchError::NoActiveGeneration)?;
        if now_ms >= expires_at_ms {
            return Err(CommunitySearchError::PolicyExpired);
        }
        let mut statement = database
            .prepare(
                "SELECT campaign_json, placement_weight, frequency_cap
                 FROM advertising_campaign
                 WHERE scope = ?1 AND starts_at_ms <= ?2 AND ends_at_ms > ?2",
            )
            .map_err(|error| storage("query eligible advertising campaigns", error))?;
        let rows = statement
            .query_map(params![scope, now_ms], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, u16>(1)?,
                    row.get::<_, u16>(2)?,
                ))
            })
            .map_err(|error| storage("read eligible advertising campaigns", error))?;
        let mut candidates = Vec::new();
        for row in rows {
            let (campaign_json, weight, frequency_cap) =
                row.map_err(|error| storage("read advertising campaign", error))?;
            let campaign: AdvertisingCampaign = serde_json::from_str(&campaign_json)
                .map_err(|error| storage("decode advertising campaign", error))?;
            let views = current_views(&database, &scope, &campaign.campaign_id, now_ms)?;
            if views >= u64::from(frequency_cap) {
                continue;
            }
            let personal_adjustment = match (interests, campaign.embedding.as_deref()) {
                (Some(interests), Some(embedding)) => interests.personal_score(
                    InterestDomain::Advertising,
                    &ModelContract::harrier_v1(),
                    embedding,
                    now_ms,
                )?,
                _ => 0.0,
            };
            candidates.push((f32::from(weight) / 100.0 + personal_adjustment, campaign));
        }
        candidates.sort_by(|left, right| {
            right
                .0
                .total_cmp(&left.0)
                .then_with(|| left.1.campaign_id.cmp(&right.1.campaign_id))
        });
        candidates
            .into_iter()
            .take(limit)
            .map(|(score, campaign)| selection(campaign, score))
            .collect()
    }

    pub fn record_view(
        &self,
        country: &str,
        placement: AdvertisingPlacement,
        campaign_id: &str,
        now_ms: u64,
    ) -> Result<bool> {
        validate_identifier("advertising campaign id", campaign_id, 128)?;
        let country = validate_country(country)?;
        let scope = expected_scope(&country, placement);
        let mut database = open_database(&self.database_path)?;
        let transaction = database
            .transaction()
            .map_err(|error| storage("begin local advertising view", error))?;
        let campaign = load_active_campaign(&transaction, &scope, campaign_id, now_ms)?
            .ok_or_else(|| invalid_error("advertising campaign is not currently eligible"))?;
        let (window_start_ms, count) = transaction
            .query_row(
                "SELECT window_start_ms, view_count FROM advertising_view
                 WHERE scope = ?1 AND campaign_id = ?2",
                params![scope, campaign_id],
                |row| Ok((row.get::<_, u64>(0)?, row.get::<_, u64>(1)?)),
            )
            .optional()
            .map_err(|error| storage("read local advertising frequency", error))?
            .map(|(window, count)| {
                if now_ms.saturating_sub(window) >= DAY_MS {
                    (now_ms, 0)
                } else {
                    (window, count)
                }
            })
            .unwrap_or((now_ms, 0));
        if count >= u64::from(campaign.frequency_cap) {
            return Ok(false);
        }
        transaction
            .execute(
                "INSERT INTO advertising_view(scope, campaign_id, window_start_ms, view_count)
                 VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(scope, campaign_id) DO UPDATE SET
                   window_start_ms = excluded.window_start_ms,
                   view_count = excluded.view_count",
                params![scope, campaign_id, window_start_ms, count + 1],
            )
            .map_err(|error| storage("store local advertising frequency", error))?;
        transaction
            .commit()
            .map_err(|error| storage("commit local advertising view", error))?;
        Ok(true)
    }
}

fn validate_catalog(
    catalog: &AdvertisingCatalog,
    expected_country: &str,
    expected_placement: AdvertisingPlacement,
    now_ms: u64,
) -> Result<()> {
    if catalog.catalog_scope_id != expected_scope(expected_country, expected_placement) {
        return Err(CommunitySearchError::ScopeMismatch);
    }
    validate_identifier("advertising policy version", &catalog.policy_version, 80)?;
    if catalog.jurisdiction_review_ids.len() > 64 || catalog.campaigns.len() > MAX_CAMPAIGNS {
        return invalid("advertising catalog exceeds its limits");
    }
    for review in &catalog.jurisdiction_review_ids {
        validate_identifier("advertising jurisdiction review id", review, 100)?;
    }
    let generated_at_ms = timestamp_ms(&catalog.generated_at)?;
    let expires_at_ms = timestamp_ms(&catalog.expires_at)?;
    if generated_at_ms > now_ms
        || expires_at_ms <= now_ms
        || expires_at_ms.saturating_sub(generated_at_ms) > MAX_CATALOG_VALIDITY_MS
    {
        return Err(CommunitySearchError::PolicyExpired);
    }
    for campaign in &catalog.campaigns {
        validate_campaign(
            campaign,
            expected_country,
            expected_placement,
            generated_at_ms,
            expires_at_ms,
        )?;
    }
    Ok(())
}

fn validate_campaign(
    campaign: &AdvertisingCampaign,
    expected_country: &str,
    expected_placement: AdvertisingPlacement,
    catalog_generated_at_ms: u64,
    catalog_expires_at_ms: u64,
) -> Result<()> {
    validate_identifier("advertising campaign id", &campaign.campaign_id, 128)?;
    validate_identifier("advertiser id", &campaign.advertiser_id, 100)?;
    validate_identifier("advertising payer id", &campaign.paid_by_id, 100)?;
    validate_text(
        "advertiser display name",
        &campaign.advertiser_display_name,
        2,
        100,
    )?;
    validate_text(
        "advertising payer display name",
        &campaign.paid_by_display_name,
        2,
        100,
    )?;
    validate_text("advertising title", &campaign.title, 4, 80)?;
    validate_text("advertising body", &campaign.body, 8, 280)?;
    if campaign.title.contains(['<', '>']) || campaign.body.contains(['<', '>']) {
        return invalid("advertising text must not contain markup");
    }
    if campaign.content_revision == 0
        || campaign.status != AdvertisingCampaignStatus::Approved
        || campaign.placement != expected_placement
        || matches!(
            campaign.kind,
            AdvertisingKind::CryptoExchange
                | AdvertisingKind::CryptoInvestment
                | AdvertisingKind::CryptoYield
                | AdvertisingKind::Gambling
        )
    {
        return invalid("advertising campaign policy is invalid");
    }
    if !campaign
        .eligible_regions
        .iter()
        .any(|country| country == expected_country)
    {
        return Err(CommunitySearchError::ScopeMismatch);
    }
    if campaign.eligible_categories.is_empty() || campaign.eligible_categories.len() > 12 {
        return invalid("advertising categories are invalid");
    }
    for category in &campaign.eligible_categories {
        validate_identifier("advertising category", category, 50)?;
    }
    let starts_at_ms = timestamp_ms(&campaign.starts_at)?;
    let ends_at_ms = timestamp_ms(&campaign.ends_at)?;
    if starts_at_ms >= ends_at_ms
        || ends_at_ms.saturating_sub(starts_at_ms) > MAX_CAMPAIGN_DURATION_MS
        || ends_at_ms <= catalog_generated_at_ms
        || catalog_expires_at_ms > ends_at_ms
    {
        return invalid("advertising campaign schedule is invalid");
    }
    if campaign.placement_weight == 0
        || campaign.placement_weight > 100
        || campaign.frequency_cap == 0
        || campaign.frequency_cap > 20
    {
        return invalid("advertising placement controls are invalid");
    }
    validate_https_url(&campaign.destination_url, false)?;
    if let Some(media_url) = &campaign.media_url {
        validate_https_url(media_url, true)?;
    }
    match (&campaign.embedding_model, &campaign.embedding) {
        (None, None) => {}
        (Some(model), Some(embedding)) if model == HARRIER_V1_MODEL_ID => {
            validate_embedding(embedding, V1_EMBEDDING_DIMENSION)?;
        }
        _ => return invalid("advertising embedding contract is invalid"),
    }
    timestamp_ms(&campaign.created_at)?;
    timestamp_ms(
        campaign
            .reviewed_at
            .as_deref()
            .ok_or_else(|| invalid_error("approved advertising must contain a review time"))?,
    )?;
    validate_identifier(
        "advertising jurisdiction review id",
        campaign.jurisdiction_review_id.as_deref().ok_or_else(|| {
            invalid_error("approved advertising must contain a jurisdiction review id")
        })?,
        100,
    )
}

fn validate_https_url(value: &str, tex8_only: bool) -> Result<()> {
    let url = Url::parse(value).map_err(|_| invalid_error("advertising URL is invalid"))?;
    let host = url
        .host_str()
        .ok_or_else(|| invalid_error("advertising URL has no host"))?;
    if value.len() > 2_048
        || url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || (tex8_only && host != "tex8.com" && !host.ends_with(".tex8.com"))
    {
        return invalid("advertising URL is invalid");
    }
    Ok(())
}

fn selection(campaign: AdvertisingCampaign, local_score: f32) -> Result<AdvertisingSelection> {
    Ok(AdvertisingSelection {
        campaign_id: campaign.campaign_id,
        content_revision: campaign.content_revision,
        advertiser_id: campaign.advertiser_id,
        advertiser_display_name: campaign.advertiser_display_name,
        paid_by_id: campaign.paid_by_id,
        paid_by_display_name: campaign.paid_by_display_name,
        title: campaign.title,
        body: campaign.body,
        destination_url: campaign.destination_url,
        media_url: campaign.media_url,
        eligible_categories: campaign.eligible_categories,
        sponsorship_label: campaign.sponsorship_label,
        starts_at_ms: timestamp_ms(&campaign.starts_at)?,
        ends_at_ms: timestamp_ms(&campaign.ends_at)?,
        frequency_cap: campaign.frequency_cap,
        selection_reason: if local_score > f32::from(campaign.placement_weight) / 100.0 + 0.001 {
            AdvertisingSelectionReason::LocalInterests
        } else {
            AdvertisingSelectionReason::ContextualPlacement
        },
    })
}

fn load_active_campaign(
    transaction: &Transaction<'_>,
    scope: &str,
    campaign_id: &str,
    now_ms: u64,
) -> Result<Option<AdvertisingCampaign>> {
    let campaign_json = transaction
        .query_row(
            "SELECT campaign_json FROM advertising_campaign
             WHERE scope = ?1 AND campaign_id = ?2
               AND starts_at_ms <= ?3 AND ends_at_ms > ?3",
            params![scope, campaign_id, now_ms],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| storage("read active advertising campaign", error))?;
    campaign_json
        .map(|value| {
            serde_json::from_str(&value)
                .map_err(|error| storage("decode active advertising campaign", error))
        })
        .transpose()
}

fn current_views(
    database: &Connection,
    scope: &str,
    campaign_id: &str,
    now_ms: u64,
) -> Result<u64> {
    let state = database
        .query_row(
            "SELECT window_start_ms, view_count FROM advertising_view
             WHERE scope = ?1 AND campaign_id = ?2",
            params![scope, campaign_id],
            |row| Ok((row.get::<_, u64>(0)?, row.get::<_, u64>(1)?)),
        )
        .optional()
        .map_err(|error| storage("read advertising view count", error))?;
    Ok(state
        .filter(|(window, _)| now_ms.saturating_sub(*window) < DAY_MS)
        .map(|(_, count)| count)
        .unwrap_or(0))
}

fn expected_scope(country: &str, placement: AdvertisingPlacement) -> String {
    format!("ads:{country}:{}", placement.as_str())
}

fn validate_country(value: &str) -> Result<String> {
    let value = value.trim().to_ascii_uppercase();
    if value.len() != 2 || !value.bytes().all(|byte| byte.is_ascii_uppercase()) {
        return invalid("advertising country is invalid");
    }
    Ok(value)
}

fn timestamp_ms(value: &str) -> Result<u64> {
    let timestamp = DateTime::parse_from_rfc3339(value)
        .map_err(|_| invalid_error("advertising timestamp is invalid"))?
        .with_timezone(&Utc)
        .timestamp_millis();
    u64::try_from(timestamp).map_err(|_| invalid_error("advertising timestamp is invalid"))
}

fn open_database(path: &Path) -> Result<Connection> {
    let database = Connection::open(path)
        .map_err(|error| storage("open local advertising database", error))?;
    database
        .execute_batch(
            "PRAGMA foreign_keys = ON;
             PRAGMA trusted_schema = OFF;
             PRAGMA journal_mode = DELETE;
             PRAGMA busy_timeout = 5000;",
        )
        .map_err(|error| storage("configure local advertising database", error))?;
    Ok(database)
}

fn initialize_database(database: &Connection) -> Result<()> {
    database
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS advertising_catalog (
               scope TEXT PRIMARY KEY,
               generation INTEGER NOT NULL,
               generated_at_ms INTEGER NOT NULL,
               expires_at_ms INTEGER NOT NULL,
               policy_version TEXT NOT NULL,
               payload_sha256 TEXT NOT NULL
             ) STRICT;
             CREATE TABLE IF NOT EXISTS advertising_campaign (
               scope TEXT NOT NULL,
               campaign_id TEXT NOT NULL,
               starts_at_ms INTEGER NOT NULL,
               ends_at_ms INTEGER NOT NULL,
               placement_weight INTEGER NOT NULL,
               frequency_cap INTEGER NOT NULL,
               campaign_json TEXT NOT NULL,
               PRIMARY KEY(scope, campaign_id),
               FOREIGN KEY(scope) REFERENCES advertising_catalog(scope)
                 ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
             ) STRICT;
             CREATE INDEX IF NOT EXISTS advertising_active
               ON advertising_campaign(scope, starts_at_ms, ends_at_ms);
             CREATE TABLE IF NOT EXISTS advertising_view (
               scope TEXT NOT NULL,
               campaign_id TEXT NOT NULL,
               window_start_ms INTEGER NOT NULL,
               view_count INTEGER NOT NULL,
               PRIMARY KEY(scope, campaign_id)
             ) STRICT;",
        )
        .map_err(|error| storage("initialize local advertising database", error))
}

fn invalid<T>(message: impl Into<String>) -> Result<T> {
    Err(invalid_error(message))
}

fn invalid_error(message: impl Into<String>) -> CommunitySearchError {
    CommunitySearchError::InvalidCatalog(message.into())
}

fn storage(context: &str, error: impl std::fmt::Display) -> CommunitySearchError {
    CommunitySearchError::Storage(format!("{context}: {error}"))
}
