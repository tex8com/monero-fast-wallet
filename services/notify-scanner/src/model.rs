use serde::{Deserialize, Serialize};
use std::{fmt, str::FromStr};
use thiserror::Error;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Network {
    Mainnet,
    Testnet,
    Stagenet,
}

impl fmt::Display for Network {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let value = match self {
            Self::Mainnet => "mainnet",
            Self::Testnet => "testnet",
            Self::Stagenet => "stagenet",
        };
        f.write_str(value)
    }
}

impl FromStr for Network {
    type Err = WatchValidationError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "mainnet" => Ok(Self::Mainnet),
            "testnet" => Ok(Self::Testnet),
            "stagenet" => Ok(Self::Stagenet),
            _ => Err(WatchValidationError::InvalidNetwork),
        }
    }
}

#[derive(Clone, Deserialize, Serialize)]
pub struct RegisterWatchRequest {
    pub identity_id: String,
    pub address: String,
    pub private_view_key: String,
    pub network: Network,
    pub restore_height: u64,
    #[serde(default)]
    pub push_token: Option<String>,
    #[serde(default)]
    pub device_id: Option<String>,
}

impl fmt::Debug for RegisterWatchRequest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("RegisterWatchRequest")
            .field("identity_id", &self.identity_id)
            .field("address", &self.address)
            .field("private_view_key", &"<redacted>")
            .field("network", &self.network)
            .field("restore_height", &self.restore_height)
            .field(
                "push_token",
                &self.push_token.as_ref().map(|_| "<redacted>"),
            )
            .field("device_id", &self.device_id)
            .finish()
    }
}

#[derive(Clone, Deserialize, Serialize)]
pub struct WatchRegistration {
    pub identity_id: String,
    pub address: String,
    pub private_view_key: String,
    pub network: Network,
    pub restore_height: u64,
    pub push_token: Option<String>,
    pub device_id: Option<String>,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
    pub last_scanned_height: u64,
}

impl fmt::Debug for WatchRegistration {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("WatchRegistration")
            .field("identity_id", &self.identity_id)
            .field("address", &self.address)
            .field("private_view_key", &"<redacted>")
            .field("network", &self.network)
            .field("restore_height", &self.restore_height)
            .field(
                "push_token",
                &self.push_token.as_ref().map(|_| "<redacted>"),
            )
            .field("device_id", &self.device_id)
            .field("created_at_ms", &self.created_at_ms)
            .field("updated_at_ms", &self.updated_at_ms)
            .field("last_scanned_height", &self.last_scanned_height)
            .finish()
    }
}

impl WatchRegistration {
    pub fn from_request(
        request: RegisterWatchRequest,
        now_ms: u64,
    ) -> Result<Self, WatchValidationError> {
        request.validate()?;
        Ok(Self {
            last_scanned_height: request.restore_height.saturating_sub(1),
            created_at_ms: now_ms,
            updated_at_ms: now_ms,
            identity_id: request.identity_id.trim().to_owned(),
            address: request.address.trim().to_owned(),
            private_view_key: request.private_view_key.trim().to_owned(),
            network: request.network,
            restore_height: request.restore_height,
            push_token: request
                .push_token
                .map(clean_optional)
                .filter(|v| !v.is_empty()),
            device_id: request
                .device_id
                .map(clean_optional)
                .filter(|v| !v.is_empty()),
        })
    }

    pub fn response(&self, status: &'static str) -> WatchResponse {
        WatchResponse {
            identity_id: self.identity_id.clone(),
            status: status.to_owned(),
            scanner_status: status.to_owned(),
            network: self.network,
            restore_height: self.restore_height,
            last_scanned_height: self.last_scanned_height,
        }
    }
}

