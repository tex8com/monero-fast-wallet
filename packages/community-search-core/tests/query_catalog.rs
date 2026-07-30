use community_search_core::{
    normalize_query_text_v1, CommonQueryCore, CommunitySearchError, ModelContract,
    QueryCatalogDelta, QueryCatalogEntry, QueryCatalogPayload, QueryCatalogSnapshot,
    QueryCatalogTombstone, SignedQueryCatalogPackage, QUERY_NORMALIZATION_VERSION,
    V1_EMBEDDING_DIMENSION,
};
use ed25519_dalek::SigningKey;
use rand::rngs::OsRng;
use rusqlite::Connection;

const NOW: u64 = 2_000_000_000_000;
const DAY: u64 = 24 * 60 * 60 * 1_000;

fn model() -> ModelContract {
    ModelContract::harrier_v1()
}

fn vector(axis: usize) -> Vec<f32> {
    let mut value = vec![0.0; V1_EMBEDDING_DIMENSION];
    value[axis] = 1.0;
    value
}

fn entry(
    id: &str,
    revision: u64,
    display: &str,
    language: &str,
    axis: usize,
    weight: f32,
) -> QueryCatalogEntry {
    QueryCatalogEntry {
        query_id: id.to_owned(),
        revision,
        normalized_text: normalize_query_text_v1(display).unwrap(),
        display_text: display.to_owned(),
        language: language.to_owned(),
        weight,
        model: model(),
        embedding: vector(axis),
    }
}

fn snapshot(sequence: u64, entries: Vec<QueryCatalogEntry>) -> QueryCatalogPayload {
    QueryCatalogPayload::Snapshot(QueryCatalogSnapshot {
        schema_version: 1,
        catalog_scope_id: "pa-queries-v1".to_owned(),
        sequence,
        normalization_version: QUERY_NORMALIZATION_VERSION.to_owned(),
        model: model(),
        entries,
        tombstones: Vec::new(),
    })
}

fn package(payload: &QueryCatalogPayload, key: &SigningKey) -> SignedQueryCatalogPackage {
    SignedQueryCatalogPackage::create(
        payload,
        key,
        "review-panama-v1",
        "community-policy-v1",
        NOW - 1_000,
        NOW + 7 * DAY,
    )
    .unwrap()
}

#[test]
fn signed_common_queries_are_looked_up_and_suggested_only_locally() {
    let directory = tempfile::tempdir().unwrap();
    let key = SigningKey::generate(&mut OsRng);
    let core =
        CommonQueryCore::open(directory.path(), "pa-queries-v1", key.verifying_key()).unwrap();
    let payload = snapshot(
        1,
        vec![
            entry("privacy", 1, "Monero Privacy", "de", 0, 0.8),
            entry("privacy-dev", 1, "Monero Privacy Entwickler", "de", 1, 0.9),
            entry("unrelated", 1, "Rust", "de", 2, 1.0),
        ],
    );
    let signed = package(&payload, &key);
    assert_eq!(
        core.install(&signed.manifest_json, &signed.payload_json, NOW)
            .unwrap(),
        1
    );

    let found = core
        .lookup("  MONERO   Privacy  ", "de", &model(), NOW)
        .unwrap()
        .unwrap();
    assert_eq!(found.query_id, "privacy");
    assert_eq!(found.query.embedding, vector(0));
    assert!(core
        .lookup("not in the signed catalog", "de", &model(), NOW)
        .unwrap()
        .is_none());

    let suggestions = core.suggest("MONERO pri", "de", &model(), 10, NOW).unwrap();
    assert_eq!(suggestions.len(), 2);
    assert_eq!(suggestions[0].query_id, "privacy-dev");
    assert_eq!(suggestions[1].query_id, "privacy");
}

#[test]
fn unicode_normalization_is_versioned_and_deterministic() {
    assert_eq!(
        normalize_query_text_v1("  ＭＯＮＥＲＯ\tPrivacy  ").unwrap(),
        "monero privacy"
    );
    assert!(normalize_query_text_v1("\n").is_err());
    assert!(normalize_query_text_v1("").is_err());
}

#[test]
fn tampering_wrong_scope_and_wrong_model_fail_closed() {
    let directory = tempfile::tempdir().unwrap();
    let key = SigningKey::generate(&mut OsRng);
    let payload = snapshot(1, vec![entry("privacy", 1, "Privacy", "en", 0, 1.0)]);
    let signed = package(&payload, &key);
    let core =
        CommonQueryCore::open(directory.path(), "pa-queries-v1", key.verifying_key()).unwrap();

    let mut tampered = signed.payload_json.clone();
    let position = tampered.iter().position(|byte| *byte == b'P').unwrap();
    tampered[position] = b'X';
    assert!(matches!(
        core.install(&signed.manifest_json, &tampered, NOW),
        Err(CommunitySearchError::PayloadHashMismatch)
    ));

    core.install(&signed.manifest_json, &signed.payload_json, NOW)
        .unwrap();
    let mut wrong_model = model();
    wrong_model.weights_sha256 = "c".repeat(64);
    assert!(matches!(
        core.lookup("privacy", "en", &wrong_model, NOW),
        Err(CommunitySearchError::ModelMismatch)
    ));
}

