use crate::{Job, JobState, Status, Submission};
use anyhow::{ensure, Result};
use chacha20poly1305::{
    aead::{Aead, KeyInit, Payload},
    XChaCha20Poly1305, XNonce,
};
use fs2::FileExt;
use rand::{rngs::OsRng, RngCore};
use rusqlite::{params, Connection, OptionalExtension};
use std::path::Path;
use subtle::ConstantTimeEq;
use zeroize::Zeroizing;

pub struct Store {
    db: Connection,
    cipher: XChaCha20Poly1305,
    max_jobs: usize,
    _lock: std::fs::File,
}

impl Store {
    pub fn open(path: &Path, key: [u8; 32], max_jobs: usize) -> Result<Self> {
        let key = Zeroizing::new(key);
        let lock = std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(path.with_extension("lock"))?;
        lock.try_lock_exclusive()?;
        let db = Connection::open(path)?;
        db.execute_batch(
            "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
          CREATE TABLE IF NOT EXISTS jobs (
            id TEXT PRIMARY KEY, auth BLOB NOT NULL, payload BLOB NOT NULL,
            claim TEXT UNIQUE NOT NULL, commit_id TEXT UNIQUE NOT NULL,
            status TEXT NOT NULL, terminal INTEGER NOT NULL DEFAULT 0,
            notified INTEGER NOT NULL DEFAULT 0
          );",
        )?;
        Ok(Self {
            db,
            cipher: XChaCha20Poly1305::new_from_slice(key.as_ref())
                .map_err(|_| anyhow::anyhow!("invalid storage key"))?,
            max_jobs,
            _lock: lock,
        })
    }

    pub fn insert(
        &mut self,
        id: &str,
        auth: [u8; 32],
        input: Submission,
        now: u64,
    ) -> Result<Status> {
        let exists: bool =
            self.db
                .query_row("SELECT EXISTS(SELECT 1 FROM jobs WHERE id=?1)", [id], |r| {
                    r.get(0)
                })?;
        if exists {
            let job = self.authorized(id, auth)?;
            ensure!(job.submission == input, "immutable job differs");
            return Ok(job.status);
        }
        let count: usize = self
            .db
            .query_row("SELECT count(*) FROM jobs", [], |r| r.get(0))?;
        ensure!(count < self.max_jobs, "queue capacity reached");
        let active: usize =
            self.db
                .query_row("SELECT count(*) FROM jobs WHERE terminal=0", [], |r| {
                    r.get(0)
                })?;
        ensure!(active < 128, "active queue capacity reached");
        let status = Status {
            job_id: id.to_owned(),
            claim_txid: input.claim_txid.clone(),
            state: JobState::Waiting,
            created_at: now,
            checked_at: None,
            commit_height: None,
            chain_height: None,
        };
        let plaintext = Zeroizing::new(serde_json::to_vec(&input)?);
        let mut nonce = [0; 24];
        OsRng.fill_bytes(&mut nonce);
        let mut sealed = nonce.to_vec();
        sealed.extend(
            self.cipher
                .encrypt(
                    XNonce::from_slice(&nonce),
                    Payload {
                        msg: &plaintext,
                        aad: id.as_bytes(),
                    },
                )
                .map_err(|_| anyhow::anyhow!("encryption failed"))?,
        );
        // UNIQUE commit prevents duplicate scheduling under a different job id.
        self.db.execute(
            "INSERT INTO jobs(id,auth,payload,claim,commit_id,status) VALUES(?1,?2,?3,?4,?5,?6)",
            params![
                id,
                auth,
                sealed,
                input.claim_txid,
                input.commit_txid,
                serde_json::to_string(&status)?
            ],
        )?;
        Ok(status)
    }

    pub fn authorized(&self, id: &str, auth: [u8; 32]) -> Result<Job> {
        let expected: Option<Vec<u8>> = self
            .db
            .query_row("SELECT auth FROM jobs WHERE id=?1", [id], |r| r.get(0))
            .optional()?;
        ensure!(
            expected
                .as_deref()
                .map(|v| bool::from(v.ct_eq(&auth)))
                .unwrap_or(false),
            "not found"
        );
        self.load(id)
    }

    pub(crate) fn load(&self, id: &str) -> Result<Job> {
        let (sealed, status): (Vec<u8>, String) =
            self.db
                .query_row("SELECT payload,status FROM jobs WHERE id=?1", [id], |r| {
                    Ok((r.get(0)?, r.get(1)?))
                })?;
        ensure!(sealed.len() >= 24, "invalid ciphertext");
        let plaintext = Zeroizing::new(
            self.cipher
                .decrypt(
                    XNonce::from_slice(&sealed[..24]),
                    Payload {
                        msg: &sealed[24..],
                        aad: id.as_bytes(),
                    },
                )
                .map_err(|_| anyhow::anyhow!("invalid storage key or ciphertext"))?,
        );
        Ok(Job {
            submission: serde_json::from_slice(&plaintext)?,
            status: serde_json::from_str(&status)?,
        })
    }

    pub fn update(&mut self, status: &Status) -> Result<()> {
        self.db.execute(
            "UPDATE jobs SET status=?2, terminal=?3 WHERE id=?1",
            params![
                status.job_id,
                serde_json::to_string(status)?,
                status.state.terminal()
            ],
        )?;
        Ok(())
    }

    pub fn pending(&self) -> Result<Vec<Job>> {
        self.select("SELECT id FROM jobs WHERE terminal=0 ORDER BY rowid")
    }
    pub fn notifications(&self) -> Result<Vec<Job>> {
        self.select("SELECT id FROM jobs WHERE terminal=1 AND notified=0 ORDER BY rowid")
    }
    fn select(&self, query: &str) -> Result<Vec<Job>> {
        let mut statement = self.db.prepare(query)?;
        let ids = statement
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        ids.iter().map(|id| self.load(id)).collect()
    }
    pub fn mark_notified(&mut self, id: &str) -> Result<()> {
        self.db
            .execute("UPDATE jobs SET notified=1 WHERE id=?1", [id])?;
        Ok(())
    }
}
