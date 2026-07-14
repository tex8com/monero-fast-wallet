use crate::model::{
    approximate_distance_km, validate_area_id, validate_bio, validate_display_name,
    validate_message, validate_radius, validate_report_reason, BlockRecord, ContactRecord,
    ContactResponse, IdentityRecord, MessageRecord, MessageResponse, NearbyProfileResponse,
    ProfileResponse, ReportRecord, StoredCommunity, UpdateProfileRequest, PRESENCE_TTL_MS,
};
use anyhow::{anyhow, Context, Result};
use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    Engine,
};
use chacha20poly1305::{
    aead::{Aead, KeyInit},
    XChaCha20Poly1305, XNonce,
};
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::RwLock,
};
use subtle::ConstantTimeEq;

pub struct CommunityStore {
    path: Option<PathBuf>,
    cipher: XChaCha20Poly1305,
    data: RwLock<StoredCommunity>,
}

impl CommunityStore {
    pub fn in_memory() -> Self {
        Self {
            path: None,
            cipher: XChaCha20Poly1305::new((&[0u8; 32]).into()),
            data: RwLock::new(StoredCommunity::default()),
        }
    }

    pub fn open(path: impl Into<PathBuf>, key: [u8; 32]) -> Result<Self> {
        let path = path.into();
        let cipher = XChaCha20Poly1305::new((&key).into());
        let data = if path.exists() {
            read_encrypted(&path, &cipher)?
        } else {
            StoredCommunity::default()
        };
        Ok(Self {
            path: Some(path),
            cipher,
            data: RwLock::new(data),
        })
    }

    pub fn create_identity(
        &self,
        display_name: &str,
        now_ms: u64,
    ) -> Result<(IdentityRecord, String)> {
        let display_name = validate_display_name(display_name).map_err(anyhow::Error::msg)?;
        let identity_id = random_id(18);
        let token = random_id(32);
        let record = IdentityRecord {
            id: identity_id,
            token_hash: hash_token(&token),
            display_name,
            bio: String::new(),
            area_id: None,
            visible: false,
            radius_km: 10,
            created_at_ms: now_ms,
            last_seen_at_ms: now_ms,
        };
        let mut data = self.data.write().expect("community store poisoned");
        data.identities.push(record.clone());
        self.persist(&data)?;
        Ok((record, token))
    }

    pub fn authenticate(&self, token: &str) -> Option<IdentityRecord> {
        let candidate = hash_token(token);
        self.data
            .read()
            .expect("community store poisoned")
            .identities
            .iter()
            .find(|identity| constant_time_equal(&candidate, &identity.token_hash))
            .cloned()
    }

    pub fn profile(&self, identity_id: &str) -> Option<IdentityRecord> {
        self.data
            .read()
            .expect("community store poisoned")
            .identities
            .iter()
            .find(|identity| identity.id == identity_id)
            .cloned()
    }

    pub fn update_profile(
        &self,
        identity_id: &str,
        request: UpdateProfileRequest,
        now_ms: u64,
    ) -> Result<IdentityRecord> {
        let display_name =
            validate_display_name(&request.display_name).map_err(anyhow::Error::msg)?;
        let bio = validate_bio(&request.bio).map_err(anyhow::Error::msg)?;
        let area_id = request
            .area_id
            .as_deref()
            .map(validate_area_id)
            .transpose()
            .map_err(anyhow::Error::msg)?;
        let radius_km = validate_radius(request.radius_km).map_err(anyhow::Error::msg)?;
        if request.visible && area_id.is_none() {
            return Err(anyhow!("area_id is required while visible"));
        }

        let mut data = self.data.write().expect("community store poisoned");
        let identity = data
            .identities
            .iter_mut()
            .find(|identity| identity.id == identity_id)
            .ok_or_else(|| anyhow!("identity not found"))?;
        identity.display_name = display_name;
        identity.bio = bio;
        identity.area_id = area_id;
        identity.visible = request.visible;
        identity.radius_km = radius_km;
        identity.last_seen_at_ms = now_ms;
        let result = identity.clone();
        self.persist(&data)?;
        Ok(result)
    }

    pub fn touch_presence(&self, identity_id: &str, now_ms: u64) -> Result<IdentityRecord> {
        let mut data = self.data.write().expect("community store poisoned");
        let identity = data
            .identities
            .iter_mut()
            .find(|identity| identity.id == identity_id)
            .ok_or_else(|| anyhow!("identity not found"))?;
        identity.last_seen_at_ms = now_ms;
        let result = identity.clone();
        self.persist(&data)?;
        Ok(result)
    }

