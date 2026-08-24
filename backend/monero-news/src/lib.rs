//! A small server-owned news feed for the wallet dashboard.
//!
//! The wallet clients retrieve a small server-owned catalog and only accept
//! immutable WebP covers from the TEX8 CDN.

mod ads;

use axum::{
    extract::DefaultBodyLimit,
    extract::{Query, State},
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::{Mutex, RwLock};

pub use ads::AdConfig;

const CURATED_CATALOG_IMAGE_CDN: &str =
    "https://cdn.tex8.com/tex8-images/monero-fast-wallet/news/v1/2026-08-20";
const CACHE_FOR: Duration = Duration::from_secs(15 * 60);
const NEWS_CATALOG_LIMIT: usize = 10;
const MARKET_QUOTE_CACHE_FOR: Duration = Duration::from_secs(60);
const MARKET_CHART_CACHE_FOR: Duration = Duration::from_secs(5 * 60);
const COINGECKO_BASE: &str = "https://api.coingecko.com/api/v3";
const BITFINEX_BASE: &str = "https://api-pub.bitfinex.com/v2";

#[derive(Clone)]
pub struct NewsState {
    client: reqwest::Client,
    cache: Arc<RwLock<Option<CachedFeed>>>,
    catalog_hash: String,
    market_quote_cache: Arc<RwLock<Option<CachedMarketQuote>>>,
    market_chart_cache: Arc<RwLock<HashMap<String, CachedMarketChart>>>,
    market_quote_refresh: Arc<Mutex<()>>,
    market_chart_refresh: Arc<Mutex<()>>,
    pub(crate) ads: ads::AdService,
}

#[derive(Clone)]
struct CachedFeed {
    fetched_at: Instant,
    items: Vec<NewsItem>,
}

#[derive(Clone)]
struct CachedMarketQuote {
    fetched_at: Instant,
    quote: MarketQuote,
}

#[derive(Clone)]
struct CachedMarketChart {
    fetched_at: Instant,
    points: Vec<MarketPoint>,
}

#[derive(Clone, Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NewsItem {
    pub id: String,
    pub title: String,
    pub summary: String,
    pub published_at: String,
    pub category: NewsCategory,
    pub url: String,
    pub image_url: String,
}

#[derive(Clone, Copy, Serialize, Deserialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum NewsCategory {
    Network,
    Wallet,
    Ecosystem,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NewsResponse {
    catalog_hash: String,
    items: Vec<NewsItem>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CatalogHashResponse {
    catalog_hash: String,
}

#[derive(Clone, Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MarketQuote {
    pub price: f64,
    pub change_24h: f64,
    pub as_of: String,
}

#[derive(Clone, Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MarketPoint {
    pub timestamp: i64,
    pub price: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MarketChartResponse {
    timeframe: String,
    points: Vec<MarketPoint>,
    as_of: String,
}

#[derive(Deserialize)]
struct NewsQuery {
    category: Option<NewsCategory>,
    limit: Option<usize>,
}

#[derive(Deserialize)]
struct MarketChartQuery {
    timeframe: Option<String>,
}

impl NewsState {
    pub fn new() -> Result<Self, String> {
        Self::new_with_ad_service(ads::AdService::from_env()?)
    }

    pub fn new_with_ads(config: AdConfig) -> Result<Self, String> {
        Self::new_with_ad_service(ads::AdService::enabled(config)?)
    }

