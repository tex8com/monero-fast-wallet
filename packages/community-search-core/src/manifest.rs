use crate::{
    model::{validate_identifier, validate_sha256, CatalogPayload, ModelContract},
    CommunitySearchError, Result, CATALOG_SCHEMA_VERSION, MAX_CATALOG_BYTES,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CatalogManifestUnsigned {
    pub schema_version: u16,
    pub catalog_scope_id: String,
    pub jurisdiction_review_id: String,
    pub policy_version: String,
    pub sequence: u64,
    pub previous_sequence: Option<u64>,
    pub created_at_ms: u64,
    pub expires_at_ms: u64,
    pub model: ModelContract,
    pub payload_sha256: String,
    pub payload_bytes: u64,
    pub records: u64,
    pub tombstones: u64,
    pub signer_key_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CatalogManifest {
    #[serde(flatten)]
    pub unsigned: CatalogManifestUnsigned,
    pub signature: String,
}

#[derive(Clone, Debug)]
pub struct SignedCatalogPackage {
    pub manifest_json: Vec<u8>,
    pub payload_json: Vec<u8>,
}

impl SignedCatalogPackage {
    pub fn create(
        payload: &CatalogPayload,
        signing_key: &SigningKey,
        jurisdiction_review_id: impl Into<String>,
        policy_version: impl Into<String>,
        created_at_ms: u64,
        expires_at_ms: u64,
    ) -> Result<Self> {
        payload.validate_shape()?;
        let payload_json = serde_json::to_vec(payload).map_err(|error| {
            CommunitySearchError::InvalidCatalog(format!(
                "catalog payload could not be encoded: {error}"
            ))
        })?;
        if payload_json.len() > MAX_CATALOG_BYTES {
            return Err(CommunitySearchError::InvalidCatalog(
                "catalog payload exceeds the byte limit".to_owned(),
            ));
        }
        let (records, tombstones) = payload.counts();
        let unsigned = CatalogManifestUnsigned {
            schema_version: CATALOG_SCHEMA_VERSION,
            catalog_scope_id: payload.scope().to_owned(),
            jurisdiction_review_id: jurisdiction_review_id.into(),
            policy_version: policy_version.into(),
            sequence: payload.sequence(),
            previous_sequence: payload.previous_sequence(),
            created_at_ms,
            expires_at_ms,
            model: payload.model().clone(),
            payload_sha256: hex::encode(Sha256::digest(&payload_json)),
            payload_bytes: payload_json.len() as u64,
            records: records as u64,
            tombstones: tombstones as u64,
            signer_key_id: catalog_signer_key_id(&signing_key.verifying_key()),
        };
        unsigned.validate(created_at_ms)?;
        let signature = signing_key.sign(&unsigned.signing_bytes()?);
        let manifest = CatalogManifest {
            unsigned,
            signature: URL_SAFE_NO_PAD.encode(signature.to_bytes()),
        };
        let manifest_json = serde_json::to_vec(&manifest).map_err(|error| {
            CommunitySearchError::InvalidCatalog(format!(
                "catalog manifest could not be encoded: {error}"
            ))
        })?;
        Ok(Self {
            manifest_json,
            payload_json,
        })
    }
}

impl CatalogManifest {
    pub(crate) fn parse_and_verify(
        bytes: &[u8],
        payload_bytes: &[u8],
        verifying_key: &VerifyingKey,
        now_ms: u64,
    ) -> Result<Self> {
        if payload_bytes.len() > MAX_CATALOG_BYTES {
            return Err(CommunitySearchError::InvalidCatalog(
                "catalog payload exceeds the byte limit".to_owned(),
            ));
        }
        let manifest = Self::parse_and_verify_signature(bytes, verifying_key, now_ms)?;
        if manifest.unsigned.payload_bytes != payload_bytes.len() as u64
            || manifest.unsigned.payload_sha256 != hex::encode(Sha256::digest(payload_bytes))
        {
            return Err(CommunitySearchError::PayloadHashMismatch);
        }
        Ok(manifest)
    }

    pub(crate) fn parse_and_verify_signature(
        bytes: &[u8],
        verifying_key: &VerifyingKey,
        now_ms: u64,
    ) -> Result<Self> {
        let manifest: Self = serde_json::from_slice(bytes).map_err(|error| {
            CommunitySearchError::InvalidCatalog(format!(
                "catalog manifest is not valid JSON: {error}"
            ))
        })?;
        manifest.unsigned.validate(now_ms)?;
        if manifest.unsigned.signer_key_id != catalog_signer_key_id(verifying_key) {
            return Err(CommunitySearchError::InvalidSignature);
        }
        let signature_bytes = URL_SAFE_NO_PAD
            .decode(&manifest.signature)
            .map_err(|_| CommunitySearchError::InvalidSignature)?;
        let signature = Signature::from_slice(&signature_bytes)
            .map_err(|_| CommunitySearchError::InvalidSignature)?;
        verifying_key
            .verify(&manifest.unsigned.signing_bytes()?, &signature)
            .map_err(|_| CommunitySearchError::InvalidSignature)?;
        Ok(manifest)
    }
}

impl CatalogManifestUnsigned {
    pub(crate) fn signing_bytes(&self) -> Result<Vec<u8>> {
        serde_json::to_vec(self).map_err(|error| {
            CommunitySearchError::InvalidCatalog(format!(
                "catalog signature payload could not be encoded: {error}"
            ))
        })
    }

    pub(crate) fn validate(&self, now_ms: u64) -> Result<()> {
        if self.schema_version != CATALOG_SCHEMA_VERSION {
            return Err(CommunitySearchError::InvalidCatalog(
                "unsupported catalog manifest schema".to_owned(),
            ));
        }
        validate_identifier("catalog scope", &self.catalog_scope_id, 128)?;
        validate_identifier("jurisdiction review id", &self.jurisdiction_review_id, 128)?;
        validate_identifier("policy version", &self.policy_version, 128)?;
        validate_identifier("catalog signer key id", &self.signer_key_id, 64)?;
        validate_sha256("catalog payload", &self.payload_sha256)?;
        self.model.validate_v1()?;
        if self.sequence == 0
            || self.created_at_ms == 0
            || self.expires_at_ms <= self.created_at_ms
            || self.payload_bytes == 0
        {
            return Err(CommunitySearchError::InvalidCatalog(
                "catalog manifest sequence, times, and payload size are invalid".to_owned(),
            ));
        }
        if now_ms < self.created_at_ms || now_ms >= self.expires_at_ms {
            return Err(CommunitySearchError::PolicyExpired);
        }
        if self
            .previous_sequence
            .is_some_and(|value| value >= self.sequence)
        {
            return Err(CommunitySearchError::InvalidCatalog(
                "catalog previous sequence must be lower than its sequence".to_owned(),
            ));
        }
        Ok(())
    }
}

pub fn catalog_signer_key_id(verifying_key: &VerifyingKey) -> String {
    hex::encode(Sha256::digest(verifying_key.as_bytes()))[..32].to_owned()
}