    pub fn nearby(
        &self,
        identity_id: &str,
        radius_km: u16,
        now_ms: u64,
    ) -> Result<Vec<NearbyProfileResponse>> {
        let radius_km = validate_radius(radius_km).map_err(anyhow::Error::msg)?;
        let data = self.data.read().expect("community store poisoned");
        let own = data
            .identities
            .iter()
            .find(|identity| identity.id == identity_id)
            .ok_or_else(|| anyhow!("identity not found"))?;
        let own_area = own
            .area_id
            .as_deref()
            .ok_or_else(|| anyhow!("profile has no approximate area"))?;

        let mut nearby = data
            .identities
            .iter()
            .filter(|candidate| candidate.id != identity_id)
            .filter(|candidate| candidate.visible)
            .filter(|candidate| now_ms.saturating_sub(candidate.last_seen_at_ms) <= PRESENCE_TTL_MS)
            .filter(|candidate| !is_blocked(&data, identity_id, &candidate.id))
            .filter_map(|candidate| {
                let distance = approximate_distance_km(own_area, candidate.area_id.as_deref()?)?;
                if distance > radius_km || distance > candidate.radius_km {
                    return None;
                }
                Some(NearbyProfileResponse {
                    profile: ProfileResponse::from(candidate),
                    approximate_distance_km: distance,
                    relationship: relationship(&data, identity_id, &candidate.id),
                })
            })
            .collect::<Vec<_>>();
        nearby.sort_by_key(|profile| {
            (
                profile.approximate_distance_km,
                profile.profile.display_name.clone(),
            )
        });
        Ok(nearby)
    }

    pub fn request_contact(
        &self,
        requester_id: &str,
        recipient_id: &str,
        now_ms: u64,
    ) -> Result<ContactRecord> {
        if requester_id == recipient_id {
            return Err(anyhow!("cannot connect to the same identity"));
        }
        let mut data = self.data.write().expect("community store poisoned");
        ensure_identity(&data, recipient_id)?;
        if is_blocked(&data, requester_id, recipient_id) {
            return Err(anyhow!("contact is blocked"));
        }
        if let Some(existing) = contact_between(&data, requester_id, recipient_id) {
            return Ok(existing.clone());
        }
        let record = ContactRecord {
            requester_id: requester_id.to_owned(),
            recipient_id: recipient_id.to_owned(),
            requested_at_ms: now_ms,
            accepted_at_ms: None,
        };
        data.contacts.push(record.clone());
        self.persist(&data)?;
        Ok(record)
    }

    pub fn accept_contact(
        &self,
        recipient_id: &str,
        requester_id: &str,
        now_ms: u64,
    ) -> Result<ContactRecord> {
        let mut data = self.data.write().expect("community store poisoned");
        if is_blocked(&data, recipient_id, requester_id) {
            return Err(anyhow!("contact is blocked"));
        }
        let contact = data
            .contacts
            .iter_mut()
            .find(|contact| {
                contact.requester_id == requester_id && contact.recipient_id == recipient_id
            })
            .ok_or_else(|| anyhow!("incoming contact request not found"))?;
        contact.accepted_at_ms = Some(now_ms);
        let result = contact.clone();
        self.persist(&data)?;
        Ok(result)
    }

    pub fn contacts(&self, identity_id: &str) -> Result<Vec<ContactResponse>> {
        let data = self.data.read().expect("community store poisoned");
        ensure_identity(&data, identity_id)?;
        let mut result = data
            .contacts
            .iter()
            .filter_map(|contact| {
                let (peer_id, status) = if contact.requester_id == identity_id {
                    (
                        &contact.recipient_id,
                        if contact.accepted_at_ms.is_some() {
                            "connected"
                        } else {
                            "outgoing"
                        },
                    )
                } else if contact.recipient_id == identity_id {
                    (
                        &contact.requester_id,
                        if contact.accepted_at_ms.is_some() {
                            "connected"
                        } else {
                            "incoming"
                        },
                    )
                } else {
                    return None;
                };
                if is_blocked(&data, identity_id, peer_id) {
                    return None;
                }
                let peer = data
                    .identities
                    .iter()
                    .find(|identity| identity.id == *peer_id)?;
                Some(ContactResponse {
                    profile: ProfileResponse::from(peer),
                    status: status.to_owned(),
                })
            })
            .collect::<Vec<_>>();
        result
            .sort_by(|first, second| first.profile.display_name.cmp(&second.profile.display_name));
        Ok(result)
    }

