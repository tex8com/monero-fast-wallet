//! Encrypted-at-rest Worker watch storage.

use crate::model::{
    privacy_safe_detection_id, DetectionStatus, MatchedOutput, NotificationStatus,
    WatchRegistration,
};
use anyhow::{anyhow, Context, Result};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use chacha20poly1305::{
    aead::{Aead, KeyInit, OsRng},
    XChaCha20Poly1305, XNonce,
};
use rand_core::RngCore;
use serde::de::IgnoredAny;
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::RwLock,
};
use zeroize::Zeroize;

#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

pub const MAX_WATCH_RECORDS: usize = 100_000;
pub const MAX_MATCHES_PER_WATCH: usize = 4_096;

pub trait WatchStore: Send + Sync {
    fn upsert(&self, registration: WatchRegistration) -> Result<WatchRegistration>;
    fn remove(&self, identity_id: &str) -> Result<Option<WatchRegistration>>;
    fn get(&self, identity_id: &str) -> Result<Option<WatchRegistration>>;
    fn list(&self) -> Result<Vec<WatchRegistration>>;
    fn upsert_match(&self, output: MatchedOutput) -> Result<MatchedOutput>;
    fn list_matches(&self, identity_id: &str) -> Result<Vec<MatchedOutput>>;
}

#[derive(Default)]
pub struct InMemoryWatchStore {
    records: RwLock<BTreeMap<String, WatchRegistration>>,
    matches: RwLock<BTreeMap<String, MatchedOutput>>,
}

impl WatchStore for InMemoryWatchStore {
    fn upsert(&self, registration: WatchRegistration) -> Result<WatchRegistration> {
        let mut records = self.records.write().expect("watch store poisoned");
        ensure_watch_capacity(&records, &registration.identity_id, MAX_WATCH_RECORDS)?;
        records.insert(registration.identity_id.clone(), registration.clone());
        Ok(registration)
    }

    fn remove(&self, identity_id: &str) -> Result<Option<WatchRegistration>> {
        let mut records = self.records.write().expect("watch store poisoned");
        let removed = records.remove(identity_id);
        self.matches
            .write()
            .expect("watch store poisoned")
            .retain(|_, output| output.identity_id != identity_id);
        Ok(removed)
    }

    fn get(&self, identity_id: &str) -> Result<Option<WatchRegistration>> {
        let records = self.records.read().expect("watch store poisoned");
        Ok(records.get(identity_id).cloned())
    }

    fn list(&self) -> Result<Vec<WatchRegistration>> {
        let records = self.records.read().expect("watch store poisoned");
        Ok(records.values().cloned().collect())
    }

    fn upsert_match(&self, output: MatchedOutput) -> Result<MatchedOutput> {
        let mut matches = self.matches.write().expect("watch store poisoned");
        let mut stored = output.clone();
        if let Some(existing) = matches.get(&output.id) {
            stored = merge_matched_output(existing, output);
        }
        matches.insert(stored.id.clone(), stored.clone());
        prune_matches_for_identity(&mut matches, &stored.identity_id, MAX_MATCHES_PER_WATCH);
        Ok(stored)
    }

    fn list_matches(&self, identity_id: &str) -> Result<Vec<MatchedOutput>> {
        let matches = self.matches.read().expect("watch store poisoned");
        Ok(matches
            .values()
            .filter(|output| output.identity_id == identity_id)
            .cloned()
            .collect())
    }
}

pub struct EncryptedJsonFileStore {
    path: PathBuf,
    cipher: XChaCha20Poly1305,
    records: RwLock<BTreeMap<String, WatchRegistration>>,
    matches: RwLock<BTreeMap<String, MatchedOutput>>,
}

