use community_search_core::{
    normalize_query_text_v1, ModelContract, QueryCatalogDelta, QueryCatalogEntry,
    QueryCatalogPayload, CATALOG_SCHEMA_VERSION, QUERY_NORMALIZATION_VERSION,
    V1_EMBEDDING_DIMENSION,
};
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    path::Path,
    sync::{Mutex, MutexGuard},
};
use thiserror::Error;
use zeroize::Zeroize;

pub const DEFAULT_MINIMUM_INDEPENDENT_CONTRIBUTORS: u32 = 3;
pub const RARE_TERM_RETENTION_MS: u64 = 30 * 24 * 60 * 60 * 1_000;
pub const SUBMISSION_RECEIPT_RETENTION_MS: u64 = 7 * 24 * 60 * 60 * 1_000;
const MAX_CANDIDATES: usize = 10_000;

#[derive(Debug, Error)]
pub enum QueryContributionError {
    #[error("query contribution is invalid: {0}")]
    Invalid(String),
    #[error("query contribution was not found")]
    NotFound,
    #[error("query contribution is in the wrong state")]
    InvalidState,
    #[error("query contribution storage failed")]
    Storage,
}

pub type Result<T> = std::result::Result<T, QueryContributionError>;

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct QueryContributionInput {
    pub submission_id: String,
    pub query: String,
    pub language: String,
    pub model_id: String,
    pub query_prompt_version: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryContributionReceipt {
    pub accepted: bool,
    pub duplicate: bool,
    pub eligible_for_review: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryContributionCandidate {
    pub query_id: String,
    pub normalized_text: String,
    pub language: String,
    pub independent_contributors: u64,
    pub total_submissions: u64,
    pub first_seen_at_ms: u64,
    pub last_seen_at_ms: u64,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QueryModerationDecision {
    Approve,
    Reject,
}

pub struct QueryContributionStore {
    connection: Mutex<Connection>,
    privacy_salt: [u8; 32],
    minimum_independent_contributors: u32,
}

impl QueryContributionStore {
    pub fn open(
        path: impl AsRef<Path>,
        privacy_salt: [u8; 32],
        minimum_independent_contributors: u32,
    ) -> Result<Self> {
        let path = path.as_ref();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|_| QueryContributionError::Storage)?;
        }
        let connection = Connection::open(path).map_err(|_| QueryContributionError::Storage)?;
        Self::from_connection(connection, privacy_salt, minimum_independent_contributors)
    }

    pub fn in_memory(
        privacy_salt: [u8; 32],
        minimum_independent_contributors: u32,
    ) -> Result<Self> {
        Self::from_connection(
            Connection::open_in_memory().map_err(|_| QueryContributionError::Storage)?,
            privacy_salt,
            minimum_independent_contributors,
        )
    }

    fn from_connection(
        connection: Connection,
        privacy_salt: [u8; 32],
        minimum_independent_contributors: u32,
    ) -> Result<Self> {
        if !(2..=100).contains(&minimum_independent_contributors) {
            return invalid("minimum independent contributors must be between 2 and 100");
        }
        connection
            .execute_batch(
                "
                PRAGMA trusted_schema = OFF;
                PRAGMA foreign_keys = ON;
                PRAGMA journal_mode = WAL;
                CREATE TABLE IF NOT EXISTS query_term (
                    query_id TEXT PRIMARY KEY,
                    normalized_text TEXT NOT NULL,
                    language TEXT NOT NULL,
                    model_id TEXT NOT NULL,
                    query_prompt_version TEXT NOT NULL,
                    first_seen_at_ms INTEGER NOT NULL,
                    last_seen_at_ms INTEGER NOT NULL,
                    total_submissions INTEGER NOT NULL,
                    independent_contributors INTEGER NOT NULL,
                    moderation_status TEXT NOT NULL
                        CHECK(moderation_status IN ('pending', 'approved', 'rejected', 'published')),
                    moderator_id TEXT,
                    moderation_reason TEXT,
                    moderated_at_ms INTEGER,
                    embedding_json TEXT,
                    catalog_revision INTEGER NOT NULL DEFAULT 1,
                    published_sequence INTEGER,
                    published_at_ms INTEGER,
                    UNIQUE(normalized_text, language, model_id, query_prompt_version)
                ) STRICT;
                CREATE TABLE IF NOT EXISTS query_contributor (
                    query_id TEXT NOT NULL REFERENCES query_term(query_id) ON DELETE CASCADE,
                    contributor_tag BLOB NOT NULL,
                    first_seen_at_ms INTEGER NOT NULL,
                    PRIMARY KEY(query_id, contributor_tag)
                ) STRICT;
                CREATE TABLE IF NOT EXISTS query_submission (
                    submission_id TEXT PRIMARY KEY,
                    query_id TEXT NOT NULL REFERENCES query_term(query_id) ON DELETE CASCADE,
                    created_at_ms INTEGER NOT NULL
                ) STRICT;
                CREATE INDEX IF NOT EXISTS query_term_review_idx
                    ON query_term(moderation_status, independent_contributors, last_seen_at_ms);
                CREATE INDEX IF NOT EXISTS query_submission_age_idx
                    ON query_submission(created_at_ms);
                ",
            )
            .map_err(|_| QueryContributionError::Storage)?;
        Ok(Self {
            connection: Mutex::new(connection),
            privacy_salt,
            minimum_independent_contributors,
        })
    }

    pub fn contribute(
        &self,
        contributor_identity: &str,
        input: &QueryContributionInput,
        now_ms: u64,
    ) -> Result<QueryContributionReceipt> {
        validate_identifier("submission id", &input.submission_id, 128)?;
        validate_identifier("contributor identity", contributor_identity, 128)?;
        validate_language(&input.language)?;
        let model = ModelContract::harrier_v1();
        if input.model_id != model.id || input.query_prompt_version != model.query_prompt_version {
            return invalid("query contribution uses an unsupported model contract");
        }
        let normalized = normalize_query_text_v1(&input.query)
            .map_err(|_| QueryContributionError::Invalid("query text is invalid".to_owned()))?;
        if contains_sensitive_query_data(&normalized) {
            return invalid("query may contain private or secret data");
        }
        to_sql_i64(now_ms)?;
        let query_id = query_id(
            &normalized,
            &input.language,
            &input.model_id,
            &input.query_prompt_version,
        );
        let contributor_tag = self.contributor_tag(contributor_identity, &query_id);
        let mut connection = self.lock()?;
        prune_locked(&connection, now_ms, self.minimum_independent_contributors)?;
        let transaction = connection
            .transaction()
            .map_err(|_| QueryContributionError::Storage)?;
        if transaction
            .query_row(
                "SELECT 1 FROM query_submission WHERE submission_id = ?1",
                [&input.submission_id],
                |_| Ok(()),
            )
            .optional()
            .map_err(|_| QueryContributionError::Storage)?
            .is_some()
        {
            return Ok(QueryContributionReceipt {
                accepted: true,
                duplicate: true,
                eligible_for_review: false,
            });
        }
        transaction
            .execute(
                "INSERT INTO query_term(
                    query_id, normalized_text, language, model_id, query_prompt_version,
                    first_seen_at_ms, last_seen_at_ms, total_submissions,
                    independent_contributors, moderation_status
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, 0, 0, 'pending')
                 ON CONFLICT(query_id) DO NOTHING",
                params![
                    query_id,
                    normalized,
                    input.language,
                    input.model_id,
                    input.query_prompt_version,
                    to_sql_i64(now_ms)?
                ],
            )
            .map_err(|_| QueryContributionError::Storage)?;
        transaction
            .execute(
                "INSERT INTO query_submission(submission_id, query_id, created_at_ms)
                 VALUES (?1, ?2, ?3)",
                params![input.submission_id, query_id, to_sql_i64(now_ms)?],
            )
            .map_err(|_| QueryContributionError::Storage)?;
        transaction
            .execute(
                "UPDATE query_term
                 SET total_submissions = total_submissions + 1, last_seen_at_ms = ?1
                 WHERE query_id = ?2",
                params![to_sql_i64(now_ms)?, query_id],
            )
            .map_err(|_| QueryContributionError::Storage)?;
        let new_contributor = transaction
            .execute(
                "INSERT INTO query_contributor(query_id, contributor_tag, first_seen_at_ms)
                 VALUES (?1, ?2, ?3)
                 ON CONFLICT(query_id, contributor_tag) DO NOTHING",
                params![query_id, contributor_tag.as_slice(), to_sql_i64(now_ms)?],
            )
            .map_err(|_| QueryContributionError::Storage)?
            == 1;
        if new_contributor {
            transaction
                .execute(
                    "UPDATE query_term
                     SET independent_contributors = independent_contributors + 1,
                         moderation_status = CASE
                           WHEN moderation_status = 'published' THEN 'approved'
                           ELSE moderation_status
                         END,
                         catalog_revision = CASE
                           WHEN moderation_status = 'published' THEN catalog_revision + 1
                           ELSE catalog_revision
                         END
                     WHERE query_id = ?1",
                    [&query_id],
                )
                .map_err(|_| QueryContributionError::Storage)?;
        }
        let independent: u64 = transaction
            .query_row(
                "SELECT independent_contributors FROM query_term WHERE query_id = ?1",
                [&query_id],
                |row| row_u64(row, 0),
            )
            .map_err(|_| QueryContributionError::Storage)?;
        transaction
            .commit()
            .map_err(|_| QueryContributionError::Storage)?;
        Ok(QueryContributionReceipt {
            accepted: true,
            duplicate: false,
            eligible_for_review: independent >= u64::from(self.minimum_independent_contributors),
        })
    }

    pub fn review_candidates(
        &self,
        limit: usize,
        now_ms: u64,
    ) -> Result<Vec<QueryContributionCandidate>> {
        if !(1..=MAX_CANDIDATES).contains(&limit) {
            return invalid("candidate limit is invalid");
        }
        let connection = self.lock()?;
        prune_locked(&connection, now_ms, self.minimum_independent_contributors)?;
        let mut statement = connection
            .prepare(
                "SELECT query_id, normalized_text, language, independent_contributors,
                        total_submissions, first_seen_at_ms, last_seen_at_ms
                 FROM query_term
                 WHERE moderation_status = 'pending'
                   AND independent_contributors >= ?1
                 ORDER BY independent_contributors DESC, total_submissions DESC,
                          first_seen_at_ms ASC, query_id ASC
                 LIMIT ?2",
            )
            .map_err(|_| QueryContributionError::Storage)?;
        let candidates = statement
            .query_map(
                params![
                    self.minimum_independent_contributors,
                    i64::try_from(limit).map_err(|_| QueryContributionError::Storage)?
                ],
                |row| {
                    Ok(QueryContributionCandidate {
                        query_id: row.get(0)?,
                        normalized_text: row.get(1)?,
                        language: row.get(2)?,
                        independent_contributors: row_u64(row, 3)?,
                        total_submissions: row_u64(row, 4)?,
                        first_seen_at_ms: row_u64(row, 5)?,
                        last_seen_at_ms: row_u64(row, 6)?,
                    })
                },
            )
            .map_err(|_| QueryContributionError::Storage)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(|_| QueryContributionError::Storage)?;
        Ok(candidates)
    }

    pub fn moderate(
        &self,
        query_id: &str,
        moderator_id: &str,
        reason: &str,
        decision: QueryModerationDecision,
        embedding: Option<&[f32]>,
        now_ms: u64,
    ) -> Result<()> {
        validate_identifier("query id", query_id, 128)?;
        validate_identifier("moderator id", moderator_id, 128)?;
        validate_text("moderation reason", reason, 4, 1_000)?;
        to_sql_i64(now_ms)?;
        let encoded_embedding = match decision {
            QueryModerationDecision::Approve => {
                let embedding = embedding.ok_or_else(|| {
                    QueryContributionError::Invalid(
                        "approved query requires its reviewed embedding".to_owned(),
                    )
                })?;
                validate_embedding(embedding)?;
                Some(
                    serde_json::to_string(embedding)
                        .map_err(|_| QueryContributionError::Storage)?,
                )
            }
            QueryModerationDecision::Reject if embedding.is_some() => {
                return invalid("rejected query must not include an embedding")
            }
            QueryModerationDecision::Reject => None,
        };
        let connection = self.lock()?;
        let changed = connection
            .execute(
                "UPDATE query_term
                 SET moderation_status = ?1, moderator_id = ?2,
                     moderation_reason = ?3, moderated_at_ms = ?4,
                     embedding_json = ?5
                 WHERE query_id = ?6 AND moderation_status = 'pending'
                   AND independent_contributors >= ?7",
                params![
                    match decision {
                        QueryModerationDecision::Approve => "approved",
                        QueryModerationDecision::Reject => "rejected",
                    },
                    moderator_id,
                    reason,
                    to_sql_i64(now_ms)?,
                    encoded_embedding,
                    query_id,
                    self.minimum_independent_contributors
                ],
            )
            .map_err(|_| QueryContributionError::Storage)?;
        if changed == 1 {
            Ok(())
        } else if exists(&connection, query_id)? {
            Err(QueryContributionError::InvalidState)
        } else {
            Err(QueryContributionError::NotFound)
        }
    }

    pub fn catalog_delta(
        &self,
        catalog_scope_id: &str,
        from_sequence: u64,
        to_sequence: u64,
        limit: usize,
    ) -> Result<QueryCatalogPayload> {
        validate_identifier("query catalog scope", catalog_scope_id, 128)?;
        if to_sequence <= from_sequence || !(1..=MAX_CANDIDATES).contains(&limit) {
            return invalid("query catalog sequence or limit is invalid");
        }
        to_sql_i64(from_sequence)?;
        to_sql_i64(to_sequence)?;
        let connection = self.lock()?;
        let mut statement = connection
            .prepare(
                "SELECT query_id, normalized_text, language, independent_contributors,
                        catalog_revision, embedding_json
                 FROM query_term
                 WHERE moderation_status = 'approved'
                 ORDER BY independent_contributors DESC, total_submissions DESC,
                          first_seen_at_ms ASC, query_id ASC
                 LIMIT ?1",
            )
            .map_err(|_| QueryContributionError::Storage)?;
        let rows = statement
            .query_map(
                [i64::try_from(limit).map_err(|_| QueryContributionError::Storage)?],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row_u64(row, 3)?,
                        row_u64(row, 4)?,
                        row.get::<_, String>(5)?,
                    ))
                },
            )
            .map_err(|_| QueryContributionError::Storage)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(|_| QueryContributionError::Storage)?;
        let model = ModelContract::harrier_v1();
        let upserts = rows
            .into_iter()
            .map(
                |(query_id, normalized_text, language, independent, revision, embedding_json)| {
                    let embedding: Vec<f32> = serde_json::from_str(&embedding_json)
                        .map_err(|_| QueryContributionError::Storage)?;
                    validate_embedding(&embedding)?;
                    Ok(QueryCatalogEntry {
                        query_id,
                        revision,
                        display_text: normalized_text.clone(),
                        normalized_text,
                        language,
                        weight: popularity_weight(independent),
                        model: model.clone(),
                        embedding,
                    })
                },
            )
            .collect::<Result<Vec<_>>>()?;
        let payload = QueryCatalogPayload::Delta(QueryCatalogDelta {
            schema_version: CATALOG_SCHEMA_VERSION,
            catalog_scope_id: catalog_scope_id.to_owned(),
            from_sequence,
            to_sequence,
            normalization_version: QUERY_NORMALIZATION_VERSION.to_owned(),
            model,
            upserts,
            tombstones: Vec::new(),
        });
        payload
            .validate_for_publication()
            .map_err(|error| QueryContributionError::Invalid(error.to_string()))?;
        Ok(payload)
    }

    pub fn acknowledge_published(
        &self,
        query_ids: &[String],
        sequence: u64,
        now_ms: u64,
    ) -> Result<()> {
        if query_ids.is_empty() || query_ids.len() > MAX_CANDIDATES {
            return invalid("published query list is invalid");
        }
        to_sql_i64(sequence)?;
        to_sql_i64(now_ms)?;
        let mut connection = self.lock()?;
        let transaction = connection
            .transaction()
            .map_err(|_| QueryContributionError::Storage)?;
        for query_id in query_ids {
            validate_identifier("query id", query_id, 128)?;
            let changed = transaction
                .execute(
                    "UPDATE query_term
                     SET moderation_status = 'published', published_sequence = ?1,
                         published_at_ms = ?2
                     WHERE query_id = ?3 AND moderation_status = 'approved'",
                    params![to_sql_i64(sequence)?, to_sql_i64(now_ms)?, query_id],
                )
                .map_err(|_| QueryContributionError::Storage)?;
            if changed != 1 {
                return Err(QueryContributionError::InvalidState);
            }
        }
        transaction
            .commit()
            .map_err(|_| QueryContributionError::Storage)
    }

    fn contributor_tag(&self, identity: &str, query_id: &str) -> [u8; 32] {
        let mut digest = Sha256::new();
        digest.update(b"tex8-community-query-contributor-v1");
        digest.update(self.privacy_salt);
        digest.update(query_id.as_bytes());
        digest.update([0]);
        digest.update(identity.as_bytes());
        digest.finalize().into()
    }

    fn lock(&self) -> Result<MutexGuard<'_, Connection>> {
        self.connection
            .lock()
            .map_err(|_| QueryContributionError::Storage)
    }
}

