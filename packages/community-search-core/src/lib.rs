mod advertising;
mod artifact;
mod interest;
mod local_query;
mod manifest;
mod model;
mod query;
mod store;

pub use interest::{
    InterestDomain, InterestSignal, InterestState, PersonalizationUpdate, RepetitionFingerprint,
};
pub use local_query::{
    LocalQueryCache, LocalQueryCacheStatus, LocalQuerySuggestion,
    DEFAULT_LOCAL_QUERY_CACHE_CAPACITY, LOCAL_QUERY_LOW_USE_MAX_AGE_MS,
    MAX_LOCAL_QUERY_CACHE_CAPACITY,
};
pub use manifest::{
    catalog_signer_key_id, CatalogManifest, CatalogManifestUnsigned, SignedCatalogPackage,
};
pub use model::{
    CatalogDelta, CatalogEmbeddingChunk, CatalogEmbeddingSource, CatalogItem, CatalogItemKind,
    CatalogPayload, CatalogSnapshot, CatalogTombstone, LocalQueryEmbedding, MediaReference,
    ModelContract, SearchFilters, SearchResult, Sponsorship, HARRIER_V1_MODEL_ID,
    HARRIER_V1_SOURCE_REVISION, HARRIER_V1_SOURCE_WEIGHTS_SHA256, HARRIER_V1_TOKENIZER_SHA256,
    MAX_EMBEDDING_CHUNKS_PER_ITEM,
};
pub use query::{
    normalize_query_text_v1, CommonQueryCore, QueryCatalogDelta, QueryCatalogEntry,
    QueryCatalogPayload, QueryCatalogSnapshot, QueryCatalogTombstone, QuerySuggestion,
    SignedQueryCatalogPackage, QUERY_NORMALIZATION_VERSION,
};
pub use store::{CommunitySearchCore, InstalledGeneration};

use thiserror::Error;

pub const CATALOG_SCHEMA_VERSION: u16 = 1;
pub const V1_EMBEDDING_DIMENSION: usize = 640;
pub const MAX_CATALOG_BYTES: usize = 256 * 1024 * 1024;
pub const MAX_CATALOG_ITEMS: usize = 250_000;
pub const MAX_QUERY_CATALOG_ITEMS: usize = 100_000;
pub const MAX_LISTING_LIFETIME_MS: u64 = 30 * 24 * 60 * 60 * 1_000;

#[derive(Debug, Error)]
pub enum CommunitySearchError {
    #[error("catalog data is invalid: {0}")]
    InvalidCatalog(String),
    #[error("catalog signature is invalid")]
    InvalidSignature,
    #[error("catalog payload hash does not match the signed manifest")]
    PayloadHashMismatch,
    #[error("catalog scope does not match the active policy scope")]
    ScopeMismatch,
    #[error("catalog policy is not currently valid")]
    PolicyExpired,
    #[error("catalog sequence cannot be applied to the active generation")]
    SequenceMismatch,
    #[error("catalog model contract does not match the active generation")]
    ModelMismatch,
    #[error("no verified catalog generation is active")]
    NoActiveGeneration,
    #[error("catalog storage failed: {0}")]
    Storage(String),
    #[error("local vector index failed: {0}")]
    VectorIndex(String),
}

pub type Result<T> = std::result::Result<T, CommunitySearchError>;
pub use advertising::{
    AdvertisingCampaign, AdvertisingCampaignStatus, AdvertisingCatalog, AdvertisingCatalogCore,
    AdvertisingKind, AdvertisingLabel, AdvertisingPlacement, AdvertisingSelection,
    AdvertisingSelectionReason, SignedAdvertisingCatalog,
};
pub use artifact::{
    HarrierArtifactManifest, HarrierArtifactManifestUnsigned, HarrierArtifactTarget,
    SignedHarrierArtifactPackage, HARRIER_QUERY_INSTRUCTION_V2,
};
