use crate::{
    model::{validate_embedding, validate_identifier, LocalQueryEmbedding, ModelContract},
    normalize_query_text_v1, CommunitySearchError, QuerySuggestion, Result,
};
use chacha20poly1305::{
    aead::{Aead, Payload},
    Key, KeyInit, XChaCha20Poly1305, XNonce,
};
use rand::{rngs::OsRng, RngCore};
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    cmp::Reverse,
    fs,
    path::{Path, PathBuf},
};
use zeroize::{Zeroize, Zeroizing};

pub const DEFAULT_LOCAL_QUERY_CACHE_CAPACITY: usize = 512;
pub const MAX_LOCAL_QUERY_CACHE_CAPACITY: usize = 4_096;
pub const LOCAL_QUERY_LOW_USE_MAX_AGE_MS: u64 = 180 * 24 * 60 * 60 * 1_000;

const DATABASE_FILE: &str = "local-queries.sqlite3";
const CACHE_SCHEMA_VERSION: i64 = 3;
const RECORD_ID_BYTES: usize = 16;
const NONCE_BYTES: usize = 24;
const CACHE_KEY_BYTES: usize = 32;
const MAX_USE_COUNT: u64 = 1_000_000_000;
const LOW_USE_THRESHOLD: u64 = 2;
const METADATA_AAD_PREFIX: &[u8] = b"tex8-local-query-cache-metadata-v3:";
const EMBEDDING_AAD_PREFIX: &[u8] = b"tex8-local-query-cache-embedding-v3:";

