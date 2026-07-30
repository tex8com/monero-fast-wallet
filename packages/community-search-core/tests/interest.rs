use community_search_core::{
    CatalogItem, CatalogItemKind, CatalogPayload, CatalogSnapshot, CommunitySearchCore,
    InterestDomain, InterestSignal, InterestState, LocalQueryEmbedding, ModelContract,
    PersonalizationUpdate, RepetitionFingerprint, SearchFilters, SignedCatalogPackage,
    V1_EMBEDDING_DIMENSION,
};
use ed25519_dalek::SigningKey;
use rand::rngs::OsRng;

const NOW: u64 = 2_000_000_000_000;
const DAY: u64 = 24 * 60 * 60 * 1_000;

fn model() -> ModelContract {
    ModelContract::harrier_v1()
}

fn vector(axis: usize) -> Vec<f32> {
    let mut vector = vec![0.0; V1_EMBEDDING_DIMENSION];
    vector[axis] = 1.0;
    vector
}

fn fingerprint(value: u8) -> RepetitionFingerprint {
    RepetitionFingerprint::from_hex(format!("{value:02x}").repeat(32)).unwrap()
}

fn profile(public_id: &str, embedding: Vec<f32>) -> CatalogItem {
    CatalogItem {
        public_id: public_id.to_owned(),
        revision: 1,
        owner_public_id: format!("owner-{public_id}"),
        kind: CatalogItemKind::Profile,
        title: format!("Profile {public_id}"),
        summary: "A public privacy community profile.".to_owned(),
        roles: Vec::new(),
        categories: vec!["privacy".to_owned()],
        languages: vec!["en".to_owned()],
        coarse_region: None,
        radius_km: None,
        media: Vec::new(),
        published_at_ms: NOW - DAY,
        expires_at_ms: None,
        moderation_decision_id: format!("decision-{public_id}"),
        sponsorship: None,
        model: model(),
        embedding,
        embedding_chunks: Vec::new(),
    }
}

#[test]
fn personalization_is_off_by_default_and_reset_is_complete() {
    let mut state = InterestState::default();
    assert_eq!(
        state
            .record(
                InterestDomain::Discovery,
                InterestSignal::ContentOpened,
                &fingerprint(1),
                &model(),
                &vector(0),
                NOW,
            )
            .unwrap(),
        PersonalizationUpdate::Disabled
    );
    state.set_enabled(true);
    state
        .record(
            InterestDomain::Discovery,
            InterestSignal::MoreLikeThis,
            &fingerprint(1),
            &model(),
            &vector(0),
            NOW,
        )
        .unwrap();
    assert!(
        state
            .personal_score(InterestDomain::Discovery, &model(), &vector(0), NOW)
            .unwrap()
            > 0.0
    );
    state.reset();
    assert_eq!(
        state
            .personal_score(InterestDomain::Discovery, &model(), &vector(0), NOW)
            .unwrap(),
        0.0
    );
}

#[test]
fn reports_and_blocks_are_exclusions_not_interest_signals() {
    let mut state = InterestState::default();
    state.set_enabled(true);
    for signal in [InterestSignal::Reported, InterestSignal::Blocked] {
        assert_eq!(
            state
                .record(
                    InterestDomain::Discovery,
                    signal,
                    &fingerprint(2),
                    &model(),
                    &vector(0),
                    NOW,
                )
                .unwrap(),
            PersonalizationUpdate::ExcludedSafetyAction
        );
    }
    assert_eq!(
        state
            .personal_score(InterestDomain::Discovery, &model(), &vector(0), NOW)
            .unwrap(),
        0.0
    );
}

#[test]
fn repeated_events_are_capped_and_negative_signals_remain_separate() {
    let mut state = InterestState::default();
    state.set_enabled(true);
    for _ in 0..3 {
        assert_eq!(
            state
                .record(
                    InterestDomain::Discovery,
                    InterestSignal::ContentOpened,
                    &fingerprint(3),
                    &model(),
                    &vector(0),
                    NOW,
                )
                .unwrap(),
            PersonalizationUpdate::Applied
        );
    }
    assert_eq!(
        state
            .record(
                InterestDomain::Discovery,
                InterestSignal::ContentOpened,
                &fingerprint(3),
                &model(),
                &vector(0),
                NOW,
            )
            .unwrap(),
        PersonalizationUpdate::RepetitionCapped
    );
    state
        .record(
            InterestDomain::Discovery,
            InterestSignal::LessLikeThis,
            &fingerprint(4),
            &model(),
            &vector(1),
            NOW,
        )
        .unwrap();
    assert!(
        state
            .personal_score(InterestDomain::Discovery, &model(), &vector(1), NOW)
            .unwrap()
            < 0.0
    );
    assert_eq!(
        state
            .record(
                InterestDomain::Discovery,
                InterestSignal::ContentOpened,
                &fingerprint(3),
                &model(),
                &vector(0),
                NOW + DAY,
            )
            .unwrap(),
        PersonalizationUpdate::Applied
    );
}

