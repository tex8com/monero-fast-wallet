use crate::model::WatchRegistration;
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
}

#[derive(Default)]
pub struct InMemoryWatchStore {
    records: RwLock<BTreeMap<String, WatchRegistration>>,
}

impl WatchStore for InMemoryWatchStore {
    fn upsert(&self, registration: WatchRegistration) -> Result<WatchRegistration> {
        let mut records = self.records.write().expect("watch store poisoned");
        records.insert(registration.identity_id.clone(), registration.clone());
        Ok(registration)
    }

    fn remove(&self, identity_id: &str) -> Result<Option<WatchRegistration>> {
        let mut records = self.records.write().expect("watch store poisoned");
        Ok(records.remove(identity_id))
    }

    fn get(&self, identity_id: &str) -> Result<Option<WatchRegistration>> {
        let records = self.records.read().expect("watch store poisoned");
        Ok(records.get(identity_id).cloned())
    }

    fn list(&self) -> Result<Vec<WatchRegistration>> {
        let records = self.records.read().expect("watch store poisoned");
        Ok(records.values().cloned().collect())
    }
}

pub struct EncryptedJsonFileStore {
    path: PathBuf,
    cipher: XChaCha20Poly1305,
    records: RwLock<BTreeMap<String, WatchRegistration>>,
}

impl EncryptedJsonFileStore {
    pub fn open(path: impl Into<PathBuf>, key: [u8; 32]) -> Result<Self> {
        let path = path.into();
        let cipher = XChaCha20Poly1305::new((&key).into());
        let records = if path.exists() {
            read_records(&path, &cipher)?
        } else {
            BTreeMap::new()
        };

        Ok(Self {
            path,
            cipher,
            records: RwLock::new(records),
        })
    }

    fn persist_locked(&self, records: &BTreeMap<String, WatchRegistration>) -> Result<()> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)
                .with_context(|| format!("create watch db parent {}", parent.display()))?;
        }

        let plaintext = serde_json::to_vec(&StoredRecords {
            records: records.values().cloned().collect(),
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
        self.persist_locked(&records)?;
        Ok(registration)
    }

    fn remove(&self, identity_id: &str) -> Result<Option<WatchRegistration>> {
        let mut records = self.records.write().expect("watch store poisoned");
        let removed = records.remove(identity_id);
        self.persist_locked(&records)?;
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

fn read_records(
    path: &Path,
    cipher: &XChaCha20Poly1305,
) -> Result<BTreeMap<String, WatchRegistration>> {
    let value = fs::read(path).with_context(|| format!("read watch db {}", path.display()))?;
    let sealed: SealedFile = serde_json::from_slice(&value)?;
    let plaintext = open(cipher, &sealed)?;
    let stored: StoredRecords = serde_json::from_slice(&plaintext)?;
    Ok(stored
        .records
        .into_iter()
        .map(|record| (record.identity_id.clone(), record))
        .collect())
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

#[derive(Deserialize, Serialize)]
struct StoredRecords {
    records: Vec<WatchRegistration>,
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
    use crate::model::Network;

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

        let bytes = fs::read(&path).unwrap();
        let raw = String::from_utf8_lossy(&bytes);
        assert!(!raw.contains(&view_key));
        assert!(!raw.contains("push-token"));

        let reopened = EncryptedJsonFileStore::open(&path, key).unwrap();
        let loaded = reopened.get("fast-receive-0").unwrap().unwrap();
        assert_eq!(loaded.private_view_key, view_key);
    }
}
