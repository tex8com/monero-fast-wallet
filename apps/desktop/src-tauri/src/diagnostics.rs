use serde_json::{Map, Value};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager};

const FILE_NAME: &str = "diagnostics.jsonl";
const PREVIOUS_FILE_NAME: &str = "diagnostics.previous.jsonl";
const MAX_BYTES: u64 = 512 * 1024;

/// Append a privacy-safe operational event.  This is deliberately not a
/// wallet audit trail: callers must never include addresses, paths, seeds,
/// passwords, device tokens, transaction data, or other identifying values.
/// The file is small, rotated, and lets support diagnose node/sync lifecycle
/// failures even when a packaged macOS app has no attached terminal.
pub fn record(app: &AppHandle, event: &str, fields: &[(&str, String)]) {
    let result = (|| -> Result<(), std::io::Error> {
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

        let mut field_values = Map::new();
        for (name, value) in fields {
            field_values.insert((*name).to_owned(), Value::String(value.clone()));
        }
        let mut entry = Map::new();
        entry.insert("timestamp".to_owned(), Value::from(now()));
        entry.insert("event".to_owned(), Value::String(event.to_owned()));
        entry.insert("fields".to_owned(), Value::Object(field_values));
        let encoded =
            serde_json::to_string(&Value::Object(entry)).map_err(std::io::Error::other)?;
        let mut file = OpenOptions::new().create(true).append(true).open(path)?;
        writeln!(file, "{encoded}")?;
        file.sync_data()
    })();

    if let Err(error) = result {
        eprintln!("MONERO_DESKTOP_DIAGNOSTICS write-failed event={event} error={error}");
    }
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
