use crate::{
    catalog_signer_key_id, model::validate_identifier, CommunitySearchError, ModelContract, Result,
    HARRIER_V1_SOURCE_REVISION, HARRIER_V1_TOKENIZER_SHA256,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs::{self, File},
    io::{BufReader, Read},
    path::Path,
};

const ARTIFACT_SCHEMA_VERSION: u16 = 1;
const ARTIFACT_RUNTIME: &str = "executorch";
const ARTIFACT_RUNTIME_VERSION: &str = "1.3.1";
const EXPORTER_REVISION: &str = "d1140eca622900404c1c5af3f74425034c239f37";
const SOURCE_REPOSITORY: &str = "microsoft/harrier-oss-v1-270m";
const MAX_ARTIFACT_BYTES: u64 = 768 * 1024 * 1024;
const MAX_TOKENIZER_BYTES: u64 = 64 * 1024 * 1024;
const MAX_CONFORMANCE_REPORT_BYTES: u64 = 4 * 1024 * 1024;
const MIN_REFERENCE_CASES: u32 = 32;
const MIN_REFERENCE_COSINE_PPM: u32 = 980_000;
const QUERY_MAX_INPUT_TOKENS: u32 = 256;
const CANONICAL_REFERENCE_SHA256: &str =
    "e5731dc99b676e4186646c9a1d277ad1d20717231ee04f70da0a3fd10d0c39fd";

pub const HARRIER_QUERY_INSTRUCTION_V2: &str =
    "Instruct: Given a community search query, retrieve relevant public profiles, posts, services, products, news, and clearly labeled advertisements\nQuery: ";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HarrierArtifactTarget {
    XnnpackA8w8,
    CoreMlInt8,
}