    pub fn send_message(
        &self,
        sender_id: &str,
        recipient_id: &str,
        body: &str,
        now_ms: u64,
    ) -> Result<MessageRecord> {
        let body = validate_message(body).map_err(anyhow::Error::msg)?;
        let mut data = self.data.write().expect("community store poisoned");
        ensure_connected(&data, sender_id, recipient_id)?;
        if is_blocked(&data, sender_id, recipient_id) {
            return Err(anyhow!("contact is blocked"));
        }
        let message = MessageRecord {
            id: random_id(18),
            sender_id: sender_id.to_owned(),
            recipient_id: recipient_id.to_owned(),
            body,
            sent_at_ms: now_ms,
        };
        data.messages.push(message.clone());
        self.persist(&data)?;
        Ok(message)
    }

    pub fn messages(
        &self,
        identity_id: &str,
        peer_id: &str,
        after_ms: u64,
    ) -> Result<Vec<MessageResponse>> {
        let data = self.data.read().expect("community store poisoned");
        ensure_connected(&data, identity_id, peer_id)?;
        if is_blocked(&data, identity_id, peer_id) {
            return Err(anyhow!("contact is blocked"));
        }
        let mut messages = data
            .messages
            .iter()
            .filter(|message| message.sent_at_ms > after_ms)
            .filter(|message| {
                (message.sender_id == identity_id && message.recipient_id == peer_id)
                    || (message.sender_id == peer_id && message.recipient_id == identity_id)
            })
            .map(MessageResponse::from)
            .collect::<Vec<_>>();
        messages.sort_by_key(|message| (message.sent_at_ms, message.id.clone()));
        Ok(messages)
    }

    pub fn block(&self, blocker_id: &str, blocked_id: &str, now_ms: u64) -> Result<()> {
        if blocker_id == blocked_id {
            return Err(anyhow!("cannot block the same identity"));
        }
        let mut data = self.data.write().expect("community store poisoned");
        ensure_identity(&data, blocked_id)?;
        if !data
            .blocks
            .iter()
            .any(|block| block.blocker_id == blocker_id && block.blocked_id == blocked_id)
        {
            data.blocks.push(BlockRecord {
                blocker_id: blocker_id.to_owned(),
                blocked_id: blocked_id.to_owned(),
                created_at_ms: now_ms,
            });
        }
        data.contacts.retain(|contact| {
            !same_pair(
                &contact.requester_id,
                &contact.recipient_id,
                blocker_id,
                blocked_id,
            )
        });
        data.messages.retain(|message| {
            !same_pair(
                &message.sender_id,
                &message.recipient_id,
                blocker_id,
                blocked_id,
            )
        });
        self.persist(&data)
    }

    pub fn report(
        &self,
        reporter_id: &str,
        reported_id: &str,
        reason: &str,
        now_ms: u64,
    ) -> Result<ReportRecord> {
        let reason = validate_report_reason(reason).map_err(anyhow::Error::msg)?;
        let mut data = self.data.write().expect("community store poisoned");
        ensure_identity(&data, reported_id)?;
        let report = ReportRecord {
            id: random_id(18),
            reporter_id: reporter_id.to_owned(),
            reported_id: reported_id.to_owned(),
            reason,
            created_at_ms: now_ms,
        };
        data.reports.push(report.clone());
        self.persist(&data)?;
        Ok(report)
    }

    pub fn delete_identity(&self, identity_id: &str) -> Result<()> {
        let mut data = self.data.write().expect("community store poisoned");
        data.identities
            .retain(|identity| identity.id != identity_id);
        data.contacts.retain(|contact| {
            contact.requester_id != identity_id && contact.recipient_id != identity_id
        });
        data.messages.retain(|message| {
            message.sender_id != identity_id && message.recipient_id != identity_id
        });
        data.blocks
            .retain(|block| block.blocker_id != identity_id && block.blocked_id != identity_id);
        self.persist(&data)
    }

