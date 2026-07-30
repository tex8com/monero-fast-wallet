use community_search_core::{
    LocalQueryCache, LocalQueryEmbedding, ModelContract, LOCAL_QUERY_LOW_USE_MAX_AGE_MS,
};
use rusqlite::Connection;
use std::fs;
use tempfile::tempdir;

const NOW: u64 = 1_900_000_000_000;

fn query(first: usize) -> LocalQueryEmbedding {
    let model = ModelContract::harrier_v1();
    let mut embedding = vec![0.0; model.dimension];
    embedding[first] = 1.0;
    LocalQueryEmbedding { model, embedding }
}

#[test]
fn entered_queries_are_encrypted_cached_and_suggested() {
    let root = tempdir().unwrap();
    let key = [0x31; 32];
    let cache = LocalQueryCache::open(root.path(), key, 8).unwrap();

    cache
        .record("  Private   MONERO wallet  ", "de", &query(0), NOW)
        .unwrap();
    cache
        .record("Private Monero Wallet", "de", &query(0), NOW + 1)
        .unwrap();
    cache
        .record("Private gardening robot", "de", &query(1), NOW + 2)
        .unwrap();

    let exact = cache
        .lookup("private monero WALLET", "de", &ModelContract::harrier_v1())
        .unwrap()
        .unwrap();
    assert_eq!(exact.display_text, "Private Monero Wallet");
    assert_eq!(exact.query.embedding, query(0).embedding);

    let suggestions = cache
        .suggest("PRIV", "de", &ModelContract::harrier_v1(), 8)
        .unwrap();
    assert_eq!(suggestions.len(), 2);
    assert_eq!(suggestions[0].display_text, "Private Monero Wallet");
    assert!(suggestions[0].query_id.starts_with("local:"));
    assert!(suggestions[0].weight > suggestions[1].weight);

    let database = fs::read(root.path().join("local-queries.sqlite3")).unwrap();
    assert!(!database
        .windows(b"Private Monero Wallet".len())
        .any(|window| window == b"Private Monero Wallet"));
    assert!(!database
        .windows(b"private monero wallet".len())
        .any(|window| window == b"private monero wallet"));
}

#[test]
fn capacity_evicts_the_least_used_oldest_entry_deterministically() {
    let root = tempdir().unwrap();
    let cache = LocalQueryCache::open(root.path(), [0x42; 32], 3).unwrap();
    cache.record("alpha query", "en", &query(0), NOW).unwrap();
    cache
        .record("beta query", "en", &query(1), NOW + 1)
        .unwrap();
    cache
        .record("gamma query", "en", &query(2), NOW + 2)
        .unwrap();
    cache
        .record("alpha query", "en", &query(0), NOW + 3)
        .unwrap();
    cache
        .record("delta query", "en", &query(3), NOW + 4)
        .unwrap();

    assert_eq!(cache.status().unwrap().entries, 3);
    assert!(cache
        .lookup("alpha query", "en", &ModelContract::harrier_v1())
        .unwrap()
        .is_some());
    assert!(cache
        .lookup("beta query", "en", &ModelContract::harrier_v1())
        .unwrap()
        .is_none());
    assert!(cache
        .lookup("gamma query", "en", &ModelContract::harrier_v1())
        .unwrap()
        .is_some());
    assert!(cache
        .lookup("delta query", "en", &ModelContract::harrier_v1())
        .unwrap()
        .is_some());
}

#[test]
fn stale_low_use_queries_expire_but_frequent_queries_survive() {
    let root = tempdir().unwrap();
    let cache = LocalQueryCache::open(root.path(), [0x53; 32], 8).unwrap();
    let old = NOW - LOCAL_QUERY_LOW_USE_MAX_AGE_MS - 1;
    cache
        .record("old rare query", "en", &query(0), old)
        .unwrap();
    for offset in 0..3 {
        cache
            .record("old frequent query", "en", &query(1), old + offset)
            .unwrap();
    }
    cache.prune(NOW).unwrap();

    assert!(cache
        .lookup("old rare query", "en", &ModelContract::harrier_v1())
        .unwrap()
        .is_none());
    assert!(cache
        .lookup("old frequent query", "en", &ModelContract::harrier_v1())
        .unwrap()
        .is_some());
    assert_eq!(cache.status().unwrap().entries, 1);
}

