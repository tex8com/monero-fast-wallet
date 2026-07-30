use chacha20poly1305::{
    aead::{Aead, KeyInit},
    XChaCha20Poly1305, XNonce,
};
use community_search_core::{
    CatalogEmbeddingChunk, CatalogEmbeddingSource, CatalogItem, CatalogItemKind, CatalogTombstone,
    MediaReference, ModelContract, MAX_EMBEDDING_CHUNKS_PER_ITEM, MAX_LISTING_LIFETIME_MS,
};
use rand::{rngs::OsRng, RngCore};
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};
use thiserror::Error;

const REMINDER_WINDOW_MS: u64 = 24 * 60 * 60 * 1_000;
const DELIVERY_LEASE_MS: u64 = 5 * 60 * 1_000;
const MAX_SCHEDULED_DELIVERIES_PER_RUN: usize = 100;
const MAX_PRIVATE_REASON_CHARS: usize = 2_000;

#[derive(Debug, Error)]
pub enum PublicationError {
    #[error("publication request is invalid: {0}")]
    Invalid(String),
    #[error("publication record was not found")]
    NotFound,
    #[error("publication action is not allowed in the current state")]
    InvalidState,
    #[error("publication actor is not authorized for this record")]
    Unauthorized,
    #[error("publication storage failed: {0}")]
    Storage(String),
    #[error("private moderation evidence could not be encrypted")]
    Encryption,
}

pub type Result<T> = std::result::Result<T, PublicationError>;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PublicContentKind {
    Profile,
    Post,
    ServiceListing,
    ProductListing,
}

impl PublicContentKind {
    fn catalog_kind(self) -> CatalogItemKind {
        match self {
            Self::Profile => CatalogItemKind::Profile,
            Self::Post => CatalogItemKind::Post,
            Self::ServiceListing => CatalogItemKind::ServiceListing,
            Self::ProductListing => CatalogItemKind::ProductListing,
        }
    }

    fn is_listing(self) -> bool {
        matches!(self, Self::ServiceListing | Self::ProductListing)
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct PublicContentDraft {
    pub kind: PublicContentKind,
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
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PublicationStatus {
    AwaitingScreening,
    HumanReview,
    NeedsChanges,
    Quarantined,
    ApprovedAwaitingEmbedding,
    Published,
    Hidden,
    Rejected,
    Removed,
    Expired,
    Withdrawn,
}

impl PublicationStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::AwaitingScreening => "awaiting_screening",
            Self::HumanReview => "human_review",
            Self::NeedsChanges => "needs_changes",
            Self::Quarantined => "quarantined",
            Self::ApprovedAwaitingEmbedding => "approved_awaiting_embedding",
            Self::Published => "published",
            Self::Hidden => "hidden",
            Self::Rejected => "rejected",
            Self::Removed => "removed",
            Self::Expired => "expired",
            Self::Withdrawn => "withdrawn",
        }
    }

