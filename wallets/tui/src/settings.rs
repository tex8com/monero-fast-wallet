//! Settings and Menu surfaces that mirror the Tauri 2 desktop wallet.

use crate::action::NetworkChoice;
use crate::backend::NodeConnection;
use serde::{Deserialize, Serialize};
use std::cell::RefCell;
use std::path::PathBuf;
use zeroize::Zeroizing;

pub const MFW_NAME_REGISTRATION: bool = true;
pub const PRIVATE_WORKER_PAIRING: bool = true;

const APP_ID: &str = "com.tex8.monerowallet.desktop";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MenuItem {
    Wallets,
    MfwNames,
    Settings,
    Node,
    Project,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MenuEntry {
    pub item: MenuItem,
    pub title: &'static str,
    pub hint: &'static str,
}

pub fn menu_items() -> Vec<MenuEntry> {
    let mut items = vec![MenuEntry {
        item: MenuItem::Wallets,
        title: "Manage wallets",
        hint: "Manage and rename local wallets.",
    }];
    if MFW_NAME_REGISTRATION {
        items.push(MenuEntry {
            item: MenuItem::MfwNames,
            title: "Your Address Names",
            hint: "Claim a memorable public .mfw name for a Monero receive address.",
        });
    }
    items.push(MenuEntry {
        item: MenuItem::Settings,
        title: "Settings",
        hint: "Configure wallet.",
    });
    items.push(MenuEntry {
        item: MenuItem::Node,
        title: "Node Status",
        hint: "Connection status.",
    });
    items
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum WorkerKind {
    #[default]
    Recommended,
    Community,
    Private,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum ComputeBackend {
    #[default]
    Cpu,
    Metal,
    Cuda,
}

impl ComputeBackend {
    pub fn label(self) -> &'static str {
        match self {
            Self::Cpu => "CPU",
            Self::Metal => "Metal",
            Self::Cuda => "CUDA",
        }
    }

    pub fn available(self) -> bool {
        match self {
            Self::Cpu => true,
            Self::Metal => cfg!(target_os = "macos"),
            Self::Cuda => cfg!(not(target_os = "macos")),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum ProtectionMode {
    #[default]
    None,
    System,
    Password,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum NodeMode {
    #[default]
    OptimizedGrpc,
    OriginalRpc,
    Custom,
}

impl NodeMode {
    pub fn label(self) -> &'static str {
        match self {
            Self::OptimizedGrpc => "MFN fast sync",
            Self::OriginalRpc => "Original RPC",
            Self::Custom => "Custom RPC",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NodePreset {
    Tex8,
    Community,
}

impl NodePreset {
    pub fn label(self) -> &'static str {
        match self {
            Self::Tex8 => "TEX8 Node",
            Self::Community => "Community Node",
        }
    }

    pub fn clearnet_host(self) -> &'static str {
        match self {
            Self::Tex8 => "xmr.tex8.com",
            Self::Community => "199.30.65.42",
        }
    }

    pub fn onion_host(self) -> &'static str {
        match self {
            Self::Tex8 => "fastrelayrpcf3hbc4qvykjgbpwpmcuq5dpcsdxoe7gwfh2zxdib3eid.onion",
            Self::Community => "quietportrpccujodzxhwcfefbmhftof5i6oiq7rrx5tnzna7rxirhqd.onion",
        }
    }

    pub fn grpc(self) -> String {
        format!("{}:18091", self.clearnet_host())
    }

    pub fn onion_daemon(self) -> String {
        format!("{}:18089", self.onion_host())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Language {
    pub code: &'static str,
    pub name: &'static str,
}

pub const LANGUAGES: [Language; 18] = [
    Language {
        code: "en",
        name: "English",
    },
    Language {
        code: "de",
        name: "Deutsch",
    },
    Language {
        code: "es",
        name: "Español",
    },
    Language {
        code: "pt-BR",
        name: "Português (Brasil)",
    },
    Language {
        code: "ru",
        name: "Русский",
    },
    Language {
        code: "vi",
        name: "Tiếng Việt",
    },
    Language {
        code: "id",
        name: "Bahasa Indonesia",
    },
    Language {
        code: "uk",
        name: "Українська",
    },
    Language {
        code: "tr",
        name: "Türkçe",
    },
    Language {
        code: "hi",
        name: "हिन्दी",
    },
    Language {
        code: "ur",
        name: "اردو",
    },
    Language {
        code: "fr",
        name: "Français",
    },
    Language {
        code: "fil",
        name: "Filipino",
    },
    Language {
        code: "ja",
        name: "日本語",
    },
    Language {
        code: "ko",
        name: "한국어",
    },
    Language {
        code: "ar",
        name: "العربية",
    },
    Language {
        code: "zh-CN",
        name: "简体中文",
    },
    Language {
        code: "zh-TW",
        name: "繁體中文",
    },
];

pub const AUTO_LOCK_OPTIONS: [(u32, &str); 6] = [
    (60, "1 minute"),
    (300, "5 minutes"),
    (900, "15 minutes"),
    (1800, "30 minutes (default)"),
    (3600, "1 hour"),
    (0, "Never (not recommended)"),
];

pub struct ProjectAddress {
    pub label: &'static str,
    pub transport: &'static str,
    pub address: &'static str,
}

pub const PROJECT_ADDRESSES: [ProjectAddress; 4] = [
    ProjectAddress {
        label: "TEX8",
        transport: "Clearnet",
        address: "xmr.tex8.com",
    },
    ProjectAddress {
        label: "Community",
        transport: "Clearnet",
        address: "mfw-resolver2.tex8.com",
    },
    ProjectAddress {
        label: "TEX8 Onion",
        transport: "Onion",
        address: "fastrelayrpcf3hbc4qvykjgbpwpmcuq5dpcsdxoe7gwfh2zxdib3eid.onion",
    },
    ProjectAddress {
        label: "Community Onion",
        transport: "Onion",
        address: "quietportrpccujodzxhwcfefbmhftof5i6oiq7rrx5tnzna7rxirhqd.onion",
    },
];

pub const PROJECT_SERVICES: [&str; 6] = [
    "Monero Fast Wallet",
    "Monero Fast Node",
    "Relay Service",
    "Fast Wallet Worker",
    "Monero Name Registry",
    "All services",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PersistedSettings {
    #[serde(default)]
    worker: WorkerKind,
    #[serde(default = "default_language")]
    language: String,
    #[serde(default)]
    compute: ComputeBackend,
    #[serde(default = "default_true")]
    share_searches: bool,
    #[serde(default)]
    protection: ProtectionMode,
    #[serde(default = "default_auto_lock")]
    auto_lock_seconds: u32,
    #[serde(default)]
    node_network: String,
    #[serde(default)]
    node_mode: NodeMode,
    #[serde(default)]
    daemon_address: String,
    #[serde(default)]
    grpc_endpoint: String,
    #[serde(default)]
    proxy_address: String,
}

fn default_language() -> String {
    "en".into()
}
fn default_true() -> bool {
    true
}
fn default_auto_lock() -> u32 {
    1800
}

pub struct SettingsState {
    pub worker: WorkerKind,
    pub worker_label: String,
    pub private_worker: String,
    pub show_private_worker: bool,
    pub language: &'static str,
    pub compute: ComputeBackend,
    pub share_searches: bool,
    pub protection: ProtectionMode,
    pub auto_lock_seconds: u32,
    pub node_network: NetworkChoice,
    pub node_mode: NodeMode,
    pub daemon_address: String,
    pub grpc_endpoint: String,
    pub proxy_address: String,
    pub scroll: u16,
    pub seed_reveal: Option<Zeroizing<String>>,
    pub message: Option<String>,
    pub locked: bool,
    pub app_password: Zeroizing<String>,
    pub app_password_confirm: Zeroizing<String>,
    pub current_app_password: Zeroizing<String>,
    pub mfw_name: String,
    pub mfw_years: u32,
    cached_cli: RefCell<Option<NodeConnection>>,
}

impl SettingsState {
    pub fn load() -> Self {
        let mut state = Self::defaults();
        state.overlay_desktop_node_settings();
        if let Ok(raw) = std::fs::read_to_string(settings_path()) {
            if let Ok(saved) = serde_json::from_str::<PersistedSettings>(&raw) {
                state.worker = saved.worker;
                state.language = LANGUAGES
                    .iter()
                    .find(|item| item.code == saved.language)
                    .map(|item| item.code)
                    .unwrap_or("en");
                state.compute = saved.compute;
                state.share_searches = saved.share_searches;
                state.protection = saved.protection;
                state.auto_lock_seconds = saved.auto_lock_seconds;
                state.node_network = match saved.node_network.as_str() {
                    "testnet" => NetworkChoice::Testnet,
                    "stagenet" => NetworkChoice::Stagenet,
                    _ => NetworkChoice::Mainnet,
                };
                state.node_mode = saved.node_mode;
                if !saved.daemon_address.is_empty() {
                    state.daemon_address = saved.daemon_address;
                }
                if !saved.grpc_endpoint.is_empty() {
                    state.grpc_endpoint = saved.grpc_endpoint;
                }
                state.proxy_address = saved.proxy_address;
            }
        }
        state
    }

    fn defaults() -> Self {
        let tex8 = NodePreset::Tex8;
        Self {
            worker: WorkerKind::Recommended,
            worker_label: "Recommended".into(),
            private_worker: String::new(),
            show_private_worker: false,
            language: "en",
            compute: ComputeBackend::Cpu,
            share_searches: true,
            protection: ProtectionMode::None,
            auto_lock_seconds: 1800,
            node_network: NetworkChoice::Mainnet,
            node_mode: NodeMode::OptimizedGrpc,
            daemon_address: tex8.onion_daemon(),
            grpc_endpoint: tex8.grpc(),
            proxy_address: "127.0.0.1:9050".into(),
            scroll: 0,
            seed_reveal: None,
            message: None,
            locked: false,
            app_password: Zeroizing::new(String::new()),
            app_password_confirm: Zeroizing::new(String::new()),
            current_app_password: Zeroizing::new(String::new()),
            mfw_name: String::new(),
            mfw_years: 1,
            cached_cli: RefCell::new(None),
        }
    }

    pub fn persist(&self) {
        let saved = PersistedSettings {
            worker: self.worker,
            language: self.language.to_owned(),
            compute: self.compute,
            share_searches: self.share_searches,
            protection: self.protection,
            auto_lock_seconds: self.auto_lock_seconds,
            node_network: self.node_network.label().to_owned(),
            node_mode: self.node_mode,
            daemon_address: self.daemon_address.clone(),
            grpc_endpoint: self.grpc_endpoint.clone(),
            proxy_address: self.proxy_address.clone(),
        };
        if let Some(parent) = settings_path().parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(raw) = serde_json::to_string_pretty(&saved) {
            let _ = std::fs::write(settings_path(), raw);
        }
        self.cached_cli.replace(None);
    }

    pub fn language_name(&self) -> &'static str {
        LANGUAGES
            .iter()
            .find(|item| item.code == self.language)
            .map(|item| item.name)
            .unwrap_or("English")
    }

    pub fn auto_lock_label(&self) -> &'static str {
        AUTO_LOCK_OPTIONS
            .iter()
            .find(|(seconds, _)| *seconds == self.auto_lock_seconds)
            .map(|(_, label)| *label)
            .unwrap_or("30 minutes (default)")
    }

    pub fn cycle_language(&mut self) {
        let index = LANGUAGES
            .iter()
            .position(|item| item.code == self.language)
            .unwrap_or(0);
        self.language = LANGUAGES[(index + 1) % LANGUAGES.len()].code;
        self.persist();
        self.message = Some(format!("Language: {}", self.language_name()));
    }

    pub fn cycle_auto_lock(&mut self) {
        if self.protection == ProtectionMode::None {
            self.message = Some("Enable app protection first to use automatic locking.".into());
            return;
        }
        let index = AUTO_LOCK_OPTIONS
            .iter()
            .position(|(seconds, _)| *seconds == self.auto_lock_seconds)
            .unwrap_or(3);
        self.auto_lock_seconds = AUTO_LOCK_OPTIONS[(index + 1) % AUTO_LOCK_OPTIONS.len()].0;
        self.persist();
        self.message = Some("Automatic app lock was updated.".into());
    }

    pub fn set_compute(&mut self, backend: ComputeBackend) {
        if !backend.available() {
            self.message = Some("This implementation is not available on this device.".into());
            return;
        }
        self.compute = backend;
        self.persist();
        self.message = Some(format!("Wallet scanning: {}", backend.label()));
    }

    pub fn apply_node_preset(&mut self, preset: NodePreset, onion: bool) {
        if onion {
            self.daemon_address = preset.onion_daemon();
            self.proxy_address = "127.0.0.1:9050".into();
        } else {
            self.grpc_endpoint = preset.grpc();
        }
        self.node_mode = NodeMode::OptimizedGrpc;
        self.persist();
        self.message = Some(format!("Using {}", preset.label()));
    }

    pub fn reset_node_defaults(&mut self) {
        let tex8 = NodePreset::Tex8;
        self.node_mode = NodeMode::OptimizedGrpc;
        self.daemon_address = tex8.onion_daemon();
        self.grpc_endpoint = tex8.grpc();
        self.proxy_address = "127.0.0.1:9050".into();
        self.persist();
        self.message = Some("Node defaults restored.".into());
    }

    pub fn system_auth_label() -> &'static str {
        if cfg!(target_os = "macos") {
            "Touch ID"
        } else if cfg!(target_os = "windows") {
            "Windows Hello"
        } else {
            "system sign-in"
        }
    }

    pub fn cli_connection(&self) -> NodeConnection {
        if let Some(cached) = self.cached_cli.borrow().clone() {
            return cached;
        }
        let node = cli_connection(
            &self.daemon_address,
            &self.grpc_endpoint,
            &self.proxy_address,
            self.node_network,
        );
        self.cached_cli.replace(Some(node.clone()));
        node
    }

    fn overlay_desktop_node_settings(&mut self) {
        let Some(path) = desktop_node_settings_path() else {
            return;
        };
        let Ok(raw) = std::fs::read_to_string(path) else {
            return;
        };
        let Ok(file) = serde_json::from_str::<DesktopNodeSettingsFile>(&raw) else {
            return;
        };
        let wanted = self.node_network.label();
        let Some(profile) = file
            .profiles
            .into_iter()
            .find(|profile| profile.network == wanted)
        else {
            return;
        };
        if !profile.daemon_address.is_empty() {
            self.daemon_address = profile.daemon_address;
        }
        if !profile.grpc_endpoint.is_empty() {
            self.grpc_endpoint = profile.grpc_endpoint;
        }
        self.proxy_address = profile.proxy_address;
        self.node_mode = match profile.mode.as_str() {
            "original-rpc" => NodeMode::OriginalRpc,
            "custom" => NodeMode::Custom,
            _ => NodeMode::OptimizedGrpc,
        };
    }
}

pub fn cli_connection(
    daemon_address: &str,
    grpc_endpoint: &str,
    proxy_address: &str,
    network: NetworkChoice,
) -> NodeConnection {
    let _ = proxy_address;
    // The product CLI speaks Monero JSON-RPC, not MFN gRPC, and has no
    // bundled Tor. Desktop keeps wallet RPC on Onion; the same node answers
    // JSON-RPC on Clearnet :18089 (verified /get_height). Using Onion here
    // only because 127.0.0.1:9050 is open leaves the TUI stuck — that SOCKS
    // port is the desktop app's embedded Tor, not a general wallet2 proxy.
    let onion = daemon_address.contains(".onion");
    let daemon = if onion || daemon_address.trim().is_empty() {
        clearnet_rpc(grpc_endpoint, network)
    } else {
        daemon_address.trim().to_owned()
    };
    NodeConnection {
        daemon_address: daemon,
        proxy_address: String::new(),
        trusted: true,
        use_ssl: false,
    }
}

fn clearnet_rpc(grpc_endpoint: &str, network: NetworkChoice) -> String {
    let trimmed = grpc_endpoint.trim();
    if let Some((host, port)) = trimmed.rsplit_once(':') {
        if !host.is_empty() && (port == "18091" || port == "28091" || port == "38091") {
            let rpc_port = match port {
                "28091" => "28089",
                "38091" => "38089",
                _ => "18089",
            };
            return format!("{host}:{rpc_port}");
        }
        if !host.is_empty() && !host.contains(".onion") {
            return trimmed.to_owned();
        }
    }
    match network {
        NetworkChoice::Testnet => "xmr.tex8.com:28089".into(),
        NetworkChoice::Stagenet => "xmr.tex8.com:38089".into(),
        NetworkChoice::Mainnet => "xmr.tex8.com:18089".into(),
    }
}

fn desktop_node_settings_path() -> Option<PathBuf> {
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"))?;
    let home = PathBuf::from(home);
    let path = if cfg!(target_os = "macos") {
        home.join("Library/Application Support")
            .join(APP_ID)
            .join("wallets/node-settings.json")
    } else if cfg!(target_os = "windows") {
        std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .unwrap_or(home)
            .join(APP_ID)
            .join("wallets/node-settings.json")
    } else {
        home.join(".local/share")
            .join(APP_ID)
            .join("wallets/node-settings.json")
    };
    Some(path)
}

#[derive(Deserialize)]
struct DesktopNodeSettingsFile {
    #[serde(default)]
    profiles: Vec<DesktopNodeProfile>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DesktopNodeProfile {
    #[serde(default)]
    mode: String,
    #[serde(default)]
    network: String,
    #[serde(default)]
    daemon_address: String,
    #[serde(default)]
    grpc_endpoint: String,
    #[serde(default)]
    proxy_address: String,
}

fn settings_path() -> PathBuf {
    if let Some(custom) = std::env::var_os("MFW_TUI_SETTINGS") {
        return PathBuf::from(custom);
    }
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"));
    match home {
        Some(home) => {
            let home = PathBuf::from(home);
            if cfg!(target_os = "macos") {
                home.join("Library/Application Support")
                    .join(APP_ID)
                    .join("tui-settings.json")
            } else if cfg!(target_os = "windows") {
                std::env::var_os("APPDATA")
                    .map(PathBuf::from)
                    .unwrap_or(home)
                    .join(APP_ID)
                    .join("tui-settings.json")
            } else {
                home.join(".local/share")
                    .join(APP_ID)
                    .join("tui-settings.json")
            }
        }
        None => PathBuf::from("tui-settings.json"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn onion_without_tor_falls_back_to_clearnet_rpc() {
        let node = cli_connection(
            "fastrelayrpcf3hbc4qvykjgbpwpmcuq5dpcsdxoe7gwfh2zxdib3eid.onion:18089",
            "xmr.tex8.com:18091",
            "127.0.0.1:1",
            NetworkChoice::Mainnet,
        );
        assert_eq!(node.daemon_address, "xmr.tex8.com:18089");
        assert!(node.proxy_address.is_empty());
        assert!(node.cli_args().contains(&"--daemon-address".into()));
        assert!(node.cli_args().contains(&"xmr.tex8.com:18089".into()));
        assert!(node.cli_args().contains(&"--trusted-daemon".into()));
        assert!(!node.cli_args().iter().any(|item| item == "--proxy"));
    }

    #[test]
    fn clearnet_daemon_does_not_use_socks() {
        let node = cli_connection(
            "xmr.tex8.com:18089",
            "xmr.tex8.com:18091",
            "127.0.0.1:9050",
            NetworkChoice::Mainnet,
        );
        assert_eq!(node.daemon_address, "xmr.tex8.com:18089");
        assert!(node.proxy_address.is_empty());
    }

    #[test]
    fn onion_desktop_profile_uses_clearnet_rpc_for_the_product_cli() {
        let node = cli_connection(
            "fastrelayrpcf3hbc4qvykjgbpwpmcuq5dpcsdxoe7gwfh2zxdib3eid.onion:18089",
            "xmr.tex8.com:18091",
            "127.0.0.1:9050",
            NetworkChoice::Mainnet,
        );
        assert_eq!(node.daemon_address, "xmr.tex8.com:18089");
        assert!(
            node.proxy_address.is_empty(),
            "wallet2 must not inherit the desktop Tor SOCKS port"
        );
        assert!(node.cli_args().contains(&"--trusted-daemon".into()));
    }
}
