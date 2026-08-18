use crate::{
    interest::{InterestDomain, InterestState},
    model::{
        validate_embedding, CatalogEmbeddingSource, CatalogItem, CatalogItemKind, CatalogPayload,
        LocalQueryEmbedding, SearchFilters, SearchResult,
    },
    CatalogManifest, CommunitySearchError, ModelContract, Result, MAX_CATALOG_ITEMS,
};
use ed25519_dalek::VerifyingKey;
use rusqlite::{params, Connection, OpenFlags, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
};
use usearch::{Index, IndexOptions, MetricKind, ScalarKind};

const DATABASE_FILE: &str = "catalog.sqlite3";
const INDEX_FILE: &str = "catalog.usearch";
const MANIFEST_FILE: &str = "manifest.json";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ActivationMarker {
    sequence: u64,
    catalog_scope_id: String,
    manifest_sha256: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledGeneration {
    pub sequence: u64,
    pub catalog_scope_id: String,
    pub policy_version: String,
    pub model: ModelContract,
    pub items: usize,
}

pub struct CommunitySearchCore {
    root: PathBuf,
    expected_scope: String,
    verifying_key: VerifyingKey,
}

impl CommunitySearchCore {
    pub fn open(
        root: impl AsRef<Path>,
        expected_scope: impl Into<String>,
        verifying_key: VerifyingKey,
    ) -> Result<Self> {
        let root = root.as_ref().to_path_buf();
        fs::create_dir_all(root.join("generations"))
            .map_err(|error| storage("create catalog generation directory", error))?;
        fs::create_dir_all(root.join("activations"))
            .map_err(|error| storage("create catalog activation directory", error))?;
        let core = Self {
            root,
            expected_scope: expected_scope.into(),
            verifying_key,
        };
        crate::model::validate_identifier("catalog scope", &core.expected_scope, 128)?;
        Ok(core)
    }

    pub fn install(
        &self,
        manifest_json: &[u8],
        payload_json: &[u8],
        now_ms: u64,
    ) -> Result<InstalledGeneration> {
        let manifest = CatalogManifest::parse_and_verify(
            manifest_json,
            payload_json,
            &self.verifying_key,
            now_ms,
        )?;
        if manifest.unsigned.catalog_scope_id != self.expected_scope {
            return Err(CommunitySearchError::ScopeMismatch);
        }
        let payload: CatalogPayload = serde_json::from_slice(payload_json).map_err(|error| {
            CommunitySearchError::InvalidCatalog(format!(
                "catalog payload is not valid JSON: {error}"
            ))
        })?;
        payload.validate_shape()?;
        self.validate_package_consistency(&manifest, &payload)?;

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
            // Network retries and app restarts may deliver the exact current
            // immutable package again. Its signature and payload hash were
            // verified above; returning the locally revalidated generation is
            // safe and avoids treating a normal retry as a rollback attempt.
            return active.ok_or(CommunitySearchError::NoActiveGeneration);
        }
        self.validate_sequence(active.as_ref(), &manifest, &payload)?;
        if final_directory.exists() {
            return Err(CommunitySearchError::SequenceMismatch);
        }
        let staging_directory = self
            .root
            .join("generations")
            .join(format!(".staging-{generation_name}-{}", std::process::id()));
        if staging_directory.exists() {
            return Err(CommunitySearchError::Storage(
                "a catalog staging generation already exists".to_owned(),
            ));
        }
        fs::create_dir(&staging_directory)
            .map_err(|error| storage("create catalog staging directory", error))?;

        let install_result = (|| {
            let database_path = staging_directory.join(DATABASE_FILE);
            match &payload {
                CatalogPayload::Snapshot(_) => {
                    let connection = Connection::open(&database_path)
                        .map_err(|error| storage("create catalog SQLite generation", error))?;
                    initialize_database(&connection)?;
                }
                CatalogPayload::Delta(_) => {
                    let active = active
                        .as_ref()
                        .ok_or(CommunitySearchError::NoActiveGeneration)?;
                    fs::copy(
                        self.generation_directory(active.sequence)
                            .join(DATABASE_FILE),
                        &database_path,
                    )
                    .map_err(|error| storage("copy active SQLite generation", error))?;
                }
            }
            let mut connection = Connection::open(&database_path)
                .map_err(|error| storage("open catalog SQLite generation", error))?;
            configure_database(&connection)?;
            migrate_embedding_schema(&connection)?;
            let transaction = connection
                .transaction()
                .map_err(|error| storage("begin catalog transaction", error))?;
            apply_payload(&transaction, &payload)?;
            write_catalog_state(&transaction, &manifest)?;
            transaction
                .commit()
                .map_err(|error| storage("commit catalog transaction", error))?;
            connection
                .execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
                .map_err(|error| storage("checkpoint catalog generation", error))?;
            drop(connection);

            let index_path = staging_directory.join(INDEX_FILE);
            let items = build_usearch_index(&database_path, &index_path, &manifest.unsigned.model)?;
            fs::write(staging_directory.join(MANIFEST_FILE), manifest_json)
                .map_err(|error| storage("write verified catalog manifest", error))?;
            sync_file(&database_path)?;
            sync_file(&index_path)?;
            sync_file(&staging_directory.join(MANIFEST_FILE))?;
            sync_directory(&staging_directory)?;

            fs::rename(&staging_directory, &final_directory)
                .map_err(|error| storage("activate complete catalog directory", error))?;
            sync_directory(&self.root.join("generations"))?;
            self.write_activation_marker(&manifest, manifest_json)?;

            Ok(InstalledGeneration {
                sequence,
                catalog_scope_id: self.expected_scope.clone(),
                policy_version: manifest.unsigned.policy_version.clone(),
                model: manifest.unsigned.model.clone(),
                items,
            })
        })();

        if install_result.is_err() {
            let _ = fs::remove_dir_all(&staging_directory);
        }
        install_result
    }

    pub fn active_generation(&self, now_ms: u64) -> Result<InstalledGeneration> {
        let mut markers = self.activation_markers()?;
        markers.sort_unstable_by_key(|marker| std::cmp::Reverse(marker.0));
        for (sequence, marker_path) in markers {
            if let Ok(generation) = self.validate_active_marker(sequence, &marker_path, now_ms) {
                return Ok(generation);
            }
        }
        Err(CommunitySearchError::NoActiveGeneration)
    }

    pub fn search(
        &self,
        query: &LocalQueryEmbedding,
        limit: usize,
        filters: &SearchFilters,
        now_ms: u64,
    ) -> Result<Vec<SearchResult>> {
        let generation = self.active_generation(now_ms)?;
        if query.model != generation.model {
            return Err(CommunitySearchError::ModelMismatch);
        }
        validate_embedding(&query.embedding, generation.model.dimension)?;
        if limit == 0 {
            return Ok(Vec::new());
        }
        if let Some(region) = &filters.coarse_region {
            crate::model::validate_identifier("search coarse region", region, 16)?;
        }
        let directory = self.generation_directory(generation.sequence);
        let index_path = path_string(&directory.join(INDEX_FILE))?;
        let index = Index::restore(&index_path)
            .map_err(|error| CommunitySearchError::VectorIndex(error.to_string()))?;
        let count = index.size();
        if count == 0 {
            return Ok(Vec::new());
        }
        let matches = index
            .exact_search(&query.embedding, count)
            .map_err(|error| CommunitySearchError::VectorIndex(error.to_string()))?;
        let connection = open_read_only_database(
            &directory.join(DATABASE_FILE),
            "open active catalog for search",
        )?;
        let mut results = Vec::with_capacity(limit.min(count));
        let mut matched_items = HashSet::with_capacity(limit.min(count));
        for (key, distance) in matches.keys.into_iter().zip(matches.distances) {
            if let Some(item) = load_search_item(&connection, key, now_ms)? {
                if !filters.kinds.is_empty() && !filters.kinds.contains(&item.kind) {
                    continue;
                }
                if item.kind == CatalogItemKind::Advertisement && !filters.include_advertising {
                    continue;
                }
                if filters
                    .coarse_region
                    .as_ref()
                    .is_some_and(|region| item.coarse_region.as_ref() != Some(region))
                {
                    continue;
                }
                if !matched_items.insert(item.public_id.clone()) {
                    continue;
                }
                results.push(SearchResult {
                    item,
                    semantic_distance: distance,
                    personal_adjustment: 0.0,
                    combined_score: 1.0 - distance,
                });
                if results.len() == limit {
                    break;
                }
            }
        }
        Ok(results)
    }

    pub fn search_personalized(
        &self,
        query: &LocalQueryEmbedding,
        limit: usize,
        filters: &SearchFilters,
        interests: &InterestState,
        now_ms: u64,
    ) -> Result<Vec<SearchResult>> {
        if limit == 0 {
            return Ok(Vec::new());
        }
        let mut candidates = self.search(query, MAX_CATALOG_ITEMS, filters, now_ms)?;
        for result in &mut candidates {
            let domain = match result.item.kind {
                CatalogItemKind::News => InterestDomain::News,
                CatalogItemKind::Advertisement => InterestDomain::Advertising,
                CatalogItemKind::Profile
                | CatalogItemKind::Post
                | CatalogItemKind::ServiceListing
                | CatalogItemKind::ProductListing => InterestDomain::Discovery,
            };
            result.personal_adjustment =
                interests.personal_score(domain, &query.model, &result.item.embedding, now_ms)?;
            result.combined_score = 1.0 - result.semantic_distance + result.personal_adjustment;
        }
        candidates.sort_by(|left, right| {
            right
                .combined_score
                .total_cmp(&left.combined_score)
                .then_with(|| left.semantic_distance.total_cmp(&right.semantic_distance))
                .then_with(|| left.item.public_id.cmp(&right.item.public_id))
        });
        candidates.truncate(limit);
        Ok(candidates)
    }

    /// Resolves a verified catalog item for an on-device interest event.
    ///
    /// Callers expose only `public_id` across the UI boundary. The signed
    /// embedding stays inside the native runtime and is never accepted from
    /// renderer or server event payloads.
    pub fn interest_item(&self, public_id: &str, now_ms: u64) -> Result<CatalogItem> {
        crate::model::validate_identifier("public item id", public_id, 128)?;
        let generation = self.active_generation(now_ms)?;
        let directory = self.generation_directory(generation.sequence);
        let connection = open_read_only_database(
            &directory.join(DATABASE_FILE),
            "open active catalog for local interest event",
        )?;
        let item_json: Option<String> = connection
            .query_row(
                "SELECT item_json FROM catalog_item
                 WHERE public_id = ?1 AND deleted = 0
                   AND (expires_at_ms IS NULL OR expires_at_ms > ?2)",
                params![public_id, to_sql_i64(now_ms, "interest event time")?],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| storage("load catalog item for local interest event", error))?;
        let item_json = item_json.ok_or_else(|| {
            CommunitySearchError::InvalidCatalog(
                "local interest event references an unknown catalog item".to_owned(),
            )
        })?;
        serde_json::from_str(&item_json).map_err(|error| {
            CommunitySearchError::Storage(format!(
                "stored catalog item for local interest event is invalid: {error}"
            ))
        })
    }

    fn validate_package_consistency(
        &self,
        manifest: &CatalogManifest,
        payload: &CatalogPayload,
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
        if records as u64 != manifest.unsigned.records
            || tombstones as u64 != manifest.unsigned.tombstones
        {
            return Err(CommunitySearchError::InvalidCatalog(
                "signed manifest record counts do not match the payload".to_owned(),
            ));
        }
        Ok(())
    }

    fn validate_sequence(
        &self,
        active: Option<&InstalledGeneration>,
        manifest: &CatalogManifest,
        payload: &CatalogPayload,
    ) -> Result<()> {
        match (active, payload) {
            (None, CatalogPayload::Snapshot(_))
                if manifest.unsigned.previous_sequence.is_none() =>
            {
                Ok(())
            }
            (Some(active), CatalogPayload::Snapshot(_))
                if manifest.unsigned.previous_sequence.is_none()
                    && manifest.unsigned.sequence > active.sequence =>
            {
                Ok(())
            }
            (Some(active), CatalogPayload::Delta(_))
                if manifest.unsigned.previous_sequence == Some(active.sequence)
                    && manifest.unsigned.sequence > active.sequence
                    && manifest.unsigned.model == active.model =>
            {
                Ok(())
            }
            _ => Err(CommunitySearchError::SequenceMismatch),
        }
    }

    fn write_activation_marker(
        &self,
        manifest: &CatalogManifest,
        manifest_json: &[u8],
    ) -> Result<()> {
        let sequence = manifest.unsigned.sequence;
        let marker = ActivationMarker {
            sequence,
            catalog_scope_id: self.expected_scope.clone(),
            manifest_sha256: hex::encode(Sha256::digest(manifest_json)),
        };
        let bytes = serde_json::to_vec(&marker)
            .map_err(|error| CommunitySearchError::Storage(error.to_string()))?;
        let temporary = self
            .root
            .join("activations")
            .join(format!(".active-{sequence:020}-{}.tmp", std::process::id()));
        let final_path = self
            .root
            .join("activations")
            .join(format!("active-{sequence:020}.json"));
        fs::write(&temporary, bytes)
            .map_err(|error| storage("write catalog activation marker", error))?;
        sync_file(&temporary)?;
        fs::rename(&temporary, &final_path)
            .map_err(|error| storage("publish catalog activation marker", error))?;
        sync_directory(&self.root.join("activations"))
    }

    fn validate_active_marker(
        &self,
        sequence: u64,
        marker_path: &Path,
        now_ms: u64,
    ) -> Result<InstalledGeneration> {
        let marker_bytes = fs::read(marker_path)
            .map_err(|error| storage("read catalog activation marker", error))?;
        let marker: ActivationMarker = serde_json::from_slice(&marker_bytes)
            .map_err(|error| CommunitySearchError::Storage(error.to_string()))?;
        if marker.sequence != sequence || marker.catalog_scope_id != self.expected_scope {
            return Err(CommunitySearchError::ScopeMismatch);
        }
        let directory = self.generation_directory(sequence);
        let manifest_json = fs::read(directory.join(MANIFEST_FILE))
            .map_err(|error| storage("read active catalog manifest", error))?;
        if marker.manifest_sha256 != hex::encode(Sha256::digest(&manifest_json)) {
            return Err(CommunitySearchError::PayloadHashMismatch);
        }
        let manifest = CatalogManifest::parse_and_verify_signature(
            &manifest_json,
            &self.verifying_key,
            now_ms,
        )?;
        if manifest.unsigned.catalog_scope_id != self.expected_scope
            || manifest.unsigned.sequence != sequence
        {
            return Err(CommunitySearchError::ScopeMismatch);
        }
        if now_ms < manifest.unsigned.created_at_ms || now_ms >= manifest.unsigned.expires_at_ms {
            return Err(CommunitySearchError::PolicyExpired);
        }
        let connection = open_read_only_database(
            &directory.join(DATABASE_FILE),
            "open active catalog generation",
        )?;
        let state: (i64, String, String, i64) = connection
            .query_row(
                "SELECT sequence, policy_version, model_json, item_count FROM catalog_state WHERE singleton = 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .map_err(|error| storage("read active catalog state", error))?;
        let model: ModelContract = serde_json::from_str(&state.2)
            .map_err(|error| CommunitySearchError::Storage(error.to_string()))?;
        if from_sql_i64(state.0, "catalog sequence")? != sequence
            || model != manifest.unsigned.model
        {
            return Err(CommunitySearchError::ModelMismatch);
        }
        if !directory.join(INDEX_FILE).is_file() {
            return Err(CommunitySearchError::Storage(
                "active catalog vector index is missing".to_owned(),
            ));
        }
        Ok(InstalledGeneration {
            sequence,
            catalog_scope_id: self.expected_scope.clone(),
            policy_version: state.1,
            model,
            items: usize::try_from(state.3).map_err(|_| {
                CommunitySearchError::Storage("catalog item count is invalid".to_owned())
            })?,
        })
    }

    fn activation_markers(&self) -> Result<Vec<(u64, PathBuf)>> {
        let mut markers = Vec::new();
        for entry in fs::read_dir(self.root.join("activations"))
            .map_err(|error| storage("list catalog activations", error))?
        {
            let entry = entry.map_err(|error| storage("read catalog activation", error))?;
            let name = entry.file_name();
            let name = name.to_string_lossy();
            let Some(raw) = name
                .strip_prefix("active-")
                .and_then(|value| value.strip_suffix(".json"))
            else {
                continue;
            };
            if let Ok(sequence) = raw.parse::<u64>() {
                markers.push((sequence, entry.path()));
            }
        }
        Ok(markers)
    }

    fn generation_directory(&self, sequence: u64) -> PathBuf {
        self.root
            .join("generations")
            .join(format!("{sequence:020}"))
    }
}

fn initialize_database(connection: &Connection) -> Result<()> {
    configure_database(connection)?;
    connection
        .execute_batch(
            "
            CREATE TABLE catalog_item (
                id INTEGER PRIMARY KEY,
                public_id TEXT NOT NULL UNIQUE,
                revision INTEGER NOT NULL CHECK(revision > 0),
                kind TEXT NOT NULL,
                item_json TEXT NOT NULL,
                coarse_region TEXT,
                published_at_ms INTEGER NOT NULL,
                expires_at_ms INTEGER,
                deleted INTEGER NOT NULL DEFAULT 0 CHECK(deleted IN (0, 1))
            ) STRICT;
            CREATE TABLE catalog_embedding (
                id INTEGER PRIMARY KEY,
                item_id INTEGER NOT NULL REFERENCES catalog_item(id) ON DELETE CASCADE,
                source TEXT NOT NULL,
                ordinal INTEGER NOT NULL CHECK(ordinal >= 0 AND ordinal <= 65535),
                model_json TEXT NOT NULL,
                embedding BLOB NOT NULL,
                UNIQUE(item_id, source, ordinal)
            ) STRICT;
            CREATE TABLE catalog_tombstone (
                public_id TEXT PRIMARY KEY,
                revision INTEGER NOT NULL,
                deleted_at_ms INTEGER NOT NULL
            ) STRICT;
            CREATE TABLE catalog_state (
                singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
                sequence INTEGER NOT NULL,
                policy_version TEXT NOT NULL,
                manifest_sha256 TEXT NOT NULL,
                model_json TEXT NOT NULL,
                item_count INTEGER NOT NULL
            ) STRICT;
            ",
        )
        .map_err(|error| storage("initialize catalog SQLite schema", error))
}

fn configure_database(connection: &Connection) -> Result<()> {
    connection
        .execute_batch(
            "PRAGMA foreign_keys = ON; PRAGMA trusted_schema = OFF; PRAGMA journal_mode = DELETE;",
        )
        .map_err(|error| storage("configure catalog SQLite connection", error))
}

fn migrate_embedding_schema(connection: &Connection) -> Result<()> {
    let mut statement = connection
        .prepare("PRAGMA table_info(catalog_embedding)")
        .map_err(|error| storage("inspect catalog embedding schema", error))?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|error| storage("read catalog embedding schema", error))?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(|error| storage("read catalog embedding column", error))?;
    if columns.iter().any(|column| column == "source") {
        return Ok(());
    }
    connection
        .execute_batch(
            "
            ALTER TABLE catalog_embedding RENAME TO catalog_embedding_single;
            CREATE TABLE catalog_embedding (
                id INTEGER PRIMARY KEY,
                item_id INTEGER NOT NULL REFERENCES catalog_item(id) ON DELETE CASCADE,
                source TEXT NOT NULL,
                ordinal INTEGER NOT NULL CHECK(ordinal >= 0 AND ordinal <= 65535),
                model_json TEXT NOT NULL,
                embedding BLOB NOT NULL,
                UNIQUE(item_id, source, ordinal)
            ) STRICT;
            INSERT INTO catalog_embedding(item_id, source, ordinal, model_json, embedding)
                SELECT item_id, 'primary', 0, model_json, embedding
                FROM catalog_embedding_single;
            DROP TABLE catalog_embedding_single;
            ",
        )
        .map_err(|error| storage("migrate catalog embedding schema", error))
}