    fn parse(value: &str) -> Result<Self> {
        match value {
            "awaiting_screening" => Ok(Self::AwaitingScreening),
            "human_review" => Ok(Self::HumanReview),
            "needs_changes" => Ok(Self::NeedsChanges),
            "quarantined" => Ok(Self::Quarantined),
            "approved_awaiting_embedding" => Ok(Self::ApprovedAwaitingEmbedding),
            "published" => Ok(Self::Published),
            "hidden" => Ok(Self::Hidden),
            "rejected" => Ok(Self::Rejected),
            "removed" => Ok(Self::Removed),
            "expired" => Ok(Self::Expired),
            "withdrawn" => Ok(Self::Withdrawn),
            _ => Err(PublicationError::Storage(
                "stored publication status is invalid".to_owned(),
            )),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct PublicationRecord {
    pub public_id: String,
    pub revision: u64,
    pub owner_public_id: String,
    pub draft: PublicContentDraft,
    pub status: PublicationStatus,
    pub created_at_ms: u64,
    pub published_at_ms: Option<u64>,
    pub expires_at_ms: Option<u64>,
    pub moderation_decision_id: Option<String>,
    pub wording_suggestion: Option<String>,
    pub reminder_sent_at_ms: Option<u64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ScreeningOutcome {
    Clear,
    WordingOnly,
    Ambiguous,
    DangerousOrProhibited,
}

#[derive(Clone, Debug)]
pub struct ScreeningAssessment {
    pub model_version: String,
    pub rules_version: String,
    pub confidence: f32,
    pub triggered_policy: String,
    pub outcome: ScreeningOutcome,
    pub optional_wording_suggestion: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ModeratorDecision {
    Approve,
    Reject,
    KeepVisible,
    Hide,
    Remove,
    Reinstate,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ScheduledAction {
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

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ModerationCase {
    pub case_id: String,
    pub public_id: String,
    pub revision: u64,
    pub source: String,
    pub status: String,
    pub created_at_ms: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ModerationQueueCase {
    pub case_id: String,
    pub public_id: String,
    pub revision: u64,
    pub source: String,
    pub status: String,
    pub created_at_ms: u64,
    pub acknowledged_at_ms: Option<u64>,
    pub acknowledged_by: Option<String>,
    pub illegal_content_notice: bool,
    pub reporter_public_id: Option<String>,
    pub private_evidence: Option<String>,
    pub appeal_reason: Option<String>,
    pub model_version: Option<String>,
    pub rules_version: Option<String>,
    pub confidence: Option<f32>,
    pub triggered_policy: Option<String>,
    pub content: PublicationRecord,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ModerationOutcome {
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

pub struct PublicationStore {
    connection: Mutex<Connection>,
    cipher: XChaCha20Poly1305,
    path: Option<PathBuf>,
}

impl PublicationStore {
    pub fn open(path: impl AsRef<Path>, encryption_key: [u8; 32]) -> Result<Self> {
        let path = path.as_ref().to_path_buf();
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(storage)?;
        }
        let connection = Connection::open(&path).map_err(storage)?;
        let store = Self {
            connection: Mutex::new(connection),
            cipher: XChaCha20Poly1305::new((&encryption_key).into()),
            path: Some(path),
        };
        store.initialize()?;
        Ok(store)
    }

    pub fn in_memory(encryption_key: [u8; 32]) -> Result<Self> {
        let connection = Connection::open_in_memory().map_err(storage)?;
        let store = Self {
            connection: Mutex::new(connection),
            cipher: XChaCha20Poly1305::new((&encryption_key).into()),
            path: None,
        };
        store.initialize()?;
        Ok(store)
    }

    pub fn submit(
        &self,
        owner_public_id: &str,
        draft: PublicContentDraft,
        now_ms: u64,
    ) -> Result<PublicationRecord> {
        validate_identifier("owner public id", owner_public_id)?;
        validate_draft(&draft)?;
        let public_id = random_id("content");
        self.insert_revision(&public_id, 1, owner_public_id, draft, now_ms)
    }

    pub fn resubmit(
        &self,
        owner_public_id: &str,
        public_id: &str,
        draft: PublicContentDraft,
        now_ms: u64,
    ) -> Result<PublicationRecord> {
        validate_draft(&draft)?;
        let latest = self.latest(public_id)?;
        if latest.owner_public_id != owner_public_id {
            return Err(PublicationError::Unauthorized);
        }
        if !matches!(
            latest.status,
            PublicationStatus::NeedsChanges
                | PublicationStatus::Rejected
                | PublicationStatus::Expired
                | PublicationStatus::Withdrawn
        ) {
            return Err(PublicationError::InvalidState);
        }
        if latest.draft.kind != draft.kind {
            return Err(PublicationError::Invalid(
                "content kind cannot change between revisions".to_owned(),
            ));
        }
        self.insert_revision(
            public_id,
            latest.revision.saturating_add(1),
            owner_public_id,
            draft,
            now_ms,
        )
    }

    pub fn record_screening(
        &self,
        public_id: &str,
        revision: u64,
        assessment: &ScreeningAssessment,
        now_ms: u64,
    ) -> Result<ModerationCase> {
        validate_assessment(assessment)?;
        let mut connection = self.connection.lock().map_err(lock_error)?;
        let transaction = connection.transaction().map_err(storage)?;
        let record = load_revision(&transaction, &self.cipher, public_id, revision)?;
        if record.status != PublicationStatus::AwaitingScreening {
            return Err(PublicationError::InvalidState);
        }
        let suggestion = match assessment.outcome {
            ScreeningOutcome::WordingOnly => assessment
                .optional_wording_suggestion
                .as_ref()
                .map(|value| validate_private_text("wording suggestion", value))
                .transpose()?,
            _ if assessment.optional_wording_suggestion.is_some() => {
                return Err(PublicationError::Invalid(
                    "wording suggestions are allowed only for wording-only findings".to_owned(),
                ));
            }
            _ => None,
        };
        let suggestion_cipher = suggestion
            .as_ref()
            .map(|value| self.encrypt_private(value.clone()))
            .transpose()?;
        let status = match assessment.outcome {
            ScreeningOutcome::WordingOnly => PublicationStatus::NeedsChanges,
            ScreeningOutcome::DangerousOrProhibited => PublicationStatus::Quarantined,
            ScreeningOutcome::Clear | ScreeningOutcome::Ambiguous => PublicationStatus::HumanReview,
        };
        transaction
            .execute(
                "UPDATE content_revision SET status = ?1, wording_suggestion_cipher = ?2
                 WHERE public_id = ?3 AND revision = ?4",
                params![
                    status.as_str(),
                    suggestion_cipher,
                    public_id,
                    to_sql_i64(revision)?
                ],
            )
            .map_err(storage)?;
        let case_id = random_id("case");
        let case_status = if assessment.outcome == ScreeningOutcome::WordingOnly {
            "author_action_required"
        } else {
            "open"
        };
        transaction
            .execute(
                "INSERT INTO moderation_case(
                    case_id, public_id, revision, source, status, created_at_ms,
                    model_version, rules_version, confidence, triggered_policy
                 ) VALUES (?1, ?2, ?3, 'screening', ?4, ?5, ?6, ?7, ?8, ?9)",
                params![
                    case_id,
                    public_id,
                    to_sql_i64(revision)?,
                    case_status,
                    to_sql_i64(now_ms)?,
                    assessment.model_version,
                    assessment.rules_version,
                    assessment.confidence,
                    assessment.triggered_policy
                ],
            )
            .map_err(storage)?;
        append_audit(
            &transaction,
            "screening_recorded",
            public_id,
            "policy-engine",
            now_ms,
            &format!("case={case_id};status={}", status.as_str()),
        )?;
        transaction.commit().map_err(storage)?;
        Ok(ModerationCase {
            case_id,
            public_id: public_id.to_owned(),
            revision,
            source: "screening".to_owned(),
            status: case_status.to_owned(),
            created_at_ms: now_ms,
        })
    }

    pub fn moderate(
        &self,
        case_id: &str,
        moderator_id: &str,
        decision: ModeratorDecision,
        reason: &str,
        now_ms: u64,
    ) -> Result<PublicationRecord> {
        validate_identifier("moderator id", moderator_id)?;
        let encrypted_reason =
            self.encrypt_private(validate_private_text("decision reason", reason)?)?;
        let mut connection = self.connection.lock().map_err(lock_error)?;
        let transaction = connection.transaction().map_err(storage)?;
        let case = load_case(&transaction, case_id)?;
        if case.status != "open" && case.status != "appealed" {
            return Err(PublicationError::InvalidState);
        }
        let mut record = load_revision(&transaction, &self.cipher, &case.public_id, case.revision)?;
        let next_status = next_status_for_decision(record.status, decision)?;
        let creates_reinstatement_revision = decision == ModeratorDecision::Reinstate
            && matches!(
                record.status,
                PublicationStatus::Rejected
                    | PublicationStatus::Hidden
                    | PublicationStatus::Removed
            );
        let decision_id = random_id("decision");
        transaction
            .execute(
                "UPDATE moderation_case SET status = 'resolved', resolved_at_ms = ?1,
                    decision = ?2, decision_reason_cipher = ?3, moderator_id = ?4
                 WHERE case_id = ?5",
                params![
                    to_sql_i64(now_ms)?,
                    decision_name(decision),
                    encrypted_reason,
                    moderator_id,
                    case_id
                ],
            )
            .map_err(storage)?;
        if creates_reinstatement_revision {
            let latest_revision_raw: i64 = transaction
                .query_row(
                    "SELECT MAX(revision) FROM content_revision WHERE public_id = ?1",
                    [&record.public_id],
                    |row| row.get(0),
                )
                .map_err(storage)?;
            let new_revision = from_sql_i64(latest_revision_raw)?.saturating_add(1);
            let draft_cipher =
                self.encrypt_private(serde_json::to_string(&record.draft).map_err(json_error)?)?;
            transaction
                .execute(
                    "INSERT INTO content_revision(
                        public_id, revision, owner_public_id, draft_cipher, status, created_at_ms,
                        moderation_decision_id
                     ) VALUES (?1, ?2, ?3, ?4, 'approved_awaiting_embedding', ?5, ?6)",
                    params![
                        record.public_id,
                        to_sql_i64(new_revision)?,
                        record.owner_public_id,
                        draft_cipher,
                        to_sql_i64(now_ms)?,
                        decision_id
                    ],
                )
                .map_err(storage)?;
            record.revision = new_revision;
            record.created_at_ms = now_ms;
            record.published_at_ms = None;
            record.expires_at_ms = None;
            record.wording_suggestion = None;
            record.reminder_sent_at_ms = None;
        } else {
            transaction
                .execute(
                    "UPDATE content_revision SET status = ?1, moderation_decision_id = ?2
                     WHERE public_id = ?3 AND revision = ?4",
                    params![
                        next_status.as_str(),
                        decision_id,
                        record.public_id,
                        to_sql_i64(record.revision)?
                    ],
                )
                .map_err(storage)?;
            if matches!(
                next_status,
                PublicationStatus::Hidden | PublicationStatus::Removed
            ) {
                write_tombstone(&transaction, &record.public_id, record.revision, now_ms)?;
            }
        }
        append_audit(
            &transaction,
            "moderation_decided",
            &record.public_id,
            moderator_id,
            now_ms,
            &format!("case={case_id};decision={}", decision_name(decision)),
        )?;
        enqueue_scheduled_delivery(
            &transaction,
            "moderation_outcome_notice",
            &format!("moderation_outcome_author:{case_id}:{decision_id}"),
            Some(&record.public_id),
            Some(record.revision),
            Some(&record.owner_public_id),
            Some(case_id),
            now_ms,
        )?;
        let reporter_public_id = transaction
            .query_row(
                "SELECT reporter_public_id FROM moderation_case WHERE case_id = ?1",
                [case_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .map_err(storage)?;
        if reporter_public_id
            .as_deref()
            .is_some_and(|reporter| reporter != record.owner_public_id)
        {
            enqueue_scheduled_delivery(
                &transaction,
                "moderation_outcome_notice",
                &format!("moderation_outcome_reporter:{case_id}:{decision_id}"),
                Some(&record.public_id),
                Some(record.revision),
                reporter_public_id.as_deref(),
                Some(case_id),
                now_ms,
            )?;
        }
        transaction.commit().map_err(storage)?;
        record.status = next_status;
        record.moderation_decision_id = Some(decision_id);
        Ok(record)
    }

    pub fn publish_with_embedding(
        &self,
        public_id: &str,
        revision: u64,
        model: &ModelContract,
        embedding: &[f32],
        now_ms: u64,
    ) -> Result<PublicationRecord> {
        self.publish_with_embedding_chunks(public_id, revision, model, embedding, &[], now_ms)
    }

    pub fn publish_with_embedding_chunks(
        &self,
        public_id: &str,
        revision: u64,
        model: &ModelContract,
        embedding: &[f32],
        embedding_chunks: &[CatalogEmbeddingChunk],
        now_ms: u64,
    ) -> Result<PublicationRecord> {
        validate_embedding(model, embedding)?;
        validate_embedding_chunks(model, embedding_chunks)?;
        let mut connection = self.connection.lock().map_err(lock_error)?;
        let transaction = connection.transaction().map_err(storage)?;
        let mut record = load_revision(&transaction, &self.cipher, public_id, revision)?;
        if record.status != PublicationStatus::ApprovedAwaitingEmbedding {
            return Err(PublicationError::InvalidState);
        }
        let expires_at_ms = record
            .draft
            .kind
            .is_listing()
            .then_some(now_ms.saturating_add(MAX_LISTING_LIFETIME_MS));
        transaction
            .execute(
                "UPDATE content_revision SET status = 'published', published_at_ms = ?1,
                    expires_at_ms = ?2, model_json = ?3, embedding = ?4
                 WHERE public_id = ?5 AND revision = ?6",
                params![
                    to_sql_i64(now_ms)?,
                    expires_at_ms.map(to_sql_i64).transpose()?,
                    serde_json::to_string(model).map_err(json_error)?,
                    encode_embedding(embedding),
                    public_id,
                    to_sql_i64(revision)?
                ],
            )
            .map_err(storage)?;
        transaction
            .execute(
                "DELETE FROM content_embedding_chunk
                 WHERE public_id = ?1 AND revision = ?2",
                params![public_id, to_sql_i64(revision)?],
            )
            .map_err(storage)?;
        for chunk in embedding_chunks {
            transaction
                .execute(
                    "INSERT INTO content_embedding_chunk(
                        public_id, revision, source, ordinal, embedding
                     ) VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![
                        public_id,
                        to_sql_i64(revision)?,
                        embedding_source_name(chunk.source),
                        i64::from(chunk.ordinal),
                        encode_embedding(&chunk.embedding)
                    ],
                )
                .map_err(storage)?;
        }
        transaction
            .execute(
                "DELETE FROM catalog_tombstone WHERE public_id = ?1 AND revision < ?2",
                params![public_id, to_sql_i64(revision)?],
            )
            .map_err(storage)?;
        append_audit(
            &transaction,
            "content_published",
            public_id,
            "catalog-publisher",
            now_ms,
            &format!("revision={revision}"),
        )?;
        transaction.commit().map_err(storage)?;
        record.status = PublicationStatus::Published;
        record.published_at_ms = Some(now_ms);
        record.expires_at_ms = expires_at_ms;
        Ok(record)
    }

    pub fn report(
        &self,
        reporter_public_id: &str,
        public_id: &str,
        revision: u64,
        reason: &str,
        illegal_content_notice: bool,
        now_ms: u64,
    ) -> Result<ModerationCase> {
        validate_identifier("reporter public id", reporter_public_id)?;
        let reason_cipher =
            self.encrypt_private(validate_private_text("report reason", reason)?)?;
        let mut connection = self.connection.lock().map_err(lock_error)?;
        let transaction = connection.transaction().map_err(storage)?;
        let record = load_revision(&transaction, &self.cipher, public_id, revision)?;
        if !matches!(
            record.status,
            PublicationStatus::Published | PublicationStatus::Hidden
        ) {
            return Err(PublicationError::InvalidState);
        }
        let case_id = random_id("case");
        transaction
            .execute(
                "INSERT INTO moderation_case(
                    case_id, public_id, revision, source, status, created_at_ms,
                    reporter_public_id, private_evidence_cipher, illegal_content_notice
                 ) VALUES (?1, ?2, ?3, 'report', 'open', ?4, ?5, ?6, ?7)",
                params![
                    case_id,
                    public_id,
                    to_sql_i64(revision)?,
                    to_sql_i64(now_ms)?,
                    reporter_public_id,
                    reason_cipher,
                    i64::from(illegal_content_notice)
                ],
            )
            .map_err(storage)?;
        append_audit(
            &transaction,
            "content_reported",
            public_id,
            reporter_public_id,
            now_ms,
            &format!("case={case_id};illegal_notice={illegal_content_notice}"),
        )?;
        transaction.commit().map_err(storage)?;
        Ok(ModerationCase {
            case_id,
            public_id: public_id.to_owned(),
            revision,
            source: "report".to_owned(),
            status: "open".to_owned(),
            created_at_ms: now_ms,
        })
    }

    pub fn appeal(
        &self,
        owner_public_id: &str,
        case_id: &str,
        reason: &str,
        now_ms: u64,
    ) -> Result<()> {
        let reason_cipher =
            self.encrypt_private(validate_private_text("appeal reason", reason)?)?;
        let mut connection = self.connection.lock().map_err(lock_error)?;
        let transaction = connection.transaction().map_err(storage)?;
        let case = load_case(&transaction, case_id)?;
        let record = load_revision(&transaction, &self.cipher, &case.public_id, case.revision)?;
        if record.owner_public_id != owner_public_id {
            return Err(PublicationError::Unauthorized);
        }
        if case.status != "resolved"
            || !matches!(
                record.status,
                PublicationStatus::Rejected
                    | PublicationStatus::Hidden
                    | PublicationStatus::Removed
            )
        {
            return Err(PublicationError::InvalidState);
        }
        transaction
            .execute(
                "UPDATE moderation_case SET status = 'appealed', appeal_reason_cipher = ?1,
                    appealed_at_ms = ?2 WHERE case_id = ?3",
                params![reason_cipher, to_sql_i64(now_ms)?, case_id],
            )
            .map_err(storage)?;
        append_audit(
            &transaction,
            "moderation_appealed",
            &record.public_id,
            owner_public_id,
            now_ms,
            &format!("case={case_id}"),
        )?;
        transaction.commit().map_err(storage)?;
        Ok(())
    }

    pub fn withdraw(
        &self,
        owner_public_id: &str,
        public_id: &str,
        revision: u64,
        now_ms: u64,
    ) -> Result<()> {
        let mut connection = self.connection.lock().map_err(lock_error)?;
        let transaction = connection.transaction().map_err(storage)?;
        let record = load_revision(&transaction, &self.cipher, public_id, revision)?;
        if record.owner_public_id != owner_public_id {
            return Err(PublicationError::Unauthorized);
        }
        if matches!(
            record.status,
            PublicationStatus::Removed | PublicationStatus::Expired | PublicationStatus::Withdrawn
        ) {
            return Err(PublicationError::InvalidState);
        }
        transaction
            .execute(
                "UPDATE content_revision SET status = 'withdrawn',
                    model_json = NULL, embedding = NULL
                 WHERE public_id = ?1 AND revision = ?2",
                params![public_id, to_sql_i64(revision)?],
            )
            .map_err(storage)?;
        transaction
            .execute(
                "DELETE FROM content_embedding_chunk
                 WHERE public_id = ?1 AND revision = ?2",
                params![public_id, to_sql_i64(revision)?],
            )
            .map_err(storage)?;
        if record.status == PublicationStatus::Published {
            write_tombstone(&transaction, public_id, revision, now_ms)?;
        }
        append_audit(
            &transaction,
            "content_withdrawn",
            public_id,
            owner_public_id,
            now_ms,
            &format!("revision={revision}"),
        )?;
        transaction.commit().map_err(storage)
    }

    /// Removes an owner's public footprint. Revisions involved in a currently
    /// open report/appeal remain encrypted under a moderation hold; every
    /// other draft and vector is cryptographically replaced with a neutral
    /// redacted record.
    pub fn delete_owner(&self, owner_public_id: &str, now_ms: u64) -> Result<usize> {
        validate_identifier("owner public id", owner_public_id)?;
        let redacted = PublicContentDraft {
            kind: PublicContentKind::Profile,
            title: "Deleted profile".to_owned(),
            summary: "This public entry was deleted by its owner.".to_owned(),
            roles: Vec::new(),
            categories: Vec::new(),
            languages: vec!["en".to_owned()],
            coarse_region: None,
            radius_km: None,
            media: Vec::new(),
        };
        let redacted_json = serde_json::to_string(&redacted).map_err(json_error)?;
        let redacted_cipher = self.encrypt_private(redacted_json)?;
        let mut connection = self.connection.lock().map_err(lock_error)?;
        let transaction = connection.transaction().map_err(storage)?;
        let rows = {
            let mut statement = transaction
                .prepare(
                    "SELECT public_id, revision, status FROM content_revision
                     WHERE owner_public_id = ?1 ORDER BY public_id, revision",
                )
                .map_err(storage)?;
            let rows = statement
                .query_map([owner_public_id], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                })
                .map_err(storage)?
                .collect::<std::result::Result<Vec<_>, _>>()
                .map_err(storage)?;
            rows
        };
        for (public_id, revision_raw, status) in &rows {
            let revision = from_sql_i64(*revision_raw)?;
            if matches!(status.as_str(), "published" | "hidden") {
                write_tombstone(&transaction, public_id, revision, now_ms)?;
            }
            let active_hold: bool = transaction
                .query_row(
                    "SELECT 1 FROM moderation_case
                     WHERE public_id = ?1 AND revision = ?2
                       AND status IN ('open', 'appealed')
                     LIMIT 1",
                    params![public_id, revision_raw],
                    |_| Ok(()),
                )
                .optional()
                .map_err(storage)?
                .is_some();
            if active_hold {
                transaction
                    .execute(
                        "UPDATE content_revision
                         SET status = 'withdrawn', embedding = NULL, model_json = NULL,
                             wording_suggestion_cipher = NULL
                         WHERE public_id = ?1 AND revision = ?2",
                        params![public_id, revision_raw],
                    )
                    .map_err(storage)?;
            } else {
                transaction
                    .execute(
                        "UPDATE content_revision
                         SET status = 'withdrawn', draft_cipher = ?1, embedding = NULL,
                             model_json = NULL, wording_suggestion_cipher = NULL
                         WHERE public_id = ?2 AND revision = ?3",
                        params![redacted_cipher, public_id, revision_raw],
                    )
                    .map_err(storage)?;
            }
            transaction
                .execute(
                    "DELETE FROM content_embedding_chunk
                     WHERE public_id = ?1 AND revision = ?2",
                    params![public_id, revision_raw],
                )
                .map_err(storage)?;
            transaction
                .execute(
                    "UPDATE scheduled_delivery
                     SET delivered_at_ms = COALESCE(delivered_at_ms, ?1),
                         lease_until_ms = NULL
                     WHERE public_id = ?2 AND revision = ?3",
                    params![to_sql_i64(now_ms)?, public_id, revision_raw],
                )
                .map_err(storage)?;
        }
        let redacted_owner = random_id("deleted");
        transaction
            .execute(
                "UPDATE content_revision SET owner_public_id = ?1
                 WHERE owner_public_id = ?2",
                params![redacted_owner, owner_public_id],
            )
            .map_err(storage)?;
        transaction
            .execute(
                "UPDATE moderation_audit
                 SET actor_id = ?1 WHERE actor_id = ?2",
                params![redacted_owner, owner_public_id],
            )
            .map_err(storage)?;
        append_audit(
            &transaction,
            "publication_owner_deleted",
            &redacted_owner,
            &redacted_owner,
            now_ms,
            &format!("revisions={}", rows.len()),
        )?;
        transaction.commit().map_err(storage)?;
        Ok(rows.len())
    }

    pub fn run_scheduled(&self, now_ms: u64) -> Result<Vec<ScheduledAction>> {
        let mut connection = self.connection.lock().map_err(lock_error)?;
        let transaction = connection.transaction().map_err(storage)?;
        let mut statement = transaction
            .prepare(
                "SELECT public_id, revision, owner_public_id, expires_at_ms, reminder_sent_at_ms
                 FROM content_revision
                 WHERE status = 'published' AND expires_at_ms IS NOT NULL
                 ORDER BY expires_at_ms, public_id, revision",
            )
            .map_err(storage)?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, Option<i64>>(4)?,
                ))
            })
            .map_err(storage)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(storage)?;
        drop(statement);
        let mut actions = Vec::new();
        for (public_id, revision_raw, owner_public_id, expires_raw, reminder_raw) in rows {
            let revision = from_sql_i64(revision_raw)?;
            let expires_at = from_sql_i64(expires_raw)?;
            if now_ms >= expires_at {
                transaction
                    .execute(
                        "UPDATE content_revision SET status = 'expired'
                         WHERE public_id = ?1 AND revision = ?2 AND status = 'published'",
                        params![public_id, revision_raw],
                    )
                    .map_err(storage)?;
                transaction
                    .execute(
                        "UPDATE scheduled_delivery
                         SET delivered_at_ms = COALESCE(delivered_at_ms, ?1),
                             lease_until_ms = NULL
                         WHERE idempotency_key = ?2",
                        params![
                            to_sql_i64(now_ms)?,
                            format!("listing_expiry_reminder:{public_id}:{revision}")
                        ],
                    )
                    .map_err(storage)?;
                write_tombstone(&transaction, &public_id, revision, now_ms)?;
                append_audit(
                    &transaction,
                    "listing_expired",
                    &public_id,
                    "expiry-worker",
                    now_ms,
                    &format!("revision={revision}"),
                )?;
                actions.push(ScheduledAction::ListingExpired {
                    public_id,
                    revision,
                });
            } else if reminder_raw.is_none()
                && expires_at.saturating_sub(now_ms) <= REMINDER_WINDOW_MS
            {
                transaction
                    .execute(
                        "UPDATE content_revision SET reminder_sent_at_ms = ?1
                         WHERE public_id = ?2 AND revision = ?3 AND reminder_sent_at_ms IS NULL",
                        params![to_sql_i64(now_ms)?, public_id, revision_raw],
                    )
                    .map_err(storage)?;
                enqueue_scheduled_delivery(
                    &transaction,
                    "listing_expiry_reminder",
                    &format!("listing_expiry_reminder:{public_id}:{revision}"),
                    Some(&public_id),
                    Some(revision),
                    Some(&owner_public_id),
                    None,
                    now_ms,
                )?;
            }
        }
        let mut moderation_statement = transaction
            .prepare(
                "SELECT case_id, created_at_ms, alert_sent_at_ms,
                        acknowledged_at_ms, escalated_at_ms
                 FROM moderation_case
                 WHERE status IN ('open', 'appealed')
                 ORDER BY created_at_ms, case_id",
            )
            .map_err(storage)?;
        let moderation_rows = moderation_statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, Option<i64>>(2)?,
                    row.get::<_, Option<i64>>(3)?,
                    row.get::<_, Option<i64>>(4)?,
                ))
            })
            .map_err(storage)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(storage)?;
        drop(moderation_statement);
        const MODERATION_ESCALATION_MS: u64 = 4 * 60 * 60 * 1_000;
        for (case_id, created_raw, alert_raw, acknowledged_raw, escalated_raw) in moderation_rows {
            let created_at_ms = from_sql_i64(created_raw)?;
            if alert_raw.is_none() {
                transaction
                    .execute(
                        "UPDATE moderation_case SET alert_sent_at_ms = ?1
                         WHERE case_id = ?2 AND alert_sent_at_ms IS NULL",
                        params![to_sql_i64(now_ms)?, case_id],
                    )
                    .map_err(storage)?;
                enqueue_scheduled_delivery(
                    &transaction,
                    "moderation_queue_alert",
                    &format!("moderation_queue_alert:{case_id}"),
                    None,
                    None,
                    None,
                    Some(&case_id),
                    now_ms,
                )?;
            } else if acknowledged_raw.is_none()
                && escalated_raw.is_none()
                && now_ms >= created_at_ms.saturating_add(MODERATION_ESCALATION_MS)
            {
                transaction
                    .execute(
                        "UPDATE moderation_case SET escalated_at_ms = ?1
                         WHERE case_id = ?2 AND acknowledged_at_ms IS NULL
                           AND escalated_at_ms IS NULL",
                        params![to_sql_i64(now_ms)?, case_id],
                    )
                    .map_err(storage)?;
                enqueue_scheduled_delivery(
                    &transaction,
                    "moderation_overdue",
                    &format!("moderation_overdue:{case_id}"),
                    None,
                    None,
                    None,
                    Some(&case_id),
                    now_ms,
                )?;
            }
        }
        actions.extend(claim_scheduled_deliveries(&transaction, now_ms)?);
        transaction.commit().map_err(storage)?;
        Ok(actions)
    }

    /// Confirms that a generic scheduled notification was accepted by its
    /// external provider. Until this ACK is durably recorded, a crashed
    /// operations process can reclaim the delivery after the bounded lease.
    pub fn acknowledge_scheduled_delivery(
        &self,
        delivery_id: &str,
        actor_id: &str,
        now_ms: u64,
    ) -> Result<()> {
        validate_identifier("scheduled delivery id", delivery_id)?;
        validate_identifier("delivery actor id", actor_id)?;
        let mut connection = self.connection.lock().map_err(lock_error)?;
        let transaction = connection.transaction().map_err(storage)?;
        let changed = transaction
            .execute(
                "UPDATE scheduled_delivery
                 SET delivered_at_ms = COALESCE(delivered_at_ms, ?1),
                     lease_until_ms = NULL
                 WHERE delivery_id = ?2",
                params![to_sql_i64(now_ms)?, delivery_id],
            )
            .map_err(storage)?;
        if changed == 0 {
            return Err(PublicationError::NotFound);
        }
        append_audit(
            &transaction,
            "scheduled_delivery_acknowledged",
            delivery_id,
            actor_id,
            now_ms,
            "",
        )?;
        transaction.commit().map_err(storage)
    }

    pub fn moderation_queue(&self, limit: usize) -> Result<Vec<ModerationQueueCase>> {
        if limit == 0 || limit > 100 {
            return Err(PublicationError::Invalid(
                "moderation queue limit must be between 1 and 100".to_owned(),
            ));
        }
        let connection = self.connection.lock().map_err(lock_error)?;
        let mut statement = connection
            .prepare(
                "SELECT case_id, public_id, revision, source, status, created_at_ms,
                        acknowledged_at_ms, acknowledged_by, illegal_content_notice,
                        reporter_public_id, private_evidence_cipher, appeal_reason_cipher,
                        model_version, rules_version, confidence, triggered_policy
                 FROM moderation_case
                 WHERE status IN ('open', 'appealed')
                 ORDER BY (status = 'appealed') DESC,
                          COALESCE(illegal_content_notice, 0) DESC,
                          created_at_ms, case_id
                 LIMIT ?1",
            )
            .map_err(storage)?;
        let limit = i64::try_from(limit)
            .map_err(|_| PublicationError::Invalid("queue limit is invalid".to_owned()))?;
        let rows = statement
            .query_map([limit], |row| {
                Ok(ModerationQueueRow {
                    case_id: row.get(0)?,
                    public_id: row.get(1)?,
                    revision: row.get(2)?,
                    source: row.get(3)?,
                    status: row.get(4)?,
                    created_at_ms: row.get(5)?,
                    acknowledged_at_ms: row.get(6)?,
                    acknowledged_by: row.get(7)?,
                    illegal_content_notice: row.get(8)?,
                    reporter_public_id: row.get(9)?,
                    private_evidence_cipher: row.get(10)?,
                    appeal_reason_cipher: row.get(11)?,
                    model_version: row.get(12)?,
                    rules_version: row.get(13)?,
                    confidence: row.get(14)?,
                    triggered_policy: row.get(15)?,
                })
            })
            .map_err(storage)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(storage)?;
        drop(statement);
        rows.into_iter()
            .map(|row| {
                let revision = from_sql_i64(row.revision)?;
                Ok(ModerationQueueCase {
                    case_id: row.case_id,
                    public_id: row.public_id.clone(),
                    revision,
                    source: row.source,
                    status: row.status,
                    created_at_ms: from_sql_i64(row.created_at_ms)?,
                    acknowledged_at_ms: row.acknowledged_at_ms.map(from_sql_i64).transpose()?,
                    acknowledged_by: row.acknowledged_by,
                    illegal_content_notice: row.illegal_content_notice.unwrap_or(0) == 1,
                    reporter_public_id: row.reporter_public_id,
                    private_evidence: row
                        .private_evidence_cipher
                        .map(|value| decrypt_private(&self.cipher, &value))
                        .transpose()?,
                    appeal_reason: row
                        .appeal_reason_cipher
                        .map(|value| decrypt_private(&self.cipher, &value))
                        .transpose()?,
                    model_version: row.model_version,
                    rules_version: row.rules_version,
                    confidence: row.confidence,
                    triggered_policy: row.triggered_policy,
                    content: load_revision(&connection, &self.cipher, &row.public_id, revision)?,
                })
            })
            .collect()
    }

    pub fn moderation_outcomes_for_actor(
        &self,
        actor_public_id: &str,
        limit: usize,
    ) -> Result<Vec<ModerationOutcome>> {
        validate_identifier("moderation actor", actor_public_id)?;
        if limit == 0 || limit > 100 {
            return Err(PublicationError::Invalid(
                "moderation outcome limit must be between 1 and 100".to_owned(),
            ));
        }
        let connection = self.connection.lock().map_err(lock_error)?;
        let mut statement = connection
            .prepare(
                "SELECT m.case_id, m.public_id, m.revision, m.source, m.status,
                        m.decision, m.decision_reason_cipher, m.resolved_at_ms,
                        c.owner_public_id
                 FROM moderation_case m
                 JOIN content_revision c
                   ON c.public_id = m.public_id AND c.revision = m.revision
                 WHERE c.owner_public_id = ?1 OR m.reporter_public_id = ?1
                 ORDER BY m.created_at_ms DESC, m.case_id
                 LIMIT ?2",
            )
            .map_err(storage)?;
        let rows = statement
            .query_map(
                params![
                    actor_public_id,
                    i64::try_from(limit).map_err(|_| PublicationError::InvalidState)?
                ],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, Option<String>>(5)?,
                        row.get::<_, Option<Vec<u8>>>(6)?,
                        row.get::<_, Option<i64>>(7)?,
                        row.get::<_, String>(8)?,
                    ))
                },
            )
            .map_err(storage)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(storage)?;
        drop(statement);
        rows.into_iter()
            .map(
                |(
                    case_id,
                    public_id,
                    revision,
                    source,
                    status,
                    decision,
                    reason_cipher,
                    resolved_at_ms,
                    owner_public_id,
                )| {
                    Ok(ModerationOutcome {
                        case_id,
                        public_id,
                        revision: from_sql_i64(revision)?,
                        source,
                        appeal_pending: status == "appealed",
                        status,
                        decision,
                        decision_reason: reason_cipher
                            .map(|cipher| decrypt_private(&self.cipher, &cipher))
                            .transpose()?,
                        resolved_at_ms: resolved_at_ms.map(from_sql_i64).transpose()?,
                        affected_author: owner_public_id == actor_public_id,
                    })
                },
            )
            .collect()
    }

    pub fn acknowledge_moderation_case(
        &self,
        case_id: &str,
        moderator_id: &str,
        now_ms: u64,
    ) -> Result<()> {
        validate_identifier("moderation case id", case_id)?;
        validate_identifier("moderator id", moderator_id)?;
        let mut connection = self.connection.lock().map_err(lock_error)?;
        let transaction = connection.transaction().map_err(storage)?;
        let changed = transaction
            .execute(
                "UPDATE moderation_case
                 SET acknowledged_at_ms = COALESCE(acknowledged_at_ms, ?1),
                     acknowledged_by = COALESCE(acknowledged_by, ?2)
                 WHERE case_id = ?3 AND status IN ('open', 'appealed')",
                params![to_sql_i64(now_ms)?, moderator_id, case_id],
            )
            .map_err(storage)?;
        if changed == 0 {
            return Err(PublicationError::NotFound);
        }
        transaction
            .execute(
                "UPDATE scheduled_delivery
                 SET delivered_at_ms = COALESCE(delivered_at_ms, ?1),
                     lease_until_ms = NULL
                 WHERE case_id = ?2 AND kind IN (
                     'moderation_queue_alert', 'moderation_overdue'
                 )",
                params![to_sql_i64(now_ms)?, case_id],
            )
            .map_err(storage)?;
        append_audit(
            &transaction,
            "moderation_acknowledged",
            case_id,
            moderator_id,
            now_ms,
            "",
        )?;
        transaction.commit().map_err(storage)
    }

    pub fn latest(&self, public_id: &str) -> Result<PublicationRecord> {
        let connection = self.connection.lock().map_err(lock_error)?;
        let revision: i64 = connection
            .query_row(
                "SELECT MAX(revision) FROM content_revision WHERE public_id = ?1",
                [public_id],
                |row| row.get(0),
            )
            .map_err(|error| match error {
                rusqlite::Error::QueryReturnedNoRows => PublicationError::NotFound,
                _ => storage(error),
            })?;
        load_revision(
            &connection,
            &self.cipher,
            public_id,
            from_sql_i64(revision)?,
        )
    }

    pub fn records_for_owner(
        &self,
        owner_public_id: &str,
        limit: usize,
    ) -> Result<Vec<PublicationRecord>> {
        validate_identifier("owner public id", owner_public_id)?;
        if limit == 0 || limit > 100 {
            return Err(PublicationError::Invalid(
                "owner record limit must be between 1 and 100".to_owned(),
            ));
        }
        let connection = self.connection.lock().map_err(lock_error)?;
        let mut statement = connection
            .prepare(
                "SELECT public_id, MAX(revision)
                 FROM content_revision
                 WHERE owner_public_id = ?1
                 GROUP BY public_id
                 ORDER BY MAX(created_at_ms) DESC, public_id
                 LIMIT ?2",
            )
            .map_err(storage)?;
        let rows = statement
            .query_map(
                params![
                    owner_public_id,
                    i64::try_from(limit).map_err(|_| PublicationError::InvalidState)?
                ],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
            )
            .map_err(storage)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(storage)?;
        drop(statement);
        rows.into_iter()
            .map(|(public_id, revision)| {
                load_revision(
                    &connection,
                    &self.cipher,
                    &public_id,
                    from_sql_i64(revision)?,
                )
            })
            .collect()
    }

    pub fn catalog_records(&self, now_ms: u64) -> Result<Vec<CatalogItem>> {
        let connection = self.connection.lock().map_err(lock_error)?;
        let mut statement = connection
            .prepare(
                "SELECT public_id, revision FROM content_revision
                 WHERE status = 'published'
                   AND (expires_at_ms IS NULL OR expires_at_ms > ?1)
                 ORDER BY public_id, revision",
            )
            .map_err(storage)?;
        let keys = statement
            .query_map([to_sql_i64(now_ms)?], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })
            .map_err(storage)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(storage)?;
        let mut records = Vec::with_capacity(keys.len());
        for (public_id, revision) in keys {
            records.push(load_catalog_item(
                &connection,
                &self.cipher,
                &public_id,
                from_sql_i64(revision)?,
            )?);
        }
        Ok(records)
    }

    pub fn catalog_tombstones(&self) -> Result<Vec<CatalogTombstone>> {
        let connection = self.connection.lock().map_err(lock_error)?;
        let mut statement = connection
            .prepare(
                "SELECT public_id, revision, deleted_at_ms
                 FROM catalog_tombstone ORDER BY public_id",
            )
            .map_err(storage)?;
        let tombstones = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            })
            .map_err(storage)?
            .map(|row| {
                let (public_id, revision, deleted_at_ms) = row.map_err(storage)?;
                Ok(CatalogTombstone {
                    public_id,
                    revision: from_sql_i64(revision)?,
                    deleted_at_ms: from_sql_i64(deleted_at_ms)?,
                })
            })
            .collect();
        tombstones
    }

    pub fn database_path(&self) -> Option<&Path> {
        self.path.as_deref()
    }

    fn initialize(&self) -> Result<()> {
        let connection = self.connection.lock().map_err(lock_error)?;
        connection
            .execute_batch(
                "
                PRAGMA foreign_keys = ON;
                PRAGMA trusted_schema = OFF;
                PRAGMA journal_mode = DELETE;
                CREATE TABLE IF NOT EXISTS content_revision (
                    public_id TEXT NOT NULL,
                    revision INTEGER NOT NULL,
                    owner_public_id TEXT NOT NULL,
                    draft_cipher BLOB NOT NULL,
                    status TEXT NOT NULL,
                    created_at_ms INTEGER NOT NULL,
                    published_at_ms INTEGER,
                    expires_at_ms INTEGER,
                    moderation_decision_id TEXT,
                    wording_suggestion_cipher BLOB,
                    reminder_sent_at_ms INTEGER,
                    model_json TEXT,
                    embedding BLOB,
                    PRIMARY KEY(public_id, revision)
                ) STRICT;
                CREATE TABLE IF NOT EXISTS moderation_case (
                    case_id TEXT PRIMARY KEY,
                    public_id TEXT NOT NULL,
                    revision INTEGER NOT NULL,
                    source TEXT NOT NULL,
                    status TEXT NOT NULL,
                    created_at_ms INTEGER NOT NULL,
                    resolved_at_ms INTEGER,
                    decision TEXT,
                    decision_reason_cipher BLOB,
                    moderator_id TEXT,
                    model_version TEXT,
                    rules_version TEXT,
                    confidence REAL,
                    triggered_policy TEXT,
                    reporter_public_id TEXT,
                    private_evidence_cipher BLOB,
                    illegal_content_notice INTEGER,
                    appeal_reason_cipher BLOB,
                    appealed_at_ms INTEGER,
                    alert_sent_at_ms INTEGER,
                    acknowledged_at_ms INTEGER,
                    acknowledged_by TEXT,
                    escalated_at_ms INTEGER,
                    FOREIGN KEY(public_id, revision)
                        REFERENCES content_revision(public_id, revision)
                ) STRICT;
                CREATE TABLE IF NOT EXISTS content_embedding_chunk (
                    public_id TEXT NOT NULL,
                    revision INTEGER NOT NULL,
                    source TEXT NOT NULL,
                    ordinal INTEGER NOT NULL CHECK(ordinal >= 0 AND ordinal <= 65535),
                    embedding BLOB NOT NULL,
                    PRIMARY KEY(public_id, revision, source, ordinal),
                    FOREIGN KEY(public_id, revision)
                        REFERENCES content_revision(public_id, revision)
                        ON DELETE CASCADE
                ) STRICT;
                CREATE TABLE IF NOT EXISTS catalog_tombstone (
                    public_id TEXT PRIMARY KEY,
                    revision INTEGER NOT NULL,
                    deleted_at_ms INTEGER NOT NULL
                ) STRICT;
                CREATE TABLE IF NOT EXISTS moderation_audit (
                    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
                    event TEXT NOT NULL,
                    target_id TEXT NOT NULL,
                    actor_id TEXT NOT NULL,
                    created_at_ms INTEGER NOT NULL,
                    details TEXT NOT NULL
                ) STRICT;
                CREATE TABLE IF NOT EXISTS scheduled_delivery (
                    delivery_id TEXT PRIMARY KEY,
                    idempotency_key TEXT NOT NULL UNIQUE,
                    kind TEXT NOT NULL,
                    public_id TEXT,
                    revision INTEGER,
                    owner_public_id TEXT,
                    case_id TEXT,
                    created_at_ms INTEGER NOT NULL,
                    lease_until_ms INTEGER,
                    attempts INTEGER NOT NULL DEFAULT 0,
                    delivered_at_ms INTEGER
                ) STRICT;
                ",
            )
            .map_err(storage)?;
        for (column, declaration) in [
            ("alert_sent_at_ms", "INTEGER"),
            ("acknowledged_at_ms", "INTEGER"),
            ("acknowledged_by", "TEXT"),
            ("escalated_at_ms", "INTEGER"),
        ] {
            ensure_column(&connection, "moderation_case", column, declaration)?;
        }
        Ok(())
    }

    fn insert_revision(
        &self,
        public_id: &str,
        revision: u64,
        owner_public_id: &str,
        draft: PublicContentDraft,
        now_ms: u64,
    ) -> Result<PublicationRecord> {
        let draft_json = serde_json::to_string(&draft).map_err(json_error)?;
        let draft_cipher = self.encrypt_private(draft_json)?;
        let mut connection = self.connection.lock().map_err(lock_error)?;
        let transaction = connection.transaction().map_err(storage)?;
        transaction
            .execute(
                "INSERT INTO content_revision(
                    public_id, revision, owner_public_id, draft_cipher, status, created_at_ms
                 ) VALUES (?1, ?2, ?3, ?4, 'awaiting_screening', ?5)",
                params![
                    public_id,
                    to_sql_i64(revision)?,
                    owner_public_id,
                    draft_cipher,
                    to_sql_i64(now_ms)?
                ],
            )
            .map_err(storage)?;
        append_audit(
            &transaction,
            "content_submitted",
            public_id,
            owner_public_id,
            now_ms,
            &format!("revision={revision}"),
        )?;
        transaction.commit().map_err(storage)?;
        Ok(PublicationRecord {
            public_id: public_id.to_owned(),
            revision,
            owner_public_id: owner_public_id.to_owned(),
            draft,
            status: PublicationStatus::AwaitingScreening,
            created_at_ms: now_ms,
            published_at_ms: None,
            expires_at_ms: None,
            moderation_decision_id: None,
            wording_suggestion: None,
            reminder_sent_at_ms: None,
        })
    }

    fn encrypt_private(&self, text: String) -> Result<Vec<u8>> {
        let mut nonce = [0u8; 24];
        OsRng.fill_bytes(&mut nonce);
        let ciphertext = self
            .cipher
            .encrypt(XNonce::from_slice(&nonce), text.as_bytes())
            .map_err(|_| PublicationError::Encryption)?;
        let mut output = Vec::with_capacity(1 + nonce.len() + ciphertext.len());
        output.push(1);
        output.extend_from_slice(&nonce);
        output.extend_from_slice(&ciphertext);
        Ok(output)
    }
}

