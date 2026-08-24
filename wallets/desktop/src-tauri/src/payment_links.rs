use reqwest::{redirect::Policy, Client, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const MAX_RESPONSE_BYTES: usize = 4 * 1024;
const MAX_PAYMENT_URI_LENGTH: usize = 1_024;
const MAX_SERVER_TTL_MS: u64 = 30 * 24 * 60 * 60 * 1_000;
const MAX_CLOCK_SKEW_MS: u64 = 5 * 60 * 1_000;
const MAX_MONERO_ATOMIC_AMOUNT: u128 = 18_446_744_073_709_551_615;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatePaymentLinkInput {
    pub uri: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PaymentLinkRecord {
    pub expires_at: u64,
    pub id: String,
    pub uri: String,
    pub url: String,
}

pub async fn create(uri: &str) -> Result<PaymentLinkRecord, String> {
    require_canonical_payment_uri(uri)?;
    let origin = crate::release_features::payment_link_origin()
        .ok_or_else(|| "Payment link service is unavailable.".to_owned())?;
    let client = Client::builder()
        .timeout(Duration::from_secs(25))
        .redirect(Policy::none())
        .proxy(crate::tor_transport::proxy()?)
        .build()
        .map_err(|_| "Payment link service is unavailable.".to_owned())?;
    let response = client
        .post(format!("{origin}/v1/payment-requests"))
        .header("Accept", "application/json")
        .json(&serde_json::json!({ "uri": uri }))
        .send()
        .await
        .map_err(|_| "Payment link service is unavailable.".to_owned())?;
    if response.status() != StatusCode::CREATED {
        return Err("Payment link service returned an invalid status.".to_owned());
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
    {
        return Err("Payment link service response has an invalid size.".to_owned());
    }
    let body = response
        .bytes()
        .await
        .map_err(|_| "Payment link service response is unavailable.".to_owned())?;
    if body.is_empty() || body.len() > MAX_RESPONSE_BYTES {
        return Err("Payment link service response has an invalid size.".to_owned());
    }
    let value: Value = serde_json::from_slice(&body)
        .map_err(|_| "Payment link service response is malformed.".to_owned())?;
    let object = value
        .as_object()
        .ok_or_else(|| "Payment link service response is malformed.".to_owned())?;
    let expected_keys = ["expiresAt", "id", "uri", "url"];
    let mut keys = object.keys().map(String::as_str).collect::<Vec<_>>();
    keys.sort_unstable();
    if keys != expected_keys {
        return Err("Payment link service response is malformed.".to_owned());
    }
    let record: PaymentLinkRecord = serde_json::from_value(value)
        .map_err(|_| "Payment link service response is malformed.".to_owned())?;
    validate_record(&record, &origin, uri)?;
    Ok(record)
}

fn validate_record(
    record: &PaymentLinkRecord,
    origin: &str,
    expected_uri: &str,
) -> Result<(), String> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "Device clock is invalid.".to_owned())?
        .as_millis() as u64;
    if !valid_payment_request_id(&record.id)
        || record.uri != expected_uri
        || record.url != format!("{origin}/pay/{}", record.id)
        || record.expires_at <= now
        || record.expires_at > now + MAX_SERVER_TTL_MS + MAX_CLOCK_SKEW_MS
    {
        return Err("Payment link service response is invalid.".to_owned());
    }
    require_canonical_payment_uri(&record.uri)
}

fn valid_payment_request_id(value: &str) -> bool {
    value.len() == 22
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn require_canonical_payment_uri(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > MAX_PAYMENT_URI_LENGTH
        || value.trim() != value
        || !value.bytes().all(|byte| (0x21..=0x7e).contains(&byte))
        || !value.starts_with("monero:")
        || value.contains('#')
    {
        return Err("Payment URI is invalid.".to_owned());
    }
    let payload = &value["monero:".len()..];
    let (address, query) = payload
        .split_once('?')
        .map_or((payload, None), |(address, query)| (address, Some(query)));
    if !valid_monero_address(address) {
        return Err("Payment URI is invalid.".to_owned());
    }
    let Some(query) = query else {
        return Ok(());
    };
    if query.is_empty() {
        return Err("Payment URI is invalid.".to_owned());
    }
    let allowed = ["tx_amount", "recipient_name", "tx_description"];
    let mut previous = None;
    for part in query.split('&') {
        let (key, encoded) = part
            .split_once('=')
            .filter(|(key, encoded)| !key.is_empty() && !encoded.is_empty())
            .ok_or_else(|| "Payment URI is invalid.".to_owned())?;
        let position = allowed
            .iter()
            .position(|candidate| *candidate == key)
            .ok_or_else(|| "Payment URI is invalid.".to_owned())?;
        if previous.is_some_and(|last| position <= last) {
            return Err("Payment URI is invalid.".to_owned());
        }
        previous = Some(position);
        let decoded = percent_decode(encoded)?;
        if percent_encode(&decoded) != encoded {
            return Err("Payment URI is invalid.".to_owned());
        }
        if key == "tx_amount" {
            require_xmr_amount(&decoded)?;
        } else {
            let maximum = if key == "recipient_name" { 80 } else { 120 };
            if decoded.trim() != decoded
                || decoded.is_empty()
                || decoded.chars().count() > maximum
                || decoded.chars().any(|character| {
                    let code = character as u32;
                    code <= 31 || (127..=159).contains(&code)
                })
            {
                return Err("Payment URI is invalid.".to_owned());
            }
        }
    }
    Ok(())
}

fn valid_monero_address(value: &str) -> bool {
    matches!(value.len(), 95 | 106)
        && value.bytes().all(|byte| {
            matches!(byte, b'1'..=b'9' | b'A'..=b'H' | b'J'..=b'N' | b'P'..=b'Z' | b'a'..=b'k' | b'm'..=b'z')
        })
}

fn require_xmr_amount(value: &str) -> Result<(), String> {
    let decimal = value.split_once('.');
    let (whole, fraction) = decimal.unwrap_or((value, ""));
    if whole.is_empty()
        || whole.len() > 20
        || !whole.bytes().all(|byte| byte.is_ascii_digit())
        || (decimal.is_some() && fraction.is_empty())
        || fraction.len() > 12
        || (!fraction.is_empty() && !fraction.bytes().all(|byte| byte.is_ascii_digit()))
    {
        return Err("Payment URI is invalid.".to_owned());
    }
    let whole = whole
        .parse::<u128>()
        .map_err(|_| "Payment URI is invalid.".to_owned())?;
    let fraction = if fraction.is_empty() {
        0
    } else {
        format!("{fraction:0<12}")
            .parse::<u128>()
            .map_err(|_| "Payment URI is invalid.".to_owned())?
    };
    let atomic = whole
        .checked_mul(1_000_000_000_000)
        .and_then(|whole| whole.checked_add(fraction))
        .ok_or_else(|| "Payment URI is invalid.".to_owned())?;
    (atomic > 0 && atomic <= MAX_MONERO_ATOMIC_AMOUNT)
        .then_some(())
        .ok_or_else(|| "Payment URI is invalid.".to_owned())
}

fn percent_decode(value: &str) -> Result<String, String> {
    let mut bytes = Vec::with_capacity(value.len());
    let input = value.as_bytes();
    let mut index = 0;
    while index < input.len() {
        if input[index] == b'%' {
            if index + 2 >= input.len() {
                return Err("Payment URI is invalid.".to_owned());
            }
            let high = hex(input[index + 1])?;
            let low = hex(input[index + 2])?;
            bytes.push((high << 4) | low);
            index += 3;
        } else {
            bytes.push(input[index]);
            index += 1;
        }
    }
    String::from_utf8(bytes).map_err(|_| "Payment URI is invalid.".to_owned())
}

fn hex(byte: u8) -> Result<u8, String> {
    match byte {
        b'0'..=b'9' => Ok(byte - b'0'),
        b'A'..=b'F' => Ok(byte - b'A' + 10),
        _ => Err("Payment URI is invalid.".to_owned()),
    }
}

fn percent_encode(value: &str) -> String {
    let mut encoded = String::new();
    for byte in value.as_bytes() {
        if byte.is_ascii_alphanumeric()
            || matches!(
                byte,
                b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')'
            )
        {
            encoded.push(*byte as char);
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

#[cfg(test)]
mod tests {
    use super::{require_canonical_payment_uri, valid_payment_request_id};

    #[test]
    fn canonical_payment_uri_matches_the_mobile_contract() {
        let address = "4".repeat(95);
        assert!(
            require_canonical_payment_uri(&format!("monero:{address}?tx_amount=0.001")).is_ok()
        );
        assert!(require_canonical_payment_uri(&format!("monero:{address}?tx_amount=0")).is_err());
        assert!(require_canonical_payment_uri(&format!("monero:{address}?unknown=value")).is_err());
        assert!(valid_payment_request_id("AbcdEF0123_-abcdEF0123"));
    }
}