impl Drop for QueryContributionStore {
    fn drop(&mut self) {
        self.privacy_salt.zeroize();
    }
}

pub fn contains_sensitive_query_data(value: &str) -> bool {
    let lower = value.to_lowercase();
    if ["http://", "https://", "www.", ".onion", "mailto:"]
        .iter()
        .any(|marker| lower.contains(marker))
        || value.contains('@')
    {
        return true;
    }
    let words = value.split_whitespace().collect::<Vec<_>>();
    if (12..=25).contains(&words.len())
        && words.iter().all(|word| {
            let cleaned = trim_token(word);
            (2..=20).contains(&cleaned.len()) && cleaned.chars().all(char::is_alphabetic)
        })
    {
        return true;
    }
    words.into_iter().any(|word| {
        let token = trim_token(word);
        token.len() > 64
            || (token.len() == 64 && token.bytes().all(|byte| byte.is_ascii_hexdigit()))
            || ((90..=110).contains(&token.len())
                && token.bytes().all(|byte| {
                    b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz".contains(&byte)
                }))
            || phone_like(token)
    })
}

fn trim_token(value: &str) -> &str {
    value.trim_matches(|character: char| {
        matches!(
            character,
            ',' | '.' | ';' | ':' | '!' | '?' | '(' | ')' | '[' | ']' | '{' | '}' | '"' | '\''
        )
    })
}