impl EncryptedJsonFileStore {
    pub fn open(path: impl Into<PathBuf>, mut key: [u8; 32]) -> Result<Self> {
        let path = path.into();
        let cipher = XChaCha20Poly1305::new((&key).into());
        key.zeroize();
        let backup_path = backup_path(&path);
        let rewrite_existing = path.exists() || backup_path.exists();
        let mut stored = if path.exists() {
            read_records(&path, &cipher).or_else(|primary_error| {
                read_records(&backup_path, &cipher).with_context(|| {
                    format!("primary watch db could not be recovered ({primary_error:#})")
                })
            })?
        } else if backup_path.exists() {
            read_records(&backup_path, &cipher)?
        } else {
            StoredRecords::default()
        };
        for output in &mut stored.matches {
            output.id = privacy_safe_detection_id(&output.id);
        }

        let store = Self {
            path,
            cipher,
            records: RwLock::new(
                stored
                    .records
                    .into_iter()
                    .map(|record| (record.identity_id.clone(), record))
                    .collect(),
            ),
            matches: RwLock::new(
                stored
                    .matches
                    .into_iter()
                    .map(|output| (output.id.clone(), output))
                    .collect(),
            ),
        };

        if rewrite_existing {
            let records = store.records.read().expect("watch store poisoned");
            let matches = store.matches.read().expect("watch store poisoned");
            store.persist(&records, &matches)?;
        }

        Ok(store)
    }

    fn persist(
        &self,
        records: &BTreeMap<String, WatchRegistration>,
        matches: &BTreeMap<String, MatchedOutput>,
    ) -> Result<()> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)
                .with_context(|| format!("create watch db parent {}", parent.display()))?;
        }

        let mut plaintext = serde_json::to_vec(&StoredRecords {
            records: records.values().cloned().collect(),
            matches: matches.values().cloned().collect(),
        })?;
        let sealed_result = seal(&self.cipher, &plaintext);
        plaintext.zeroize();
        let sealed = sealed_result?;
        let serialized = serde_json::to_vec_pretty(&sealed)?;
        atomic_replace(&self.path, &serialized)?;
        Ok(())
    }
}

impl WatchStore for EncryptedJsonFileStore {
    fn upsert(&self, registration: WatchRegistration) -> Result<WatchRegistration> {
        let mut records = self.records.write().expect("watch store poisoned");
        ensure_watch_capacity(&records, &registration.identity_id, MAX_WATCH_RECORDS)?;
        records.insert(registration.identity_id.clone(), registration.clone());
        let matches = self.matches.read().expect("watch store poisoned");
        self.persist(&records, &matches)?;
        Ok(registration)
    }

    fn remove(&self, identity_id: &str) -> Result<Option<WatchRegistration>> {
        let mut records = self.records.write().expect("watch store poisoned");
        let removed = records.remove(identity_id);
        let mut matches = self.matches.write().expect("watch store poisoned");
        matches.retain(|_, output| output.identity_id != identity_id);
        // The first atomic replacement deliberately preserves the preceding
        // authenticated snapshot for crash recovery. After a revocation that
        // preceding snapshot can still contain the removed View Key. Commit
        // the already-deleted state a second time so both the primary and its
        // recovery snapshot enforce the revocation before it is acknowledged.
        self.persist(&records, &matches)?;
        self.persist(&records, &matches)?;
        Ok(removed)
    }

    fn get(&self, identity_id: &str) -> Result<Option<WatchRegistration>> {
        let records = self.records.read().expect("watch store poisoned");
        Ok(records.get(identity_id).cloned())
    }

    fn list(&self) -> Result<Vec<WatchRegistration>> {
        let records = self.records.read().expect("watch store poisoned");
        Ok(records.values().cloned().collect())
    }

    fn upsert_match(&self, output: MatchedOutput) -> Result<MatchedOutput> {
        let records = self.records.read().expect("watch store poisoned");
        let mut matches = self.matches.write().expect("watch store poisoned");
        let mut stored = output.clone();
        if let Some(existing) = matches.get(&output.id) {
            stored = merge_matched_output(existing, output);
        }
        matches.insert(stored.id.clone(), stored.clone());
        prune_matches_for_identity(&mut matches, &stored.identity_id, MAX_MATCHES_PER_WATCH);
        self.persist(&records, &matches)?;
        Ok(stored)
    }

    fn list_matches(&self, identity_id: &str) -> Result<Vec<MatchedOutput>> {
        let matches = self.matches.read().expect("watch store poisoned");
        Ok(matches
            .values()
            .filter(|output| output.identity_id == identity_id)
            .cloned()
            .collect())
    }
}

fn ensure_watch_capacity(
    records: &BTreeMap<String, WatchRegistration>,
    identity_id: &str,
    limit: usize,
) -> Result<()> {
    if !records.contains_key(identity_id) && records.len() >= limit {
        return Err(anyhow!("watch storage capacity reached"));
    }
    Ok(())
}

