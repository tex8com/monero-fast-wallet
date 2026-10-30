use serde_json::{Map, Value};
use std::{
    collections::HashMap,
    fs::{self, OpenOptions},
    io::Write,
    sync::{Mutex, OnceLock},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager};

const FILE_NAME: &str = "diagnostics.jsonl";
const PREVIOUS_FILE_NAME: &str = "diagnostics.previous.jsonl";
const MAX_BYTES: u64 = 4 * 1024 * 1024;
static WRITER: Mutex<()> = Mutex::new(());
static LAST_SAMPLES: OnceLock<Mutex<HashMap<String, u64>>> = OnceLock::new();

/// Append a privacy-safe operational event.  This is deliberately not a
/// wallet audit trail: callers must never include addresses, paths, seeds,
/// passwords, device tokens, transaction data, or other identifying values.
/// The file is small, rotated, and lets support diagnose node/sync lifecycle
/// failures even when a packaged macOS app has no attached terminal.
pub fn record(app: &AppHandle, event: &str, fields: &[(&str, String)]) {
    let result = (|| -> Result<(), std::io::Error> {
        let _writer = WRITER
            .lock()
            .map_err(|_| std::io::Error::other("Diagnostic writer unavailable"))?;
        let directory = app
            .path()
            .app_data_dir()
            .map_err(std::io::Error::other)?
            .join("wallets");
        fs::create_dir_all(&directory)?;
        let path = directory.join(FILE_NAME);
        if fs::metadata(&path)
            .map(|metadata| metadata.len() > MAX_BYTES)
            .unwrap_or(false)
        {
            let previous = directory.join(PREVIOUS_FILE_NAME);
            let _ = fs::remove_file(&previous);
            fs::rename(&path, previous)?;
        }

        let field_values = safe_fields(fields);
        let mut entry = Map::new();
        entry.insert("timestamp".to_owned(), Value::from(now()));
        entry.insert(
            "timestampMs".to_owned(),
            Value::from(
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as u64,
            ),
        );
        entry.insert("processId".to_owned(), Value::from(std::process::id()));
        entry.insert("event".to_owned(), Value::String(event.to_owned()));
        entry.insert("fields".to_owned(), Value::Object(field_values));
        let encoded =
            serde_json::to_string(&Value::Object(entry)).map_err(std::io::Error::other)?;
        let mut file = OpenOptions::new().create(true).append(true).open(path)?;
        writeln!(file, "{encoded}")?;
        Ok(())
    })();

    if let Err(error) = result {
        eprintln!("MONERO_DESKTOP_DIAGNOSTICS write-failed event={event} error={error}");
    }
}

fn safe_fields(fields: &[(&str, String)]) -> Map<String, Value> {
    let mut safe = Map::new();
    for (name, value) in fields {
        if *name == "error" {
            safe.insert(
                "safeErrorCode".to_owned(),
                Value::String(safe_error_code(value).to_owned()),
            );
        } else if SAFE_FIELD_NAMES.contains(name) {
            safe.insert((*name).to_owned(), Value::String(value.clone()));
        }
    }
    safe
}

// Diagnostics are an operational state trace, never an audit trail. New
// fields fail closed until explicitly reviewed here. In particular wallet,
// registration, address, path, transaction and token identifiers are absent.
const SAFE_FIELD_NAMES: &[&str] = &[
    "targetHeight",
    "remainingBlocks",
    "stalledMs",
    "transport",
    "account",
    "app-lock-state-changed",
    "assignmentEpoch",
    "autoLockSeconds",
    "available",
    "daemonFallback",
    "delivery",
    "pushTestEventId",
    "scheduledAt",
    "deliverAfter",
    "elapsedMs",
    "endpointPresent",
    "event",
    "expired",
    "failed",
    "fastLoaded",
    "filesRetained",
    "flow",
    "grpcFallback",
    "hostingCheckId",
    "httpStatus",
    "kind",
    "leaseState",
    "legacy",
    "network",
    "nodeMode",
    "normalLoaded",
    "nsErrorDomain",
    "nsErrorCode",
    "opened",
    "operation",
    "outcome",
    "ownerCount",
    "phase",
    "preference",
    "providerGeneration",
    "providerStatus",
    "reason",
    "registrationDigest",
    "reopenAttempt",
    "result",
    "safeErrorCode",
    "seedBackupStatus",
    "sessionGeneration",
    "skipped",
    "stage",
    "syncPhase",
    "unavailable",
    "usesTls",
    "verified",
    "waitMs",
    "walletHeight",
    "worker",
];

