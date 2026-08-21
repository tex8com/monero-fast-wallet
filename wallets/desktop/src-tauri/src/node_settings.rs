use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Write,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager};

const SETTINGS_FILE: &str = "node-settings.json";
const SETTINGS_VERSION: u8 = 1;

/// Public node connection metadata. Passwords are never serialized here; the
/// boolean only indicates that an OS-keychain credential exists.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeProfile {
    pub mode: String,
    pub network: String,
    pub daemon_address: String,
    pub grpc_endpoint: String,
    pub trusted: bool,
    pub use_ssl: bool,
    pub username: String,
    pub proxy_address: String,
    pub password_stored: bool,
    pub updated_at: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct NodeSettingsFile {
    version: u8,
    profiles: Vec<NodeProfile>,
}

impl Default for NodeSettingsFile {
    fn default() -> Self {
        Self {
            version: SETTINGS_VERSION,
            profiles: Vec::new(),
        }
    }
}

pub fn default_profile(network: &str) -> Result<NodeProfile, String> {
    validate_network(network)?;
    let (daemon_port, grpc_port) = ports(network, "optimized-grpc")?;
    let split_mainnet = network == "mainnet";
    Ok(NodeProfile {
        mode: "optimized-grpc".to_owned(),
        network: network.to_owned(),
        daemon_address: if split_mainnet {
            "fastrelayrpcf3hbc4qvykjgbpwpmcuq5dpcsdxoe7gwfh2zxdib3eid.onion:18089".to_owned()
        } else {
            format!("xmr.tex8.com:{daemon_port}")
        },
        grpc_endpoint: format!("xmr.tex8.com:{grpc_port}"),
        trusted: true,
        use_ssl: false,
        username: String::new(),
        proxy_address: crate::tor_transport::TOR_SOCKS_ADDRESS.to_owned(),
        password_stored: false,
        updated_at: now(),
    })
}

pub fn load(app: &AppHandle, network: &str) -> Result<NodeProfile, String> {
    validate_network(network)?;
    let settings = read(app)?;
    settings
        .profiles
        .into_iter()
        .find(|profile| profile.network == network)
        .map(Ok)
        .unwrap_or_else(|| default_profile(network))
}

pub fn save(app: &AppHandle, mut profile: NodeProfile) -> Result<NodeProfile, String> {
    profile.updated_at = now();
    validate_profile(&profile)?;
    let mut settings = read(app)?;
    if let Some(index) = settings
        .profiles
        .iter()
        .position(|existing| existing.network == profile.network)
    {
        settings.profiles[index] = profile.clone();
    } else {
        settings.profiles.push(profile.clone());
    }
    write(app, settings)?;
    Ok(profile)
}

// This mirrors the flat Tauri command payload. Keeping the independently
// validated connection fields explicit prevents hidden defaults.
#[allow(clippy::too_many_arguments)]
pub fn profile(
    mode: String,
    network: String,
    daemon_address: String,
    grpc_endpoint: String,
    trusted: bool,
    use_ssl: bool,
    username: String,
    proxy_address: String,
    password_stored: bool,
) -> Result<NodeProfile, String> {
    let mode = mode.trim().to_owned();
    let network = network.trim().to_owned();
    validate_mode(&mode)?;
    let mut profile = NodeProfile {
        mode: mode.clone(),
        network: network.clone(),
        daemon_address: daemon_address.trim().to_owned(),
        grpc_endpoint: grpc_endpoint.trim().to_owned(),
        trusted,
        use_ssl,
        username: username.trim().to_owned(),
        proxy_address: proxy_address.trim().to_owned(),
        password_stored,
        updated_at: now(),
    };
    if profile.daemon_address.is_empty() {
        profile.daemon_address = format!("xmr.tex8.com:{}", ports(&network, &mode)?.0);
    }
    if profile.mode == "optimized-grpc" && profile.grpc_endpoint.is_empty() {
        profile.grpc_endpoint = format!("xmr.tex8.com:{}", ports(&network, &mode)?.1);
    }
    if profile.mode != "optimized-grpc" {
        profile.grpc_endpoint.clear();
    }
    validate_profile(&profile)?;
    Ok(profile)
}

fn read(app: &AppHandle) -> Result<NodeSettingsFile, String> {
    let path = settings_path(app)?;
    match fs::read_to_string(path) {
        Ok(value) => serde_json::from_str::<NodeSettingsFile>(&value)
            .map_err(|_| "The node settings could not be read safely.".to_owned())
            .and_then(normalize),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Ok(NodeSettingsFile::default())
        }
        Err(_) => Err("The node settings could not be read.".to_owned()),
    }
}

fn normalize(mut settings: NodeSettingsFile) -> Result<NodeSettingsFile, String> {
    if settings.version != SETTINGS_VERSION {
        return Err("The node settings use an unsupported version.".to_owned());
    }
    let mut profiles = Vec::with_capacity(settings.profiles.len());
    for mut profile in settings.profiles.drain(..) {
        validate_mode(&profile.mode)?;
        if profile.mode == "optimized-grpc" && profile.network == "mainnet" {
            profile.daemon_address = match profile.daemon_address.as_str() {
                "xmr.tex8.com:18089" => {
                    "fastrelayrpcf3hbc4qvykjgbpwpmcuq5dpcsdxoe7gwfh2zxdib3eid.onion:18089"
                        .to_owned()
                }
                "199.30.65.42:18089" => {
                    "quietportrpccujodzxhwcfefbmhftof5i6oiq7rrx5tnzna7rxirhqd.onion:18089"
                        .to_owned()
                }
                _ => profile.daemon_address,
            };
        }
        if profile.mode == "optimized-grpc" && profile.grpc_endpoint.trim().is_empty() {
            profile.grpc_endpoint = format!(
                "xmr.tex8.com:{}",
                ports(&profile.network, "optimized-grpc")?.1
            );
        }
        if profile.mode != "optimized-grpc" {
            profile.grpc_endpoint.clear();
        }
        validate_profile(&profile)?;
        if let Some(index) = profiles
            .iter()
            .position(|item: &NodeProfile| item.network == profile.network)
        {
            profiles[index] = profile;
        } else {
            profiles.push(profile);
        }
    }
    settings.profiles = profiles;
    Ok(settings)
}

