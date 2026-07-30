use crate::{
    catalog_signer_key_id,
    manifest::{CatalogManifest, CatalogManifestUnsigned},
    model::{
        validate_embedding, validate_identifier, validate_text, LocalQueryEmbedding, ModelContract,
    },
    CommunitySearchError, Result, CATALOG_SCHEMA_VERSION, MAX_CATALOG_BYTES,
    MAX_QUERY_CATALOG_ITEMS,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use ed25519_dalek::{Signer, SigningKey, VerifyingKey};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    fs::{self, File},
    path::{Path, PathBuf},
};
use unicode_normalization::UnicodeNormalization;

pub const QUERY_NORMALIZATION_VERSION: &str = "unicode-nfkc-lower-ws-v1";
const DATABASE_FILE: &str = "queries.sqlite3";
const MANIFEST_FILE: &str = "manifest.json";

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct QueryCatalogEntry {
    pub query_id: String,
    pub revision: u64,
    pub normalized_text: String,
    pub display_text: String,
    pub language: String,
    pub weight: f32,
    pub model: ModelContract,
    pub embedding: Vec<f32>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct QueryCatalogTombstone {
    pub normalized_text: String,
    pub language: String,
    pub revision: u64,
    pub deleted_at_ms: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct QueryCatalogSnapshot {
    pub schema_version: u16,
    pub catalog_scope_id: String,
    pub sequence: u64,
    pub normalization_version: String,
    pub model: ModelContract,
    pub entries: Vec<QueryCatalogEntry>,
    #[serde(default)]
    pub tombstones: Vec<QueryCatalogTombstone>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct QueryCatalogDelta {
    pub schema_version: u16,
    pub catalog_scope_id: String,
    pub from_sequence: u64,
    pub to_sequence: u64,
    pub normalization_version: String,
    pub model: ModelContract,
    #[serde(default)]
    pub upserts: Vec<QueryCatalogEntry>,
    #[serde(default)]
    pub tombstones: Vec<QueryCatalogTombstone>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "payloadType", rename_all = "snake_case")]
pub enum QueryCatalogPayload {
    Snapshot(QueryCatalogSnapshot),
    Delta(QueryCatalogDelta),
}

#[derive(Clone, Debug)]
pub struct SignedQueryCatalogPackage {
    pub manifest_json: Vec<u8>,
    pub payload_json: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct QuerySuggestion {
    pub query_id: String,
    pub normalized_text: String,
    pub display_text: String,
    pub language: String,
    pub weight: f32,
    pub query: LocalQueryEmbedding,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct QueryActivationMarker {
    sequence: u64,
    catalog_scope_id: String,
    manifest_sha256: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct ActiveQueryGeneration {
    sequence: u64,
    model: ModelContract,
}

pub struct CommonQueryCore {
    root: PathBuf,
    expected_scope: String,
    verifying_key: VerifyingKey,
}

impl QueryCatalogEntry {
    fn validate(&self, model: &ModelContract) -> Result<()> {
        validate_identifier("query id", &self.query_id, 128)?;
        if self.revision == 0 {
            return invalid("query catalog revisions start at 1");
        }
        to_sql_i64(self.revision, "query revision")?;
        validate_text("query display text", &self.display_text, 1, 160)?;
        validate_identifier("query language", &self.language, 16)?;
        if self.normalized_text != normalize_query_text_v1(&self.display_text)? {
            return invalid("query normalized text does not match normalization v1");
        }
        if !self.weight.is_finite() || !(0.0..=1.0).contains(&self.weight) {
            return invalid("query catalog weight must be finite and between zero and one");
        }
        if &self.model != model {
            return Err(CommunitySearchError::ModelMismatch);
        }
        validate_embedding(&self.embedding, model.dimension)
    }

    fn suggestion(self) -> QuerySuggestion {
        QuerySuggestion {
            query_id: self.query_id,
            normalized_text: self.normalized_text,
            display_text: self.display_text,
            language: self.language,
            weight: self.weight,
            query: LocalQueryEmbedding {
                model: self.model,
                embedding: self.embedding,
            },
        }
    }
}

impl QueryCatalogTombstone {
    fn validate(&self) -> Result<()> {
        if self.normalized_text != normalize_query_text_v1(&self.normalized_text)? {
            return invalid("query tombstone text is not normalized with normalization v1");
        }
        validate_identifier("query tombstone language", &self.language, 16)?;
        if self.revision == 0 || self.deleted_at_ms == 0 {
            return invalid("query tombstone revision and deletion time are required");
        }
        to_sql_i64(self.revision, "query tombstone revision")?;
        to_sql_i64(self.deleted_at_ms, "query tombstone deletion time")?;
        Ok(())
    }
}

impl QueryCatalogPayload {
    pub fn validate_for_publication(&self) -> Result<()> {
        self.validate_shape()
    }

    fn validate_shape(&self) -> Result<()> {
        let (schema, scope, normalization, model, entries, tombstones) = match self {
            Self::Snapshot(value) => (
                value.schema_version,
                value.catalog_scope_id.as_str(),
                value.normalization_version.as_str(),
                &value.model,
                value.entries.as_slice(),
                value.tombstones.as_slice(),
            ),
            Self::Delta(value) => (
                value.schema_version,
                value.catalog_scope_id.as_str(),
                value.normalization_version.as_str(),
                &value.model,
                value.upserts.as_slice(),
                value.tombstones.as_slice(),
            ),
        };
        if schema != CATALOG_SCHEMA_VERSION {
            return invalid("unsupported query catalog schema");
        }
        validate_identifier("query catalog scope", scope, 128)?;
        if normalization != QUERY_NORMALIZATION_VERSION {
            return invalid("unsupported query normalization version");
        }
        model.validate_v1()?;
        to_sql_i64(self.sequence(), "query catalog sequence")?;
        if let Some(previous) = self.previous_sequence() {
            to_sql_i64(previous, "query catalog previous sequence")?;
        }
        if entries.len().saturating_add(tombstones.len()) > MAX_QUERY_CATALOG_ITEMS {
            return invalid("query catalog payload exceeds the item limit");
        }
        let mut seen = BTreeSet::new();
        for entry in entries {
            entry.validate(model)?;
            if !seen.insert((entry.normalized_text.as_str(), entry.language.as_str())) {
                return invalid("query catalog contains a duplicate normalized key");
            }
        }
        for tombstone in tombstones {
            tombstone.validate()?;
            if !seen.insert((
                tombstone.normalized_text.as_str(),
                tombstone.language.as_str(),
            )) {
                return invalid("query catalog upserts and tombstones overlap");
            }
        }
        Ok(())
    }

    fn scope(&self) -> &str {
        match self {
            Self::Snapshot(value) => &value.catalog_scope_id,
            Self::Delta(value) => &value.catalog_scope_id,
        }
    }

    fn sequence(&self) -> u64 {
        match self {
            Self::Snapshot(value) => value.sequence,
            Self::Delta(value) => value.to_sequence,
        }
    }

    fn previous_sequence(&self) -> Option<u64> {
        match self {
            Self::Snapshot(_) => None,
            Self::Delta(value) => Some(value.from_sequence),
        }
    }

    fn model(&self) -> &ModelContract {
        match self {
            Self::Snapshot(value) => &value.model,
            Self::Delta(value) => &value.model,
        }
    }

    fn counts(&self) -> (usize, usize) {
        match self {
            Self::Snapshot(value) => (value.entries.len(), value.tombstones.len()),
            Self::Delta(value) => (value.upserts.len(), value.tombstones.len()),
        }
    }
}

impl SignedQueryCatalogPackage {
    #[allow(clippy::too_many_arguments)]
    pub fn create(
        payload: &QueryCatalogPayload,
        signing_key: &SigningKey,
        jurisdiction_review_id: impl Into<String>,
        policy_version: impl Into<String>,
        created_at_ms: u64,
        expires_at_ms: u64,
    ) -> Result<Self> {
        payload.validate_shape()?;
        let payload_json = serde_json::to_vec(payload).map_err(json_invalid)?;
        if payload_json.len() > MAX_CATALOG_BYTES {
            return invalid("query catalog payload exceeds the byte limit");
        }
        let (records, tombstones) = payload.counts();
        let unsigned = CatalogManifestUnsigned {
            schema_version: CATALOG_SCHEMA_VERSION,
            catalog_scope_id: payload.scope().to_owned(),
            jurisdiction_review_id: jurisdiction_review_id.into(),
            policy_version: policy_version.into(),
            sequence: payload.sequence(),
            previous_sequence: payload.previous_sequence(),
            created_at_ms,
            expires_at_ms,
            model: payload.model().clone(),
            payload_sha256: hex::encode(Sha256::digest(&payload_json)),
            payload_bytes: payload_json.len() as u64,
            records: records as u64,
            tombstones: tombstones as u64,
            signer_key_id: catalog_signer_key_id(&signing_key.verifying_key()),
        };
        unsigned.validate(created_at_ms)?;
        let signature = signing_key.sign(&unsigned.signing_bytes()?);
        let manifest = CatalogManifest {
            unsigned,
            signature: URL_SAFE_NO_PAD.encode(signature.to_bytes()),
        };
        let manifest_json = serde_json::to_vec(&manifest).map_err(json_invalid)?;
        Ok(Self {
            manifest_json,
            payload_json,
        })
    }
}

impl CommonQueryCore {
    pub fn open(
        root: impl AsRef<Path>,
        expected_scope: impl Into<String>,
        verifying_key: VerifyingKey,
    ) -> Result<Self> {
        let root = root.as_ref().to_path_buf();
        fs::create_dir_all(root.join("generations"))
            .map_err(|error| storage("create query generation directory", error))?;
        fs::create_dir_all(root.join("activations"))
            .map_err(|error| storage("create query activation directory", error))?;
        let core = Self {
            root,
            expected_scope: expected_scope.into(),
            verifying_key,
        };
        validate_identifier("query catalog scope", &core.expected_scope, 128)?;
        Ok(core)
    }

    pub fn install(&self, manifest_json: &[u8], payload_json: &[u8], now_ms: u64) -> Result<u64> {
        let manifest = CatalogManifest::parse_and_verify(
            manifest_json,
            payload_json,
            &self.verifying_key,
            now_ms,
        )?;
        if manifest.unsigned.catalog_scope_id != self.expected_scope {
            return Err(CommunitySearchError::ScopeMismatch);
        }
        let payload: QueryCatalogPayload =
            serde_json::from_slice(payload_json).map_err(json_invalid)?;
        payload.validate_shape()?;
        self.validate_consistency(&manifest, &payload)?;
        let active = self.active_generation(now_ms).ok();
        let sequence = manifest.unsigned.sequence;
        let generation_name = format!("{sequence:020}");
        let final_directory = self.root.join("generations").join(&generation_name);
        if active
            .as_ref()
            .is_some_and(|value| value.sequence == sequence)
            && final_directory.is_dir()
            && fs::read(final_directory.join(MANIFEST_FILE))
                .is_ok_and(|stored| stored == manifest_json)
        {
            return Ok(sequence);
        }
        validate_query_sequence(active.as_ref(), &manifest, &payload)?;
        if final_directory.exists() {
            return Err(CommunitySearchError::SequenceMismatch);
        }
        let staging_directory = self
            .root
            .join("generations")
            .join(format!(".staging-{generation_name}-{}", std::process::id()));
        if staging_directory.exists() {
            return Err(CommunitySearchError::Storage(
                "a query catalog staging generation already exists".to_owned(),
            ));
        }
        fs::create_dir(&staging_directory)
            .map_err(|error| storage("create query catalog staging directory", error))?;
        let result = (|| {
            let database_path = staging_directory.join(DATABASE_FILE);
            match &payload {
                QueryCatalogPayload::Snapshot(_) => {
                    let connection = Connection::open(&database_path)
                        .map_err(|error| storage("create query SQLite generation", error))?;
                    initialize_database(&connection)?;
                }
                QueryCatalogPayload::Delta(_) => {
                    let current = active
                        .as_ref()
                        .ok_or(CommunitySearchError::NoActiveGeneration)?;
                    fs::copy(
                        self.generation_directory(current.sequence)
                            .join(DATABASE_FILE),
                        &database_path,
                    )
                    .map_err(|error| storage("copy active query SQLite generation", error))?;
                }
            }
            let mut connection = Connection::open(&database_path)
                .map_err(|error| storage("open query SQLite generation", error))?;
            configure_database(&connection)?;
            let transaction = connection
                .transaction()
                .map_err(|error| storage("begin query catalog transaction", error))?;
            apply_payload(&transaction, &payload)?;
            write_state(&transaction, &manifest)?;
            transaction
                .commit()
                .map_err(|error| storage("commit query catalog transaction", error))?;
            connection
                .execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
                .map_err(|error| storage("checkpoint query catalog generation", error))?;
            drop(connection);
            fs::write(staging_directory.join(MANIFEST_FILE), manifest_json)
                .map_err(|error| storage("write verified query manifest", error))?;
            sync_file(&database_path)?;
            sync_file(&staging_directory.join(MANIFEST_FILE))?;
            sync_directory(&staging_directory)?;
            fs::rename(&staging_directory, &final_directory)
                .map_err(|error| storage("activate complete query generation", error))?;
            sync_directory(&self.root.join("generations"))?;
            self.write_activation_marker(&manifest, manifest_json)?;
            Ok(sequence)
        })();
        if result.is_err() {
            let _ = fs::remove_dir_all(&staging_directory);
        }
        result
    }

    pub fn lookup(
        &self,
        text: &str,
        language: &str,
        model: &ModelContract,
        now_ms: u64,
    ) -> Result<Option<QuerySuggestion>> {
        let normalized = normalize_query_text_v1(text)?;
        validate_identifier("query language", language, 16)?;
        let generation = self.active_generation(now_ms)?;
        if &generation.model != model {
            return Err(CommunitySearchError::ModelMismatch);
        }
        let connection = self.open_generation_database(generation.sequence)?;
        let entry_json: Option<String> = connection
            .query_row(
                "SELECT entry_json FROM query_entry
                 WHERE normalized_text = ?1 AND language = ?2 AND deleted = 0",
                params![normalized, language],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| storage("lookup common query", error))?;
        entry_json
            .map(|value| decode_entry(&value, model).map(QueryCatalogEntry::suggestion))
            .transpose()
    }

    pub fn suggest(
        &self,
        prefix: &str,
        language: &str,
        model: &ModelContract,
        limit: usize,
        now_ms: u64,
    ) -> Result<Vec<QuerySuggestion>> {
        if limit == 0 {
            return Ok(Vec::new());
        }
        let normalized = normalize_query_text_v1(prefix)?;
        validate_identifier("query language", language, 16)?;
        let generation = self.active_generation(now_ms)?;
        if &generation.model != model {
            return Err(CommunitySearchError::ModelMismatch);
        }
        let connection = self.open_generation_database(generation.sequence)?;
        let escaped = escape_like_prefix(&normalized);
        let mut statement = connection
            .prepare(
                "SELECT entry_json FROM query_entry
                 WHERE language = ?1 AND deleted = 0
                   AND normalized_text LIKE ?2 ESCAPE '\\'
                 ORDER BY weight DESC, normalized_text ASC LIMIT ?3",
            )
            .map_err(|error| storage("prepare local query suggestions", error))?;
        let rows = statement
            .query_map(
                params![language, format!("{escaped}%"), limit.min(20) as i64],
                |row| row.get::<_, String>(0),
            )
            .map_err(|error| storage("read local query suggestions", error))?;
        let mut suggestions = Vec::new();
        for row in rows {
            let entry = decode_entry(
                &row.map_err(|error| storage("read local query suggestion row", error))?,
                model,
            )?;
            suggestions.push(entry.suggestion());
        }
        Ok(suggestions)
    }

    /// Returns the newest complete, verified and currently valid query
    /// generation. This never trusts a remote "latest" pointer: activation
    /// markers, signatures, scope, model and expiry are rechecked locally.
    pub fn active_sequence(&self, now_ms: u64) -> Result<u64> {
        Ok(self.active_generation(now_ms)?.sequence)
    }

    fn active_generation(&self, now_ms: u64) -> Result<ActiveQueryGeneration> {
        let mut markers = activation_markers(&self.root)?;
        markers.sort_unstable_by_key(|value| std::cmp::Reverse(value.0));
        for (sequence, marker_path) in markers {
            if let Ok(generation) = self.validate_active_marker(sequence, &marker_path, now_ms) {
                return Ok(generation);
            }
        }
        Err(CommunitySearchError::NoActiveGeneration)
    }

    fn validate_active_marker(
        &self,
        sequence: u64,
        marker_path: &Path,
        now_ms: u64,
    ) -> Result<ActiveQueryGeneration> {
        let marker_bytes = fs::read(marker_path)
            .map_err(|error| storage("read query activation marker", error))?;
        let marker: QueryActivationMarker = serde_json::from_slice(&marker_bytes)
            .map_err(|error| CommunitySearchError::Storage(error.to_string()))?;
        if marker.sequence != sequence || marker.catalog_scope_id != self.expected_scope {
            return Err(CommunitySearchError::ScopeMismatch);
        }
        let directory = self.generation_directory(sequence);
        let manifest_bytes = fs::read(directory.join(MANIFEST_FILE))
            .map_err(|error| storage("read active query manifest", error))?;
        if marker.manifest_sha256 != hex::encode(Sha256::digest(&manifest_bytes)) {
            return Err(CommunitySearchError::PayloadHashMismatch);
        }
        let manifest = CatalogManifest::parse_and_verify_signature(
            &manifest_bytes,
            &self.verifying_key,
            now_ms,
        )?;
        if manifest.unsigned.sequence != sequence
            || manifest.unsigned.catalog_scope_id != self.expected_scope
        {
            return Err(CommunitySearchError::SequenceMismatch);
        }
        let connection = self.open_generation_database(sequence)?;
        let stored: (i64, String, String, i64) = connection
            .query_row(
                "SELECT sequence, catalog_scope_id, model_json, item_count
                 FROM query_state WHERE singleton = 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .map_err(|error| storage("validate active query state", error))?;
        let stored_model: ModelContract = serde_json::from_str(&stored.2).map_err(json_invalid)?;
        let actual_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM query_entry WHERE deleted = 0",
                [],
                |row| row.get(0),
            )
            .map_err(|error| storage("count active query entries", error))?;
        if u64::try_from(stored.0).ok() != Some(sequence)
            || stored.1 != self.expected_scope
            || stored_model != manifest.unsigned.model
            || stored.3 != actual_count
        {
            return Err(CommunitySearchError::Storage(
                "active query generation metadata is inconsistent".to_owned(),
            ));
        }
        Ok(ActiveQueryGeneration {
            sequence,
            model: stored_model,
        })
    }

    fn open_generation_database(&self, sequence: u64) -> Result<Connection> {
        let path = self.generation_directory(sequence).join(DATABASE_FILE);
        let metadata = fs::symlink_metadata(&path)
            .map_err(|error| storage("inspect active query database", error))?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(CommunitySearchError::Storage(
                "query database must be a regular non-symlink file".to_owned(),
            ));
        }
        let flags = OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX;
        let connection = Connection::open_with_flags(&path, flags)
            .map_err(|error| storage("open active query database", error))?;
        connection
            .execute_batch(
                "PRAGMA foreign_keys = ON;
                 PRAGMA trusted_schema = OFF;
                 PRAGMA query_only = ON;
                 PRAGMA busy_timeout = 5000;",
            )
            .map_err(|error| storage("configure read-only query database", error))?;
        Ok(connection)
    }

    fn generation_directory(&self, sequence: u64) -> PathBuf {
        self.root
            .join("generations")
            .join(format!("{sequence:020}"))
    }

    fn validate_consistency(
        &self,
        manifest: &CatalogManifest,
        payload: &QueryCatalogPayload,
    ) -> Result<()> {
        if payload.scope() != manifest.unsigned.catalog_scope_id {
            return Err(CommunitySearchError::ScopeMismatch);
        }
        if payload.sequence() != manifest.unsigned.sequence
            || payload.previous_sequence() != manifest.unsigned.previous_sequence
        {
            return Err(CommunitySearchError::SequenceMismatch);
        }
        if payload.model() != &manifest.unsigned.model {
            return Err(CommunitySearchError::ModelMismatch);
        }
        let (records, tombstones) = payload.counts();
        if manifest.unsigned.records != records as u64
            || manifest.unsigned.tombstones != tombstones as u64
        {
            return invalid("signed query manifest counts do not match its payload");
        }
        Ok(())
    }

    fn write_activation_marker(
        &self,
        manifest: &CatalogManifest,
        manifest_json: &[u8],
    ) -> Result<()> {
        let sequence = manifest.unsigned.sequence;
        let marker = QueryActivationMarker {
            sequence,
            catalog_scope_id: self.expected_scope.clone(),
            manifest_sha256: hex::encode(Sha256::digest(manifest_json)),
        };
        let bytes = serde_json::to_vec(&marker).map_err(json_invalid)?;
        let temporary = self
            .root
            .join("activations")
            .join(format!(".active-{sequence:020}-{}.tmp", std::process::id()));
        let final_path = self
            .root
            .join("activations")
            .join(format!("active-{sequence:020}.json"));
        fs::write(&temporary, bytes)
            .map_err(|error| storage("write query activation marker", error))?;
        sync_file(&temporary)?;
        fs::rename(&temporary, &final_path)
            .map_err(|error| storage("publish query activation marker", error))?;
        sync_directory(&self.root.join("activations"))
    }
}

pub fn normalize_query_text_v1(value: &str) -> Result<String> {
    if value
        .chars()
        .any(|character| character.is_control() && !character.is_whitespace())
    {
        return invalid("query text cannot contain control characters");
    }
    let folded: String = value.nfkc().flat_map(char::to_lowercase).collect();
    let normalized = folded.split_whitespace().collect::<Vec<_>>().join(" ");
    let count = normalized.chars().count();
    if !(1..=160).contains(&count) {
        return invalid("normalized query text must contain 1 to 160 characters");
    }
    Ok(normalized)
}

fn validate_query_sequence(
    active: Option<&ActiveQueryGeneration>,
    manifest: &CatalogManifest,
    payload: &QueryCatalogPayload,
) -> Result<()> {
    match (active, payload) {
        (None, QueryCatalogPayload::Snapshot(_))
            if manifest.unsigned.previous_sequence.is_none() =>
        {
            Ok(())
        }
        (Some(active), QueryCatalogPayload::Snapshot(_))
            if manifest.unsigned.previous_sequence.is_none()
                && manifest.unsigned.sequence > active.sequence =>
        {
            Ok(())
        }
        (Some(active), QueryCatalogPayload::Delta(_))
            if manifest.unsigned.previous_sequence == Some(active.sequence)
                && manifest.unsigned.sequence > active.sequence
                && manifest.unsigned.model == active.model =>
        {
            Ok(())
        }
        _ => Err(CommunitySearchError::SequenceMismatch),
    }
}

fn initialize_database(connection: &Connection) -> Result<()> {
    connection
        .execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = FULL;
             PRAGMA foreign_keys = ON;
             CREATE TABLE query_entry (
               normalized_text TEXT NOT NULL,
               language TEXT NOT NULL,
               query_id TEXT NOT NULL,
               revision INTEGER NOT NULL CHECK(revision > 0),
               entry_json TEXT NOT NULL,
               weight REAL NOT NULL,
               deleted INTEGER NOT NULL DEFAULT 0 CHECK(deleted IN (0, 1)),
               PRIMARY KEY(normalized_text, language)
             ) STRICT;
             CREATE INDEX query_entry_suggestion
               ON query_entry(language, deleted, normalized_text, weight);
             CREATE TABLE query_tombstone (
               normalized_text TEXT NOT NULL,
               language TEXT NOT NULL,
               revision INTEGER NOT NULL CHECK(revision > 0),
               deleted_at_ms INTEGER NOT NULL CHECK(deleted_at_ms > 0),
               PRIMARY KEY(normalized_text, language)
             ) STRICT;
             CREATE TABLE query_state (
               singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
               sequence INTEGER NOT NULL,
               catalog_scope_id TEXT NOT NULL,
               model_json TEXT NOT NULL,
               item_count INTEGER NOT NULL CHECK(item_count >= 0)
             ) STRICT;",
        )
        .map_err(|error| storage("initialize query catalog database", error))
}

fn configure_database(connection: &Connection) -> Result<()> {
    connection
        .execute_batch(
            "PRAGMA foreign_keys = ON;
             PRAGMA trusted_schema = OFF;
             PRAGMA busy_timeout = 5000;",
        )
        .map_err(|error| storage("configure query catalog database", error))
}

fn apply_payload(transaction: &Transaction<'_>, payload: &QueryCatalogPayload) -> Result<()> {
    let (entries, tombstones) = match payload {
        QueryCatalogPayload::Snapshot(value) => {
            (value.entries.as_slice(), value.tombstones.as_slice())
        }
        QueryCatalogPayload::Delta(value) => {
            (value.upserts.as_slice(), value.tombstones.as_slice())
        }
    };
    for tombstone in tombstones {
        apply_tombstone(transaction, tombstone)?;
    }
    for entry in entries {
        apply_entry(transaction, entry)?;
    }
    Ok(())
}

fn apply_entry(transaction: &Transaction<'_>, entry: &QueryCatalogEntry) -> Result<()> {
    let revision = to_sql_i64(entry.revision, "query revision")?;
    let tombstone_revision: Option<i64> = transaction
        .query_row(
            "SELECT revision FROM query_tombstone
             WHERE normalized_text = ?1 AND language = ?2",
            params![entry.normalized_text, entry.language],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| storage("read query tombstone revision", error))?;
    if tombstone_revision.is_some_and(|value| value >= revision) {
        return Err(CommunitySearchError::SequenceMismatch);
    }
    let existing_revision: Option<i64> = transaction
        .query_row(
            "SELECT revision FROM query_entry
             WHERE normalized_text = ?1 AND language = ?2",
            params![entry.normalized_text, entry.language],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| storage("read query entry revision", error))?;
    if existing_revision.is_some_and(|value| value >= revision) {
        return Err(CommunitySearchError::SequenceMismatch);
    }
    let entry_json = serde_json::to_string(entry).map_err(json_invalid)?;
    transaction
        .execute(
            "INSERT INTO query_entry(
               normalized_text, language, query_id, revision, entry_json, weight, deleted
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0)
             ON CONFLICT(normalized_text, language) DO UPDATE SET
               query_id=excluded.query_id, revision=excluded.revision,
               entry_json=excluded.entry_json, weight=excluded.weight, deleted=0",
            params![
                entry.normalized_text,
                entry.language,
                entry.query_id,
                revision,
                entry_json,
                entry.weight
            ],
        )
        .map_err(|error| storage("write query catalog entry", error))?;
    transaction
        .execute(
            "DELETE FROM query_tombstone
             WHERE normalized_text = ?1 AND language = ?2 AND revision < ?3",
            params![entry.normalized_text, entry.language, revision],
        )
        .map_err(|error| storage("retire older query tombstone", error))?;
    Ok(())
}

fn apply_tombstone(transaction: &Transaction<'_>, tombstone: &QueryCatalogTombstone) -> Result<()> {
    let revision = to_sql_i64(tombstone.revision, "query tombstone revision")?;
    let deleted_at = to_sql_i64(tombstone.deleted_at_ms, "query tombstone deletion time")?;
    let existing_entry: Option<i64> = transaction
        .query_row(
            "SELECT revision FROM query_entry
             WHERE normalized_text = ?1 AND language = ?2",
            params![tombstone.normalized_text, tombstone.language],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| storage("read query entry before tombstone", error))?;
    let existing_tombstone: Option<i64> = transaction
        .query_row(
            "SELECT revision FROM query_tombstone
             WHERE normalized_text = ?1 AND language = ?2",
            params![tombstone.normalized_text, tombstone.language],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| storage("read existing query tombstone", error))?;
    if existing_entry.is_some_and(|value| value > revision)
        || existing_tombstone.is_some_and(|value| value >= revision)
    {
        return Err(CommunitySearchError::SequenceMismatch);
    }
    transaction
        .execute(
            "INSERT INTO query_tombstone(
               normalized_text, language, revision, deleted_at_ms
             ) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(normalized_text, language) DO UPDATE SET
               revision=excluded.revision, deleted_at_ms=excluded.deleted_at_ms
             WHERE excluded.revision > query_tombstone.revision",
            params![
                tombstone.normalized_text,
                tombstone.language,
                revision,
                deleted_at
            ],
        )
        .map_err(|error| storage("write query tombstone", error))?;
    transaction
        .execute(
            "UPDATE query_entry SET deleted = 1
             WHERE normalized_text = ?1 AND language = ?2 AND revision <= ?3",
            params![tombstone.normalized_text, tombstone.language, revision],
        )
        .map_err(|error| storage("apply query tombstone", error))?;
    Ok(())
}

fn write_state(transaction: &Transaction<'_>, manifest: &CatalogManifest) -> Result<()> {
    let count: i64 = transaction
        .query_row(
            "SELECT COUNT(*) FROM query_entry WHERE deleted = 0",
            [],
            |row| row.get(0),
        )
        .map_err(|error| storage("count active common queries", error))?;
    if usize::try_from(count)
        .ok()
        .is_none_or(|value| value > MAX_QUERY_CATALOG_ITEMS)
    {
        return invalid("active query catalog exceeds the item limit");
    }
    let model_json = serde_json::to_string(&manifest.unsigned.model).map_err(json_invalid)?;
    let sequence = to_sql_i64(manifest.unsigned.sequence, "query catalog sequence")?;
    transaction
        .execute(
            "INSERT INTO query_state(
               singleton, sequence, catalog_scope_id, model_json, item_count
             ) VALUES (1, ?1, ?2, ?3, ?4)
             ON CONFLICT(singleton) DO UPDATE SET
               sequence=excluded.sequence, catalog_scope_id=excluded.catalog_scope_id,
               model_json=excluded.model_json, item_count=excluded.item_count",
            params![
                sequence,
                manifest.unsigned.catalog_scope_id,
                model_json,
                count
            ],
        )
        .map_err(|error| storage("write query catalog state", error))?;
    Ok(())
}