/// A bounded, encrypted, device-local cache of queries the user actually ran.
///
/// The signed downloaded Common-Query catalog remains a separate immutable
/// generation. This cache never changes or weakens that trust boundary.
pub struct LocalQueryCache {
    database_path: PathBuf,
    capacity: usize,
    key: Zeroizing<[u8; CACHE_KEY_BYTES]>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct LocalQueryCacheStatus {
    pub entries: usize,
    pub capacity: usize,
}

#[derive(Clone, Debug, PartialEq)]
pub struct LocalQuerySuggestion {
    pub query_id: String,
    pub normalized_text: String,
    pub display_text: String,
    pub language: String,
    pub weight: f32,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct LocalQueryMetadata {
    normalized_text: String,
    display_text: String,
    language: String,
    model: ModelContract,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct LocalQueryEmbeddingSecret {
    embedding: Vec<f32>,
}

#[derive(Debug)]
struct DecryptedRow {
    record_id: Vec<u8>,
    use_count: u64,
    last_used_ms: u64,
    metadata: LocalQueryMetadata,
}

impl Drop for LocalQueryMetadata {
    fn drop(&mut self) {
        self.normalized_text.zeroize();
        self.display_text.zeroize();
        self.language.zeroize();
        self.model.id.zeroize();
        self.model.weights_sha256.zeroize();
        self.model.tokenizer_sha256.zeroize();
        self.model.document_prompt_version.zeroize();
        self.model.query_prompt_version.zeroize();
        self.model.pooling.zeroize();
        self.model.normalization.zeroize();
        self.model.quantization.zeroize();
    }
}

impl Drop for LocalQueryEmbeddingSecret {
    fn drop(&mut self) {
        self.embedding.zeroize();
    }
}

impl LocalQueryCache {
    pub fn open(
        root: impl AsRef<Path>,
        key: [u8; CACHE_KEY_BYTES],
        capacity: usize,
    ) -> Result<Self> {
        if !(1..=MAX_LOCAL_QUERY_CACHE_CAPACITY).contains(&capacity) {
            return invalid("local query cache capacity is invalid");
        }
        let root = root.as_ref();
        fs::create_dir_all(root)
            .map_err(|error| storage("create local query cache directory", error))?;
        protect_directory(root)?;
        let database_path = root.join(DATABASE_FILE);
        let connection = Connection::open(&database_path)
            .map_err(|error| storage("open local query cache database", error))?;
        initialize_database(&connection)?;
        drop(connection);
        protect_file(&database_path)?;
        Ok(Self {
            database_path,
            capacity,
            key: Zeroizing::new(key),
        })
    }

    pub fn record(
        &self,
        display_text: &str,
        language: &str,
        query: &LocalQueryEmbedding,
        now_ms: u64,
    ) -> Result<()> {
        if now_ms == 0 {
            return invalid("local query cache timestamp is required");
        }
        let normalized_text = normalize_query_text_v1(display_text)?;
        let display_text = canonical_display_text(display_text)?;
        validate_identifier("local query language", language, 16)?;
        validate_embedding(&query.embedding, query.model.dimension)?;
        let now = to_sql_i64(now_ms, "local query timestamp")?;
        let mut connection = self.connection()?;
        let transaction = connection
            .transaction()
            .map_err(|error| storage("begin local query cache transaction", error))?;
        let existing =
            self.find_exact_in_transaction(&transaction, &normalized_text, language, &query.model)?;
        let metadata = LocalQueryMetadata {
            normalized_text,
            display_text,
            language: language.to_owned(),
            model: query.model.clone(),
        };
        let embedding = LocalQueryEmbeddingSecret {
            embedding: query.embedding.clone(),
        };
        let protected_record_id = match existing {
            Some(existing) => {
                let use_count = existing.use_count.saturating_add(1).min(MAX_USE_COUNT);
                let (metadata_nonce, metadata_ciphertext) =
                    self.encrypt(&existing.record_id, METADATA_AAD_PREFIX, &metadata)?;
                let (embedding_nonce, embedding_ciphertext) =
                    self.encrypt(&existing.record_id, EMBEDDING_AAD_PREFIX, &embedding)?;
                transaction
                    .execute(
                        "UPDATE local_query
                         SET metadata_nonce = ?2, metadata_ciphertext = ?3,
                             embedding_nonce = ?4, embedding_ciphertext = ?5,
                             use_count = ?6, last_used_ms = ?7
                         WHERE record_id = ?1",
                        params![
                            existing.record_id,
                            metadata_nonce,
                            metadata_ciphertext,
                            embedding_nonce,
                            embedding_ciphertext,
                            to_sql_i64(use_count, "local query use count")?,
                            now
                        ],
                    )
                    .map_err(|error| storage("update local query cache entry", error))?;
                existing.record_id
            }
            None => {
                let mut record_id = vec![0_u8; RECORD_ID_BYTES];
                OsRng.fill_bytes(&mut record_id);
                let (metadata_nonce, metadata_ciphertext) =
                    self.encrypt(&record_id, METADATA_AAD_PREFIX, &metadata)?;
                let (embedding_nonce, embedding_ciphertext) =
                    self.encrypt(&record_id, EMBEDDING_AAD_PREFIX, &embedding)?;
                transaction
                    .execute(
                        "INSERT INTO local_query(
                           record_id, metadata_nonce, metadata_ciphertext,
                           embedding_nonce, embedding_ciphertext, use_count,
                           first_used_ms, last_used_ms
                         ) VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6, ?6)",
                        params![
                            record_id,
                            metadata_nonce,
                            metadata_ciphertext,
                            embedding_nonce,
                            embedding_ciphertext,
                            now
                        ],
                    )
                    .map_err(|error| storage("insert local query cache entry", error))?;
                record_id
            }
        };
        self.prune_transaction(&transaction, now_ms, Some(&protected_record_id))?;
        transaction
            .commit()
            .map_err(|error| storage("commit local query cache transaction", error))
    }

    /// Removes expired low-use entries and enforces the fixed capacity.
    ///
    /// The runtime calls this before reads as well as after writes, so a cache
    /// that remains open for months cannot keep presenting stale suggestions.
    pub fn prune(&self, now_ms: u64) -> Result<()> {
        if now_ms == 0 {
            return invalid("local query cache timestamp is required");
        }
        let mut connection = self.connection()?;
        let transaction = connection
            .transaction()
            .map_err(|error| storage("begin local query cache prune", error))?;
        self.prune_transaction(&transaction, now_ms, None)?;
        transaction
            .commit()
            .map_err(|error| storage("commit local query cache prune", error))
    }

    pub fn lookup(
        &self,
        text: &str,
        language: &str,
        model: &ModelContract,
    ) -> Result<Option<QuerySuggestion>> {
        let normalized = normalize_query_text_v1(text)?;
        validate_identifier("local query language", language, 16)?;
        let connection = self.connection()?;
        self.read_rows(&connection)?
            .into_iter()
            .find(|row| {
                row.metadata.normalized_text == normalized
                    && row.metadata.language == language
                    && &row.metadata.model == model
            })
            .map(|row| {
                let embedding =
                    self.read_embedding(&connection, &row.record_id, &row.metadata.model)?;
                row.query_suggestion(embedding)
            })
            .transpose()
    }

