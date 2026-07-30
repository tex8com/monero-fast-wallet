//! Encrypted voluntary single-message report intake for Matrix E2EE chat.
//!
//! This Core never receives room history or Matrix recovery material. The
//! reporting endpoint may pass exactly one user-selected plaintext message
//! after showing it to the reporter and obtaining explicit confirmation.

use chacha20poly1305::{
    aead::{Aead, KeyInit, Payload},
    XChaCha20Poly1305, XNonce,
};
use rand::{rngs::OsRng, RngCore};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::{
    path::Path,
    sync::{Mutex, MutexGuard},
};
use thiserror::Error;
use zeroize::Zeroizing;

const REPORT_AAD: &[u8] = b"TEX8 Monero Enthusiast selected Matrix report.v1";
const MAX_ID_BYTES: usize = 255;
const MAX_MESSAGE_CHARACTERS: usize = 2_000;
const MAX_REASON_CHARACTERS: usize = 2_000;
const MAX_QUEUE_LIMIT: usize = 100;
const NOTICE_LEASE_MS: u64 = 5 * 60 * 1_000;

#[derive(Debug, Error)]
pub enum ChatReportError {
    #[error("chat report input is invalid: {0}")]
    Invalid(String),
    #[error("chat report was not found")]
    NotFound,
    #[error("chat report state conflicts with the requested action")]
    Conflict,
    #[error("chat report storage failed")]
    Storage,
    #[error("chat report evidence could not be protected")]
    Encryption,
}