fn prune_matches_for_identity(
    matches: &mut BTreeMap<String, MatchedOutput>,
    identity_id: &str,
    limit: usize,
) {
    let mut ordered = matches
        .iter()
        .filter(|(_, output)| output.identity_id == identity_id)
        .map(|(id, output)| (output.updated_at_ms, id.clone()))
        .collect::<Vec<_>>();
    ordered.sort();
    let remove_count = ordered.len().saturating_sub(limit);
    for (_, id) in ordered.into_iter().take(remove_count) {
        matches.remove(&id);
    }
}

fn merge_matched_output(existing: &MatchedOutput, incoming: MatchedOutput) -> MatchedOutput {
    let mut stored = incoming;
    stored.created_at_ms = existing.created_at_ms;
    if stored.notification_group_id.is_empty() {
        stored.notification_group_id = existing.notification_group_id.clone();
    }

    if stored.mempool_first_seen_ms.is_none() {
        stored.mempool_first_seen_ms = existing.mempool_first_seen_ms;
    } else if let Some(existing_first) = existing.mempool_first_seen_ms {
        stored.mempool_first_seen_ms = stored
            .mempool_first_seen_ms
            .map(|incoming_first| incoming_first.min(existing_first));
    }

    if stored.mempool_last_seen_ms.is_none() {
        stored.mempool_last_seen_ms = existing.mempool_last_seen_ms;
    } else if let Some(existing_last) = existing.mempool_last_seen_ms {
        stored.mempool_last_seen_ms = stored
            .mempool_last_seen_ms
            .map(|incoming_last| incoming_last.max(existing_last));
    }

    if existing.detection_status == DetectionStatus::Confirmed
        && stored.detection_status != DetectionStatus::Reorged
    {
        stored.detection_status = DetectionStatus::Confirmed;
    }

    if stored.notification_status == NotificationStatus::Pending {
        let reactivated_after_invalid_detection = matches!(
            existing.detection_status,
            DetectionStatus::Dropped | DetectionStatus::Reorged
        ) && matches!(
            stored.detection_status,
            DetectionStatus::PendingMempool
                | DetectionStatus::Detected
                | DetectionStatus::Confirmed
        ) && existing.notification_status
            == NotificationStatus::Suppressed;

        if existing.notification_status != NotificationStatus::Pending
            && !reactivated_after_invalid_detection
        {
            stored.notification_status = existing.notification_status.clone();
        }
    }

    stored
}

pub fn parse_storage_key(value: &str) -> Result<[u8; 32]> {
    let trimmed = value.trim();
    let decoded = if trimmed.len() == 64 && trimmed.bytes().all(|b| b.is_ascii_hexdigit()) {
        hex::decode(trimmed)?
    } else {
        BASE64.decode(trimmed)?
    };

    decoded
        .try_into()
        .map_err(|_| anyhow!("storage key must decode to exactly 32 bytes"))
}

pub fn verify_storage_file(path: impl AsRef<Path>, mut key: [u8; 32]) -> Result<()> {
    let cipher = XChaCha20Poly1305::new((&key).into());
    key.zeroize();
    let mut plaintext = read_plaintext(path.as_ref(), &cipher)?;
    let validation = serde_json::from_slice::<IgnoredAny>(&plaintext)
        .context("validate decrypted watch db JSON");
    plaintext.zeroize();
    validation.map(|_| ())
}

