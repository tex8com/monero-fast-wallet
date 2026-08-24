use crate::{mfw_names, release_features};
use reqwest::{blocking::Client, redirect::Policy, Url};
use serde::{Deserialize, Serialize};
use std::{collections::HashSet, io::Read, time::Duration};

const MAX_RESPONSE_BYTES: u64 = 16 * 1024;
const MAX_SUGGESTION_RESPONSE_BYTES: u64 = 4 * 1024;
const MAX_NAME_SUGGESTIONS: usize = 5;
const MAX_REVERSE_NAMES: usize = 100;
const MIN_CONFIRMATIONS: u64 = 15;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Resolution {
    pub address_kind: u8,
    pub canonical_name: String,
    pub chain_tip_hash_hex: String,
    pub chain_tip_height: u64,
    pub confirmations: u64,
    pub expiry_height: u64,
    pub network: String,
    #[serde(default)]
    pub owner_public_key_hex: String,
    pub public_spend_key_hex: String,
    pub public_view_key_hex: String,
    pub record_block_hash_hex: String,
    pub record_height: u64,
    pub record_payload_hex: String,
    #[serde(default)]
    pub sequence: u64,
    #[serde(default)]
    pub signing_owner_public_key_hex: String,
    pub source_txid_hex: String,
    pub status: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Availability {
    pub canonical_name: String,
    pub status: String,
    pub chain_tip_height: u64,
    pub expiry_height: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SuggestionResponse {
    pub prefix: String,
    pub names: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReverseResponse {
    address: String,
    network: String,
    names: Vec<String>,
    truncated: bool,
    chain_tip_height: u64,
    chain_tip_hash_hex: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReverseOwnedName {
    pub resolution: Resolution,
    pub address: String,
}

pub fn resolve(name: &str) -> Result<Resolution, String> {
    let canonical_name = mfw_names::canonical_name(name)?;
    let origins = release_features::mfw_name_resolver_origins()
        .ok_or_else(|| "MFW resolver quorum is not configured for this release.".to_owned())?;
    resolve_with_origins(&canonical_name, &origins)
}

pub fn resolve_payment(name: &str, network: &str) -> Result<String, String> {
    release_features::require(
        "mfwNameResolution",
        "MFW name resolution is not enabled in this release.",
    )?;
    let resolution = resolve(name)?;
    validate_active(&resolution, name, network, None)?;
    verify_record_address(&resolution, name, network)
}

pub fn suggest(prefix: &str) -> Result<SuggestionResponse, String> {
    release_features::require(
        "mfwNameResolution",
        "MFW name suggestions are not enabled in this release.",
    )?;
    let prefix = normalize_suggestion_prefix(prefix)?;
    let origins = release_features::mfw_name_suggestion_onion_origins()
        .ok_or_else(|| "MFW suggestion resolver is not configured for this release.".to_owned())?;
    suggest_with_origins(&prefix, &origins)
}

pub fn reverse_for_wallet(address: &str, network: &str) -> Result<Vec<ReverseOwnedName>, String> {
    release_features::require(
        "mfwNameRegistration",
        "MFW name reverse discovery is not enabled in this release.",
    )?;
    let origins = release_features::mfw_name_resolver_origins()
        .ok_or_else(|| "MFW resolver quorum is not configured for this release.".to_owned())?;
    let reverse = reverse_with_origins(address, network, &origins)?;
    if reverse.truncated {
        return Err("MFW reverse discovery returned more than 100 names.".to_owned());
    }
    reverse
        .names
        .iter()
        .map(|name| {
            let resolution = resolve_with_origins(name, &origins)?;
            validate_active(&resolution, name, network, None)?;
            let verified = verify_record_address(&resolution, name, network)?;
            if verified != reverse.address {
                return Err("MFW reverse discovery changed the verified address.".to_owned());
            }
            Ok(ReverseOwnedName {
                resolution,
                address: verified,
            })
        })
        .collect()
}

pub fn resolve_predecessor(
    name: &str,
    network: &str,
    expected_owner_public_key_hex: &str,
) -> Result<Resolution, String> {
    release_features::require(
        "mfwNameRegistration",
        "MFW name registration is not enabled in this release.",
    )?;
    let resolution = resolve(name)?;
    validate_active(
        &resolution,
        name,
        network,
        Some(expected_owner_public_key_hex),
    )?;
    verify_record_address(&resolution, name, network)?;
    Ok(resolution)
}

pub fn resolve_for_import(name: &str, network: &str) -> Result<(Resolution, String), String> {
    release_features::require(
        "mfwNameRegistration",
        "MFW name recovery is not enabled in this release.",
    )?;
    let resolution = resolve(name)?;
    validate_active(&resolution, name, network, None)?;
    let address = verify_record_address(&resolution, name, network)?;
    Ok((resolution, address))
}

pub fn availability(name: &str, network: &str) -> Result<Availability, String> {
    release_features::require(
        "mfwNameRegistration",
        "MFW name availability is not enabled in this release.",
    )?;
    let canonical_name = mfw_names::canonical_name(name)?;
    let resolution = resolve(&canonical_name)?;
    if resolution.canonical_name != canonical_name || resolution.network != network {
        return Err("MFW availability response is malformed or wrong-network.".to_owned());
    }
    validate_tip(&resolution)?;
    let status = match resolution.status.as_str() {
        "not_found" => {
            require_empty_record(&resolution)?;
            "available"
        }
        "expired" | "revoked" => "available-again",
        "reserved" => {
            require_empty_record(&resolution)?;
            "reserved"
        }
        "provisional" => "pending",
        "finalized" => "taken",
        _ => return Err("MFW availability response has an unsupported status.".to_owned()),
    };
    Ok(Availability {
        canonical_name,
        status: status.to_owned(),
        chain_tip_height: resolution.chain_tip_height,
        expiry_height: (resolution.expiry_height > 0).then_some(resolution.expiry_height),
    })
}

pub fn validate_expected_finalization(
    resolution: &Resolution,
    record: &mfw_names::OwnedNameRecord,
) -> Result<String, String> {
    let expected_status = if record.stage == "revoke-pending" {
        "revoked"
    } else {
        "finalized"
    };
    if resolution.status != expected_status
        || resolution.canonical_name != record.canonical_name
        || resolution.network != record.network
        || resolution.owner_public_key_hex != record.owner_public_key_hex.as_deref().unwrap_or("")
        || resolution.confirmations < MIN_CONFIRMATIONS
        || resolution.source_txid_hex != record.source_txid_hex.as_deref().unwrap_or("")
        || resolution.sequence != record.sequence
    {
        return Err("The finalized MFW record is not the expected operation.".to_owned());
    }
    validate_tip(resolution)?;
    verify_record_address(resolution, &record.canonical_name, &record.network)
}

pub fn verified_address(
    resolution: &Resolution,
    expected_name: &str,
    expected_network: &str,
) -> Result<String, String> {
    validate_shape(resolution)?;
    validate_tip(resolution)?;
    verify_record_address(resolution, expected_name, expected_network)
}

fn resolve_with_origins(canonical_name: &str, origins: &[String]) -> Result<Resolution, String> {
    if origins.is_empty() || origins.len() > 4 {
        return Err("MFW name resolution requires one to four resolvers.".to_owned());
    }
    let client = Client::builder()
        .timeout(Duration::from_secs(8))
        .redirect(Policy::none())
        .proxy(crate::tor_transport::proxy()?)
        .build()
        .map_err(|_| "MFW resolver transport is unavailable.".to_owned())?;
    let mut answers = Vec::with_capacity(origins.len());
    for origin in origins {
        let origin = validate_origin(origin)?;
        let endpoint = format!(
            "{}/v1/mfw/names/{}",
            origin.trim_end_matches('/'),
            canonical_name
        );
        let mut response = client
            .get(endpoint)
            .header(reqwest::header::ACCEPT, "application/json")
            .send()
            .map_err(|_| "An MFW resolver could not be reached.".to_owned())?;
        if response.status() != reqwest::StatusCode::OK {
            return Err(format!(
                "An MFW resolver returned HTTP {}.",
                response.status().as_u16()
            ));
        }
        let mut body = Vec::new();
        response
            .by_ref()
            .take(MAX_RESPONSE_BYTES + 1)
            .read_to_end(&mut body)
            .map_err(|_| "An MFW resolver response could not be read.".to_owned())?;
        if body.is_empty() || body.len() as u64 > MAX_RESPONSE_BYTES {
            return Err("An MFW resolver response has an invalid size.".to_owned());
        }
        let answer: Resolution = serde_json::from_slice(&body)
            .map_err(|_| "An MFW resolver response is malformed.".to_owned())?;
        validate_shape(&answer)?;
        answers.push(answer);
    }
    let first = answers
        .first()
        .cloned()
        .ok_or_else(|| "MFW resolver quorum is empty.".to_owned())?;
    if answers.iter().any(|answer| answer != &first) {
        return Err("Independent MFW resolvers disagree.".to_owned());
    }
    Ok(first)
}

fn suggest_with_origins(prefix: &str, origins: &[String]) -> Result<SuggestionResponse, String> {
    if origins.is_empty() || origins.len() > 4 {
        return Err("MFW name suggestions require one to four Onion resolvers.".to_owned());
    }
    let client = Client::builder()
        .timeout(Duration::from_secs(8))
        .redirect(Policy::none())
        .proxy(crate::tor_transport::proxy()?)
        .build()
        .map_err(|_| "MFW suggestion transport is unavailable.".to_owned())?;
    let mut answers = Vec::with_capacity(origins.len());
    for origin in origins {
        let origin = validate_origin(origin)?;
        if !origin.ends_with(".onion") {
            return Err("MFW suggestions require direct Onion resolver origins.".to_owned());
        }
        let endpoint = format!(
            "{}/v1/mfw/name-suggestions/{}",
            origin.trim_end_matches('/'),
            prefix
        );
        let mut response = client
            .get(endpoint)
            .header(reqwest::header::ACCEPT, "application/json")
            .send()
            .map_err(|_| "The MFW suggestion resolver could not be reached.".to_owned())?;
        if response.status() != reqwest::StatusCode::OK {
            return Err(format!(
                "The MFW suggestion resolver returned HTTP {}.",
                response.status().as_u16()
            ));
        }
        let mut body = Vec::new();
        response
            .by_ref()
            .take(MAX_SUGGESTION_RESPONSE_BYTES + 1)
            .read_to_end(&mut body)
            .map_err(|_| "The MFW suggestion response could not be read.".to_owned())?;
        if body.is_empty() || body.len() as u64 > MAX_SUGGESTION_RESPONSE_BYTES {
            return Err("The MFW suggestion response has an invalid size.".to_owned());
        }
        let answer: SuggestionResponse = serde_json::from_slice(&body)
            .map_err(|_| "The MFW suggestion response is malformed.".to_owned())?;
        validate_suggestion_response(&answer, prefix)?;
        answers.push(answer);
    }
    let first = answers
        .first()
        .cloned()
        .ok_or_else(|| "MFW suggestion resolver quorum is empty.".to_owned())?;
    if answers.iter().any(|answer| answer != &first) {
        return Err("Independent MFW suggestion resolvers disagree.".to_owned());
    }
    Ok(first)
}

fn reverse_with_origins(
    address: &str,
    network: &str,
    origins: &[String],
) -> Result<ReverseResponse, String> {
    let address = address.trim();
    if address.len() != 95 || !address.bytes().all(is_monero_base58) {
        return Err("MFW reverse address is invalid.".to_owned());
    }
    if !matches!(network, "mainnet" | "testnet" | "stagenet")
        || origins.is_empty()
        || origins.len() > 4
    {
        return Err("MFW reverse discovery is not configured.".to_owned());
    }
    let client = Client::builder()
        .timeout(Duration::from_secs(8))
        .redirect(Policy::none())
        .proxy(crate::tor_transport::proxy()?)
        .build()
        .map_err(|_| "MFW reverse transport is unavailable.".to_owned())?;
    let mut answers = Vec::with_capacity(origins.len());
    for origin in origins {
        let origin = validate_origin(origin)?;
        if !origin.ends_with(".onion") {
            return Err("MFW reverse discovery requires direct Onion resolver origins.".to_owned());
        }
        let endpoint = format!(
            "{}/v1/mfw/addresses/{}/names",
            origin.trim_end_matches('/'),
            address
        );
        let mut response = client
            .get(endpoint)
            .header(reqwest::header::ACCEPT, "application/json")
            .send()
            .map_err(|_| "An MFW reverse resolver could not be reached.".to_owned())?;
        if response.status() != reqwest::StatusCode::OK {
            return Err(format!(
                "An MFW reverse resolver returned HTTP {}.",
                response.status().as_u16()
            ));
        }
        let mut body = Vec::new();
        response
            .by_ref()
            .take(MAX_RESPONSE_BYTES + 1)
            .read_to_end(&mut body)
            .map_err(|_| "An MFW reverse response could not be read.".to_owned())?;
        if body.is_empty() || body.len() as u64 > MAX_RESPONSE_BYTES {
            return Err("An MFW reverse response has an invalid size.".to_owned());
        }
        let answer: ReverseResponse = serde_json::from_slice(&body)
            .map_err(|_| "An MFW reverse response is malformed.".to_owned())?;
        validate_reverse_response(&answer, address, network)?;
        answers.push(answer);
    }
    let first = answers
        .first()
        .cloned()
        .ok_or_else(|| "MFW reverse resolver quorum is empty.".to_owned())?;
    if answers.iter().any(|answer| answer != &first) {
        return Err("Independent MFW reverse resolvers disagree.".to_owned());
    }
    Ok(first)
}

fn validate_reverse_response(
    response: &ReverseResponse,
    expected_address: &str,
    expected_network: &str,
) -> Result<(), String> {
    if response.address != expected_address
        || response.network != expected_network
        || response.names.len() > MAX_REVERSE_NAMES
        || !is_hex(&response.chain_tip_hash_hex, 32)
    {
        return Err("The MFW reverse response is malformed.".to_owned());
    }
    let mut previous: Option<&str> = None;
    let mut unique = HashSet::new();
    for name in &response.names {
        if mfw_names::canonical_name(name).as_deref() != Ok(name.as_str())
            || previous.is_some_and(|value| value >= name.as_str())
            || !unique.insert(name)
        {
            return Err("The MFW reverse response is malformed.".to_owned());
        }
        previous = Some(name);
    }
    Ok(())
}

fn is_monero_base58(byte: u8) -> bool {
    b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz".contains(&byte)
}

fn normalize_suggestion_prefix(value: &str) -> Result<String, String> {
    let normalized = value.trim().to_ascii_lowercase();
    if normalized.len() < 3
        || normalized.len() > 63
        || normalized.starts_with('-')
        || normalized.ends_with('-')
        || !normalized
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
    {
        return Err("MFW suggestion prefix is invalid.".to_owned());
    }
    Ok(normalized)
}

fn validate_suggestion_response(
    response: &SuggestionResponse,
    expected_prefix: &str,
) -> Result<(), String> {
    if response.prefix != expected_prefix || response.names.len() > MAX_NAME_SUGGESTIONS {
        return Err("The MFW suggestion response is malformed.".to_owned());
    }
    let mut unique = HashSet::new();
    for name in &response.names {
        if mfw_names::canonical_name(name).as_deref() != Ok(name.as_str())
            || !name.starts_with(expected_prefix)
            || !unique.insert(name)
        {
            return Err("The MFW suggestion response is malformed.".to_owned());
        }
    }
    Ok(())
}

fn validate_origin(value: &str) -> Result<String, String> {
    let url = Url::parse(value)
        .map_err(|_| "MFW resolver origins must be bare private-service origins.".to_owned())?;
    let onion = url.scheme() == "http"
        && url.host_str().is_some_and(|host| {
            host.len() == 62
                && host.ends_with(".onion")
                && host[..56]
                    .bytes()
                    .all(|byte| matches!(byte, b'a'..=b'z' | b'2'..=b'7'))
        });
    if (url.scheme() != "https" && !onion)
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || !matches!(url.path(), "" | "/")
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("MFW resolver origins must be bare HTTPS or Tor v3 Onion origins.".to_owned());
    }
    Ok(url.origin().ascii_serialization())
}

fn validate_active(
    resolution: &Resolution,
    expected_name: &str,
    expected_network: &str,
    expected_owner: Option<&str>,
) -> Result<(), String> {
    let expected_name = mfw_names::canonical_name(expected_name)?;
    if resolution.status != "finalized"
        || resolution.canonical_name != expected_name
        || resolution.network != expected_network
        || resolution.confirmations < MIN_CONFIRMATIONS
        || resolution.expiry_height <= resolution.chain_tip_height
        || expected_owner.is_some_and(|owner| resolution.owner_public_key_hex != owner)
    {
        return Err("MFW name is not an active, finalized, owner-matched record.".to_owned());
    }
    validate_shape(resolution)?;
    validate_tip(resolution)
}

fn validate_shape(resolution: &Resolution) -> Result<(), String> {
    mfw_names::canonical_name(&resolution.canonical_name)?;
    if !matches!(
        resolution.status.as_str(),
        "not_found" | "reserved" | "provisional" | "finalized" | "expired" | "revoked"
    ) || !matches!(
        resolution.network.as_str(),
        "mainnet" | "testnet" | "stagenet"
    ) || resolution.address_kind > 1
    {
        return Err("MFW resolver response is malformed.".to_owned());
    }
    for value in [
        &resolution.chain_tip_hash_hex,
        &resolution.owner_public_key_hex,
        &resolution.public_spend_key_hex,
        &resolution.public_view_key_hex,
        &resolution.record_block_hash_hex,
        &resolution.signing_owner_public_key_hex,
        &resolution.source_txid_hex,
    ] {
        if !value.is_empty() && !is_hex(value, 32) {
            return Err("MFW resolver response contains malformed binary data.".to_owned());
        }
    }
    let legacy_record = resolution.owner_public_key_hex.is_empty()
        && resolution.signing_owner_public_key_hex.is_empty()
        && resolution.sequence == 0
        && is_bounded_hex(&resolution.record_payload_hex, 89, 152);
    let current_record = is_hex(&resolution.owner_public_key_hex, 32)
        && is_hex(&resolution.signing_owner_public_key_hex, 32)
        && is_bounded_hex(&resolution.record_payload_hex, 189, 251);
    if !resolution.record_payload_hex.is_empty() && !legacy_record && !current_record {
        return Err("MFW resolver response contains a malformed signed record.".to_owned());
    }
    Ok(())
}

fn validate_tip(resolution: &Resolution) -> Result<(), String> {
    if !is_hex(&resolution.chain_tip_hash_hex, 32) {
        return Err("MFW resolver response has no canonical chain tip.".to_owned());
    }
    if resolution.status != "not_found"
        && resolution
            .record_height
            .saturating_add(resolution.confirmations.saturating_sub(1))
            > resolution.chain_tip_height
    {
        return Err("MFW resolver response has inconsistent confirmations.".to_owned());
    }
    Ok(())
}

fn require_empty_record(resolution: &Resolution) -> Result<(), String> {
    if resolution.address_kind != 0
        || !resolution.public_spend_key_hex.is_empty()
        || !resolution.public_view_key_hex.is_empty()
        || !resolution.owner_public_key_hex.is_empty()
        || resolution.sequence != 0
        || resolution.record_height != 0
        || !resolution.source_txid_hex.is_empty()
        || resolution.expiry_height != 0
        || resolution.confirmations != 0
        || !resolution.record_payload_hex.is_empty()
        || !resolution.signing_owner_public_key_hex.is_empty()
        || !resolution.record_block_hash_hex.is_empty()
    {
        return Err("MFW not-found response unexpectedly contains a record.".to_owned());
    }
    Ok(())
}

fn verify_record_address(
    resolution: &Resolution,
    expected_name: &str,
    network: &str,
) -> Result<String, String> {
    let record = hex::decode(&resolution.record_payload_hex)
        .map_err(|_| "MFW signed record is malformed.".to_owned())?;
    let network = match network {
        "mainnet" => 0,
        "testnet" => 1,
        "stagenet" => 2,
        _ => return Err("Unsupported MFW network.".to_owned()),
    };
    let canonical_name = mfw_names::canonical_name(expected_name)?;
    let mut output = [0_u8; fast_wallet_protocol::ffi::MFW_MONERO_ADDRESS_BYTES];
    let status = if resolution.signing_owner_public_key_hex.is_empty() {
        unsafe {
            fast_wallet_protocol::ffi::tex8_mfw_verify_and_encode_legacy_name_address_v1(
                record.as_ptr(),
                record.len(),
                canonical_name.as_ptr(),
                canonical_name.len(),
                network,
                output.as_mut_ptr(),
                output.len(),
            )
        }
    } else {
        let signer = hex::decode(&resolution.signing_owner_public_key_hex)
            .map_err(|_| "MFW signing owner key is malformed.".to_owned())?;
        unsafe {
            fast_wallet_protocol::ffi::tex8_mfw_verify_and_encode_name_address_v1(
                record.as_ptr(),
                record.len(),
                canonical_name.as_ptr(),
                canonical_name.len(),
                network,
                signer.as_ptr(),
                signer.len(),
                output.as_mut_ptr(),
                output.len(),
            )
        }
    };
    if status != fast_wallet_protocol::ffi::OK {
        return Err("MFW signed record failed native owner verification.".to_owned());
    }
    String::from_utf8(output.to_vec()).map_err(|_| "MFW record address is invalid.".to_owned())
}

fn is_hex(value: &str, bytes: usize) -> bool {
    value.len() == bytes * 2
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

fn is_bounded_hex(value: &str, minimum_bytes: usize, maximum_bytes: usize) -> bool {
    value.len() % 2 == 0
        && value.len() >= minimum_bytes * 2
        && value.len() <= maximum_bytes * 2
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

#[cfg(test)]
mod tests {
    use super::{
        normalize_suggestion_prefix, require_empty_record, validate_origin,
        validate_reverse_response, validate_shape, validate_suggestion_response, Resolution,
        ReverseResponse, SuggestionResponse,
    };

    fn empty_resolution() -> Resolution {
        Resolution {
            address_kind: 0,
            canonical_name: "alice.mfw".to_owned(),
            chain_tip_hash_hex: "11".repeat(32),
            chain_tip_height: 100,
            confirmations: 0,
            expiry_height: 0,
            network: "mainnet".to_owned(),
            owner_public_key_hex: String::new(),
            public_spend_key_hex: String::new(),
            public_view_key_hex: String::new(),
            record_block_hash_hex: String::new(),
            record_height: 0,
            record_payload_hex: String::new(),
            sequence: 0,
            signing_owner_public_key_hex: String::new(),
            source_txid_hex: String::new(),
            status: "not_found".to_owned(),
        }
    }

    #[test]
    fn origins_reject_credentials_paths_and_plain_http() {
        assert_eq!(
            validate_origin("https://mfw.example/").unwrap(),
            "https://mfw.example"
        );
        assert!(validate_origin("http://mfw.example/").is_err());
        assert!(validate_origin("https://user@mfw.example/").is_err());
        assert!(validate_origin("https://mfw.example/path").is_err());
    }

    #[test]
    fn unknown_json_fields_fail_closed() {
        let mut value = serde_json::to_value(empty_resolution()).unwrap();
        value["unexpected"] = serde_json::json!(true);
        assert!(serde_json::from_value::<Resolution>(value).is_err());
    }

    #[test]
    fn first_public_resolver_legacy_fields_default_only_for_availability() {
        let mut value = serde_json::to_value(empty_resolution()).unwrap();
        value.as_object_mut().unwrap().remove("ownerPublicKeyHex");
        value.as_object_mut().unwrap().remove("sequence");
        value
            .as_object_mut()
            .unwrap()
            .remove("signingOwnerPublicKeyHex");
        let parsed = serde_json::from_value::<Resolution>(value).unwrap();
        assert!(parsed.owner_public_key_hex.is_empty());
        assert_eq!(parsed.sequence, 0);
        assert!(parsed.signing_owner_public_key_hex.is_empty());
    }

    #[test]
    fn not_found_response_must_be_empty_but_keep_canonical_tip() {
        let mut value = empty_resolution();
        assert!(validate_shape(&value).is_ok());
        assert!(require_empty_record(&value).is_ok());
        value.owner_public_key_hex = "22".repeat(32);
        assert!(require_empty_record(&value).is_err());
    }

    #[test]
    fn suggestion_prefix_and_response_are_strict() {
        assert_eq!(normalize_suggestion_prefix(" TeX ").unwrap(), "tex");
        assert!(normalize_suggestion_prefix("te").is_err());
        assert!(normalize_suggestion_prefix("tex.mfw").is_err());
        let response = SuggestionResponse {
            prefix: "tex".to_owned(),
            names: vec!["tex8.mfw".to_owned()],
        };
        assert!(validate_suggestion_response(&response, "tex").is_ok());
        let duplicate = SuggestionResponse {
            prefix: "tex".to_owned(),
            names: vec!["tex8.mfw".to_owned(), "tex8.mfw".to_owned()],
        };
        assert!(validate_suggestion_response(&duplicate, "tex").is_err());
    }

    #[test]
    fn reverse_response_is_exact_sorted_and_tip_bound() {
        let address = "49indexNameRuJZKgFL42yi11NgwYn3pzgf45HvvbEpCZq29KfQknnUM6xaptUokNsjh8TRghjr94ioSN2ZNhePm1vzJLQJ";
        let mut response = ReverseResponse {
            address: address.to_owned(),
            network: "mainnet".to_owned(),
            names: vec!["alice.mfw".to_owned(), "shop.mfw".to_owned()],
            truncated: false,
            chain_tip_height: 100,
            chain_tip_hash_hex: "11".repeat(32),
        };
        assert!(validate_reverse_response(&response, address, "mainnet").is_ok());
        response.names.reverse();
        assert!(validate_reverse_response(&response, address, "mainnet").is_err());
    }
}