fn write(app: &AppHandle, settings: NodeSettingsFile) -> Result<(), String> {
    let settings = normalize(settings)?;
    let path = settings_path(app)?;
    let directory = path
        .parent()
        .ok_or_else(|| "Wallet data directory is unavailable.".to_owned())?;
    fs::create_dir_all(directory)
        .map_err(|_| "Wallet data directory could not be created.".to_owned())?;
    let content = serde_json::to_vec_pretty(&settings)
        .map_err(|_| "The node settings could not be encoded.".to_owned())?;
    let temporary = path.with_extension("json.tmp");
    let mut file = fs::File::create(&temporary)
        .map_err(|_| "The node settings could not be saved.".to_owned())?;
    file.write_all(&content)
        .and_then(|_| file.sync_all())
        .map_err(|_| "The node settings could not be saved.".to_owned())?;
    fs::rename(temporary, path).map_err(|_| "The node settings could not be saved.".to_owned())
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|directory| directory.join("wallets").join(SETTINGS_FILE))
        .map_err(|_| "Wallet data directory is unavailable.".to_owned())
}

fn validate_profile(profile: &NodeProfile) -> Result<(), String> {
    validate_network(&profile.network)?;
    validate_mode(&profile.mode)?;
    if !endpoint(&profile.daemon_address)
        || (profile.mode == "optimized-grpc" && !endpoint(&profile.grpc_endpoint))
        || (profile.mode != "optimized-grpc" && !profile.grpc_endpoint.is_empty())
        || profile.username.len() > 128
        || profile.proxy_address.len() > 240
        || profile.username.chars().any(char::is_control)
        || profile.proxy_address.chars().any(char::is_control)
    {
        return Err("The node settings contain invalid data.".to_owned());
    }
    Ok(())
}

fn validate_mode(mode: &str) -> Result<(), String> {
    if matches!(mode, "optimized-grpc" | "original-rpc" | "custom") {
        Ok(())
    } else {
        Err("Unknown node connection mode.".to_owned())
    }
}

fn endpoint(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 240
        && !value
            .chars()
            .any(|character| character.is_control() || character.is_whitespace())
}

fn validate_network(network: &str) -> Result<(), String> {
    if matches!(network, "mainnet" | "testnet" | "stagenet") {
        Ok(())
    } else {
        Err("Unknown wallet network.".to_owned())
    }
}

fn ports(network: &str, mode: &str) -> Result<(u16, u16), String> {
    validate_network(network)?;
    let daemon = match (network, mode) {
        ("mainnet", "optimized-grpc") => 18089,
        ("testnet", "optimized-grpc") => 28089,
        ("stagenet", "optimized-grpc") => 38089,
        ("mainnet", _) => 18081,
        ("testnet", _) => 28081,
        ("stagenet", _) => 38081,
        _ => return Err("Unknown node mode.".to_owned()),
    };
    let grpc = match network {
        "mainnet" => 18091,
        "testnet" => 28091,
        "stagenet" => 38091,
        _ => unreachable!("validated network"),
    };
    Ok((daemon, grpc))
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[cfg(test)]
mod tests {
    use super::{default_profile, profile};

    #[test]
    fn optimized_default_uses_the_monero_fast_node_ports() {
        let profile = default_profile("stagenet").expect("default profile");
        assert_eq!(profile.daemon_address, "xmr.tex8.com:38089");
        assert_eq!(profile.grpc_endpoint, "xmr.tex8.com:38091");
    }

    #[test]
    fn original_rpc_profile_keeps_standard_monero_rpc_and_disables_grpc() {
        let profile = profile(
            "original-rpc".to_owned(),
            "mainnet".to_owned(),
            String::new(),
            "ignored:18091".to_owned(),
            true,
            false,
            String::new(),
            String::new(),
            false,
        )
        .expect("original RPC profile");
        assert_eq!(profile.mode, "original-rpc");
        assert_eq!(profile.daemon_address, "xmr.tex8.com:18081");
        assert!(profile.grpc_endpoint.is_empty());
        assert!(profile.proxy_address.is_empty());
    }

    #[test]
    fn custom_profile_never_carries_an_mfn_grpc_endpoint() {
        let profile = profile(
            "custom".to_owned(),
            "mainnet".to_owned(),
            "node.example:18081".to_owned(),
            "xmr.tex8.com:18091".to_owned(),
            false,
            false,
            String::new(),
            "127.0.0.1:9050".to_owned(),
            false,
        )
        .expect("custom profile");
        assert_eq!(profile.mode, "custom");
        assert_eq!(profile.daemon_address, "node.example:18081");
        assert!(profile.grpc_endpoint.is_empty());
        assert_eq!(profile.proxy_address, "127.0.0.1:9050");
    }

    #[test]
    fn public_profile_does_not_have_a_password_field() {
        let profile = default_profile("mainnet").expect("default profile");
        let encoded = serde_json::to_string(&profile).expect("encode profile");
        assert!(!encoded.contains("\"password\":"));
    }
}
