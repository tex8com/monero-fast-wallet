use crate::{
    CommunitySearchError, Result, MAX_CATALOG_ITEMS, MAX_LISTING_LIFETIME_MS,
    V1_EMBEDDING_DIMENSION,
};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

const GEOHASH_ALPHABET: &str = "0123456789bcdefghjkmnpqrstuvwxyz";
pub const HARRIER_V1_MODEL_ID: &str = "harrier-oss-v1-270m-community-v1";
pub const HARRIER_V1_SOURCE_REVISION: &str = "31de22b673913c7d658c0f03f792d77c2dcf8ebd";
pub const HARRIER_V1_SOURCE_WEIGHTS_SHA256: &str =
    "90933b6826b61afd9331e0ebe3c0598b421a32eda5fb301a114fe36f306cb51a";
pub const HARRIER_V1_TOKENIZER_SHA256: &str =
    "6852f8d561078cc0cebe70ca03c5bfdd0d60a45f9d2e0e1e4cc05b68e9ec329e";
pub const MAX_EMBEDDING_CHUNKS_PER_ITEM: usize = 16;
const HARRIER_V1_DOCUMENT_PROMPT_VERSION: &str = "community-document-v1";
const HARRIER_V1_QUERY_PROMPT_VERSION: &str = "community-query-v2";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ModelContract {
    pub id: String,
    pub weights_sha256: String,
    pub tokenizer_sha256: String,
    pub document_prompt_version: String,
    pub query_prompt_version: String,
    pub pooling: String,
    pub dimension: usize,
    pub normalization: String,
    pub quantization: String,
}

impl ModelContract {
    pub fn harrier_v1() -> Self {
        Self {
            id: HARRIER_V1_MODEL_ID.to_owned(),
            weights_sha256: HARRIER_V1_SOURCE_WEIGHTS_SHA256.to_owned(),
            tokenizer_sha256: HARRIER_V1_TOKENIZER_SHA256.to_owned(),
            document_prompt_version: HARRIER_V1_DOCUMENT_PROMPT_VERSION.to_owned(),
            query_prompt_version: HARRIER_V1_QUERY_PROMPT_VERSION.to_owned(),
            pooling: "last-token".to_owned(),
            dimension: V1_EMBEDDING_DIMENSION,
            normalization: "l2".to_owned(),
            quantization: "float32".to_owned(),
        }
    }

