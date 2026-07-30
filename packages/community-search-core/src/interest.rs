use crate::{
    model::validate_embedding, CommunitySearchError, ModelContract, Result, V1_EMBEDDING_DIMENSION,
};
use chacha20poly1305::{
    aead::{Aead, Payload},
    KeyInit, XChaCha20Poly1305, XNonce,
};
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use zeroize::Zeroizing;

const DECAY_HALF_LIFE_MS: f64 = 30.0 * 24.0 * 60.0 * 60.0 * 1_000.0;
const REPETITION_WINDOW_MS: u64 = 24 * 60 * 60 * 1_000;
const MAX_REPETITIONS_PER_WINDOW: u8 = 3;
const MAX_REPETITION_RECORDS: usize = 256;
const PROTECTED_STATE_PREFIX: &[u8] = b"MFW-INTEREST\x01";
const PROTECTED_STATE_AAD: &[u8] = b"com.tex8.monerowallet.community-interest.v1";

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InterestDomain {
    Discovery,
    News,
    Advertising,
    Global,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InterestSignal {
    SearchSubmitted,
    ContentOpened,
    LongerLocalView,
    ContactRequested,
    SavedLocally,
    MoreLikeThis,
    LessLikeThis,
    Hidden,
    Reported,
    Blocked,
}

impl InterestSignal {
    fn weight(self) -> Option<f32> {
        match self {
            Self::SearchSubmitted => Some(0.4),
            Self::ContentOpened => Some(0.2),
            Self::LongerLocalView => Some(0.3),
            Self::ContactRequested => Some(1.0),
            Self::SavedLocally => Some(0.7),
            Self::MoreLikeThis => Some(1.0),
            Self::LessLikeThis => Some(-1.0),
            Self::Hidden => Some(-0.7),
            Self::Reported | Self::Blocked => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RepetitionFingerprint(String);

impl RepetitionFingerprint {
    pub fn from_hex(value: impl Into<String>) -> Result<Self> {
        let value = value.into();
        if value.len() != 64
            || !value
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err(CommunitySearchError::InvalidCatalog(
                "local event fingerprint must be a 32-byte lowercase hexadecimal value".to_owned(),
            ));
        }
        Ok(Self(value))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PersonalizationUpdate {
    Applied,
    Disabled,
    RepetitionCapped,
    ExcludedSafetyAction,
    ModelResetAndApplied,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct InterestState {
    enabled: bool,
    model: Option<ModelContract>,
    domains: BTreeMap<InterestDomain, DomainInterest>,
    repetitions: BTreeMap<String, RepetitionCounter>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct DomainInterest {
    positive_sum: Vec<f32>,
    positive_mass: f32,
    negative_sum: Vec<f32>,
    negative_mass: f32,
    last_decay_at_ms: u64,
    applied_events: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct RepetitionCounter {
    window_started_at_ms: u64,
    last_seen_at_ms: u64,
    count: u8,
}

impl InterestState {
    pub fn enabled(&self) -> bool {
        self.enabled
    }

    pub fn set_enabled(&mut self, enabled: bool) {
        self.enabled = enabled;
    }

    pub fn reset(&mut self) {
        self.model = None;
        self.domains.clear();
        self.repetitions.clear();
    }

    pub fn record(
        &mut self,
        domain: InterestDomain,
        signal: InterestSignal,
        fingerprint: &RepetitionFingerprint,
        model: &ModelContract,
        embedding: &[f32],
        now_ms: u64,
    ) -> Result<PersonalizationUpdate> {
        if !self.enabled {
            return Ok(PersonalizationUpdate::Disabled);
        }
        model.validate_v1()?;
        validate_embedding(embedding, model.dimension)?;
        let Some(weight) = signal.weight() else {
            return Ok(PersonalizationUpdate::ExcludedSafetyAction);
        };
        let model_changed = self.model.as_ref().is_some_and(|active| active != model);
        if model_changed {
            self.reset();
            self.enabled = true;
        }
        if self.model.is_none() {
            self.model = Some(model.clone());
        }
        if !self.allow_repetition(fingerprint, now_ms) {
            return Ok(PersonalizationUpdate::RepetitionCapped);
        }
        let state = self
            .domains
            .entry(domain)
            .or_insert_with(|| DomainInterest::new(now_ms));
        state.decay(now_ms);
        if weight >= 0.0 {
            add_weighted(&mut state.positive_sum, embedding, weight);
            state.positive_mass += weight;
        } else {
            let magnitude = weight.abs();
            add_weighted(&mut state.negative_sum, embedding, magnitude);
            state.negative_mass += magnitude;
        }
        state.applied_events = state.applied_events.saturating_add(1);
        Ok(if model_changed {
            PersonalizationUpdate::ModelResetAndApplied
        } else {
            PersonalizationUpdate::Applied
        })
    }

    pub fn personal_score(
        &self,
        domain: InterestDomain,
        model: &ModelContract,
        item_embedding: &[f32],
        now_ms: u64,
    ) -> Result<f32> {
        if !self.enabled || self.model.as_ref() != Some(model) {
            return Ok(0.0);
        }
        validate_embedding(item_embedding, model.dimension)?;
        let Some(mut state) = self.domains.get(&domain).cloned() else {
            return Ok(0.0);
        };
        state.decay(now_ms);
        let positive = normalized(&state.positive_sum)
            .map(|vector| dot(&vector, item_embedding))
            .unwrap_or(0.0);
        let negative = normalized(&state.negative_sum)
            .map(|vector| dot(&vector, item_embedding))
            .unwrap_or(0.0);
        Ok((0.15 * positive - 0.15 * negative).clamp(-0.15, 0.15))
    }

    /// Seals the local interest state with an application-specific key obtained
    /// from the platform credential store. The returned blob may be placed in
    /// app-private storage, but must never be synced, backed up, or exported.
    pub fn seal_for_protected_storage(&self, key: &[u8; 32]) -> Result<Vec<u8>> {
        self.validate()?;
        let plaintext = Zeroizing::new(serde_json::to_vec(self).map_err(|error| {
            CommunitySearchError::Storage(format!(
                "local personalization state could not be encoded: {error}"
            ))
        })?);
        let cipher = XChaCha20Poly1305::new(key.into());
        let mut nonce = [0_u8; 24];
        OsRng.fill_bytes(&mut nonce);
        let ciphertext = cipher
            .encrypt(
                XNonce::from_slice(&nonce),
                Payload {
                    msg: plaintext.as_slice(),
                    aad: PROTECTED_STATE_AAD,
                },
            )
            .map_err(|_| {
                CommunitySearchError::Storage(
                    "local personalization state could not be encrypted".to_owned(),
                )
            })?;
        let mut sealed =
            Vec::with_capacity(PROTECTED_STATE_PREFIX.len() + nonce.len() + ciphertext.len());
        sealed.extend_from_slice(PROTECTED_STATE_PREFIX);
        sealed.extend_from_slice(&nonce);
        sealed.extend_from_slice(&ciphertext);
        Ok(sealed)
    }

    pub fn open_from_protected_storage(bytes: &[u8], key: &[u8; 32]) -> Result<Self> {
        let header_len = PROTECTED_STATE_PREFIX.len() + 24;
        if bytes.len() <= header_len || !bytes.starts_with(PROTECTED_STATE_PREFIX) {
            return Err(CommunitySearchError::Storage(
                "local personalization state has an invalid envelope".to_owned(),
            ));
        }
        let cipher = XChaCha20Poly1305::new(key.into());
        let plaintext = Zeroizing::new(
            cipher
                .decrypt(
                    XNonce::from_slice(&bytes[PROTECTED_STATE_PREFIX.len()..header_len]),
                    Payload {
                        msg: &bytes[header_len..],
                        aad: PROTECTED_STATE_AAD,
                    },
                )
                .map_err(|_| {
                    CommunitySearchError::Storage(
                        "local personalization state failed authentication".to_owned(),
                    )
                })?,
        );
        let state: Self = serde_json::from_slice(plaintext.as_slice()).map_err(|error| {
            CommunitySearchError::Storage(format!(
                "local personalization state could not be decoded: {error}"
            ))
        })?;
        state.validate()?;
        Ok(state)
    }

    fn allow_repetition(&mut self, fingerprint: &RepetitionFingerprint, now_ms: u64) -> bool {
        let counter = self
            .repetitions
            .entry(fingerprint.0.clone())
            .or_insert(RepetitionCounter {
                window_started_at_ms: now_ms,
                last_seen_at_ms: now_ms,
                count: 0,
            });
        if now_ms.saturating_sub(counter.window_started_at_ms) >= REPETITION_WINDOW_MS {
            counter.window_started_at_ms = now_ms;
            counter.count = 0;
        }
        counter.last_seen_at_ms = now_ms;
        if counter.count >= MAX_REPETITIONS_PER_WINDOW {
            return false;
        }
        counter.count += 1;
        if self.repetitions.len() > MAX_REPETITION_RECORDS {
            if let Some(oldest) = self
                .repetitions
                .iter()
                .min_by_key(|(_, value)| value.last_seen_at_ms)
                .map(|(key, _)| key.clone())
            {
                self.repetitions.remove(&oldest);
            }
        }
        true
    }

    fn validate(&self) -> Result<()> {
        if let Some(model) = &self.model {
            model.validate_v1()?;
        }
        if self.domains.len() > 4 || self.repetitions.len() > MAX_REPETITION_RECORDS {
            return Err(CommunitySearchError::Storage(
                "local personalization state exceeds its bounds".to_owned(),
            ));
        }
        for state in self.domains.values() {
            if state.positive_sum.len() != V1_EMBEDDING_DIMENSION
                || state.negative_sum.len() != V1_EMBEDDING_DIMENSION
                || !state.positive_mass.is_finite()
                || !state.negative_mass.is_finite()
                || state
                    .positive_sum
                    .iter()
                    .chain(&state.negative_sum)
                    .any(|value| !value.is_finite())
            {
                return Err(CommunitySearchError::Storage(
                    "local personalization vector state is invalid".to_owned(),
                ));
            }
        }
        for (fingerprint, counter) in &self.repetitions {
            RepetitionFingerprint::from_hex(fingerprint.clone())?;
            if counter.count > MAX_REPETITIONS_PER_WINDOW {
                return Err(CommunitySearchError::Storage(
                    "local repetition state is invalid".to_owned(),
                ));
            }
        }
        Ok(())
    }
}

impl DomainInterest {
    fn new(now_ms: u64) -> Self {
        Self {
            positive_sum: vec![0.0; V1_EMBEDDING_DIMENSION],
            positive_mass: 0.0,
            negative_sum: vec![0.0; V1_EMBEDDING_DIMENSION],
            negative_mass: 0.0,
            last_decay_at_ms: now_ms,
            applied_events: 0,
        }
    }

    fn decay(&mut self, now_ms: u64) {
        let elapsed = now_ms.saturating_sub(self.last_decay_at_ms) as f64;
        if elapsed == 0.0 {
            return;
        }
        let factor = 2f64.powf(-elapsed / DECAY_HALF_LIFE_MS) as f32;
        for value in self
            .positive_sum
            .iter_mut()
            .chain(self.negative_sum.iter_mut())
        {
            *value *= factor;
        }
        self.positive_mass *= factor;
        self.negative_mass *= factor;
        self.last_decay_at_ms = now_ms;
    }
}

fn add_weighted(sum: &mut [f32], vector: &[f32], weight: f32) {
    for (target, value) in sum.iter_mut().zip(vector) {
        *target += weight * value;
    }
}

fn normalized(vector: &[f32]) -> Option<Vec<f32>> {
    let norm = vector
        .iter()
        .map(|value| f64::from(*value).powi(2))
        .sum::<f64>()
        .sqrt() as f32;
    if norm <= f32::EPSILON {
        return None;
    }
    Some(vector.iter().map(|value| *value / norm).collect())
}

fn dot(left: &[f32], right: &[f32]) -> f32 {
    left.iter().zip(right).map(|(a, b)| a * b).sum()
}