fn decode_entry(value: &str, model: &ModelContract) -> Result<QueryCatalogEntry> {
    let entry: QueryCatalogEntry = serde_json::from_str(value).map_err(json_invalid)?;
    entry.validate(model)?;
    Ok(entry)
}

fn activation_markers(root: &Path) -> Result<Vec<(u64, PathBuf)>> {
    let entries = fs::read_dir(root.join("activations"))
        .map_err(|error| storage("read query activation directory", error))?;
    let mut markers = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|error| storage("read query activation entry", error))?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let Some(sequence) = name
            .strip_prefix("active-")
            .and_then(|value| value.strip_suffix(".json"))
            .and_then(|value| value.parse::<u64>().ok())
        else {
            continue;
        };
        markers.push((sequence, entry.path()));
    }
    Ok(markers)
}

fn escape_like_prefix(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

fn sync_file(path: &Path) -> Result<()> {
    File::open(path)
        .and_then(|file| file.sync_all())
        .map_err(|error| storage("synchronize query catalog file", error))
}

fn sync_directory(path: &Path) -> Result<()> {
    match File::open(path).and_then(|directory| directory.sync_all()) {
        Ok(()) => Ok(()),
        Err(_error) if cfg!(target_os = "windows") => Ok(()),
        Err(error) => Err(storage("synchronize query catalog directory", error)),
    }
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

fn to_sql_i64(value: u64, label: &str) -> Result<i64> {
    i64::try_from(value).map_err(|_| {
        CommunitySearchError::InvalidCatalog(format!("{label} exceeds the supported range"))
    })
}