fn phone_like(value: &str) -> bool {
    let digits = value.bytes().filter(u8::is_ascii_digit).count();
    digits >= 7
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'+' | b'-' | b'(' | b')' | b'.'))
}

fn prune_locked(
    connection: &Connection,
    now_ms: u64,
    minimum_independent_contributors: u32,
) -> Result<()> {
    let receipt_cutoff = now_ms.saturating_sub(SUBMISSION_RECEIPT_RETENTION_MS);
    let rare_cutoff = now_ms.saturating_sub(RARE_TERM_RETENTION_MS);
    connection
        .execute(
            "DELETE FROM query_submission WHERE created_at_ms < ?1",
            [to_sql_i64(receipt_cutoff)?],
        )
        .map_err(|_| QueryContributionError::Storage)?;
    connection
        .execute(
            "DELETE FROM query_term
             WHERE moderation_status = 'pending'
               AND independent_contributors < ?1
               AND last_seen_at_ms < ?2",
            params![minimum_independent_contributors, to_sql_i64(rare_cutoff)?],
        )
        .map_err(|_| QueryContributionError::Storage)?;
    Ok(())
}

fn query_id(text: &str, language: &str, model_id: &str, prompt: &str) -> String {
    let mut digest = Sha256::new();
    digest.update(b"tex8-community-query-id-v1");
    for value in [text, language, model_id, prompt] {
        digest.update([0]);
        digest.update(value.as_bytes());
    }
    format!("query_{}", hex::encode(digest.finalize()))
}

