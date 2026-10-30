//! A cached observation is display metadata, never authorization to send keys.
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    sync::{Mutex, OnceLock},
};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostingStatus {
    pub status: String,
    pub attempted_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checked_at: Option<u64>,
    pub verified: bool,
    pub repair_attempted: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub assignment_handle: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub assignment_epoch: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worker_root_id: Option<String>,
}

impl HostingStatus {
    pub fn unknown(attempted_at: u64, code: &str) -> Self {
        Self {
            status: "unknown".into(),
            attempted_at,
            checked_at: None,
            verified: false,
            repair_attempted: false,
            error_code: Some(code.into()),
            assignment_handle: None,
            assignment_epoch: None,
            worker_root_id: None,
        }
    }

    pub fn valid(&self) -> bool {
        let proof_status = matches!(self.status.as_str(), "hosted" | "rehosted" | "missing");
        matches!(
            self.status.as_str(),
            "hosted" | "rehosted" | "missing" | "unknown" | "blocked" | "unsupported"
        ) && self.attempted_at > 0
            && (proof_status == self.verified)
            && (self.verified == self.checked_at.is_some())
            && (self.status != "rehosted" || self.repair_attempted)
            && (!self.verified
                || (self.assignment_handle.as_deref().is_some_and(hex32)
                    && self.assignment_epoch.is_some_and(|epoch| epoch > 0)
                    && self.worker_root_id.as_deref().is_some_and(hex32)))
            && self
                .checked_at
                .is_none_or(|at| at >= self.attempted_at.saturating_sub(5))
            && self.error_code.as_ref().is_none_or(|code| {
                !code.is_empty()
                    && code.len() <= 64
                    && code.bytes().all(|byte| {
                        byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_'
                    })
            })
    }

    pub fn failure(attempted_at: u64, code: &str, repair_attempted: bool) -> Self {
        let mut status = Self::unknown(attempted_at, code);
        status.repair_attempted = repair_attempted;
        status.status = match code {
            "hosting_check_unsupported" | "legacy_wallet_unsupported" => "unsupported",
            "gateway_credentials_missing"
            | "gateway_credentials_invalid"
            | "assignment_owner_mismatch"
            | "assignment_epoch_mismatch"
            | "assignment_state_missing"
            | "backup_required"
            | "notification_permission_required"
            | "authorization_cancelled"
            | "credential_missing" => "blocked",
            _ => "unknown",
        }
        .into();
        status
    }
}

fn hex32(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

pub fn enrollment_error_code(error: &str) -> &'static str {
    let error = error.to_ascii_lowercase();
    if error.contains("apns-authorization-denied")
        || error.contains("permission-denied")
        || error.contains("allow notifications")
    {
        "notification_permission_required"
    } else if error.contains("authorization-error")
        || error.contains("request notification authorization")
        || error.contains("registration-error")
        || error.contains("registration-failed")
        || error.contains("registration-timeout")
        || error.contains("register remote notifications")
    {
        "notification_service_error"
    } else if error.contains("notification")
        && (error.contains("pending") || error.contains("timed out"))
    {
        "notification_service_error"
    } else if error.contains("back up") || error.contains("backup") {
        "backup_required"
    } else if error.contains("cancel") || error.contains("authorization was denied") {
        "authorization_cancelled"
    } else if error.contains("credential") || error.contains("password") {
        "credential_missing"
    } else {
        "enrollment_failed"
    }
}

static IN_FLIGHT: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

/// Owns the identity, not a MutexGuard, so the async operation remains Send.
pub struct HostingCheckGuard(String);
impl HostingCheckGuard {
    pub fn acquire(identity_id: &str) -> Result<Self, String> {
        let mut active = IN_FLIGHT
            .get_or_init(Mutex::default)
            .lock()
            .map_err(|_| "A hosting check could not be started.".to_owned())?;
        if !active.insert(identity_id.to_owned()) {
            return Err("A hosting check for this Fast Wallet is already running.".into());
        }
        Ok(Self(identity_id.to_owned()))
    }
}
impl Drop for HostingCheckGuard {
    fn drop(&mut self) {
        if let Ok(mut active) = IN_FLIGHT.get_or_init(Mutex::default).lock() {
            active.remove(&self.0);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn system_authorization_error_is_not_persisted_as_user_denial() {
        let code = enrollment_error_code("apns-authorization-error: UNErrorDomain code=1");
        let status = HostingStatus::failure(100, code, true);
        assert_eq!(status.status, "unknown");
        assert_eq!(
            status.error_code.as_deref(),
            Some("notification_service_error")
        );
        assert!(!status.verified);
        let denied = HostingStatus::failure(
            100,
            enrollment_error_code("apns-authorization-denied"),
            true,
        );
        assert_eq!(denied.status, "blocked");
        assert_eq!(
            denied.error_code.as_deref(),
            Some("notification_permission_required")
        );
    }

    #[test]
    fn duplicate_checks_cannot_overlap_or_repair_twice() {
        let guard = HostingCheckGuard::acquire("duplicate-check-test").unwrap();
        assert!(HostingCheckGuard::acquire("duplicate-check-test").is_err());
        let other = HostingCheckGuard::acquire("independent-check-test").unwrap();
        drop(guard);
        assert!(HostingCheckGuard::acquire("duplicate-check-test").is_ok());
        drop(other);
    }

    #[test]
    fn cached_state_cannot_claim_green_without_a_proof_timestamp() {
        let mut status = HostingStatus::unknown(100, "network_error");
        assert!(status.valid());
        status.status = "hosted".into();
        assert!(!status.valid());
        status.verified = true;
        assert!(!status.valid());
        status.checked_at = Some(94);
        assert!(!status.valid());
        status.checked_at = Some(100);
        status.assignment_handle = Some("ab".repeat(32));
        status.assignment_epoch = Some(1);
        status.worker_root_id = Some("cd".repeat(32));
        assert!(status.valid());
        status.status = "unknown".into();
        assert!(!status.valid());
    }
}
