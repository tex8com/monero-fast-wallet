use community_search_core::{
    CatalogDelta, CatalogEmbeddingChunk, CatalogEmbeddingSource, CatalogItem, CatalogItemKind,
    CatalogPayload, CatalogSnapshot, CatalogTombstone, CommunitySearchCore, CommunitySearchError,
    LocalQueryEmbedding, ModelContract, SearchFilters, SignedCatalogPackage,
    V1_EMBEDDING_DIMENSION,
};
use ed25519_dalek::SigningKey;
use rand::rngs::OsRng;
use std::fs;

const NOW: u64 = 2_000_000_000_000;
const DAY: u64 = 24 * 60 * 60 * 1_000;

fn model() -> ModelContract {
    ModelContract::harrier_v1()
}

fn unit_vector(axis: usize) -> Vec<f32> {
    let mut vector = vec![0.0; V1_EMBEDDING_DIMENSION];
    vector[axis] = 1.0;
    vector
}

fn query(axis: usize) -> LocalQueryEmbedding {
    LocalQueryEmbedding {
        model: model(),
        embedding: unit_vector(axis),
    }
}

fn item(public_id: &str, revision: u64, axis: usize, kind: CatalogItemKind) -> CatalogItem {
    CatalogItem {
        public_id: public_id.to_owned(),
        revision,
        owner_public_id: format!("owner-{public_id}"),
        kind,
        title: format!("Public {public_id}"),
        summary: "A privacy-focused public community entry.".to_owned(),
        roles: vec!["developer".to_owned()],
        categories: vec!["privacy".to_owned()],
        languages: vec!["en".to_owned()],
        coarse_region: None,
        radius_km: None,
        media: Vec::new(),
        published_at_ms: NOW - DAY,
        expires_at_ms: kind.is_listing().then_some(NOW + 20 * DAY),
        moderation_decision_id: format!("decision-{public_id}-{revision}"),
        sponsorship: None,
        model: model(),
        embedding: unit_vector(axis),
        embedding_chunks: Vec::new(),
    }
}

fn package(payload: &CatalogPayload, signing_key: &SigningKey) -> SignedCatalogPackage {
    SignedCatalogPackage::create(
        payload,
        signing_key,
        "review-panama-v1",
        "community-policy-v1",
        NOW - 1_000,
        NOW + 7 * DAY,
    )
    .unwrap()
}

#[test]
fn signed_snapshot_installs_and_searches_locally() {
    let directory = tempfile::tempdir().unwrap();
    let signing_key = SigningKey::generate(&mut OsRng);
    let core =
        CommunitySearchCore::open(directory.path(), "pa-v1", signing_key.verifying_key()).unwrap();
    let payload = CatalogPayload::Snapshot(CatalogSnapshot {
        schema_version: 1,
        catalog_scope_id: "pa-v1".to_owned(),
        sequence: 1,
        model: model(),
        items: vec![
            item("rust", 1, 0, CatalogItemKind::Profile),
            item("design", 1, 1, CatalogItemKind::Profile),
        ],
        tombstones: Vec::new(),
    });
    let signed = package(&payload, &signing_key);
    let generation = core
        .install(&signed.manifest_json, &signed.payload_json, NOW)
        .unwrap();
    assert_eq!(generation.sequence, 1);
    assert_eq!(generation.items, 2);

    let results = core
        .search(&query(0), 2, &SearchFilters::default(), NOW)
        .unwrap();
    assert_eq!(results.len(), 2);
    assert_eq!(results[0].item.public_id, "rust");
    assert!(results[0].semantic_distance <= results[1].semantic_distance);
}

#[test]
fn multiple_embedding_chunks_rank_and_collapse_to_one_product() {
    let directory = tempfile::tempdir().unwrap();
    let signing_key = SigningKey::generate(&mut OsRng);
    let core =
        CommunitySearchCore::open(directory.path(), "pa-v1", signing_key.verifying_key()).unwrap();
    let mut long_listing = item("long-listing", 1, 0, CatalogItemKind::ProductListing);
    long_listing.embedding_chunks = vec![
        CatalogEmbeddingChunk {
            source: CatalogEmbeddingSource::Bullet,
            ordinal: 0,
            embedding: unit_vector(1),
        },
        CatalogEmbeddingChunk {
            source: CatalogEmbeddingSource::Description,
            ordinal: 0,
            embedding: unit_vector(2),
        },
    ];
    let payload = CatalogPayload::Snapshot(CatalogSnapshot {
        schema_version: 1,
        catalog_scope_id: "pa-v1".to_owned(),
        sequence: 1,
        model: model(),
        items: vec![
            long_listing,
            item("other-listing", 1, 3, CatalogItemKind::ProductListing),
        ],
        tombstones: Vec::new(),
    });
    let signed = package(&payload, &signing_key);
    let installed = core
        .install(&signed.manifest_json, &signed.payload_json, NOW)
        .unwrap();
    assert_eq!(installed.items, 2);

    let results = core
        .search(&query(2), 10, &SearchFilters::default(), NOW)
        .unwrap();
    assert_eq!(
        results
            .iter()
            .map(|result| result.item.public_id.as_str())
            .collect::<Vec<_>>(),
        vec!["long-listing", "other-listing"]
    );
    assert_eq!(results[0].combined_score, 1.0);
}