fn popularity_weight(independent_contributors: u64) -> f32 {
    ((independent_contributors as f32) / 100.0)
        .sqrt()
        .clamp(0.05, 1.0)
}

fn validate_embedding(embedding: &[f32]) -> Result<()> {
    if embedding.len() != V1_EMBEDDING_DIMENSION || embedding.iter().any(|value| !value.is_finite())
    {
        return invalid("query embedding is invalid");
    }
    let norm = embedding
        .iter()
        .map(|value| f64::from(*value) * f64::from(*value))
        .sum::<f64>()
        .sqrt();
    if !(0.999..=1.001).contains(&norm) {
        return invalid("query embedding must be L2-normalized");
    }
    Ok(())
}

fn validate_language(value: &str) -> Result<()> {
    if !(2..=16).contains(&value.len())
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        return invalid("query language is invalid");
    }
    Ok(())
}

fn validate_identifier(label: &str, value: &str, maximum: usize) -> Result<()> {
    if value.is_empty()
        || value.len() > maximum
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return invalid(&format!("{label} is invalid"));
    }
    Ok(())
}

fn validate_text(label: &str, value: &str, minimum: usize, maximum: usize) -> Result<()> {
    if !(minimum..=maximum).contains(&value.chars().count())
        || value
            .chars()
            .any(|character| character == '\0' || character.is_control())
    {
        return invalid(&format!("{label} is invalid"));
    }
    Ok(())
}

