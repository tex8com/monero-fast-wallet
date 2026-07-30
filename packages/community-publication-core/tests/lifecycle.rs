use community_publication_core::{
    ModeratorDecision, PublicContentDraft, PublicContentKind, PublicationError, PublicationStatus,
    PublicationStore, ScheduledAction, ScreeningAssessment, ScreeningOutcome,
};
use community_search_core::{
    CatalogEmbeddingChunk, CatalogEmbeddingSource, CatalogPayload, CatalogSnapshot,
    CommunitySearchCore, LocalQueryEmbedding, SearchFilters, SignedCatalogPackage,
};
use community_search_core::{ModelContract, V1_EMBEDDING_DIMENSION};
use ed25519_dalek::SigningKey;
use rand::rngs::OsRng;
use std::fs;

const NOW: u64 = 2_000_000_000_000;
const DAY: u64 = 24 * 60 * 60 * 1_000;

fn model() -> ModelContract {
    ModelContract::harrier_v1()
}

fn embedding() -> Vec<f32> {
    let mut result = vec![0.0; V1_EMBEDDING_DIMENSION];
    result[0] = 1.0;
    result
}

fn embedding_at(axis: usize) -> Vec<f32> {
    let mut result = vec![0.0; V1_EMBEDDING_DIMENSION];
    result[axis] = 1.0;
    result
}

fn listing() -> PublicContentDraft {
    PublicContentDraft {
        kind: PublicContentKind::ServiceListing,
        title: "Privacy-first mobile development".to_owned(),
        summary: "Architecture and implementation for useful private applications.".to_owned(),
        roles: vec!["developer".to_owned()],
        categories: vec!["software".to_owned(), "privacy".to_owned()],
        languages: vec!["en".to_owned(), "de".to_owned()],
        coarse_region: None,
        radius_km: None,
        media: Vec::new(),
    }
}

fn clear_screening() -> ScreeningAssessment {
    ScreeningAssessment {
        model_version: "policy-model-v1".to_owned(),
        rules_version: "community-rules-v1".to_owned(),
        confidence: 0.98,
        triggered_policy: "none".to_owned(),
        outcome: ScreeningOutcome::Clear,
        optional_wording_suggestion: None,
    }
}

#[test]
fn complete_listing_lifecycle_is_moderated_expires_and_republishes() {
    let store = PublicationStore::in_memory([7u8; 32]).unwrap();
    let submitted = store.submit("owner-alice", listing(), NOW).unwrap();
    assert_eq!(submitted.status, PublicationStatus::AwaitingScreening);

    let moderation_case = store
        .record_screening(
            &submitted.public_id,
            submitted.revision,
            &clear_screening(),
            NOW + 1,
        )
        .unwrap();
    let approved = store
        .moderate(
            &moderation_case.case_id,
            "moderator-one",
            ModeratorDecision::Approve,
            "The public entry follows the current Community Rules.",
            NOW + 2,
        )
        .unwrap();
    assert_eq!(
        approved.status,
        PublicationStatus::ApprovedAwaitingEmbedding
    );
    let outcome = store.run_scheduled(NOW + 2).unwrap();
    assert!(matches!(
        &outcome[0],
        ScheduledAction::ModerationOutcomeNotice {
            recipient_public_id,
            ..
        } if recipient_public_id == "owner-alice"
    ));
    let outcome_delivery_id = match &outcome[0] {
        ScheduledAction::ModerationOutcomeNotice { delivery_id, .. } => delivery_id,
        _ => unreachable!(),
    };
    store
        .acknowledge_scheduled_delivery(outcome_delivery_id, "provider-worker", NOW + 2)
        .unwrap();
    let published = store
        .publish_with_embedding(
            &submitted.public_id,
            submitted.revision,
            &model(),
            &embedding(),
            NOW + 3,
        )
        .unwrap();
    assert_eq!(published.status, PublicationStatus::Published);
    assert_eq!(published.expires_at_ms, Some(NOW + 3 + 30 * DAY));
    assert_eq!(store.catalog_records(NOW + 4).unwrap().len(), 1);

    let reminder_time = published.expires_at_ms.unwrap() - DAY;
    let reminder = store.run_scheduled(reminder_time).unwrap();
    assert_eq!(reminder.len(), 1);
    assert!(matches!(
        &reminder[0],
        ScheduledAction::ListingExpiryReminder { public_id, .. }
            if public_id == &submitted.public_id
    ));
    assert!(store.run_scheduled(reminder_time + 1).unwrap().is_empty());
    let delivery_id = match &reminder[0] {
        ScheduledAction::ListingExpiryReminder { delivery_id, .. } => delivery_id,
        _ => unreachable!(),
    };
    store
        .acknowledge_scheduled_delivery(delivery_id, "provider-worker", reminder_time + 2)
        .unwrap();
    assert!(store
        .run_scheduled(reminder_time + 10 * 60 * 1_000)
        .unwrap()
        .is_empty());

    let expired = store
        .run_scheduled(published.expires_at_ms.unwrap())
        .unwrap();
    assert!(matches!(
        &expired[0],
        ScheduledAction::ListingExpired { public_id, .. }
            if public_id == &submitted.public_id
    ));
    assert!(store
        .catalog_records(published.expires_at_ms.unwrap())
        .unwrap()
        .is_empty());
    assert_eq!(store.catalog_tombstones().unwrap().len(), 1);

    let republished_draft = listing();
    let second = store
        .resubmit(
            "owner-alice",
            &submitted.public_id,
            republished_draft,
            published.expires_at_ms.unwrap() + 1,
        )
        .unwrap();
    assert_eq!(second.revision, 2);
    assert_eq!(second.status, PublicationStatus::AwaitingScreening);
}

