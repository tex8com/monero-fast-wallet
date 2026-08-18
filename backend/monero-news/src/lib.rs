//! A small server-owned news feed for the wallet dashboard.
//!
//! The mobile clients never scrape a third party.  This service retrieves the
//! public Monero blog, normalises the small response contract, caches it, and
//! only returns official getmonero.org article links.

mod ads;

use axum::{
    extract::DefaultBodyLimit,
    extract::{Query, State},
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use chrono::{DateTime, NaiveDate, Utc};
use image::{
    codecs::jpeg::JpegEncoder, imageops::FilterType, DynamicImage, GenericImageView, Rgb, RgbImage,
};
use scraper::{Html, Selector};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::{Mutex, RwLock};

pub use ads::AdConfig;

const SOURCE_URL: &str = "https://www.getmonero.org/blog/";
const CACHE_FOR: Duration = Duration::from_secs(15 * 60);
const NEWS_CATALOG_LIMIT: usize = 10;
const NEWS_IMAGE_WIDTH: u32 = 960;
const NEWS_IMAGE_HEIGHT: u32 = 540;
const NEWS_IMAGE_SOURCE_LIMIT: usize = 4 * 1024 * 1024;
const NEWS_IMAGE_JPEG_LIMIT: usize = 64 * 1024;
const MARKET_QUOTE_CACHE_FOR: Duration = Duration::from_secs(60);
const MARKET_CHART_CACHE_FOR: Duration = Duration::from_secs(5 * 60);
const COINGECKO_BASE: &str = "https://api.coingecko.com/api/v3";
const BITFINEX_BASE: &str = "https://api-pub.bitfinex.com/v2";

#[derive(Clone)]
pub struct NewsState {
    client: reqwest::Client,
    cache: Arc<RwLock<Option<CachedFeed>>>,
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
    pub image_data_url: String,
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
    items: Vec<NewsItem>,
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

        let body = self
            .client
            .get(SOURCE_URL)
            .send()
            .await
            .map_err(|_| ApiError::Unavailable)?
            .error_for_status()
            .map_err(|_| ApiError::Unavailable)?
            .text()
            .await
            .map_err(|_| ApiError::Unavailable)?;
        let mut items = parse_blog(&body);
        if items.is_empty() {
            return Err(ApiError::Unavailable);
        }
        items.truncate(NEWS_CATALOG_LIMIT);
        self.load_catalog_images(&mut items).await;
        *self.cache.write().await = Some(CachedFeed {
            fetched_at: Instant::now(),
            items: items.clone(),
        });
        Ok(items)
    }

    async fn load_catalog_images(&self, items: &mut [NewsItem]) {
        let mut tasks = tokio::task::JoinSet::new();
        for (index, item) in items.iter().enumerate() {
            let client = self.client.clone();
            let article_url = item.url.clone();
            let fallback = item.image_data_url.clone();
            tasks.spawn(async move {
                let image = tokio::time::timeout(
                    Duration::from_secs(6),
                    fetch_article_image(&client, &article_url),
                )
                .await
                .ok()
                .flatten()
                .and_then(|bytes| normalise_news_image(&bytes))
                .unwrap_or(fallback);
                (index, image)
            });
        }
        while let Some(result) = tasks.join_next().await {
            if let Ok((index, image)) = result {
                if let Some(item) = items.get_mut(index) {
                    item.image_data_url = image;
                }
            }
        }
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
    let mut items = state.feed().await?;
    if let Some(category) = query.category {
        items.retain(|item| item.category == category);
    }
    items.truncate(limit);
    Ok(Json(NewsResponse { items }))
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

fn parse_blog(body: &str) -> Vec<NewsItem> {
    let document = Html::parse_document(body);
    let post = Selector::parse(".post-lead").expect("static CSS selector");
    let title = Selector::parse("h3 a").expect("static CSS selector");
    let paragraph = Selector::parse("p").expect("static CSS selector");
    let category = Selector::parse("small a").expect("static CSS selector");

    document
        .select(&post)
        .filter_map(|element| {
            let title_link = element.select(&title).next()?;
            let relative_url = title_link.value().attr("href")?;
            if !relative_url.starts_with('/') || relative_url.contains("..") {
                return None;
            }
            let title = text(&title_link);
            let paragraphs: Vec<String> =
                element.select(&paragraph).map(|item| text(&item)).collect();
            let metadata = paragraphs.get(1)?;
            let published_at = parse_published_at(metadata)?;
            let categories: Vec<String> = element
                .select(&category)
                .map(|item| text(&item).to_lowercase())
                .collect();
            let category = classify(&title, &categories);
            let summary = paragraphs
                .first()
                .filter(|summary| !summary.is_empty())
                .cloned()
                .unwrap_or_else(|| title.clone());
            let url = format!("https://www.getmonero.org{relative_url}");
            let image_data_url = fallback_news_image(&title, category);
            Some(NewsItem {
                id: relative_url.trim_start_matches('/').replace('/', "-"),
                title,
                summary,
                published_at,
                category,
                url,
                image_data_url,
            })
        })
        .collect()
}

async fn fetch_article_image(client: &reqwest::Client, article_url: &str) -> Option<Vec<u8>> {
    let article = client
        .get(article_url)
        .send()
        .await
        .ok()?
        .error_for_status()
        .ok()?
        .text()
        .await
        .ok()?;
    let image_url = parse_article_image_url(&article)?;
    let response = client
        .get(image_url)
        .send()
        .await
        .ok()?
        .error_for_status()
        .ok()?;
    if response
        .content_length()
        .is_some_and(|length| length > NEWS_IMAGE_SOURCE_LIMIT as u64)
    {
        return None;
    }
    let bytes = response.bytes().await.ok()?;
    (bytes.len() <= NEWS_IMAGE_SOURCE_LIMIT).then(|| bytes.to_vec())
}

fn parse_article_image_url(body: &str) -> Option<String> {
    let document = Html::parse_document(body);
    let selector = Selector::parse(r#"meta[property="og:image"]"#).ok()?;
    let value = document
        .select(&selector)
        .find_map(|element| element.value().attr("content"))?;
    let base = url::Url::parse(SOURCE_URL).ok()?;
    let parsed = base.join(value).ok()?;
    if parsed.scheme() != "https" || parsed.host_str() != Some("www.getmonero.org") {
        return None;
    }
    Some(parsed.to_string())
}

fn normalise_news_image(bytes: &[u8]) -> Option<String> {
    let image = image::load_from_memory(bytes).ok()?;
    let (width, height) = image.dimensions();
    if width == 0 || height == 0 || u64::from(width) * u64::from(height) > 40_000_000 {
        return None;
    }
    let resized = image
        .resize_to_fill(NEWS_IMAGE_WIDTH, NEWS_IMAGE_HEIGHT, FilterType::Triangle)
        .to_rgb8();
    encode_catalog_jpeg(&resized)
}

fn fallback_news_image(title: &str, category: NewsCategory) -> String {
    let seed = title.bytes().fold(0_u32, |value, byte| {
        value.wrapping_mul(33).wrapping_add(u32::from(byte))
    });
    let accent = match category {
        NewsCategory::Network => (242_u8, 104_u8, 34_u8),
        NewsCategory::Wallet => (244_u8, 189_u8, 85_u8),
        NewsCategory::Ecosystem => (0_u8, 214_u8, 143_u8),
    };
    let image = RgbImage::from_fn(NEWS_IMAGE_WIDTH, NEWS_IMAGE_HEIGHT, |x, y| {
        let horizontal = x as f32 / NEWS_IMAGE_WIDTH as f32;
        let vertical = y as f32 / NEWS_IMAGE_HEIGHT as f32;
        let glow_x = ((seed % NEWS_IMAGE_WIDTH) as f32 - x as f32).abs() / NEWS_IMAGE_WIDTH as f32;
        let glow = (1.0 - glow_x).max(0.0) * (1.0 - vertical * 0.55);
        let stripe = if (x + y + seed) % 173 < 5 { 0.13 } else { 0.0 };
        let mix = (horizontal * 0.18 + glow * 0.32 + stripe).clamp(0.0, 0.58);
        Rgb([
            (13.0 + f32::from(accent.0) * mix) as u8,
            (10.0 + f32::from(accent.1) * mix) as u8,
            (22.0 + f32::from(accent.2) * mix) as u8,
        ])
    });
    encode_catalog_jpeg(&image).expect("generated news image is encodable")
}

fn encode_catalog_jpeg(image: &RgbImage) -> Option<String> {
    for quality in [72_u8, 60, 48, 36] {
        let mut encoded = Vec::new();
        JpegEncoder::new_with_quality(&mut encoded, quality)
            .encode_image(&DynamicImage::ImageRgb8(image.clone()))
            .ok()?;
        if encoded.len() <= NEWS_IMAGE_JPEG_LIMIT {
            return Some(format!(
                "data:image/jpeg;base64,{}",
                STANDARD.encode(encoded)
            ));
        }
    }
    None
}

fn text(element: &scraper::ElementRef<'_>) -> String {
    element
        .text()
        .collect::<Vec<_>>()
        .join(" ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn parse_published_at(metadata: &str) -> Option<String> {
    let date = metadata
        .split("| ")
        .nth(1)?
        .split("Category:")
        .next()?
        .trim();
    let date = NaiveDate::parse_from_str(date, "%d %B %Y").ok()?;
    let timestamp = date.and_hms_opt(0, 0, 0)?;
    Some(DateTime::<Utc>::from_naive_utc_and_offset(timestamp, Utc).to_rfc3339())
}

fn classify(title: &str, categories: &[String]) -> NewsCategory {
    let haystack = format!("{} {}", title.to_lowercase(), categories.join(" "));
    if haystack.contains("wallet") || haystack.contains("gui") || haystack.contains("ledger") {
        NewsCategory::Wallet
    } else if haystack.contains("community")
        || haystack.contains("meeting")
        || haystack.contains("ecosystem")
    {
        NewsCategory::Ecosystem
    } else {
        NewsCategory::Network
    }
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
    fn parses_and_classifies_official_blog_posts() {
        let html = r#"
          <div class="post-lead">
            <h3><a href="/2026/07/21/monero-GUI-released.html">Monero GUI released</a></h3>
            <p>Release fixing wallet generation.</p>
            <p><small>Posted by alice | 21 July 2026<br>Category: <a href="/blog/tags/releases.html">releases</a></small></p>
          </div>
          <div class="post-lead">
            <h3><a href="/2026/07/20/community.html">Community meeting</a></h3>
            <p>People met privately.</p>
            <p><small>Posted by bob | 20 July 2026<br>Category: <a href="/blog/tags/community.html">community</a></small></p>
          </div>"#;
        let news = parse_blog(html);
        assert_eq!(news.len(), 2);
        assert_eq!(news[0].category, NewsCategory::Wallet);
        assert_eq!(news[1].category, NewsCategory::Ecosystem);
        assert!(news
            .iter()
            .all(|item| item.url.starts_with("https://www.getmonero.org/")));
        assert!(news
            .iter()
            .all(|item| item.image_data_url.starts_with("data:image/jpeg;base64,")));
    }

    #[test]
    fn catalog_images_have_a_fixed_private_payload() {
        let data_url = fallback_news_image("Private Monero news", NewsCategory::Network);
        let encoded = data_url
            .strip_prefix("data:image/jpeg;base64,")
            .expect("JPEG data URL");
        let bytes = STANDARD.decode(encoded).expect("base64 image");
        assert!(bytes.len() <= NEWS_IMAGE_JPEG_LIMIT);
        let decoded = image::load_from_memory(&bytes).expect("catalog image");
        assert_eq!(decoded.dimensions(), (NEWS_IMAGE_WIDTH, NEWS_IMAGE_HEIGHT));
    }

    #[test]
    fn accepts_only_official_monero_article_images() {
        let relative = r#"<meta property="og:image" content="/press-kit/images/monero-logo.png">"#;
        assert_eq!(
            parse_article_image_url(relative).as_deref(),
            Some("https://www.getmonero.org/press-kit/images/monero-logo.png")
        );
        let external = r#"<meta property="og:image" content="https://tracker.example/image.jpg">"#;
        assert!(parse_article_image_url(external).is_none());
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
