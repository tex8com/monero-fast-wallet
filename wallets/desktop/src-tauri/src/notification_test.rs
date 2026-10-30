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
}