#[test]
fn duplicate_vector_hits_do_not_consume_distinct_result_slots() {
    let directory = tempfile::tempdir().unwrap();
    let signing_key = SigningKey::generate(&mut OsRng);
    let core =
        CommunitySearchCore::open(directory.path(), "pa-v1", signing_key.verifying_key()).unwrap();
    let mut repeated_listing = item("repeated-listing", 1, 0, CatalogItemKind::ProductListing);
    repeated_listing.embedding_chunks = (0..16)
        .map(|ordinal| CatalogEmbeddingChunk {
            source: CatalogEmbeddingSource::Description,
            ordinal,
            embedding: unit_vector(0),
        })
        .collect();
    let mut items = vec![repeated_listing];
    items.extend((0..25).map(|index| {
        item(
            &format!("distinct-listing-{index:02}"),
            1,
            index + 1,
            CatalogItemKind::ProductListing,
        )
    }));
    let payload = CatalogPayload::Snapshot(CatalogSnapshot {
        schema_version: 1,
        catalog_scope_id: "pa-v1".to_owned(),
        sequence: 1,
        model: model(),
        items,
        tombstones: Vec::new(),
    });
    let signed = package(&payload, &signing_key);
    core.install(&signed.manifest_json, &signed.payload_json, NOW)
        .unwrap();

    let results = core
        .search(&query(0), 25, &SearchFilters::default(), NOW)
        .unwrap();
    let public_ids = results
        .iter()
        .map(|result| result.item.public_id.as_str())
        .collect::<Vec<_>>();

    assert_eq!(results.len(), 25);
    assert_eq!(public_ids[0], "repeated-listing");
    assert_eq!(
        public_ids
            .iter()
            .filter(|public_id| **public_id == "repeated-listing")
            .count(),
        1
    );
}

#[test]
fn duplicate_or_invalid_embedding_chunks_fail_closed() {
    let signing_key = SigningKey::generate(&mut OsRng);
    let mut invalid = item("duplicate", 1, 0, CatalogItemKind::ProductListing);
    invalid.embedding_chunks = vec![
        CatalogEmbeddingChunk {
            source: CatalogEmbeddingSource::Bullet,
            ordinal: 1,
            embedding: unit_vector(1),
        },
        CatalogEmbeddingChunk {
            source: CatalogEmbeddingSource::Bullet,
            ordinal: 1,
            embedding: unit_vector(2),
        },
    ];
    let payload = CatalogPayload::Snapshot(CatalogSnapshot {
        schema_version: 1,
        catalog_scope_id: "pa-v1".to_owned(),
        sequence: 1,
        model: model(),
        items: vec![invalid],
        tombstones: Vec::new(),
    });
    assert!(SignedCatalogPackage::create(
        &payload,
        &signing_key,
        "review-panama-v1",
        "community-policy-v1",
        NOW - 1,
        NOW + DAY
    )
    .is_err());
}