    pub fn suggest(
        &self,
        prefix: &str,
        language: &str,
        model: &ModelContract,
        limit: usize,
    ) -> Result<Vec<LocalQuerySuggestion>> {
        if limit == 0 {
            return Ok(Vec::new());
        }
        let normalized = normalize_query_text_v1(prefix)?;
        validate_identifier("local query language", language, 16)?;
        let connection = self.connection()?;
        let mut rows = self
            .read_rows(&connection)?
            .into_iter()
            .filter(|row| {
                row.metadata.language == language
                    && &row.metadata.model == model
                    && row.metadata.normalized_text.starts_with(&normalized)
            })
            .collect::<Vec<_>>();
        rows.sort_by(|left, right| {
            Reverse(left.use_count)
                .cmp(&Reverse(right.use_count))
                .then_with(|| Reverse(left.last_used_ms).cmp(&Reverse(right.last_used_ms)))
                .then_with(|| {
                    left.metadata
                        .normalized_text
                        .cmp(&right.metadata.normalized_text)
                })
        });
        Ok(rows
            .into_iter()
            .take(limit.min(20))
            .map(DecryptedRow::local_suggestion)
            .collect::<Vec<_>>())
    }

    pub fn status(&self) -> Result<LocalQueryCacheStatus> {
        let connection = self.connection()?;
        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM local_query", [], |row| row.get(0))
            .map_err(|error| storage("count local query cache entries", error))?;
        let entries = usize::try_from(count)
            .map_err(|_| CommunitySearchError::Storage("invalid local query count".to_owned()))?;
        Ok(LocalQueryCacheStatus {
            entries,
            capacity: self.capacity,
        })
    }

    pub fn clear(&self) -> Result<()> {
        let connection = self.connection()?;
        connection
            .execute("DELETE FROM local_query", [])
            .map_err(|error| storage("clear local query cache", error))?;
        connection
            .execute_batch("PRAGMA wal_checkpoint(TRUNCATE); VACUUM;")
            .map_err(|error| storage("compact cleared local query cache", error))
    }

    fn connection(&self) -> Result<Connection> {
        let connection = Connection::open(&self.database_path)
            .map_err(|error| storage("open local query cache database", error))?;
        configure_database(&connection)?;
        Ok(connection)
    }

    fn find_exact_in_transaction(
        &self,
        transaction: &Transaction<'_>,
        normalized_text: &str,
        language: &str,
        model: &ModelContract,
    ) -> Result<Option<DecryptedRow>> {
        Ok(self.read_rows(transaction)?.into_iter().find(|row| {
            row.metadata.normalized_text == normalized_text
                && row.metadata.language == language
                && &row.metadata.model == model
        }))
    }