fn load_revision(
    connection: &Connection,
    cipher: &XChaCha20Poly1305,
    public_id: &str,
    revision: u64,
) -> Result<PublicationRecord> {
    connection
        .query_row(
            "SELECT owner_public_id, draft_cipher, status, created_at_ms, published_at_ms,
                    expires_at_ms, moderation_decision_id, wording_suggestion_cipher,
                    reminder_sent_at_ms
             FROM content_revision WHERE public_id = ?1 AND revision = ?2",
            params![public_id, to_sql_i64(revision)?],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Vec<u8>>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, Option<i64>>(4)?,
                    row.get::<_, Option<i64>>(5)?,
                    row.get::<_, Option<String>>(6)?,
                    row.get::<_, Option<Vec<u8>>>(7)?,
                    row.get::<_, Option<i64>>(8)?,
                ))
            },
        )
        .optional()
        .map_err(storage)?
        .ok_or(PublicationError::NotFound)
        .and_then(
            |(
                owner_public_id,
                draft_cipher,
                status,
                created_at_ms,
                published_at_ms,
                expires_at_ms,
                moderation_decision_id,
                wording_suggestion_cipher,
                reminder_sent_at_ms,
            )| {
                let draft_json = decrypt_private(cipher, &draft_cipher)?;
                Ok(PublicationRecord {
                    public_id: public_id.to_owned(),
                    revision,
                    owner_public_id,
                    draft: serde_json::from_str(&draft_json).map_err(json_error)?,
                    status: PublicationStatus::parse(&status)?,
                    created_at_ms: from_sql_i64(created_at_ms)?,
                    published_at_ms: published_at_ms.map(from_sql_i64).transpose()?,
                    expires_at_ms: expires_at_ms.map(from_sql_i64).transpose()?,
                    moderation_decision_id,
                    wording_suggestion: wording_suggestion_cipher
                        .map(|value| decrypt_private(cipher, &value))
                        .transpose()?,
                    reminder_sent_at_ms: reminder_sent_at_ms.map(from_sql_i64).transpose()?,
                })
            },
        )
}