#[test]
fn signature_payload_and_scope_tampering_fail_closed() {
    let directory = tempfile::tempdir().unwrap();
    let signing_key = SigningKey::generate(&mut OsRng);
    let wrong_key = SigningKey::generate(&mut OsRng);
    let payload = CatalogPayload::Snapshot(CatalogSnapshot {
        schema_version: 1,
        catalog_scope_id: "pa-v1".to_owned(),
        sequence: 1,
        model: model(),
        items: vec![item("rust", 1, 0, CatalogItemKind::Profile)],
        tombstones: Vec::new(),
    });
    let signed = package(&payload, &signing_key);

    let wrong_signer_core = CommunitySearchCore::open(
        directory.path().join("wrong-key"),
        "pa-v1",
        wrong_key.verifying_key(),
    )
    .unwrap();
    assert!(matches!(
        wrong_signer_core.install(&signed.manifest_json, &signed.payload_json, NOW),
        Err(CommunitySearchError::InvalidSignature)
    ));

    let core = CommunitySearchCore::open(
        directory.path().join("right-key"),
        "pa-v1",
        signing_key.verifying_key(),
    )
    .unwrap();
    let mut tampered_payload = signed.payload_json.clone();
    let last = tampered_payload.len() - 2;
    tampered_payload[last] ^= 1;
    assert!(matches!(
        core.install(&signed.manifest_json, &tampered_payload, NOW),
        Err(CommunitySearchError::PayloadHashMismatch)
    ));

    let wrong_scope_core = CommunitySearchCore::open(
        directory.path().join("wrong-scope"),
        "uk-v1",
        signing_key.verifying_key(),
    )
    .unwrap();
    assert!(matches!(
        wrong_scope_core.install(&signed.manifest_json, &signed.payload_json, NOW),
        Err(CommunitySearchError::ScopeMismatch)
    ));
}

