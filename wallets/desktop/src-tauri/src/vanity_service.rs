use std::{fs, io::Write, time::Duration};

use curve25519_dalek::{constants::ED25519_BASEPOINT_POINT, scalar::Scalar};
use monero_address::{AddressType as MoneroAddressType, MoneroAddress, Network};
use reqwest::header;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use zeroize::Zeroizing;

const MAX_RESPONSE_BYTES: usize = 256 * 1024;
const MONERO_BASE58: &str = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const VANITY_ONION_ORIGIN: &str =
    "http://vanityxmrbzqenrthzrlq2akcigzrjhpzewqsns2kfcj4a4vrq54khad.onion";

#[derive(Clone, Debug, Deserialize, Serialize)]
struct VanityRecoveryResult {
    matched_prefix: String,
    result_address: String,
    key_offset_hex: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct VanityRecoveryState {
    version: u8,
    kind: String,
    order_id: String,
    source_wallet_registration_id: String,
    source_public_address: String,
    results: Vec<VanityRecoveryResult>,
    created_at: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateVanityQuoteInput {
    pub source_wallet_registration_id: String,
    pub public_address: String,
    pub account_index: Option<u32>,
    pub address_index: Option<u32>,
    pub prefixes: Vec<String>,
    pub notification_installation_id: String,
}

pub async fn create_quote(input: CreateVanityQuoteInput) -> Result<String, String> {
    validate_create_input(&input)?;
    let response = client()?
        .post(format!("{}/api/v1/quotes", origin()?))
        .header(header::ACCEPT, "application/json")
        .json(&json!({
            "version": 1,
            "kind": "monero",
            "network": "mainnet",
            "public_address": input.public_address,
            "prefixes": input.prefixes,
            "notification": {
                "installation_id": input.notification_installation_id,
                "platform": "desktop"
            }
        }))
        .send()
        .await
        .map_err(|_| "The Vanity service could not be reached through Tor.".to_owned())?;
    let status = response.status();
    let bytes = response
        .bytes()
        .await
        .map_err(|_| "The Vanity quote response could not be read.".to_owned())?;
    if bytes.len() > MAX_RESPONSE_BYTES {
        return Err("The Vanity quote response was too large.".to_owned());
    }
    let mut value: Value = serde_json::from_slice(&bytes)
        .map_err(|_| "The Vanity quote response was invalid.".to_owned())?;
    if !status.is_success() {
        return Err(value
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("The Vanity quote was rejected.")
            .to_owned());
    }
    let order_id = value
        .pointer("/order/id")
        .and_then(Value::as_str)
        .filter(|value| valid_order_id(value))
        .ok_or_else(|| "The Vanity quote has no valid order ID.".to_owned())?
        .to_owned();
    let deep_link = value
        .get("status_deep_link")
        .and_then(Value::as_str)
        .filter(|value| *value == format!("mfw://vanity/order/{order_id}"))
        .ok_or_else(|| "The Vanity quote has an invalid status link.".to_owned())?;
    let _ = deep_link;
    let token = Zeroizing::new(
        value
            .get_mut("status_token")
            .map(Value::take)
            .and_then(|value| value.as_str().map(str::to_owned))
            .filter(|value| valid_status_token(value))
            .ok_or_else(|| "The Vanity quote has no valid status credential.".to_owned())?,
    );
    crate::secure_store::store_vanity_order_status_token(&order_id, token.to_string())?;
    crate::secure_store::store_latest_vanity_order_id(order_id.clone())?;
    store_recovery_state(&VanityRecoveryState {
        version: 1,
        kind: "mfw-monero-vanity-split-recovery-v1".to_owned(),
        order_id,
        source_wallet_registration_id: input.source_wallet_registration_id,
        source_public_address: input.public_address,
        results: Vec::new(),
        created_at: unix_time(),
    })?;
    serde_json::to_string(&value).map_err(|_| "The Vanity quote could not be prepared.".to_owned())
}

pub fn latest_order_id() -> Result<Option<String>, String> {
    match crate::secure_store::load_latest_vanity_order_id()? {
        Some(order_id) if valid_order_id(&order_id) => Ok(Some(order_id)),
        Some(_) => Err("The stored Vanity order ID is invalid.".to_owned()),
        None => Ok(None),
    }
}

pub async fn order_status(order_id: String) -> Result<String, String> {
    if !valid_order_id(&order_id) {
        return Err("The Vanity order ID is invalid.".to_owned());
    }
    let token = Zeroizing::new(
        crate::secure_store::load_vanity_order_status_token(&order_id)?
            .filter(|value| valid_status_token(value))
            .ok_or_else(|| "This Vanity order is not stored on this device.".to_owned())?,
    );
    let response = client()?
        .get(format!("{}/api/v1/orders/{order_id}", origin()?))
        .header(header::ACCEPT, "application/json")
        .bearer_auth(token.as_str())
        .send()
        .await
        .map_err(|_| "The Vanity service could not be reached through Tor.".to_owned())?;
    let status = response.status();
    let bytes = response
        .bytes()
        .await
        .map_err(|_| "The Vanity status response could not be read.".to_owned())?;
    if bytes.len() > MAX_RESPONSE_BYTES {
        return Err("The Vanity status response was too large.".to_owned());
    }
    let mut value: Value = serde_json::from_slice(&bytes)
        .map_err(|_| "The Vanity status response was invalid.".to_owned())?;
    if !status.is_success() {
        return Err(value
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("The Vanity status request was rejected.")
            .to_owned());
    }
    if value.pointer("/order/id").and_then(Value::as_str) != Some(order_id.as_str())
        || value.get("status_token").is_some()
    {
        return Err("The Vanity status response did not match this order.".to_owned());
    }
    persist_completed_recovery(&order_id, &value)?;
    strip_result_offsets(&mut value);
    serde_json::to_string(&value).map_err(|_| "The Vanity status could not be prepared.".to_owned())
}

pub fn export_recovery(order_id: String) -> Result<(), String> {
    if !valid_order_id(&order_id) {
        return Err("The Vanity order ID is invalid.".to_owned());
    }
    let state = load_recovery_state(&order_id)?;
    if state.results.is_empty() {
        return Err("No completed Vanity recovery data is stored for this order.".to_owned());
    }
    validate_recovery_state(&state)?;
    let payload = serde_json::to_string(&state)
        .map_err(|_| "The Vanity recovery backup could not be encoded.".to_owned())?;
    let path = rfd::FileDialog::new()
        .add_filter("MFW Vanity recovery", &["mfw-vanity-recovery"])
        .set_file_name(format!("{}-vanity.mfw-vanity-recovery", state.order_id))
        .save_file()
        .ok_or_else(|| "Vanity recovery export was cancelled.".to_owned())?;
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path).map_err(|_| {
        "Choose a new file name; an existing recovery file will not be overwritten.".to_owned()
    })?;
    file.write_all(format!("MFW Vanity recovery v1\n{payload}\n").as_bytes())
        .and_then(|_| file.sync_all())
        .map_err(|_| "The Vanity recovery backup could not be saved.".to_owned())
}

fn persist_completed_recovery(order_id: &str, value: &Value) -> Result<(), String> {
    let Some(groups) = value
        .pointer("/order/search_groups")
        .and_then(Value::as_array)
    else {
        return Err("The Vanity status response has invalid search groups.".to_owned());
    };
    let mut results = Vec::new();
    for group in groups {
        if group.get("status").and_then(Value::as_str) != Some("completed") {
            continue;
        }
        let result = VanityRecoveryResult {
            matched_prefix: group
                .get("matched_prefix")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            result_address: group
                .get("result_address")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            key_offset_hex: group
                .get("result_key_offset")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
        };
        validate_recovery_result(&result)?;
        results.push(result);
    }
    if results.is_empty() {
        return Ok(());
    }
    let mut state = load_recovery_state(order_id)?;
    state.results = results;
    validate_recovery_state(&state)?;
    store_recovery_state(&state)
}

fn strip_result_offsets(value: &mut Value) {
    if let Some(groups) = value
        .pointer_mut("/order/search_groups")
        .and_then(Value::as_array_mut)
    {
        for group in groups {
            if let Some(object) = group.as_object_mut() {
                object.remove("result_key_offset");
                if let Some(candidates) = object.get_mut("candidates").and_then(Value::as_array_mut)
                {
                    for candidate in candidates {
                        if let Some(candidate) = candidate.as_object_mut() {
                            candidate.remove("result_key_offset");
                        }
                    }
                }
            }
        }
    }
}

fn store_recovery_state(state: &VanityRecoveryState) -> Result<(), String> {
    validate_recovery_state(state)?;
    crate::secure_store::store_vanity_order_recovery_state(
        &state.order_id,
        serde_json::to_string(state)
            .map_err(|_| "The Vanity recovery state could not be encoded.".to_owned())?,
    )
}

fn load_recovery_state(order_id: &str) -> Result<VanityRecoveryState, String> {
    let raw = Zeroizing::new(
        crate::secure_store::load_vanity_order_recovery_state(order_id)?
            .ok_or_else(|| "This Vanity recovery state is not stored on this device.".to_owned())?,
    );
    let state: VanityRecoveryState = serde_json::from_str(raw.as_str())
        .map_err(|_| "The protected Vanity recovery state is invalid.".to_owned())?;
    validate_recovery_state(&state)?;
    Ok(state)
}

fn validate_recovery_state(state: &VanityRecoveryState) -> Result<(), String> {
    if state.version != 1
        || state.kind != "mfw-monero-vanity-split-recovery-v1"
        || !valid_order_id(&state.order_id)
        || state.source_wallet_registration_id.trim().is_empty()
        || !valid_primary_address(&state.source_public_address)
        || state.results.len() > 100
        || state.results.iter().any(|result| {
            validate_recovery_result(result).is_err()
                || !valid_split_key_result(
                    &state.source_public_address,
                    &result.result_address,
                    &result.key_offset_hex,
                )
        })
    {
        return Err("The protected Vanity recovery state is invalid.".to_owned());
    }
    Ok(())
}

fn validate_recovery_result(result: &VanityRecoveryResult) -> Result<(), String> {
    if !(2..=10).contains(&result.matched_prefix.len())
        || !result.matched_prefix.starts_with('4')
        || !result
            .matched_prefix
            .bytes()
            .all(|byte| MONERO_BASE58.as_bytes().contains(&byte))
        || !valid_primary_address(&result.result_address)
        || !result.result_address.starts_with(&result.matched_prefix)
        || result.key_offset_hex.len() != 64
        || !result
            .key_offset_hex
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        || result.key_offset_hex.bytes().all(|byte| byte == b'0')
    {
        return Err("The Vanity service returned invalid recovery data.".to_owned());
    }
    Ok(())
}

fn valid_primary_address(value: &str) -> bool {
    value.len() == 95
        && value.starts_with('4')
        && value
            .bytes()
            .all(|byte| MONERO_BASE58.as_bytes().contains(&byte))
        && MoneroAddress::from_str(Network::Mainnet, value)
            .is_ok_and(|address| *address.kind() == MoneroAddressType::Legacy)
}

fn valid_split_key_result(source: &str, result: &str, offset_hex: &str) -> bool {
    let (Ok(source), Ok(result)) = (
        MoneroAddress::from_str(Network::Mainnet, source),
        MoneroAddress::from_str(Network::Mainnet, result),
    ) else {
        return false;
    };
    if *source.kind() != MoneroAddressType::Legacy
        || *result.kind() != MoneroAddressType::Legacy
        || source.view() != result.view()
    {
        return false;
    }
    let mut offset_bytes = [0_u8; 32];
    if hex::decode_to_slice(offset_hex, &mut offset_bytes).is_err() {
        return false;
    }
    let offset = Option::<Scalar>::from(Scalar::from_canonical_bytes(offset_bytes));
    offset_bytes.fill(0);
    offset.is_some_and(|offset| {
        offset != Scalar::ZERO
            && source.spend() + offset * ED25519_BASEPOINT_POINT == result.spend()
    })
}

fn unix_time() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |duration| duration.as_secs())
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .user_agent("Monero-Fast-Wallet-Desktop/0.1")
        .proxy(crate::tor_transport::proxy()?)
        .build()
        .map_err(|_| "The Vanity Tor client could not be initialized.".to_owned())
}