#[test]
fn wording_suggestion_never_auto_publishes_and_dangerous_rewrite_is_rejected() {
    let store = PublicationStore::in_memory([8u8; 32]).unwrap();
    let submitted = store.submit("owner-alice", listing(), NOW).unwrap();
    let wording = ScreeningAssessment {
        model_version: "policy-model-v1".to_owned(),
        rules_version: "community-rules-v1".to_owned(),
        confidence: 0.8,
        triggered_policy: "wording".to_owned(),
        outcome: ScreeningOutcome::WordingOnly,
        optional_wording_suggestion: Some(
            "Describe the service without an unsupported guarantee.".to_owned(),
        ),
    };
    store
        .record_screening(&submitted.public_id, 1, &wording, NOW + 1)
        .unwrap();
    let latest = store.latest(&submitted.public_id).unwrap();
    assert_eq!(latest.status, PublicationStatus::NeedsChanges);
    assert!(latest.wording_suggestion.is_some());
    assert!(store.catalog_records(NOW + 2).unwrap().is_empty());

    let dangerous = ScreeningAssessment {
        outcome: ScreeningOutcome::DangerousOrProhibited,
        optional_wording_suggestion: Some("Disguised wording".to_owned()),
        ..clear_screening()
    };
    let second = store
        .resubmit("owner-alice", &submitted.public_id, listing(), NOW + 2)
        .unwrap();
    assert!(store
        .record_screening(&second.public_id, second.revision, &dangerous, NOW + 3)
        .is_err());
}

#[test]
fn reports_are_durable_encrypted_and_support_appeal_and_reinstatement() {
    let directory = tempfile::tempdir().unwrap();
    let database = directory.path().join("publication.sqlite3");
    let store = PublicationStore::open(&database, [9u8; 32]).unwrap();
    let submitted = store.submit("owner-alice", listing(), NOW).unwrap();
    let initial = store
        .record_screening(&submitted.public_id, 1, &clear_screening(), NOW + 1)
        .unwrap();
    store
        .moderate(
            &initial.case_id,
            "moderator-one",
            ModeratorDecision::Approve,
            "Approved for the public catalog.",
            NOW + 2,
        )
        .unwrap();
    store
        .publish_with_embedding(&submitted.public_id, 1, &model(), &embedding(), NOW + 3)
        .unwrap();
    let report_reason = "This profile makes a specific misleading public claim.";
    let report = store
        .report(
            "reporter-bob",
            &submitted.public_id,
            1,
            report_reason,
            false,
            NOW + 4,
        )
        .unwrap();
    store
        .moderate(
            &report.case_id,
            "moderator-two",
            ModeratorDecision::Hide,
            "Hidden pending more evidence.",
            NOW + 5,
        )
        .unwrap();
    let author_outcome = store
        .moderation_outcomes_for_actor("owner-alice", 10)
        .unwrap()
        .into_iter()
        .find(|outcome| outcome.case_id == report.case_id)
        .unwrap();
    assert!(author_outcome.affected_author);
    assert_eq!(
        author_outcome.decision_reason.as_deref(),
        Some("Hidden pending more evidence.")
    );
    let reporter_outcome = store
        .moderation_outcomes_for_actor("reporter-bob", 10)
        .unwrap()
        .into_iter()
        .find(|outcome| outcome.case_id == report.case_id)
        .unwrap();
    assert!(!reporter_outcome.affected_author);
    assert_eq!(reporter_outcome.decision.as_deref(), Some("hide"));
    store
        .appeal(
            "owner-alice",
            &report.case_id,
            "The referenced claim can be independently verified.",
            NOW + 6,
        )
        .unwrap();
    assert!(
        store
            .moderation_outcomes_for_actor("owner-alice", 10)
            .unwrap()
            .into_iter()
            .find(|outcome| outcome.case_id == report.case_id)
            .unwrap()
            .appeal_pending
    );
    let reinstated = store
        .moderate(
            &report.case_id,
            "moderator-three",
            ModeratorDecision::Reinstate,
            "The appeal supplied sufficient evidence.",
            NOW + 7,
        )
        .unwrap();
    assert_eq!(
        reinstated.status,
        PublicationStatus::ApprovedAwaitingEmbedding
    );
    assert_eq!(reinstated.revision, 2);

    let database_bytes = fs::read(database).unwrap();
    assert!(!database_bytes
        .windows(report_reason.len())
        .any(|window| window == report_reason.as_bytes()));
    let unpublished_draft_text = "Architecture and implementation for useful private applications.";
    assert!(!database_bytes
        .windows(unpublished_draft_text.len())
        .any(|window| window == unpublished_draft_text.as_bytes()));
}