fn load_case(connection: &Connection, case_id: &str) -> Result<ModerationCase> {
    connection
        .query_row(
            "SELECT public_id, revision, source, status, created_at_ms
             FROM moderation_case WHERE case_id = ?1",
            [case_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, i64>(4)?,
                ))
            },
        )
        .optional()
        .map_err(storage)?
        .ok_or(PublicationError::NotFound)
        .and_then(|(public_id, revision, source, status, created_at_ms)| {
            Ok(ModerationCase {
                case_id: case_id.to_owned(),
                public_id,
                revision: from_sql_i64(revision)?,
                source,
                status,
                created_at_ms: from_sql_i64(created_at_ms)?,
            })
        })
}

struct ModerationQueueRow {
    case_id: String,
    public_id: String,
    revision: i64,
    source: String,
    status: String,
    created_at_ms: i64,
    acknowledged_at_ms: Option<i64>,
    acknowledged_by: Option<String>,
    illegal_content_notice: Option<i64>,
    reporter_public_id: Option<String>,
    private_evidence_cipher: Option<Vec<u8>>,
    appeal_reason_cipher: Option<Vec<u8>>,
    model_version: Option<String>,
    rules_version: Option<String>,
    confidence: Option<f32>,
    triggered_policy: Option<String>,
}