/// Drain independently of the wallet mutex, including during blocking I/O.
pub fn start_native_drain(app: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_millis(500));
        let lines = crate::native_wallet::drain_diagnostics();
        if lines.is_empty() {
            continue;
        }
        let result = (|| -> std::io::Result<()> {
            let directory = app
                .path()
                .app_data_dir()
                .map_err(std::io::Error::other)?
                .join("wallets");
            fs::create_dir_all(&directory)?;
            let path = directory.join("native-diagnostics.log");
            if fs::metadata(&path)
                .map(|m| m.len() > 16 * 1024 * 1024)
                .unwrap_or(false)
            {
                fs::rename(&path, directory.join("native-diagnostics.previous.log"))?;
            }
            let mut file = OpenOptions::new().create(true).append(true).open(path)?;
            for line in lines {
                if line.starts_with("MONERO_WALLET_DIAGNOSTICS ")
                    && line.len() < 8192
                    && !line.contains('\n')
                {
                    writeln!(file, "processId={} {line}", std::process::id())?;
                }
            }
            Ok(())
        })();
        if result.is_err() {
            eprintln!("MONERO_DESKTOP_DIAGNOSTICS native-drain-write-failed");
        }
    });
}

fn safe_error_code(error: &str) -> &'static str {
    let normalized = error.to_ascii_lowercase();
    if normalized.contains("apns-authorization-error") {
        "apns-authorization-error"
    } else if normalized.contains("apns-authorization-denied") {
        "apns-authorization-denied"
    } else if normalized.contains("apns-registration-error") {
        "apns-registration-error"
    } else if normalized.contains("apns-registration-timeout") {
        "apns-registration-timeout"
    } else if normalized.contains("apns-registration-failed") {
        "apns-registration-failed"
    } else if normalized.contains("session-stale") || normalized.contains("no longer open") {
        "session-stale"
    } else if normalized.contains("timeout") || normalized.contains("timed out") {
        "timeout"
    } else if normalized.contains("permission") || normalized.contains("denied") {
        "permission"
    } else if normalized.contains("credential")
        || normalized.contains("password")
        || normalized.contains("secret")
    {
        "credential"
    } else if normalized.contains("ledger")
        || normalized.contains("bluetooth")
        || normalized.contains("hardware")
    {
        "hardware"
    } else if normalized.contains("node")
        || normalized.contains("network")
        || normalized.contains("grpc")
        || normalized.contains("rpc")
    {
        "network"
    } else if normalized.contains("storage") || normalized.contains("file") {
        "storage"
    } else {
        "internal"
    }
}

/// Keeps high-frequency successful UI polls useful without letting them evict
/// the failure or state-transition that support actually needs. `sample_key`
/// must be a fixed, non-sensitive operation name rather than a wallet value.
pub fn record_sampled(
    app: &AppHandle,
    event: &str,
    sample_key: &str,
    interval_seconds: u64,
    fields: &[(&str, String)],
) {
    let sampled_at = now();
    let samples = LAST_SAMPLES.get_or_init(|| Mutex::new(HashMap::new()));
    let should_record = samples
        .lock()
        .map(|mut last_samples| {
            let last = last_samples.get(sample_key).copied().unwrap_or(0);
            if sampled_at.saturating_sub(last) < interval_seconds {
                return false;
            }
            last_samples.insert(sample_key.to_owned(), sampled_at);
            true
        })
        .unwrap_or(true);
    if should_record {
        record(app, event, fields);
    }
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[cfg(test)]
mod tests {
    use super::safe_fields;

    #[test]
    fn diagnostics_drop_identifiers_and_reduce_errors_to_safe_codes() {
        let fields = safe_fields(&[
            ("identityId", "fast-mainnet-secret-alias".to_owned()),
            ("registrationId", "hardware-mainnet-private".to_owned()),
            (
                "error",
                "Ledger failed while opening a private wallet file".to_owned(),
            ),
            ("sessionGeneration", "3".to_owned()),
        ]);

        assert!(!fields.contains_key("identityId"));
        assert!(!fields.contains_key("registrationId"));
        assert!(!fields.contains_key("error"));
        assert_eq!(
            fields.get("safeErrorCode").and_then(|value| value.as_str()),
            Some("hardware")
        );
        assert_eq!(
            fields
                .get("sessionGeneration")
                .and_then(|value| value.as_str()),
            Some("3")
        );
    }

    #[test]
    fn apns_system_errors_remain_distinct_from_user_denial() {
        for code in ["apns-authorization-error", "apns-authorization-denied", "apns-registration-error", "apns-registration-timeout"] {
            let fields = safe_fields(&[("error", format!("{code}: macOS notification operation stopped"))]);
            assert_eq!(fields.get("safeErrorCode").and_then(|value| value.as_str()), Some(code));
        }
        let fields = safe_fields(&[("nsErrorDomain", "UNErrorDomain".to_owned()),
            ("nsErrorCode", "1".to_owned()), ("userInfo", "private content".to_owned()),
            ("deviceToken", "private token".to_owned())]);
        assert_eq!(fields.len(), 2);
        assert!(!fields.contains_key("userInfo"));
        assert!(!fields.contains_key("deviceToken"));
    }
}
