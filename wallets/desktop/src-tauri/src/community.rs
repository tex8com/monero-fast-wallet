use crate::secure_store;
use reqwest::{Client, Method, Response};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use zeroize::{Zeroize, ZeroizeOnDrop};

const COMMUNITY_API_BASE_URL: &str =
    "http://fastrelayrpcf3hbc4qvykjgbpwpmcuq5dpcsdxoe7gwfh2zxdib3eid.onion/community";
const GEOHASH_ALPHABET: &str = "0123456789bcdefghjkmnpqrstuvwxyz";

pub struct CommunityState {
    client: Client,
}

impl CommunityState {
    pub fn new() -> Result<Self, String> {
        let client = Client::builder()
            .timeout(Duration::from_secs(12))
            .user_agent("Monero-Fast-Wallet-Desktop/0.1")
            .proxy(crate::tor_transport::proxy()?)
            .build()
            .map_err(|_| "The Community client could not be initialized.".to_owned())?;
        Ok(Self { client })
    }

    pub async fn load_profile(&self) -> Result<CommunityProfile, String> {
        let account = self.account_or_create().await?;
        let response = self
            .authorized(Method::GET, "/v1/profile", &account)
            .send()
            .await
            .map_err(network_error)?;
        parse_response::<ApiProfile>(response)
            .await
            .map(CommunityProfile::from)
    }

    pub async fn update_profile(
        &self,
        input: CommunityProfileUpdateInput,
    ) -> Result<CommunityProfile, String> {
        let mut account = self.account_or_create().await?;
        let request = ApiProfileUpdate {
            display_name: validate_display_name(&input.display_name)?,
            bio: validate_bio(&input.bio)?,
            area_id: validate_area_id(input.area_id.as_deref(), input.visible)?,
            visible: input.visible,
            radius_km: validate_radius(input.radius_km)?,
        };
        let response = self
            .authorized(Method::PUT, "/v1/profile", &account)
            .json(&request)
            .send()
            .await
            .map_err(network_error)?;
        let profile: CommunityProfile = parse_response::<ApiProfile>(response).await?.into();
        account.display_name = profile.display_name.clone();
        save_account(&account)?;
        Ok(profile)
    }

    pub async fn list_nearby(&self, radius_km: u16) -> Result<Vec<CommunityNearby>, String> {
        let account = self.account_or_create().await?;
        let radius_km = validate_radius(radius_km)?;
        let response = self
            .authorized(
                Method::GET,
                &format!("/v1/nearby?radius_km={radius_km}"),
                &account,
            )
            .send()
            .await
            .map_err(network_error)?;
        parse_response::<Vec<ApiNearby>>(response)
            .await
            .map(|items| items.into_iter().map(CommunityNearby::from).collect())
    }

    pub async fn list_contacts(&self) -> Result<Vec<CommunityContact>, String> {
        let account = self.account_or_create().await?;
        let response = self
            .authorized(Method::GET, "/v1/contacts", &account)
            .send()
            .await
            .map_err(network_error)?;
        parse_response::<Vec<ApiContact>>(response)
            .await
            .map(|items| items.into_iter().map(CommunityContact::from).collect())
    }

    pub async fn request_contact(&self, peer_id: &str) -> Result<(), String> {
        self.no_content(
            Method::POST,
            &format!("/v1/contacts/{}", peer_segment(peer_id)?),
        )
        .await
    }

    pub async fn accept_contact(&self, peer_id: &str) -> Result<(), String> {
        self.no_content(
            Method::POST,
            &format!("/v1/contacts/{}/accept", peer_segment(peer_id)?),
        )
        .await
    }

    pub async fn list_messages(
        &self,
        peer_id: &str,
        after_ms: u64,
    ) -> Result<Vec<CommunityMessage>, String> {
        let account = self.account_or_create().await?;
        let response = self
            .authorized(
                Method::GET,
                &format!(
                    "/v1/conversations/{}/messages?after_ms={after_ms}",
                    peer_segment(peer_id)?
                ),
                &account,
            )
            .send()
            .await
            .map_err(network_error)?;
        parse_response::<Vec<ApiMessage>>(response)
            .await
            .map(|items| items.into_iter().map(CommunityMessage::from).collect())
    }

    pub async fn send_message(
        &self,
        peer_id: &str,
        body: &str,
    ) -> Result<CommunityMessage, String> {
        let account = self.account_or_create().await?;
        let body = validate_message_body(body)?;
        let response = self
            .authorized(
                Method::POST,
                &format!("/v1/conversations/{}/messages", peer_segment(peer_id)?),
                &account,
            )
            .json(&ApiMessageBody { body })
            .send()
            .await
            .map_err(network_error)?;
        parse_response::<ApiMessage>(response)
            .await
            .map(CommunityMessage::from)
    }

    pub async fn block_profile(&self, peer_id: &str) -> Result<(), String> {
        self.no_content(
            Method::POST,
            &format!("/v1/blocks/{}", peer_segment(peer_id)?),
        )
        .await
    }