pub type Result<T> = std::result::Result<T, ChatReportError>;

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SelectedChatMessage {
    pub room_id: String,
    pub event_id: String,
    pub sender_id: String,
    pub body: String,
    pub timestamp_ms: u64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct VoluntaryChatReport {
    pub selected_message: SelectedChatMessage,
    pub reason: String,
    #[serde(default)]
    pub illegal_content_notice: bool,
    /// The native client sets this only after rendering the exact evidence and
    /// receiving a fresh explicit confirmation.
    pub confirmed_exact_message: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatReportReceipt {
    pub case_id: String,
    pub status: String,
    pub created_at_ms: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChatReportDecision {
    Dismiss,
    WarnSender,
    SuspendSender,
}

impl ChatReportDecision {
    fn as_str(self) -> &'static str {
        match self {
            Self::Dismiss => "dismiss",
            Self::WarnSender => "warn_sender",
            Self::SuspendSender => "suspend_sender",
        }
    }

    fn parse(value: &str) -> Result<Self> {
        match value {
            "dismiss" => Ok(Self::Dismiss),
            "warn_sender" => Ok(Self::WarnSender),
            "suspend_sender" => Ok(Self::SuspendSender),
            _ => Err(ChatReportError::Storage),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatReportQueueCase {
    pub case_id: String,
    pub reporter_public_id: String,
    pub peer_public_id: String,
    pub status: String,
    pub created_at_ms: u64,
    pub acknowledged_at_ms: Option<u64>,
    pub acknowledged_by: Option<String>,
    pub illegal_content_notice: bool,
    pub selected_message: SelectedChatMessage,
    pub reason: String,
    pub appeal_reason: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatReportOutcome {
    pub case_id: String,
    pub status: String,
    pub decision: Option<ChatReportDecision>,
    pub decision_reason: Option<String>,
    pub resolved_at_ms: Option<u64>,
    pub appeal_pending: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ChatReportNotice {
    pub delivery_id: String,
    pub case_id: String,
    pub recipient_public_id: String,
}

pub struct ChatReportStore {
    connection: Mutex<Connection>,
    cipher: XChaCha20Poly1305,
}

impl ChatReportStore {
    pub fn open(path: impl AsRef<Path>, encryption_key: [u8; 32]) -> Result<Self> {
        let path = path.as_ref();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|_| ChatReportError::Storage)?;
        }
        Self::from_connection(
            Connection::open(path).map_err(|_| ChatReportError::Storage)?,
            encryption_key,
        )
    }

    pub fn in_memory(encryption_key: [u8; 32]) -> Result<Self> {
        Self::from_connection(
            Connection::open_in_memory().map_err(|_| ChatReportError::Storage)?,
            encryption_key,
        )
    }

    fn from_connection(connection: Connection, encryption_key: [u8; 32]) -> Result<Self> {
        connection
            .execute_batch(
                "PRAGMA trusted_schema = OFF;
                 PRAGMA foreign_keys = ON;
                 CREATE TABLE IF NOT EXISTS chat_report (
                   case_id TEXT PRIMARY KEY,
                   reporter_public_id TEXT NOT NULL,
                   peer_public_id TEXT NOT NULL,
                   event_fingerprint BLOB NOT NULL,
                   evidence_cipher BLOB NOT NULL,
                   illegal_content_notice INTEGER NOT NULL,
                   status TEXT NOT NULL,
                   created_at_ms INTEGER NOT NULL,
                   acknowledged_at_ms INTEGER,
                   acknowledged_by TEXT,
                   resolved_at_ms INTEGER,
                   decision TEXT,
                   decision_reason_cipher BLOB,
                   moderator_id TEXT,
                   UNIQUE(reporter_public_id, event_fingerprint)
                 ) STRICT;
                 CREATE TABLE IF NOT EXISTS chat_report_audit (
                   sequence INTEGER PRIMARY KEY AUTOINCREMENT,
                   event TEXT NOT NULL,
                   case_id TEXT NOT NULL,
                   actor_id TEXT NOT NULL,
                   created_at_ms INTEGER NOT NULL
                 ) STRICT;
                 CREATE TABLE IF NOT EXISTS chat_report_appeal (
                   case_id TEXT PRIMARY KEY,
                   affected_public_id TEXT NOT NULL,
                   reason_cipher BLOB NOT NULL,
                   created_at_ms INTEGER NOT NULL
                 ) STRICT;
                 CREATE TABLE IF NOT EXISTS chat_report_notice (
                   delivery_id TEXT PRIMARY KEY,
                   case_id TEXT NOT NULL,
                   recipient_public_id TEXT NOT NULL,
                   created_at_ms INTEGER NOT NULL,
                   lease_until_ms INTEGER,
                   attempts INTEGER NOT NULL DEFAULT 0,
                   delivered_at_ms INTEGER,
                   FOREIGN KEY(case_id) REFERENCES chat_report(case_id)
                 ) STRICT;",
            )
            .map_err(|_| ChatReportError::Storage)?;
        Ok(Self {
            connection: Mutex::new(connection),
            cipher: XChaCha20Poly1305::new((&encryption_key).into()),
        })
    }

    pub fn submit(
        &self,
        reporter_public_id: &str,
        peer_public_id: &str,
        report: &VoluntaryChatReport,
        now_ms: u64,
    ) -> Result<ChatReportReceipt> {
        validate_identifier("reporter", reporter_public_id)?;
        validate_identifier("peer", peer_public_id)?;
        if reporter_public_id == peer_public_id {
            return Err(ChatReportError::Invalid(
                "a peer report requires another identity".to_owned(),
            ));
        }
        validate_report(report)?;
        let evidence = serde_json::to_vec(report)
            .map_err(|_| ChatReportError::Invalid("chat report evidence is invalid".to_owned()))?;
        let evidence_cipher = seal(&self.cipher, &evidence)?;
        let event_fingerprint = event_fingerprint(
            reporter_public_id,
            &report.selected_message.room_id,
            &report.selected_message.event_id,
        );
        let case_id = random_id("chat_case");
        let mut connection = lock(&self.connection)?;
        let transaction = connection
            .transaction()
            .map_err(|_| ChatReportError::Storage)?;
        transaction
            .execute(
                "INSERT INTO chat_report(
                   case_id, reporter_public_id, peer_public_id, event_fingerprint,
                   evidence_cipher, illegal_content_notice, status, created_at_ms
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'open', ?7)",
                params![
                    case_id,
                    reporter_public_id,
                    peer_public_id,
                    event_fingerprint.as_slice(),
                    evidence_cipher,
                    i64::from(report.illegal_content_notice),
                    to_i64(now_ms)?
                ],
            )
            .map_err(|error| {
                if error.sqlite_error_code() == Some(rusqlite::ErrorCode::ConstraintViolation) {
                    ChatReportError::Conflict
                } else {
                    ChatReportError::Storage
                }
            })?;
        append_audit(
            &transaction,
            "chat_report_submitted",
            &case_id,
            reporter_public_id,
            now_ms,
        )?;
        transaction.commit().map_err(|_| ChatReportError::Storage)?;
        Ok(ChatReportReceipt {
            case_id,
            status: "open".to_owned(),
            created_at_ms: now_ms,
        })
    }

    pub fn queue(&self, limit: usize) -> Result<Vec<ChatReportQueueCase>> {
        if limit == 0 || limit > MAX_QUEUE_LIMIT {
            return Err(ChatReportError::Invalid(
                "queue limit must be between 1 and 100".to_owned(),
            ));
        }
        let connection = lock(&self.connection)?;
        let mut statement = connection
            .prepare(
                "SELECT r.case_id, r.reporter_public_id, r.peer_public_id, r.evidence_cipher,
                        r.illegal_content_notice, r.status, r.created_at_ms,
                        r.acknowledged_at_ms, r.acknowledged_by, a.reason_cipher
                 FROM chat_report r
                 LEFT JOIN chat_report_appeal a ON a.case_id = r.case_id
                 WHERE r.status IN ('open', 'appealed')
                 ORDER BY r.illegal_content_notice DESC, r.created_at_ms, r.case_id
                 LIMIT ?1",
            )
            .map_err(|_| ChatReportError::Storage)?;
        let rows = statement
            .query_map(
                [i64::try_from(limit).map_err(|_| ChatReportError::Storage)?],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, Vec<u8>>(3)?,
                        row.get::<_, i64>(4)?,
                        row.get::<_, String>(5)?,
                        row.get::<_, i64>(6)?,
                        row.get::<_, Option<i64>>(7)?,
                        row.get::<_, Option<String>>(8)?,
                        row.get::<_, Option<Vec<u8>>>(9)?,
                    ))
                },
            )
            .map_err(|_| ChatReportError::Storage)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(|_| ChatReportError::Storage)?;
        rows.into_iter()
            .map(
                |(
                    case_id,
                    reporter_public_id,
                    peer_public_id,
                    cipher,
                    illegal,
                    status,
                    created,
                    acknowledged,
                    acknowledged_by,
                    appeal_reason_cipher,
                )| {
                    let evidence: Zeroizing<Vec<u8>> = Zeroizing::new(open(&self.cipher, &cipher)?);
                    let report: VoluntaryChatReport = serde_json::from_slice(&evidence)
                        .map_err(|_| ChatReportError::Encryption)?;
                    Ok(ChatReportQueueCase {
                        case_id,
                        reporter_public_id,
                        peer_public_id,
                        status,
                        created_at_ms: from_i64(created)?,
                        acknowledged_at_ms: acknowledged.map(from_i64).transpose()?,
                        acknowledged_by,
                        illegal_content_notice: illegal == 1,
                        selected_message: report.selected_message,
                        reason: report.reason,
                        appeal_reason: appeal_reason_cipher
                            .map(|cipher| {
                                let plaintext = Zeroizing::new(open(&self.cipher, &cipher)?);
                                String::from_utf8(plaintext.to_vec())
                                    .map_err(|_| ChatReportError::Encryption)
                            })
                            .transpose()?,
                    })
                },
            )
            .collect()
    }

    pub fn acknowledge(&self, case_id: &str, moderator_id: &str, now_ms: u64) -> Result<()> {
        validate_identifier("case", case_id)?;
        validate_identifier("moderator", moderator_id)?;
        let connection = lock(&self.connection)?;
        let changed = connection
            .execute(
                "UPDATE chat_report
                 SET acknowledged_at_ms = COALESCE(acknowledged_at_ms, ?1),
                     acknowledged_by = COALESCE(acknowledged_by, ?2)
                 WHERE case_id = ?3 AND status IN ('open', 'appealed')",
                params![to_i64(now_ms)?, moderator_id, case_id],
            )
            .map_err(|_| ChatReportError::Storage)?;
        if changed != 1 {
            return Err(ChatReportError::NotFound);
        }
        append_audit(
            &connection,
            "chat_report_acknowledged",
            case_id,
            moderator_id,
            now_ms,
        )
    }

    pub fn decide(
        &self,
        case_id: &str,
        moderator_id: &str,
        decision: ChatReportDecision,
        reason: &str,
        now_ms: u64,
    ) -> Result<()> {
        validate_identifier("case", case_id)?;
        validate_identifier("moderator", moderator_id)?;
        validate_text("decision reason", reason, MAX_REASON_CHARACTERS)?;
        let reason_cipher = seal(&self.cipher, reason.as_bytes())?;
        let mut connection = lock(&self.connection)?;
        let transaction = connection
            .transaction()
            .map_err(|_| ChatReportError::Storage)?;
        let (reporter_public_id, peer_public_id) = transaction
            .query_row(
                "SELECT reporter_public_id, peer_public_id FROM chat_report
                 WHERE case_id = ?1 AND status IN ('open', 'appealed')",
                [case_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()
            .map_err(|_| ChatReportError::Storage)?
            .ok_or(ChatReportError::NotFound)?;
        let changed = transaction
            .execute(
                "UPDATE chat_report SET status = 'resolved', resolved_at_ms = ?1,
                    decision = ?2, decision_reason_cipher = ?3, moderator_id = ?4
                 WHERE case_id = ?5 AND status IN ('open', 'appealed')",
                params![
                    to_i64(now_ms)?,
                    decision.as_str(),
                    reason_cipher,
                    moderator_id,
                    case_id
                ],
            )
            .map_err(|_| ChatReportError::Storage)?;
        if changed != 1 {
            return Err(ChatReportError::NotFound);
        }
        append_audit(
            &transaction,
            "chat_report_decided",
            case_id,
            moderator_id,
            now_ms,
        )?;
        for recipient_public_id in [&reporter_public_id, &peer_public_id] {
            let delivery_id = random_id("chat_notice");
            transaction
                .execute(
                    "INSERT INTO chat_report_notice(
                       delivery_id, case_id, recipient_public_id, created_at_ms
                     ) VALUES (?1, ?2, ?3, ?4)",
                    params![delivery_id, case_id, recipient_public_id, to_i64(now_ms)?],
                )
                .map_err(|_| ChatReportError::Storage)?;
        }
        transaction.commit().map_err(|_| ChatReportError::Storage)
    }

    pub fn claim_notices(&self, now_ms: u64, limit: usize) -> Result<Vec<ChatReportNotice>> {
        if limit == 0 || limit > MAX_QUEUE_LIMIT {
            return Err(ChatReportError::Invalid(
                "notice limit must be between 1 and 100".to_owned(),
            ));
        }
        let mut connection = lock(&self.connection)?;
        let transaction = connection
            .transaction()
            .map_err(|_| ChatReportError::Storage)?;
        let rows = {
            let mut statement = transaction
                .prepare(
                    "SELECT delivery_id, case_id, recipient_public_id
                     FROM chat_report_notice
                     WHERE delivered_at_ms IS NULL
                       AND (lease_until_ms IS NULL OR lease_until_ms <= ?1)
                     ORDER BY created_at_ms, delivery_id
                     LIMIT ?2",
                )
                .map_err(|_| ChatReportError::Storage)?;
            let collected = statement
                .query_map(
                    params![
                        to_i64(now_ms)?,
                        i64::try_from(limit).map_err(|_| ChatReportError::Storage)?
                    ],
                    |row| {
                        Ok(ChatReportNotice {
                            delivery_id: row.get(0)?,
                            case_id: row.get(1)?,
                            recipient_public_id: row.get(2)?,
                        })
                    },
                )
                .map_err(|_| ChatReportError::Storage)?
                .collect::<std::result::Result<Vec<_>, _>>()
                .map_err(|_| ChatReportError::Storage)?;
            collected
        };
        let lease_until_ms = to_i64(now_ms.saturating_add(NOTICE_LEASE_MS))?;
        let mut claimed = Vec::with_capacity(rows.len());
        for notice in rows {
            let changed = transaction
                .execute(
                    "UPDATE chat_report_notice
                     SET lease_until_ms = ?1, attempts = attempts + 1
                     WHERE delivery_id = ?2 AND delivered_at_ms IS NULL
                       AND (lease_until_ms IS NULL OR lease_until_ms <= ?3)",
                    params![lease_until_ms, notice.delivery_id, to_i64(now_ms)?],
                )
                .map_err(|_| ChatReportError::Storage)?;
            if changed == 1 {
                claimed.push(notice);
            }
        }
        transaction.commit().map_err(|_| ChatReportError::Storage)?;
        Ok(claimed)
    }

    pub fn acknowledge_notice(&self, delivery_id: &str, actor_id: &str, now_ms: u64) -> Result<()> {
        validate_identifier("delivery", delivery_id)?;
        validate_identifier("delivery actor", actor_id)?;
        let connection = lock(&self.connection)?;
        let changed = connection
            .execute(
                "UPDATE chat_report_notice
                 SET delivered_at_ms = COALESCE(delivered_at_ms, ?1),
                     lease_until_ms = NULL
                 WHERE delivery_id = ?2",
                params![to_i64(now_ms)?, delivery_id],
            )
            .map_err(|_| ChatReportError::Storage)?;
        if changed != 1 {
            return Err(ChatReportError::NotFound);
        }
        append_audit(
            &connection,
            "chat_report_notice_acknowledged",
            delivery_id,
            actor_id,
            now_ms,
        )
    }

    pub fn appeal(
        &self,
        case_id: &str,
        affected_public_id: &str,
        reason: &str,
        now_ms: u64,
    ) -> Result<()> {
        validate_identifier("case", case_id)?;
        validate_identifier("affected user", affected_public_id)?;
        validate_text("appeal reason", reason, MAX_REASON_CHARACTERS)?;
        let reason_cipher = seal(&self.cipher, reason.as_bytes())?;
        let mut connection = lock(&self.connection)?;
        let transaction = connection
            .transaction()
            .map_err(|_| ChatReportError::Storage)?;
        let eligible = transaction
            .query_row(
                "SELECT 1 FROM chat_report
                 WHERE case_id = ?1 AND peer_public_id = ?2
                   AND status = 'resolved' AND decision = 'suspend_sender'",
                params![case_id, affected_public_id],
                |_| Ok(()),
            )
            .optional()
            .map_err(|_| ChatReportError::Storage)?
            .is_some();
        if !eligible {
            return Err(ChatReportError::NotFound);
        }
        transaction
            .execute(
                "INSERT INTO chat_report_appeal(
                   case_id, affected_public_id, reason_cipher, created_at_ms
                 ) VALUES (?1, ?2, ?3, ?4)",
                params![case_id, affected_public_id, reason_cipher, to_i64(now_ms)?],
            )
            .map_err(|error| {
                if error.sqlite_error_code() == Some(rusqlite::ErrorCode::ConstraintViolation) {
                    ChatReportError::Conflict
                } else {
                    ChatReportError::Storage
                }
            })?;
        let changed = transaction
            .execute(
                "UPDATE chat_report SET status = 'appealed'
                 WHERE case_id = ?1 AND status = 'resolved'",
                [case_id],
            )
            .map_err(|_| ChatReportError::Storage)?;
        if changed != 1 {
            return Err(ChatReportError::Conflict);
        }
        append_audit(
            &transaction,
            "chat_report_appealed",
            case_id,
            affected_public_id,
            now_ms,
        )?;
        transaction.commit().map_err(|_| ChatReportError::Storage)
    }

    pub fn outcome_for_actor(
        &self,
        case_id: &str,
        actor_public_id: &str,
    ) -> Result<ChatReportOutcome> {
        validate_identifier("case", case_id)?;
        validate_identifier("actor", actor_public_id)?;
        let connection = lock(&self.connection)?;
        let row = connection
            .query_row(
                "SELECT status, decision, decision_reason_cipher, resolved_at_ms
                 FROM chat_report
                 WHERE case_id = ?1
                   AND (reporter_public_id = ?2 OR peer_public_id = ?2)",
                params![case_id, actor_public_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, Option<Vec<u8>>>(2)?,
                        row.get::<_, Option<i64>>(3)?,
                    ))
                },
            )
            .optional()
            .map_err(|_| ChatReportError::Storage)?
            .ok_or(ChatReportError::NotFound)?;
        Ok(ChatReportOutcome {
            case_id: case_id.to_owned(),
            appeal_pending: row.0 == "appealed",
            status: row.0,
            decision: row
                .1
                .as_deref()
                .map(ChatReportDecision::parse)
                .transpose()?,
            decision_reason: row
                .2
                .map(|cipher| {
                    let plaintext = Zeroizing::new(open(&self.cipher, &cipher)?);
                    String::from_utf8(plaintext.to_vec()).map_err(|_| ChatReportError::Encryption)
                })
                .transpose()?,
            resolved_at_ms: row.3.map(from_i64).transpose()?,
        })
    }

    pub fn reported_peer(&self, case_id: &str) -> Result<String> {
        validate_identifier("case", case_id)?;
        lock(&self.connection)?
            .query_row(
                "SELECT peer_public_id FROM chat_report WHERE case_id = ?1",
                [case_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|_| ChatReportError::Storage)?
            .ok_or(ChatReportError::NotFound)
    }

    pub fn delete_reporter(&self, reporter_public_id: &str, now_ms: u64) -> Result<()> {
        validate_identifier("reporter", reporter_public_id)?;
        let redacted = random_id("deleted");
        let connection = lock(&self.connection)?;
        connection
            .execute(
                "DELETE FROM chat_report_notice WHERE recipient_public_id = ?1",
                [reporter_public_id],
            )
            .map_err(|_| ChatReportError::Storage)?;
        connection
            .execute(
                "UPDATE chat_report SET reporter_public_id = ?1
                 WHERE reporter_public_id = ?2",
                params![redacted, reporter_public_id],
            )
            .map_err(|_| ChatReportError::Storage)?;
        append_audit(
            &connection,
            "chat_report_reporter_deleted",
            &redacted,
            &redacted,
            now_ms,
        )
    }
}