pub fn rotate_storage_key(
    path: impl AsRef<Path>,
    mut old_key: [u8; 32],
    mut new_key: [u8; 32],
) -> Result<()> {
    let path = path.as_ref();
    if old_key == new_key {
        old_key.zeroize();
        new_key.zeroize();
        return Err(anyhow!("new storage key must differ from the old key"));
    }

    let old_cipher = XChaCha20Poly1305::new((&old_key).into());
    old_key.zeroize();
    let new_cipher = XChaCha20Poly1305::new((&new_key).into());
    new_key.zeroize();

    let backup = backup_path(path);
    let mut plaintext = if path.exists() {
        read_plaintext(path, &old_cipher).or_else(|primary_error| {
            read_plaintext(&backup, &old_cipher).with_context(|| {
                format!("primary watch db could not be recovered ({primary_error:#})")
            })
        })?
    } else {
        read_plaintext(&backup, &old_cipher)?
    };
    serde_json::from_slice::<IgnoredAny>(&plaintext)
        .context("validate decrypted watch db JSON before key rotation")?;

    let first_result = seal(&new_cipher, &plaintext)
        .and_then(|sealed| serde_json::to_vec_pretty(&sealed).map_err(Into::into));
    let second_result = seal(&new_cipher, &plaintext)
        .and_then(|sealed| serde_json::to_vec_pretty(&sealed).map_err(Into::into));
    plaintext.zeroize();
    let first = first_result?;
    let second = second_result?;

    // Two authenticated snapshots under the new key ensure that normal
    // corruption recovery keeps working immediately after a rotation.
    atomic_replace(path, &first)?;
    atomic_replace(path, &second)?;
    read_records(path, &new_cipher).context("verify rotated watch db")?;
    read_records(&backup, &new_cipher).context("verify rotated recovery snapshot")?;
    Ok(())
}

pub fn backup_storage_file(
    source: impl AsRef<Path>,
    destination: impl AsRef<Path>,
    key: [u8; 32],
) -> Result<()> {
    copy_verified_storage_file(source.as_ref(), destination.as_ref(), key, "backup")
}

pub fn restore_storage_file(
    source: impl AsRef<Path>,
    destination: impl AsRef<Path>,
    key: [u8; 32],
) -> Result<()> {
    copy_verified_storage_file(source.as_ref(), destination.as_ref(), key, "restore")
}

fn copy_verified_storage_file(
    source: &Path,
    destination: &Path,
    mut key: [u8; 32],
    operation: &str,
) -> Result<()> {
    let result = (|| {
        if source == destination {
            return Err(anyhow!("{operation} source and destination must differ"));
        }
        verify_storage_file(source, key)?;
        let contents =
            fs::read(source).with_context(|| format!("read storage {operation} source"))?;
        atomic_replace(destination, &contents)?;
        verify_storage_file(destination, key)
            .with_context(|| format!("verify storage {operation} destination"))
    })();
    key.zeroize();
    result
}

fn read_records(path: &Path, cipher: &XChaCha20Poly1305) -> Result<StoredRecords> {
    let mut plaintext = read_plaintext(path, cipher)?;
    let result = serde_json::from_slice(&plaintext).map_err(Into::into);
    plaintext.zeroize();
    result
}

fn read_plaintext(path: &Path, cipher: &XChaCha20Poly1305) -> Result<Vec<u8>> {
    let value = fs::read(path).with_context(|| format!("read watch db {}", path.display()))?;
    let sealed: SealedFile = serde_json::from_slice(&value)?;
    open(cipher, &sealed)
}

fn backup_path(path: &Path) -> PathBuf {
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("watch-db");
    path.with_file_name(format!("{file_name}.previous"))
}

fn atomic_replace(path: &Path, contents: &[u8]) -> Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| anyhow!("watch db path has no parent"))?;
    fs::create_dir_all(parent)
        .with_context(|| format!("create watch db parent {}", parent.display()))?;
    #[cfg(unix)]
    fs::set_permissions(parent, fs::Permissions::from_mode(0o700))
        .with_context(|| format!("secure watch db parent {}", parent.display()))?;

    let mut random = [0u8; 8];
    OsRng.fill_bytes(&mut random);
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("watch-db");
    let temporary_path = parent.join(format!(".{file_name}.tmp-{}", hex::encode(random)));

    let write_result = (|| -> Result<()> {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        options.mode(0o600);
        let mut temporary = options
            .open(&temporary_path)
            .with_context(|| format!("create temporary watch db {}", temporary_path.display()))?;
        temporary
            .write_all(contents)
            .with_context(|| format!("write temporary watch db {}", temporary_path.display()))?;
        temporary
            .sync_all()
            .with_context(|| format!("sync temporary watch db {}", temporary_path.display()))?;
        drop(temporary);

        let backup = backup_path(path);
        if path.exists() {
            if backup.exists() {
                fs::remove_file(&backup)
                    .with_context(|| format!("remove old watch db backup {}", backup.display()))?;
            }
            fs::rename(path, &backup)
                .with_context(|| format!("rotate watch db backup {}", backup.display()))?;
        }
        if let Err(error) = fs::rename(&temporary_path, path) {
            if backup.exists() && !path.exists() {
                let _ = fs::rename(&backup, path);
            }
            return Err(error).with_context(|| format!("install watch db {}", path.display()));
        }
        #[cfg(unix)]
        {
            fs::set_permissions(path, fs::Permissions::from_mode(0o600))
                .with_context(|| format!("secure watch db {}", path.display()))?;
            File::open(parent)
                .and_then(|directory| directory.sync_all())
                .with_context(|| format!("sync watch db parent {}", parent.display()))?;
        }
        Ok(())
    })();

    if temporary_path.exists() {
        let _ = fs::remove_file(&temporary_path);
    }
    write_result
}