#[test]
fn unapproved_model_change_is_rejected_without_erasing_valid_state() {
    let mut state = InterestState::default();
    state.set_enabled(true);
    state
        .record(
            InterestDomain::Discovery,
            InterestSignal::MoreLikeThis,
            &fingerprint(5),
            &model(),
            &vector(0),
            NOW,
        )
        .unwrap();
    let mut next_model = model();
    next_model.weights_sha256 = "c".repeat(64);
    assert!(state
        .record(
            InterestDomain::Discovery,
            InterestSignal::MoreLikeThis,
            &fingerprint(6),
            &next_model,
            &vector(1),
            NOW + 1,
        )
        .is_err());
    assert!(
        state
            .personal_score(InterestDomain::Discovery, &model(), &vector(0), NOW + 1)
            .unwrap()
            > 0.0
    );
}

#[test]
fn protected_storage_envelope_is_randomized_and_rejects_tampering() {
    let mut state = InterestState::default();
    state.set_enabled(true);
    state
        .record(
            InterestDomain::News,
            InterestSignal::SavedLocally,
            &fingerprint(7),
            &model(),
            &vector(2),
            NOW,
        )
        .unwrap();
    let key = [42_u8; 32];
    let first = state.seal_for_protected_storage(&key).unwrap();
    let second = state.seal_for_protected_storage(&key).unwrap();
    assert_ne!(first, second);
    let decoded = InterestState::open_from_protected_storage(&first, &key).unwrap();
    assert!(decoded.enabled());

    let mut tampered = first;
    let last = tampered.last_mut().unwrap();
    *last ^= 1;
    assert!(InterestState::open_from_protected_storage(&tampered, &key).is_err());
    assert!(InterestState::open_from_protected_storage(&second, &[41_u8; 32]).is_err());
}

#[test]
fn local_reranking_is_bounded_deterministic_and_opt_in() {
    let directory = tempfile::tempdir().unwrap();
    let signing_key = SigningKey::generate(&mut OsRng);
    let core =
        CommunitySearchCore::open(directory.path(), "pa-v1", signing_key.verifying_key()).unwrap();
    let mut close_match = vector(0);
    close_match[0] = 0.99;
    close_match[1] = (1.0_f32 - 0.99_f32.powi(2)).sqrt();
    let payload = CatalogPayload::Snapshot(CatalogSnapshot {
        schema_version: 1,
        catalog_scope_id: "pa-v1".to_owned(),
        sequence: 1,
        model: model(),
        items: vec![
            profile("semantic-first", vector(0)),
            profile("personal-first", close_match),
        ],
        tombstones: Vec::new(),
    });
    let signed = SignedCatalogPackage::create(
        &payload,
        &signing_key,
        "review-panama-v1",
        "community-policy-v1",
        NOW - 1_000,
        NOW + DAY,
    )
    .unwrap();
    core.install(&signed.manifest_json, &signed.payload_json, NOW)
        .unwrap();
    let query = LocalQueryEmbedding {
        model: model(),
        embedding: vector(0),
    };
    let disabled = InterestState::default();
    let original = core
        .search_personalized(&query, 2, &SearchFilters::default(), &disabled, NOW)
        .unwrap();
    assert_eq!(original[0].item.public_id, "semantic-first");
    assert_eq!(original[0].personal_adjustment, 0.0);

    let mut enabled = InterestState::default();
    enabled.set_enabled(true);
    enabled
        .record(
            InterestDomain::Discovery,
            InterestSignal::MoreLikeThis,
            &fingerprint(8),
            &model(),
            &vector(1),
            NOW,
        )
        .unwrap();
    let reranked = core
        .search_personalized(&query, 2, &SearchFilters::default(), &enabled, NOW)
        .unwrap();
    assert_eq!(reranked[0].item.public_id, "personal-first");
    assert!((0.0..=0.15).contains(&reranked[0].personal_adjustment));
    assert!(reranked[0].combined_score >= reranked[1].combined_score);
}