fn load_catalog_item(
    connection: &Connection,
    cipher: &XChaCha20Poly1305,
    public_id: &str,
    revision: u64,
) -> Result<CatalogItem> {
    let record = load_revision(connection, cipher, public_id, revision)?;
    if record.status != PublicationStatus::Published {
        return Err(PublicationError::InvalidState);
    }
    let (model_json, embedding): (String, Vec<u8>) = connection
        .query_row(
            "SELECT model_json, embedding FROM content_revision
             WHERE public_id = ?1 AND revision = ?2",
            params![public_id, to_sql_i64(revision)?],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(storage)?;
    let model: ModelContract = serde_json::from_str(&model_json).map_err(json_error)?;
    let embedding = decode_embedding(&embedding, model.dimension)?;
    let embedding_chunks = {
        let mut statement = connection
            .prepare(
                "SELECT source, ordinal, embedding
                 FROM content_embedding_chunk
                 WHERE public_id = ?1 AND revision = ?2
                 ORDER BY source, ordinal",
            )
            .map_err(storage)?;
        let chunks = statement
            .query_map(params![public_id, to_sql_i64(revision)?], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, Vec<u8>>(2)?,
                ))
            })
            .map_err(storage)?
            .map(|row| {
                let (source, ordinal, bytes) = row.map_err(storage)?;
                Ok(CatalogEmbeddingChunk {
                    source: parse_embedding_source(&source)?,
                    ordinal: u16::try_from(ordinal).map_err(|_| {
                        PublicationError::Storage(
                            "stored embedding chunk ordinal is invalid".to_owned(),
                        )
                    })?,
                    embedding: decode_embedding(&bytes, model.dimension)?,
                })
            })
            .collect::<Result<Vec<_>>>()?;
        chunks
    };
    Ok(CatalogItem {
        public_id: record.public_id,
        revision: record.revision,
        owner_public_id: record.owner_public_id,
        kind: record.draft.kind.catalog_kind(),
        title: record.draft.title,
        summary: record.draft.summary,
        roles: record.draft.roles,
        categories: record.draft.categories,
        languages: record.draft.languages,
        coarse_region: record.draft.coarse_region,
        radius_km: record.draft.radius_km,
        media: record.draft.media,
        published_at_ms: record
            .published_at_ms
            .ok_or(PublicationError::InvalidState)?,
        expires_at_ms: record.expires_at_ms,
        moderation_decision_id: record
            .moderation_decision_id
            .ok_or(PublicationError::InvalidState)?,
        sponsorship: None,
        model,
        embedding,
        embedding_chunks,
    })
}

