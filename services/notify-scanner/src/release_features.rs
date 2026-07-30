use serde::Deserialize;
use std::{collections::HashMap, sync::OnceLock};

#[derive(Debug, Deserialize)]
struct Manifest {
    #[serde(rename = "schemaVersion")]
    schema_version: u8,
    profile: String,
    features: HashMap<String, bool>,
}

fn manifest() -> Option<&'static Manifest> {
    static MANIFEST: OnceLock<Option<Manifest>> = OnceLock::new();
    MANIFEST
        .get_or_init(|| {
            serde_json::from_str::<Manifest>(include_str!(
                "../../../config/v1-release-features.json"
            ))
            .ok()
            .filter(|manifest| manifest.schema_version == 1 && manifest.profile == "safe-wallet-v1")
        })
        .as_ref()
}

/// Unknown, missing and malformed release capabilities always fail closed.
pub fn enabled(feature: &str) -> bool {
    manifest()
        .and_then(|manifest| manifest.features.get(feature))
        .copied()
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::enabled;

    #[test]
    fn v1_rejects_legacy_plaintext_hosting_and_key_image_authority() {
        assert!(!enabled("plaintextFastWalletHosting"));
        assert!(!enabled("scannerKeyImageSpendAuthority"));
        assert!(!enabled("unknownScannerCapability"));
    }
}