impl HarrierArtifactTarget {
    fn evidence_backend(self) -> &'static str {
        match self {
            Self::XnnpackA8w8 => "xnnpack-a8w8",
            Self::CoreMlInt8 => "coreml-int8",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct HarrierArtifactManifestUnsigned {
    pub schema_version: u16,
    pub artifact_id: String,
    pub sequence: u64,
    pub source_repository: String,
    pub source_revision: String,
    pub exporter_revision: String,
    pub runtime: String,
    pub runtime_version: String,
    pub target: HarrierArtifactTarget,
    pub minimum_platform_version: String,
    pub max_input_tokens: u32,
    pub query_instruction: String,
    pub model: ModelContract,
    pub artifact_sha256: String,
    pub artifact_bytes: u64,
    pub tokenizer_sha256: String,
    pub tokenizer_bytes: u64,
    pub conformance_report_sha256: String,
    pub conformance_report_bytes: u64,
    pub reference_cases: u32,
    pub measured_min_reference_cosine_ppm: u32,
    pub created_at_ms: u64,
    pub signer_key_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct HarrierArtifactManifest {
    #[serde(flatten)]
    pub unsigned: HarrierArtifactManifestUnsigned,
    pub signature: String,
}

#[derive(Clone, Debug)]
pub struct SignedHarrierArtifactPackage {
    pub manifest_json: Vec<u8>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct HarrierConformanceReport {
    schema_version: u16,
    backend: String,
    runtime: String,
    runtime_version: String,
    artifact_sha256: String,
    reference_sha256: String,
    candidate_sha256: String,
    reference_cases: u32,
    minimum_cosine: f64,
    minimum_cosine_ppm: u32,
    maximum_absolute_difference: f64,
    passed: bool,
    cases: Vec<HarrierConformanceCase>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct HarrierConformanceCase {
    id: String,
    cosine: f64,
    max_abs_difference: f64,
}

impl SignedHarrierArtifactPackage {
    #[allow(clippy::too_many_arguments)]
    pub fn create(
        artifact_id: impl Into<String>,
        sequence: u64,
        target: HarrierArtifactTarget,
        minimum_platform_version: impl Into<String>,
        artifact: &[u8],
        tokenizer: &[u8],
        conformance_report: &[u8],
        reference_cases: u32,
        measured_min_reference_cosine_ppm: u32,
        created_at_ms: u64,
        signing_key: &SigningKey,
    ) -> Result<Self> {
        let unsigned = HarrierArtifactManifestUnsigned {
            schema_version: ARTIFACT_SCHEMA_VERSION,
            artifact_id: artifact_id.into(),
            sequence,
            source_repository: SOURCE_REPOSITORY.to_owned(),
            source_revision: HARRIER_V1_SOURCE_REVISION.to_owned(),
            exporter_revision: EXPORTER_REVISION.to_owned(),
            runtime: ARTIFACT_RUNTIME.to_owned(),
            runtime_version: ARTIFACT_RUNTIME_VERSION.to_owned(),
            target,
            minimum_platform_version: minimum_platform_version.into(),
            max_input_tokens: QUERY_MAX_INPUT_TOKENS,
            query_instruction: HARRIER_QUERY_INSTRUCTION_V2.to_owned(),
            model: ModelContract::harrier_v1(),
            artifact_sha256: hex::encode(Sha256::digest(artifact)),
            artifact_bytes: artifact.len() as u64,
            tokenizer_sha256: hex::encode(Sha256::digest(tokenizer)),
            tokenizer_bytes: tokenizer.len() as u64,
            conformance_report_sha256: hex::encode(Sha256::digest(conformance_report)),
            conformance_report_bytes: conformance_report.len() as u64,
            reference_cases,
            measured_min_reference_cosine_ppm,
            created_at_ms,
            signer_key_id: catalog_signer_key_id(&signing_key.verifying_key()),
        };
        unsigned.validate()?;
        validate_conformance_report(conformance_report, &unsigned)?;
        let signature = signing_key.sign(&unsigned.signing_bytes()?);
        let manifest = HarrierArtifactManifest {
            unsigned,
            signature: URL_SAFE_NO_PAD.encode(signature.to_bytes()),
        };
        let manifest_json = serde_json::to_vec(&manifest).map_err(|error| {
            CommunitySearchError::InvalidCatalog(format!(
                "Harrier artifact manifest could not be encoded: {error}"
            ))
        })?;
        Ok(Self { manifest_json })
    }
}

impl HarrierArtifactManifest {
    pub fn parse_and_verify_manifest(
        manifest_json: &[u8],
        verifying_key: &VerifyingKey,
    ) -> Result<Self> {
        let manifest: Self = serde_json::from_slice(manifest_json).map_err(|error| {
            CommunitySearchError::InvalidCatalog(format!(
                "Harrier artifact manifest is not valid JSON: {error}"
            ))
        })?;
        manifest.unsigned.validate()?;
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

    pub fn parse_and_verify(
        manifest_json: &[u8],
        artifact: &[u8],
        tokenizer: &[u8],
        conformance_report: &[u8],
        verifying_key: &VerifyingKey,
    ) -> Result<Self> {
        let manifest = Self::parse_and_verify_manifest(manifest_json, verifying_key)?;
        verify_blob(
            "Harrier runtime artifact",
            artifact,
            manifest.unsigned.artifact_bytes,
            &manifest.unsigned.artifact_sha256,
        )?;
        verify_blob(
            "Harrier tokenizer",
            tokenizer,
            manifest.unsigned.tokenizer_bytes,
            &manifest.unsigned.tokenizer_sha256,
        )?;
        verify_blob(
            "Harrier conformance report",
            conformance_report,
            manifest.unsigned.conformance_report_bytes,
            &manifest.unsigned.conformance_report_sha256,
        )?;
        validate_conformance_report(conformance_report, &manifest.unsigned)?;
        Ok(manifest)
    }

    /// Verifies a packaged artifact without loading the large PTE into Rust
    /// memory. Callers must keep the verified files in a private, read-only
    /// application directory until the native runtime has opened them.
    pub fn parse_and_verify_files(
        manifest_json: &[u8],
        artifact_path: impl AsRef<Path>,
        tokenizer_path: impl AsRef<Path>,
        conformance_report_path: impl AsRef<Path>,
        verifying_key: &VerifyingKey,
    ) -> Result<Self> {
        let manifest = Self::parse_and_verify_manifest(manifest_json, verifying_key)?;
        verify_file(
            "Harrier runtime artifact",
            artifact_path.as_ref(),
            manifest.unsigned.artifact_bytes,
            &manifest.unsigned.artifact_sha256,
        )?;
        verify_file(
            "Harrier tokenizer",
            tokenizer_path.as_ref(),
            manifest.unsigned.tokenizer_bytes,
            &manifest.unsigned.tokenizer_sha256,
        )?;
        let report_path = conformance_report_path.as_ref();
        verify_file(
            "Harrier conformance report",
            report_path,
            manifest.unsigned.conformance_report_bytes,
            &manifest.unsigned.conformance_report_sha256,
        )?;
        let conformance_report = fs::read(report_path).map_err(|error| {
            CommunitySearchError::Storage(format!(
                "read verified Harrier conformance report: {error}"
            ))
        })?;
        validate_conformance_report(&conformance_report, &manifest.unsigned)?;
        Ok(manifest)
    }
}

impl HarrierArtifactManifestUnsigned {
    fn validate(&self) -> Result<()> {
        if self.schema_version != ARTIFACT_SCHEMA_VERSION
            || self.sequence == 0
            || self.created_at_ms == 0
        {
            return invalid("Harrier artifact schema, sequence, or creation time is invalid");
        }
        validate_identifier("Harrier artifact id", &self.artifact_id, 128)?;
        validate_identifier(
            "Harrier minimum platform version",
            &self.minimum_platform_version,
            64,
        )?;
        validate_identifier("Harrier artifact signer key id", &self.signer_key_id, 64)?;
        if self.source_repository != SOURCE_REPOSITORY
            || self.source_revision != HARRIER_V1_SOURCE_REVISION
            || self.exporter_revision != EXPORTER_REVISION
            || self.runtime != ARTIFACT_RUNTIME
            || self.runtime_version != ARTIFACT_RUNTIME_VERSION
            || self.max_input_tokens != QUERY_MAX_INPUT_TOKENS
            || self.query_instruction != HARRIER_QUERY_INSTRUCTION_V2
            || self.model != ModelContract::harrier_v1()
            || self.tokenizer_sha256 != HARRIER_V1_TOKENIZER_SHA256
        {
            return invalid("Harrier artifact does not match the pinned V1 runtime contract");
        }
        validate_sha256("Harrier artifact", &self.artifact_sha256)?;
        validate_sha256("Harrier tokenizer", &self.tokenizer_sha256)?;
        validate_sha256(
            "Harrier conformance report",
            &self.conformance_report_sha256,
        )?;
        if self.artifact_bytes == 0
            || self.artifact_bytes > MAX_ARTIFACT_BYTES
            || self.tokenizer_bytes == 0
            || self.tokenizer_bytes > MAX_TOKENIZER_BYTES
            || self.conformance_report_bytes == 0
            || self.conformance_report_bytes > MAX_CONFORMANCE_REPORT_BYTES
        {
            return invalid("Harrier artifact package size is invalid");
        }
        if self.reference_cases < MIN_REFERENCE_CASES
            || self.measured_min_reference_cosine_ppm < MIN_REFERENCE_COSINE_PPM
            || self.measured_min_reference_cosine_ppm > 1_000_000
        {
            return invalid("Harrier artifact has not passed the V1 reference-vector threshold");
        }
        Ok(())
    }

    fn signing_bytes(&self) -> Result<Vec<u8>> {
        serde_json::to_vec(self).map_err(|error| {
            CommunitySearchError::InvalidCatalog(format!(
                "Harrier artifact signature payload could not be encoded: {error}"
            ))
        })
    }
}

fn verify_blob(
    label: &str,
    bytes: &[u8],
    expected_bytes: u64,
    expected_sha256: &str,
) -> Result<()> {
    if bytes.len() as u64 != expected_bytes || hex::encode(Sha256::digest(bytes)) != expected_sha256
    {
        return Err(CommunitySearchError::PayloadHashMismatch);
    }
    if bytes.is_empty() {
        return invalid(format!("{label} cannot be empty"));
    }
    Ok(())
}

fn verify_file(label: &str, path: &Path, expected_bytes: u64, expected_sha256: &str) -> Result<()> {
    let link_metadata = fs::symlink_metadata(path)
        .map_err(|error| CommunitySearchError::Storage(format!("inspect {label} file: {error}")))?;
    if link_metadata.file_type().is_symlink() || !link_metadata.is_file() {
        return invalid(format!("{label} must be a regular non-symlink file"));
    }
    if link_metadata.len() != expected_bytes || expected_bytes == 0 {
        return Err(CommunitySearchError::PayloadHashMismatch);
    }

    let file = File::open(path)
        .map_err(|error| CommunitySearchError::Storage(format!("open {label} file: {error}")))?;
    let opened_metadata = file.metadata().map_err(|error| {
        CommunitySearchError::Storage(format!("inspect opened {label} file: {error}"))
    })?;
    if !opened_metadata.is_file() || opened_metadata.len() != expected_bytes {
        return Err(CommunitySearchError::PayloadHashMismatch);
    }
    let mut reader = BufReader::with_capacity(1024 * 1024, file);
    let mut digest = Sha256::new();
    // Mobile worker threads can have stacks smaller than one MiB. Keep the
    // bounded hashing buffer on the heap so artifact verification cannot
    // overflow an iOS thread stack before the runtime is opened.
    let mut buffer = vec![0_u8; 1024 * 1024];
    let mut measured_bytes = 0_u64;
    loop {
        let read = reader.read(&mut buffer).map_err(|error| {
            CommunitySearchError::Storage(format!("hash {label} file: {error}"))
        })?;
        if read == 0 {
            break;
        }
        measured_bytes = measured_bytes
            .checked_add(read as u64)
            .ok_or_else(|| CommunitySearchError::InvalidCatalog(format!("{label} is too large")))?;
        if measured_bytes > expected_bytes {
            return Err(CommunitySearchError::PayloadHashMismatch);
        }
        digest.update(&buffer[..read]);
    }
    if measured_bytes != expected_bytes || hex::encode(digest.finalize()) != expected_sha256 {
        return Err(CommunitySearchError::PayloadHashMismatch);
    }
    Ok(())
}

fn validate_conformance_report(
    bytes: &[u8],
    manifest: &HarrierArtifactManifestUnsigned,
) -> Result<()> {
    let report: HarrierConformanceReport = serde_json::from_slice(bytes).map_err(|error| {
        CommunitySearchError::InvalidCatalog(format!(
            "Harrier conformance report is invalid: {error}"
        ))
    })?;
    validate_sha256("Harrier conformance candidate", &report.candidate_sha256)?;
    validate_sha256("Harrier conformance artifact", &report.artifact_sha256)?;
    validate_sha256("Harrier conformance reference", &report.reference_sha256)?;
    if report.schema_version != 1
        || report.backend != manifest.target.evidence_backend()
        || report.runtime != ARTIFACT_RUNTIME
        || report.runtime_version != ARTIFACT_RUNTIME_VERSION
        || report.artifact_sha256 != manifest.artifact_sha256
        || report.reference_sha256 != CANONICAL_REFERENCE_SHA256
        || report.reference_cases != manifest.reference_cases
        || report.minimum_cosine_ppm != manifest.measured_min_reference_cosine_ppm
        || !report.passed
        || report.reference_cases < MIN_REFERENCE_CASES
        || report.minimum_cosine_ppm < MIN_REFERENCE_COSINE_PPM
        || report.cases.len() != report.reference_cases as usize
        || !report.minimum_cosine.is_finite()
        || !report.maximum_absolute_difference.is_finite()
        || !(0.0..=1.0).contains(&report.minimum_cosine)
        || report.maximum_absolute_difference < 0.0
        || (report.minimum_cosine * 1_000_000.0).round() as u32 != report.minimum_cosine_ppm
    {
        return invalid("Harrier conformance evidence does not match the signed artifact");
    }

    let mut identifiers = HashSet::with_capacity(report.cases.len());
    let mut measured_minimum = 1.0_f64;
    let mut measured_maximum_difference = 0.0_f64;
    for case in &report.cases {
        validate_identifier("Harrier conformance case id", &case.id, 128)?;
        if !identifiers.insert(case.id.as_str())
            || !case.cosine.is_finite()
            || !case.max_abs_difference.is_finite()
            || !(0.0..=1.0).contains(&case.cosine)
            || case.max_abs_difference < 0.0
        {
            return invalid("Harrier conformance report contains an invalid case");
        }
        measured_minimum = measured_minimum.min(case.cosine);
        measured_maximum_difference = measured_maximum_difference.max(case.max_abs_difference);
    }
    if (measured_minimum - report.minimum_cosine).abs() > 1e-12
        || (measured_maximum_difference - report.maximum_absolute_difference).abs() > 1e-12
    {
        return invalid("Harrier conformance aggregate does not match its cases");
    }
    Ok(())
}

fn validate_sha256(label: &str, value: &str) -> Result<()> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return invalid(format!("{label} SHA-256 is invalid"));
    }
    Ok(())
}

fn invalid<T>(message: impl Into<String>) -> Result<T> {
    Err(CommunitySearchError::InvalidCatalog(message.into()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::rngs::OsRng;
    use std::io::Write;
    use tempfile::NamedTempFile;

    const NOW: u64 = 2_000_000_000_000;

    fn unsigned(key: &SigningKey, measured_cosine_ppm: u32) -> HarrierArtifactManifestUnsigned {
        HarrierArtifactManifestUnsigned {
            schema_version: ARTIFACT_SCHEMA_VERSION,
            artifact_id: "harrier-xnnpack-a8w8-v1".to_owned(),
            sequence: 1,
            source_repository: SOURCE_REPOSITORY.to_owned(),
            source_revision: HARRIER_V1_SOURCE_REVISION.to_owned(),
            exporter_revision: EXPORTER_REVISION.to_owned(),
            runtime: ARTIFACT_RUNTIME.to_owned(),
            runtime_version: ARTIFACT_RUNTIME_VERSION.to_owned(),
            target: HarrierArtifactTarget::XnnpackA8w8,
            minimum_platform_version: "portable-v1".to_owned(),
            max_input_tokens: QUERY_MAX_INPUT_TOKENS,
            query_instruction: HARRIER_QUERY_INSTRUCTION_V2.to_owned(),
            model: ModelContract::harrier_v1(),
            artifact_sha256: hex::encode(Sha256::digest(b"pte")),
            artifact_bytes: 3,
            tokenizer_sha256: HARRIER_V1_TOKENIZER_SHA256.to_owned(),
            tokenizer_bytes: 33_385_008,
            conformance_report_sha256: hex::encode(Sha256::digest(b"report")),
            conformance_report_bytes: 6,
            reference_cases: 64,
            measured_min_reference_cosine_ppm: measured_cosine_ppm,
            created_at_ms: NOW,
            signer_key_id: catalog_signer_key_id(&key.verifying_key()),
        }
    }

    fn evidence(unsigned: &HarrierArtifactManifestUnsigned) -> Vec<u8> {
        let cases = (0..unsigned.reference_cases)
            .map(|index| {
                serde_json::json!({
                    "id": format!("case-{index}"),
                    "cosine": 0.99,
                    "maxAbsDifference": 0.01
                })
            })
            .collect::<Vec<_>>();
        serde_json::to_vec(&serde_json::json!({
            "schemaVersion": 1,
            "backend": unsigned.target.evidence_backend(),
            "runtime": ARTIFACT_RUNTIME,
            "runtimeVersion": ARTIFACT_RUNTIME_VERSION,
            "artifactSha256": unsigned.artifact_sha256,
            "referenceSha256": CANONICAL_REFERENCE_SHA256,
            "candidateSha256": hex::encode(Sha256::digest(b"candidate")),
            "referenceCases": unsigned.reference_cases,
            "minimumCosine": 0.99,
            "minimumCosinePpm": 990_000,
            "maximumAbsoluteDifference": 0.01,
            "passed": true,
            "cases": cases
        }))
        .unwrap()
    }

    #[test]
    fn streamed_file_verification_rejects_changed_size_and_hash() {
        let mut file = NamedTempFile::new().expect("temporary artifact");
        file.write_all(b"verified-pte").expect("write artifact");
        file.flush().expect("flush artifact");
        let digest = hex::encode(Sha256::digest(b"verified-pte"));
        verify_file(
            "test artifact",
            file.path(),
            b"verified-pte".len() as u64,
            &digest,
        )
        .expect("matching file");
        assert!(matches!(
            verify_file(
                "test artifact",
                file.path(),
                b"verified-pte".len() as u64,
                &hex::encode(Sha256::digest(b"other-value")),
            ),
            Err(CommunitySearchError::PayloadHashMismatch)
        ));
        assert!(matches!(
            verify_file(
                "test artifact",
                file.path(),
                b"verified-pte".len() as u64 + 1,
                &digest,
            ),
            Err(CommunitySearchError::PayloadHashMismatch)
        ));
    }

    #[test]
    fn signed_manifest_is_verified_before_assets_are_downloaded() {
        let key = SigningKey::generate(&mut OsRng);
        let unsigned = unsigned(&key, 990_000);
        let signature = key.sign(&unsigned.signing_bytes().unwrap());
        let manifest = HarrierArtifactManifest {
            unsigned,
            signature: URL_SAFE_NO_PAD.encode(signature.to_bytes()),
        };
        let json = serde_json::to_vec(&manifest).unwrap();
        assert_eq!(
            HarrierArtifactManifest::parse_and_verify_manifest(&json, &key.verifying_key())
                .unwrap()
                .unsigned
                .artifact_id,
            "harrier-xnnpack-a8w8-v1"
        );
    }

    #[test]
    fn measured_reference_threshold_is_mandatory() {
        let key = SigningKey::generate(&mut OsRng);
        assert!(unsigned(&key, 979_999).validate().is_err());
        assert!(unsigned(&key, 980_000).validate().is_ok());
    }

    #[test]
    fn legacy_monero_biased_query_prompt_is_rejected() {
        let key = SigningKey::generate(&mut OsRng);
        let mut legacy = unsigned(&key, 990_000);
        legacy.query_instruction =
            "Instruct: Given a Monero community search query, retrieve relevant public profiles, posts, services, products, news, and clearly labeled advertisements\nQuery: "
                .to_owned();
        legacy.model.query_prompt_version = "community-query-v1".to_owned();
        assert!(legacy.validate().is_err());
    }

    #[test]
    fn conformance_evidence_is_bound_to_artifact_backend_and_reference() {
        let key = SigningKey::generate(&mut OsRng);
        let unsigned = unsigned(&key, 990_000);
        assert!(validate_conformance_report(&evidence(&unsigned), &unsigned).is_ok());

        let mut wrong_artifact =
            serde_json::from_slice::<serde_json::Value>(&evidence(&unsigned)).unwrap();
        wrong_artifact["artifactSha256"] =
            serde_json::Value::String(hex::encode(Sha256::digest(b"other")));
        assert!(validate_conformance_report(
            &serde_json::to_vec(&wrong_artifact).unwrap(),
            &unsigned
        )
        .is_err());

        let mut duplicate_case =
            serde_json::from_slice::<serde_json::Value>(&evidence(&unsigned)).unwrap();
        duplicate_case["cases"][1]["id"] = duplicate_case["cases"][0]["id"].clone();
        assert!(validate_conformance_report(
            &serde_json::to_vec(&duplicate_case).unwrap(),
            &unsigned
        )
        .is_err());
    }
}
