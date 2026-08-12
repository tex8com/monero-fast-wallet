use reqwest::Url;
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, sync::OnceLock};

#[derive(Debug, Deserialize)]
struct Manifest {
    #[serde(rename = "schemaVersion")]
    schema_version: u8,
    profile: String,
    parameters: Parameters,
    features: HashMap<String, bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Parameters {
    #[serde(default)]
    mfw_name_resolver_origins: Vec<String>,
    #[serde(default)]
    mfw_name_genesis: Option<MfwNameGenesisConfig>,
    monero_enthusiast_v1: Option<MoneroEnthusiastV1Config>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MfwNameGenesisConfig {
    pub version: u8,
    pub network: String,
    pub registry_address: String,
    pub registry_private_view_key: String,
    pub activation_height: u64,
    pub maximum_term_years: u32,
    pub commit_maturity_blocks: u64,
    pub commit_reveal_window_blocks: u64,
    pub reserved_name_manifest_hash: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MoneroEnthusiastV1Config {
    pub api_origin: String,
    pub matrix_homeserver: String,
    pub catalog_origin: String,
    pub catalog_scope: String,
    pub catalog_verifying_key_hex: String,
    pub advertising_origin: String,
    pub advertising_verifying_key_hex: String,
    pub advertising_country: String,
    pub artifact_verifying_key_hex: String,
    pub artifact_manifest_resource: String,
    pub pte_resource: String,
    pub tokenizer_resource: String,
    pub conformance_resource: String,
}

fn manifest() -> Option<&'static Manifest> {
    static MANIFEST: OnceLock<Option<Manifest>> = OnceLock::new();
    MANIFEST
        .get_or_init(|| {
            serde_json::from_str::<Manifest>(include_str!(
                "../../../../config/v1-release-features.json"
            ))
            .ok()
            .filter(|manifest| manifest.schema_version == 1 && manifest.profile == "safe-wallet-v1")
        })
        .as_ref()
}

/// Missing, malformed and unknown capabilities always fail closed.
pub fn enabled(feature: &str) -> bool {
    manifest()
        .and_then(|manifest| manifest.features.get(feature))
        .copied()
        .unwrap_or(false)
}

pub fn require(feature: &str, unavailable: &str) -> Result<(), String> {
    enabled(feature)
        .then_some(())
        .ok_or_else(|| unavailable.to_owned())
}

pub fn mfw_name_resolver_origins() -> Option<Vec<String>> {
    if !enabled("mfwNameResolution") && !enabled("mfwNameRegistration") {
        return None;
    }
    let origins = &manifest()?.parameters.mfw_name_resolver_origins;
    validate_mfw_resolver_origins(origins).then(|| {
        origins
            .iter()
            .map(|origin| origin.trim_end_matches('/').to_owned())
            .collect()
    })
}

pub fn mfw_name_genesis(network: &str) -> Option<MfwNameGenesisConfig> {
    if !enabled("mfwNameRegistration") {
        return None;
    }
    let config = manifest()?.parameters.mfw_name_genesis.clone()?;
    (config.network == network && validate_mfw_genesis(&config)).then_some(config)
}

fn validate_mfw_resolver_origins(origins: &[String]) -> bool {
    if origins.len() < 2 || origins.len() > 4 {
        return false;
    }
    let mut normalized = std::collections::HashSet::new();
    origins.iter().all(|origin| {
        let Ok(url) = Url::parse(origin) else {
            return false;
        };
        let valid = url.scheme() == "https"
            && url.host_str().is_some()
            && url.username().is_empty()
            && url.password().is_none()
            && url.query().is_none()
            && url.fragment().is_none()
            && url.path() == "/";
        valid && normalized.insert(url.origin().ascii_serialization().to_ascii_lowercase())
    })
}

fn validate_mfw_genesis(config: &MfwNameGenesisConfig) -> bool {
    config.version == 1
        && matches!(config.network.as_str(), "mainnet" | "testnet" | "stagenet")
        && config.registry_address.len() >= 50
        && config.registry_address.len() <= 150
        && config
            .registry_address
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric())
        && canonical_hex(&config.registry_private_view_key, 32)
        && config.maximum_term_years > 0
        && config.maximum_term_years <= 10
        && config.commit_maturity_blocks > 0
        && config.commit_reveal_window_blocks > config.commit_maturity_blocks
        && canonical_hex(&config.reserved_name_manifest_hash, 32)
}

fn canonical_hex(value: &str, bytes: usize) -> bool {
    value.len() == bytes * 2
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

pub fn monero_enthusiast_v1_config() -> Option<MoneroEnthusiastV1Config> {
    if !enabled("moneroEnthusiastV1") {
        return None;
    }
    let config = manifest()?.parameters.monero_enthusiast_v1.clone()?;
    validate_enthusiast_config(&config).then_some(config)
}

fn validate_enthusiast_config(config: &MoneroEnthusiastV1Config) -> bool {
    for origin in [
        &config.api_origin,
        &config.matrix_homeserver,
        &config.catalog_origin,
        &config.advertising_origin,
    ] {
        let Ok(url) = Url::parse(origin) else {
            return false;
        };
        if url.scheme() != "https"
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || url.path() != "/"
        {
            return false;
        }
    }
    if config.catalog_scope.is_empty()
        || config.catalog_scope.len() > 128
        || config
            .catalog_scope
            .bytes()
            .any(|byte| !(byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_')))
    {
        return false;
    }
    if [
        &config.catalog_verifying_key_hex,
        &config.advertising_verifying_key_hex,
        &config.artifact_verifying_key_hex,
    ]
    .iter()
    .any(|key| {
        key.len() != 64
            || !key
                .bytes()
                .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
    }) {
        return false;
    }
    if config.advertising_country.len() != 2
        || !config
            .advertising_country
            .bytes()
            .all(|byte| byte.is_ascii_uppercase())
    {
        return false;
    }
    [
        &config.artifact_manifest_resource,
        &config.pte_resource,
        &config.tokenizer_resource,
        &config.conformance_resource,
    ]
    .iter()
    .all(|path| {
        !path.is_empty()
            && path.len() <= 256
            && !path.starts_with('/')
            && !path.split('/').any(|part| part.is_empty() || part == "..")
            && path.bytes().all(|byte| {
                byte.is_ascii_alphanumeric() || matches!(byte, b'/' | b'.' | b'-' | b'_')
            })
    })
}

#[cfg(test)]
mod tests {
    use super::{
        enabled, mfw_name_genesis, mfw_name_resolver_origins, monero_enthusiast_v1_config,
        validate_enthusiast_config, validate_mfw_genesis, validate_mfw_resolver_origins,
        MfwNameGenesisConfig, MoneroEnthusiastV1Config,
    };

    #[test]
    fn safe_v1_uses_independent_fast_wallets_and_disables_legacy_paths() {
        assert!(!enabled("plaintextFastWalletHosting"));
        // A Fast Wallet owns independent entropy. It is never a hidden Ledger
        // account whose private view key could be enrolled accidentally.
        assert!(!enabled("ledgerFastWallet"));
        assert!(!enabled("scannerKeyImageSpendAuthority"));
        assert!(!enabled("legacyCommunity"));
        assert!(!enabled("mfwNameResolution"));
        assert!(!enabled("mfwNameRegistration"));
        assert!(mfw_name_resolver_origins().is_none());
        assert!(mfw_name_genesis("mainnet").is_none());
        let community = monero_enthusiast_v1_config()
            .expect("the signed Community V1 test release must have a valid configuration");
        assert_eq!(community.api_origin, "https://xmr.tex8.com");
        assert_eq!(community.catalog_scope, "global-v1");
    }

    #[test]
    fn mfw_release_configuration_is_strict_and_independent() {
        assert!(validate_mfw_resolver_origins(&[
            "https://mfw-a.example/".to_owned(),
            "https://mfw-b.example/".to_owned(),
        ]));
        assert!(!validate_mfw_resolver_origins(&[
            "https://mfw.example/".to_owned(),
            "https://MFW.EXAMPLE/".to_owned(),
        ]));
        assert!(!validate_mfw_resolver_origins(&[
            "http://mfw-a.example/".to_owned(),
            "https://mfw-b.example/path".to_owned(),
        ]));

        let mut genesis = MfwNameGenesisConfig {
            version: 1,
            network: "mainnet".to_owned(),
            registry_address: "4".repeat(95),
            registry_private_view_key: "11".repeat(32),
            activation_height: 3_500_000,
            maximum_term_years: 5,
            commit_maturity_blocks: 10,
            commit_reveal_window_blocks: 720,
            reserved_name_manifest_hash: "22".repeat(32),
        };
        assert!(validate_mfw_genesis(&genesis));
        genesis.commit_reveal_window_blocks = 10;
        assert!(!validate_mfw_genesis(&genesis));
    }

    #[test]
    fn unknown_features_fail_closed() {
        assert!(!enabled("rendererCanOverrideSecurity"));
    }

    #[test]
    fn community_release_configuration_rejects_http_and_unsafe_resources() {
        let mut config = MoneroEnthusiastV1Config {
            api_origin: "https://community.example/".to_owned(),
            matrix_homeserver: "https://matrix.example/".to_owned(),
            catalog_origin: "https://catalog.example/".to_owned(),
            catalog_scope: "global-v1".to_owned(),
            catalog_verifying_key_hex: "a1".repeat(32),
            advertising_origin: "https://advertising.example/".to_owned(),
            advertising_verifying_key_hex: "c3".repeat(32),
            advertising_country: "US".to_owned(),
            artifact_verifying_key_hex: "b2".repeat(32),
            artifact_manifest_resource: "community/artifact.json".to_owned(),
            pte_resource: "community/harrier.pte".to_owned(),
            tokenizer_resource: "community/tokenizer.json".to_owned(),
            conformance_resource: "community/conformance.json".to_owned(),
        };
        assert!(validate_enthusiast_config(&config));
        config.api_origin = "http://community.example/".to_owned();
        assert!(!validate_enthusiast_config(&config));
        config.api_origin = "https://community.example/".to_owned();
        config.pte_resource = "../untrusted.pte".to_owned();
        assert!(!validate_enthusiast_config(&config));
        config.pte_resource = "community/harrier.pte".to_owned();
        config.advertising_country = "usa".to_owned();
        assert!(!validate_enthusiast_config(&config));
    }
}