#[test]
fn moderation_queue_alert_acknowledgement_and_escalation_are_durable() {
    let store = PublicationStore::in_memory([11u8; 32]).unwrap();
    let submitted = store.submit("owner-alice", listing(), NOW).unwrap();
    let case = store
        .record_screening(
            &submitted.public_id,
            submitted.revision,
            &clear_screening(),
            NOW + 1,
        )
        .unwrap();
    let first = store.run_scheduled(NOW + 2).unwrap();
    assert!(first.iter().any(
        |action| matches!(action, ScheduledAction::ModerationQueueAlert { case_id, .. } if case_id == &case.case_id)
    ));
    assert!(store.run_scheduled(NOW + 3).unwrap().is_empty());
    store
        .acknowledge_moderation_case(&case.case_id, "moderator-one", NOW + 4)
        .unwrap();
    let queue = store.moderation_queue(10).unwrap();
    assert_eq!(queue.len(), 1);
    assert_eq!(queue[0].acknowledged_by.as_deref(), Some("moderator-one"));
    assert!(store
        .run_scheduled(NOW + 5 * 60 * 60 * 1_000)
        .unwrap()
        .is_empty());

    let second = store.submit("owner-bob", listing(), NOW + 10).unwrap();
    let second_case = store
        .record_screening(
            &second.public_id,
            second.revision,
            &clear_screening(),
            NOW + 11,
        )
        .unwrap();
    store.run_scheduled(NOW + 12).unwrap();
    let overdue = store.run_scheduled(NOW + 5 * 60 * 60 * 1_000).unwrap();
    assert!(overdue.iter().any(
        |action| matches!(action, ScheduledAction::ModerationOverdue { case_id, .. } if case_id == &second_case.case_id)
    ));
    for action in &overdue {
        let delivery_id = match action {
            ScheduledAction::ListingExpiryReminder { delivery_id, .. }
            | ScheduledAction::ModerationQueueAlert { delivery_id, .. }
            | ScheduledAction::ModerationOverdue { delivery_id, .. }
            | ScheduledAction::ModerationOutcomeNotice { delivery_id, .. } => delivery_id,
            ScheduledAction::ListingExpired { .. } => continue,
        };
        store
            .acknowledge_scheduled_delivery(
                delivery_id,
                "provider-worker",
                NOW + 5 * 60 * 60 * 1_000 + 1,
            )
            .unwrap();
    }
    assert!(store
        .run_scheduled(NOW + 6 * 60 * 60 * 1_000)
        .unwrap()
        .is_empty());
}

#[test]
fn unacknowledged_scheduled_delivery_is_reclaimed_after_lease() {
    let store = PublicationStore::in_memory([12u8; 32]).unwrap();
    let submitted = store.submit("owner-alice", listing(), NOW).unwrap();
    let case = store
        .record_screening(
            &submitted.public_id,
            submitted.revision,
            &clear_screening(),
            NOW + 1,
        )
        .unwrap();
    let first = store.run_scheduled(NOW + 2).unwrap();
    let first_delivery = first
        .iter()
        .find_map(|action| match action {
            ScheduledAction::ModerationQueueAlert {
                delivery_id,
                case_id,
            } if case_id == &case.case_id => Some(delivery_id.clone()),
            _ => None,
        })
        .unwrap();
    assert!(store.run_scheduled(NOW + 60_000).unwrap().is_empty());
    let reclaimed = store.run_scheduled(NOW + 6 * 60_000).unwrap();
    assert!(reclaimed.iter().any(|action| matches!(
        action,
        ScheduledAction::ModerationQueueAlert {
            delivery_id,
            case_id,
        } if delivery_id == &first_delivery && case_id == &case.case_id
    )));
}

