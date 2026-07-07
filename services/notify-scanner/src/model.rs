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
    let value = value.trim();
    if value.len() == 64 && hex::decode(value).is_ok() {
        Ok(())
    } else {
        Err(WatchValidationError::InvalidPrivateViewKey)
    }
}

fn clean_optional(value: String) -> String {
    value.trim().to_owned()
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
}
