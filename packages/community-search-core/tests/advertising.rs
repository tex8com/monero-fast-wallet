use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use chrono::{DateTime, SecondsFormat, Utc};
use community_search_core::{
    AdvertisingCampaign, AdvertisingCampaignStatus, AdvertisingCatalog, AdvertisingCatalogCore,
    AdvertisingKind, AdvertisingLabel, AdvertisingPlacement, AdvertisingSelectionReason,
    CommunitySearchError, InterestDomain, InterestSignal, InterestState, ModelContract,
    RepetitionFingerprint, SignedAdvertisingCatalog, HARRIER_V1_MODEL_ID, V1_EMBEDDING_DIMENSION,
};
use ed25519_dalek::{Signer, SigningKey};
use rand::rngs::OsRng;

const NOW: u64 = 2_000_000_000_000;
const MINUTE: u64 = 60 * 1_000;
const DAY: u64 = 24 * 60 * MINUTE;

fn timestamp(value: u64) -> String {
    DateTime::<Utc>::from_timestamp_millis(i64::try_from(value).unwrap())
        .unwrap()
        .to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn unit_vector(axis: usize) -> Vec<f32> {
    let mut vector = vec![0.0; V1_EMBEDDING_DIMENSION];
    vector[axis] = 1.0;
    vector
}

fn campaign(id: &str, starts_at: u64, ends_at: u64, frequency_cap: u16) -> AdvertisingCampaign {
    AdvertisingCampaign {
        campaign_id: id.to_owned(),
        content_revision: 1,
        advertiser_id: format!("advertiser-{id}"),
        advertiser_display_name: "Example Hardware Company".to_owned(),
        paid_by_id: format!("payer-{id}"),
        paid_by_display_name: "Example Hardware Company".to_owned(),
        kind: AdvertisingKind::OrdinaryProduct,
        placement: AdvertisingPlacement::News,
        title: "Protect your hardware wallet".to_owned(),
        body: "Learn about a reviewed hardware wallet product.".to_owned(),
        destination_url: "https://example.com/hardware".to_owned(),
        media_url: Some("https://cdn.tex8.com/ads/hardware.webp".to_owned()),
        starts_at: timestamp(starts_at),
        ends_at: timestamp(ends_at),
        eligible_categories: vec!["hardware".to_owned(), "privacy".to_owned()],
        eligible_regions: vec!["US".to_owned(), "DE".to_owned()],
        placement_weight: 50,
        frequency_cap,
        sponsorship_label: AdvertisingLabel::Advertisement,
        embedding_model: Some(HARRIER_V1_MODEL_ID.to_owned()),
        embedding: Some(unit_vector(0)),
        status: AdvertisingCampaignStatus::Approved,
        created_at: timestamp(starts_at.saturating_sub(DAY)),
        reviewed_at: Some(timestamp(starts_at.saturating_sub(MINUTE))),
        jurisdiction_review_id: Some("legal-review-2026-07".to_owned()),
    }
}

fn signed_response(
    signing_key: &SigningKey,
    generation: u64,
    generated_at: u64,
    scope: &str,
    campaigns: Vec<AdvertisingCampaign>,
) -> Vec<u8> {
    let catalog = AdvertisingCatalog {
        catalog_scope_id: scope.to_owned(),
        jurisdiction_review_ids: vec!["legal-review-2026-07".to_owned()],
        policy_version: "ads-test-v1".to_owned(),
        generation,
        generated_at: timestamp(generated_at),
        expires_at: timestamp(generated_at + 10 * MINUTE),
        campaigns,
    };
    let bytes = serde_json::to_vec(&catalog).unwrap();
    serde_json::to_vec(&SignedAdvertisingCatalog {
        catalog,
        signed_catalog: BASE64.encode(&bytes),
        algorithm: "Ed25519".to_owned(),
        signing_key_id: "local-test-key-1".to_owned(),
        signing_public_key: BASE64.encode(signing_key.verifying_key().as_bytes()),
        signature: BASE64.encode(signing_key.sign(&bytes).to_bytes()),
    })
    .unwrap()
}

#[test]
fn signed_catalog_is_persistent_renderer_safe_and_frequency_capped_locally() {
    let directory = tempfile::tempdir().unwrap();
    let signing_key = SigningKey::generate(&mut OsRng);
    let response = signed_response(
        &signing_key,
        1,
        NOW,
        "ads:US:news",
        vec![campaign("hardware-1", NOW - MINUTE, NOW + 7 * DAY, 2)],
    );
    let core = AdvertisingCatalogCore::open(directory.path(), signing_key.verifying_key()).unwrap();
    assert_eq!(
        core.install(&response, "US", AdvertisingPlacement::News, NOW)
            .unwrap(),
        1
    );
    assert_eq!(
        core.install(&response, "us", AdvertisingPlacement::News, NOW)
            .unwrap(),
        1
    );

    let first = core
        .select("US", AdvertisingPlacement::News, 1, None, NOW)
        .unwrap();
    assert_eq!(first.len(), 1);
    assert_eq!(
        first[0].selection_reason,
        AdvertisingSelectionReason::ContextualPlacement
    );
    let rendered = serde_json::to_value(&first[0]).unwrap();
    assert!(rendered.get("embedding").is_none());
    assert!(rendered.get("embeddingModel").is_none());
    assert_eq!(rendered["paidByDisplayName"], "Example Hardware Company");

    assert!(core
        .record_view("US", AdvertisingPlacement::News, "hardware-1", NOW)
        .unwrap());
    assert!(core
        .record_view("US", AdvertisingPlacement::News, "hardware-1", NOW + MINUTE)
        .unwrap());
    assert!(core
        .select("US", AdvertisingPlacement::News, 1, None, NOW + 2 * MINUTE)
        .unwrap()
        .is_empty());
    assert!(!core
        .record_view(
            "US",
            AdvertisingPlacement::News,
            "hardware-1",
            NOW + 2 * MINUTE
        )
        .unwrap());

    let reopened =
        AdvertisingCatalogCore::open(directory.path(), signing_key.verifying_key()).unwrap();
    assert!(reopened
        .select("US", AdvertisingPlacement::News, 1, None, NOW + 3 * MINUTE)
        .unwrap()
        .is_empty());

    let next_day = NOW + DAY;
    let refreshed = signed_response(
        &signing_key,
        2,
        next_day,
        "ads:US:news",
        vec![campaign("hardware-1", NOW - MINUTE, NOW + 7 * DAY, 2)],
    );
    reopened
        .install(&refreshed, "US", AdvertisingPlacement::News, next_day)
        .unwrap();
    assert_eq!(
        reopened
            .select("US", AdvertisingPlacement::News, 1, None, next_day)
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn signature_key_visible_payload_scope_expiry_and_rollback_fail_closed() {
    let directory = tempfile::tempdir().unwrap();
    let signing_key = SigningKey::generate(&mut OsRng);
    let wrong_key = SigningKey::generate(&mut OsRng);
    let valid = signed_response(
        &signing_key,
        4,
        NOW,
        "ads:US:news",
        vec![campaign("hardware-1", NOW - MINUTE, NOW + DAY, 1)],
    );

    let wrong_key_core =
        AdvertisingCatalogCore::open(directory.path().join("wrong"), wrong_key.verifying_key())
            .unwrap();
    assert!(matches!(
        wrong_key_core.install(&valid, "US", AdvertisingPlacement::News, NOW),
        Err(CommunitySearchError::InvalidSignature)
    ));

    let core =
        AdvertisingCatalogCore::open(directory.path().join("right"), signing_key.verifying_key())
            .unwrap();
    let mut visible_tampering: serde_json::Value = serde_json::from_slice(&valid).unwrap();
    visible_tampering["catalog"]["campaigns"][0]["title"] =
        serde_json::Value::String("Tampered but plausible title".to_owned());
    assert!(matches!(
        core.install(
            &serde_json::to_vec(&visible_tampering).unwrap(),
            "US",
            AdvertisingPlacement::News,
            NOW
        ),
        Err(CommunitySearchError::PayloadHashMismatch)
    ));

    let mut signature_tampering: serde_json::Value = serde_json::from_slice(&valid).unwrap();
    signature_tampering["signature"] = serde_json::Value::String(BASE64.encode([0_u8; 64]));
    assert!(matches!(
        core.install(
            &serde_json::to_vec(&signature_tampering).unwrap(),
            "US",
            AdvertisingPlacement::News,
            NOW
        ),
        Err(CommunitySearchError::InvalidSignature)
    ));

    let wrong_scope = signed_response(
        &signing_key,
        4,
        NOW,
        "ads:DE:news",
        vec![campaign("hardware-1", NOW - MINUTE, NOW + DAY, 1)],
    );
    assert!(matches!(
        core.install(&wrong_scope, "US", AdvertisingPlacement::News, NOW),
        Err(CommunitySearchError::ScopeMismatch)
    ));
    assert!(matches!(
        core.install(&valid, "US", AdvertisingPlacement::News, NOW + 10 * MINUTE),
        Err(CommunitySearchError::PolicyExpired)
    ));

    core.install(&valid, "US", AdvertisingPlacement::News, NOW)
        .unwrap();
    let rollback = signed_response(
        &signing_key,
        3,
        NOW + MINUTE,
        "ads:US:news",
        vec![campaign("hardware-2", NOW - MINUTE, NOW + DAY, 1)],
    );
    assert!(matches!(
        core.install(&rollback, "US", AdvertisingPlacement::News, NOW + MINUTE),
        Err(CommunitySearchError::SequenceMismatch)
    ));
}

#[test]
fn enabled_local_interest_state_can_rank_without_leaving_device() {
    let directory = tempfile::tempdir().unwrap();
    let signing_key = SigningKey::generate(&mut OsRng);
    let core = AdvertisingCatalogCore::open(directory.path(), signing_key.verifying_key()).unwrap();
    let response = signed_response(
        &signing_key,
        1,
        NOW,
        "ads:US:news",
        vec![campaign("hardware-1", NOW - MINUTE, NOW + DAY, 3)],
    );
    core.install(&response, "US", AdvertisingPlacement::News, NOW)
        .unwrap();

    let mut interests = InterestState::default();
    interests.set_enabled(true);
    interests
        .record(
            InterestDomain::Advertising,
            InterestSignal::MoreLikeThis,
            &RepetitionFingerprint::from_hex("a".repeat(64)).unwrap(),
            &ModelContract::harrier_v1(),
            &unit_vector(0),
            NOW,
        )
        .unwrap();

    let selected = core
        .select("US", AdvertisingPlacement::News, 1, Some(&interests), NOW)
        .unwrap();
    assert_eq!(selected.len(), 1);
    assert_eq!(
        selected[0].selection_reason,
        AdvertisingSelectionReason::LocalInterests
    );
}