fn next_status_for_decision(
    current: PublicationStatus,
    decision: ModeratorDecision,
) -> Result<PublicationStatus> {
    match (current, decision) {
        (
            PublicationStatus::HumanReview | PublicationStatus::Quarantined,
            ModeratorDecision::Approve,
        ) => Ok(PublicationStatus::ApprovedAwaitingEmbedding),
        (
            PublicationStatus::HumanReview
            | PublicationStatus::Quarantined
            | PublicationStatus::NeedsChanges,
            ModeratorDecision::Reject,
        ) => Ok(PublicationStatus::Rejected),
        (PublicationStatus::Published, ModeratorDecision::KeepVisible) => {
            Ok(PublicationStatus::Published)
        }
        (PublicationStatus::Published, ModeratorDecision::Hide) => Ok(PublicationStatus::Hidden),
        (PublicationStatus::Published | PublicationStatus::Hidden, ModeratorDecision::Remove) => {
            Ok(PublicationStatus::Removed)
        }
        (
            PublicationStatus::Rejected | PublicationStatus::Hidden | PublicationStatus::Removed,
            ModeratorDecision::Reinstate,
        ) => Ok(PublicationStatus::ApprovedAwaitingEmbedding),
        _ => Err(PublicationError::InvalidState),
    }
}