fn seal(cipher: &XChaCha20Poly1305, plaintext: &[u8]) -> Result<SealedFile> {
    let mut nonce = [0u8; 24];
    OsRng.fill_bytes(&mut nonce);
    let ciphertext = cipher
        .encrypt(XNonce::from_slice(&nonce), plaintext)
        .map_err(|_| anyhow!("encrypt watch db"))?;
    Ok(SealedFile {
        version: 1,
        nonce: BASE64.encode(nonce),
        ciphertext: BASE64.encode(ciphertext),
    })
}

fn open(cipher: &XChaCha20Poly1305, sealed: &SealedFile) -> Result<Vec<u8>> {
    if sealed.version != 1 {
        return Err(anyhow!("unsupported watch db version {}", sealed.version));
    }
    let nonce = BASE64.decode(&sealed.nonce)?;
    let ciphertext = BASE64.decode(&sealed.ciphertext)?;
    cipher
        .decrypt(XNonce::from_slice(&nonce), ciphertext.as_ref())
        .map_err(|_| anyhow!("decrypt watch db"))
}

#[derive(Default, Deserialize, Serialize)]
struct StoredRecords {
    #[serde(default)]
    records: Vec<WatchRegistration>,
    #[serde(default)]
    matches: Vec<MatchedOutput>,
}

#[derive(Deserialize, Serialize)]
struct SealedFile {
    version: u32,
    nonce: String,
    ciphertext: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{DetectionStatus, Network, NotificationStatus};

    fn registration() -> WatchRegistration {
        WatchRegistration {
            identity_id: "fast-receive-0".to_owned(),
            address: "9".repeat(95),
            private_view_key: "b".repeat(64),
            management_token_hash: "0".repeat(64),
            network: Network::Stagenet,
            restore_height: 50,
            push_token: Some("push-token".to_owned()),
            device_id: None,
            worker_assignment_epoch: None,
            created_at_ms: 1,
            updated_at_ms: 1,
            last_scanned_height: 49,
            last_scanned_hash: None,
        }
    }

    fn matched_output() -> MatchedOutput {
        MatchedOutput {
            id: format!("fast-receive-0:{}:1", "1".repeat(64)),
            notification_group_id: "grp_test-payment".to_owned(),
            identity_id: "fast-receive-0".to_owned(),
            detection_status: DetectionStatus::Detected,
            notification_status: NotificationStatus::Pending,
            created_at_ms: 2,
            updated_at_ms: 2,
            mempool_first_seen_ms: None,
            mempool_last_seen_ms: None,
        }
    }

    #[test]
    fn sent_notification_remains_terminal_when_a_mempool_match_confirms() {
        let mut existing = matched_output();
        existing.detection_status = DetectionStatus::PendingMempool;
        existing.notification_status = NotificationStatus::Sent;
        existing.mempool_first_seen_ms = Some(2);
        existing.mempool_last_seen_ms = Some(3);

        let mut confirmed = matched_output();
        confirmed.detection_status = DetectionStatus::Confirmed;
        confirmed.notification_status = NotificationStatus::Pending;
        confirmed.updated_at_ms = 4;

        let merged = merge_matched_output(&existing, confirmed);

        assert_eq!(merged.detection_status, DetectionStatus::Confirmed);
        assert_eq!(merged.notification_status, NotificationStatus::Sent);
        assert_eq!(merged.mempool_first_seen_ms, Some(2));
        assert_eq!(merged.mempool_last_seen_ms, Some(3));
    }

