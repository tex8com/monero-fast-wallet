//! Persisted, bounded Windows presentation policy. No network or OS calls.
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum OsPhase {
    #[serde(rename = "presentation_pending")]
    Pending,
    #[serde(rename = "os_accepted")]
    Accepted,
    #[serde(rename = "os_disabled_for_application")]
    DisabledForApplication,
    #[serde(rename = "os_disabled_for_user")]
    DisabledForUser,
    #[serde(rename = "os_disabled_by_group_policy")]
    DisabledByGroupPolicy,
    #[serde(rename = "os_disabled_by_manifest")]
    DisabledByManifest,
    #[serde(rename = "os_setting_unavailable")]
    SettingUnavailable,
    #[serde(rename = "notification-toast-identity-failed")]
    IdentityFailed,
    #[serde(rename = "presentation_unknown")]
    PresentationUnknown,
}
impl OsPhase {
    pub fn from_error(error: &str) -> Self {
        match error {
            "os_disabled_for_application" => Self::DisabledForApplication,
            "os_disabled_for_user" => Self::DisabledForUser,
            "os_disabled_by_group_policy" => Self::DisabledByGroupPolicy,
            "os_disabled_by_manifest" => Self::DisabledByManifest,
            "os_setting_unavailable" => Self::SettingUnavailable,
            "notification-toast-identity-failed" | "wallet app command is unavailable" => {
                Self::IdentityFailed
            }
            _ => Self::PresentationUnknown,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "presentation_pending",
            Self::Accepted => "os_accepted",
            Self::DisabledForApplication => "os_disabled_for_application",
            Self::DisabledForUser => "os_disabled_for_user",
            Self::DisabledByGroupPolicy => "os_disabled_by_group_policy",
            Self::DisabledByManifest => "os_disabled_by_manifest",
            Self::SettingUnavailable => "os_setting_unavailable",
            Self::IdentityFailed => "notification-toast-identity-failed",
            Self::PresentationUnknown => "presentation_unknown",
        }
    }
    pub fn is_failure(self) -> bool {
        !matches!(self, Self::Pending | Self::Accepted)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Retry {
    pub attempts: u16,
    pub next_attempt_at: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PresentationOutcome {
    Accepted,
    AlreadyAccepted,
    Deferred,
    Retry(Retry),
}
impl Retry {
    pub fn valid(self) -> bool {
        self.attempts > 0 && self.next_attempt_at > 0
    }
    pub fn due(self, now: u64) -> bool {
        now >= self.next_attempt_at
    }
    pub fn after_attempt(previous: Option<Self>, now: u64) -> Self {
        let attempts = previous.map_or(1, |retry| retry.attempts.saturating_add(1));
        // Five quick retries, then at most one attempt every five minutes.
        // Persisted attempts prevent a replay or a process restart from
        // repeatedly returning to the short initial intervals.
        let delay = match attempts {
            1 => 1,
            2 => 2,
            3 => 4,
            4 => 8,
            5 => 16,
            _ => 300,
        };
        Self {
            attempts,
            next_attempt_at: now.saturating_add(delay).max(1),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn retry_budget_has_a_bounded_burst_then_slow_attempts() {
        let mut previous = None;
        for delay in [1, 2, 4, 8, 16, 300, 300, 300] {
            let next = Retry::after_attempt(previous, 1000);
            assert_eq!(next.next_attempt_at, 1000 + delay);
            assert!(!next.due(1000));
            assert!(next.due(1000 + delay));
            assert!(next.valid());
            previous = Some(next);
        }
        assert_eq!(previous.unwrap().attempts, 8);
    }
    #[test]
    fn overflow_never_wraps_a_retry_into_the_past() {
        let retry = Retry::after_attempt(
            Some(Retry {
                attempts: u16::MAX,
                next_attempt_at: 1,
            }),
            u64::MAX,
        );
        assert_eq!(retry.attempts, u16::MAX);
        assert_eq!(retry.next_attempt_at, u64::MAX);
    }
    #[test]
    fn arbitrary_os_error_text_never_becomes_a_status() {
        assert_eq!(
            OsPhase::from_error("PRIVATE_TOKEN=/home/user"),
            OsPhase::PresentationUnknown
        );
        assert_eq!(
            OsPhase::from_error("os_setting_unavailable"),
            OsPhase::SettingUnavailable
        );
        assert_eq!(
            OsPhase::from_error("os_disabled_by_group_policy"),
            OsPhase::DisabledByGroupPolicy
        );
    }
}