fn write_tombstone(
    transaction: &Transaction<'_>,
    public_id: &str,
    revision: u64,
    now_ms: u64,
) -> Result<()> {
    transaction
        .execute(
            "INSERT INTO catalog_tombstone(public_id, revision, deleted_at_ms)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(public_id) DO UPDATE SET revision = excluded.revision,
                deleted_at_ms = excluded.deleted_at_ms
             WHERE excluded.revision >= catalog_tombstone.revision",
            params![public_id, to_sql_i64(revision)?, to_sql_i64(now_ms)?],
        )
        .map_err(storage)?;
    Ok(())
}

fn append_audit(
    transaction: &Transaction<'_>,
    event: &str,
    target_id: &str,
    actor_id: &str,
    now_ms: u64,
    details: &str,
) -> Result<()> {
    transaction
        .execute(
            "INSERT INTO moderation_audit(event, target_id, actor_id, created_at_ms, details)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![event, target_id, actor_id, to_sql_i64(now_ms)?, details],
        )
        .map_err(storage)?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn enqueue_scheduled_delivery(
    transaction: &Transaction<'_>,
    kind: &str,
    idempotency_key: &str,
    public_id: Option<&str>,
    revision: Option<u64>,
    owner_public_id: Option<&str>,
    case_id: Option<&str>,
    now_ms: u64,
) -> Result<()> {
    let delivery_id = random_id("delivery");
    transaction
        .execute(
            "INSERT INTO scheduled_delivery(
                delivery_id, idempotency_key, kind, public_id, revision,
                owner_public_id, case_id, created_at_ms
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(idempotency_key) DO NOTHING",
            params![
                delivery_id,
                idempotency_key,
                kind,
                public_id,
                revision.map(to_sql_i64).transpose()?,
                owner_public_id,
                case_id,
                to_sql_i64(now_ms)?
            ],
        )
        .map_err(storage)?;
    Ok(())
}

fn claim_scheduled_deliveries(
    transaction: &Transaction<'_>,
    now_ms: u64,
) -> Result<Vec<ScheduledAction>> {
    let mut statement = transaction
        .prepare(
            "SELECT delivery_id, kind, public_id, revision, owner_public_id, case_id
             FROM scheduled_delivery
             WHERE delivered_at_ms IS NULL
               AND (lease_until_ms IS NULL OR lease_until_ms <= ?1)
             ORDER BY created_at_ms, delivery_id
             LIMIT ?2",
        )
        .map_err(storage)?;
    let rows = statement
        .query_map(
            params![
                to_sql_i64(now_ms)?,
                i64::try_from(MAX_SCHEDULED_DELIVERIES_PER_RUN)
                    .map_err(|_| PublicationError::InvalidState)?
            ],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<i64>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, Option<String>>(5)?,
                ))
            },
        )
        .map_err(storage)?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(storage)?;
    drop(statement);

    let lease_until = to_sql_i64(now_ms.saturating_add(DELIVERY_LEASE_MS))?;
    let mut actions = Vec::with_capacity(rows.len());
    for (delivery_id, kind, public_id, revision_raw, owner_public_id, case_id) in rows {
        let action = match kind.as_str() {
            "listing_expiry_reminder" => ScheduledAction::ListingExpiryReminder {
                delivery_id: delivery_id.clone(),
                public_id: public_id.ok_or_else(|| {
                    PublicationError::Storage(
                        "scheduled listing reminder is missing its content id".to_owned(),
                    )
                })?,
                revision: from_sql_i64(revision_raw.ok_or_else(|| {
                    PublicationError::Storage(
                        "scheduled listing reminder is missing its revision".to_owned(),
                    )
                })?)?,
                owner_public_id: owner_public_id.ok_or_else(|| {
                    PublicationError::Storage(
                        "scheduled listing reminder is missing its owner".to_owned(),
                    )
                })?,
            },
            "moderation_queue_alert" => ScheduledAction::ModerationQueueAlert {
                delivery_id: delivery_id.clone(),
                case_id: case_id.ok_or_else(|| {
                    PublicationError::Storage(
                        "scheduled moderation alert is missing its case id".to_owned(),
                    )
                })?,
            },
            "moderation_overdue" => ScheduledAction::ModerationOverdue {
                delivery_id: delivery_id.clone(),
                case_id: case_id.ok_or_else(|| {
                    PublicationError::Storage(
                        "scheduled moderation escalation is missing its case id".to_owned(),
                    )
                })?,
            },
            "moderation_outcome_notice" => ScheduledAction::ModerationOutcomeNotice {
                delivery_id: delivery_id.clone(),
                case_id: case_id.ok_or_else(|| {
                    PublicationError::Storage(
                        "scheduled moderation outcome is missing its case id".to_owned(),
                    )
                })?,
                recipient_public_id: owner_public_id.ok_or_else(|| {
                    PublicationError::Storage(
                        "scheduled moderation outcome is missing its recipient".to_owned(),
                    )
                })?,
            },
            _ => {
                return Err(PublicationError::Storage(
                    "scheduled delivery contains an unknown kind".to_owned(),
                ))
            }
        };
        let changed = transaction
            .execute(
                "UPDATE scheduled_delivery
                 SET lease_until_ms = ?1, attempts = attempts + 1
                 WHERE delivery_id = ?2 AND delivered_at_ms IS NULL
                   AND (lease_until_ms IS NULL OR lease_until_ms <= ?3)",
                params![lease_until, delivery_id, to_sql_i64(now_ms)?],
            )
            .map_err(storage)?;
        if changed == 1 {
            actions.push(action);
        }
    }
    Ok(actions)
}