    #[test]
    fn suppressed_drop_is_reactivated_if_the_payment_later_confirms() {
        let mut existing = matched_output();
        existing.detection_status = DetectionStatus::Dropped;
        existing.notification_status = NotificationStatus::Suppressed;

        let mut confirmed = matched_output();
        confirmed.detection_status = DetectionStatus::Confirmed;
        confirmed.notification_status = NotificationStatus::Pending;
        confirmed.updated_at_ms = 4;

        let merged = merge_matched_output(&existing, confirmed);

        assert_eq!(merged.detection_status, DetectionStatus::Confirmed);
        assert_eq!(merged.notification_status, NotificationStatus::Pending);
    }

    #[test]
    fn parses_hex_storage_key() {
        let key = parse_storage_key(&"11".repeat(32)).unwrap();
        assert_eq!(key, [0x11; 32]);
    }

    #[test]
    fn bounded_storage_rejects_new_watches_and_prunes_old_privacy_records() {
        let record = registration();
        let mut records = BTreeMap::new();
        records.insert(record.identity_id.clone(), record.clone());
        assert!(ensure_watch_capacity(&records, &record.identity_id, 1).is_ok());
        assert!(ensure_watch_capacity(&records, "fast-receive-new", 1).is_err());

        let mut matches = BTreeMap::new();
        for timestamp in 1..=3 {
            let mut output = matched_output();
            output.id = format!("evt_{timestamp}");
            output.updated_at_ms = timestamp;
            matches.insert(output.id.clone(), output);
        }
        prune_matches_for_identity(&mut matches, &record.identity_id, 2);
        assert_eq!(matches.len(), 2);
        assert!(!matches.contains_key("evt_1"));
    }

    #[test]
    fn encrypted_store_does_not_write_view_key_in_plaintext() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("watch.json.enc");
        let key = [7u8; 32];
        let store = EncryptedJsonFileStore::open(&path, key).unwrap();
        let record = registration();
        let view_key = record.private_view_key.clone();

        store.upsert(record).unwrap();
        store.upsert_match(matched_output()).unwrap();

        let bytes = fs::read(&path).unwrap();
        let raw = String::from_utf8_lossy(&bytes);
        assert!(!raw.contains(&view_key));
        assert!(!raw.contains("push-token"));