    fn read_rows(&self, connection: &Connection) -> Result<Vec<DecryptedRow>> {
        let mut statement = connection
            .prepare(
                "SELECT record_id, metadata_nonce, metadata_ciphertext,
                        use_count, first_used_ms, last_used_ms
                 FROM local_query",
            )
            .map_err(|error| storage("prepare local query cache read", error))?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, Vec<u8>>(0)?,
                    row.get::<_, Vec<u8>>(1)?,
                    row.get::<_, Vec<u8>>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, i64>(5)?,
                ))
            })
            .map_err(|error| storage("read local query cache rows", error))?;
        let mut decrypted = Vec::new();
        for row in rows {
            let (
                record_id,
                metadata_nonce,
                metadata_ciphertext,
                use_count,
                first_used_ms,
                last_used_ms,
            ) = row.map_err(|error| storage("read local query cache row", error))?;
            if record_id.len() != RECORD_ID_BYTES
                || metadata_nonce.len() != NONCE_BYTES
                || use_count <= 0
                || first_used_ms <= 0
                || last_used_ms < first_used_ms
            {
                return invalid("local query cache row is invalid");
            }
            let metadata =
                self.decrypt_metadata(&record_id, &metadata_nonce, &metadata_ciphertext)?;
            decrypted.push(DecryptedRow {
                record_id,
                use_count: u64::try_from(use_count)
                    .map_err(|_| CommunitySearchError::Storage("invalid use count".to_owned()))?,
                last_used_ms: u64::try_from(last_used_ms).map_err(|_| {
                    CommunitySearchError::Storage("invalid last-used time".to_owned())
                })?,
                metadata,
            });
        }
        Ok(decrypted)
    }

    fn read_embedding(
        &self,
        connection: &Connection,
        record_id: &[u8],
        model: &ModelContract,
    ) -> Result<Vec<f32>> {
        let (nonce, ciphertext): (Vec<u8>, Vec<u8>) = connection
            .query_row(
                "SELECT embedding_nonce, embedding_ciphertext
                 FROM local_query WHERE record_id = ?1",
                params![record_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(|error| storage("read exact local query embedding", error))?;
        if nonce.len() != NONCE_BYTES {
            return invalid("local query cache embedding nonce is invalid");
        }
        self.decrypt_embedding(record_id, &nonce, &ciphertext, model)
    }

    fn prune_transaction(
        &self,
        transaction: &Transaction<'_>,
        now_ms: u64,
        protected_record_id: Option<&[u8]>,
    ) -> Result<()> {
        let stale_before = now_ms.saturating_sub(LOCAL_QUERY_LOW_USE_MAX_AGE_MS);
        if stale_before > 0 {
            transaction
                .execute(
                    "DELETE FROM local_query
                     WHERE use_count <= ?1 AND last_used_ms < ?2",
                    params![
                        to_sql_i64(LOW_USE_THRESHOLD, "low-use threshold")?,
                        to_sql_i64(stale_before, "local query stale cutoff")?
                    ],
                )
                .map_err(|error| storage("prune stale local queries", error))?;
        }
        let count: i64 = transaction
            .query_row("SELECT COUNT(*) FROM local_query", [], |row| row.get(0))
            .map_err(|error| storage("count local queries before eviction", error))?;
        let count = usize::try_from(count)
            .map_err(|_| CommunitySearchError::Storage("invalid local query count".to_owned()))?;
        let excess = count.saturating_sub(self.capacity);
        if excess > 0 {
            let excess = i64::try_from(excess).map_err(|_| {
                CommunitySearchError::Storage("invalid local query excess".to_owned())
            })?;
            match protected_record_id {
                Some(record_id) => transaction
                    .execute(
                        "DELETE FROM local_query
                         WHERE record_id IN (
                           SELECT record_id FROM local_query
                           WHERE record_id <> ?2
                           ORDER BY use_count ASC, last_used_ms ASC,
                                    first_used_ms ASC, record_id ASC
                           LIMIT ?1
                         )",
                        params![excess, record_id],
                    )
                    .map_err(|error| storage("evict local query cache entries", error))?,
                None => transaction
                    .execute(
                        "DELETE FROM local_query
                         WHERE record_id IN (
                           SELECT record_id FROM local_query
                           ORDER BY use_count ASC, last_used_ms ASC,
                                    first_used_ms ASC, record_id ASC
                           LIMIT ?1
                         )",
                        params![excess],
                    )
                    .map_err(|error| storage("evict local query cache entries", error))?,
            };
        }
        Ok(())
    }

    fn encrypt<T: Serialize>(
        &self,
        record_id: &[u8],
        aad_prefix: &[u8],
        secret: &T,
    ) -> Result<(Vec<u8>, Vec<u8>)> {
        let mut nonce = vec![0_u8; NONCE_BYTES];
        OsRng.fill_bytes(&mut nonce);
        let plaintext = Zeroizing::new(serde_json::to_vec(secret).map_err(json_invalid)?);
        let ciphertext = self
            .cipher()
            .encrypt(
                XNonce::from_slice(&nonce),
                Payload {
                    msg: plaintext.as_slice(),
                    aad: &aad(aad_prefix, record_id),
                },
            )
            .map_err(|_| CommunitySearchError::Storage("encrypt local query cache".to_owned()))?;
        Ok((nonce, ciphertext))
    }

    fn decrypt_metadata(
        &self,
        record_id: &[u8],
        nonce: &[u8],
        ciphertext: &[u8],
    ) -> Result<LocalQueryMetadata> {
        let plaintext = Zeroizing::new(
            self.cipher()
                .decrypt(
                    XNonce::from_slice(nonce),
                    Payload {
                        msg: ciphertext,
                        aad: &aad(METADATA_AAD_PREFIX, record_id),
                    },
                )
                .map_err(|_| {
                    CommunitySearchError::Storage(
                        "local query cache authentication failed".to_owned(),
                    )
                })?,
        );
        let metadata: LocalQueryMetadata =
            serde_json::from_slice(plaintext.as_slice()).map_err(json_invalid)?;
        validate_metadata(&metadata)?;
        Ok(metadata)
    }

    fn decrypt_embedding(
        &self,
        record_id: &[u8],
        nonce: &[u8],
        ciphertext: &[u8],
        model: &ModelContract,
    ) -> Result<Vec<f32>> {
        let plaintext = Zeroizing::new(
            self.cipher()
                .decrypt(
                    XNonce::from_slice(nonce),
                    Payload {
                        msg: ciphertext,
                        aad: &aad(EMBEDDING_AAD_PREFIX, record_id),
                    },
                )
                .map_err(|_| {
                    CommunitySearchError::Storage(
                        "local query cache authentication failed".to_owned(),
                    )
                })?,
        );
        let mut secret: LocalQueryEmbeddingSecret =
            serde_json::from_slice(plaintext.as_slice()).map_err(json_invalid)?;
        validate_embedding(&secret.embedding, model.dimension)?;
        Ok(std::mem::take(&mut secret.embedding))
    }

    fn cipher(&self) -> XChaCha20Poly1305 {
        XChaCha20Poly1305::new(Key::from_slice(self.key.as_slice()))
    }
}

impl DecryptedRow {
    fn local_suggestion(self) -> LocalQuerySuggestion {
        LocalQuerySuggestion {
            query_id: local_query_id(&self.metadata.language, &self.metadata.normalized_text),
            normalized_text: self.metadata.normalized_text.clone(),
            display_text: self.metadata.display_text.clone(),
            language: self.metadata.language.clone(),
            weight: local_weight(self.use_count),
        }
    }

    fn query_suggestion(self, embedding: Vec<f32>) -> Result<QuerySuggestion> {
        validate_embedding(&embedding, self.metadata.model.dimension)?;
        Ok(QuerySuggestion {
            query_id: local_query_id(&self.metadata.language, &self.metadata.normalized_text),
            normalized_text: self.metadata.normalized_text.clone(),
            display_text: self.metadata.display_text.clone(),
            language: self.metadata.language.clone(),
            weight: local_weight(self.use_count),
            query: LocalQueryEmbedding {
                model: self.metadata.model.clone(),
                embedding,
            },
        })
    }
}

fn local_query_id(language: &str, normalized_text: &str) -> String {
    let mut digest = Sha256::new();
    digest.update(b"tex8-local-query-id-v1:");
    digest.update(language.as_bytes());
    digest.update([0]);
    digest.update(normalized_text.as_bytes());
    format!("local:{}", hex::encode(&digest.finalize()[..16]))
}

fn initialize_database(connection: &Connection) -> Result<()> {
    connection
        .execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = FULL;
             PRAGMA foreign_keys = ON;
             PRAGMA trusted_schema = OFF;
             PRAGMA secure_delete = ON;
             CREATE TABLE IF NOT EXISTS local_query_meta (
               singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
               schema_version INTEGER NOT NULL CHECK(schema_version > 0)
             ) STRICT;",
        )
        .map_err(|error| storage("initialize local query cache database", error))?;
    let schema: Option<i64> = connection
        .query_row(
            "SELECT schema_version FROM local_query_meta WHERE singleton = 1",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| storage("read local query cache schema", error))?;
    let migrated = match schema {
        None => {
            connection
                .execute(
                    "INSERT INTO local_query_meta(singleton, schema_version)
                     VALUES (1, ?1)",
                    params![CACHE_SCHEMA_VERSION],
                )
                .map_err(|error| storage("create local query cache schema", error))?;
            false
        }
        Some(1) | Some(2) => {
            // V1 stored metadata and vectors together. V2 used the biased
            // community-query-v1 prompt. Query embeddings are disposable, so
            // both legacy schemas are securely cleared instead of carrying
            // stale vectors into the community-query-v2 contract.
            connection
                .execute_batch(
                    "BEGIN IMMEDIATE;
                     DROP TABLE IF EXISTS local_query;
                     UPDATE local_query_meta SET schema_version = 3
                     WHERE singleton = 1;
                     COMMIT;",
                )
                .map_err(|error| storage("migrate local query cache schema", error))?;
            true
        }
        Some(CACHE_SCHEMA_VERSION) => false,
        Some(_) => return invalid("unsupported local query cache schema"),
    };
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS local_query (
               record_id BLOB PRIMARY KEY NOT NULL CHECK(length(record_id) = 16),
               metadata_nonce BLOB NOT NULL CHECK(length(metadata_nonce) = 24),
               metadata_ciphertext BLOB NOT NULL CHECK(length(metadata_ciphertext) > 16),
               embedding_nonce BLOB NOT NULL CHECK(length(embedding_nonce) = 24),
               embedding_ciphertext BLOB NOT NULL CHECK(length(embedding_ciphertext) > 16),
               use_count INTEGER NOT NULL CHECK(use_count > 0 AND use_count <= 1000000000),
               first_used_ms INTEGER NOT NULL CHECK(first_used_ms > 0),
               last_used_ms INTEGER NOT NULL CHECK(last_used_ms >= first_used_ms)
             ) STRICT;
             CREATE INDEX IF NOT EXISTS local_query_eviction
               ON local_query(use_count, last_used_ms, first_used_ms);",
        )
        .map_err(|error| storage("create local query cache tables", error))?;
    if migrated {
        connection
            .execute_batch("PRAGMA wal_checkpoint(TRUNCATE); VACUUM;")
            .map_err(|error| storage("compact migrated local query cache", error))?;
    }
    Ok(())
}