    pub async fn report_profile(&self, peer_id: &str, reason: &str) -> Result<(), String> {
        let account = self.account_or_create().await?;
        let reason = validate_report_reason(reason)?;
        let response = self
            .authorized(
                Method::POST,
                &format!("/v1/reports/{}", peer_segment(peer_id)?),
                &account,
            )
            .json(&ApiReport { reason })
            .send()
            .await
            .map_err(network_error)?;
        expect_no_content(response).await
    }

    pub async fn delete_identity(&self) -> Result<(), String> {
        let account = self
            .load_account()?
            .ok_or_else(|| "No Community identity exists on this device.".to_owned())?;
        let response = self
            .authorized(Method::DELETE, "/v1/profile", &account)
            .send()
            .await
            .map_err(network_error)?;
        expect_no_content(response).await?;
        secure_store::delete_community_account()
    }

    async fn no_content(&self, method: Method, path: &str) -> Result<(), String> {
        let account = self.account_or_create().await?;
        let response = self
            .authorized(method, path, &account)
            .send()
            .await
            .map_err(network_error)?;
        expect_no_content(response).await
    }

    fn authorized(
        &self,
        method: Method,
        path: &str,
        account: &CommunityAccount,
    ) -> reqwest::RequestBuilder {
        self.client
            .request(method, format!("{COMMUNITY_API_BASE_URL}{path}"))
            .header(reqwest::header::ACCEPT, "application/json")
            .bearer_auth(&account.access_token)
    }

    fn load_account(&self) -> Result<Option<CommunityAccount>, String> {
        let Some(mut raw) = secure_store::load_community_account()? else {
            return Ok(None);
        };
        let parsed = serde_json::from_str::<CommunityAccount>(&raw)
            .map_err(|_| "The Community identity in secure storage is invalid.".to_owned());
        raw.zeroize();
        parsed.map(Some)
    }