    fn new_with_ad_service(ads: ads::AdService) -> Result<Self, String> {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(12))
            .user_agent("Monero-Fast-Wallet-News/1.0 (+https://solutions.tex8.com/en)")
            .build()
            .map_err(|error| format!("news HTTP client could not start: {error}"))?;
        Ok(Self {
            client,
            cache: Arc::new(RwLock::new(None)),
            catalog_hash: catalog_hash(&curated_catalog()),
            market_quote_cache: Arc::new(RwLock::new(None)),
            market_chart_cache: Arc::new(RwLock::new(HashMap::new())),
            market_quote_refresh: Arc::new(Mutex::new(())),
            market_chart_refresh: Arc::new(Mutex::new(())),
            ads,
        })
    }

    async fn feed(&self) -> Result<Vec<NewsItem>, ApiError> {
        if let Some(cached) = self.cache.read().await.as_ref() {
            if cached.fetched_at.elapsed() < CACHE_FOR {
                return Ok(cached.items.clone());
            }
        }

        let items = curated_catalog();
        *self.cache.write().await = Some(CachedFeed {
            fetched_at: Instant::now(),
            items: items.clone(),
        });
        Ok(items)
    }

    async fn market_quote(&self) -> Result<MarketQuote, ApiError> {
        if let Some(cached) = self.market_quote_cache.read().await.as_ref() {
            if cached.fetched_at.elapsed() < MARKET_QUOTE_CACHE_FOR {
                return Ok(cached.quote.clone());
            }
        }

        let _refresh = self.market_quote_refresh.lock().await;
        if let Some(cached) = self.market_quote_cache.read().await.as_ref() {
            if cached.fetched_at.elapsed() < MARKET_QUOTE_CACHE_FOR {
                return Ok(cached.quote.clone());
            }
        }

        match self.fetch_market_quote().await {
            Ok(quote) => {
                *self.market_quote_cache.write().await = Some(CachedMarketQuote {
                    fetched_at: Instant::now(),
                    quote: quote.clone(),
                });
                Ok(quote)
            }
            Err(error) => self
                .market_quote_cache
                .read()
                .await
                .as_ref()
                .map(|cached| cached.quote.clone())
                .ok_or(error),
        }
    }

    async fn market_chart(&self, timeframe: &str) -> Result<Vec<MarketPoint>, ApiError> {
        if let Some(cached) = self.market_chart_cache.read().await.get(timeframe) {
            if cached.fetched_at.elapsed() < MARKET_CHART_CACHE_FOR {
                return Ok(cached.points.clone());
            }
        }

        let _refresh = self.market_chart_refresh.lock().await;
        if let Some(cached) = self.market_chart_cache.read().await.get(timeframe) {
            if cached.fetched_at.elapsed() < MARKET_CHART_CACHE_FOR {
                return Ok(cached.points.clone());
            }
        }

        match self.fetch_market_chart(timeframe).await {
            Ok(points) => {
                self.market_chart_cache.write().await.insert(
                    timeframe.to_owned(),
                    CachedMarketChart {
                        fetched_at: Instant::now(),
                        points: points.clone(),
                    },
                );
                Ok(points)
            }
            Err(error) => self
                .market_chart_cache
                .read()
                .await
                .get(timeframe)
                .map(|cached| cached.points.clone())
                .ok_or(error),
        }
    }

    async fn fetch_market_quote(&self) -> Result<MarketQuote, ApiError> {
        let coingecko = self.fetch_text(format!(
            "{COINGECKO_BASE}/simple/price?ids=monero&vs_currencies=usd&include_24hr_change=true"
        ));
        let bitfinex = self.fetch_text(format!("{BITFINEX_BASE}/ticker/tXMRUSD"));
        tokio::pin!(coingecko);
        tokio::pin!(bitfinex);

        tokio::select! {
            primary = &mut coingecko => match primary.and_then(|body| {
                parse_coingecko_quote(&body).ok_or(ApiError::Unavailable)
            }) {
                Ok(quote) => Ok(quote),
                Err(_) => bitfinex
                    .await
                    .and_then(|body| parse_bitfinex_quote(&body).ok_or(ApiError::Unavailable)),
            },
            backup = &mut bitfinex => match backup.and_then(|body| {
                parse_bitfinex_quote(&body).ok_or(ApiError::Unavailable)
            }) {
                Ok(quote) => Ok(quote),
                Err(_) => coingecko
                    .await
                    .and_then(|body| parse_coingecko_quote(&body).ok_or(ApiError::Unavailable)),
            },
        }
    }

    async fn fetch_market_chart(&self, timeframe: &str) -> Result<Vec<MarketPoint>, ApiError> {
        let (coingecko_url, bitfinex_url) =
            market_chart_urls(timeframe).ok_or(ApiError::BadRequest)?;
        let coingecko = self.fetch_text(coingecko_url);
        let bitfinex = self.fetch_text(bitfinex_url);
        tokio::pin!(coingecko);
        tokio::pin!(bitfinex);

        tokio::select! {
            primary = &mut coingecko => match primary.and_then(|body| {
                parse_coingecko_chart(&body).ok_or(ApiError::Unavailable)
            }) {
                Ok(points) => Ok(points),
                Err(_) => bitfinex
                    .await
                    .and_then(|body| parse_bitfinex_chart(&body).ok_or(ApiError::Unavailable)),
            },
            backup = &mut bitfinex => match backup.and_then(|body| {
                parse_bitfinex_chart(&body).ok_or(ApiError::Unavailable)
            }) {
                Ok(points) => Ok(points),
                Err(_) => coingecko
                    .await
                    .and_then(|body| parse_coingecko_chart(&body).ok_or(ApiError::Unavailable)),
            },
        }
    }

    async fn fetch_text(&self, url: String) -> Result<String, ApiError> {
        self.client
            .get(url)
            .send()
            .await
            .map_err(|_| ApiError::Unavailable)?
            .error_for_status()
            .map_err(|_| ApiError::Unavailable)?
            .text()
            .await
            .map_err(|_| ApiError::Unavailable)
    }
}

