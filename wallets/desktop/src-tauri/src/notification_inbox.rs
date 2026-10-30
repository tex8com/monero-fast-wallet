//! Durable consumption of opaque background-agent receipts.

use std::{fs, path::Path};

pub fn persist_then_remove(
    path: &Path,
    persist: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    persist()?;
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("Notification receipt could not be consumed.".to_owned()),
    }
}

#[cfg(any(target_os = "windows", target_os = "linux", test))]
pub fn received_timestamp(raw: &str, observed_at: u64) -> u64 {
    raw.parse::<u64>()
        .ok()
        .filter(|received| *received > 0 && *received <= observed_at.saturating_add(5))
        .unwrap_or(observed_at)
}

/// Finish the durable replacement before an inbox receipt may be removed.
/// The caller has already synced and closed the new file.
#[cfg(any(target_os = "windows", target_os = "linux", test))]
pub fn commit_replacement(temporary: &Path, destination: &Path) -> std::io::Result<()> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn MoveFileExW(from: *const u16, to: *const u16, flags: u32) -> i32;
        }
        let from: Vec<u16> = temporary.as_os_str().encode_wide().chain(Some(0)).collect();
        let to: Vec<u16> = destination
            .as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect();
        // MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH.
        if unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), 0x1 | 0x8) } == 0 {
            return Err(std::io::Error::last_os_error());
        }
    }
    #[cfg(not(windows))]
    fs::rename(temporary, destination)?;
    #[cfg(unix)]
    fs::File::open(destination.parent().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "Missing notification directory",
        )
    })?)?
    .sync_all()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);

    fn receipt() -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!(
            "mfw-inbox-test-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed),
        ));
        fs::write(&path, b"opaque-event").unwrap();
        path
    }

    #[test]
    fn failed_persistence_retains_receipt_for_retry() {
        let path = receipt();
        assert!(persist_then_remove(&path, || Err("synthetic disk error".to_owned())).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"opaque-event");
        persist_then_remove(&path, || Ok(())).unwrap();
        assert!(!path.exists());
    }

    #[test]
    fn original_receipt_exists_until_persistence_finishes() {
        let path = receipt();
        persist_then_remove(&path, || {
            assert_eq!(fs::read(&path).unwrap(), b"opaque-event");
            Ok(())
        })
        .unwrap();
        assert!(!path.exists());
    }

    #[test]
    fn delayed_wallet_open_keeps_actual_background_receipt_time() {
        assert_eq!(received_timestamp("1000", 9000), 1000);
        for raw in ["", "0", "invalid", "99999999999999999999999", "9010"] {
            assert_eq!(received_timestamp(raw, 9000), 9000);
        }
    }

    #[test]
    fn replacement_overwrites_existing_state_before_consumption() {
        let path = receipt();
        let temporary = path.with_extension("new");
        fs::write(&temporary, b"durable-new-state").unwrap();
        fs::OpenOptions::new()
            .write(true)
            .open(&temporary)
            .unwrap()
            .sync_all()
            .unwrap();
        commit_replacement(&temporary, &path).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"durable-new-state");
        assert!(!temporary.exists());
        fs::remove_file(path).unwrap();
    }
}
