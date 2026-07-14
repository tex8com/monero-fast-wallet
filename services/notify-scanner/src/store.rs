use crate::model::{
    key_image_status_id, privacy_safe_detection_id, DetectionStatus, KeyImageStatusRecord,
    MatchedOutput, NotificationStatus, WatchRegistration,
};
use anyhow::{anyhow, Context, Result};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use chacha20poly1305::{
    aead::{Aead, KeyInit, OsRng},
    XChaCha20Poly1305, XNonce,
};
use rand_core::RngCore;
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    sync::RwLock,
};

pub trait WatchStore: Send + Sync {
    fn upsert(&self, registration: WatchRegistration) -> Result<WatchRegistration>;
    fn remove(&self, identity_id: &str) -> Result<Option<WatchRegistration>>;
    fn get(&self, identity_id: &str) -> Result<Option<WatchRegistration>>;
    fn list(&self) -> Result<Vec<WatchRegistration>>;
    fn upsert_match(&self, output: MatchedOutput) -> Result<MatchedOutput>;
    fn list_matches(&self, identity_id: &str) -> Result<Vec<MatchedOutput>>;
    fn upsert_key_image_status(&self, status: KeyImageStatusRecord)
        -> Result<KeyImageStatusRecord>;
    fn get_key_image_statuses(
        &self,
        identity_id: &str,
        key_images: &[String],
    ) -> Result<Vec<KeyImageStatusRecord>>;
}

#[derive(Default)]
pub struct InMemoryWatchStore {
    records: RwLock<BTreeMap<String, WatchRegistration>>,
    matches: RwLock<BTreeMap<String, MatchedOutput>>,
    key_image_statuses: RwLock<BTreeMap<String, KeyImageStatusRecord>>,
}

impl WatchStore for InMemoryWatchStore {
    fn upsert(&self, registration: WatchRegistration) -> Result<WatchRegistration> {
        let mut records = self.records.write().expect("watch store poisoned");
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
        self.key_image_statuses
            .write()
            .expect("watch store poisoned")
            .retain(|_, status| status.identity_id != identity_id);
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

    fn upsert_key_image_status(
        &self,
        status: KeyImageStatusRecord,
    ) -> Result<KeyImageStatusRecord> {
        let mut statuses = self
            .key_image_statuses
            .write()
            .expect("watch store poisoned");
        statuses.insert(
            key_image_status_id(&status.identity_id, &status.key_image),
            status.clone(),
        );
        Ok(status)
    }

    fn get_key_image_statuses(
        &self,
        identity_id: &str,
        key_images: &[String],
    ) -> Result<Vec<KeyImageStatusRecord>> {
        let statuses = self
            .key_image_statuses
            .read()
            .expect("watch store poisoned");
        Ok(key_images
            .iter()
            .filter_map(|key_image| statuses.get(&key_image_status_id(identity_id, key_image)))
            .cloned()
            .collect())
    }
}

pub struct EncryptedJsonFileStore {
    path: PathBuf,
    cipher: XChaCha20Poly1305,
    records: RwLock<BTreeMap<String, WatchRegistration>>,
    matches: RwLock<BTreeMap<String, MatchedOutput>>,
    key_image_statuses: RwLock<BTreeMap<String, KeyImageStatusRecord>>,
}

impl EncryptedJsonFileStore {
    pub fn open(path: impl Into<PathBuf>, key: [u8; 32]) -> Result<Self> {
        let path = path.into();
        let cipher = XChaCha20Poly1305::new((&key).into());
        let rewrite_existing = path.exists();
        let mut stored = if rewrite_existing {
            read_records(&path, &cipher)?
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
            key_image_statuses: RwLock::new(
                stored
                    .key_image_statuses
                    .into_iter()
                    .map(|status| {
                        (
                            key_image_status_id(&status.identity_id, &status.key_image),
                            status,
                        )
                    })
                    .collect(),
            ),
        };

        if rewrite_existing {
            let records = store.records.read().expect("watch store poisoned");
            let matches = store.matches.read().expect("watch store poisoned");
            let key_image_statuses = store
                .key_image_statuses
                .read()
                .expect("watch store poisoned");
            store.persist(&records, &matches, &key_image_statuses)?;
        }

        Ok(store)
    }

    fn persist(
        &self,
        records: &BTreeMap<String, WatchRegistration>,
        matches: &BTreeMap<String, MatchedOutput>,
        key_image_statuses: &BTreeMap<String, KeyImageStatusRecord>,
    ) -> Result<()> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)
                .with_context(|| format!("create watch db parent {}", parent.display()))?;
        }

        let plaintext = serde_json::to_vec(&StoredRecords {
            records: records.values().cloned().collect(),
            matches: matches.values().cloned().collect(),
            key_image_statuses: key_image_statuses.values().cloned().collect(),
        })?;
        let sealed = seal(&self.cipher, &plaintext)?;
        let serialized = serde_json::to_vec_pretty(&sealed)?;
        fs::write(&self.path, serialized)
            .with_context(|| format!("write watch db {}", self.path.display()))?;
        Ok(())
    }
}

impl WatchStore for EncryptedJsonFileStore {
    fn upsert(&self, registration: WatchRegistration) -> Result<WatchRegistration> {
        let mut records = self.records.write().expect("watch store poisoned");
        records.insert(registration.identity_id.clone(), registration.clone());
        let matches = self.matches.read().expect("watch store poisoned");
        let key_image_statuses = self
            .key_image_statuses
            .read()
            .expect("watch store poisoned");
        self.persist(&records, &matches, &key_image_statuses)?;
        Ok(registration)
    }

