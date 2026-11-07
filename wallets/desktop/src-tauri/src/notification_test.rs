//! Pure validation/correlation for the server-scheduled notification self-test.
pub const CATEGORY: &str = "monero.fast_wallet.test";
pub const DEEP_LINK: &str = "tex8://notification/test";

pub fn opaque_event_id(id: &str) -> bool {
    let valid = (id.starts_with("evt_") || id.starts_with("sig_")) && id.len() == 68
        || id.starts_with("fwpush_") && id.len() == 39;
    valid && id.split_once('_').is_some_and(|(_, suffix)|
        suffix.bytes().all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()))
}
pub fn valid_schedule(accepted: bool, id: &str, scheduled_at: u64, deliver_after: u64, now: u64) -> bool {
    accepted && id.starts_with("evt_") && opaque_event_id(id) && scheduled_at > 0
        && scheduled_at.checked_add(10) == Some(deliver_after)
        && scheduled_at <= now.saturating_add(300) && scheduled_at.saturating_add(300) >= now
}
pub fn alerts_ready(enabled: bool, alert_status: &str, verified: bool, assignment_present: bool, expires_at: Option<u64>, now: u64) -> bool {
    enabled && alert_status == "on" && verified && assignment_present
        && expires_at.is_some_and(|expires| expires > now)
}
#[derive(Clone, Copy)]
pub struct AlertRecordBinding<'a> {
    pub handle: Option<&'a str>,
    pub epoch: Option<u64>,
    pub expires_at: Option<u64>,
}
#[derive(Clone, Copy)]
pub struct ProtectedAssignmentBinding<'a> {
    pub handle: &'a str,
    pub epoch: u64,
    pub expires_at: u64,
    pub worker_root: &'a str,
    pub descriptor_hash: &'a str,
    pub status: &'a str,
    pub installation_id: Option<&'a str>,
}
/// Public UI flags cannot establish that this installation still owns the
/// protected, active assignment acknowledged by its selected Worker.
#[derive(Debug, PartialEq, Eq)]
pub enum AssignmentReadiness { Ready, NeedsHostingCheck, SetupRequired }
pub fn assignment_readiness(
    record: AlertRecordBinding<'_>, assignment: ProtectedAssignmentBinding<'_>,
    installation_id: &str, trusted_worker_root: bool, now: u64,
) -> AssignmentReadiness {
    let hex32 = |value: &str| value.len() == 64 && value.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
    let metadata_matches = trusted_worker_root && hex32(assignment.handle) && hex32(assignment.worker_root)
        && hex32(assignment.descriptor_hash) && assignment.epoch > 0
        && assignment.status == "active" && assignment.expires_at > now
        && record.handle == Some(assignment.handle) && record.epoch == Some(assignment.epoch)
        && record.expires_at == Some(assignment.expires_at) && !installation_id.is_empty();
    if !metadata_matches { return AssignmentReadiness::SetupRequired; }
    match assignment.installation_id {
        Some(id) if id == installation_id => AssignmentReadiness::Ready,
        None => AssignmentReadiness::NeedsHostingCheck,
        _ => AssignmentReadiness::SetupRequired,
    }
}
#[cfg(test)]
pub fn protected_assignment_ready(
    record: AlertRecordBinding<'_>, assignment: ProtectedAssignmentBinding<'_>,
    installation_id: &str, trusted_worker_root: bool, now: u64,
) -> bool {
    assignment_readiness(record, assignment, installation_id, trusted_worker_root, now) == AssignmentReadiness::Ready
}
/// Only fixed service codes may cross the diagnostics/UI boundary.
pub fn test_rejection_code(code: Option<&str>) -> &'static str {
    match code {
        Some("self_test_worker_unsupported") => "push-test-worker-unsupported",
        Some("self_test_requires_fast_wallet") => "push-test-fast-wallet-required",
        Some("self_test_provider_required") => "push-test-provider-required",
        Some("self_test_unavailable") => "push-test-unavailable",
        Some("unauthorized") => "push-test-auth-required",
        _ => "push-test-server-rejected",
    }
}
pub fn setup_gate(has_fast_wallet: bool, has_alerts: bool, authorized: bool, provider_ready: bool, gateway_active: bool) -> &'static str {
    if !has_fast_wallet { "fast-wallet-required" }
    else if !has_alerts { "alerts-required" }
    else if !authorized { "permission-required" }
    else if !provider_ready { "provider-required" }
    else if !gateway_active { "gateway-required" }
    else { "ready" }
}
pub fn phase(pending_id: Option<&str>, received_id: Option<&str>, deliver_after: u64, now: u64) -> &'static str {
    match pending_id {
        None => "idle",
        Some(id) if Some(id) == received_id => "received",
        Some(_) if now > deliver_after.saturating_add(120) => "not-received",
        Some(_) => "scheduled",
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn id() -> String { format!("evt_{}", "a".repeat(64)) }
    #[test] fn receipt_requires_real_accepted_ten_second_schedule() {
        assert!(valid_schedule(true, &id(), 1000, 1010, 1001));
        for (accepted, scheduled, deliver) in [(false,1000,1010),(true,1000,1009),(true,1000,1011),(true,0,10),(true,u64::MAX,u64::MAX)] {
            assert!(!valid_schedule(accepted, &id(), scheduled, deliver, 1001));
        }
        assert!(!valid_schedule(true, &id(), 1, 11, 1001));
    }
    #[test] fn identifiers_never_accept_payload_or_legacy_local_test_ids() {
        for id in ["evt_bad", "fwpush_test_123", "wallet-address", "evt_💰", ""] { assert!(!opaque_event_id(id)); }
        assert!(!valid_schedule(true, &format!("evt_{}", "A".repeat(64)), 1000, 1010, 1001));
    }
    #[test] fn receipt_acceptance_or_other_events_cannot_confirm_reception() {
        let pending = id(); let other = format!("evt_{}", "b".repeat(64));
        assert_eq!(phase(Some(&pending), None, 1010, 1011), "scheduled");
        assert_eq!(phase(Some(&pending), Some(&other), 1010, 1011), "scheduled");
        assert_eq!(phase(Some(&pending), Some(&pending), 1010, 1011), "received");
        assert_eq!(phase(Some(&pending), None, 1010, 1131), "not-received");
        assert_eq!(phase(Some(&pending), Some(&pending), 1010, 1131), "received");
    }
    #[test] fn setup_missing_fast_wallet_alerts_or_provider_is_explicit() {
        assert_eq!(setup_gate(false,true,true,true,true), "fast-wallet-required");
        assert_eq!(setup_gate(true,false,true,true,true), "alerts-required");
        assert_eq!(setup_gate(true,true,false,true,true), "permission-required");
        assert_eq!(setup_gate(true,true,true,false,true), "provider-required");
        assert_eq!(setup_gate(true,true,true,true,false), "gateway-required");
        assert_eq!(setup_gate(true,true,true,true,true), "ready");
    }
    #[test] fn encrypted_alerts_depend_on_the_verified_assignment_not_legacy_scanner_status() {
        assert!(alerts_ready(true, "on", true, true, Some(1100), 1000));
        assert!(!alerts_ready(false, "on", true, true, Some(1100), 1000));
        assert!(!alerts_ready(true, "off", true, true, Some(1100), 1000));
        assert!(!alerts_ready(true, "on", false, true, Some(1100), 1000));
        assert!(!alerts_ready(true, "on", true, false, Some(1100), 1000));
        assert!(!alerts_ready(true, "on", true, true, None, 1000));
        assert!(!alerts_ready(true, "on", true, true, Some(1000), 1000));
    }
    fn binding<'a>(handle: &'a str, root: &'a str) -> ProtectedAssignmentBinding<'a> {
        ProtectedAssignmentBinding { handle, epoch: 2, expires_at: 1100, worker_root: root,
            descriptor_hash: root, status: "active", installation_id: Some("installation-a") }
    }
    #[test] fn protected_assignment_must_match_registry_and_current_installation() {
        let handle = "a".repeat(64); let root = "b".repeat(64);
        let record = || AlertRecordBinding { handle: Some(&handle), epoch: Some(2), expires_at: Some(1100) };
        assert!(protected_assignment_ready(record(), binding(&handle, &root), "installation-a", true, 1000));
        assert!(!protected_assignment_ready(record(), binding(&handle, &root), "installation-b", true, 1000));
        let mut legacy = binding(&handle, &root); legacy.installation_id = None;
        assert!(!protected_assignment_ready(record(), legacy, "installation-a", true, 1000));
        let other = "c".repeat(64);
        assert!(!protected_assignment_ready(record(), binding(&other, &root), "installation-a", true, 1000));
        let mut wrong_epoch = binding(&handle, &root); wrong_epoch.epoch = 3;
        assert!(!protected_assignment_ready(record(), wrong_epoch, "installation-a", true, 1000));
        let mut wrong_expiry = binding(&handle, &root); wrong_expiry.expires_at = 1200;
        assert!(!protected_assignment_ready(record(), wrong_expiry, "installation-a", true, 1000));
    }
    #[test] fn untrusted_pending_expired_or_malformed_assignments_never_become_ready() {
        let handle = "a".repeat(64); let root = "b".repeat(64);
        let record = || AlertRecordBinding { handle: Some(&handle), epoch: Some(2), expires_at: Some(1100) };
        assert!(!protected_assignment_ready(record(), binding(&handle, &root), "installation-a", false, 1000));
        assert!(!protected_assignment_ready(record(), binding(&handle, &root), "installation-a", true, 1100));
        let mut pending = binding(&handle, &root); pending.status = "pending";
        assert!(!protected_assignment_ready(record(), pending, "installation-a", true, 1000));
        assert!(!protected_assignment_ready(record(), binding(&handle, "invalid"), "installation-a", true, 1000));
        let mut malformed = binding(&handle, &root); malformed.descriptor_hash = "SECRET-ERROR-TEXT";
        assert!(!protected_assignment_ready(record(), malformed, "installation-a", true, 1000));
    }
    #[test] fn rejected_test_diagnostics_use_only_fixed_allowlisted_codes() {
        assert_eq!(test_rejection_code(Some("self_test_requires_fast_wallet")), "push-test-fast-wallet-required");
        assert_eq!(test_rejection_code(Some("self_test_provider_required")), "push-test-provider-required");
        for input in [None, Some("PRIVATE_TOKEN_VALUE"), Some("arbitrary server exception")]
            { assert_eq!(test_rejection_code(input), "push-test-server-rejected"); }
    }
    #[test] fn intact_legacy_binding_needs_only_a_hosting_check_not_new_enrollment() {
        let handle = "a".repeat(64); let root = "b".repeat(64);
        let record = AlertRecordBinding { handle: Some(&handle), epoch: Some(2), expires_at: Some(1100) };
        let mut legacy = binding(&handle, &root); legacy.installation_id = None;
        assert_eq!(assignment_readiness(record, legacy, "installation-a", true, 1000), AssignmentReadiness::NeedsHostingCheck);
        legacy.installation_id = Some("installation-a");
        assert_eq!(assignment_readiness(record, legacy, "installation-a", true, 1000), AssignmentReadiness::Ready);
        legacy.installation_id = Some("installation-b");
        assert_eq!(assignment_readiness(record, legacy, "installation-a", true, 1000), AssignmentReadiness::SetupRequired);
    }

}