fn ensure_column(
    connection: &Connection,
    table: &str,
    column: &str,
    declaration: &str,
) -> Result<()> {
    let exists = connection
        .query_row(
            &format!(
                "SELECT COUNT(*) FROM pragma_table_info('{}') WHERE name = ?1",
                table
            ),
            [column],
            |row| row.get::<_, i64>(0),
        )
        .map_err(storage)?
        > 0;
    if !exists {
        connection
            .execute_batch(&format!(
                "ALTER TABLE {table} ADD COLUMN {column} {declaration};"
            ))
            .map_err(storage)?;
    }
    Ok(())
}

fn validate_draft(draft: &PublicContentDraft) -> Result<()> {
    validate_text("title", &draft.title, 1, 120)?;
    validate_text("summary", &draft.summary, 1, 2_000)?;
    validate_list("roles", &draft.roles, 16, 64)?;
    validate_list("categories", &draft.categories, 16, 64)?;
    validate_list("languages", &draft.languages, 12, 16)?;
    if draft.languages.is_empty() {
        return Err(PublicationError::Invalid(
            "at least one content language is required".to_owned(),
        ));
    }
    match (&draft.coarse_region, draft.radius_km) {
        (None, None) => {}
        (Some(region), Some(5 | 10 | 25))
            if region.len() == 5
                && region
                    .bytes()
                    .all(|byte| b"0123456789bcdefghjkmnpqrstuvwxyz".contains(&byte)) => {}
        _ => {
            return Err(PublicationError::Invalid(
                "coarse location must use a 5-character geohash and a 5, 10, or 25 km radius"
                    .to_owned(),
            ));
        }
    }
    if draft.media.len() > 8 {
        return Err(PublicationError::Invalid(
            "a public entry may reference at most 8 media objects".to_owned(),
        ));
    }
    // Reuse the signed-catalog schema as the final validator. The publication
    // draft is intentionally typed and has no price, payment, wallet, order,
    // matching, or transaction fields.
    Ok(())
}

fn validate_assessment(assessment: &ScreeningAssessment) -> Result<()> {
    validate_identifier("model version", &assessment.model_version)?;
    validate_identifier("rules version", &assessment.rules_version)?;
    validate_identifier("triggered policy", &assessment.triggered_policy)?;
    if !assessment.confidence.is_finite() || !(0.0..=1.0).contains(&assessment.confidence) {
        return Err(PublicationError::Invalid(
            "screening confidence must be between 0 and 1".to_owned(),
        ));
    }
    Ok(())
}

fn validate_embedding(model: &ModelContract, embedding: &[f32]) -> Result<()> {
    model
        .validate_v1()
        .map_err(|error| PublicationError::Invalid(error.to_string()))?;
    if embedding.len() != model.dimension || embedding.iter().any(|value| !value.is_finite()) {
        return Err(PublicationError::Invalid(
            "embedding does not match the V1 Harrier model contract".to_owned(),
        ));
    }
    let norm = embedding
        .iter()
        .map(|value| f64::from(*value).powi(2))
        .sum::<f64>()
        .sqrt();
    if !(0.995..=1.005).contains(&norm) {
        return Err(PublicationError::Invalid(
            "embedding must be L2-normalized".to_owned(),
        ));
    }
    Ok(())
}

fn validate_embedding_chunks(
    model: &ModelContract,
    chunks: &[CatalogEmbeddingChunk],
) -> Result<()> {
    if chunks.len() > MAX_EMBEDDING_CHUNKS_PER_ITEM {
        return Err(PublicationError::Invalid(format!(
            "at most {MAX_EMBEDDING_CHUNKS_PER_ITEM} additional embedding chunks are allowed"
        )));
    }
    let mut keys = HashSet::with_capacity(chunks.len());
    for chunk in chunks {
        if !keys.insert((chunk.source, chunk.ordinal)) {
            return Err(PublicationError::Invalid(
                "embedding chunk source and ordinal must be unique".to_owned(),
            ));
        }
        validate_embedding(model, &chunk.embedding)?;
    }
    Ok(())
}

fn embedding_source_name(source: CatalogEmbeddingSource) -> &'static str {
    match source {
        CatalogEmbeddingSource::Title => "title",
        CatalogEmbeddingSource::Summary => "summary",
        CatalogEmbeddingSource::Bullet => "bullet",
        CatalogEmbeddingSource::Description => "description",
    }
}

fn parse_embedding_source(value: &str) -> Result<CatalogEmbeddingSource> {
    match value {
        "title" => Ok(CatalogEmbeddingSource::Title),
        "summary" => Ok(CatalogEmbeddingSource::Summary),
        "bullet" => Ok(CatalogEmbeddingSource::Bullet),
        "description" => Ok(CatalogEmbeddingSource::Description),
        _ => Err(PublicationError::Storage(
            "stored embedding chunk source is invalid".to_owned(),
        )),
    }
}

fn validate_identifier(label: &str, value: &str) -> Result<()> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
    {
        return Err(PublicationError::Invalid(format!("{label} is invalid")));
    }
    Ok(())
}

fn validate_text(label: &str, value: &str, min: usize, max: usize) -> Result<String> {
    let count = value.chars().count();
    if value.trim() != value || !(min..=max).contains(&count) || value.chars().any(char::is_control)
    {
        return Err(PublicationError::Invalid(format!(
            "{label} must contain {min} to {max} printable characters"
        )));
    }
    Ok(value.to_owned())
}

fn validate_private_text(label: &str, value: &str) -> Result<String> {
    validate_text(label, value, 1, MAX_PRIVATE_REASON_CHARS)
}

fn validate_list(label: &str, values: &[String], max_items: usize, max_chars: usize) -> Result<()> {
    if values.len() > max_items {
        return Err(PublicationError::Invalid(format!(
            "{label} contains too many entries"
        )));
    }
    for value in values {
        validate_text(label, value, 1, max_chars)?;
    }
    Ok(())
}

fn random_id(prefix: &str) -> String {
    let mut value = [0u8; 16];
    OsRng.fill_bytes(&mut value);
    format!("{prefix}_{}", hex::encode(value))
}

fn decision_name(decision: ModeratorDecision) -> &'static str {
    match decision {
        ModeratorDecision::Approve => "approve",
        ModeratorDecision::Reject => "reject",
        ModeratorDecision::KeepVisible => "keep_visible",
        ModeratorDecision::Hide => "hide",
        ModeratorDecision::Remove => "remove",
        ModeratorDecision::Reinstate => "reinstate",
    }
}

fn encode_embedding(values: &[f32]) -> Vec<u8> {
    values
        .iter()
        .flat_map(|value| value.to_le_bytes())
        .collect()
}

fn decode_embedding(bytes: &[u8], dimension: usize) -> Result<Vec<f32>> {
    if bytes.len() != dimension * 4 {
        return Err(PublicationError::Storage(
            "stored embedding has an invalid length".to_owned(),
        ));
    }
    Ok(bytes
        .chunks_exact(4)
        .map(|chunk| f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
        .collect())
}

fn to_sql_i64(value: u64) -> Result<i64> {
    i64::try_from(value).map_err(|_| {
        PublicationError::Invalid("integer exceeds SQLite's supported range".to_owned())
    })
}

fn from_sql_i64(value: i64) -> Result<u64> {
    u64::try_from(value)
        .map_err(|_| PublicationError::Storage("stored integer is negative".to_owned()))
}

fn storage(error: impl std::fmt::Display) -> PublicationError {
    PublicationError::Storage(error.to_string())
}

fn json_error(error: impl std::fmt::Display) -> PublicationError {
    PublicationError::Invalid(error.to_string())
}

fn lock_error<T>(_: std::sync::PoisonError<T>) -> PublicationError {
    PublicationError::Storage("publication store lock is poisoned".to_owned())
}

fn decrypt_private(cipher: &XChaCha20Poly1305, value: &[u8]) -> Result<String> {
    if value.len() < 25 || value[0] != 1 {
        return Err(PublicationError::Encryption);
    }
    let plaintext = cipher
        .decrypt(XNonce::from_slice(&value[1..25]), &value[25..])
        .map_err(|_| PublicationError::Encryption)?;
    String::from_utf8(plaintext).map_err(|_| PublicationError::Encryption)
}