pub fn router(state: NewsState) -> Router {
    Router::new()
        .route("/healthz", get(healthz))
        .route("/v1/news", get(news))
        .route("/v1/news/catalog-hash", get(catalog_hash_endpoint))
        .route("/v1/market/quote", get(market_quote))
        .route("/v1/market/chart", get(market_chart))
        .route("/v1/ads/catalog", get(ads::public_catalog))
        .route(
            "/v1/ads/catalog/{country}/{placement}",
            get(ads::public_catalog_path),
        )
        .route(
            "/v1/admin/ads/campaigns",
            get(ads::admin_list).post(ads::admin_create),
        )
        .route(
            "/v1/admin/ads/campaigns/{campaign_id}/approve",
            post(ads::admin_approve),
        )
        .route(
            "/v1/admin/ads/campaigns/{campaign_id}/withdraw",
            post(ads::admin_withdraw),
        )
        .layer(DefaultBodyLimit::max(64 * 1024))
        .with_state(state)
}

async fn healthz(State(state): State<NewsState>) -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "ok": true,
        "advertisingConfigured": state.ads.is_enabled(),
    }))
}

async fn news(
    State(state): State<NewsState>,
    Query(query): Query<NewsQuery>,
) -> Result<Json<NewsResponse>, ApiError> {
    let limit = query
        .limit
        .unwrap_or(NEWS_CATALOG_LIMIT)
        .clamp(1, NEWS_CATALOG_LIMIT);
    let catalog_hash = state.catalog_hash.clone();
    let mut items = state.feed().await?;
    if let Some(category) = query.category {
        items.retain(|item| item.category == category);
    }
    items.truncate(limit);
    Ok(Json(NewsResponse {
        catalog_hash,
        items,
    }))
}

async fn catalog_hash_endpoint(State(state): State<NewsState>) -> Json<CatalogHashResponse> {
    Json(CatalogHashResponse {
        catalog_hash: state.catalog_hash.clone(),
    })
}

async fn market_quote(State(state): State<NewsState>) -> Result<Json<MarketQuote>, ApiError> {
    state.market_quote().await.map(Json)
}

async fn market_chart(
    State(state): State<NewsState>,
    Query(query): Query<MarketChartQuery>,
) -> Result<Json<MarketChartResponse>, ApiError> {
    let timeframe = query.timeframe.unwrap_or_else(|| "24H".to_owned());
    let points = state.market_chart(&timeframe).await?;
    Ok(Json(MarketChartResponse {
        timeframe,
        points,
        as_of: Utc::now().to_rfc3339(),
    }))
}

fn market_chart_urls(timeframe: &str) -> Option<(String, String)> {
    let (days, interval, limit) = match timeframe {
        "24H" => ("1", "1h", 25),
        "7D" => ("7", "6h", 29),
        "1M" => ("30", "12h", 61),
        "1Y" => ("365", "1D", 366),
        "Max" => ("max", "1D", 10_000),
        _ => return None,
    };
    Some((
        format!("{COINGECKO_BASE}/coins/monero/market_chart?vs_currency=usd&days={days}"),
        format!("{BITFINEX_BASE}/candles/trade:{interval}:tXMRUSD/hist?limit={limit}&sort=-1"),
    ))
}

fn parse_coingecko_quote(body: &str) -> Option<MarketQuote> {
    let value: serde_json::Value = serde_json::from_str(body).ok()?;
    let monero = value.get("monero")?;
    market_quote_value(
        monero.get("usd")?.as_f64()?,
        monero
            .get("usd_24h_change")
            .and_then(serde_json::Value::as_f64)
            .unwrap_or(0.0),
    )
}

fn parse_bitfinex_quote(body: &str) -> Option<MarketQuote> {
    let value: serde_json::Value = serde_json::from_str(body).ok()?;
    let values = value.as_array()?;
    market_quote_value(
        values.get(6)?.as_f64()?,
        values
            .get(5)
            .and_then(serde_json::Value::as_f64)
            .unwrap_or(0.0)
            * 100.0,
    )
}

