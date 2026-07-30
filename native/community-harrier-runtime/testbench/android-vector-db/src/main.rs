/*
 * Copyright (c) 2026 TEX8.
 * SPDX-License-Identifier: AGPL-3.0-only
 */
use community_search_core::{
    CatalogEmbeddingChunk, CatalogEmbeddingSource, CatalogItem, CatalogItemKind, CatalogPayload,
    CatalogSnapshot, CommunitySearchCore, LocalQueryEmbedding, ModelContract, SearchFilters,
    SignedCatalogPackage, CATALOG_SCHEMA_VERSION,
};
use ed25519_dalek::SigningKey;
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashSet},
    fs,
    path::{Path, PathBuf},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const SCOPE: &str = "android-long-product-v1";
const DAY_MS: u64 = 24 * 60 * 60 * 1_000;
const SEARCH_REPETITIONS: usize = 100;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EmbeddingFixture {
    schema_version: u16,
    artifact_target: String,
    embedding_dimension: usize,
    embeddings_per_second: f64,
    measured_embeddings: usize,
    load_ms: f64,
    measurement_ms: f64,
    products: Vec<ProductVector>,
    queries: Vec<QueryVector>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProductVector {
    id: String,
    title: String,
    title_characters: usize,
    bullet_characters: Vec<usize>,
    description_characters: usize,
    full_input_tokens: usize,
    retained_input_tokens: usize,
    was_truncated: bool,
    embedding: Vec<f32>,
    embedding_chunks: Vec<ProductChunkVector>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProductChunkVector {
    source: String,
    ordinal: u16,
    full_input_tokens: usize,
    retained_input_tokens: usize,
    was_truncated: bool,
    embedding: Vec<f32>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct QueryVector {
    id: String,
    #[serde(default)]
    query_group_id: String,
    #[serde(default)]
    query_kind: String,
    polarity: String,
    evaluated_product_id: String,
    expected_top_product_id: String,
    full_input_tokens: usize,
    retained_input_tokens: usize,
    was_truncated: bool,
    embedding: Vec<f32>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Output {
    schema_version: u16,
    artifact_target: String,
    embedding_dimension: usize,
    product_count: usize,
    query_count: usize,
    field_contract: FieldContract,
    embedding_stage: EmbeddingStage,
    database: DatabaseResult,
    searches: Vec<QueryResult>,
    evaluation: SimilarityEvaluation,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FieldContract {
    input_title_characters: usize,
    input_bullet_characters: usize,
    bullets_per_product: usize,
    input_description_characters: usize,
    catalog_title_limit: usize,
    indexed_title_characters: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EmbeddingStage {
    embeddings_per_second: f64,
    measured_embeddings: usize,
    load_ms: f64,
    measurement_ms: f64,
    truncated_products: usize,
    minimum_full_product_tokens: usize,
    maximum_full_product_tokens: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DatabaseResult {
    engine: &'static str,
    metric: &'static str,
    scalar: &'static str,
    installed_items: usize,
    installed_vectors: usize,
    install_ms: f64,
    search_calls: usize,
    total_search_ms: f64,
    mean_search_ms: f64,
    index_bytes: u64,
    sqlite_bytes: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct QueryResult {
    id: String,
    query_group_id: String,
    query_kind: String,
    polarity: String,
    evaluated_product_id: String,
    expected_top_product_id: String,
    evaluated_rank: usize,
    expected_top_rank: usize,
    pair_similarity: f32,
    top_product_id: String,
    top_similarity: f32,
    decision_correct: bool,
    ranking: Vec<RankedProduct>,
    full_input_tokens: usize,
    retained_input_tokens: usize,
    was_truncated: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RankedProduct {
    product_id: String,
    similarity: f32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SimilarityEvaluation {
    pair_count: usize,
    distinct_query_groups: usize,
    positive_pairs: usize,
    negative_pairs: usize,
    expected_top_matches: usize,
    expected_top_recall_at_5_matches: usize,
    expected_top_recall_at_5: f64,
    mean_reciprocal_rank: f64,
    mean_ndcg_at_5: f64,
    polarity_decisions_correct: usize,
    positive_mean_similarity: f32,
    negative_mean_similarity: f32,
    mean_similarity_gap: f32,
    minimum_positive_similarity: f32,
    maximum_negative_similarity: f32,
    complete_score_separation: bool,
    roc_auc: f64,
    query_kinds: BTreeMap<String, QueryKindEvaluation>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct QueryKindEvaluation {
    cases: usize,
    expected_top_matches: usize,
    recall_at_5_matches: usize,
    mean_reciprocal_rank: f64,
}

fn now_ms() -> Result<u64, String> {
    Ok(SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("system clock: {error}"))?
        .as_millis() as u64)
}

fn milliseconds(duration: Duration) -> f64 {
    duration.as_secs_f64() * 1_000.0
}

fn catalog_item(
    product: &ProductVector,
    title: String,
    model: &ModelContract,
    now: u64,
) -> Result<CatalogItem, String> {
    let embedding_chunks = product
        .embedding_chunks
        .iter()
        .map(|chunk| {
            let source = match chunk.source.as_str() {
                "title" => CatalogEmbeddingSource::Title,
                "summary" => CatalogEmbeddingSource::Summary,
                "bullet" => CatalogEmbeddingSource::Bullet,
                "description" => CatalogEmbeddingSource::Description,
                _ => {
                    return Err(format!(
                        "unsupported embedding source for {}: {}",
                        product.id, chunk.source
                    ));
                }
            };
            Ok(CatalogEmbeddingChunk {
                source,
                ordinal: chunk.ordinal,
                embedding: chunk.embedding.clone(),
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    Ok(CatalogItem {
        public_id: product.id.clone(),
        revision: 1,
        owner_public_id: format!("owner-{}", product.id),
        kind: CatalogItemKind::ProductListing,
        title,
        summary: "Synthetic long-field Android vector database benchmark.".to_owned(),
        roles: vec!["merchant".to_owned()],
        categories: vec!["product".to_owned()],
        languages: vec!["de".to_owned()],
        coarse_region: None,
        radius_km: None,
        media: Vec::new(),
        published_at_ms: now.saturating_sub(1_000),
        expires_at_ms: Some(now + 7 * DAY_MS),
        moderation_decision_id: format!("decision-{}", product.id),
        sponsorship: None,
        model: model.clone(),
        embedding: product.embedding.clone(),
        embedding_chunks,
    })
}

fn package(
    products: &[ProductVector],
    model: &ModelContract,
    key: &SigningKey,
    now: u64,
) -> Result<SignedCatalogPackage, String> {
    let items = products
        .iter()
        .map(|product| {
            let title = product
                .title
                .chars()
                .take(120)
                .collect::<String>()
                .trim_end()
                .to_owned();
            catalog_item(product, title, model, now)
        })
        .collect::<Result<Vec<_>, String>>()?;
    let payload = CatalogPayload::Snapshot(CatalogSnapshot {
        schema_version: CATALOG_SCHEMA_VERSION,
        catalog_scope_id: SCOPE.to_owned(),
        sequence: 1,
        model: model.clone(),
        items,
        tombstones: Vec::new(),
    });
    SignedCatalogPackage::create(
        &payload,
        key,
        "android-test-review-v1",
        "android-test-policy-v1",
        now.saturating_sub(1_000),
        now + DAY_MS,
    )
    .map_err(|error| error.to_string())
}

fn generation_file(root: &Path, name: &str) -> Result<PathBuf, String> {
    let generations = root.join("generations");
    let entry = fs::read_dir(&generations)
        .map_err(|error| format!("read generations: {error}"))?
        .filter_map(Result::ok)
        .find(|entry| entry.path().is_dir())
        .ok_or_else(|| "installed generation directory is missing".to_owned())?;
    Ok(entry.path().join(name))
}

fn run(input: &Path, storage: &Path) -> Result<Output, String> {
    let fixture: EmbeddingFixture =
        serde_json::from_slice(&fs::read(input).map_err(|error| format!("read fixture: {error}"))?)
            .map_err(|error| format!("parse fixture: {error}"))?;
    if fixture.schema_version != 1
        || fixture.artifact_target != "xnnpack_a8w8"
        || fixture.embedding_dimension != 640
        || fixture.products.len() < 2
        || fixture.queries.len() < 20
    {
        return Err("embedding fixture contract is invalid".to_owned());
    }
    for product in &fixture.products {
        if product.title_characters != 255
            || product.title.chars().count() != 255
            || product.bullet_characters.len() != 5
            || product
                .bullet_characters
                .iter()
                .any(|characters| *characters != 255)
            || product.description_characters <= 255
            || product.retained_input_tokens > 256
            || product.embedding_chunks.len() != 6
            || product.embedding_chunks.iter().any(|chunk| {
                chunk.retained_input_tokens > 256
                    || chunk.was_truncated
                    || chunk.full_input_tokens == 0
            })
        {
            return Err(format!("long-field contract failed for {}", product.id));
        }
    }

    let now = now_ms()?;
    let model = ModelContract::harrier_v1();
    let signing_key = SigningKey::from_bytes(&[0x51; 32]);
    let accepted = package(&fixture.products, &model, &signing_key, now)?;
    let core = CommunitySearchCore::open(storage, SCOPE, signing_key.verifying_key())
        .map_err(|error| error.to_string())?;
    let install_start = Instant::now();
    let installed = core
        .install(&accepted.manifest_json, &accepted.payload_json, now)
        .map_err(|error| error.to_string())?;
    let install_ms = milliseconds(install_start.elapsed());
    if installed.items != fixture.products.len() {
        return Err("vector database installed the wrong item count".to_owned());
    }

    let mut searches = Vec::with_capacity(fixture.queries.len());
    for query in &fixture.queries {
        let results = core
            .search(
                &LocalQueryEmbedding {
                    model: model.clone(),
                    embedding: query.embedding.clone(),
                },
                fixture.products.len(),
                &SearchFilters::default(),
                now,
            )
            .map_err(|error| error.to_string())?;
        let expected_rank = results
            .iter()
            .position(|result| result.item.public_id == query.expected_top_product_id)
            .map_or(0, |index| index + 1);
        let evaluated_rank = results
            .iter()
            .position(|result| result.item.public_id == query.evaluated_product_id)
            .map_or(0, |index| index + 1);
        let pair_similarity = results
            .iter()
            .find(|result| result.item.public_id == query.evaluated_product_id)
            .map_or(0.0, |result| result.combined_score);
        let decision_correct = match query.polarity.as_str() {
            "positive" => evaluated_rank == 1,
            "negative" => evaluated_rank != 1,
            _ => {
                return Err(format!(
                    "unsupported polarity for {}: {}",
                    query.id, query.polarity
                ));
            }
        };
        searches.push(QueryResult {
            id: query.id.clone(),
            query_group_id: if query.query_group_id.is_empty() {
                query.id.clone()
            } else {
                query.query_group_id.clone()
            },
            query_kind: if query.query_kind.is_empty() {
                "legacy".to_owned()
            } else {
                query.query_kind.clone()
            },
            polarity: query.polarity.clone(),
            evaluated_product_id: query.evaluated_product_id.clone(),
            expected_top_product_id: query.expected_top_product_id.clone(),
            evaluated_rank,
            expected_top_rank: expected_rank,
            pair_similarity,
            top_product_id: results
                .first()
                .map(|result| result.item.public_id.clone())
                .unwrap_or_default(),
            top_similarity: results.first().map_or(0.0, |result| result.combined_score),
            decision_correct,
            ranking: results
                .into_iter()
                .map(|result| RankedProduct {
                    product_id: result.item.public_id,
                    similarity: result.combined_score,
                })
                .collect(),
            full_input_tokens: query.full_input_tokens,
            retained_input_tokens: query.retained_input_tokens,
            was_truncated: query.was_truncated,
        });
    }

    let search_start = Instant::now();
    for _ in 0..SEARCH_REPETITIONS {
        for query in &fixture.queries {
            core.search(
                &LocalQueryEmbedding {
                    model: model.clone(),
                    embedding: query.embedding.clone(),
                },
                fixture.products.len(),
                &SearchFilters::default(),
                now,
            )
            .map_err(|error| error.to_string())?;
        }
    }
    let total_search_ms = milliseconds(search_start.elapsed());
    let search_calls = SEARCH_REPETITIONS * fixture.queries.len();
    let positive_scores = searches
        .iter()
        .filter(|result| result.polarity == "positive")
        .map(|result| result.pair_similarity)
        .collect::<Vec<_>>();
    let negative_scores = searches
        .iter()
        .filter(|result| result.polarity == "negative")
        .map(|result| result.pair_similarity)
        .collect::<Vec<_>>();
    if positive_scores.is_empty() || negative_scores.is_empty() {
        return Err("both positive and negative similarity pairs are required".to_owned());
    }
    let positive_mean = positive_scores.iter().sum::<f32>() / positive_scores.len() as f32;
    let negative_mean = negative_scores.iter().sum::<f32>() / negative_scores.len() as f32;
    let minimum_positive = positive_scores
        .iter()
        .copied()
        .min_by(f32::total_cmp)
        .ok_or_else(|| "positive score missing".to_owned())?;
    let maximum_negative = negative_scores
        .iter()
        .copied()
        .max_by(f32::total_cmp)
        .ok_or_else(|| "negative score missing".to_owned())?;
    let mut auc_wins = 0.0;
    for positive in &positive_scores {
        for negative in &negative_scores {
            auc_wins += if positive > negative {
                1.0
            } else if positive == negative {
                0.5
            } else {
                0.0
            };
        }
    }
    let roc_auc = auc_wins / (positive_scores.len() * negative_scores.len()) as f64;
    let expected_top_recall_at_5_matches = searches
        .iter()
        .filter(|result| (1..=5).contains(&result.expected_top_rank))
        .count();
    let mean_reciprocal_rank = searches
        .iter()
        .map(|result| {
            if result.expected_top_rank == 0 {
                0.0
            } else {
                1.0 / result.expected_top_rank as f64
            }
        })
        .sum::<f64>()
        / searches.len() as f64;
    let mean_ndcg_at_5 = searches
        .iter()
        .map(|result| {
            if (1..=5).contains(&result.expected_top_rank) {
                1.0 / ((result.expected_top_rank + 1) as f64).log2()
            } else {
                0.0
            }
        })
        .sum::<f64>()
        / searches.len() as f64;
    let mut query_kind_accumulators = BTreeMap::<String, (usize, usize, usize, f64)>::new();
    for result in &searches {
        let accumulator = query_kind_accumulators
            .entry(result.query_kind.clone())
            .or_insert((0, 0, 0, 0.0));
        accumulator.0 += 1;
        accumulator.1 += usize::from(result.expected_top_rank == 1);
        accumulator.2 += usize::from((1..=5).contains(&result.expected_top_rank));
        if result.expected_top_rank > 0 {
            accumulator.3 += 1.0 / result.expected_top_rank as f64;
        }
    }
    let query_kinds = query_kind_accumulators
        .into_iter()
        .map(
            |(kind, (cases, top_matches, recall_matches, reciprocal_sum))| {
                (
                    kind,
                    QueryKindEvaluation {
                        cases,
                        expected_top_matches: top_matches,
                        recall_at_5_matches: recall_matches,
                        mean_reciprocal_rank: reciprocal_sum / cases as f64,
                    },
                )
            },
        )
        .collect();

    let index_path = generation_file(storage, "catalog.usearch")?;
    let sqlite_path = generation_file(storage, "catalog.sqlite3")?;
    let full_tokens = fixture
        .products
        .iter()
        .map(|product| product.full_input_tokens)
        .collect::<Vec<_>>();
    let installed_vectors = fixture
        .products
        .iter()
        .map(|product| 1 + product.embedding_chunks.len())
        .sum();
    let evaluation = SimilarityEvaluation {
        pair_count: fixture.queries.len(),
        distinct_query_groups: searches
            .iter()
            .map(|result| result.query_group_id.as_str())
            .collect::<HashSet<_>>()
            .len(),
        positive_pairs: positive_scores.len(),
        negative_pairs: negative_scores.len(),
        expected_top_matches: searches
            .iter()
            .filter(|result| result.expected_top_rank == 1)
            .count(),
        expected_top_recall_at_5_matches,
        expected_top_recall_at_5: expected_top_recall_at_5_matches as f64 / searches.len() as f64,
        mean_reciprocal_rank,
        mean_ndcg_at_5,
        polarity_decisions_correct: searches
            .iter()
            .filter(|result| result.decision_correct)
            .count(),
        positive_mean_similarity: positive_mean,
        negative_mean_similarity: negative_mean,
        mean_similarity_gap: positive_mean - negative_mean,
        minimum_positive_similarity: minimum_positive,
        maximum_negative_similarity: maximum_negative,
        complete_score_separation: minimum_positive > maximum_negative,
        roc_auc,
        query_kinds,
    };
    Ok(Output {
        schema_version: 1,
        artifact_target: fixture.artifact_target,
        embedding_dimension: fixture.embedding_dimension,
        product_count: fixture.products.len(),
        query_count: fixture.queries.len(),
        field_contract: FieldContract {
            input_title_characters: 255,
            input_bullet_characters: 255,
            bullets_per_product: 5,
            input_description_characters: fixture.products[0].description_characters,
            catalog_title_limit: 120,
            indexed_title_characters: 120,
        },
        embedding_stage: EmbeddingStage {
            embeddings_per_second: fixture.embeddings_per_second,
            measured_embeddings: fixture.measured_embeddings,
            load_ms: fixture.load_ms,
            measurement_ms: fixture.measurement_ms,
            truncated_products: fixture
                .products
                .iter()
                .filter(|product| product.was_truncated)
                .count(),
            minimum_full_product_tokens: *full_tokens
                .iter()
                .min()
                .ok_or_else(|| "product tokens are missing".to_owned())?,
            maximum_full_product_tokens: *full_tokens
                .iter()
                .max()
                .ok_or_else(|| "product tokens are missing".to_owned())?,
        },
        database: DatabaseResult {
            engine: "community-search-core SQLite + USearch",
            metric: "cosine",
            scalar: "f32",
            installed_items: installed.items,
            installed_vectors,
            install_ms,
            search_calls,
            total_search_ms,
            mean_search_ms: total_search_ms / search_calls as f64,
            index_bytes: fs::metadata(index_path)
                .map_err(|error| format!("index metadata: {error}"))?
                .len(),
            sqlite_bytes: fs::metadata(sqlite_path)
                .map_err(|error| format!("SQLite metadata: {error}"))?
                .len(),
        },
        searches,
        evaluation,
    })
}

fn main() {
    let arguments = std::env::args_os().skip(1).collect::<Vec<_>>();
    if arguments.len() != 2 {
        eprintln!(
            "usage: community-android-vector-db-benchmark \
             <embeddings.json> <storage-root>"
        );
        std::process::exit(2);
    }
    match run(Path::new(&arguments[0]), Path::new(&arguments[1])) {
        Ok(output) => match serde_json::to_string(&output) {
            Ok(json) => println!("{json}"),
            Err(error) => {
                eprintln!("serialize result: {error}");
                std::process::exit(1);
            }
        },
        Err(error) => {
            eprintln!("Android vector database benchmark failed: {error}");
            std::process::exit(1);
        }
    }
}
