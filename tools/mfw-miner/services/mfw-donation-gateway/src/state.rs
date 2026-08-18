// SPDX-License-Identifier: GPL-3.0-only

use std::collections::HashSet;
use std::sync::{
    Arc,
    atomic::{AtomicU64, Ordering},
};

use tokio::sync::watch;

use crate::config::{Backend, Config};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Selection {
    pub generation: u64,
    pub primary: String,
}

#[derive(Default)]
pub struct Metrics {
    active_connections: AtomicU64,
    total_connections: AtomicU64,
    upstream_failures: AtomicU64,
}

impl Metrics {
    pub fn connection_opened(&self) {
        self.active_connections.fetch_add(1, Ordering::Relaxed);
        self.total_connections.fetch_add(1, Ordering::Relaxed);
    }

    pub fn connection_closed(&self) {
        self.active_connections.fetch_sub(1, Ordering::Relaxed);
    }

    pub fn upstream_failed(&self) {
        self.upstream_failures.fetch_add(1, Ordering::Relaxed);
    }

    pub fn snapshot(&self) -> MetricsSnapshot {
        MetricsSnapshot {
            active_connections: self.active_connections.load(Ordering::Relaxed),
            total_connections: self.total_connections.load(Ordering::Relaxed),
            upstream_failures: self.upstream_failures.load(Ordering::Relaxed),
        }
    }
}

#[derive(Clone, Copy, Debug, serde::Serialize)]
pub struct MetricsSnapshot {
    pub active_connections: u64,
    pub total_connections: u64,
    pub upstream_failures: u64,
}

#[derive(Clone)]
pub struct AppState {
    pub config: Arc<Config>,
    pub selection_tx: watch::Sender<Selection>,
    pub metrics: Arc<Metrics>,
    pub admin_token: Option<Arc<str>>,
}

impl AppState {
    pub fn new(config: Config, admin_token: Option<String>) -> Self {
        let selection = Selection {
            generation: 1,
            primary: config.active_backend.clone(),
        };
        let (selection_tx, _) = watch::channel(selection);

        Self {
            config: Arc::new(config),
            selection_tx,
            metrics: Arc::new(Metrics::default()),
            admin_token: admin_token.map(Arc::from),
        }
    }

    pub fn current_selection(&self) -> Selection {
        self.selection_tx.borrow().clone()
    }

    pub fn selected_backends(&self, selection: &Selection) -> Vec<Backend> {
        let mut seen = HashSet::new();

        std::iter::once(selection.primary.as_str())
            .chain(self.config.fallback_backends.iter().map(String::as_str))
            .filter(|name| seen.insert(*name))
            .filter_map(|name| self.config.backend(name))
            .filter(|backend| backend.enabled)
            .cloned()
            .collect()
    }

    pub fn switch_backend(&self, name: &str) -> anyhow::Result<Selection> {
        self.config.ensure_enabled_backend(name)?;
        let current = self.current_selection();
        if current.primary == name {
            return Ok(current);
        }

        let next = Selection {
            generation: current.generation + 1,
            primary: name.to_owned(),
        };
        self.selection_tx.send_replace(next.clone());
        Ok(next)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{AdminConfig, BackendMode};

    const ADDRESS: &str = "49aaK7WgMCQABhjHt1UyXijKRwbjjbtSq2xbDbB4AgYLGqtXpudonJq58aM4j7fhTWdph4LD7VxjpEwEzBXBdzK2K9vybrL";

    fn backend(name: &str, port: u16) -> Backend {
        Backend {
            name: name.to_owned(),
            mode: BackendMode::Pool,
            host: "127.0.0.1".to_owned(),
            port,
            tls: false,
            tls_server_name: None,
            password: "x".to_owned(),
            enabled: true,
        }
    }

    fn state() -> AppState {
        AppState::new(
            Config {
                listen: "127.0.0.1:3333".parse().unwrap(),
                donation_address: ADDRESS.to_owned(),
                active_backend: "pool".to_owned(),
                fallback_backends: vec!["fallback".to_owned()],
                max_line_bytes: 64 * 1024,
                connect_timeout_secs: 10,
                admin: AdminConfig::default(),
                backends: vec![backend("pool", 4444), backend("fallback", 5555)],
            },
            Some("secret".to_owned()),
        )
    }

    #[test]
    fn switching_updates_generation_and_deduplicates_fallback() {
        let state = state();
        let selection = state.switch_backend("fallback").unwrap();
        assert_eq!(selection.generation, 2);
        assert_eq!(selection.primary, "fallback");

        let selected = state.selected_backends(&selection);
        assert_eq!(selected.len(), 1);
        assert_eq!(selected[0].name, "fallback");
    }

    #[test]
    fn switching_rejects_unknown_backend() {
        assert!(state().switch_backend("unknown").is_err());
    }
}