        let reopened = EncryptedJsonFileStore::open(&path, key).unwrap();
        let loaded = reopened.get("fast-receive-0").unwrap().unwrap();
        assert_eq!(loaded.private_view_key, view_key);
        let matches = reopened.list_matches("fast-receive-0").unwrap();
        assert_eq!(matches.len(), 1);
        assert!(matches[0].id.starts_with("evt_"));
        assert!(!matches[0].id.contains(&"1".repeat(64)));
    }

    #[test]
    fn encrypted_store_recovers_from_the_last_authenticated_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("watch.json.enc");
        let key = [8u8; 32];
        let store = EncryptedJsonFileStore::open(&path, key).unwrap();
        let first = registration();
        store.upsert(first.clone()).unwrap();

        let mut updated = first;
        updated.updated_at_ms = 2;
        store.upsert(updated).unwrap();
        assert!(backup_path(&path).exists());

        fs::write(&path, b"corrupted-current-snapshot").unwrap();
        let recovered = EncryptedJsonFileStore::open(&path, key).unwrap();
        assert_eq!(
            recovered
                .get("fast-receive-0")
                .unwrap()
                .unwrap()
                .updated_at_ms,
            1
        );
        assert!(read_records(&path, &recovered.cipher).is_ok());
    }

    #[test]
    fn encrypted_store_removal_purges_primary_and_recovery_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("watch.json.enc");
        let key = [10u8; 32];
        let store = EncryptedJsonFileStore::open(&path, key).unwrap();
        store.upsert(registration()).unwrap();

        assert!(store.remove("fast-receive-0").unwrap().is_some());
        for snapshot in [&path, &backup_path(&path)] {
            let stored = read_records(snapshot, &store.cipher).unwrap();
            assert!(stored.records.is_empty());
            assert!(stored.matches.is_empty());
        }
    }

    #[test]
    fn storage_key_rotation_reencrypts_primary_and_recovery_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("watch.json.enc");
        let old_key = [4u8; 32];
        let new_key = [5u8; 32];
        let store = EncryptedJsonFileStore::open(&path, old_key).unwrap();
        store.upsert(registration()).unwrap();

        rotate_storage_key(&path, old_key, new_key).unwrap();

        assert!(EncryptedJsonFileStore::open(&path, old_key).is_err());
        let reopened = EncryptedJsonFileStore::open(&path, new_key).unwrap();
        assert!(reopened.get("fast-receive-0").unwrap().is_some());
        verify_storage_file(&path, new_key).unwrap();
        verify_storage_file(backup_path(&path), new_key).unwrap();
    }

    #[test]
    fn authenticated_backup_and_restore_reject_the_wrong_key() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("watch.json.enc");
        let backup = dir.path().join("off-host-backup.json.enc");
        let restored = dir.path().join("restored").join("watch.json.enc");
        let key = [3u8; 32];
        let store = EncryptedJsonFileStore::open(&path, key).unwrap();
        store.upsert(registration()).unwrap();

        backup_storage_file(&path, &backup, key).unwrap();
        assert!(restore_storage_file(&backup, &restored, [2u8; 32]).is_err());
        restore_storage_file(&backup, &restored, key).unwrap();

        let reopened = EncryptedJsonFileStore::open(&restored, key).unwrap();
        assert!(reopened.get("fast-receive-0").unwrap().is_some());
    }

    #[cfg(unix)]
    #[test]
    fn encrypted_store_uses_private_file_and_directory_permissions() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let database_dir = dir.path().join("private");
        let path = database_dir.join("watch.json.enc");
        let store = EncryptedJsonFileStore::open(&path, [6u8; 32]).unwrap();
        store.upsert(registration()).unwrap();

        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            fs::metadata(&database_dir).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert!(fs::read_dir(&database_dir).unwrap().all(|entry| {
            !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .contains(".tmp-")
        }));
    }

    #[test]
    fn opening_a_legacy_store_removes_transaction_details() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("legacy-watch.json.enc");
        let key = [9u8; 32];
        let cipher = XChaCha20Poly1305::new((&key).into());
        let tx_id = "3".repeat(64);
        let legacy_id = format!("fast-receive-0:{tx_id}:4");
        let legacy_plaintext = serde_json::to_vec(&serde_json::json!({
            "records": [registration()],
            "matches": [{
                "id": legacy_id,
                "identity_id": "fast-receive-0",
                "detection_status": "confirmed",
                "notification_status": "pending",
                "created_at_ms": 2,
                "updated_at_ms": 3,
                "mempool_first_seen_ms": 2,
                "mempool_last_seen_ms": 3,
                "tx_id": tx_id,
                "output_index": 4,
                "amount_atomic": "50000000",
                "block_height": 100,
                "block_timestamp": 200
            }],
            "key_image_statuses": []
        }))
        .unwrap();
        let sealed = seal(&cipher, &legacy_plaintext).unwrap();
        fs::write(&path, serde_json::to_vec(&sealed).unwrap()).unwrap();

        let store = EncryptedJsonFileStore::open(&path, key).unwrap();
        let migrated = store.list_matches("fast-receive-0").unwrap();
        assert_eq!(migrated.len(), 1);
        assert!(migrated[0].id.starts_with("evt_"));

        let rewritten: SealedFile = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        let plaintext = String::from_utf8(open(&cipher, &rewritten).unwrap()).unwrap();
        for forbidden in [
            "tx_id",
            "output_index",
            "amount_atomic",
            "block_height",
            "block_timestamp",
            tx_id.as_str(),
        ] {
            assert!(!plaintext.contains(forbidden));
        }
    }

    #[test]
    fn match_inserts_are_idempotent_and_remove_cleans_identity_data() {
        let store = InMemoryWatchStore::default();
        store.upsert(registration()).unwrap();
        let output = matched_output();

        store.upsert_match(output.clone()).unwrap();
        let mut updated = output;
        updated.updated_at_ms = 10;
        updated.notification_status = NotificationStatus::Sent;
        let stored = store.upsert_match(updated).unwrap();

        assert_eq!(stored.created_at_ms, 2);
        assert_eq!(store.list_matches("fast-receive-0").unwrap().len(), 1);

        store.remove("fast-receive-0").unwrap();
        assert!(store.list_matches("fast-receive-0").unwrap().is_empty());
    }
}
