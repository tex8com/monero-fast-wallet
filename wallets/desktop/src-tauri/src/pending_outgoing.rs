use crate::app_vault;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashSet};

const VAULT_KEY: &str = "wallet.pending-outgoing.v1";
const REGISTRY_VERSION: u8 = 1;
const MAX_PENDING_PER_WALLET: usize = 32;
const MAX_PENDING_AGE_SECONDS: u64 = 7 * 24 * 60 * 60;

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct PendingOutgoing {
    hash: String,
    address: String,
    amount_atomic: String,
    fee_atomic: String,
    timestamp: u64,
    subaddress_account: u32,
    subaddress_indices: Vec<u32>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Registry {
    version: u8,
    wallets: BTreeMap<String, Vec<PendingOutgoing>>,
}

impl Default for Registry {
    fn default() -> Self {
        Self {
            version: REGISTRY_VERSION,
            wallets: BTreeMap::new(),
        }
    }
}

fn valid_atomic(value: &str) -> bool {
    !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit())
}

fn valid_hash(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn load() -> Result<Registry, String> {
    let Some(encoded) = app_vault::get_secret(VAULT_KEY)? else {
        return Ok(Registry::default());
    };
    let parsed: Registry = serde_json::from_str(&encoded)
        .map_err(|_| "Pending outgoing transaction storage is invalid.".to_owned())?;
    if parsed.version != REGISTRY_VERSION {
        return Err("Pending outgoing transaction storage has an unsupported version.".to_owned());
    }
    Ok(parsed)
}

fn store(registry: &Registry) -> Result<(), String> {
    if registry.wallets.is_empty() {
        return app_vault::delete_secret(VAULT_KEY);
    }
    let encoded = serde_json::to_string(registry)
        .map_err(|_| "Pending outgoing transactions could not be encoded.".to_owned())?;
    app_vault::put_secret(VAULT_KEY, &encoded)
}

pub fn record(
    registration_id: &str,
    committed: &Value,
    address: &str,
    prepared_amount_atomic: &str,
    prepared_fee_atomic: &str,
    timestamp: u64,
) -> Result<bool, String> {
    let tx_ids = committed
        .get("txIds")
        .and_then(Value::as_array)
        .ok_or_else(|| "The broadcast result has no transaction ID.".to_owned())?;
    if tx_ids.len() != 1 {
        return Ok(false);
    }
    let hash = tx_ids[0]
        .as_str()
        .map(str::to_lowercase)
        .filter(|value| valid_hash(value))
        .ok_or_else(|| "The broadcast transaction ID is invalid.".to_owned())?;
    let amount_atomic = committed
        .get("amountAtomic")
        .and_then(Value::as_str)
        .filter(|value| valid_atomic(value))
        .unwrap_or(prepared_amount_atomic)
        .to_owned();
    let fee_atomic = committed
        .get("feeAtomic")
        .and_then(Value::as_str)
        .filter(|value| valid_atomic(value))
        .unwrap_or(prepared_fee_atomic)
        .to_owned();
    if !valid_atomic(&amount_atomic) || !valid_atomic(&fee_atomic) {
        return Err("The broadcast amount or fee is invalid.".to_owned());
    }
    let subaddress_account = committed
        .get("subaddressAccounts")
        .and_then(Value::as_array)
        .and_then(|values| values.first())
        .and_then(Value::as_u64)
        .and_then(|value| u32::try_from(value).ok())
        .unwrap_or(0);
    let subaddress_indices = committed
        .get("subaddressIndices")
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_u64)
                .filter_map(|value| u32::try_from(value).ok())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    let transaction = PendingOutgoing {
        hash,
        address: address.to_owned(),
        amount_atomic,
        fee_atomic,
        timestamp,
        subaddress_account,
        subaddress_indices,
    };
    let mut registry = load()?;
    let values = registry
        .wallets
        .entry(registration_id.to_owned())
        .or_default();
    values.retain(|current| current.hash != transaction.hash);
    values.insert(0, transaction);
    values.truncate(MAX_PENDING_PER_WALLET);
    store(&registry)?;
    Ok(true)
}

pub fn merge(registration_id: &str, authoritative_json: &str, now: u64) -> Result<String, String> {
    let mut authoritative: Vec<Value> = serde_json::from_str(authoritative_json)
        .map_err(|_| "The native wallet transaction history was invalid.".to_owned())?;
    let hashes = authoritative
        .iter()
        .filter_map(|transaction| transaction.get("hash").and_then(Value::as_str))
        .map(str::to_lowercase)
        .collect::<HashSet<_>>();
    let mut registry = load()?;
    let before = registry.clone();
    let mut pending = registry.wallets.remove(registration_id).unwrap_or_default();
    pending.retain(|transaction| {
        !hashes.contains(&transaction.hash)
            && now.saturating_sub(transaction.timestamp) <= MAX_PENDING_AGE_SECONDS
    });
    pending.sort_by(|left, right| right.timestamp.cmp(&left.timestamp));
    pending.truncate(MAX_PENDING_PER_WALLET);
    authoritative.extend(pending.iter().map(to_native_transaction));
    authoritative.sort_by(|left, right| json_timestamp(right).cmp(&json_timestamp(left)));
    if !pending.is_empty() {
        registry.wallets.insert(registration_id.to_owned(), pending);
    }
    if registry != before {
        store(&registry)?;
    }
    serde_json::to_string(&authoritative)
        .map_err(|_| "The merged transaction history could not be encoded.".to_owned())
}

fn json_timestamp(value: &Value) -> u64 {
    value
        .get("timestamp")
        .and_then(|timestamp| {
            timestamp
                .as_u64()
                .or_else(|| timestamp.as_str()?.parse().ok())
        })
        .unwrap_or(0)
}

fn to_native_transaction(transaction: &PendingOutgoing) -> Value {
    json!({
        "hash": transaction.hash,
        "paymentId": "",
        "description": "",
        "label": "",
        "direction": "out",
        "pending": true,
        "failed": false,
        "coinbase": false,
        "amountAtomic": transaction.amount_atomic,
        "feeAtomic": transaction.fee_atomic,
        "blockHeight": "0",
        "confirmations": "0",
        "unlockTime": "0",
        "timestamp": transaction.timestamp.to_string(),
        "subaddressAccount": transaction.subaddress_account,
        "subaddressIndices": transaction.subaddress_indices,
        "transfers": [{
            "amountAtomic": transaction.amount_atomic,
            "address": transaction.address,
        }],
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_pending_shape_is_grey_outgoing_compatible() {
        let value = to_native_transaction(&PendingOutgoing {
            hash: "a".repeat(64),
            address: "recipient".to_owned(),
            amount_atomic: "1000000000".to_owned(),
            fee_atomic: "40000000".to_owned(),
            timestamp: 123,
            subaddress_account: 1,
            subaddress_indices: vec![2],
        });
        assert_eq!(value["direction"], "out");
        assert_eq!(value["pending"], true);
        assert_eq!(value["confirmations"], "0");
        assert_eq!(value["timestamp"], "123");
    }
}