fn configure_database(connection: &Connection) -> Result<()> {
    connection
        .execute_batch(
            "PRAGMA foreign_keys = ON;
             PRAGMA trusted_schema = OFF;
             PRAGMA secure_delete = ON;
             PRAGMA busy_timeout = 5000;",
        )
        .map_err(|error| storage("configure local query cache database", error))
}

fn validate_metadata(metadata: &LocalQueryMetadata) -> Result<()> {
    if metadata.normalized_text != normalize_query_text_v1(&metadata.display_text)? {
        return invalid("local query cache normalization is invalid");
    }
    validate_identifier("local query language", &metadata.language, 16)?;
    metadata.model.validate_v1()
}

fn canonical_display_text(value: &str) -> Result<String> {
    if value
        .chars()
        .any(|character| character.is_control() && !character.is_whitespace())
    {
        return invalid("local query text cannot contain control characters");
    }
    let display = value.split_whitespace().collect::<Vec<_>>().join(" ");
    let count = display.chars().count();
    if !(1..=160).contains(&count) {
        return invalid("local query display text must contain 1 to 160 characters");
    }
    Ok(display)
}

fn local_weight(use_count: u64) -> f32 {
    let steps = (64 - use_count.max(1).leading_zeros() as u64).saturating_sub(1);
    (0.55 + (steps.min(9) as f32 * 0.05)).min(1.0)
}