    pub fn validate_v1(&self) -> Result<()> {
        validate_identifier("model id", &self.id, 128)?;
        validate_sha256("model weights", &self.weights_sha256)?;
        validate_sha256("model tokenizer", &self.tokenizer_sha256)?;
        validate_identifier(
            "document prompt version",
            &self.document_prompt_version,
            128,
        )?;
        validate_identifier("query prompt version", &self.query_prompt_version, 128)?;
        if self.id != HARRIER_V1_MODEL_ID
            || self.weights_sha256 != HARRIER_V1_SOURCE_WEIGHTS_SHA256
            || self.tokenizer_sha256 != HARRIER_V1_TOKENIZER_SHA256
            || self.document_prompt_version != HARRIER_V1_DOCUMENT_PROMPT_VERSION
            || self.query_prompt_version != HARRIER_V1_QUERY_PROMPT_VERSION
            || self.pooling != "last-token"
            || self.dimension != V1_EMBEDDING_DIMENSION
            || self.normalization != "l2"
            || self.quantization != "float32"
        {
            return Err(CommunitySearchError::InvalidCatalog(
                "the V1 model contract must use the pinned Harrier source, prompts, 640-dimensional float32 output, last-token pooling and L2 normalization"
                    .to_owned(),
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CatalogItemKind {
    Profile,
    Post,
    ServiceListing,
    ProductListing,
    News,
    Advertisement,
}

impl CatalogItemKind {
    pub fn is_listing(self) -> bool {
        matches!(self, Self::ServiceListing | Self::ProductListing)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct MediaReference {
    pub media_id: String,
    pub sha256: String,
    pub content_type: String,
    pub width: u32,
    pub height: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Sponsorship {
    pub campaign_id: String,
    pub advertiser_id: String,
    pub paid_by_id: String,
    pub starts_at_ms: u64,
    pub ends_at_ms: u64,
    pub sponsorship_label: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CatalogEmbeddingSource {
    Title,
    Summary,
    Bullet,
    Description,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CatalogEmbeddingChunk {
    pub source: CatalogEmbeddingSource,
    pub ordinal: u16,
    pub embedding: Vec<f32>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CatalogItem {
    pub public_id: String,
    pub revision: u64,
    pub owner_public_id: String,
    pub kind: CatalogItemKind,
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
    pub media: Vec<MediaReference>,
    pub published_at_ms: u64,
    pub expires_at_ms: Option<u64>,
    pub moderation_decision_id: String,
    pub sponsorship: Option<Sponsorship>,
    pub model: ModelContract,
    pub embedding: Vec<f32>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub embedding_chunks: Vec<CatalogEmbeddingChunk>,
}

impl CatalogItem {
    pub(crate) fn validate(&self, manifest_model: &ModelContract) -> Result<()> {
        validate_identifier("public item id", &self.public_id, 128)?;
        validate_identifier("public owner id", &self.owner_public_id, 128)?;
        validate_identifier("moderation decision id", &self.moderation_decision_id, 128)?;
        if self.revision == 0 {
            return invalid("catalog revisions start at 1");
        }
        validate_text("title", &self.title, 1, 120)?;
        validate_text("summary", &self.summary, 1, 2_000)?;
        validate_string_list("roles", &self.roles, 16, 64)?;
        validate_string_list("categories", &self.categories, 16, 64)?;
        validate_string_list("languages", &self.languages, 12, 16)?;
        if self.languages.is_empty() {
            return invalid("at least one public content language is required");
        }
        if let Some(region) = &self.coarse_region {
            validate_coarse_region(region)?;
        }
        match (self.coarse_region.as_ref(), self.radius_km) {
            (Some(_), Some(5 | 10 | 25)) | (None, None) => {}
            (Some(_), None) => return invalid("a coarse region requires a public radius"),
            (None, Some(_)) => return invalid("a public radius requires a coarse region"),
            (_, Some(_)) => return invalid("public radius must be 5, 10, or 25 km"),
        }
        if self.media.len() > 8 {
            return invalid("a catalog item may reference at most 8 public media objects");
        }
        for media in &self.media {
            media.validate()?;
        }
        if self.published_at_ms == 0 {
            return invalid("publishedAtMs is required");
        }
        if self.kind.is_listing() {
            let expires_at = self
                .expires_at_ms
                .ok_or_else(|| invalid_error("public listings must expire"))?;
            if expires_at <= self.published_at_ms
                || expires_at.saturating_sub(self.published_at_ms) > MAX_LISTING_LIFETIME_MS
            {
                return invalid("public listings may remain visible for at most 30 days");
            }
        } else if let Some(expires_at) = self.expires_at_ms {
            if expires_at <= self.published_at_ms {
                return invalid("content expiry must be after publication");
            }
        }
        if self.kind == CatalogItemKind::Advertisement {
            let sponsor = self
                .sponsorship
                .as_ref()
                .ok_or_else(|| invalid_error("advertising must expose its sponsor and payer"))?;
            sponsor.validate()?;
        } else if self.sponsorship.is_some() {
            return invalid("organic catalog items cannot contain sponsorship metadata");
        }
        if &self.model != manifest_model {
            return Err(CommunitySearchError::ModelMismatch);
        }
        validate_embedding(&self.embedding, self.model.dimension)?;
        if self.embedding_chunks.len() > MAX_EMBEDDING_CHUNKS_PER_ITEM {
            return invalid(format!(
                "a catalog item may contain at most {MAX_EMBEDDING_CHUNKS_PER_ITEM} additional embedding chunks"
            ));
        }
        let mut chunk_keys = HashSet::with_capacity(self.embedding_chunks.len());
        for chunk in &self.embedding_chunks {
            if !chunk_keys.insert((chunk.source, chunk.ordinal)) {
                return invalid("catalog embedding chunk source and ordinal must be unique");
            }
            validate_embedding(&chunk.embedding, self.model.dimension)?;
        }
        Ok(())
    }
}

impl MediaReference {
    fn validate(&self) -> Result<()> {
        validate_identifier("media id", &self.media_id, 128)?;
        validate_sha256("media", &self.sha256)?;
        if !matches!(
            self.content_type.as_str(),
            "image/avif" | "image/webp" | "image/jpeg" | "image/png"
        ) {
            return invalid("catalog media must use an approved image content type");
        }
        if self.width == 0 || self.height == 0 || self.width > 4096 || self.height > 4096 {
            return invalid("catalog media dimensions are invalid");
        }
        Ok(())
    }
}

impl Sponsorship {
    fn validate(&self) -> Result<()> {
        validate_identifier("campaign id", &self.campaign_id, 128)?;
        validate_identifier("advertiser id", &self.advertiser_id, 128)?;
        validate_identifier("payer id", &self.paid_by_id, 128)?;
        validate_text("sponsorship label", &self.sponsorship_label, 1, 80)?;
        if self.ends_at_ms <= self.starts_at_ms {
            return invalid("advertising end must be after its start");
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CatalogTombstone {
    pub public_id: String,
    pub revision: u64,
    pub deleted_at_ms: u64,
}

impl CatalogTombstone {
    pub(crate) fn validate(&self) -> Result<()> {
        validate_identifier("tombstone public id", &self.public_id, 128)?;
        if self.revision == 0 || self.deleted_at_ms == 0 {
            return invalid("tombstone revision and deletion time are required");
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CatalogSnapshot {
    pub schema_version: u16,
    pub catalog_scope_id: String,
    pub sequence: u64,
    pub model: ModelContract,
    pub items: Vec<CatalogItem>,
    #[serde(default)]
    pub tombstones: Vec<CatalogTombstone>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CatalogDelta {
    pub schema_version: u16,
    pub catalog_scope_id: String,
    pub from_sequence: u64,
    pub to_sequence: u64,
    pub model: ModelContract,
    #[serde(default)]
    pub upserts: Vec<CatalogItem>,
    #[serde(default)]
    pub tombstones: Vec<CatalogTombstone>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "payloadType", rename_all = "snake_case")]
pub enum CatalogPayload {
    Snapshot(CatalogSnapshot),
    Delta(CatalogDelta),
}

impl CatalogPayload {
    pub(crate) fn validate_shape(&self) -> Result<()> {
        let (schema_version, scope, model, items, tombstones) = match self {
            Self::Snapshot(value) => (
                value.schema_version,
                value.catalog_scope_id.as_str(),
                &value.model,
                value.items.as_slice(),
                value.tombstones.as_slice(),
            ),
            Self::Delta(value) => (
                value.schema_version,
                value.catalog_scope_id.as_str(),
                &value.model,
                value.upserts.as_slice(),
                value.tombstones.as_slice(),
            ),
        };
        if schema_version != crate::CATALOG_SCHEMA_VERSION {
            return invalid("unsupported catalog payload schema");
        }
        validate_identifier("catalog scope", scope, 128)?;
        model.validate_v1()?;
        if items.len().saturating_add(tombstones.len()) > MAX_CATALOG_ITEMS {
            return invalid("catalog payload exceeds the item limit");
        }
        for item in items {
            item.validate(model)?;
        }
        for tombstone in tombstones {
            tombstone.validate()?;
        }
        Ok(())
    }

    pub(crate) fn sequence(&self) -> u64 {
        match self {
            Self::Snapshot(value) => value.sequence,
            Self::Delta(value) => value.to_sequence,
        }
    }

    pub(crate) fn previous_sequence(&self) -> Option<u64> {
        match self {
            Self::Snapshot(_) => None,
            Self::Delta(value) => Some(value.from_sequence),
        }
    }

    pub(crate) fn scope(&self) -> &str {
        match self {
            Self::Snapshot(value) => &value.catalog_scope_id,
            Self::Delta(value) => &value.catalog_scope_id,
        }
    }

    pub(crate) fn model(&self) -> &ModelContract {
        match self {
            Self::Snapshot(value) => &value.model,
            Self::Delta(value) => &value.model,
        }
    }

    pub(crate) fn counts(&self) -> (usize, usize) {
        match self {
            Self::Snapshot(value) => (value.items.len(), value.tombstones.len()),
            Self::Delta(value) => (value.upserts.len(), value.tombstones.len()),
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct SearchFilters {
    pub kinds: Vec<CatalogItemKind>,
    pub coarse_region: Option<String>,
    pub include_advertising: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct LocalQueryEmbedding {
    pub model: ModelContract,
    pub embedding: Vec<f32>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub item: CatalogItem,
    pub semantic_distance: f32,
    pub personal_adjustment: f32,
    pub combined_score: f32,
}

pub(crate) fn validate_embedding(vector: &[f32], dimension: usize) -> Result<()> {
    if vector.len() != dimension {
        return invalid("embedding dimension does not match the signed model contract");
    }
    if vector.iter().any(|value| !value.is_finite()) {
        return invalid("embeddings must contain only finite numbers");
    }
    let norm = vector
        .iter()
        .map(|value| f64::from(*value).powi(2))
        .sum::<f64>()
        .sqrt();
    if !(0.995..=1.005).contains(&norm) {
        return invalid("embeddings must be L2-normalized");
    }
    Ok(())
}

pub(crate) fn validate_identifier(label: &str, value: &str, max: usize) -> Result<()> {
    if value.is_empty()
        || value.len() > max
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
    {
        return invalid(format!("{label} is invalid"));
    }
    Ok(())
}

pub(crate) fn validate_sha256(label: &str, value: &str) -> Result<()> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return invalid(format!(
            "{label} SHA-256 must be 64 lowercase hexadecimal characters"
        ));
    }
    Ok(())
}

pub(crate) fn validate_text(label: &str, value: &str, min: usize, max: usize) -> Result<()> {
    let trimmed = value.trim();
    let count = trimmed.chars().count();
    if trimmed != value || !(min..=max).contains(&count) || value.chars().any(char::is_control) {
        return invalid(format!(
            "{label} must contain {min} to {max} printable characters"
        ));
    }
    Ok(())
}

fn validate_string_list(
    label: &str,
    values: &[String],
    max_items: usize,
    max_chars: usize,
) -> Result<()> {
    if values.len() > max_items {
        return invalid(format!("{label} contains too many entries"));
    }
    for value in values {
        validate_text(label, value, 1, max_chars)?;
    }
    Ok(())
}

fn validate_coarse_region(value: &str) -> Result<()> {
    if value.len() != 5
        || !value
            .chars()
            .all(|character| GEOHASH_ALPHABET.contains(character))
    {
        return invalid("coarse region must be a 5-character geohash");
    }
    Ok(())
}

fn invalid<T>(message: impl Into<String>) -> Result<T> {
    Err(invalid_error(message))
}

fn invalid_error(message: impl Into<String>) -> CommunitySearchError {
    CommunitySearchError::InvalidCatalog(message.into())
}