fn validate_report(report: &VoluntaryChatReport) -> Result<()> {
    if !report.confirmed_exact_message {
        return Err(ChatReportError::Invalid(
            "the exact selected message was not confirmed".to_owned(),
        ));
    }
    validate_identifier("room", &report.selected_message.room_id)?;
    validate_identifier("event", &report.selected_message.event_id)?;
    validate_identifier("sender", &report.selected_message.sender_id)?;
    validate_text(
        "message",
        &report.selected_message.body,
        MAX_MESSAGE_CHARACTERS,
    )?;
    validate_text("report reason", &report.reason, MAX_REASON_CHARACTERS)
}

fn validate_identifier(label: &str, value: &str) -> Result<()> {
    if value.is_empty()
        || value.len() > MAX_ID_BYTES
        || value.chars().any(char::is_control)
        || value.chars().any(char::is_whitespace)
    {
        return Err(ChatReportError::Invalid(format!("{label} ID is invalid")));
    }
    Ok(())
}

fn validate_text(label: &str, value: &str, maximum: usize) -> Result<()> {
    if value.trim() != value
        || !(1..=maximum).contains(&value.chars().count())
        || value
            .chars()
            .any(|character| character.is_control() && !matches!(character, '\n' | '\t'))
    {
        return Err(ChatReportError::Invalid(format!("{label} is invalid")));
    }
    Ok(())
}