fn apply_payload(transaction: &Transaction<'_>, payload: &CatalogPayload) -> Result<()> {
    match payload {
        CatalogPayload::Snapshot(snapshot) => {
            transaction
                .execute("DELETE FROM catalog_embedding", [])
                .and_then(|_| transaction.execute("DELETE FROM catalog_item", []))
                .and_then(|_| transaction.execute("DELETE FROM catalog_tombstone", []))
                .map_err(|error| storage("clear catalog snapshot target", error))?;
            for item in &snapshot.items {
                upsert_item(transaction, item)?;
            }
            for tombstone in &snapshot.tombstones {
                apply_tombstone(
                    transaction,
                    &tombstone.public_id,
                    tombstone.revision,
                    tombstone.deleted_at_ms,
                )?;
            }
        }
        CatalogPayload::Delta(delta) => {
            for tombstone in &delta.tombstones {
                apply_tombstone(
                    transaction,
                    &tombstone.public_id,
                    tombstone.revision,
                    tombstone.deleted_at_ms,
                )?;
            }
            for item in &delta.upserts {
                upsert_item(transaction, item)?;
            }
        }
    }
    Ok(())
}

fn upsert_item(transaction: &Transaction<'_>, item: &CatalogItem) -> Result<()> {
    let existing_revision: Option<i64> = transaction
        .query_row(
            "SELECT revision FROM catalog_item WHERE public_id = ?1",
            [&item.public_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| storage("read catalog item revision", error))?;
    let tombstone_revision: Option<i64> = transaction
        .query_row(
            "SELECT revision FROM catalog_tombstone WHERE public_id = ?1",
            [&item.public_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| storage("read catalog tombstone revision", error))?;
    if existing_revision
        .map(|revision| from_sql_i64(revision, "catalog revision"))
        .transpose()?
        .is_some_and(|revision| revision >= item.revision)
        || tombstone_revision
            .map(|revision| from_sql_i64(revision, "catalog tombstone revision"))
            .transpose()?
            .is_some_and(|revision| revision >= item.revision)
    {
        return Err(CommunitySearchError::SequenceMismatch);
    }
    let item_json = serde_json::to_string(item)
        .map_err(|error| CommunitySearchError::InvalidCatalog(error.to_string()))?;
    transaction
        .execute(
            "INSERT INTO catalog_item(public_id, revision, kind, item_json, coarse_region, published_at_ms, expires_at_ms, deleted)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0)
             ON CONFLICT(public_id) DO UPDATE SET revision=excluded.revision, kind=excluded.kind,
               item_json=excluded.item_json, coarse_region=excluded.coarse_region,
               published_at_ms=excluded.published_at_ms, expires_at_ms=excluded.expires_at_ms, deleted=0",
            params![
                item.public_id,
                to_sql_i64(item.revision, "catalog revision")?,
                kind_name(item.kind),
                item_json,
                item.coarse_region,
                to_sql_i64(item.published_at_ms, "publication time")?,
                item.expires_at_ms
                    .map(|value| to_sql_i64(value, "content expiry"))
                    .transpose()?
            ],
        )
        .map_err(|error| storage("upsert catalog item", error))?;
    let item_id: i64 = transaction
        .query_row(
            "SELECT id FROM catalog_item WHERE public_id = ?1",
            [&item.public_id],
            |row| row.get(0),
        )
        .map_err(|error| storage("read catalog item id", error))?;
    let model_json = serde_json::to_string(&item.model)
        .map_err(|error| CommunitySearchError::InvalidCatalog(error.to_string()))?;
    transaction
        .execute(
            "DELETE FROM catalog_embedding WHERE item_id = ?1",
            [item_id],
        )
        .map_err(|error| storage("clear superseded catalog embeddings", error))?;
    insert_embedding(
        transaction,
        item_id,
        "primary",
        0,
        &model_json,
        &item.embedding,
    )?;
    for chunk in &item.embedding_chunks {
        insert_embedding(
            transaction,
            item_id,
            embedding_source_name(chunk.source),
            chunk.ordinal,
            &model_json,
            &chunk.embedding,
        )?;
    }
    transaction
        .execute(
            "DELETE FROM catalog_tombstone WHERE public_id = ?1 AND revision < ?2",
            params![
                item.public_id,
                to_sql_i64(item.revision, "catalog revision")?
            ],
        )
        .map_err(|error| storage("clear superseded catalog tombstone", error))?;
    Ok(())
}

fn insert_embedding(
    transaction: &Transaction<'_>,
    item_id: i64,
    source: &str,
    ordinal: u16,
    model_json: &str,
    embedding: &[f32],
) -> Result<()> {
    transaction
        .execute(
            "INSERT INTO catalog_embedding(item_id, source, ordinal, model_json, embedding)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                item_id,
                source,
                i64::from(ordinal),
                model_json,
                encode_embedding(embedding)
            ],
        )
        .map_err(|error| storage("insert catalog embedding chunk", error))?;
    Ok(())
}

fn apply_tombstone(
    transaction: &Transaction<'_>,
    public_id: &str,
    revision: u64,
    deleted_at_ms: u64,
) -> Result<()> {
    let existing_revision: Option<i64> = transaction
        .query_row(
            "SELECT revision FROM catalog_item WHERE public_id = ?1",
            [public_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| storage("read tombstoned item revision", error))?;
    let existing_tombstone_revision: Option<i64> = transaction
        .query_row(
            "SELECT revision FROM catalog_tombstone WHERE public_id = ?1",
            [public_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| storage("read existing catalog tombstone revision", error))?;
    if existing_revision
        .map(|existing| from_sql_i64(existing, "catalog revision"))
        .transpose()?
        .is_some_and(|existing| existing > revision)
        || existing_tombstone_revision
            .map(|existing| from_sql_i64(existing, "catalog tombstone revision"))
            .transpose()?
            .is_some_and(|existing| existing >= revision)
    {
        return Err(CommunitySearchError::SequenceMismatch);
    }
    let revision_sql = to_sql_i64(revision, "catalog tombstone revision")?;
    let deleted_at_sql = to_sql_i64(deleted_at_ms, "catalog deletion time")?;
    transaction
        .execute(
            "INSERT INTO catalog_tombstone(public_id, revision, deleted_at_ms)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(public_id) DO UPDATE SET revision=excluded.revision, deleted_at_ms=excluded.deleted_at_ms
             WHERE excluded.revision > catalog_tombstone.revision",
            params![public_id, revision_sql, deleted_at_sql],
        )
        .map_err(|error| storage("write catalog tombstone", error))?;
    transaction
        .execute(
            "UPDATE catalog_item SET deleted = 1 WHERE public_id = ?1 AND revision <= ?2",
            params![public_id, revision_sql],
        )
        .map_err(|error| storage("apply catalog tombstone", error))?;
    transaction
        .execute(
            "DELETE FROM catalog_embedding WHERE item_id IN (
                SELECT id FROM catalog_item WHERE public_id = ?1 AND revision <= ?2
             )",
            params![public_id, revision_sql],
        )
        .map_err(|error| storage("remove tombstoned embedding", error))?;
    Ok(())
}

fn write_catalog_state(transaction: &Transaction<'_>, manifest: &CatalogManifest) -> Result<()> {
    let item_count: i64 = transaction
        .query_row(
            "SELECT COUNT(*) FROM catalog_item WHERE deleted = 0",
            [],
            |row| row.get(0),
        )
        .map_err(|error| storage("count active catalog items", error))?;
    let item_count_usize = usize::try_from(item_count)
        .map_err(|_| CommunitySearchError::Storage("catalog item count is invalid".to_owned()))?;
    if item_count_usize > MAX_CATALOG_ITEMS {
        return Err(CommunitySearchError::InvalidCatalog(
            "active catalog exceeds the item limit".to_owned(),
        ));
    }
    let model_json = serde_json::to_string(&manifest.unsigned.model)
        .map_err(|error| CommunitySearchError::InvalidCatalog(error.to_string()))?;
    let manifest_hash = hex::encode(Sha256::digest(
        serde_json::to_vec(manifest)
            .map_err(|error| CommunitySearchError::InvalidCatalog(error.to_string()))?,
    ));
    transaction
        .execute(
            "INSERT INTO catalog_state(singleton, sequence, policy_version, manifest_sha256, model_json, item_count)
             VALUES (1, ?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(singleton) DO UPDATE SET sequence=excluded.sequence,
               policy_version=excluded.policy_version, manifest_sha256=excluded.manifest_sha256,
               model_json=excluded.model_json, item_count=excluded.item_count",
            params![
                to_sql_i64(manifest.unsigned.sequence, "catalog sequence")?,
                manifest.unsigned.policy_version,
                manifest_hash,
                model_json,
                item_count
            ],
        )
        .map_err(|error| storage("write catalog state", error))?;
    Ok(())
}

fn build_usearch_index(
    database_path: &Path,
    index_path: &Path,
    model: &ModelContract,
) -> Result<usize> {
    let connection = open_read_only_database(database_path, "open catalog for vector-index build")?;
    let mut statement = connection
        .prepare(
            "SELECT e.id, e.embedding FROM catalog_item i
             JOIN catalog_embedding e ON e.item_id = i.id
             WHERE i.deleted = 0 ORDER BY e.id",
        )
        .map_err(|error| storage("prepare catalog vector-index build", error))?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, Vec<u8>>(1)?))
        })
        .map_err(|error| storage("read catalog embeddings", error))?;
    let mut vectors = Vec::new();
    for row in rows {
        let (key, bytes) = row.map_err(|error| storage("read catalog embedding row", error))?;
        let key = from_sql_i64(key, "catalog item id")?;
        let embedding = decode_embedding(&bytes, model.dimension)?;
        vectors.push((key, embedding));
    }
    let options = IndexOptions {
        dimensions: model.dimension,
        metric: MetricKind::Cos,
        quantization: ScalarKind::F32,
        ..Default::default()
    };
    let index = Index::new(&options)
        .map_err(|error| CommunitySearchError::VectorIndex(error.to_string()))?;
    if !vectors.is_empty() {
        index
            .reserve(vectors.len())
            .map_err(|error| CommunitySearchError::VectorIndex(error.to_string()))?;
        for (key, vector) in &vectors {
            index
                .add(*key, vector)
                .map_err(|error| CommunitySearchError::VectorIndex(error.to_string()))?;
        }
    }
    index
        .save(&path_string(index_path)?)
        .map_err(|error| CommunitySearchError::VectorIndex(error.to_string()))?;
    connection
        .query_row(
            "SELECT COUNT(*) FROM catalog_item WHERE deleted = 0",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| storage("count indexed catalog items", error))
        .and_then(|count| {
            usize::try_from(count).map_err(|_| {
                CommunitySearchError::Storage("catalog item count is invalid".to_owned())
            })
        })
}