fn exists(connection: &Connection, query_id: &str) -> Result<bool> {
    connection
        .query_row(
            "SELECT 1 FROM query_term WHERE query_id = ?1",
            [query_id],
            |_| Ok(()),
        )
        .optional()
        .map(|value| value.is_some())
        .map_err(|_| QueryContributionError::Storage)
}

fn to_sql_i64(value: u64) -> Result<i64> {
    i64::try_from(value)
        .map_err(|_| QueryContributionError::Invalid("timestamp is invalid".to_owned()))
}

fn row_u64(row: &Row<'_>, index: usize) -> rusqlite::Result<u64> {
    let value = row.get::<_, i64>(index)?;
    u64::try_from(value).map_err(|_| rusqlite::Error::IntegralValueOutOfRange(index, value))
}

fn invalid<T>(message: &str) -> Result<T> {
    Err(QueryContributionError::Invalid(message.to_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: u64 = 2_000_000_000_000;

    fn input(submission: &str, query: &str) -> QueryContributionInput {
        let model = ModelContract::harrier_v1();
        QueryContributionInput {
            submission_id: submission.to_owned(),
            query: query.to_owned(),
            language: "de".to_owned(),
            model_id: model.id,
            query_prompt_version: model.query_prompt_version,
        }
    }

    fn vector() -> Vec<f32> {
        let mut value = vec![0.0; V1_EMBEDDING_DIMENSION];
        value[0] = 1.0;
        value
    }

    #[test]
    fn private_identifiers_are_rejected_before_storage() {
        let store = QueryContributionStore::in_memory([7; 32], 3).expect("contribution store");
        for (index, query) in [
            "mail me at person@example.com",
            "transaction aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "call +49123456789",
            "48A1cDefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQ",
            "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima",
        ]
        .iter()
        .enumerate()
        {
            assert!(store
                .contribute(
                    "person_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                    &input(&format!("submission-{index}"), query),
                    NOW,
                )
                .is_err());
        }
        assert!(store.review_candidates(10, NOW).unwrap().is_empty());
    }

    #[test]
    fn independent_threshold_moderation_and_catalog_delta_are_enforced() {
        let store = QueryContributionStore::in_memory([8; 32], 3).expect("contribution store");
        for index in 0..3 {
            let receipt = store
                .contribute(
                    &format!("person_{index:032x}"),
                    &input(&format!("submission-{index}"), "privacy friendly shopping"),
                    NOW + index,
                )
                .unwrap();
            assert_eq!(receipt.eligible_for_review, index == 2);
        }
        let candidates = store.review_candidates(10, NOW + 10).unwrap();
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].independent_contributors, 3);
        store
            .moderate(
                &candidates[0].query_id,
                "moderator-one",
                "Reviewed common product-search phrase.",
                QueryModerationDecision::Approve,
                Some(&vector()),
                NOW + 20,
            )
            .unwrap();
        let payload = store.catalog_delta("pa-queries-v1", 1, 2, 100).unwrap();
        let QueryCatalogPayload::Delta(delta) = payload else {
            panic!("expected delta");
        };
        assert_eq!(delta.upserts.len(), 1);
        assert_eq!(
            delta.upserts[0].normalized_text,
            "privacy friendly shopping"
        );
        store
            .acknowledge_published(&[delta.upserts[0].query_id.clone()], 2, NOW + 30)
            .unwrap();
        let payload = store.catalog_delta("pa-queries-v1", 2, 3, 100).unwrap();
        let QueryCatalogPayload::Delta(delta) = payload else {
            panic!("expected delta");
        };
        assert!(delta.upserts.is_empty());

        store
            .contribute(
                "person_ffffffffffffffffffffffffffffffff",
                &input("submission-after-publication", "privacy friendly shopping"),
                NOW + 40,
            )
            .unwrap();
        let payload = store.catalog_delta("pa-queries-v1", 2, 3, 100).unwrap();
        let QueryCatalogPayload::Delta(delta) = payload else {
            panic!("expected popularity update delta");
        };
        assert_eq!(delta.upserts.len(), 1);
        assert_eq!(delta.upserts[0].revision, 2);
    }

    #[test]
    fn one_identity_cannot_fake_independent_popularity_and_retry_is_idempotent() {
        let store = QueryContributionStore::in_memory([9; 32], 3).expect("contribution store");
        let first = input("submission-one", "open source shop");
        assert!(
            !store
                .contribute("person_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", &first, NOW)
                .unwrap()
                .duplicate
        );
        assert!(
            store
                .contribute("person_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", &first, NOW + 1)
                .unwrap()
                .duplicate
        );
        store
            .contribute(
                "person_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                &input("submission-two", "open source shop"),
                NOW + 2,
            )
            .unwrap();
        assert!(store.review_candidates(10, NOW + 3).unwrap().is_empty());
    }
}