#[test]
fn wrong_key_and_tampered_ciphertext_fail_closed_and_clear_is_complete() {
    let root = tempdir().unwrap();
    let cache = LocalQueryCache::open(root.path(), [0x64; 32], 8).unwrap();
    cache
        .record("sensitive local query", "en", &query(0), NOW)
        .unwrap();
    drop(cache);

    let wrong_key = LocalQueryCache::open(root.path(), [0x65; 32], 8).unwrap();
    let error = wrong_key
        .lookup("sensitive local query", "en", &ModelContract::harrier_v1())
        .unwrap_err();
    assert!(error.to_string().contains("authentication failed"));
    drop(wrong_key);

    let cache = LocalQueryCache::open(root.path(), [0x64; 32], 8).unwrap();
    cache.clear().unwrap();
    assert_eq!(cache.status().unwrap().entries, 0);
    assert!(cache
        .suggest("sensitive", "en", &ModelContract::harrier_v1(), 8)
        .unwrap()
        .is_empty());
}

#[test]
fn suggestions_decrypt_only_metadata_and_exact_lookup_authenticates_the_vector() {
    let root = tempdir().unwrap();
    let cache = LocalQueryCache::open(root.path(), [0x75; 32], 8).unwrap();
    cache
        .record("fast private search", "en", &query(0), NOW)
        .unwrap();

    let connection = Connection::open(root.path().join("local-queries.sqlite3")).unwrap();
    connection
        .execute(
            "UPDATE local_query
             SET embedding_ciphertext = zeroblob(length(embedding_ciphertext))",
            [],
        )
        .unwrap();
    drop(connection);

    let suggestions = cache
        .suggest("fast", "en", &ModelContract::harrier_v1(), 8)
        .unwrap();
    assert_eq!(suggestions.len(), 1);
    assert_eq!(suggestions[0].display_text, "fast private search");

    let error = cache
        .lookup("fast private search", "en", &ModelContract::harrier_v1())
        .unwrap_err();
    assert!(error.to_string().contains("authentication failed"));
}

#[test]
fn version_one_cache_is_securely_discarded_during_metadata_vector_split() {
    let root = tempdir().unwrap();
    let database = root.path().join("local-queries.sqlite3");
    let connection = Connection::open(&database).unwrap();
    connection
        .execute_batch(
            "PRAGMA secure_delete = ON;
             CREATE TABLE local_query_meta (
               singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
               schema_version INTEGER NOT NULL
             ) STRICT;
             INSERT INTO local_query_meta VALUES (1, 1);
             CREATE TABLE local_query (
               record_id BLOB PRIMARY KEY NOT NULL,
               nonce BLOB NOT NULL,
               ciphertext BLOB NOT NULL,
               use_count INTEGER NOT NULL,
               first_used_ms INTEGER NOT NULL,
               last_used_ms INTEGER NOT NULL
             ) STRICT;
             INSERT INTO local_query VALUES (
               randomblob(16), randomblob(24), randomblob(32), 1, 1, 1
             );",
        )
        .unwrap();
    drop(connection);

    let cache = LocalQueryCache::open(root.path(), [0x76; 32], 8).unwrap();
    assert_eq!(cache.status().unwrap().entries, 0);
    cache
        .record("new schema query", "en", &query(0), NOW)
        .unwrap();
    assert_eq!(cache.status().unwrap().entries, 1);
}

#[test]
fn version_two_prompt_cache_is_securely_discarded_during_prompt_migration() {
    let root = tempdir().unwrap();
    let database = root.path().join("local-queries.sqlite3");
    let connection = Connection::open(&database).unwrap();
    connection
        .execute_batch(
            "PRAGMA secure_delete = ON;
             CREATE TABLE local_query_meta (
               singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
               schema_version INTEGER NOT NULL
             ) STRICT;
             INSERT INTO local_query_meta VALUES (1, 2);
             CREATE TABLE local_query (
               record_id BLOB PRIMARY KEY NOT NULL,
               metadata_nonce BLOB NOT NULL,
               metadata_ciphertext BLOB NOT NULL,
               embedding_nonce BLOB NOT NULL,
               embedding_ciphertext BLOB NOT NULL,
               use_count INTEGER NOT NULL,
               first_used_ms INTEGER NOT NULL,
               last_used_ms INTEGER NOT NULL
             ) STRICT;
             INSERT INTO local_query VALUES (
               randomblob(16), randomblob(24), randomblob(32),
               randomblob(24), randomblob(32), 1, 1, 1
             );",
        )
        .unwrap();
    drop(connection);

    let cache = LocalQueryCache::open(root.path(), [0x77; 32], 8).unwrap();
    assert_eq!(cache.status().unwrap().entries, 0);
    cache
        .record("neutral prompt query", "en", &query(0), NOW)
        .unwrap();
    assert_eq!(cache.status().unwrap().entries, 1);

    let connection = Connection::open(&database).unwrap();
    let schema: i64 = connection
        .query_row(
            "SELECT schema_version FROM local_query_meta WHERE singleton = 1",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(schema, 3);
}
