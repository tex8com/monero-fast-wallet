/*
 * Copyright (c) 2026 TEX8.
 * SPDX-License-Identifier: AGPL-3.0-only
 */

use community_search_core::{
    normalize_query_text_v1, CatalogItem, CatalogItemKind, CatalogPayload, CatalogSnapshot,
    HarrierArtifactTarget, ModelContract, QueryCatalogEntry, QueryCatalogPayload,
    QueryCatalogSnapshot, SignedCatalogPackage, SignedHarrierArtifactPackage,
    SignedQueryCatalogPackage, QUERY_NORMALIZATION_VERSION, V1_EMBEDDING_DIMENSION,
};
use ed25519_dalek::SigningKey;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    env,
    fmt::Write as _,
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

const CATALOG_SCOPE: &str = "simulator-v1";
const DAY_MS: u64 = 24 * 60 * 60 * 1_000;

fn read(path: &Path) -> Result<Vec<u8>, String> {
    fs::read(path).map_err(|error| format!("read {}: {error}", path.display()))
}

fn write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("create {}: {error}", parent.display()))?;
    }
    fs::write(path, bytes).map_err(|error| format!("write {}: {error}", path.display()))
}

fn reference_embeddings(path: &Path) -> Result<HashMap<String, Vec<f32>>, String> {
    let value: Value = serde_json::from_slice(&read(path)?)
        .map_err(|error| format!("parse reference vectors: {error}"))?;
    let vectors = value
        .get("vectors")
        .and_then(Value::as_array)
        .ok_or_else(|| "reference vectors are missing".to_owned())?;
    let mut result = HashMap::new();
    for vector in vectors {
        let id = vector
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| "reference vector id is invalid".to_owned())?;
        let embedding = vector
            .get("embedding")
            .and_then(Value::as_array)
            .ok_or_else(|| "reference embedding is invalid".to_owned())?
            .iter()
            .map(|value| {
                value
                    .as_f64()
                    .map(|number| number as f32)
                    .ok_or_else(|| "reference embedding value is invalid".to_owned())
            })
            .collect::<Result<Vec<_>, _>>()?;
        if embedding.len() != V1_EMBEDDING_DIMENSION {
            return Err(format!("reference embedding {id} has the wrong dimension"));
        }
        result.insert(id.to_owned(), embedding);
    }
    Ok(result)
}

fn embedding(references: &HashMap<String, Vec<f32>>, id: &str) -> Result<Vec<f32>, String> {
    references
        .get(id)
        .cloned()
        .ok_or_else(|| format!("reference embedding {id} is missing"))
}

fn hex_encode(bytes: &[u8]) -> String {
    let mut encoded = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        write!(&mut encoded, "{byte:02x}").expect("writing to a String cannot fail");
    }
    encoded
}

fn item(
    public_id: &str,
    title: &str,
    summary: &str,
    kind: CatalogItemKind,
    embedding: Vec<f32>,
    now_ms: u64,
) -> CatalogItem {
    CatalogItem {
        public_id: public_id.to_owned(),
        revision: 1,
        owner_public_id: format!("owner-{public_id}"),
        kind,
        title: title.to_owned(),
        summary: summary.to_owned(),
        roles: vec!["developer".to_owned()],
        categories: vec!["privacy".to_owned(), "software".to_owned()],
        languages: vec!["de".to_owned(), "en".to_owned()],
        coarse_region: None,
        radius_km: None,
        media: Vec::new(),
        published_at_ms: now_ms.saturating_sub(60_000),
        expires_at_ms: kind.is_listing().then_some(now_ms + 7 * DAY_MS),
        moderation_decision_id: format!("decision-{public_id}-1"),
        sponsorship: None,
        model: ModelContract::harrier_v1(),
        embedding,
        embedding_chunks: Vec::new(),
    }
}

