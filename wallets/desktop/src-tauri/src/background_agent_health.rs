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
    #[serde(default)]
    os_phase: Option<String>,
}

impl Health {
    fn valid_identity_and_heartbeat(&self, now: u64) -> bool {
        self.version == 1
            && self.pid != 0
            && self.instance_id.len() == 32
            && self
                .instance_id
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit())
            && self.heartbeat_at != 0
            && self.heartbeat_at <= now.saturating_add(5)
    }

    fn status(&self, now: u64) -> &'static str {
        if !self.valid_identity_and_heartbeat(now) {
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

    fn presentation_status(&self, now: u64) -> Option<&'static str> {
        if !self.valid_identity_and_heartbeat(now) || now.saturating_sub(self.heartbeat_at) > 10 {
            return None;
        }
        // A current local presentation failure is meaningful even while the
        // independent network connection is reconnecting. Never expose raw
        // helper errors or infer that OS acceptance proves a visible banner.
        match self.os_phase.as_deref()? {
            "presentation_pending" => Some("pending"),
            "os_accepted" => Some("accepted"),
            "os_disabled_for_application" => Some("disabled-for-application"),
            "os_disabled_for_user" => Some("disabled-for-user"),
            "os_disabled_by_group_policy" | "os_disabled_by_manifest" => Some("disabled-by-policy"),
            "os_setting_unavailable" | "notification-toast-identity-failed" => {
                Some("registration-error")
            }
            "presentation_unknown"
            | "os_notifier_create_failed"
            | "os_xml_create_failed"
            | "os_xml_load_failed"
            | "os_toast_create_failed"
            | "os_toast_tag_failed"
            | "os_dismiss_handler_failed"
            | "os_failed_handler_failed"
            | "os_show_failed" => Some("presentation-error"),
            _ => None,
        }
    }
}

fn read_health(path: &Path) -> Option<Health> {
    let metadata = fs::symlink_metadata(path).ok()?;
    if !metadata.is_file() || metadata.len() > 4096 {
        return None;
    }
    fs::read(path)
        .ok()
        .filter(|bytes| bytes.len() <= 4096)
        .and_then(|bytes| serde_json::from_slice::<Health>(&bytes).ok())
}

pub fn status(path: &Path, now: u64) -> &'static str {
    read_health(path)
        .map(|health| health.status(now))
        .unwrap_or("unknown")
}

pub fn presentation_status(path: &Path, now: u64) -> Option<&'static str> {
    read_health(path).and_then(|health| health.presentation_status(now))
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
            os_phase: None,
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

    #[test]
    fn presentation_failure_does_not_change_network_readiness() {
        let mut h = health();
        h.os_phase = Some("os_setting_unavailable".to_owned());
        assert_eq!(h.status(105), "connected");
        assert_eq!(h.presentation_status(105), Some("registration-error"));
        h.connected = false;
        h.phase = "backoff".to_owned();
        h.last_peer_at = None;
        assert_eq!(h.status(105), "backoff");
        assert_eq!(h.presentation_status(105), Some("registration-error"));
        h.os_phase = Some("os_accepted".to_owned());
        assert_eq!(h.status(105), "backoff");
        assert_eq!(h.presentation_status(105), Some("accepted"));
    }

    #[test]
    fn only_fixed_presentation_codes_cross_the_ui_boundary() {
        let mut h = health();
        for (phase, expected) in [
            ("presentation_pending", "pending"),
            ("os_accepted", "accepted"),
            ("os_disabled_for_application", "disabled-for-application"),
            ("os_disabled_for_user", "disabled-for-user"),
            ("os_disabled_by_group_policy", "disabled-by-policy"),
            ("os_disabled_by_manifest", "disabled-by-policy"),
            ("os_setting_unavailable", "registration-error"),
            ("notification-toast-identity-failed", "registration-error"),
            ("presentation_unknown", "presentation-error"),
            ("os_show_failed", "presentation-error"),
        ] {
            h.os_phase = Some(phase.to_owned());
            assert_eq!(h.presentation_status(105), Some(expected));
        }
        for phase in [
            "PRIVATE_TOKEN_VALUE",
            "os_arbitrary_exception",
            "connected",
            "",
        ] {
            h.os_phase = Some(phase.to_owned());
            assert_eq!(h.presentation_status(105), None);
        }
    }

    #[test]
    fn stale_or_invalid_health_never_reports_presentation_state() {
        let mut h = health();
        h.os_phase = Some("os_accepted".to_owned());
        assert_eq!(h.presentation_status(111), None);
        h.heartbeat_at = 200;
        assert_eq!(h.presentation_status(105), None);
        h.heartbeat_at = 100;
        h.instance_id = "invalid".to_owned();
        assert_eq!(h.presentation_status(105), None);
        h = health();
        h.os_phase = Some("os_accepted".to_owned());
        h.pid = 0;
        assert_eq!(h.presentation_status(105), None);
    }

    #[test]
    fn legacy_health_without_os_phase_preserves_network_status() {
        let legacy = br#"{"version":1,"pid":1,"instanceId":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","heartbeatAt":100,"connected":true,"lastPeerAt":100,"phase":"connected"}"#;
        let h: Health = serde_json::from_slice(legacy).unwrap();
        assert_eq!(h.status(105), "connected");
        assert_eq!(h.presentation_status(105), None);
    }
}
