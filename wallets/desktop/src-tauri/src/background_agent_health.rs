//! Recent agent liveness is distinct from provider registration or a banner.

use serde::Deserialize;
use std::{fs, path::Path};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Health {
    version: u8,
    pid: u32,
    instance_id: String,
    heartbeat_at: u64,
    connected: bool,
    last_peer_at: Option<u64>,
    phase: String,
}

impl Health {
    fn status(&self, now: u64) -> &'static str {
        if self.version != 1
            || self.pid == 0
            || self.instance_id.len() != 32
            || !self
                .instance_id
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit())
            || self.heartbeat_at == 0
            || self.heartbeat_at > now.saturating_add(5)
        {
            return "unknown";
        }
        if now.saturating_sub(self.heartbeat_at) > 10 {
            return "stale";
        }
        if self.connected
            && self.phase == "connected"
            && self.last_peer_at.is_some_and(|peer| {
                peer > 0 && peer <= now.saturating_add(5) && now.saturating_sub(peer) <= 60
            })
        {
            return "connected";
        }
        match self.phase.as_str() {
            "disabled" => "disabled",
            "stopped" => "stopped",
            "starting" => "starting",
            "connecting" => "connecting",
            "backoff" => "backoff",
            "connected" => "stale",
            _ => "unknown",
        }
    }
}

pub fn status(path: &Path, now: u64) -> &'static str {
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return "unknown";
    };
    if !metadata.is_file() || metadata.len() > 4096 {
        return "unknown";
    }
    fs::read(path)
        .ok()
        .filter(|bytes| bytes.len() <= 4096)
        .and_then(|bytes| serde_json::from_slice::<Health>(&bytes).ok())
        .map(|health| health.status(now))
        .unwrap_or("unknown")
}

#[cfg(test)]
mod tests {
    use super::*;
    fn health() -> Health {
        Health {
            version: 1,
            pid: 1,
            instance_id: "a".repeat(32),
            heartbeat_at: 100,
            connected: true,
            last_peer_at: Some(100),
            phase: "connected".to_owned(),
        }
    }
    #[test]
    fn recent_process_and_real_peer_activity_are_both_required() {
        assert_eq!(health().status(105), "connected");
        assert_eq!(health().status(111), "stale");
        let mut h = health();
        h.last_peer_at = Some(1);
        assert_eq!(h.status(105), "stale");
        h.last_peer_at = None;
        assert_eq!(h.status(105), "stale");
    }
    #[test]
    fn configuration_and_local_heartbeat_never_imply_connected() {
        let mut h = health();
        h.connected = false;
        h.phase = "connecting".to_owned();
        assert_eq!(h.status(105), "connecting");
        h.phase = "disabled".to_owned();
        assert_eq!(h.status(105), "disabled");
        h.phase = "stopped".to_owned();
        assert_eq!(h.status(105), "stopped");
    }
    #[test]
    fn invalid_or_future_state_is_not_ready() {
        let mut h = health();
        h.heartbeat_at = 200;
        assert_eq!(h.status(105), "unknown");
        h = health();
        h.instance_id = "invalid".to_owned();
        assert_eq!(h.status(105), "unknown");
        h = health();
        h.last_peer_at = Some(200);
        assert_eq!(h.status(105), "stale");
    }
}