#[test]
fn signed_delta_tombstones_queries_and_exact_network_retry_is_idempotent() {
    let directory = tempfile::tempdir().unwrap();
    let key = SigningKey::generate(&mut OsRng);
    let core =
        CommonQueryCore::open(directory.path(), "pa-queries-v1", key.verifying_key()).unwrap();
    let initial = package(
        &snapshot(
            1,
            vec![
                entry("privacy", 1, "Privacy", "en", 0, 1.0),
                entry("rust", 1, "Rust", "en", 1, 0.8),
            ],
        ),
        &key,
    );
    core.install(&initial.manifest_json, &initial.payload_json, NOW)
        .unwrap();

    let delta_payload = QueryCatalogPayload::Delta(QueryCatalogDelta {
        schema_version: 1,
        catalog_scope_id: "pa-queries-v1".to_owned(),
        from_sequence: 1,
        to_sequence: 2,
        normalization_version: QUERY_NORMALIZATION_VERSION.to_owned(),
        model: model(),
        upserts: vec![entry("rust", 2, "Rust", "en", 2, 0.95)],
        tombstones: vec![QueryCatalogTombstone {
            normalized_text: "privacy".to_owned(),
            language: "en".to_owned(),
            revision: 2,
            deleted_at_ms: NOW + 1,
        }],
    });
    let delta = package(&delta_payload, &key);
    core.install(&delta.manifest_json, &delta.payload_json, NOW)
        .unwrap();
    assert!(core
        .lookup("privacy", "en", &model(), NOW)
        .unwrap()
        .is_none());
    assert_eq!(
        core.lookup("rust", "en", &model(), NOW)
            .unwrap()
            .unwrap()
            .query
            .embedding,
        vector(2)
    );
    assert_eq!(
        core.install(&delta.manifest_json, &delta.payload_json, NOW)
            .unwrap(),
        2
    );
    let repeated_tombstone = package(
        &QueryCatalogPayload::Delta(QueryCatalogDelta {
            schema_version: 1,
            catalog_scope_id: "pa-queries-v1".to_owned(),
            from_sequence: 2,
            to_sequence: 3,
            normalization_version: QUERY_NORMALIZATION_VERSION.to_owned(),
            model: model(),
            upserts: Vec::new(),
            tombstones: vec![QueryCatalogTombstone {
                normalized_text: "privacy".to_owned(),
                language: "en".to_owned(),
                revision: 2,
                deleted_at_ms: NOW + 2,
            }],
        }),
        &key,
    );
    assert!(matches!(
        core.install(
            &repeated_tombstone.manifest_json,
            &repeated_tombstone.payload_json,
            NOW
        ),
        Err(CommunitySearchError::SequenceMismatch)
    ));
}

#[test]
fn corrupted_newest_generation_falls_back_to_last_verified_generation() {
    let directory = tempfile::tempdir().unwrap();
    let key = SigningKey::generate(&mut OsRng);
    let core =
        CommonQueryCore::open(directory.path(), "pa-queries-v1", key.verifying_key()).unwrap();
    let first = package(
        &snapshot(1, vec![entry("privacy", 1, "Privacy", "en", 0, 1.0)]),
        &key,
    );
    core.install(&first.manifest_json, &first.payload_json, NOW)
        .unwrap();
    let second = package(
        &snapshot(2, vec![entry("rust", 1, "Rust", "en", 1, 1.0)]),
        &key,
    );
    core.install(&second.manifest_json, &second.payload_json, NOW)
        .unwrap();

    let database = directory
        .path()
        .join("generations")
        .join(format!("{:020}", 2))
        .join("queries.sqlite3");
    let connection = Connection::open(database).unwrap();
    connection
        .execute("UPDATE query_state SET item_count = 99", [])
        .unwrap();
    drop(connection);

    assert!(core.lookup("rust", "en", &model(), NOW).unwrap().is_none());
    assert!(core
        .lookup("privacy", "en", &model(), NOW)
        .unwrap()
        .is_some());
}

#[test]
fn malformed_normalization_and_duplicate_keys_are_rejected_before_signing() {
    let key = SigningKey::generate(&mut OsRng);
    let mut malformed = entry("bad", 1, "Privacy", "en", 0, 1.0);
    malformed.normalized_text = "PRIVACY".to_owned();
    assert!(SignedQueryCatalogPackage::create(
        &snapshot(1, vec![malformed]),
        &key,
        "review-panama-v1",
        "community-policy-v1",
        NOW - 1,
        NOW + DAY,
    )
    .is_err());

    let duplicate = entry("same-2", 2, "Privacy", "en", 1, 0.5);
    assert!(SignedQueryCatalogPackage::create(
        &snapshot(
            1,
            vec![entry("same-1", 1, "Privacy", "en", 0, 1.0), duplicate],
        ),
        &key,
        "review-panama-v1",
        "community-policy-v1",
        NOW - 1,
        NOW + DAY,
    )
    .is_err());
}
