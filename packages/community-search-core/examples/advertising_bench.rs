use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use chrono::{DateTime, SecondsFormat, Utc};
use community_search_core::{
    AdvertisingCampaign, AdvertisingCampaignStatus, AdvertisingCatalog, AdvertisingCatalogCore,
    AdvertisingKind, AdvertisingLabel, AdvertisingPlacement, SignedAdvertisingCatalog,
    HARRIER_V1_MODEL_ID, V1_EMBEDDING_DIMENSION,
};
use ed25519_dalek::{Signer, SigningKey};
use serde_json::json;
use std::{
    fs,
    hint::black_box,
    time::{Duration, Instant},
};

const NOW: u64 = 2_000_000_000_000;
const INSTALLATIONS: usize = 100;
const SELECTIONS: usize = 10_000;

fn timestamp(value: u64) -> String {
    DateTime::<Utc>::from_timestamp_millis(i64::try_from(value).unwrap())
        .unwrap()
        .to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn campaign() -> AdvertisingCampaign {
    let mut embedding = vec![0.0; V1_EMBEDDING_DIMENSION];
    embedding[0] = 1.0;
    AdvertisingCampaign {
        campaign_id: "hardware-1".to_owned(),
        content_revision: 1,
        advertiser_id: "advertiser-hardware".to_owned(),
        advertiser_display_name: "Example Hardware Company".to_owned(),
        paid_by_id: "payer-hardware".to_owned(),
        paid_by_display_name: "Example Hardware Company".to_owned(),
        kind: AdvertisingKind::OrdinaryProduct,
        placement: AdvertisingPlacement::News,
        title: "Protect your hardware wallet".to_owned(),
        body: "Learn about a reviewed hardware wallet product.".to_owned(),
        destination_url: "https://example.com/hardware".to_owned(),
        media_url: Some("https://cdn.tex8.com/ads/hardware.webp".to_owned()),
        starts_at: timestamp(NOW - 60_000),
        ends_at: timestamp(NOW + 7 * 24 * 60 * 60 * 1_000),
        eligible_categories: vec!["hardware".to_owned(), "privacy".to_owned()],
        eligible_regions: vec!["US".to_owned()],
        placement_weight: 50,
        frequency_cap: 20,
        sponsorship_label: AdvertisingLabel::Advertisement,
        embedding_model: Some(HARRIER_V1_MODEL_ID.to_owned()),
        embedding: Some(embedding),
        status: AdvertisingCampaignStatus::Approved,
        created_at: timestamp(NOW - 24 * 60 * 60 * 1_000),
        reviewed_at: Some(timestamp(NOW - 120_000)),
        jurisdiction_review_id: Some("legal-review-2026-07".to_owned()),
    }
}

fn response(signing_key: &SigningKey, generation: u64) -> Vec<u8> {
    let catalog = AdvertisingCatalog {
        catalog_scope_id: "ads:US:news".to_owned(),
        jurisdiction_review_ids: vec!["legal-review-2026-07".to_owned()],
        policy_version: "ads-bench-v1".to_owned(),
        generation,
        generated_at: timestamp(NOW),
        expires_at: timestamp(NOW + 10 * 60 * 1_000),
        campaigns: vec![campaign()],
    };
    let bytes = serde_json::to_vec(&catalog).unwrap();
    serde_json::to_vec(&SignedAdvertisingCatalog {
        catalog,
        signed_catalog: BASE64.encode(&bytes),
        algorithm: "Ed25519".to_owned(),
        signing_key_id: "advertising-bench-key".to_owned(),
        signing_public_key: BASE64.encode(signing_key.verifying_key().as_bytes()),
        signature: BASE64.encode(signing_key.sign(&bytes).to_bytes()),
    })
    .unwrap()
}

fn percentile(samples: &[Duration], percentile: usize) -> u128 {
    let mut nanos: Vec<u128> = samples.iter().map(Duration::as_nanos).collect();
    nanos.sort_unstable();
    let index = ((nanos.len() - 1) * percentile) / 100;
    nanos[index]
}

fn main() {
    let directory = tempfile::tempdir().unwrap();
    let signing_key = SigningKey::from_bytes(&[29; 32]);
    let responses: Vec<Vec<u8>> = (1..=INSTALLATIONS)
        .map(|generation| response(&signing_key, u64::try_from(generation).unwrap()))
        .collect();

    let open_started = Instant::now();
    let core = AdvertisingCatalogCore::open(directory.path(), signing_key.verifying_key()).unwrap();
    let open_time = open_started.elapsed();

    let mut install_times = Vec::with_capacity(INSTALLATIONS);
    for response in &responses {
        let started = Instant::now();
        core.install(response, "US", AdvertisingPlacement::News, NOW)
            .unwrap();
        install_times.push(started.elapsed());
    }

    let mut selection_times = Vec::with_capacity(SELECTIONS);
    let selection_started = Instant::now();
    for _ in 0..SELECTIONS {
        let started = Instant::now();
        let selected = core
            .select("US", AdvertisingPlacement::News, 1, None, NOW)
            .unwrap();
        black_box(selected);
        selection_times.push(started.elapsed());
    }
    let selection_total = selection_started.elapsed();
    let renderer_result_bytes = serde_json::to_vec(
        &core
            .select("US", AdvertisingPlacement::News, 1, None, NOW)
            .unwrap(),
    )
    .unwrap()
    .len();

    let record_started = Instant::now();
    for offset in 0..20_u64 {
        assert!(core
            .record_view("US", AdvertisingPlacement::News, "hardware-1", NOW + offset,)
            .unwrap());
    }
    let record_total = record_started.elapsed();
    let database_bytes = fs::metadata(directory.path().join("advertising.sqlite3"))
        .unwrap()
        .len();
    let response_bytes = responses.last().unwrap().len();

    println!(
        "{}",
        serde_json::to_string_pretty(&json!({
            "environment": {
                "operation": "signed advertising catalog local core",
                "catalogCampaigns": 1,
                "embeddingModel": HARRIER_V1_MODEL_ID,
                "embeddingDimensions": V1_EMBEDDING_DIMENSION,
                "installations": INSTALLATIONS,
                "selections": SELECTIONS,
            },
            "payload": {
                "signedResponseBytes": response_bytes,
                "rendererResultBytes": renderer_result_bytes,
                "sqliteBytes": database_bytes,
            },
            "open": {
                "nanoseconds": open_time.as_nanos(),
            },
            "install": {
                "p50Nanoseconds": percentile(&install_times, 50),
                "p95Nanoseconds": percentile(&install_times, 95),
                "p99Nanoseconds": percentile(&install_times, 99),
            },
            "selection": {
                "totalNanoseconds": selection_total.as_nanos(),
                "operationsPerSecond": SELECTIONS as f64 / selection_total.as_secs_f64(),
                "p50Nanoseconds": percentile(&selection_times, 50),
                "p95Nanoseconds": percentile(&selection_times, 95),
                "p99Nanoseconds": percentile(&selection_times, 99),
            },
            "recordView": {
                "operations": 20,
                "totalNanoseconds": record_total.as_nanos(),
            },
        }))
        .unwrap()
    );
}