#[test]
fn typed_draft_rejects_marketplace_and_wallet_fields() {
    let value = serde_json::json!({
        "kind": "service_listing",
        "title": "Service",
        "summary": "Public summary",
        "roles": [],
        "categories": ["software"],
        "languages": ["en"],
        "coarseRegion": null,
        "radiusKm": null,
        "media": [],
        "price": "10 XMR",
        "walletAddress": "forbidden"
    });
    assert!(serde_json::from_value::<PublicContentDraft>(value).is_err());
}

#[test]
fn unauthorized_owner_cannot_resubmit_or_withdraw() {
    let store = PublicationStore::in_memory([10u8; 32]).unwrap();
    let submitted = store.submit("owner-alice", listing(), NOW).unwrap();
    assert!(matches!(
        store.resubmit("owner-mallory", &submitted.public_id, listing(), NOW + 1),
        Err(PublicationError::Unauthorized)
    ));
    assert!(matches!(
        store.withdraw(
            "owner-mallory",
            &submitted.public_id,
            submitted.revision,
            NOW + 1
        ),
        Err(PublicationError::Unauthorized)
    ));
}

#[test]
fn deleting_an_owner_tombstones_public_content_and_redacts_unheld_drafts() {
    let directory = tempfile::tempdir().unwrap();
    let database = directory.path().join("publication.sqlite3");
    let store = PublicationStore::open(&database, [13u8; 32]).unwrap();
    let submitted = store.submit("owner-alice", listing(), NOW).unwrap();
    let moderation_case = store
        .record_screening(
            &submitted.public_id,
            submitted.revision,
            &clear_screening(),
            NOW + 1,
        )
        .unwrap();
    store
        .moderate(
            &moderation_case.case_id,
            "moderator-one",
            ModeratorDecision::Approve,
            "Approved.",
            NOW + 2,
        )
        .unwrap();
    store
        .publish_with_embedding(
            &submitted.public_id,
            submitted.revision,
            &model(),
            &embedding(),
            NOW + 3,
        )
        .unwrap();
    assert_eq!(store.delete_owner("owner-alice", NOW + 4).unwrap(), 1);
    assert!(store.catalog_records(NOW + 5).unwrap().is_empty());
    assert_eq!(store.catalog_tombstones().unwrap().len(), 1);
    assert_eq!(
        store.latest(&submitted.public_id).unwrap().draft.title,
        "Deleted profile"
    );
    drop(store);
    let bytes = fs::read(database).unwrap();
    assert!(!bytes
        .windows(b"Privacy-first mobile development".len())
        .any(|window| window == b"Privacy-first mobile development"));
}

#[test]
fn moderated_content_reaches_only_the_signed_local_search_path() {
    let publication = PublicationStore::in_memory([11u8; 32]).unwrap();
    let submitted = publication.submit("owner-alice", listing(), NOW).unwrap();
    let moderation_case = publication
        .record_screening(&submitted.public_id, 1, &clear_screening(), NOW + 1)
        .unwrap();
    publication
        .moderate(
            &moderation_case.case_id,
            "moderator-one",
            ModeratorDecision::Approve,
            "The entry is suitable for the current public catalog.",
            NOW + 2,
        )
        .unwrap();
    publication
        .publish_with_embedding_chunks(
            &submitted.public_id,
            1,
            &model(),
            &embedding(),
            &[CatalogEmbeddingChunk {
                source: CatalogEmbeddingSource::Description,
                ordinal: 0,
                embedding: embedding_at(1),
            }],
            NOW + 3,
        )
        .unwrap();

    let catalog_records = publication.catalog_records(NOW + 4).unwrap();
    assert_eq!(catalog_records[0].embedding_chunks.len(), 1);
    let payload = CatalogPayload::Snapshot(CatalogSnapshot {
        schema_version: 1,
        catalog_scope_id: "pa-v1".to_owned(),
        sequence: 1,
        model: model(),
        items: catalog_records,
        tombstones: publication.catalog_tombstones().unwrap(),
    });
    let signing_key = SigningKey::generate(&mut OsRng);
    let signed = SignedCatalogPackage::create(
        &payload,
        &signing_key,
        "review-panama-v1",
        "community-policy-v1",
        NOW,
        NOW + 7 * DAY,
    )
    .unwrap();
    let local_directory = tempfile::tempdir().unwrap();
    let local_search =
        CommunitySearchCore::open(local_directory.path(), "pa-v1", signing_key.verifying_key())
            .unwrap();
    local_search
        .install(&signed.manifest_json, &signed.payload_json, NOW + 1)
        .unwrap();
    let results = local_search
        .search(
            &LocalQueryEmbedding {
                model: model(),
                embedding: embedding_at(1),
            },
            10,
            &SearchFilters::default(),
            NOW + 2,
        )
        .unwrap();
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].item.public_id, submitted.public_id);
}