fn aad(prefix: &[u8], record_id: &[u8]) -> Vec<u8> {
    let mut value = Vec::with_capacity(prefix.len() + record_id.len());
    value.extend_from_slice(prefix);
    value.extend_from_slice(record_id);
    value
}

#[cfg(unix)]
fn protect_directory(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
        .map_err(|error| storage("protect local query cache directory", error))
}

#[cfg(not(unix))]
fn protect_directory(_path: &Path) -> Result<()> {
    Ok(())
}

#[cfg(unix)]
fn protect_file(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .map_err(|error| storage("protect local query cache database", error))
}

#[cfg(not(unix))]
fn protect_file(_path: &Path) -> Result<()> {
    Ok(())
}

fn to_sql_i64(value: u64, label: &str) -> Result<i64> {
    i64::try_from(value).map_err(|_| {
        CommunitySearchError::InvalidCatalog(format!("{label} exceeds the supported range"))
    })
}

fn storage(action: &str, error: impl std::fmt::Display) -> CommunitySearchError {
    CommunitySearchError::Storage(format!("{action}: {error}"))
}

fn json_invalid(error: impl std::fmt::Display) -> CommunitySearchError {
    CommunitySearchError::InvalidCatalog(error.to_string())
}

fn invalid<T>(message: impl Into<String>) -> Result<T> {
    Err(CommunitySearchError::InvalidCatalog(message.into()))
}
