// SPDX-License-Identifier: GPL-3.0-only

use std::{collections::HashSet, fs, net::SocketAddr, path::Path};

use anyhow::{Context, Result, bail, ensure};
use serde::{Deserialize, Serialize};

use crate::address::validate_monero_mainnet_standard;

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub listen: SocketAddr,
    pub donation_address: String,
    pub active_backend: String,
    #[serde(default)]
    pub fallback_backends: Vec<String>,
    #[serde(default = "default_max_line_bytes")]
    pub max_line_bytes: usize,
    #[serde(default = "default_connect_timeout_secs")]
    pub connect_timeout_secs: u64,
    #[serde(default)]
    pub admin: AdminConfig,
    pub backends: Vec<Backend>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AdminConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_admin_listen")]
    pub listen: SocketAddr,
    #[serde(default = "default_admin_token_env")]
    pub token_env: String,
}

impl Default for AdminConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            listen: default_admin_listen(),
            token_env: default_admin_token_env(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Backend {
    pub name: String,
    pub mode: BackendMode,
    pub host: String,
    pub port: u16,
    #[serde(default)]
    pub tls: bool,
    pub tls_server_name: Option<String>,
    #[serde(default = "default_password")]
    pub password: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum BackendMode {
    Pool,
    P2pool,
    Solo,
}

impl Config {
    pub fn load(path: &Path) -> Result<Self> {
        let text = fs::read_to_string(path)
            .with_context(|| format!("failed to read {}", path.display()))?;
        let config: Self =
            toml::from_str(&text).with_context(|| format!("failed to parse {}", path.display()))?;
        config.validate()?;
        Ok(config)
    }

    pub fn validate(&self) -> Result<()> {
        validate_monero_mainnet_standard(&self.donation_address)
            .context("invalid donation_address")?;
        ensure!(
            (1024..=1024 * 1024).contains(&self.max_line_bytes),
            "max_line_bytes must be between 1024 and 1048576"
        );
        ensure!(
            (1..=120).contains(&self.connect_timeout_secs),
            "connect_timeout_secs must be between 1 and 120"
        );
        ensure!(
            !self.backends.is_empty(),
            "at least one backend is required"
        );

        let mut names = HashSet::new();
        for backend in &self.backends {
            ensure!(
                !backend.name.trim().is_empty(),
                "backend name cannot be empty"
            );
            ensure!(
                names.insert(&backend.name),
                "duplicate backend: {}",
                backend.name
            );
            ensure!(
                !backend.host.trim().is_empty(),
                "backend host cannot be empty"
            );
            ensure!(backend.port > 0, "backend port cannot be zero");
            if backend.tls {
                ensure!(
                    backend
                        .tls_server_name
                        .as_deref()
                        .unwrap_or(&backend.host)
                        .parse::<std::net::IpAddr>()
                        .is_err(),
                    "TLS backend {} requires a DNS server name",
                    backend.name
                );
            }
        }

        self.ensure_enabled_backend(&self.active_backend)?;
        for fallback in &self.fallback_backends {
            self.ensure_enabled_backend(fallback)?;
            ensure!(
                fallback != &self.active_backend,
                "active backend cannot be its own fallback"
            );
        }

        if self.admin.enabled {
            ensure!(
                self.admin.listen.ip().is_loopback(),
                "admin listener must be bound to loopback"
            );
            ensure!(
                !self.admin.token_env.trim().is_empty(),
                "admin token environment variable cannot be empty"
            );
        }

        Ok(())
    }

    pub fn backend(&self, name: &str) -> Option<&Backend> {
        self.backends.iter().find(|backend| backend.name == name)
    }

    pub fn ensure_enabled_backend(&self, name: &str) -> Result<()> {
        match self.backend(name) {
            Some(backend) if backend.enabled => Ok(()),
            Some(_) => bail!("backend is disabled: {name}"),
            None => bail!("unknown backend: {name}"),
        }
    }
}

fn default_max_line_bytes() -> usize {
    64 * 1024
}

fn default_connect_timeout_secs() -> u64 {
    10
}

fn default_admin_listen() -> SocketAddr {
    "127.0.0.1:18088".parse().expect("valid static address")
}

fn default_admin_token_env() -> String {
    "MFW_GATEWAY_ADMIN_TOKEN".to_owned()
}

fn default_password() -> String {
    "mfw~rx/0".to_owned()
}

fn default_true() -> bool {
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    const MFW_ADDRESS: &str = "49aaK7WgMCQABhjHt1UyXijKRwbjjbtSq2xbDbB4AgYLGqtXpudonJq58aM4j7fhTWdph4LD7VxjpEwEzBXBdzK2K9vybrL";

    fn valid_config() -> Config {
        Config {
            listen: "127.0.0.1:3333".parse().unwrap(),
            donation_address: MFW_ADDRESS.to_owned(),
            active_backend: "pool".to_owned(),
            fallback_backends: Vec::new(),
            max_line_bytes: default_max_line_bytes(),
            connect_timeout_secs: 10,
            admin: AdminConfig::default(),
            backends: vec![Backend {
                name: "pool".to_owned(),
                mode: BackendMode::Pool,
                host: "127.0.0.1".to_owned(),
                port: 4444,
                tls: false,
                tls_server_name: None,
                password: "mfw~rx/0".to_owned(),
                enabled: true,
            }],
        }
    }

    #[test]
    fn accepts_safe_config() {
        valid_config().validate().unwrap();
    }

    #[test]
    fn rejects_remote_admin_listener() {
        let mut config = valid_config();
        config.admin.enabled = true;
        config.admin.listen = "0.0.0.0:18088".parse().unwrap();
        assert!(config.validate().is_err());
    }
}
