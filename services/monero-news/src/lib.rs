//! A small server-owned news feed for the wallet dashboard.
//!
//! The mobile clients never scrape a third party.  This service retrieves the
//! public Monero blog, normalises the small response contract, caches it, and
//! only returns official getmonero.org article links.

use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::IntoResponse,
    routing::get,
    Json, Router,
};
use chrono::{DateTime, NaiveDate, Utc};
use scraper::{Html, Selector};
use serde::{Deserialize, Serialize};
use std::{sync::Arc, time::{Duration, Instant}};
use tokio::sync::RwLock;

const SOURCE_URL: &str = "https://www.getmonero.org/blog/";
const CACHE_FOR: Duration = Duration::from_secs(15 * 60);

#[derive(Clone)]
pub struct NewsState {
    client: reqwest::Client,
    cache: Arc<RwLock<Option<CachedFeed>>>,
}

#[derive(Clone)]
struct CachedFeed {
    fetched_at: Instant,
    items: Vec<NewsItem>,
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

#[derive(Deserialize)]
struct NewsQuery {
    category: Option<NewsCategory>,
    limit: Option<usize>,
}

impl NewsState {
    pub fn new() -> Result<Self, String> {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(12))
            .user_agent("Monero-Fast-Wallet-News/1.0 (+https://solutions.tex8.com/en)")
            .build()
            .map_err(|error| format!("news HTTP client could not start: {error}"))?;
        Ok(Self {
            client,
            cache: Arc::new(RwLock::new(None)),
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
        let items = parse_blog(&body);
        if items.is_empty() {
            return Err(ApiError::Unavailable);
        }
        *self.cache.write().await = Some(CachedFeed {
            fetched_at: Instant::now(),
            items: items.clone(),
        });
        Ok(items)
    }
}

pub fn router(state: NewsState) -> Router {
    Router::new()
        .route("/healthz", get(healthz))
        .route("/v1/news", get(news))
        .with_state(state)
}

async fn healthz() -> Json<serde_json::Value> {
    Json(serde_json::json!({ "ok": true }))
}

async fn news(
    State(state): State<NewsState>,
    Query(query): Query<NewsQuery>,
) -> Result<Json<NewsResponse>, ApiError> {
    let limit = query.limit.unwrap_or(12).clamp(1, 30);
    let mut items = state.feed().await?;
    if let Some(category) = query.category {
        items.retain(|item| item.category == category);
    }
    items.truncate(limit);
    Ok(Json(NewsResponse { items }))
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
            let paragraphs: Vec<String> = element.select(&paragraph).map(|item| text(&item)).collect();
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
            Some(NewsItem {
                id: relative_url.trim_start_matches('/').replace('/', "-"),
                title,
                summary,
                published_at,
                category,
                url,
            })
        })
        .collect()
}

fn text(element: &scraper::ElementRef<'_>) -> String {
    element.text().collect::<Vec<_>>().join(" ").split_whitespace().collect::<Vec<_>>().join(" ")
}

fn parse_published_at(metadata: &str) -> Option<String> {
    let date = metadata.split("| ").nth(1)?.split("Category:").next()?.trim();
    let date = NaiveDate::parse_from_str(date, "%d %B %Y").ok()?;
    let timestamp = date.and_hms_opt(0, 0, 0)?;
    Some(DateTime::<Utc>::from_naive_utc_and_offset(timestamp, Utc).to_rfc3339())
}

fn classify(title: &str, categories: &[String]) -> NewsCategory {
    let haystack = format!("{} {}", title.to_lowercase(), categories.join(" "));
    if haystack.contains("wallet") || haystack.contains("gui") || haystack.contains("ledger") {
        NewsCategory::Wallet
    } else if haystack.contains("community") || haystack.contains("meeting") || haystack.contains("ecosystem") {
        NewsCategory::Ecosystem
    } else {
        NewsCategory::Network
    }
}

enum ApiError {
    Unavailable,
}

impl IntoResponse for ApiError {
    fn into_response(self) -> axum::response::Response {
        (StatusCode::SERVICE_UNAVAILABLE, Json(serde_json::json!({
            "error": "news_unavailable"
        }))).into_response()
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
        assert!(news.iter().all(|item| item.url.starts_with("https://www.getmonero.org/")));
    }
}