fn load_search_item(connection: &Connection, key: u64, now_ms: u64) -> Result<Option<CatalogItem>> {
    let item_json: Option<String> = connection
        .query_row(
            "SELECT i.item_json FROM catalog_embedding e
             JOIN catalog_item i ON i.id = e.item_id
             WHERE e.id = ?1 AND i.deleted = 0
               AND (expires_at_ms IS NULL OR expires_at_ms > ?2)",
            params![
                to_sql_i64(key, "catalog item id")?,
                to_sql_i64(now_ms, "search time")?
            ],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| storage("load catalog search result", error))?;
    item_json
        .map(|value| {
            serde_json::from_str(&value)
                .map_err(|error| CommunitySearchError::Storage(error.to_string()))
        })
        .transpose()
}

fn encode_embedding(vector: &[f32]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(vector.len() * 4);
    for value in vector {
        bytes.extend_from_slice(&value.to_le_bytes());
    }
    bytes
}

fn decode_embedding(bytes: &[u8], dimension: usize) -> Result<Vec<f32>> {
    if bytes.len() != dimension * 4 {
        return Err(CommunitySearchError::InvalidCatalog(
            "stored embedding has an invalid byte length".to_owned(),
        ));
    }
    let vector = bytes
        .chunks_exact(4)
        .map(|chunk| f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
        .collect::<Vec<_>>();
    validate_embedding(&vector, dimension)?;
    Ok(vector)
}

fn open_read_only_database(path: &Path, action: &str) -> Result<Connection> {
    let metadata =
        fs::symlink_metadata(path).map_err(|error| storage("inspect catalog database", error))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(CommunitySearchError::Storage(
            "catalog database must be a regular non-symlink file".to_owned(),
        ));
    }
    let flags = OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX;
    let connection =
        Connection::open_with_flags(path, flags).map_err(|error| storage(action, error))?;
    connection
        .execute_batch(
            "PRAGMA foreign_keys = ON;
             PRAGMA trusted_schema = OFF;
             PRAGMA query_only = ON;
             PRAGMA busy_timeout = 5000;",
        )
        .map_err(|error| storage("configure read-only catalog database", error))?;
    Ok(connection)
}

