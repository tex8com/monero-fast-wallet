use community_search_core::{
    HarrierArtifactManifest, HarrierArtifactTarget, SignedHarrierArtifactPackage,
};
use ed25519_dalek::SigningKey;
use rand::rngs::OsRng;

const NOW: u64 = 2_000_000_000_000;

#[test]
fn artifact_package_rejects_a_non_pinned_tokenizer() {
    let key = SigningKey::generate(&mut OsRng);
    assert!(SignedHarrierArtifactPackage::create(
        "harrier-xnnpack-a8w8-v1",
        1,
        HarrierArtifactTarget::XnnpackA8w8,
        "portable-v1",
        b"pte",
        b"not-the-pinned-tokenizer",
        b"report",
        64,
        990_000,
        NOW,
        &key,
    )
    .is_err());
}

#[test]
fn manifest_parser_rejects_unknown_or_unsigned_data() {
    let key = SigningKey::generate(&mut OsRng);
    assert!(HarrierArtifactManifest::parse_and_verify(
        br#"{"schemaVersion":1}"#,
        b"pte",
        b"tokenizer",
        b"report",
        &key.verifying_key(),
    )
    .is_err());
}