fn origin() -> Result<&'static str, String> {
    let value = VANITY_ONION_ORIGIN;
    let valid = value.starts_with("http://")
        && value.ends_with(".onion")
        && value
            .strip_prefix("http://")
            .and_then(|host| host.strip_suffix(".onion"))
            .is_some_and(|host| {
                host.len() == 56
                    && host
                        .bytes()
                        .all(|byte| byte.is_ascii_lowercase() || (b'2'..=b'7').contains(&byte))
            });
    valid
        .then_some(value)
        .ok_or_else(|| "The Vanity Hidden Service is not configured.".to_owned())
}

fn validate_create_input(input: &CreateVanityQuoteInput) -> Result<(), String> {
    if input.source_wallet_registration_id.trim().is_empty()
        || input.public_address.len() != 95
        || !input.public_address.starts_with('4')
        || !input
            .public_address
            .bytes()
            .all(|byte| MONERO_BASE58.as_bytes().contains(&byte))
        || input.prefixes.is_empty()
        || input.prefixes.len() > 100
        || input.prefixes.iter().any(|prefix| {
            !(2..=10).contains(&prefix.len())
                || !prefix.starts_with('4')
                || !prefix
                    .bytes()
                    .all(|byte| MONERO_BASE58.as_bytes().contains(&byte))
        })
        || input.notification_installation_id.len() < 24
        || input.notification_installation_id.len() > 128
    {
        return Err("The Vanity quote request is invalid.".to_owned());
    }
    let mut unique = std::collections::HashSet::new();
    if input.prefixes.iter().any(|prefix| !unique.insert(prefix)) {
        return Err("Every Vanity prefix must be different.".to_owned());
    }
    Ok(())
}

