//! Discover existing Monero wallet files the same way the desktop app does.

use serde::Deserialize;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

const APP_ID: &str = "com.tex8.monerowallet.desktop";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KnownWallet {
    pub label: String,
    pub path: String,
    pub detail: String,
    pub network: String,
}

#[derive(Deserialize)]
struct RegistryFile {
    #[serde(default, rename = "wallets")]
    wallets: Vec<RegistryWallet>,
}

#[derive(Deserialize)]
struct RegistryWallet {
    #[serde(default, rename = "walletName")]
    wallet_name: String,
    #[serde(default, rename = "displayName")]
    display_name: Option<String>,
    #[serde(default)]
    network: String,
    #[serde(default)]
    kind: String,
    #[serde(default, rename = "lastOpenedAt")]
    last_opened_at: u64,
}

pub fn search_roots() -> Vec<(String, PathBuf)> {
    let mut roots = Vec::new();
    if let Ok(cwd) = std::env::current_dir() {
        roots.push(("This folder".into(), cwd));
    }
    if let Some(custom) = std::env::var_os("MFW_WALLET_DIR") {
        roots.push(("MFW_WALLET_DIR".into(), PathBuf::from(custom)));
    }
    if let Some(home) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")) {
        let home = PathBuf::from(home);
        #[cfg(target_os = "macos")]
        {
            roots.push((
                "Desktop app".into(),
                home.join("Library/Application Support")
                    .join(APP_ID)
                    .join("wallets"),
            ));
            roots.push((
                "Desktop diagnostic".into(),
                home.join("Library/Application Support")
                    .join(format!("{APP_ID}.diagnostic"))
                    .join("wallets"),
            ));
        }
        #[cfg(target_os = "linux")]
        {
            roots.push((
                "Desktop app".into(),
                home.join(".local/share").join(APP_ID).join("wallets"),
            ));
        }
        #[cfg(target_os = "windows")]
        {
            if let Some(appdata) = std::env::var_os("APPDATA") {
                roots.push((
                    "Desktop app".into(),
                    PathBuf::from(appdata).join(APP_ID).join("wallets"),
                ));
            }
        }
    }
    roots
        .into_iter()
        .filter(|(_, path)| path.is_dir())
        .collect()
}

pub fn discover_wallets() -> Vec<KnownWallet> {
    let mut found: BTreeMap<String, KnownWallet> = BTreeMap::new();
    for (source, root) in search_roots() {
        let registry = load_registry(&root);
        if let Ok(entries) = fs::read_dir(&root) {
            for entry in entries.flatten() {
                let path = entry.path();
                let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
                    continue;
                };
                if !name.ends_with(".keys") || !path.is_file() {
                    continue;
                }
                let wallet_path = path.with_file_name(name.trim_end_matches(".keys"));
                let key = wallet_path.display().to_string();
                if found.contains_key(&key) {
                    continue;
                }
                let stem = wallet_path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or("wallet");
                let registry_name = stem.strip_suffix(".wallet").unwrap_or(stem);
                let meta = registry.get(registry_name).or_else(|| registry.get(stem));
                let label = meta
                    .and_then(|item| item.display_name.clone())
                    .filter(|name| !name.is_empty())
                    .unwrap_or_else(|| registry_name.to_owned());
                let network = meta
                    .map(|item| item.network.as_str())
                    .filter(|value| !value.is_empty())
                    .unwrap_or("")
                    .to_owned();
                let detail = match meta {
                    Some(item) if !item.network.is_empty() => {
                        let kind = if item.kind == "hardware" {
                            "Ledger Nano"
                        } else {
                            item.kind.as_str()
                        };
                        format!("{} · {kind} · {source}", item.network)
                    }
                    _ if registry_name.contains("ledger") || stem.contains("ledger") => {
                        format!("Ledger Nano · {source}")
                    }
                    _ => source.clone(),
                };
                found.insert(
                    key.clone(),
                    KnownWallet {
                        label,
                        path: key,
                        detail,
                        network,
                    },
                );
            }
        }
    }
    let mut wallets: Vec<_> = found.into_values().collect();
    wallets.sort_by(|left, right| {
        left.detail.cmp(&right.detail).then(
            left.label
                .to_ascii_lowercase()
                .cmp(&right.label.to_ascii_lowercase()),
        )
    });
    wallets
}

pub fn resolve_existing_wallet(input: &str) -> PathBuf {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return PathBuf::new();
    }
    let given = PathBuf::from(trimmed);
    let mut candidates = vec![given.clone()];
    if !given.is_absolute() {
        for (_, root) in search_roots() {
            candidates.push(root.join(trimmed));
            candidates.push(root.join(format!("{trimmed}.wallet")));
        }
        if let Ok(cwd) = std::env::current_dir() {
            candidates.push(cwd.join(trimmed));
            candidates.push(cwd.join(format!("{trimmed}.wallet")));
        }
    }
    for candidate in candidates {
        if keys_path(&candidate).is_file() {
            return candidate;
        }
    }
    given
}

fn keys_path(wallet: &Path) -> PathBuf {
    PathBuf::from(format!("{}.keys", wallet.display()))
}

fn load_registry(root: &Path) -> BTreeMap<String, RegistryWallet> {
    let path = root.join("wallet-registry.json");
    let Ok(text) = fs::read_to_string(path) else {
        return BTreeMap::new();
    };
    let Ok(file) = serde_json::from_str::<RegistryFile>(&text) else {
        return BTreeMap::new();
    };
    let mut map = BTreeMap::new();
    let mut ranked = file.wallets;
    ranked.sort_by_key(|item| std::cmp::Reverse(item.last_opened_at));
    for wallet in ranked {
        if !wallet.wallet_name.is_empty() {
            map.entry(wallet.wallet_name.clone()).or_insert(wallet);
        }
    }
    map
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_keys_in_mfw_wallet_dir() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("alice.wallet.keys"), b"test").unwrap();
        fs::write(dir.path().join("alice.wallet"), b"test").unwrap();
        let previous = std::env::var_os("MFW_WALLET_DIR");
        std::env::set_var("MFW_WALLET_DIR", dir.path());
        let wallets = discover_wallets();
        match previous {
            Some(value) => std::env::set_var("MFW_WALLET_DIR", value),
            None => std::env::remove_var("MFW_WALLET_DIR"),
        }
        assert!(
            wallets
                .iter()
                .any(|wallet| wallet.path.ends_with("alice.wallet")),
            "{wallets:?}"
        );
    }
}