    fn remove(&self, identity_id: &str) -> Result<Option<WatchRegistration>> {
        let mut records = self.records.write().expect("watch store poisoned");
        let removed = records.remove(identity_id);
        let mut matches = self.matches.write().expect("watch store poisoned");
        matches.retain(|_, output| output.identity_id != identity_id);
        let mut key_image_statuses = self
            .key_image_statuses
            .write()
            .expect("watch store poisoned");
        key_image_statuses.retain(|_, status| status.identity_id != identity_id);
        self.persist(&records, &matches, &key_image_statuses)?;
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
        let key_image_statuses = self
            .key_image_statuses
            .read()
            .expect("watch store poisoned");
        let mut stored = output.clone();
        if let Some(existing) = matches.get(&output.id) {
            stored = merge_matched_output(existing, output);
        }
        matches.insert(stored.id.clone(), stored.clone());
        self.persist(&records, &matches, &key_image_statuses)?;
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

    fn upsert_key_image_status(
        &self,
        status: KeyImageStatusRecord,
    ) -> Result<KeyImageStatusRecord> {
        let records = self.records.read().expect("watch store poisoned");
        let matches = self.matches.read().expect("watch store poisoned");
        let mut key_image_statuses = self
            .key_image_statuses
            .write()
            .expect("watch store poisoned");
        key_image_statuses.insert(
            key_image_status_id(&status.identity_id, &status.key_image),
            status.clone(),
        );
        self.persist(&records, &matches, &key_image_statuses)?;
        Ok(status)
    }

    fn get_key_image_statuses(
        &self,
        identity_id: &str,
        key_images: &[String],
    ) -> Result<Vec<KeyImageStatusRecord>> {
        let statuses = self
            .key_image_statuses
            .read()
            .expect("watch store poisoned");
        Ok(key_images
            .iter()
            .filter_map(|key_image| statuses.get(&key_image_status_id(identity_id, key_image)))
            .cloned()
            .collect())
    }
}

fn merge_matched_output(existing: &MatchedOutput, incoming: MatchedOutput) -> MatchedOutput {
    let mut stored = incoming;
    stored.created_at_ms = existing.created_at_ms;

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

    if existing.detection_status == stored.detection_status
        && existing.notification_status != NotificationStatus::Pending
        && stored.notification_status == NotificationStatus::Pending
    {
        stored.notification_status = existing.notification_status.clone();
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

fn read_records(path: &Path, cipher: &XChaCha20Poly1305) -> Result<StoredRecords> {
    let value = fs::read(path).with_context(|| format!("read watch db {}", path.display()))?;
    let sealed: SealedFile = serde_json::from_slice(&value)?;
    let plaintext = open(cipher, &sealed)?;
    let stored: StoredRecords = serde_json::from_slice(&plaintext)?;
    Ok(stored)
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
    #[serde(default)]
    key_image_statuses: Vec<KeyImageStatusRecord>,
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
    use crate::model::{DetectionStatus, Network, NotificationStatus, SpentStatus};

    fn registration() -> WatchRegistration {
        WatchRegistration {
            identity_id: "fast-receive-0".to_owned(),
            address: "9".repeat(95),
            private_view_key: "b".repeat(64),
            network: Network::Stagenet,
            restore_height: 50,
            push_token: Some("push-token".to_owned()),
            device_id: None,
            created_at_ms: 1,
            updated_at_ms: 1,
            last_scanned_height: 49,
        }
    }

    fn matched_output() -> MatchedOutput {
        MatchedOutput {
            id: format!("fast-receive-0:{}:1", "1".repeat(64)),
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
    fn parses_hex_storage_key() {
        let key = parse_storage_key(&"11".repeat(32)).unwrap();
        assert_eq!(key, [0x11; 32]);
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
        store
            .upsert_key_image_status(KeyImageStatusRecord {
                identity_id: "fast-receive-0".to_owned(),
                key_image: "2".repeat(64),
                status: SpentStatus::Unspent,
                checked_height: 99,
                updated_at_ms: 3,
            })
            .unwrap();

        let bytes = fs::read(&path).unwrap();
        let raw = String::from_utf8_lossy(&bytes);
        assert!(!raw.contains(&view_key));
        assert!(!raw.contains("push-token"));
        assert!(!raw.contains(&"2".repeat(64)));

        let reopened = EncryptedJsonFileStore::open(&path, key).unwrap();
        let loaded = reopened.get("fast-receive-0").unwrap().unwrap();
        assert_eq!(loaded.private_view_key, view_key);
        let matches = reopened.list_matches("fast-receive-0").unwrap();
        assert_eq!(matches.len(), 1);
        assert!(matches[0].id.starts_with("evt_"));
        assert!(!matches[0].id.contains(&"1".repeat(64)));
        assert_eq!(
            reopened
                .get_key_image_statuses("fast-receive-0", &["2".repeat(64)])
                .unwrap()[0]
                .status,
            SpentStatus::Unspent
        );
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

        store
            .upsert_key_image_status(KeyImageStatusRecord {
                identity_id: "fast-receive-0".to_owned(),
                key_image: "2".repeat(64),
                status: SpentStatus::Spent,
                checked_height: 100,
                updated_at_ms: 11,
            })
            .unwrap();
        assert_eq!(
            store
                .get_key_image_statuses("fast-receive-0", &["2".repeat(64)])
                .unwrap()[0]
                .status,
            SpentStatus::Spent
        );

        store.remove("fast-receive-0").unwrap();
        assert!(store.list_matches("fast-receive-0").unwrap().is_empty());
        assert!(store
            .get_key_image_statuses("fast-receive-0", &["2".repeat(64)])
            .unwrap()
            .is_empty());
    }
}