fn valid_order_id(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(index, byte)| {
            if matches!(index, 8 | 13 | 18 | 23) {
                byte == b'-'
            } else {
                byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()
            }
        })
}

fn valid_status_token(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_identifiers_are_strict() {
        assert!(valid_order_id("12345678-1234-1234-1234-123456789abc"));
        assert!(!valid_order_id("../orders/secret"));
        assert!(valid_status_token(&"ab".repeat(32)));
        assert!(!valid_status_token(&"AB".repeat(32)));
    }

    #[test]
    fn recovery_state_is_seed_bound_and_offsets_do_not_cross_into_webview() {
        let source = MoneroAddress::new(
            Network::Mainnet,
            MoneroAddressType::Legacy,
            ED25519_BASEPOINT_POINT,
            ED25519_BASEPOINT_POINT * Scalar::from(2_u64),
        );
        let offset = Scalar::from(3_u64);
        let result = MoneroAddress::new(
            Network::Mainnet,
            MoneroAddressType::Legacy,
            source.spend() + offset * ED25519_BASEPOINT_POINT,
            source.view(),
        );
        let result_address = result.to_string();
        let recovery = VanityRecoveryState {
            version: 1,
            kind: "mfw-monero-vanity-split-recovery-v1".to_owned(),
            order_id: "12345678-1234-1234-1234-123456789abc".to_owned(),
            source_wallet_registration_id: "wallet-1".to_owned(),
            source_public_address: source.to_string(),
            results: vec![VanityRecoveryResult {
                matched_prefix: result_address[..3].to_owned(),
                result_address,
                key_offset_hex: hex::encode(offset.to_bytes()),
            }],
            created_at: 1,
        };
        assert!(validate_recovery_state(&recovery).is_ok());

        let mut response = serde_json::json!({
            "order": {
                "search_groups": [{
                    "result_key_offset": "12".repeat(32),
                    "candidates": [{"result_key_offset": "34".repeat(32)}]
                }]
            }
        });
        strip_result_offsets(&mut response);
        assert!(response
            .pointer("/order/search_groups/0/result_key_offset")
            .is_none());
        assert!(response
            .pointer("/order/search_groups/0/candidates/0/result_key_offset")
            .is_none());
    }
}