fn event_fingerprint(reporter: &str, room_id: &str, event_id: &str) -> [u8; 32] {
    use sha2::{Digest, Sha256};
    let mut hash = Sha256::new();
    hash.update(b"TEX8 selected Matrix report fingerprint.v1");
    hash.update((reporter.len() as u64).to_be_bytes());
    hash.update(reporter.as_bytes());
    hash.update((room_id.len() as u64).to_be_bytes());
    hash.update(room_id.as_bytes());
    hash.update((event_id.len() as u64).to_be_bytes());
    hash.update(event_id.as_bytes());
    hash.finalize().into()
}

fn seal(cipher: &XChaCha20Poly1305, plaintext: &[u8]) -> Result<Vec<u8>> {
    let mut nonce = [0_u8; 24];
    OsRng.fill_bytes(&mut nonce);
    let encrypted = cipher
        .encrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: plaintext,
                aad: REPORT_AAD,
            },
        )
        .map_err(|_| ChatReportError::Encryption)?;
    let mut envelope = Vec::with_capacity(nonce.len() + encrypted.len());
    envelope.extend_from_slice(&nonce);
    envelope.extend_from_slice(&encrypted);
    Ok(envelope)
}

fn open(cipher: &XChaCha20Poly1305, envelope: &[u8]) -> Result<Vec<u8>> {
    let (nonce, ciphertext) = envelope
        .split_at_checked(24)
        .ok_or(ChatReportError::Encryption)?;
    cipher
        .decrypt(
            XNonce::from_slice(nonce),
            Payload {
                msg: ciphertext,
                aad: REPORT_AAD,
            },
        )
        .map_err(|_| ChatReportError::Encryption)
}

