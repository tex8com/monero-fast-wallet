use crate::NewsState;
use axum::{
    extract::{Path, Query, State},
    http::{
        header::{CACHE_CONTROL, CONTENT_TYPE},
        HeaderMap, HeaderValue, StatusCode,
    },
    response::IntoResponse,
    Json,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use chrono::{DateTime, Duration as ChronoDuration, SecondsFormat, Utc};
use ed25519_dalek::{Signer, SigningKey};
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    env,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use subtle::ConstantTimeEq;
use url::Url;
use uuid::Uuid;

const MAX_CAMPAIGN_DURATION_DAYS: i64 = 30;
const CATALOG_VALIDITY_MINUTES: i64 = 10;
const MAX_TEXT_LENGTH: usize = 280;
const MAX_TITLE_LENGTH: usize = 80;
const MAX_CATEGORIES: usize = 12;
const MAX_REGIONS: usize = 64;
const ADVERTISING_EMBEDDING_MODEL: &str = "harrier-oss-v1-270m-community-v1";
const ADVERTISING_EMBEDDING_DIMENSIONS: usize = 640;
const CATALOG_CACHE_FOR: Duration = Duration::from_secs(30);
const ISO_3166_ALPHA_2: &str = "
AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ
BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ
CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ
DE DJ DK DM DO DZ
EC EE EG EH ER ES ET
FI FJ FK FM FO FR
GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY
HK HM HN HR HT HU
ID IE IL IM IN IO IQ IR IS IT
JE JM JO JP
KE KG KH KI KM KN KP KR KW KY KZ
LA LB LC LI LK LR LS LT LU LV LY
MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ
NA NC NE NF NG NI NL NO NP NR NU NZ
OM
PA PE PF PG PH PK PL PM PN PR PS PT PW PY
QA
RE RO RS RU RW
SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ
TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ
UA UG UM US UY UZ
VA VC VE VG VI VN VU
WF WS
YE YT
ZA ZM ZW
";

#[derive(Clone)]
pub(crate) struct AdService {
    backend: Option<Arc<AdBackend>>,
}

struct AdBackend {
    database: Mutex<Connection>,
    catalog_cache: Mutex<HashMap<String, CachedAdCatalog>>,
    admin_token: Vec<u8>,
    signing_key: SigningKey,
    signing_key_id: String,
    policy_version: String,
}

#[derive(Clone)]
struct CachedAdCatalog {
    cached_at: Instant,
    response: SignedAdCatalog,
}

#[derive(Clone)]
pub struct AdConfig {
    pub database_path: PathBuf,
    pub admin_token: String,
    pub signing_key: [u8; 32],
    pub signing_key_id: String,
    pub policy_version: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AdKind {
    OrdinaryProduct,
    OrdinaryService,
    NewsSponsorship,
    CryptoExchange,
    CryptoInvestment,
    CryptoYield,
    Gambling,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AdPlacement {
    News,
    Community,
    Catalog,
}

impl AdPlacement {
    fn as_str(self) -> &'static str {
        match self {
            Self::News => "news",
            Self::Community => "community",
            Self::Catalog => "catalog",
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SponsorshipLabel {
    Advertisement,
    Sponsored,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum CampaignStatus {
    Draft,
    Approved,
    Withdrawn,
}

impl CampaignStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Draft => "draft",
            Self::Approved => "approved",
            Self::Withdrawn => "withdrawn",
        }
    }

    fn parse(value: &str) -> Result<Self, AdApiError> {
        match value {
            "draft" => Ok(Self::Draft),
            "approved" => Ok(Self::Approved),
            "withdrawn" => Ok(Self::Withdrawn),
            _ => Err(AdApiError::Internal),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateAdCampaign {
    pub advertiser_id: String,
    pub advertiser_display_name: String,
    pub paid_by_id: String,
    pub paid_by_display_name: String,
    pub kind: AdKind,
    pub placement: AdPlacement,
    pub title: String,
    pub body: String,
    pub destination_url: String,
    pub media_url: Option<String>,
    pub starts_at: String,
    pub ends_at: String,
    pub eligible_categories: Vec<String>,
    pub eligible_regions: Vec<String>,
    pub placement_weight: u16,
    pub frequency_cap: u16,
    pub sponsorship_label: SponsorshipLabel,
    pub embedding_model: Option<String>,
    pub embedding: Option<Vec<f32>>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApproveCampaign {
    pub reviewer_id: String,
    pub jurisdiction_review_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WithdrawCampaign {
    pub reviewer_id: String,
    pub reason: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AdCampaign {
    pub campaign_id: String,
    pub content_revision: u64,
    pub advertiser_id: String,
    pub advertiser_display_name: String,
    pub paid_by_id: String,
    pub paid_by_display_name: String,
    pub kind: AdKind,
    pub placement: AdPlacement,
    pub title: String,
    pub body: String,
    pub destination_url: String,
    pub media_url: Option<String>,
    pub starts_at: String,
    pub ends_at: String,
    pub eligible_categories: Vec<String>,
    pub eligible_regions: Vec<String>,
    pub placement_weight: u16,
    pub frequency_cap: u16,
    pub sponsorship_label: SponsorshipLabel,
    pub embedding_model: Option<String>,
    pub embedding: Option<Vec<f32>>,
    pub status: CampaignStatus,
    pub created_at: String,
    pub reviewed_at: Option<String>,
    pub jurisdiction_review_id: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AdCatalog {
    pub catalog_scope_id: String,
    pub jurisdiction_review_ids: Vec<String>,
    pub policy_version: String,
    pub generation: u64,
    pub generated_at: String,
    pub expires_at: String,
    pub campaigns: Vec<AdCampaign>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignedAdCatalog {
    pub catalog: AdCatalog,
    pub signed_catalog: String,
    pub algorithm: String,
    pub signing_key_id: String,
    pub signing_public_key: String,
    pub signature: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct AdCatalogQuery {
    country: String,
    placement: AdPlacement,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AdminCampaignsResponse {
    campaigns: Vec<AdCampaign>,
}

impl AdService {
    pub(crate) fn from_env() -> Result<Self, String> {
        let database_path = env::var_os("TEX8_AD_DATABASE");
        let admin_token = env::var("TEX8_AD_ADMIN_TOKEN").ok();
        let signing_key = env::var("TEX8_AD_SIGNING_KEY_HEX").ok();
        let signing_key_id = env::var("TEX8_AD_SIGNING_KEY_ID").ok();
        let configured = [
            database_path.is_some(),
            admin_token.is_some(),
            signing_key.is_some(),
            signing_key_id.is_some(),
        ];
        if configured.iter().all(|value| !value) {
            return Ok(Self::disabled());
        }
        if configured.iter().any(|value| !value) {
            return Err(
                "advertising requires TEX8_AD_DATABASE, TEX8_AD_ADMIN_TOKEN, \
                 TEX8_AD_SIGNING_KEY_HEX and TEX8_AD_SIGNING_KEY_ID"
                    .to_owned(),
            );
        }
        let key_bytes = hex::decode(signing_key.expect("configuration completeness checked"))
            .map_err(|_| {
                "TEX8_AD_SIGNING_KEY_HEX must contain exactly 64 hexadecimal characters".to_owned()
            })?;
        let key_bytes: [u8; 32] = key_bytes.try_into().map_err(|_| {
            "TEX8_AD_SIGNING_KEY_HEX must contain exactly 64 hexadecimal characters".to_owned()
        })?;
        Self::enabled(AdConfig {
            database_path: PathBuf::from(
                database_path.expect("configuration completeness checked"),
            ),
            admin_token: admin_token.expect("configuration completeness checked"),
            signing_key: key_bytes,
            signing_key_id: signing_key_id.expect("configuration completeness checked"),
            policy_version: env::var("TEX8_AD_POLICY_VERSION")
                .unwrap_or_else(|_| "ads-local-v1".to_owned()),
        })
    }

    pub(crate) fn disabled() -> Self {
        Self { backend: None }
    }

    pub(crate) fn enabled(config: AdConfig) -> Result<Self, String> {
        validate_identifier("signing key ID", &config.signing_key_id, 80)
            .map_err(|error| error.code().to_owned())?;
        validate_identifier("policy version", &config.policy_version, 80)
            .map_err(|error| error.code().to_owned())?;
        if config.admin_token.len() < 32 {
            return Err("TEX8_AD_ADMIN_TOKEN must contain at least 32 bytes".to_owned());
        }
        let connection = Connection::open(&config.database_path)
            .map_err(|error| format!("advertising database could not open: {error}"))?;
        connection
            .busy_timeout(Duration::from_secs(5))
            .map_err(|error| format!("advertising database timeout could not be set: {error}"))?;
        initialise_database(&connection)
            .map_err(|error| format!("advertising database could not initialise: {error}"))?;
        Ok(Self {
            backend: Some(Arc::new(AdBackend {
                database: Mutex::new(connection),
                catalog_cache: Mutex::new(HashMap::new()),
                admin_token: config.admin_token.into_bytes(),
                signing_key: SigningKey::from_bytes(&config.signing_key),
                signing_key_id: config.signing_key_id,
                policy_version: config.policy_version,
            })),
        })
    }

    pub(crate) fn is_enabled(&self) -> bool {
        self.backend.is_some()
    }

    fn backend(&self) -> Result<Arc<AdBackend>, AdApiError> {
        self.backend
            .as_ref()
            .cloned()
            .ok_or(AdApiError::AdvertisingDisabled)
    }

    fn authorise(&self, headers: &HeaderMap) -> Result<(), AdApiError> {
        let backend = self.backend()?;
        let supplied = headers
            .get(axum::http::header::AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.strip_prefix("Bearer "))
            .ok_or(AdApiError::Unauthorized)?;
        let supplied = supplied.as_bytes();
        if supplied.len() != backend.admin_token.len()
            || supplied.ct_eq(&backend.admin_token).unwrap_u8() != 1
        {
            return Err(AdApiError::Unauthorized);
        }
        Ok(())
    }

    async fn create(&self, input: CreateAdCampaign) -> Result<AdCampaign, AdApiError> {
        validate_campaign(&input)?;
        let backend = self.backend()?;
        tokio::task::spawn_blocking(move || backend.create(input))
            .await
            .map_err(|_| AdApiError::Internal)?
    }

    async fn approve(
        &self,
        campaign_id: String,
        input: ApproveCampaign,
    ) -> Result<AdCampaign, AdApiError> {
        validate_identifier("reviewer ID", &input.reviewer_id, 100)?;
        validate_identifier("jurisdiction review ID", &input.jurisdiction_review_id, 100)?;
        let backend = self.backend()?;
        tokio::task::spawn_blocking(move || backend.approve(&campaign_id, input))
            .await
            .map_err(|_| AdApiError::Internal)?
    }

    async fn withdraw(
        &self,
        campaign_id: String,
        input: WithdrawCampaign,
    ) -> Result<AdCampaign, AdApiError> {
        validate_identifier("reviewer ID", &input.reviewer_id, 100)?;
        validate_plain_text("withdrawal reason", &input.reason, 4, MAX_TEXT_LENGTH)?;
        let backend = self.backend()?;
        tokio::task::spawn_blocking(move || backend.withdraw(&campaign_id, input))
            .await
            .map_err(|_| AdApiError::Internal)?
    }

    async fn list(&self) -> Result<Vec<AdCampaign>, AdApiError> {
        let backend = self.backend()?;
        tokio::task::spawn_blocking(move || backend.list())
            .await
            .map_err(|_| AdApiError::Internal)?
    }

    async fn catalog(
        &self,
        country: String,
        placement: AdPlacement,
    ) -> Result<SignedAdCatalog, AdApiError> {
        let country = normalise_country(&country)?;
        let backend = self.backend()?;
        tokio::task::spawn_blocking(move || backend.catalog(&country, placement))
            .await
            .map_err(|_| AdApiError::Internal)?
    }
}

impl AdBackend {
    fn connection(&self) -> Result<std::sync::MutexGuard<'_, Connection>, AdApiError> {
        self.database.lock().map_err(|_| AdApiError::Internal)
    }

    fn create(&self, input: CreateAdCampaign) -> Result<AdCampaign, AdApiError> {
        let now = timestamp(Utc::now());
        let campaign = AdCampaign {
            campaign_id: Uuid::new_v4().to_string(),
            content_revision: 1,
            advertiser_id: input.advertiser_id,
            advertiser_display_name: input.advertiser_display_name,
            paid_by_id: input.paid_by_id,
            paid_by_display_name: input.paid_by_display_name,
            kind: input.kind,
            placement: input.placement,
            title: input.title,
            body: input.body,
            destination_url: input.destination_url,
            media_url: input.media_url,
            starts_at: normalise_timestamp(&input.starts_at)?,
            ends_at: normalise_timestamp(&input.ends_at)?,
            eligible_categories: input.eligible_categories,
            eligible_regions: input
                .eligible_regions
                .iter()
                .map(|region| normalise_country(region))
                .collect::<Result<_, _>>()?,
            placement_weight: input.placement_weight,
            frequency_cap: input.frequency_cap,
            sponsorship_label: input.sponsorship_label,
            embedding_model: input.embedding_model,
            embedding: input.embedding,
            status: CampaignStatus::Draft,
            created_at: now.clone(),
            reviewed_at: None,
            jurisdiction_review_id: None,
        };
        let mut database = self.connection()?;
        let transaction = database.transaction().map_err(|_| AdApiError::Internal)?;
        insert_campaign(&transaction, &campaign)?;
        insert_audit(
            &transaction,
            &campaign.campaign_id,
            "created",
            "system",
            &now,
            None,
        )?;
        transaction.commit().map_err(|_| AdApiError::Internal)?;
        Ok(campaign)
    }

    fn approve(&self, campaign_id: &str, input: ApproveCampaign) -> Result<AdCampaign, AdApiError> {
        validate_uuid(campaign_id)?;
        let now = Utc::now();
        let mut database = self.connection()?;
        let transaction = database.transaction().map_err(|_| AdApiError::Internal)?;
        let mut campaign =
            select_campaign(&transaction, campaign_id)?.ok_or(AdApiError::NotFound)?;
        if campaign.status != CampaignStatus::Draft {
            return Err(AdApiError::InvalidState);
        }
        let ends_at = parse_timestamp(&campaign.ends_at)?;
        if ends_at <= now {
            return Err(AdApiError::CampaignExpired);
        }
        campaign.status = CampaignStatus::Approved;
        campaign.reviewed_at = Some(timestamp(now));
        campaign.jurisdiction_review_id = Some(input.jurisdiction_review_id);
        transaction
            .execute(
                "UPDATE ad_campaigns
                 SET status = ?2, reviewed_at = ?3, jurisdiction_review_id = ?4
                 WHERE campaign_id = ?1",
                params![
                    campaign.campaign_id,
                    campaign.status.as_str(),
                    campaign.reviewed_at,
                    campaign.jurisdiction_review_id,
                ],
            )
            .map_err(|_| AdApiError::Internal)?;
        bump_generation(&transaction)?;
        insert_audit(
            &transaction,
            &campaign.campaign_id,
            "approved",
            &input.reviewer_id,
            campaign.reviewed_at.as_deref().expect("review timestamp"),
            campaign.jurisdiction_review_id.as_deref(),
        )?;
        transaction.commit().map_err(|_| AdApiError::Internal)?;
        self.clear_catalog_cache()?;
        Ok(campaign)
    }

    fn withdraw(
        &self,
        campaign_id: &str,
        input: WithdrawCampaign,
    ) -> Result<AdCampaign, AdApiError> {
        validate_uuid(campaign_id)?;
        let now = timestamp(Utc::now());
        let mut database = self.connection()?;
        let transaction = database.transaction().map_err(|_| AdApiError::Internal)?;
        let mut campaign =
            select_campaign(&transaction, campaign_id)?.ok_or(AdApiError::NotFound)?;
        if campaign.status == CampaignStatus::Withdrawn {
            return Err(AdApiError::InvalidState);
        }
        let was_public = campaign.status == CampaignStatus::Approved;
        campaign.status = CampaignStatus::Withdrawn;
        transaction
            .execute(
                "UPDATE ad_campaigns SET status = ?2 WHERE campaign_id = ?1",
                params![campaign.campaign_id, campaign.status.as_str()],
            )
            .map_err(|_| AdApiError::Internal)?;
        if was_public {
            bump_generation(&transaction)?;
        }
        insert_audit(
            &transaction,
            &campaign.campaign_id,
            "withdrawn",
            &input.reviewer_id,
            &now,
            Some(&input.reason),
        )?;
        transaction.commit().map_err(|_| AdApiError::Internal)?;
        if was_public {
            self.clear_catalog_cache()?;
        }
        Ok(campaign)
    }

    fn list(&self) -> Result<Vec<AdCampaign>, AdApiError> {
        let database = self.connection()?;
        let mut statement = database
            .prepare(
                "SELECT campaign_id, content_revision, advertiser_id,
                        advertiser_display_name, paid_by_id, paid_by_display_name,
                        kind, placement, title, body, destination_url, media_url,
                        starts_at, ends_at, eligible_categories, eligible_regions,
                        placement_weight, frequency_cap, sponsorship_label,
                        embedding_model, embedding, status, created_at, reviewed_at,
                        jurisdiction_review_id
                 FROM ad_campaigns ORDER BY created_at DESC, campaign_id",
            )
            .map_err(|_| AdApiError::Internal)?;
        let rows = statement
            .query_map([], campaign_from_row)
            .map_err(|_| AdApiError::Internal)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|_| AdApiError::Internal)
    }

    fn catalog(
        &self,
        country: &str,
        placement: AdPlacement,
    ) -> Result<SignedAdCatalog, AdApiError> {
        let cache_key = format!("{country}:{}", placement.as_str());
        if let Some(response) = self
            .catalog_cache
            .lock()
            .map_err(|_| AdApiError::Internal)?
            .get(&cache_key)
            .filter(|cached| {
                cached.cached_at.elapsed() < CATALOG_CACHE_FOR
                    && parse_timestamp(&cached.response.catalog.expires_at)
                        .is_ok_and(|expires_at| expires_at > Utc::now())
            })
            .map(|cached| cached.response.clone())
        {
            return Ok(response);
        }
        let now = Utc::now();
        let now_text = timestamp(now);
        let database = self.connection()?;
        let generation = generation(&database)?;
        let (mut campaigns, next_transition) =
            self.list_for_catalog(&database, country, placement, now)?;
        campaigns.sort_by(|left, right| left.campaign_id.cmp(&right.campaign_id));
        let mut jurisdiction_review_ids = campaigns
            .iter()
            .filter_map(|campaign| campaign.jurisdiction_review_id.clone())
            .collect::<Vec<_>>();
        jurisdiction_review_ids.sort();
        jurisdiction_review_ids.dedup();
        let default_expiry = now + ChronoDuration::minutes(CATALOG_VALIDITY_MINUTES);
        let expires_at = next_transition
            .filter(|transition| *transition < default_expiry)
            .unwrap_or(default_expiry);
        let catalog = AdCatalog {
            catalog_scope_id: format!("ads:{country}:{}", placement.as_str()),
            jurisdiction_review_ids,
            policy_version: self.policy_version.clone(),
            generation,
            generated_at: now_text,
            expires_at: timestamp(expires_at),
            campaigns,
        };
        let signed_bytes = serde_json::to_vec(&catalog).map_err(|_| AdApiError::Internal)?;
        let signature = self.signing_key.sign(&signed_bytes);
        let response = SignedAdCatalog {
            catalog,
            signed_catalog: BASE64.encode(&signed_bytes),
            algorithm: "Ed25519".to_owned(),
            signing_key_id: self.signing_key_id.clone(),
            signing_public_key: BASE64.encode(self.signing_key.verifying_key().as_bytes()),
            signature: BASE64.encode(signature.to_bytes()),
        };
        self.catalog_cache
            .lock()
            .map_err(|_| AdApiError::Internal)?
            .insert(
                cache_key,
                CachedAdCatalog {
                    cached_at: Instant::now(),
                    response: response.clone(),
                },
            );
        Ok(response)
    }

    fn list_for_catalog(
        &self,
        database: &Connection,
        country: &str,
        placement: AdPlacement,
        now: DateTime<Utc>,
    ) -> Result<(Vec<AdCampaign>, Option<DateTime<Utc>>), AdApiError> {
        let mut statement = database
            .prepare(
                "SELECT campaign_id, content_revision, advertiser_id,
                        advertiser_display_name, paid_by_id, paid_by_display_name,
                        kind, placement, title, body, destination_url, media_url,
                        starts_at, ends_at, eligible_categories, eligible_regions,
                        placement_weight, frequency_cap, sponsorship_label,
                        embedding_model, embedding, status, created_at, reviewed_at,
                        jurisdiction_review_id
                 FROM ad_campaigns
                 WHERE status = 'approved' AND placement = ?1",
            )
            .map_err(|_| AdApiError::Internal)?;
        let rows = statement
            .query_map(params![placement.as_str()], campaign_from_row)
            .map_err(|_| AdApiError::Internal)?;
        let candidates = rows
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| AdApiError::Internal)?;
        let mut campaigns = Vec::new();
        let mut next_transition = None;
        for campaign in candidates.into_iter().filter(|campaign| {
            campaign
                .eligible_regions
                .iter()
                .any(|region| region == country)
                && !matches!(
                    campaign.kind,
                    AdKind::CryptoExchange
                        | AdKind::CryptoInvestment
                        | AdKind::CryptoYield
                        | AdKind::Gambling
                )
        }) {
            let starts_at = parse_timestamp(&campaign.starts_at)?;
            let ends_at = parse_timestamp(&campaign.ends_at)?;
            let transition = if starts_at > now {
                Some(starts_at)
            } else if ends_at > now {
                Some(ends_at)
            } else {
                None
            };
            if let Some(transition) = transition {
                next_transition = Some(
                    next_transition
                        .map(|current: DateTime<Utc>| current.min(transition))
                        .unwrap_or(transition),
                );
            }
            if starts_at <= now && ends_at > now {
                campaigns.push(campaign);
            }
        }
        Ok((campaigns, next_transition))
    }

    fn clear_catalog_cache(&self) -> Result<(), AdApiError> {
        self.catalog_cache
            .lock()
            .map_err(|_| AdApiError::Internal)?
            .clear();
        Ok(())
    }
}

pub(crate) async fn public_catalog(
    State(state): State<NewsState>,
    Query(query): Query<AdCatalogQuery>,
) -> Result<(HeaderMap, Json<SignedAdCatalog>), AdApiError> {
    catalog_response(&state, query.country, query.placement).await
}

pub(crate) async fn public_catalog_path(
    State(state): State<NewsState>,
    Path((country, placement)): Path<(String, AdPlacement)>,
) -> Result<(HeaderMap, Json<SignedAdCatalog>), AdApiError> {
    catalog_response(&state, country, placement).await
}

async fn catalog_response(
    state: &NewsState,
    country: String,
    placement: AdPlacement,
) -> Result<(HeaderMap, Json<SignedAdCatalog>), AdApiError> {
    let catalog = state.ads.catalog(country, placement).await?;
    let max_age = parse_timestamp(&catalog.catalog.expires_at)
        .map(|expires_at| (expires_at - Utc::now()).num_seconds().clamp(0, 30))
        .unwrap_or(0);
    let mut headers = HeaderMap::new();
    headers.insert(
        CACHE_CONTROL,
        HeaderValue::from_str(&format!("public, max-age={max_age}, must-revalidate"))
            .map_err(|_| AdApiError::Internal)?,
    );
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    Ok((headers, Json(catalog)))
}

pub(crate) async fn admin_create(
    State(state): State<NewsState>,
    headers: HeaderMap,
    Json(input): Json<CreateAdCampaign>,
) -> Result<(StatusCode, Json<AdCampaign>), AdApiError> {
    state.ads.authorise(&headers)?;
    let campaign = state.ads.create(input).await?;
    Ok((StatusCode::CREATED, Json(campaign)))
}

pub(crate) async fn admin_approve(
    State(state): State<NewsState>,
    Path(campaign_id): Path<String>,
    headers: HeaderMap,
    Json(input): Json<ApproveCampaign>,
) -> Result<Json<AdCampaign>, AdApiError> {
    state.ads.authorise(&headers)?;
    state.ads.approve(campaign_id, input).await.map(Json)
}

pub(crate) async fn admin_withdraw(
    State(state): State<NewsState>,
    Path(campaign_id): Path<String>,
    headers: HeaderMap,
    Json(input): Json<WithdrawCampaign>,
) -> Result<Json<AdCampaign>, AdApiError> {
    state.ads.authorise(&headers)?;
    state.ads.withdraw(campaign_id, input).await.map(Json)
}

pub(crate) async fn admin_list(
    State(state): State<NewsState>,
    headers: HeaderMap,
) -> Result<Json<AdminCampaignsResponse>, AdApiError> {
    state.ads.authorise(&headers)?;
    let campaigns = state.ads.list().await?;
    Ok(Json(AdminCampaignsResponse { campaigns }))
}

fn initialise_database(database: &Connection) -> rusqlite::Result<()> {
    database.execute_batch(
        "PRAGMA foreign_keys = ON;
         PRAGMA journal_mode = WAL;
         CREATE TABLE IF NOT EXISTS ad_campaigns (
           campaign_id TEXT PRIMARY KEY,
           content_revision INTEGER NOT NULL,
           advertiser_id TEXT NOT NULL,
           advertiser_display_name TEXT NOT NULL,
           paid_by_id TEXT NOT NULL,
           paid_by_display_name TEXT NOT NULL,
           kind TEXT NOT NULL,
           placement TEXT NOT NULL,
           title TEXT NOT NULL,
           body TEXT NOT NULL,
           destination_url TEXT NOT NULL,
           media_url TEXT,
           starts_at TEXT NOT NULL,
           ends_at TEXT NOT NULL,
           eligible_categories TEXT NOT NULL,
           eligible_regions TEXT NOT NULL,
           placement_weight INTEGER NOT NULL,
           frequency_cap INTEGER NOT NULL,
           sponsorship_label TEXT NOT NULL,
           embedding_model TEXT,
           embedding TEXT,
           status TEXT NOT NULL,
           created_at TEXT NOT NULL,
           reviewed_at TEXT,
           jurisdiction_review_id TEXT
         );
         CREATE INDEX IF NOT EXISTS ad_campaign_public
           ON ad_campaigns(status, placement, starts_at, ends_at);
         CREATE TABLE IF NOT EXISTS ad_audit (
           audit_id INTEGER PRIMARY KEY AUTOINCREMENT,
           campaign_id TEXT NOT NULL,
           action TEXT NOT NULL,
           actor_id TEXT NOT NULL,
           occurred_at TEXT NOT NULL,
           detail TEXT,
           FOREIGN KEY(campaign_id) REFERENCES ad_campaigns(campaign_id)
         );
         CREATE TABLE IF NOT EXISTS ad_metadata (
           key TEXT PRIMARY KEY,
           value INTEGER NOT NULL
         );
         INSERT OR IGNORE INTO ad_metadata(key, value) VALUES ('generation', 0);",
    )
}

fn insert_campaign(transaction: &Transaction<'_>, campaign: &AdCampaign) -> Result<(), AdApiError> {
    transaction
        .execute(
            "INSERT INTO ad_campaigns (
               campaign_id, content_revision, advertiser_id,
               advertiser_display_name, paid_by_id, paid_by_display_name,
               kind, placement, title, body, destination_url, media_url,
               starts_at, ends_at, eligible_categories, eligible_regions,
               placement_weight, frequency_cap, sponsorship_label,
               embedding_model, embedding, status, created_at, reviewed_at,
               jurisdiction_review_id
             ) VALUES (
               ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
               ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25
             )",
            params![
                campaign.campaign_id,
                campaign.content_revision,
                campaign.advertiser_id,
                campaign.advertiser_display_name,
                campaign.paid_by_id,
                campaign.paid_by_display_name,
                ad_kind_text(campaign.kind),
                campaign.placement.as_str(),
                campaign.title,
                campaign.body,
                campaign.destination_url,
                campaign.media_url,
                campaign.starts_at,
                campaign.ends_at,
                to_json(&campaign.eligible_categories)?,
                to_json(&campaign.eligible_regions)?,
                campaign.placement_weight,
                campaign.frequency_cap,
                sponsorship_label_text(campaign.sponsorship_label),
                campaign.embedding_model,
                campaign.embedding.as_ref().map(to_json).transpose()?,
                campaign.status.as_str(),
                campaign.created_at,
                campaign.reviewed_at,
                campaign.jurisdiction_review_id,
            ],
        )
        .map_err(|_| AdApiError::Internal)?;
    Ok(())
}

fn select_campaign(
    transaction: &Transaction<'_>,
    campaign_id: &str,
) -> Result<Option<AdCampaign>, AdApiError> {
    transaction
        .query_row(
            "SELECT campaign_id, content_revision, advertiser_id,
                    advertiser_display_name, paid_by_id, paid_by_display_name,
                    kind, placement, title, body, destination_url, media_url,
                    starts_at, ends_at, eligible_categories, eligible_regions,
                    placement_weight, frequency_cap, sponsorship_label,
                    embedding_model, embedding, status, created_at, reviewed_at,
                    jurisdiction_review_id
             FROM ad_campaigns WHERE campaign_id = ?1",
            [campaign_id],
            campaign_from_row,
        )
        .optional()
        .map_err(|_| AdApiError::Internal)
}

fn campaign_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<AdCampaign> {
    let kind: String = row.get(6)?;
    let placement: String = row.get(7)?;
    let sponsorship_label: String = row.get(18)?;
    let embedding_json: Option<String> = row.get(20)?;
    let status: String = row.get(21)?;
    Ok(AdCampaign {
        campaign_id: row.get(0)?,
        content_revision: row.get(1)?,
        advertiser_id: row.get(2)?,
        advertiser_display_name: row.get(3)?,
        paid_by_id: row.get(4)?,
        paid_by_display_name: row.get(5)?,
        kind: parse_ad_kind(&kind).map_err(to_sql_error)?,
        placement: parse_placement(&placement).map_err(to_sql_error)?,
        title: row.get(8)?,
        body: row.get(9)?,
        destination_url: row.get(10)?,
        media_url: row.get(11)?,
        starts_at: row.get(12)?,
        ends_at: row.get(13)?,
        eligible_categories: parse_json(row.get::<_, String>(14)?).map_err(to_sql_error)?,
        eligible_regions: parse_json(row.get::<_, String>(15)?).map_err(to_sql_error)?,
        placement_weight: row.get(16)?,
        frequency_cap: row.get(17)?,
        sponsorship_label: parse_sponsorship_label(&sponsorship_label).map_err(to_sql_error)?,
        embedding_model: row.get(19)?,
        embedding: embedding_json
            .map(parse_json)
            .transpose()
            .map_err(to_sql_error)?,
        status: CampaignStatus::parse(&status).map_err(to_sql_error)?,
        created_at: row.get(22)?,
        reviewed_at: row.get(23)?,
        jurisdiction_review_id: row.get(24)?,
    })
}

fn insert_audit(
    transaction: &Transaction<'_>,
    campaign_id: &str,
    action: &str,
    actor_id: &str,
    occurred_at: &str,
    detail: Option<&str>,
) -> Result<(), AdApiError> {
    transaction
        .execute(
            "INSERT INTO ad_audit(campaign_id, action, actor_id, occurred_at, detail)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![campaign_id, action, actor_id, occurred_at, detail],
        )
        .map_err(|_| AdApiError::Internal)?;
    Ok(())
}

fn bump_generation(transaction: &Transaction<'_>) -> Result<(), AdApiError> {
    transaction
        .execute(
            "UPDATE ad_metadata SET value = value + 1 WHERE key = 'generation'",
            [],
        )
        .map_err(|_| AdApiError::Internal)?;
    Ok(())
}

fn generation(database: &Connection) -> Result<u64, AdApiError> {
    database
        .query_row(
            "SELECT value FROM ad_metadata WHERE key = 'generation'",
            [],
            |row| row.get(0),
        )
        .map_err(|_| AdApiError::Internal)
}

fn validate_campaign(input: &CreateAdCampaign) -> Result<(), AdApiError> {
    validate_identifier("advertiser ID", &input.advertiser_id, 100)?;
    validate_plain_text(
        "advertiser display name",
        &input.advertiser_display_name,
        2,
        100,
    )?;
    validate_identifier("payer ID", &input.paid_by_id, 100)?;
    validate_plain_text("payer display name", &input.paid_by_display_name, 2, 100)?;
    if matches!(
        input.kind,
        AdKind::CryptoExchange | AdKind::CryptoInvestment | AdKind::CryptoYield | AdKind::Gambling
    ) {
        return Err(AdApiError::ProhibitedAdKind);
    }
    validate_plain_text("title", &input.title, 4, MAX_TITLE_LENGTH)?;
    validate_plain_text("body", &input.body, 8, MAX_TEXT_LENGTH)?;
    validate_destination_url(&input.destination_url)?;
    if let Some(media_url) = &input.media_url {
        validate_media_url(media_url)?;
    }
    let starts_at = parse_timestamp(&input.starts_at)?;
    let ends_at = parse_timestamp(&input.ends_at)?;
    if starts_at >= ends_at {
        return Err(AdApiError::InvalidSchedule);
    }
    if ends_at - starts_at > ChronoDuration::days(MAX_CAMPAIGN_DURATION_DAYS) {
        return Err(AdApiError::CampaignTooLong);
    }
    if input.eligible_categories.is_empty() || input.eligible_categories.len() > MAX_CATEGORIES {
        return Err(AdApiError::InvalidCategories);
    }
    for category in &input.eligible_categories {
        validate_slug(category).map_err(|_| AdApiError::InvalidCategories)?;
    }
    if input.eligible_regions.is_empty() || input.eligible_regions.len() > MAX_REGIONS {
        return Err(AdApiError::InvalidRegions);
    }
    for region in &input.eligible_regions {
        normalise_country(region)?;
    }
    if input.placement_weight == 0 || input.placement_weight > 100 {
        return Err(AdApiError::InvalidPlacementWeight);
    }
    if input.frequency_cap == 0 || input.frequency_cap > 20 {
        return Err(AdApiError::InvalidFrequencyCap);
    }
    match (&input.embedding_model, &input.embedding) {
        (None, None) => {}
        (Some(model), Some(embedding)) => {
            if model != ADVERTISING_EMBEDDING_MODEL
                || embedding.len() != ADVERTISING_EMBEDDING_DIMENSIONS
            {
                return Err(AdApiError::InvalidEmbedding);
            }
            let norm = embedding
                .iter()
                .try_fold(0.0_f64, |sum, value| {
                    value
                        .is_finite()
                        .then_some(sum + f64::from(*value) * f64::from(*value))
                })
                .ok_or(AdApiError::InvalidEmbedding)?;
            let norm = norm.sqrt();
            if !(0.995..=1.005).contains(&norm) {
                return Err(AdApiError::InvalidEmbedding);
            }
        }
        _ => return Err(AdApiError::InvalidEmbedding),
    }
    Ok(())
}

fn validate_plain_text(
    _field: &str,
    value: &str,
    minimum: usize,
    maximum: usize,
) -> Result<(), AdApiError> {
    let length = value.chars().count();
    if length < minimum
        || length > maximum
        || value.trim() != value
        || value.contains('<')
        || value.contains('>')
        || value.chars().any(char::is_control)
    {
        return Err(AdApiError::InvalidText);
    }
    Ok(())
}

fn validate_identifier(_field: &str, value: &str, maximum: usize) -> Result<(), AdApiError> {
    if value.is_empty()
        || value.len() > maximum
        || !value.bytes().all(|value| {
            value.is_ascii_alphanumeric() || matches!(value, b'-' | b'_' | b'.' | b':')
        })
    {
        return Err(AdApiError::InvalidIdentifier);
    }
    Ok(())
}

fn validate_slug(value: &str) -> Result<(), AdApiError> {
    if value.is_empty()
        || value.len() > 50
        || !value
            .bytes()
            .all(|value| value.is_ascii_lowercase() || value.is_ascii_digit() || value == b'-')
    {
        return Err(AdApiError::InvalidCategories);
    }
    Ok(())
}

fn validate_destination_url(value: &str) -> Result<(), AdApiError> {
    validate_https_url(value, false)
}

fn validate_media_url(value: &str) -> Result<(), AdApiError> {
    validate_https_url(value, true)
}

fn validate_https_url(value: &str, tex8_only: bool) -> Result<(), AdApiError> {
    if value.len() > 2_048 {
        return Err(AdApiError::InvalidUrl);
    }
    let url = Url::parse(value).map_err(|_| AdApiError::InvalidUrl)?;
    let host = url.host_str().ok_or(AdApiError::InvalidUrl)?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || (tex8_only && host != "tex8.com" && !host.ends_with(".tex8.com"))
    {
        return Err(AdApiError::InvalidUrl);
    }
    Ok(())
}

fn normalise_country(value: &str) -> Result<String, AdApiError> {
    let value = value.trim().to_ascii_uppercase();
    if value.len() != 2
        || !value.bytes().all(|byte| byte.is_ascii_uppercase())
        || !ISO_3166_ALPHA_2
            .split_ascii_whitespace()
            .any(|country| country == value)
    {
        return Err(AdApiError::InvalidCountry);
    }
    Ok(value)
}

fn validate_uuid(value: &str) -> Result<(), AdApiError> {
    Uuid::parse_str(value)
        .map(|_| ())
        .map_err(|_| AdApiError::NotFound)
}

fn normalise_timestamp(value: &str) -> Result<String, AdApiError> {
    parse_timestamp(value).map(timestamp)
}

fn parse_timestamp(value: &str) -> Result<DateTime<Utc>, AdApiError> {
    DateTime::parse_from_rfc3339(value)
        .map(|value| value.with_timezone(&Utc))
        .map_err(|_| AdApiError::InvalidSchedule)
}

fn timestamp(value: DateTime<Utc>) -> String {
    value.to_rfc3339_opts(SecondsFormat::Secs, true)
}

fn ad_kind_text(value: AdKind) -> &'static str {
    match value {
        AdKind::OrdinaryProduct => "ordinary_product",
        AdKind::OrdinaryService => "ordinary_service",
        AdKind::NewsSponsorship => "news_sponsorship",
        AdKind::CryptoExchange => "crypto_exchange",
        AdKind::CryptoInvestment => "crypto_investment",
        AdKind::CryptoYield => "crypto_yield",
        AdKind::Gambling => "gambling",
    }
}

fn parse_ad_kind(value: &str) -> Result<AdKind, AdApiError> {
    match value {
        "ordinary_product" => Ok(AdKind::OrdinaryProduct),
        "ordinary_service" => Ok(AdKind::OrdinaryService),
        "news_sponsorship" => Ok(AdKind::NewsSponsorship),
        "crypto_exchange" => Ok(AdKind::CryptoExchange),
        "crypto_investment" => Ok(AdKind::CryptoInvestment),
        "crypto_yield" => Ok(AdKind::CryptoYield),
        "gambling" => Ok(AdKind::Gambling),
        _ => Err(AdApiError::Internal),
    }
}

fn parse_placement(value: &str) -> Result<AdPlacement, AdApiError> {
    match value {
        "news" => Ok(AdPlacement::News),
        "community" => Ok(AdPlacement::Community),
        "catalog" => Ok(AdPlacement::Catalog),
        _ => Err(AdApiError::Internal),
    }
}

fn sponsorship_label_text(value: SponsorshipLabel) -> &'static str {
    match value {
        SponsorshipLabel::Advertisement => "advertisement",
        SponsorshipLabel::Sponsored => "sponsored",
    }
}

fn parse_sponsorship_label(value: &str) -> Result<SponsorshipLabel, AdApiError> {
    match value {
        "advertisement" => Ok(SponsorshipLabel::Advertisement),
        "sponsored" => Ok(SponsorshipLabel::Sponsored),
        _ => Err(AdApiError::Internal),
    }
}

fn to_json<T: Serialize + ?Sized>(value: &T) -> Result<String, AdApiError> {
    serde_json::to_string(value).map_err(|_| AdApiError::Internal)
}

fn parse_json<T: serde::de::DeserializeOwned>(value: String) -> Result<T, AdApiError> {
    serde_json::from_str(&value).map_err(|_| AdApiError::Internal)
}

fn to_sql_error(_: AdApiError) -> rusqlite::Error {
    rusqlite::Error::InvalidQuery
}

#[derive(Debug)]
pub(crate) enum AdApiError {
    AdvertisingDisabled,
    Unauthorized,
    NotFound,
    InvalidState,
    CampaignExpired,
    ProhibitedAdKind,
    CampaignTooLong,
    InvalidSchedule,
    InvalidCategories,
    InvalidRegions,
    InvalidPlacementWeight,
    InvalidFrequencyCap,
    InvalidEmbedding,
    InvalidText,
    InvalidIdentifier,
    InvalidUrl,
    InvalidCountry,
    Internal,
}

impl AdApiError {
    fn code(&self) -> &'static str {
        match self {
            Self::AdvertisingDisabled => "advertising_disabled",
            Self::Unauthorized => "unauthorized",
            Self::NotFound => "campaign_not_found",
            Self::InvalidState => "invalid_campaign_state",
            Self::CampaignExpired => "campaign_expired",
            Self::ProhibitedAdKind => "prohibited_ad_kind",
            Self::CampaignTooLong => "campaign_exceeds_30_days",
            Self::InvalidSchedule => "invalid_campaign_schedule",
            Self::InvalidCategories => "invalid_eligible_categories",
            Self::InvalidRegions => "invalid_eligible_regions",
            Self::InvalidPlacementWeight => "invalid_placement_weight",
            Self::InvalidFrequencyCap => "invalid_frequency_cap",
            Self::InvalidEmbedding => "invalid_embedding",
            Self::InvalidText => "invalid_plain_text",
            Self::InvalidIdentifier => "invalid_identifier",
            Self::InvalidUrl => "invalid_https_url",
            Self::InvalidCountry => "invalid_country",
            Self::Internal => "internal_error",
        }
    }
}

impl IntoResponse for AdApiError {
    fn into_response(self) -> axum::response::Response {
        let status = match self {
            Self::AdvertisingDisabled => StatusCode::SERVICE_UNAVAILABLE,
            Self::Unauthorized => StatusCode::UNAUTHORIZED,
            Self::NotFound => StatusCode::NOT_FOUND,
            Self::InvalidState => StatusCode::CONFLICT,
            Self::Internal => StatusCode::INTERNAL_SERVER_ERROR,
            _ => StatusCode::UNPROCESSABLE_ENTITY,
        };
        (status, Json(serde_json::json!({ "error": self.code() }))).into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{router, NewsState};
    use axum::{
        body::{to_bytes, Body},
        http::{Method, Request},
        Router,
    };
    use ed25519_dalek::{Signature, Verifier, VerifyingKey};
    use serde_json::{json, Value};
    use tempfile::TempDir;
    use tower::ServiceExt;

    const ADMIN_TOKEN: &str = "local-test-admin-token-32-bytes-minimum";
    const SIGNING_KEY: [u8; 32] = [17; 32];

    fn advertising_embedding() -> Vec<f32> {
        let mut embedding = vec![0.0; ADVERTISING_EMBEDDING_DIMENSIONS];
        embedding[0] = 1.0;
        embedding
    }

    struct TestBackend {
        app: Router,
        database_path: PathBuf,
        _directory: TempDir,
    }

    impl TestBackend {
        fn new() -> Self {
            let directory = tempfile::tempdir().expect("temporary advertising directory");
            let database_path = directory.path().join("advertising.sqlite3");
            let state =
                NewsState::new_with_ads(test_config(database_path.clone())).expect("test state");
            Self {
                app: router(state),
                database_path,
                _directory: directory,
            }
        }

        fn reopen(&self) -> Router {
            router(
                NewsState::new_with_ads(test_config(self.database_path.clone()))
                    .expect("reopened test state"),
            )
        }
    }

    fn test_config(database_path: PathBuf) -> AdConfig {
        AdConfig {
            database_path,
            admin_token: ADMIN_TOKEN.to_owned(),
            signing_key: SIGNING_KEY,
            signing_key_id: "local-test-key-1".to_owned(),
            policy_version: "ads-test-v1".to_owned(),
        }
    }

    fn valid_campaign() -> CreateAdCampaign {
        CreateAdCampaign {
            advertiser_id: "advertiser-ledger".to_owned(),
            advertiser_display_name: "Example Hardware Company".to_owned(),
            paid_by_id: "payer-ledger".to_owned(),
            paid_by_display_name: "Example Hardware Company".to_owned(),
            kind: AdKind::OrdinaryProduct,
            placement: AdPlacement::News,
            title: "Protect your hardware wallet".to_owned(),
            body: "Learn about a reviewed hardware wallet product.".to_owned(),
            destination_url: "https://example.com/hardware".to_owned(),
            media_url: Some("https://cdn.tex8.com/ads/hardware.webp".to_owned()),
            starts_at: timestamp(Utc::now() - ChronoDuration::minutes(1)),
            ends_at: timestamp(Utc::now() + ChronoDuration::days(7)),
            eligible_categories: vec!["hardware".to_owned(), "privacy".to_owned()],
            eligible_regions: vec!["US".to_owned(), "DE".to_owned()],
            placement_weight: 50,
            frequency_cap: 3,
            sponsorship_label: SponsorshipLabel::Advertisement,
            embedding_model: Some(ADVERTISING_EMBEDDING_MODEL.to_owned()),
            embedding: Some(advertising_embedding()),
        }
    }

    async fn request(
        app: &Router,
        method: Method,
        uri: &str,
        body: Option<Value>,
        authorised: bool,
    ) -> (StatusCode, Value) {
        let mut builder = Request::builder().method(method).uri(uri);
        if body.is_some() {
            builder = builder.header(axum::http::header::CONTENT_TYPE, "application/json");
        }
        if authorised {
            builder = builder.header(
                axum::http::header::AUTHORIZATION,
                format!("Bearer {ADMIN_TOKEN}"),
            );
        }
        let response = app
            .clone()
            .oneshot(
                builder
                    .body(
                        body.map(|value| {
                            Body::from(serde_json::to_vec(&value).expect("JSON body"))
                        })
                        .unwrap_or_else(Body::empty),
                    )
                    .expect("HTTP request"),
            )
            .await
            .expect("HTTP response");
        let status = response.status();
        let bytes = to_bytes(response.into_body(), 256 * 1024)
            .await
            .expect("response body");
        let value = if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes)
                .unwrap_or_else(|_| json!({ "raw": String::from_utf8_lossy(&bytes).into_owned() }))
        };
        (status, value)
    }

    async fn create_campaign(app: &Router, campaign: &CreateAdCampaign) -> AdCampaign {
        let (status, body) = request(
            app,
            Method::POST,
            "/v1/admin/ads/campaigns",
            Some(serde_json::to_value(campaign).expect("campaign JSON")),
            true,
        )
        .await;
        assert_eq!(status, StatusCode::CREATED, "{body}");
        serde_json::from_value(body).expect("created campaign")
    }

    async fn approve_campaign(app: &Router, campaign_id: &str) -> AdCampaign {
        let (status, body) = request(
            app,
            Method::POST,
            &format!("/v1/admin/ads/campaigns/{campaign_id}/approve"),
            Some(json!({
                "reviewerId": "reviewer-alice",
                "jurisdictionReviewId": "legal-review-2026-07"
            })),
            true,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        serde_json::from_value(body).expect("approved campaign")
    }

    async fn catalog(app: &Router, country: &str, placement: &str) -> SignedAdCatalog {
        let (status, body) = request(
            app,
            Method::GET,
            &format!("/v1/ads/catalog?country={country}&placement={placement}"),
            None,
            false,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        serde_json::from_value(body).expect("signed advertising catalog")
    }

    fn verify_catalog(response: &SignedAdCatalog) {
        let signed_bytes = BASE64
            .decode(&response.signed_catalog)
            .expect("signed catalog bytes");
        let signed_catalog: AdCatalog =
            serde_json::from_slice(&signed_bytes).expect("signed catalog JSON");
        assert_eq!(signed_catalog, response.catalog);
        let public_key: [u8; 32] = BASE64
            .decode(&response.signing_public_key)
            .expect("public key")
            .try_into()
            .expect("32-byte public key");
        let signature: [u8; 64] = BASE64
            .decode(&response.signature)
            .expect("signature")
            .try_into()
            .expect("64-byte signature");
        VerifyingKey::from_bytes(&public_key)
            .expect("verifying key")
            .verify(&signed_bytes, &Signature::from_bytes(&signature))
            .expect("valid catalog signature");
    }

    #[tokio::test]
    async fn campaign_lifecycle_is_moderated_filtered_signed_and_trackless() {
        let backend = TestBackend::new();

        let initial = catalog(&backend.app, "US", "news").await;
        assert_eq!(initial.catalog.generation, 0);
        assert!(initial.catalog.campaigns.is_empty());
        verify_catalog(&initial);
        let (path_status, path_body) = request(
            &backend.app,
            Method::GET,
            "/v1/ads/catalog/US/news",
            None,
            false,
        )
        .await;
        assert_eq!(path_status, StatusCode::OK, "{path_body}");
        let path_catalog: SignedAdCatalog =
            serde_json::from_value(path_body).expect("path catalog");
        assert_eq!(
            path_catalog.catalog.catalog_scope_id,
            initial.catalog.catalog_scope_id
        );
        verify_catalog(&path_catalog);
        let cached_initial = catalog(&backend.app, "US", "news").await;
        assert_eq!(cached_initial.signed_catalog, initial.signed_catalog);
        assert_eq!(cached_initial.signature, initial.signature);

        let (status, body) = request(
            &backend.app,
            Method::POST,
            "/v1/admin/ads/campaigns",
            Some(serde_json::to_value(valid_campaign()).expect("campaign JSON")),
            false,
        )
        .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{body}");

        let draft = create_campaign(&backend.app, &valid_campaign()).await;
        assert_eq!(draft.status, CampaignStatus::Draft);
        assert!(catalog(&backend.app, "US", "news")
            .await
            .catalog
            .campaigns
            .is_empty());

        let approved = approve_campaign(&backend.app, &draft.campaign_id).await;
        assert_eq!(approved.status, CampaignStatus::Approved);

        let us_news = catalog(&backend.app, "us", "news").await;
        assert_eq!(us_news.catalog.catalog_scope_id, "ads:US:news");
        assert_eq!(us_news.catalog.generation, 1);
        assert_eq!(us_news.catalog.campaigns.len(), 1);
        assert_eq!(
            us_news.catalog.jurisdiction_review_ids,
            ["legal-review-2026-07"]
        );
        verify_catalog(&us_news);

        assert!(catalog(&backend.app, "PA", "news")
            .await
            .catalog
            .campaigns
            .is_empty());
        assert!(catalog(&backend.app, "US", "community")
            .await
            .catalog
            .campaigns
            .is_empty());

        let (status, _) = request(
            &backend.app,
            Method::GET,
            "/v1/ads/catalog?country=US&placement=news&userId=private",
            None,
            false,
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);

        let (status, body) = request(
            &backend.app,
            Method::GET,
            "/v1/ads/catalog?country=ZZ&placement=news",
            None,
            false,
        )
        .await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(body["error"], "invalid_country");

        let (status, _) = request(
            &backend.app,
            Method::POST,
            "/v1/ads/impressions",
            Some(json!({ "campaignId": draft.campaign_id })),
            false,
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);

        let (status, body) = request(
            &backend.app,
            Method::POST,
            &format!("/v1/admin/ads/campaigns/{}/withdraw", approved.campaign_id),
            Some(json!({
                "reviewerId": "reviewer-alice",
                "reason": "Campaign ended early by advertiser request"
            })),
            true,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let withdrawn: AdCampaign = serde_json::from_value(body).expect("withdrawn campaign");
        assert_eq!(withdrawn.status, CampaignStatus::Withdrawn);
        let empty = catalog(&backend.app, "US", "news").await;
        assert_eq!(empty.catalog.generation, 2);
        assert!(empty.catalog.campaigns.is_empty());
    }

    #[tokio::test]
    async fn unsafe_or_prohibited_campaigns_fail_closed() {
        let backend = TestBackend::new();

        let mut prohibited = valid_campaign();
        prohibited.kind = AdKind::CryptoExchange;
        let (status, body) = request(
            &backend.app,
            Method::POST,
            "/v1/admin/ads/campaigns",
            Some(serde_json::to_value(prohibited).expect("campaign JSON")),
            true,
        )
        .await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(body["error"], "prohibited_ad_kind");

        let mut too_long = valid_campaign();
        too_long.ends_at = timestamp(Utc::now() + ChronoDuration::days(31));
        let (status, body) = request(
            &backend.app,
            Method::POST,
            "/v1/admin/ads/campaigns",
            Some(serde_json::to_value(too_long).expect("campaign JSON")),
            true,
        )
        .await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(body["error"], "campaign_exceeds_30_days");

        let mut remote_media = valid_campaign();
        remote_media.media_url = Some("https://tracker.example/ad.js".to_owned());
        let (status, body) = request(
            &backend.app,
            Method::POST,
            "/v1/admin/ads/campaigns",
            Some(serde_json::to_value(remote_media).expect("campaign JSON")),
            true,
        )
        .await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(body["error"], "invalid_https_url");

        let mut html = valid_campaign();
        html.body = "Safe text <script>alert('tracking')</script>".to_owned();
        let (status, body) = request(
            &backend.app,
            Method::POST,
            "/v1/admin/ads/campaigns",
            Some(serde_json::to_value(html).expect("campaign JSON")),
            true,
        )
        .await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(body["error"], "invalid_plain_text");

        let mut mismatched_embedding = valid_campaign();
        mismatched_embedding.embedding_model = None;
        let (status, body) = request(
            &backend.app,
            Method::POST,
            "/v1/admin/ads/campaigns",
            Some(serde_json::to_value(mismatched_embedding).expect("campaign JSON")),
            true,
        )
        .await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(body["error"], "invalid_embedding");
    }

    #[tokio::test]
    async fn future_campaign_is_hidden_and_database_survives_reopen() {
        let backend = TestBackend::new();
        let active = create_campaign(&backend.app, &valid_campaign()).await;
        approve_campaign(&backend.app, &active.campaign_id).await;

        let future_starts_at = Utc::now() + ChronoDuration::hours(2);
        let mut future = valid_campaign();
        future.starts_at = timestamp(future_starts_at);
        future.ends_at = timestamp(Utc::now() + ChronoDuration::days(2));
        future.title = "A future reviewed campaign".to_owned();
        let future = create_campaign(&backend.app, &future).await;
        approve_campaign(&backend.app, &future.campaign_id).await;

        let current = catalog(&backend.app, "US", "news").await;
        assert_eq!(current.catalog.generation, 2);
        assert_eq!(current.catalog.campaigns.len(), 1);
        assert_eq!(current.catalog.campaigns[0].campaign_id, active.campaign_id);
        assert!(
            parse_timestamp(&current.catalog.expires_at).expect("catalog expiry")
                <= future_starts_at
        );

        let reopened = backend.reopen();
        let persisted = catalog(&reopened, "US", "news").await;
        assert_eq!(persisted.catalog.generation, 2);
        assert_eq!(persisted.catalog.campaigns.len(), 1);
        assert_eq!(
            persisted.catalog.campaigns[0].campaign_id,
            active.campaign_id
        );
        verify_catalog(&persisted);

        let (status, body) = request(
            &reopened,
            Method::GET,
            "/v1/admin/ads/campaigns",
            None,
            true,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["campaigns"].as_array().map(Vec::len), Some(2));
    }

    #[tokio::test]
    async fn disabled_backend_is_visible_and_fails_closed() {
        let state = NewsState::new_with_ad_service(AdService::disabled()).expect("disabled state");
        let app = router(state);
        let (status, health) = request(&app, Method::GET, "/healthz", None, false).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(health["advertisingConfigured"], false);

        let (status, body) = request(
            &app,
            Method::GET,
            "/v1/ads/catalog?country=US&placement=news",
            None,
            false,
        )
        .await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(body["error"], "advertising_disabled");
    }
}