    async fn account_or_create(&self) -> Result<CommunityAccount, String> {
        if let Some(account) = self.load_account()? {
            return Ok(account);
        }
        let display_name = generated_display_name();
        let response = self
            .client
            .post(format!("{COMMUNITY_API_BASE_URL}/v1/identities"))
            .header(reqwest::header::ACCEPT, "application/json")
            .json(&ApiCreateIdentity {
                display_name: &display_name,
            })
            .send()
            .await
            .map_err(network_error)?;
        let created: ApiCreateIdentityResponse = parse_response(response).await?;
        let account = CommunityAccount {
            identity_id: created.identity_id,
            access_token: created.access_token,
            display_name,
        };
        save_account(&account)?;
        Ok(account)
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommunityProfileUpdateInput {
    pub display_name: String,
    #[serde(default)]
    pub bio: String,
    pub area_id: Option<String>,
    pub visible: bool,
    pub radius_km: u16,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommunityRadiusInput {
    pub radius_km: u16,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommunityPeerInput {
    pub peer_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommunityMessagesInput {
    pub peer_id: String,
    #[serde(default)]
    pub after_ms: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommunitySendMessageInput {
    pub peer_id: String,
    pub body: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommunityReportInput {
    pub peer_id: String,
    pub reason: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommunityProfile {
    pub identity_id: String,
    pub display_name: String,
    pub bio: String,
    pub visible: bool,
    pub radius_km: u16,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommunityNearby {
    #[serde(flatten)]
    pub profile: CommunityProfile,
    pub approximate_distance_km: u16,
    pub relationship: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommunityContact {
    #[serde(flatten)]
    pub profile: CommunityProfile,
    pub status: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommunityMessage {
    pub id: String,
    pub sender_id: String,
    pub recipient_id: String,
    pub body: String,
    pub sent_at_ms: u64,
}

#[derive(Debug, Deserialize, Serialize, Zeroize, ZeroizeOnDrop)]
struct CommunityAccount {
    identity_id: String,
    access_token: String,
    display_name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
struct ApiCreateIdentity<'a> {
    display_name: &'a str,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
struct ApiCreateIdentityResponse {
    identity_id: String,
    access_token: String,
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
struct ApiProfileUpdate {
    display_name: String,
    bio: String,
    area_id: Option<String>,
    visible: bool,
    radius_km: u16,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
struct ApiProfile {
    identity_id: String,
    display_name: String,
    bio: String,
    visible: bool,
    radius_km: u16,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
struct ApiNearby {
    #[serde(flatten)]
    profile: ApiProfile,
    approximate_distance_km: u16,
    relationship: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
struct ApiContact {
    #[serde(flatten)]
    profile: ApiProfile,
    status: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
struct ApiMessage {
    id: String,
    sender_id: String,
    recipient_id: String,
    body: String,
    sent_at_ms: u64,
}

#[derive(Serialize)]
struct ApiMessageBody {
    body: String,
}

#[derive(Serialize)]
struct ApiReport {
    reason: String,
}

#[derive(Deserialize)]
struct ApiError {
    message: Option<String>,
}

impl From<ApiProfile> for CommunityProfile {
    fn from(value: ApiProfile) -> Self {
        Self {
            identity_id: value.identity_id,
            display_name: value.display_name,
            bio: value.bio,
            visible: value.visible,
            radius_km: value.radius_km,
        }
    }
}

impl From<ApiNearby> for CommunityNearby {
    fn from(value: ApiNearby) -> Self {
        Self {
            profile: value.profile.into(),
            approximate_distance_km: value.approximate_distance_km,
            relationship: value.relationship,
        }
    }
}

impl From<ApiContact> for CommunityContact {
    fn from(value: ApiContact) -> Self {
        Self {
            profile: value.profile.into(),
            status: value.status,
        }
    }
}

impl From<ApiMessage> for CommunityMessage {
    fn from(value: ApiMessage) -> Self {
        Self {
            id: value.id,
            sender_id: value.sender_id,
            recipient_id: value.recipient_id,
            body: value.body,
            sent_at_ms: value.sent_at_ms,
        }
    }
}

async fn parse_response<T: DeserializeOwned>(response: Response) -> Result<T, String> {
    checked(response)
        .await?
        .json::<T>()
        .await
        .map_err(|_| "The Community server returned an invalid response.".to_owned())
}

async fn expect_no_content(response: Response) -> Result<(), String> {
    let response = checked(response).await?;
    if response.status().is_success() {
        Ok(())
    } else {
        Err("The Community server did not confirm the request.".to_owned())
    }
}

async fn checked(response: Response) -> Result<Response, String> {
    if response.status().is_success() {
        return Ok(response);
    }
    let status = response.status();
    let message = response
        .json::<ApiError>()
        .await
        .ok()
        .and_then(|error| error.message)
        .unwrap_or_else(|| format!("Community server returned {status}"));
    Err(message)
}

fn network_error(_: reqwest::Error) -> String {
    "The Community server is unavailable. Check your connection and try again.".to_owned()
}

fn save_account(account: &CommunityAccount) -> Result<(), String> {
    let serialized = serde_json::to_string(account)
        .map_err(|_| "The Community identity could not be encoded.".to_owned())?;
    secure_store::store_community_account(serialized)
}

fn generated_display_name() -> String {
    let entropy = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_nanos())
        .unwrap_or_default();
    format!("Monero {}", 1000 + entropy % 9000)
}

fn validate_display_name(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > 80 {
        return Err("The public alias must contain between 1 and 80 characters.".to_owned());
    }
    Ok(value.to_owned())
}

fn validate_bio(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.chars().count() > 280 {
        return Err("The public bio may contain at most 280 characters.".to_owned());
    }
    Ok(value.to_owned())
}

fn validate_radius(value: u16) -> Result<u16, String> {
    match value {
        5 | 10 | 25 => Ok(value),
        _ => Err("Community search radius must be 5, 10, or 25 km.".to_owned()),
    }
}

fn validate_area_id(value: Option<&str>, visible: bool) -> Result<Option<String>, String> {
    let value = value.map(str::trim).filter(|value| !value.is_empty());
    if !visible {
        return Ok(None);
    }
    let value = value
        .ok_or_else(|| "Approximate location is required before becoming visible.".to_owned())?;
    if value.len() != 5
        || !value
            .bytes()
            .all(|byte| GEOHASH_ALPHABET.as_bytes().contains(&byte))
    {
        return Err("The approximate Community area is invalid.".to_owned());
    }
    Ok(Some(value.to_owned()))
}

fn peer_segment(value: &str) -> Result<&str, String> {
    let valid = !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'));
    if !valid {
        return Err("The Community profile identifier is invalid.".to_owned());
    }
    Ok(value)
}

fn validate_message_body(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > 1200 {
        return Err("A Community message must contain between 1 and 1200 characters.".to_owned());
    }
    Ok(value.to_owned())
}

fn validate_report_reason(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > 500 {
        return Err("A report reason must contain between 1 and 500 characters.".to_owned());
    }
    Ok(value.to_owned())
}

#[cfg(test)]
mod tests {
    use super::{peer_segment, validate_area_id, validate_radius};

    #[test]
    fn visible_profile_requires_a_valid_coarse_area() {
        assert_eq!(
            validate_area_id(Some("d60qv"), true).unwrap(),
            Some("d60qv".to_owned())
        );
        assert!(validate_area_id(None, true).is_err());
        assert!(validate_area_id(Some("exact-location"), true).is_err());
    }

    #[test]
    fn disabled_profile_drops_any_area_before_the_request() {
        assert_eq!(validate_area_id(Some("d60qv"), false).unwrap(), None);
    }

    #[test]
    fn peer_and_radius_inputs_are_constrained() {
        assert_eq!(peer_segment("aBc_123-xyz").unwrap(), "aBc_123-xyz");
        assert!(peer_segment("../peer").is_err());
        assert_eq!(validate_radius(10).unwrap(), 10);
        assert!(validate_radius(20).is_err());
    }
}