fn append_audit(
    connection: &Connection,
    event: &str,
    case_id: &str,
    actor_id: &str,
    now_ms: u64,
) -> Result<()> {
    connection
        .execute(
            "INSERT INTO chat_report_audit(event, case_id, actor_id, created_at_ms)
             VALUES (?1, ?2, ?3, ?4)",
            params![event, case_id, actor_id, to_i64(now_ms)?],
        )
        .map(|_| ())
        .map_err(|_| ChatReportError::Storage)
}

fn random_id(prefix: &str) -> String {
    let mut bytes = [0_u8; 16];
    OsRng.fill_bytes(&mut bytes);
    format!(
        "{prefix}_{}",
        bytes
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    )
}

fn lock<T>(value: &Mutex<T>) -> Result<MutexGuard<'_, T>> {
    value.lock().map_err(|_| ChatReportError::Storage)
}

fn to_i64(value: u64) -> Result<i64> {
    i64::try_from(value).map_err(|_| ChatReportError::Invalid("time is invalid".to_owned()))
}

fn from_i64(value: i64) -> Result<u64> {
    u64::try_from(value).map_err(|_| ChatReportError::Storage)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn report(confirmed: bool) -> VoluntaryChatReport {
        VoluntaryChatReport {
            selected_message: SelectedChatMessage {
                room_id: "!room:matrix.example".to_owned(),
                event_id: "$event:matrix.example".to_owned(),
                sender_id: "@person_b:matrix.example".to_owned(),
                body: "This is the one selected message.".to_owned(),
                timestamp_ms: 42,
            },
            reason: "Threatening message".to_owned(),
            illegal_content_notice: true,
            confirmed_exact_message: confirmed,
        }
    }

    #[test]
    fn one_confirmed_message_is_encrypted_queued_and_decided() {
        let store = ChatReportStore::in_memory([7; 32]).expect("store");
        let receipt = store
            .submit("person_a", "person_b", &report(true), 1_000)
            .expect("submit");
        let queued = store.queue(10).expect("queue");
        assert_eq!(queued.len(), 1);
        assert_eq!(
            queued[0].selected_message.body,
            "This is the one selected message."
        );
        assert!(queued[0].illegal_content_notice);
        store
            .acknowledge(&receipt.case_id, "moderator_a", 1_001)
            .expect("ack");
        store
            .decide(
                &receipt.case_id,
                "moderator_a",
                ChatReportDecision::WarnSender,
                "Policy warning",
                1_002,
            )
            .expect("decide");
        assert!(store.queue(10).expect("queue after").is_empty());
        let notices = store.claim_notices(1_003, 10).expect("outcome notices");
        assert_eq!(notices.len(), 2);
        assert_eq!(
            notices
                .iter()
                .map(|notice| notice.recipient_public_id.as_str())
                .collect::<std::collections::BTreeSet<_>>(),
            std::collections::BTreeSet::from(["person_a", "person_b"])
        );
        for notice in notices {
            store
                .acknowledge_notice(&notice.delivery_id, "provider-worker", 1_004)
                .expect("acknowledge notice");
        }
        assert!(store
            .claim_notices(1_003 + NOTICE_LEASE_MS + 1, 10)
            .expect("no duplicate notices")
            .is_empty());
    }

    #[test]
    fn unconfirmed_or_duplicate_evidence_fails_closed() {
        let store = ChatReportStore::in_memory([9; 32]).expect("store");
        assert!(matches!(
            store.submit("person_a", "person_b", &report(false), 1_000),
            Err(ChatReportError::Invalid(_))
        ));
        store
            .submit("person_a", "person_b", &report(true), 1_000)
            .expect("first");
        assert!(matches!(
            store.submit("person_a", "person_b", &report(true), 1_001),
            Err(ChatReportError::Conflict)
        ));
    }

    #[test]
    fn report_storage_does_not_contain_plaintext_evidence() {
        let directory = tempfile::tempdir().expect("tempdir");
        let path = directory.path().join("reports.sqlite3");
        let store = ChatReportStore::open(&path, [3; 32]).expect("store");
        store
            .submit("person_a", "person_b", &report(true), 1_000)
            .expect("submit");
        drop(store);
        let raw = std::fs::read(path).expect("read database");
        assert!(!raw
            .windows(b"This is the one selected message.".len())
            .any(|window| window == b"This is the one selected message."));
        assert!(!raw
            .windows(b"Threatening message".len())
            .any(|window| window == b"Threatening message"));
    }

    #[test]
    fn suspended_sender_can_appeal_and_both_parties_can_read_the_outcome() {
        let store = ChatReportStore::in_memory([5; 32]).expect("store");
        let receipt = store
            .submit("person_a", "person_b", &report(true), 1_000)
            .expect("submit");
        store
            .decide(
                &receipt.case_id,
                "moderator_a",
                ChatReportDecision::SuspendSender,
                "Temporary Community suspension",
                1_001,
            )
            .expect("suspend decision");
        let affected = store
            .outcome_for_actor(&receipt.case_id, "person_b")
            .expect("affected outcome");
        assert_eq!(affected.decision, Some(ChatReportDecision::SuspendSender));
        assert_eq!(
            affected.decision_reason.as_deref(),
            Some("Temporary Community suspension")
        );
        store
            .appeal(
                &receipt.case_id,
                "person_b",
                "Please review the context.",
                1_002,
            )
            .expect("appeal");
        let queue = store.queue(10).expect("appeal queue");
        assert_eq!(
            queue[0].appeal_reason.as_deref(),
            Some("Please review the context.")
        );
        assert!(
            store
                .outcome_for_actor(&receipt.case_id, "person_a")
                .expect("reporter outcome")
                .appeal_pending
        );
        store
            .decide(
                &receipt.case_id,
                "moderator_b",
                ChatReportDecision::Dismiss,
                "Suspension reversed after appeal",
                1_003,
            )
            .expect("appeal decision");
        let resolved = store
            .outcome_for_actor(&receipt.case_id, "person_b")
            .expect("resolved outcome");
        assert_eq!(resolved.decision, Some(ChatReportDecision::Dismiss));
        assert!(!resolved.appeal_pending);
    }
}