fn kind_name(kind: CatalogItemKind) -> &'static str {
    match kind {
        CatalogItemKind::Profile => "profile",
        CatalogItemKind::Post => "post",
        CatalogItemKind::ServiceListing => "service_listing",
        CatalogItemKind::ProductListing => "product_listing",
        CatalogItemKind::News => "news",
        CatalogItemKind::Advertisement => "advertisement",
    }
}

fn embedding_source_name(source: CatalogEmbeddingSource) -> &'static str {
    match source {
        CatalogEmbeddingSource::Title => "title",
        CatalogEmbeddingSource::Summary => "summary",
        CatalogEmbeddingSource::Bullet => "bullet",
        CatalogEmbeddingSource::Description => "description",
    }
}

fn path_string(path: &Path) -> Result<String> {
    path.to_str()
        .map(str::to_owned)
        .ok_or_else(|| CommunitySearchError::Storage("catalog path is not valid UTF-8".to_owned()))
}

fn sync_file(path: &Path) -> Result<()> {
    fs::File::open(path)
        .and_then(|file| file.sync_all())
        .map_err(|error| storage("sync catalog file", error))
}

fn sync_directory(path: &Path) -> Result<()> {
    sync_directory_platform(path)
}

#[cfg(unix)]
fn sync_directory_platform(path: &Path) -> Result<()> {
    fs::File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| storage("sync catalog directory", error))
}

#[cfg(not(unix))]
fn sync_directory_platform(_path: &Path) -> Result<()> {
    // Publishing uses a unique final directory and append-only activation
    // marker. Windows does not expose directory fsync through std::fs.
    Ok(())
}

fn storage(context: &str, error: impl std::fmt::Display) -> CommunitySearchError {
    CommunitySearchError::Storage(format!("{context}: {error}"))
}

fn to_sql_i64(value: u64, label: &str) -> Result<i64> {
    i64::try_from(value).map_err(|_| {
        CommunitySearchError::InvalidCatalog(format!("{label} exceeds SQLite's integer range"))
    })
}

fn from_sql_i64(value: i64, label: &str) -> Result<u64> {
    u64::try_from(value).map_err(|_| CommunitySearchError::Storage(format!("{label} is negative")))
}