fn market_quote_value(price: f64, change_24h: f64) -> Option<MarketQuote> {
    if !price.is_finite() || price <= 0.0 || !change_24h.is_finite() {
        return None;
    }
    Some(MarketQuote {
        price,
        change_24h,
        as_of: Utc::now().to_rfc3339(),
    })
}

fn parse_coingecko_chart(body: &str) -> Option<Vec<MarketPoint>> {
    let value: serde_json::Value = serde_json::from_str(body).ok()?;
    let prices = value.get("prices")?.as_array()?;
    normalise_market_points(prices.iter().filter_map(|entry| {
        let pair = entry.as_array()?;
        market_point(pair.first()?.as_f64()?, pair.get(1)?.as_f64()?)
    }))
}

fn parse_bitfinex_chart(body: &str) -> Option<Vec<MarketPoint>> {
    let value: serde_json::Value = serde_json::from_str(body).ok()?;
    let candles = value.as_array()?;
    normalise_market_points(candles.iter().filter_map(|entry| {
        let candle = entry.as_array()?;
        market_point(candle.first()?.as_f64()?, candle.get(2)?.as_f64()?)
    }))
}

fn market_point(timestamp: f64, price: f64) -> Option<MarketPoint> {
    if !timestamp.is_finite() || timestamp <= 0.0 || !price.is_finite() || price <= 0.0 {
        return None;
    }
    Some(MarketPoint {
        timestamp: timestamp.round() as i64,
        price,
    })
}

fn normalise_market_points(points: impl Iterator<Item = MarketPoint>) -> Option<Vec<MarketPoint>> {
    let mut points: Vec<_> = points.collect();
    points.sort_by_key(|point| point.timestamp);
    points.dedup_by_key(|point| point.timestamp);
    if points.len() < 2 {
        return None;
    }
    if points.len() <= 120 {
        return Some(points);
    }
    let last = points.len() - 1;
    Some(
        (0..120)
            .map(|index| points[index * last / 119].clone())
            .collect(),
    )
}

fn curated_catalog() -> Vec<NewsItem> {
    let image_url = |name: &str| format!("{CURATED_CATALOG_IMAGE_CDN}/{name}.webp");
    vec![
        NewsItem {
            id: "2026-08-20-nano-ledger".to_string(),
            title: "Nano Ledger: Monero sicher signieren".to_string(),
            summary: "Der Spend Key bleibt auf dem Hardware-Gerät. Prüfe Empfänger, Betrag und Gebühr immer auf dem Display, bevor du die Signatur freigibst.".to_string(),
            published_at: "2026-08-20T15:00:00Z".to_string(),
            category: NewsCategory::Wallet,
            url: "https://www.getmonero.org/resources/user-guides/ledger-wallet-cli.html".to_string(),
            image_url: image_url("nano-ledger"),
        },
        NewsItem {
            id: "2026-08-20-monero".to_string(),
            title: "Monero: Private Zahlungen ohne öffentliche Kontostände".to_string(),
            summary: "Ring-Signaturen, Stealth-Adressen und vertrauliche Beträge schützen die Zahlungsdaten auf Protokollebene.".to_string(),
            published_at: "2026-08-20T14:00:00Z".to_string(),
            category: NewsCategory::Network,
            url: "https://www.getmonero.org/get-started/what-is-monero/".to_string(),
            image_url: image_url("monero"),
        },
        NewsItem {
            id: "2026-08-20-monero-fast-wallet".to_string(),
            title: "Monero Fast Wallet: Schneller Sync, Schlüssel lokal".to_string(),
            summary: "Die Wallet nutzt den gemeinsamen Monero-Core, beschleunigt den Blockabruf und lässt Seed sowie Signaturen auf deinem Gerät.".to_string(),
            published_at: "2026-08-20T13:00:00Z".to_string(),
            category: NewsCategory::Wallet,
            url: "https://www.getmonero.org/resources/user-guides/".to_string(),
            image_url: image_url("monero-fast-wallet"),
        },
        NewsItem {
            id: "2026-08-20-monero-fast-node".to_string(),
            title: "Monero Fast Node: Privater Zugang zur Blockchain".to_string(),
            summary: "Monero Fast Node stellt Wallets einen zuverlässigen Node-Zugang bereit und bleibt mit dem Monero-Netzwerk kompatibel.".to_string(),
            published_at: "2026-08-20T12:00:00Z".to_string(),
            category: NewsCategory::Network,
            url: "https://www.getmonero.org/resources/moneropedia/node.html".to_string(),
            image_url: image_url("monero-fast-node"),
        },
        NewsItem {
            id: "2026-08-20-global-privacy".to_string(),
            title: "Globale Privacy: Weniger Datenspuren im Alltag".to_string(),
            summary: "Lokale Schlüssel, verschlüsselte Verbindungen und datensparsame Dienste sind praktische Bausteine digitaler Selbstbestimmung.".to_string(),
            published_at: "2026-08-20T11:00:00Z".to_string(),
            category: NewsCategory::Ecosystem,
            url: "https://www.getmonero.org/get-started/what-is-monero/".to_string(),
            image_url: image_url("privacy"),
        },
    ]
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CatalogHashItem<'a> {
    id: &'a str,
    title: &'a str,
    summary: &'a str,
    published_at: &'a str,
    category: NewsCategory,
    url: &'a str,
    image_url: &'a str,
}