#[test]
fn delta_tombstone_removes_item_and_exact_network_retry_is_idempotent() {
    let directory = tempfile::tempdir().unwrap();
    let signing_key = SigningKey::generate(&mut OsRng);
    let core =
        CommunitySearchCore::open(directory.path(), "pa-v1", signing_key.verifying_key()).unwrap();
    let snapshot = CatalogPayload::Snapshot(CatalogSnapshot {
        schema_version: 1,
        catalog_scope_id: "pa-v1".to_owned(),
        sequence: 10,
        model: model(),
        items: vec![
            item("rust", 1, 0, CatalogItemKind::Profile),
            item("design", 1, 1, CatalogItemKind::Profile),
        ],
        tombstones: Vec::new(),
    });
    let signed_snapshot = package(&snapshot, &signing_key);
    core.install(
        &signed_snapshot.manifest_json,
        &signed_snapshot.payload_json,
        NOW,
    )
    .unwrap();

    let delta = CatalogPayload::Delta(CatalogDelta {
        schema_version: 1,
        catalog_scope_id: "pa-v1".to_owned(),
        from_sequence: 10,
        to_sequence: 11,
        model: model(),
        upserts: Vec::new(),
        tombstones: vec![CatalogTombstone {
            public_id: "rust".to_owned(),
            revision: 1,
            deleted_at_ms: NOW,
        }],
    });
    let signed_delta = package(&delta, &signing_key);
    core.install(&signed_delta.manifest_json, &signed_delta.payload_json, NOW)
        .unwrap();
    let results = core
        .search(&query(0), 10, &SearchFilters::default(), NOW)
        .unwrap();
    assert_eq!(
        results
            .iter()
            .map(|result| result.item.public_id.as_str())
            .collect::<Vec<_>>(),
        vec!["design"]
    );
    assert_eq!(
        core.install(&signed_delta.manifest_json, &signed_delta.payload_json, NOW)
            .unwrap()
            .sequence,
        11
    );
    let repeated_tombstone = package(
        &CatalogPayload::Delta(CatalogDelta {
            schema_version: 1,
            catalog_scope_id: "pa-v1".to_owned(),
            from_sequence: 11,
            to_sequence: 12,
            model: model(),
            upserts: Vec::new(),
            tombstones: vec![CatalogTombstone {
                public_id: "rust".to_owned(),
                revision: 1,
                deleted_at_ms: NOW + 1,
            }],
        }),
        &signing_key,
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
fn expired_policy_and_expired_listing_are_hidden() {
    let directory = tempfile::tempdir().unwrap();
    let signing_key = SigningKey::generate(&mut OsRng);
    let core =
        CommunitySearchCore::open(directory.path(), "pa-v1", signing_key.verifying_key()).unwrap();
    let mut expired_listing = item("old-service", 1, 0, CatalogItemKind::ServiceListing);
    expired_listing.published_at_ms = NOW - 30 * DAY + 1;
    expired_listing.expires_at_ms = Some(NOW + 1);
    let payload = CatalogPayload::Snapshot(CatalogSnapshot {
        schema_version: 1,
        catalog_scope_id: "pa-v1".to_owned(),
        sequence: 1,
        model: model(),
        items: vec![
            expired_listing,
            item("active-profile", 1, 1, CatalogItemKind::Profile),
        ],
        tombstones: Vec::new(),
    });
    let signed = package(&payload, &signing_key);
    core.install(&signed.manifest_json, &signed.payload_json, NOW)
        .unwrap();
    let visible = core
        .search(&query(0), 10, &SearchFilters::default(), NOW + 2)
        .unwrap();
    assert_eq!(visible.len(), 1);
    assert_eq!(visible[0].item.public_id, "active-profile");
    assert!(matches!(
        core.search(&query(0), 10, &SearchFilters::default(), NOW + 8 * DAY),
        Err(CommunitySearchError::NoActiveGeneration)
    ));
}

#[test]
fn invalid_vector_and_overlong_listing_lifetime_are_rejected() {
    let signing_key = SigningKey::generate(&mut OsRng);
    let mut invalid = item("bad", 1, 0, CatalogItemKind::ServiceListing);
    invalid.embedding[0] = 2.0;
    invalid.expires_at_ms = Some(invalid.published_at_ms + 31 * DAY);
    let payload = CatalogPayload::Snapshot(CatalogSnapshot {
        schema_version: 1,
        catalog_scope_id: "pa-v1".to_owned(),
        sequence: 1,
        model: model(),
        items: vec![invalid],
        tombstones: Vec::new(),
    });
    assert!(SignedCatalogPackage::create(
        &payload,
        &signing_key,
        "review-panama-v1",
        "community-policy-v1",
        NOW - 1,
        NOW + DAY
    )
    .is_err());
}

#[test]
fn wrong_query_model_and_wallet_fields_are_rejected() {
    let directory = tempfile::tempdir().unwrap();
    let signing_key = SigningKey::generate(&mut OsRng);
    let core =
        CommunitySearchCore::open(directory.path(), "pa-v1", signing_key.verifying_key()).unwrap();
    let payload = CatalogPayload::Snapshot(CatalogSnapshot {
        schema_version: 1,
        catalog_scope_id: "pa-v1".to_owned(),
        sequence: 1,
        model: model(),
        items: vec![item("privacy", 1, 0, CatalogItemKind::Profile)],
        tombstones: Vec::new(),
    });
    let signed = package(&payload, &signing_key);
    core.install(&signed.manifest_json, &signed.payload_json, NOW)
        .unwrap();

    let mut wrong_model_query = query(0);
    wrong_model_query.model.query_prompt_version = "other-query-space".to_owned();
    assert!(matches!(
        core.search(&wrong_model_query, 10, &SearchFilters::default(), NOW),
        Err(CommunitySearchError::ModelMismatch)
    ));

    let mut unsafe_json = serde_json::to_value(&payload).unwrap();
    unsafe_json["items"][0]["walletAddress"] = serde_json::json!("not-allowed");
    assert!(serde_json::from_value::<CatalogPayload>(unsafe_json).is_err());
}

#[test]
fn corrupted_newest_generation_falls_back_to_last_verified_generation() {
    let directory = tempfile::tempdir().unwrap();
    let signing_key = SigningKey::generate(&mut OsRng);
    let core =
        CommunitySearchCore::open(directory.path(), "pa-v1", signing_key.verifying_key()).unwrap();
    let first = CatalogPayload::Snapshot(CatalogSnapshot {
        schema_version: 1,
        catalog_scope_id: "pa-v1".to_owned(),
        sequence: 1,
        model: model(),
        items: vec![item("first", 1, 0, CatalogItemKind::Profile)],
        tombstones: Vec::new(),
    });
    let second = CatalogPayload::Snapshot(CatalogSnapshot {
        schema_version: 1,
        catalog_scope_id: "pa-v1".to_owned(),
        sequence: 2,
        model: model(),
        items: vec![item("second", 1, 1, CatalogItemKind::Profile)],
        tombstones: Vec::new(),
    });
    for payload in [&first, &second] {
        let signed = package(payload, &signing_key);
        core.install(&signed.manifest_json, &signed.payload_json, NOW)
            .unwrap();
    }
    let newest_manifest = directory
        .path()
        .join("generations/00000000000000000002/manifest.json");
    let mut manifest: serde_json::Value =
        serde_json::from_slice(&fs::read(&newest_manifest).unwrap()).unwrap();
    manifest["signature"] = serde_json::json!("invalid");
    fs::write(&newest_manifest, serde_json::to_vec(&manifest).unwrap()).unwrap();

    let active = core.active_generation(NOW).unwrap();
    assert_eq!(active.sequence, 1);
    let results = core
        .search(&query(0), 10, &SearchFilters::default(), NOW)
        .unwrap();
    assert_eq!(results[0].item.public_id, "first");
}