    fn persist(&self, data: &StoredCommunity) -> Result<()> {
        let Some(path) = &self.path else {
            return Ok(());
        };
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).with_context(|| {
                format!("create community database directory {}", parent.display())
            })?;
        }
        let plaintext = serde_json::to_vec(data)?;
        let sealed = seal(&self.cipher, &plaintext)?;
        let serialized = serde_json::to_vec_pretty(&sealed)?;
        let temporary = path.with_extension("tmp");
        fs::write(&temporary, serialized).with_context(|| {
            format!("write temporary community database {}", temporary.display())
        })?;
        fs::rename(&temporary, path)
            .with_context(|| format!("replace community database {}", path.display()))?;
        Ok(())
    }
}

fn ensure_identity(data: &StoredCommunity, identity_id: &str) -> Result<()> {
    if data
        .identities
        .iter()
        .any(|identity| identity.id == identity_id)
    {
        Ok(())
    } else {
        Err(anyhow!("identity not found"))
    }
}

fn ensure_connected(data: &StoredCommunity, first: &str, second: &str) -> Result<()> {
    if contact_between(data, first, second).is_some_and(|contact| contact.accepted_at_ms.is_some())
    {
        Ok(())
    } else {
        Err(anyhow!("mutual contact approval is required"))
    }
}

fn contact_between<'a>(
    data: &'a StoredCommunity,
    first: &str,
    second: &str,
) -> Option<&'a ContactRecord> {
    data.contacts
        .iter()
        .find(|contact| same_pair(&contact.requester_id, &contact.recipient_id, first, second))
}

fn same_pair(record_first: &str, record_second: &str, first: &str, second: &str) -> bool {
    (record_first == first && record_second == second)
        || (record_first == second && record_second == first)
}

fn is_blocked(data: &StoredCommunity, first: &str, second: &str) -> bool {
    data.blocks
        .iter()
        .any(|block| same_pair(&block.blocker_id, &block.blocked_id, first, second))
}

fn relationship(data: &StoredCommunity, identity_id: &str, peer_id: &str) -> String {
    let Some(contact) = contact_between(data, identity_id, peer_id) else {
        return "none".to_owned();
    };
    if contact.accepted_at_ms.is_some() {
        "connected".to_owned()
    } else if contact.requester_id == identity_id {
        "outgoing".to_owned()
    } else {
        "incoming".to_owned()
    }
}

fn random_id(bytes: usize) -> String {
    let mut value = vec![0u8; bytes];
    OsRng.fill_bytes(&mut value);
    URL_SAFE_NO_PAD.encode(value)
}

fn hash_token(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))
}

fn constant_time_equal(first: &str, second: &str) -> bool {
    first.len() == second.len() && first.as_bytes().ct_eq(second.as_bytes()).into()
}

#[derive(Serialize, Deserialize)]
struct SealedDatabase {
    version: u8,
    nonce: String,
    ciphertext: String,
}

fn seal(cipher: &XChaCha20Poly1305, plaintext: &[u8]) -> Result<SealedDatabase> {
    let mut nonce = [0u8; 24];
    OsRng.fill_bytes(&mut nonce);
    let ciphertext = cipher
        .encrypt(XNonce::from_slice(&nonce), plaintext)
        .map_err(|_| anyhow!("encrypt community database"))?;
    Ok(SealedDatabase {
        version: 1,
        nonce: STANDARD.encode(nonce),
        ciphertext: STANDARD.encode(ciphertext),
    })
}

fn read_encrypted(path: &Path, cipher: &XChaCha20Poly1305) -> Result<StoredCommunity> {
    let sealed: SealedDatabase = serde_json::from_slice(
        &fs::read(path).with_context(|| format!("read community database {}", path.display()))?,
    )?;
    if sealed.version != 1 {
        return Err(anyhow!("unsupported community database version"));
    }
    let nonce = STANDARD.decode(sealed.nonce)?;
    if nonce.len() != 24 {
        return Err(anyhow!("community database nonce has invalid length"));
    }
    let ciphertext = STANDARD.decode(sealed.ciphertext)?;
    let plaintext = cipher
        .decrypt(XNonce::from_slice(&nonce), ciphertext.as_ref())
        .map_err(|_| anyhow!("decrypt community database"))?;
    Ok(serde_json::from_slice(&plaintext)?)
}

pub fn parse_storage_key(value: &str) -> Result<[u8; 32]> {
    let decoded = hex::decode(value).or_else(|_| STANDARD.decode(value))?;
    decoded
        .try_into()
        .map_err(|_| anyhow!("storage key must contain exactly 32 bytes"))
}