fn main() -> Result<(), String> {
    let arguments = env::args_os()
        .skip(1)
        .map(PathBuf::from)
        .collect::<Vec<_>>();
    if arguments.len() != 5 {
        return Err(
            "usage: generate_ios_catalog_fixture <output-root> <pte> <tokenizer> \
             <conformance.json> <reference-vectors.json>"
                .to_owned(),
        );
    }
    let output_root = &arguments[0];
    let pte = read(&arguments[1])?;
    let tokenizer = read(&arguments[2])?;
    let conformance = read(&arguments[3])?;
    let references = reference_embeddings(&arguments[4])?;
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("system clock is invalid: {error}"))?
        .as_millis() as u64;

    // These keys are deterministic and test-only. The simulator fixture is
    // never accepted by a production build because its public keys are not
    // present in the release manifest.
    let catalog_signing_key = SigningKey::from_bytes(&[0x41; 32]);
    let advertising_signing_key = SigningKey::from_bytes(&[0x63; 32]);
    let artifact_signing_key = SigningKey::from_bytes(&[0x82; 32]);

    let artifact = SignedHarrierArtifactPackage::create(
        "harrier-v1-ios-simulator-diagnostic",
        1,
        HarrierArtifactTarget::XnnpackA8w8,
        "ios-17",
        &pte,
        &tokenizer,
        &conformance,
        36,
        997_401,
        now_ms,
        &artifact_signing_key,
    )
    .map_err(|error| format!("create artifact manifest: {error}"))?;

    let catalog_payload = CatalogPayload::Snapshot(CatalogSnapshot {
        schema_version: 1,
        catalog_scope_id: CATALOG_SCOPE.to_owned(),
        sequence: 1,
        model: ModelContract::harrier_v1(),
        items: vec![
            item(
                "privacy-software",
                "Datenschutzfreundliche Softwareentwicklung",
                "Ein lokales Testprodukt für private und sichere Software.",
                CatalogItemKind::ProductListing,
                embedding(&references, "q-de-privacy")?,
                now_ms,
            ),
            item(
                "hardware-wallet-guide",
                "Hardware Wallet Beratung",
                "Ein lokaler Testeintrag für sichere Hardware Wallets.",
                CatalogItemKind::ServiceListing,
                embedding(&references, "q-en-hardware")?,
                now_ms,
            ),
        ],
        tombstones: Vec::new(),
    });
    let catalog = SignedCatalogPackage::create(
        &catalog_payload,
        &catalog_signing_key,
        "simulator-review-v1",
        "simulator-policy-v1",
        now_ms.saturating_sub(1_000),
        now_ms + DAY_MS,
    )
    .map_err(|error| format!("create catalog: {error}"))?;

    let common_query_display = "Hardware Wallet";
    let query_payload = QueryCatalogPayload::Snapshot(QueryCatalogSnapshot {
        schema_version: 1,
        catalog_scope_id: CATALOG_SCOPE.to_owned(),
        sequence: 1,
        normalization_version: QUERY_NORMALIZATION_VERSION.to_owned(),
        model: ModelContract::harrier_v1(),
        entries: vec![QueryCatalogEntry {
            query_id: "hardware-wallet".to_owned(),
            revision: 1,
            normalized_text: normalize_query_text_v1(common_query_display)
                .map_err(|error| format!("normalize query: {error}"))?,
            display_text: common_query_display.to_owned(),
            language: "de".to_owned(),
            weight: 1.0,
            model: ModelContract::harrier_v1(),
            embedding: embedding(&references, "q-en-hardware")?,
        }],
        tombstones: Vec::new(),
    });
    let queries = SignedQueryCatalogPackage::create(
        &query_payload,
        &catalog_signing_key,
        "simulator-review-v1",
        "simulator-policy-v1",
        now_ms.saturating_sub(1_000),
        now_ms + DAY_MS,
    )
    .map_err(|error| format!("create query catalog: {error}"))?;

    let catalog_root = output_root
        .join("v1/catalogs")
        .join(CATALOG_SCOPE)
        .join("current");
    write(&catalog_root.join("manifest.json"), &catalog.manifest_json)?;
    write(&catalog_root.join("catalog.json"), &catalog.payload_json)?;
    let query_root = output_root
        .join("v1/queries")
        .join(CATALOG_SCOPE)
        .join("current");
    write(&query_root.join("manifest.json"), &queries.manifest_json)?;
    write(&query_root.join("queries.json"), &queries.payload_json)?;
    write(
        &output_root.join("artifact-manifest.json"),
        &artifact.manifest_json,
    )?;
    write(&output_root.join("conformance.json"), &conformance)?;
    let config = serde_json::to_vec(&json!({
        "advertisingVerifyingKeyHex": hex_encode(advertising_signing_key.verifying_key().as_bytes()),
        "artifactVerifyingKeyHex": hex_encode(artifact_signing_key.verifying_key().as_bytes()),
        "catalogScope": CATALOG_SCOPE,
        "catalogVerifyingKeyHex": hex_encode(catalog_signing_key.verifying_key().as_bytes()),
        "expectedTopPublicId": "privacy-software"
    }))
    .map_err(|error| format!("encode fixture configuration: {error}"))?;
    write(&output_root.join("diagnostic-config.json"), &config)?;

    println!(
        "generated signed iOS catalog fixture at {}",
        output_root.display()
    );
    Ok(())
}
