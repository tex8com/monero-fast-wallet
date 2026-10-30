//! Serialize complete Ledger workflows, not just individual FFI calls.
use serde::Serialize;
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

static OPERATION: Mutex<()> = Mutex::new(());

pub fn acquire() -> Result<MutexGuard<'static, ()>, String> {
    OPERATION.try_lock().map_err(|_| {
        "A Ledger operation is already running. Wait for it to finish before trying again."
            .to_owned()
    })
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress<'a> {
    stage: &'a str,
    height: u64,
    target_height: u64,
    elapsed_ms: u128,
    stalled_ms: u128,
}

pub fn report(
    app: &AppHandle,
    stage: &str,
    height: u64,
    target: u64,
    elapsed: Duration,
    stalled: Duration,
) {
    let _ = app.emit(
        "ledger-operation-progress",
        Progress {
            stage,
            height,
            target_height: target,
            elapsed_ms: elapsed.as_millis(),
            stalled_ms: stalled.as_millis(),
        },
    );
    crate::diagnostics::record_sampled(
        app,
        "ledger.operation-progress",
        stage,
        5,
        &[
            ("stage", stage.to_owned()),
            ("walletHeight", height.to_string()),
            ("targetHeight", target.to_string()),
            ("remainingBlocks", target.saturating_sub(height).to_string()),
            ("elapsedMs", elapsed.as_millis().to_string()),
            ("stalledMs", stalled.as_millis().to_string()),
        ],
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn overlapping_operations_fail_without_stopping_the_first() {
        let first = acquire().unwrap();
        assert!(acquire().is_err());
        drop(first);
        assert!(acquire().is_ok());
    }
}
