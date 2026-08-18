use serde::{Deserialize, Serialize};

pub const PRESENCE_TTL_MS: u64 = 30 * 60 * 1000;
const GEOHASH_ALPHABET: &str = "0123456789bcdefghjkmnpqrstuvwxyz";

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct IdentityRecord {
    pub id: String,
    pub token_hash: String,
    pub display_name: String,
    pub bio: String,
    pub area_id: Option<String>,
    pub visible: bool,
    pub radius_km: u16,
    pub created_at_ms: u64,
    pub last_seen_at_ms: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ContactRecord {
    pub requester_id: String,
    pub recipient_id: String,
    pub requested_at_ms: u64,
    pub accepted_at_ms: Option<u64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct MessageRecord {
    pub id: String,
    pub sender_id: String,
    pub recipient_id: String,
    pub body: String,
    pub sent_at_ms: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BlockRecord {
    pub blocker_id: String,
    pub blocked_id: String,
    pub created_at_ms: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ReportRecord {
    pub id: String,
    pub reporter_id: String,
    pub reported_id: String,
    pub reason: String,
    pub created_at_ms: u64,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct StoredCommunity {
    pub identities: Vec<IdentityRecord>,
    pub contacts: Vec<ContactRecord>,
    pub messages: Vec<MessageRecord>,
    pub blocks: Vec<BlockRecord>,
    pub reports: Vec<ReportRecord>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateIdentityRequest {
    pub display_name: String,
}

#[derive(Debug, Serialize)]
pub struct CreateIdentityResponse {
    pub identity_id: String,
    pub access_token: String,
    pub profile: ProfileResponse,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UpdateProfileRequest {
    pub display_name: String,
    #[serde(default)]
    pub bio: String,
    pub area_id: Option<String>,
    pub visible: bool,
    pub radius_km: u16,
}

#[derive(Clone, Debug, Serialize)]
pub struct ProfileResponse {
    pub identity_id: String,
    pub display_name: String,
    pub bio: String,
    pub visible: bool,
    pub radius_km: u16,
}

impl From<&IdentityRecord> for ProfileResponse {
    fn from(value: &IdentityRecord) -> Self {
        Self {
            identity_id: value.id.clone(),
            display_name: value.display_name.clone(),
            bio: value.bio.clone(),
            visible: value.visible,
            radius_km: value.radius_km,
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct NearbyQuery {
    pub radius_km: Option<u16>,
}

#[derive(Clone, Debug, Serialize)]
pub struct NearbyProfileResponse {
    #[serde(flatten)]
    pub profile: ProfileResponse,
    pub approximate_distance_km: u16,
    pub relationship: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct ContactResponse {
    #[serde(flatten)]
    pub profile: ProfileResponse,
    pub status: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SendMessageRequest {
    pub body: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct MessageResponse {
    pub id: String,
    pub sender_id: String,
    pub recipient_id: String,
    pub body: String,
    pub sent_at_ms: u64,
}

impl From<&MessageRecord> for MessageResponse {
    fn from(value: &MessageRecord) -> Self {
        Self {
            id: value.id.clone(),
            sender_id: value.sender_id.clone(),
            recipient_id: value.recipient_id.clone(),
            body: value.body.clone(),
            sent_at_ms: value.sent_at_ms,
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct MessageQuery {
    pub after_ms: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReportRequest {
    pub reason: String,
}

pub fn validate_display_name(value: &str) -> Result<String, &'static str> {
    let trimmed = value.trim();
    let length = trimmed.chars().count();
    if !(2..=32).contains(&length) || trimmed.chars().any(char::is_control) {
        return Err("display_name must contain 2 to 32 printable characters");
    }
    Ok(trimmed.to_owned())
}

pub fn validate_bio(value: &str) -> Result<String, &'static str> {
    let trimmed = value.trim();
    if trimmed.chars().count() > 160 || trimmed.chars().any(char::is_control) {
        return Err("bio must contain at most 160 printable characters");
    }
    Ok(trimmed.to_owned())
}

pub fn validate_area_id(value: &str) -> Result<String, &'static str> {
    let normalized = value.trim().to_ascii_lowercase();
    if normalized.len() != 5
        || !normalized
            .chars()
            .all(|character| GEOHASH_ALPHABET.contains(character))
    {
        return Err("area_id must be a 5-character geohash");
    }
    Ok(normalized)
}

pub fn validate_radius(value: u16) -> Result<u16, &'static str> {
    if matches!(value, 5 | 10 | 25) {
        Ok(value)
    } else {
        Err("radius_km must be 5, 10, or 25")
    }
}

pub fn validate_message(value: &str) -> Result<String, &'static str> {
    let trimmed = value.trim();
    if trimmed.is_empty()
        || trimmed.chars().count() > 1000
        || trimmed.chars().any(|character| character == '\0')
    {
        return Err("message must contain 1 to 1000 characters");
    }
    Ok(trimmed.to_owned())
}

pub fn validate_report_reason(value: &str) -> Result<String, &'static str> {
    let trimmed = value.trim();
    if trimmed.is_empty()
        || trimmed.chars().count() > 500
        || trimmed.chars().any(|character| character == '\0')
    {
        return Err("reason must contain 1 to 500 characters");
    }
    Ok(trimmed.to_owned())
}

pub fn geohash_center(value: &str) -> Option<(f64, f64)> {
    if validate_area_id(value).is_err() {
        return None;
    }
    let mut latitude = (-90.0, 90.0);
    let mut longitude = (-180.0, 180.0);
    let mut use_longitude = true;
    for character in value.chars() {
        let index = GEOHASH_ALPHABET.find(character)? as u8;
        for shift in (0..5).rev() {
            let bit = (index >> shift) & 1;
            let range = if use_longitude {
                &mut longitude
            } else {
                &mut latitude
            };
            let midpoint = (range.0 + range.1) / 2.0;
            if bit == 1 {
                range.0 = midpoint;
            } else {
                range.1 = midpoint;
            }
            use_longitude = !use_longitude;
        }
    }
    Some((
        (latitude.0 + latitude.1) / 2.0,
        (longitude.0 + longitude.1) / 2.0,
    ))
}

pub fn approximate_distance_km(first: &str, second: &str) -> Option<u16> {
    let (lat1, lon1) = geohash_center(first)?;
    let (lat2, lon2) = geohash_center(second)?;
    let lat_delta = (lat2 - lat1).to_radians();
    let lon_delta = (lon2 - lon1).to_radians();
    let lat1 = lat1.to_radians();
    let lat2 = lat2.to_radians();
    let a =
        (lat_delta / 2.0).sin().powi(2) + lat1.cos() * lat2.cos() * (lon_delta / 2.0).sin().powi(2);
    let distance = 6_371.0 * 2.0 * a.sqrt().atan2((1.0 - a).sqrt());
    Some(((distance / 5.0).round() * 5.0).max(0.0) as u16)
}