impl RegisterWatchRequest {
    pub fn validate(&self) -> Result<(), WatchValidationError> {
        validate_identity_id(&self.identity_id)?;
        validate_address(&self.address)?;
        validate_private_view_key(&self.private_view_key)?;
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct WatchResponse {
    pub identity_id: String,
    pub status: String,
    pub scanner_status: String,
    pub network: Network,
    pub restore_height: u64,
    pub last_scanned_height: u64,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct RegisterMatchedOutputRequest {
    pub identity_id: String,
    pub tx_id: String,
    pub block_height: u64,
    pub output_index: u64,
    pub block_timestamp_ms: u64,
    #[serde(default)]
    pub amount_atomic: Option<u64>,
    #[serde(default)]
    pub key_image: Option<String>,
}

impl fmt::Debug for RegisterMatchedOutputRequest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("RegisterMatchedOutputRequest")
            .field("identity_id", &self.identity_id)
            .field("tx_id", &self.tx_id)
            .field("block_height", &self.block_height)
            .field("output_index", &self.output_index)
            .field("block_timestamp_ms", &self.block_timestamp_ms)
            .field("amount_atomic", &self.amount_atomic)
            .field("key_image", &self.key_image.as_ref().map(|_| "<redacted>"))
            .finish()
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DetectionStatus {
    Detected,
    Confirmed,
    Reorged,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NotificationStatus {
    Pending,
    Sent,
    Suppressed,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct MatchedOutput {
    pub id: String,
    pub identity_id: String,
    pub tx_id: String,
    pub block_height: u64,
    pub output_index: u64,
    pub block_timestamp_ms: u64,
    pub amount_atomic: Option<u64>,
    pub key_image: Option<String>,
    pub detection_status: DetectionStatus,
    pub notification_status: NotificationStatus,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
}

impl fmt::Debug for MatchedOutput {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("MatchedOutput")
            .field("id", &self.id)
            .field("identity_id", &self.identity_id)
            .field("tx_id", &self.tx_id)
            .field("block_height", &self.block_height)
            .field("output_index", &self.output_index)
            .field("block_timestamp_ms", &self.block_timestamp_ms)
            .field("amount_atomic", &self.amount_atomic)
            .field("key_image", &self.key_image.as_ref().map(|_| "<redacted>"))
            .field("detection_status", &self.detection_status)
            .field("notification_status", &self.notification_status)
            .field("created_at_ms", &self.created_at_ms)
            .field("updated_at_ms", &self.updated_at_ms)
            .finish()
    }
}

impl MatchedOutput {
    pub fn from_request(
        request: RegisterMatchedOutputRequest,
        now_ms: u64,
    ) -> Result<Self, WatchValidationError> {
        request.validate()?;
        let identity_id = request.identity_id.trim().to_owned();
        let tx_id = request.tx_id.trim().to_lowercase();
        let output_index = request.output_index;
        Ok(Self {
            id: matched_output_id(&identity_id, &tx_id, output_index),
            identity_id,
            tx_id,
            block_height: request.block_height,
            output_index,
            block_timestamp_ms: request.block_timestamp_ms,
            amount_atomic: request.amount_atomic,
            key_image: request.key_image.map(|value| value.trim().to_lowercase()),
            detection_status: DetectionStatus::Detected,
            notification_status: NotificationStatus::Pending,
            created_at_ms: now_ms,
            updated_at_ms: now_ms,
        })
    }
}

impl RegisterMatchedOutputRequest {
    pub fn validate(&self) -> Result<(), WatchValidationError> {
        validate_identity_id(&self.identity_id)?;
        validate_hex_32("tx_id", &self.tx_id)?;
        if let Some(key_image) = &self.key_image {
            validate_hex_32("key_image", key_image)?;
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct MatchedOutputResponse {
    pub id: String,
    pub identity_id: String,
    pub tx_id: String,
    pub block_height: u64,
    pub output_index: u64,
    pub block_timestamp_ms: u64,
    pub detection_status: DetectionStatus,
    pub notification_status: NotificationStatus,
}

impl MatchedOutput {
    pub fn response(&self) -> MatchedOutputResponse {
        MatchedOutputResponse {
            id: self.id.clone(),
            identity_id: self.identity_id.clone(),
            tx_id: self.tx_id.clone(),
            block_height: self.block_height,
            output_index: self.output_index,
            block_timestamp_ms: self.block_timestamp_ms,
            detection_status: self.detection_status.clone(),
            notification_status: self.notification_status.clone(),
        }
    }
}

#[derive(Clone, Deserialize, Serialize)]
pub struct KeyImageStatusRequest {
    pub identity_id: String,
    pub key_images: Vec<String>,
}

impl fmt::Debug for KeyImageStatusRequest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("KeyImageStatusRequest")
            .field("identity_id", &self.identity_id)
            .field(
                "key_images",
                &format_args!("<{} redacted>", self.key_images.len()),
            )
            .finish()
    }
}

impl KeyImageStatusRequest {
    pub fn validate(&self) -> Result<(), WatchValidationError> {
        validate_identity_id(&self.identity_id)?;
        if self.key_images.is_empty() || self.key_images.len() > 1024 {
            return Err(WatchValidationError::InvalidKeyImageList);
        }
        for key_image in &self.key_images {
            validate_hex_32("key_image", key_image)?;
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SpentStatus {
    Unknown,
    Unspent,
    Spent,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct KeyImageStatusRecord {
    pub identity_id: String,
    pub key_image: String,
    pub status: SpentStatus,
    pub checked_height: u64,
    pub updated_at_ms: u64,
}

impl fmt::Debug for KeyImageStatusRecord {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("KeyImageStatusRecord")
            .field("identity_id", &self.identity_id)
            .field("key_image", &"<redacted>")
            .field("status", &self.status)
            .field("checked_height", &self.checked_height)
            .field("updated_at_ms", &self.updated_at_ms)
            .finish()
    }
}

#[derive(Clone, Deserialize, Eq, PartialEq, Serialize)]
pub struct KeyImageStatusResponse {
    pub identity_id: String,
    pub items: Vec<KeyImageStatusItem>,
}

impl fmt::Debug for KeyImageStatusResponse {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("KeyImageStatusResponse")
            .field("identity_id", &self.identity_id)
            .field("items", &self.items)
            .finish()
    }
}

#[derive(Clone, Deserialize, Eq, PartialEq, Serialize)]
pub struct KeyImageStatusItem {
    pub key_image: String,
    pub status: SpentStatus,
    pub checked_height: u64,
}

impl fmt::Debug for KeyImageStatusItem {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("KeyImageStatusItem")
            .field("key_image", &"<redacted>")
            .field("status", &self.status)
            .field("checked_height", &self.checked_height)
            .finish()
    }
}

#[derive(Debug, Error, Eq, PartialEq)]
pub enum WatchValidationError {
    #[error("identity_id must be 1..128 chars and contain only letters, numbers, dot, underscore, colon, or dash")]
    InvalidIdentityId,
    #[error("address must look like a Monero address")]
    InvalidAddress,
    #[error("private_view_key must be a 64 character hex string")]
    InvalidPrivateViewKey,
    #[error("network must be mainnet, testnet, or stagenet")]
    InvalidNetwork,
    #[error("{0} must be a 64 character hex string")]
    InvalidHex32(&'static str),
    #[error("key_images must contain 1..1024 entries")]
    InvalidKeyImageList,
}

fn validate_identity_id(value: &str) -> Result<(), WatchValidationError> {
    let value = value.trim();
    if value.is_empty() || value.len() > 128 {
        return Err(WatchValidationError::InvalidIdentityId);
    }
    if value
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b':' | b'-'))
    {
        Ok(())
    } else {
        Err(WatchValidationError::InvalidIdentityId)
    }
}

fn validate_address(value: &str) -> Result<(), WatchValidationError> {
    let value = value.trim();
    if (90..=120).contains(&value.len()) && value.bytes().all(|b| b.is_ascii_alphanumeric()) {
        Ok(())
    } else {
        Err(WatchValidationError::InvalidAddress)
    }
}

fn validate_private_view_key(value: &str) -> Result<(), WatchValidationError> {
    validate_hex_32("private_view_key", value)
        .map_err(|_| WatchValidationError::InvalidPrivateViewKey)
}

fn validate_hex_32(name: &'static str, value: &str) -> Result<(), WatchValidationError> {
    let value = value.trim();
    if value.len() == 64 && hex::decode(value).is_ok() {
        Ok(())
    } else {
        Err(WatchValidationError::InvalidHex32(name))
    }
}

fn clean_optional(value: String) -> String {
    value.trim().to_owned()
}

pub fn matched_output_id(identity_id: &str, tx_id: &str, output_index: u64) -> String {
    format!("{identity_id}:{tx_id}:{output_index}")
}

pub fn key_image_status_id(identity_id: &str, key_image: &str) -> String {
    format!("{}:{}", identity_id, key_image.trim().to_lowercase())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_request() -> RegisterWatchRequest {
        RegisterWatchRequest {
            identity_id: "fast-receive-0-20260701T120000".to_owned(),
            address: "9".repeat(95),
            private_view_key: "a".repeat(64),
            network: Network::Stagenet,
            restore_height: 123,
            push_token: Some("push-token".to_owned()),
            device_id: None,
        }
    }

    #[test]
    fn validates_watch_request_without_logging_secret_material() {
        let request = valid_request();
        request.validate().unwrap();

        let debug = format!("{request:?}");
        assert!(debug.contains("<redacted>"));
        assert!(!debug.contains(&request.private_view_key));
        assert!(!debug.contains("push-token"));
    }

    #[test]
    fn rejects_bad_private_view_key() {
        let mut request = valid_request();
        request.private_view_key = "not-a-key".to_owned();

        assert_eq!(
            request.validate(),
            Err(WatchValidationError::InvalidPrivateViewKey)
        );
    }

    #[test]
    fn validates_match_and_redacts_key_image_debug() {
        let request = RegisterMatchedOutputRequest {
            identity_id: "fast-receive-0".to_owned(),
            tx_id: "1".repeat(64),
            block_height: 42,
            output_index: 7,
            block_timestamp_ms: 1000,
            amount_atomic: Some(5),
            key_image: Some("2".repeat(64)),
        };
        let output = MatchedOutput::from_request(request, 1234).unwrap();
        assert_eq!(output.id, format!("fast-receive-0:{}:7", "1".repeat(64)));

        let debug = format!("{output:?}");
        assert!(debug.contains("<redacted>"));
        assert!(!debug.contains(&"2".repeat(64)));
    }

    #[test]
    fn rejects_empty_key_image_status_query() {
        let request = KeyImageStatusRequest {
            identity_id: "fast-receive-0".to_owned(),
            key_images: Vec::new(),
        };

        assert_eq!(
            request.validate(),
            Err(WatchValidationError::InvalidKeyImageList)
        );
    }

    #[test]
    fn redacts_key_image_status_debug() {
        let key_image = "3".repeat(64);
        let request = KeyImageStatusRequest {
            identity_id: "fast-receive-0".to_owned(),
            key_images: vec![key_image.clone()],
        };
        let response = KeyImageStatusResponse {
            identity_id: "fast-receive-0".to_owned(),
            items: vec![KeyImageStatusItem {
                key_image: key_image.clone(),
                status: SpentStatus::Unknown,
                checked_height: 0,
            }],
        };

        assert!(!format!("{request:?}").contains(&key_image));
        assert!(!format!("{response:?}").contains(&key_image));
    }
}
