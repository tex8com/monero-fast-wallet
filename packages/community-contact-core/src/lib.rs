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

const MAX_ID_BYTES: usize = 128;
const MAX_MATRIX_ID_BYTES: usize = 255;
const MATRIX_AAD: &[u8] = b"TEX8 Monero Enthusiast Matrix identity.v1";

#[derive(Debug, Error)]
pub enum ContactError {
    #[error("contact input is invalid: {0}")]
    Invalid(String),
    #[error("contact record was not found")]
    NotFound,
    #[error("contact action is not allowed")]
    Unauthorized,
    #[error("contact state conflicts with the requested action")]
    Conflict,
    #[error("contact storage failed: {0}")]
    Storage(String),
    #[error("contact secret could not be protected")]
    Encryption,
}

pub type Result<T> = std::result::Result<T, ContactError>;

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContactStatus {
    Pending,
    Accepted,
    Declined,
    Blocked,
}

impl ContactStatus {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Accepted => "accepted",
            Self::Declined => "declined",
            Self::Blocked => "blocked",
        }
    }

    fn parse(value: &str) -> Result<Self> {
        match value {
            "pending" => Ok(Self::Pending),
            "accepted" => Ok(Self::Accepted),
            "declined" => Ok(Self::Declined),
            "blocked" => Ok(Self::Blocked),
            _ => Err(ContactError::Storage(
                "stored contact status is invalid".to_owned(),
            )),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContactRequest {
    pub request_id: String,
    pub requester_id: String,
    pub recipient_id: String,
    pub status: ContactStatus,
    pub created_at_ms: u64,
    pub responded_at_ms: Option<u64>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcceptedContact {
    pub peer_id: String,
    pub matrix_user_id: String,
}

pub struct ContactStore {
    connection: Mutex<Connection>,
    key: Zeroizing<[u8; 32]>,
}

impl ContactStore {
    pub fn open(path: impl AsRef<Path>, key: [u8; 32]) -> Result<Self> {
        let path = path.as_ref();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| ContactError::Storage(error.to_string()))?;
        }
        Self::from_connection(
            Connection::open(path).map_err(|error| ContactError::Storage(error.to_string()))?,
            key,
        )
    }

    pub fn in_memory(key: [u8; 32]) -> Result<Self> {
        Self::from_connection(
            Connection::open_in_memory()
                .map_err(|error| ContactError::Storage(error.to_string()))?,
            key,
        )
    }

    fn from_connection(connection: Connection, key: [u8; 32]) -> Result<Self> {
        connection
            .execute_batch(
                "PRAGMA trusted_schema = OFF;
                 PRAGMA foreign_keys = ON;
                 CREATE TABLE IF NOT EXISTS matrix_identity (
                   owner_id TEXT PRIMARY KEY,
                   matrix_id_cipher BLOB NOT NULL,
                   updated_at_ms INTEGER NOT NULL
                 ) STRICT;
                 CREATE TABLE IF NOT EXISTS contact_request (
                   request_id TEXT PRIMARY KEY,
                   requester_id TEXT NOT NULL,
                   recipient_id TEXT NOT NULL,
                   status TEXT NOT NULL,
                   created_at_ms INTEGER NOT NULL,
                   responded_at_ms INTEGER,
                   CHECK(requester_id <> recipient_id)
                 ) STRICT;
                 CREATE UNIQUE INDEX IF NOT EXISTS contact_pair
                   ON contact_request(requester_id, recipient_id)
                   WHERE status IN ('pending', 'accepted');
                 CREATE TABLE IF NOT EXISTS contact_block (
                   blocker_id TEXT NOT NULL,
                   blocked_id TEXT NOT NULL,
                   created_at_ms INTEGER NOT NULL,
                   PRIMARY KEY(blocker_id, blocked_id),
                   CHECK(blocker_id <> blocked_id)
                 ) STRICT;
                 CREATE TABLE IF NOT EXISTS contact_audit (
                   sequence INTEGER PRIMARY KEY AUTOINCREMENT,
                   event TEXT NOT NULL,
                   actor_id TEXT NOT NULL,
                   peer_id TEXT NOT NULL,
                   created_at_ms INTEGER NOT NULL
                 ) STRICT;",
            )
            .map_err(|error| ContactError::Storage(error.to_string()))?;
        Ok(Self {
            connection: Mutex::new(connection),
            key: Zeroizing::new(key),
        })
    }

    pub fn register_matrix_identity(
        &self,
        owner_id: &str,
        matrix_user_id: &str,
        now_ms: u64,
    ) -> Result<()> {
        validate_id("owner", owner_id)?;
        validate_matrix_id(matrix_user_id)?;
        let cipher = self.seal_matrix_id(owner_id, matrix_user_id)?;
        let connection = lock(&self.connection)?;
        connection
            .execute(
                "INSERT INTO matrix_identity(owner_id, matrix_id_cipher, updated_at_ms)
                 VALUES (?1, ?2, ?3)
                 ON CONFLICT(owner_id) DO UPDATE SET
                   matrix_id_cipher = excluded.matrix_id_cipher,
                   updated_at_ms = excluded.updated_at_ms",
                params![owner_id, cipher, to_i64(now_ms)?],
            )
            .map_err(storage)?;
        append_audit(
            &connection,
            "matrix_identity_registered",
            owner_id,
            owner_id,
            now_ms,
        )
    }

    pub fn request(
        &self,
        requester_id: &str,
        recipient_id: &str,
        now_ms: u64,
    ) -> Result<ContactRequest> {
        validate_pair(requester_id, recipient_id)?;
        let mut connection = lock(&self.connection)?;
        let transaction = connection.transaction().map_err(storage)?;
        require_matrix_identity(&transaction, requester_id)?;
        require_matrix_identity(&transaction, recipient_id)?;
        if is_blocked(&transaction, requester_id, recipient_id)? {
            return Err(ContactError::Unauthorized);
        }
        let reverse = transaction
            .query_row(
                "SELECT request_id FROM contact_request
                 WHERE requester_id = ?1 AND recipient_id = ?2 AND status = 'pending'",
                params![recipient_id, requester_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(storage)?;
        if reverse.is_some() {
            return Err(ContactError::Conflict);
        }
        let request_id = random_id();
        transaction
            .execute(
                "INSERT INTO contact_request(
                   request_id, requester_id, recipient_id, status, created_at_ms
                 ) VALUES (?1, ?2, ?3, 'pending', ?4)",
                params![request_id, requester_id, recipient_id, to_i64(now_ms)?],
            )
            .map_err(|_| ContactError::Conflict)?;
        append_audit(
            &transaction,
            "contact_requested",
            requester_id,
            recipient_id,
            now_ms,
        )?;
        transaction.commit().map_err(storage)?;
        Ok(ContactRequest {
            request_id,
            requester_id: requester_id.to_owned(),
            recipient_id: recipient_id.to_owned(),
            status: ContactStatus::Pending,
            created_at_ms: now_ms,
            responded_at_ms: None,
        })
    }

    pub fn respond(
        &self,
        recipient_id: &str,
        request_id: &str,
        accept: bool,
        now_ms: u64,
    ) -> Result<ContactRequest> {
        validate_id("recipient", recipient_id)?;
        validate_id("request", request_id)?;
        let mut connection = lock(&self.connection)?;
        let transaction = connection.transaction().map_err(storage)?;
        let mut request = load_request(&transaction, request_id)?;
        if request.recipient_id != recipient_id {
            return Err(ContactError::NotFound);
        }
        if request.status != ContactStatus::Pending
            || is_blocked(&transaction, &request.requester_id, &request.recipient_id)?
        {
            return Err(ContactError::Conflict);
        }
        request.status = if accept {
            ContactStatus::Accepted
        } else {
            ContactStatus::Declined
        };
        request.responded_at_ms = Some(now_ms);
        transaction
            .execute(
                "UPDATE contact_request SET status = ?1, responded_at_ms = ?2
                 WHERE request_id = ?3 AND status = 'pending'",
                params![request.status.as_str(), to_i64(now_ms)?, request_id],
            )
            .map_err(storage)?;
        append_audit(
            &transaction,
            if accept {
                "contact_accepted"
            } else {
                "contact_declined"
            },
            recipient_id,
            &request.requester_id,
            now_ms,
        )?;
        transaction.commit().map_err(storage)?;
        Ok(request)
    }

    pub fn resolve_accepted(&self, owner_id: &str, peer_id: &str) -> Result<AcceptedContact> {
        validate_pair(owner_id, peer_id)?;
        let connection = lock(&self.connection)?;
        if is_blocked(&connection, owner_id, peer_id)? {
            return Err(ContactError::NotFound);
        }
        let accepted = connection
            .query_row(
                "SELECT 1 FROM contact_request
                 WHERE status = 'accepted' AND (
                   (requester_id = ?1 AND recipient_id = ?2) OR
                   (requester_id = ?2 AND recipient_id = ?1)
                 ) LIMIT 1",
                params![owner_id, peer_id],
                |_| Ok(()),
            )
            .optional()
            .map_err(storage)?
            .is_some();
        if !accepted {
            return Err(ContactError::NotFound);
        }
        let cipher = connection
            .query_row(
                "SELECT matrix_id_cipher FROM matrix_identity WHERE owner_id = ?1",
                [peer_id],
                |row| row.get::<_, Vec<u8>>(0),
            )
            .optional()
            .map_err(storage)?
            .ok_or(ContactError::NotFound)?;
        Ok(AcceptedContact {
            peer_id: peer_id.to_owned(),
            matrix_user_id: self.open_matrix_id(peer_id, &cipher)?,
        })
    }

    pub fn accepted_for(&self, owner_id: &str) -> Result<Vec<AcceptedContact>> {
        validate_id("owner", owner_id)?;
        let connection = lock(&self.connection)?;
        let mut statement = connection
            .prepare(
                "SELECT CASE
                    WHEN r.requester_id = ?1 THEN r.recipient_id
                    ELSE r.requester_id
                  END AS peer_id
                 FROM contact_request r
                 WHERE r.status = 'accepted'
                   AND (r.requester_id = ?1 OR r.recipient_id = ?1)
                   AND NOT EXISTS (
                     SELECT 1 FROM contact_block
                     WHERE (
                       blocker_id = ?1 AND blocked_id = CASE
                         WHEN r.requester_id = ?1 THEN r.recipient_id ELSE r.requester_id END
                     ) OR (
                       blocker_id = CASE
                         WHEN r.requester_id = ?1 THEN r.recipient_id ELSE r.requester_id END
                       AND blocked_id = ?1
                     )
                   )
                 ORDER BY r.responded_at_ms DESC, r.request_id
                 LIMIT 100",
            )
            .map_err(storage)?;
        let peers = statement
            .query_map([owner_id], |row| row.get::<_, String>(0))
            .map_err(storage)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(storage)?;
        drop(statement);
        peers
            .into_iter()
            .map(|peer_id| {
                let cipher = connection
                    .query_row(
                        "SELECT matrix_id_cipher FROM matrix_identity WHERE owner_id = ?1",
                        [&peer_id],
                        |row| row.get::<_, Vec<u8>>(0),
                    )
                    .optional()
                    .map_err(storage)?
                    .ok_or(ContactError::NotFound)?;
                Ok(AcceptedContact {
                    matrix_user_id: self.open_matrix_id(&peer_id, &cipher)?,
                    peer_id,
                })
            })
            .collect()
    }

    pub fn pending_for(&self, recipient_id: &str) -> Result<Vec<ContactRequest>> {
        validate_id("recipient", recipient_id)?;
        let connection = lock(&self.connection)?;
        let mut statement = connection
            .prepare(
                "SELECT request_id, requester_id, recipient_id, status,
                        created_at_ms, responded_at_ms
                 FROM contact_request
                 WHERE recipient_id = ?1 AND status = 'pending'
                 ORDER BY created_at_ms, request_id
                 LIMIT 100",
            )
            .map_err(storage)?;
        let rows = statement
            .query_map([recipient_id], parse_request)
            .map_err(storage)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(storage)?;
        Ok(rows)
    }

    pub fn block(&self, blocker_id: &str, blocked_id: &str, now_ms: u64) -> Result<()> {
        validate_pair(blocker_id, blocked_id)?;
        let mut connection = lock(&self.connection)?;
        let transaction = connection.transaction().map_err(storage)?;
        transaction
            .execute(
                "INSERT INTO contact_block(blocker_id, blocked_id, created_at_ms)
                 VALUES (?1, ?2, ?3)
                 ON CONFLICT(blocker_id, blocked_id) DO NOTHING",
                params![blocker_id, blocked_id, to_i64(now_ms)?],
            )
            .map_err(storage)?;
        transaction
            .execute(
                "UPDATE contact_request SET status = 'blocked', responded_at_ms = ?1
                 WHERE status IN ('pending', 'accepted') AND (
                   (requester_id = ?2 AND recipient_id = ?3) OR
                   (requester_id = ?3 AND recipient_id = ?2)
                 )",
                params![to_i64(now_ms)?, blocker_id, blocked_id],
            )
            .map_err(storage)?;
        append_audit(
            &transaction,
            "contact_blocked",
            blocker_id,
            blocked_id,
            now_ms,
        )?;
        transaction.commit().map_err(storage)
    }

    pub fn delete_identity(&self, owner_id: &str, now_ms: u64) -> Result<()> {
        validate_id("owner", owner_id)?;
        let mut connection = lock(&self.connection)?;
        let transaction = connection.transaction().map_err(storage)?;
        transaction
            .execute(
                "DELETE FROM matrix_identity WHERE owner_id = ?1",
                [owner_id],
            )
            .map_err(storage)?;
        transaction
            .execute(
                "DELETE FROM contact_request
                 WHERE requester_id = ?1 OR recipient_id = ?1",
                [owner_id],
            )
            .map_err(storage)?;
        transaction
            .execute(
                "DELETE FROM contact_block
                 WHERE blocker_id = ?1 OR blocked_id = ?1",
                [owner_id],
            )
            .map_err(storage)?;
        let redacted_id = random_deleted_id();
        transaction
            .execute(
                "UPDATE contact_audit
                 SET actor_id = CASE WHEN actor_id = ?1 THEN ?2 ELSE actor_id END,
                     peer_id = CASE WHEN peer_id = ?1 THEN ?2 ELSE peer_id END
                 WHERE actor_id = ?1 OR peer_id = ?1",
                params![owner_id, redacted_id],
            )
            .map_err(storage)?;
        append_audit(
            &transaction,
            "contact_identity_deleted",
            &redacted_id,
            &redacted_id,
            now_ms,
        )?;
        transaction.commit().map_err(storage)
    }

    pub fn matrix_identity(&self, owner_id: &str) -> Result<Option<Zeroizing<String>>> {
        validate_id("owner", owner_id)?;
        let connection = lock(&self.connection)?;
        let cipher = connection
            .query_row(
                "SELECT matrix_id_cipher FROM matrix_identity WHERE owner_id = ?1",
                [owner_id],
                |row| row.get::<_, Vec<u8>>(0),
            )
            .optional()
            .map_err(storage)?;
        cipher
            .map(|cipher| self.open_matrix_id(owner_id, &cipher).map(Zeroizing::new))
            .transpose()
    }

    fn seal_matrix_id(&self, owner_id: &str, matrix_id: &str) -> Result<Vec<u8>> {
        let cipher = XChaCha20Poly1305::new((&*self.key).into());
        let mut nonce = [0_u8; 24];
        OsRng.fill_bytes(&mut nonce);
        let aad = matrix_aad(owner_id);
        let encrypted = cipher
            .encrypt(
                XNonce::from_slice(&nonce),
                Payload {
                    msg: matrix_id.as_bytes(),
                    aad: &aad,
                },
            )
            .map_err(|_| ContactError::Encryption)?;
        let mut envelope = nonce.to_vec();
        envelope.extend_from_slice(&encrypted);
        Ok(envelope)
    }

    fn open_matrix_id(&self, owner_id: &str, envelope: &[u8]) -> Result<String> {
        if envelope.len() <= 24 {
            return Err(ContactError::Encryption);
        }
        let cipher = XChaCha20Poly1305::new((&*self.key).into());
        let aad = matrix_aad(owner_id);
        let plaintext = cipher
            .decrypt(
                XNonce::from_slice(&envelope[..24]),
                Payload {
                    msg: &envelope[24..],
                    aad: &aad,
                },
            )
            .map_err(|_| ContactError::Encryption)?;
        let matrix_id = String::from_utf8(plaintext).map_err(|_| ContactError::Encryption)?;
        validate_matrix_id(&matrix_id)?;
        Ok(matrix_id)
    }
}

fn load_request(connection: &Connection, request_id: &str) -> Result<ContactRequest> {
    connection
        .query_row(
            "SELECT request_id, requester_id, recipient_id, status,
                    created_at_ms, responded_at_ms
             FROM contact_request WHERE request_id = ?1",
            [request_id],
            parse_request,
        )
        .optional()
        .map_err(storage)?
        .ok_or(ContactError::NotFound)
}

fn parse_request(row: &rusqlite::Row<'_>) -> rusqlite::Result<ContactRequest> {
    let status: String = row.get(3)?;
    Ok(ContactRequest {
        request_id: row.get(0)?,
        requester_id: row.get(1)?,
        recipient_id: row.get(2)?,
        status: ContactStatus::parse(&status).map_err(|_| rusqlite::Error::InvalidQuery)?,
        created_at_ms: from_i64(row.get(4)?).map_err(|_| rusqlite::Error::InvalidQuery)?,
        responded_at_ms: row
            .get::<_, Option<i64>>(5)?
            .map(from_i64)
            .transpose()
            .map_err(|_| rusqlite::Error::InvalidQuery)?,
    })
}

fn require_matrix_identity(connection: &Connection, owner_id: &str) -> Result<()> {
    connection
        .query_row(
            "SELECT 1 FROM matrix_identity WHERE owner_id = ?1",
            [owner_id],
            |_| Ok(()),
        )
        .optional()
        .map_err(storage)?
        .ok_or(ContactError::NotFound)
}

fn is_blocked(connection: &Connection, first: &str, second: &str) -> Result<bool> {
    Ok(connection
        .query_row(
            "SELECT 1 FROM contact_block WHERE
               (blocker_id = ?1 AND blocked_id = ?2) OR
               (blocker_id = ?2 AND blocked_id = ?1)
             LIMIT 1",
            params![first, second],
            |_| Ok(()),
        )
        .optional()
        .map_err(storage)?
        .is_some())
}

fn append_audit(
    connection: &Connection,
    event: &str,
    actor: &str,
    peer: &str,
    now_ms: u64,
) -> Result<()> {
    connection
        .execute(
            "INSERT INTO contact_audit(event, actor_id, peer_id, created_at_ms)
             VALUES (?1, ?2, ?3, ?4)",
            params![event, actor, peer, to_i64(now_ms)?],
        )
        .map_err(storage)?;
    Ok(())
}

fn validate_pair(first: &str, second: &str) -> Result<()> {
    validate_id("identity", first)?;
    validate_id("identity", second)?;
    if first == second {
        return Err(ContactError::Invalid(
            "contact participants must differ".to_owned(),
        ));
    }
    Ok(())
}

fn validate_id(label: &str, value: &str) -> Result<()> {
    if value.is_empty()
        || value.len() > MAX_ID_BYTES
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return Err(ContactError::Invalid(format!("{label} ID is invalid")));
    }
    Ok(())
}

fn validate_matrix_id(value: &str) -> Result<()> {
    let Some((local, server)) = value
        .strip_prefix('@')
        .and_then(|rest| rest.split_once(':'))
    else {
        return Err(ContactError::Invalid(
            "Matrix user ID is invalid".to_owned(),
        ));
    };
    if local.is_empty()
        || server.is_empty()
        || value.len() > MAX_MATRIX_ID_BYTES
        || value.chars().any(|character| character.is_control())
        || value.chars().any(char::is_whitespace)
    {
        return Err(ContactError::Invalid(
            "Matrix user ID is invalid".to_owned(),
        ));
    }
    Ok(())
}

fn matrix_aad(owner_id: &str) -> Vec<u8> {
    let mut aad = Vec::with_capacity(MATRIX_AAD.len() + owner_id.len() + 1);
    aad.extend_from_slice(MATRIX_AAD);
    aad.push(0);
    aad.extend_from_slice(owner_id.as_bytes());
    aad
}

fn random_id() -> String {
    let mut bytes = [0_u8; 16];
    OsRng.fill_bytes(&mut bytes);
    let mut value = String::with_capacity(8 + 32);
    value.push_str("contact_");
    for byte in bytes {
        use std::fmt::Write as _;
        let _ = write!(value, "{byte:02x}");
    }
    value
}

fn random_deleted_id() -> String {
    let mut bytes = [0_u8; 16];
    OsRng.fill_bytes(&mut bytes);
    let mut value = String::from("deleted_");
    for byte in bytes {
        use std::fmt::Write as _;
        let _ = write!(value, "{byte:02x}");
    }
    value
}

fn to_i64(value: u64) -> Result<i64> {
    i64::try_from(value)
        .map_err(|_| ContactError::Invalid("timestamp is outside the supported range".to_owned()))
}

fn from_i64(value: i64) -> Result<u64> {
    u64::try_from(value)
        .map_err(|_| ContactError::Storage("stored timestamp is invalid".to_owned()))
}

fn lock<T>(value: &Mutex<T>) -> Result<MutexGuard<'_, T>> {
    value
        .lock()
        .map_err(|_| ContactError::Storage("contact store lock is unavailable".to_owned()))
}

fn storage(error: rusqlite::Error) -> ContactError {
    ContactError::Storage(error.to_string())
}