fn catalog_hash(items: &[NewsItem]) -> String {
    let fingerprint: Vec<_> = items
        .iter()
        .map(|item| CatalogHashItem {
            id: &item.id,
            title: &item.title,
            summary: &item.summary,
            published_at: &item.published_at,
            category: item.category,
            url: &item.url,
            image_url: &item.image_url,
        })
        .collect();
    let encoded = serde_json::to_vec(&fingerprint).expect("catalog fingerprint serializes");
    hex::encode(Sha256::digest(encoded))
}

enum ApiError {
    BadRequest,
    Unavailable,
}

impl IntoResponse for ApiError {
    fn into_response(self) -> axum::response::Response {
        let (status, code) = match self {
            Self::BadRequest => (StatusCode::BAD_REQUEST, "invalid_market_timeframe"),
            Self::Unavailable => (StatusCode::SERVICE_UNAVAILABLE, "content_unavailable"),
        };
        (status, Json(serde_json::json!({ "error": code }))).into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serves_the_curated_tex8_catalog() {
        let news = curated_catalog();
        assert_eq!(news.len(), 5);
        assert!(news
            .iter()
            .all(|item| item.url.starts_with("https://www.getmonero.org/")));
        assert!(news.iter().all(|item| {
            item.image_url.starts_with(CURATED_CATALOG_IMAGE_CDN)
                && item.image_url.ends_with(".webp")
        }));
        let encoded = serde_json::to_value(&news[0]).expect("catalog serializes");
        assert!(encoded["imageUrl"].as_str().is_some());
        assert_eq!(encoded.as_object().map(|item| item.len()), Some(7));
    }

    #[test]
    fn catalog_hash_changes_with_catalog_content() {
        let catalog = curated_catalog();
        let original = catalog_hash(&catalog);
        assert_eq!(original.len(), 64);
        let mut changed = catalog.clone();
        changed[0].title.push('!');
        assert_ne!(original, catalog_hash(&changed));
    }

    #[test]
    fn parses_both_quote_provider_contracts() {
        let coingecko = parse_coingecko_quote(r#"{"monero":{"usd":327.5,"usd_24h_change":-1.25}}"#)
            .expect("CoinGecko quote");
        assert_eq!(coingecko.price, 327.5);
        assert_eq!(coingecko.change_24h, -1.25);

        let bitfinex =
            parse_bitfinex_quote(r#"[0,0,0,0,0,-0.0125,327.5,0,0,0]"#).expect("Bitfinex quote");
        assert_eq!(bitfinex.price, 327.5);
        assert_eq!(bitfinex.change_24h, -1.25);
    }

    #[test]
    fn normalises_and_downsamples_market_charts() {
        let prices = (0..240)
            .map(|index| format!("[{},{}]", 1_700_000_000_000_i64 + index, 300 + index))
            .collect::<Vec<_>>()
            .join(",");
        let points =
            parse_coingecko_chart(&format!(r#"{{"prices":[{prices}]}}"#)).expect("market points");
        assert_eq!(points.len(), 120);
        assert!(points
            .windows(2)
            .all(|pair| pair[0].timestamp < pair[1].timestamp));
    }

    #[test]
    fn accepts_only_supported_chart_timeframes() {
        assert!(market_chart_urls("24H").is_some());
        assert!(market_chart_urls("Max").is_some());
        assert!(market_chart_urls("unexpected").is_none());
    }
}
