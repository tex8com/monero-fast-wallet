//! Decisions for resuming and waiting on the native APNs callback.
//! Kept independent of AppKit so delayed/denied callbacks are testable.

pub const TIMEOUT_MILLIS: u128 = 45_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Progress {
    NotRequested,
    Pending,
    Ready,
    Denied,
    AuthorizationRequired,
    AuthorizationError,
    RegistrationError,
    Failed,
    BundleRequired,
    TimedOut,
}

pub fn progress(status: &str, token_present: bool, elapsed_millis: u128) -> Progress {
    if status.starts_with("authorization-error|") || status.starts_with("permission-failed:") {
        return Progress::AuthorizationError;
    }
    if status.starts_with("registration-error|") || status.starts_with("failed:") {
        return Progress::RegistrationError;
    }
    match status {
        "not-requested" => Progress::NotRequested,
        "registered" if token_present => Progress::Ready,
        "permission-denied" | "authorization-denied" => Progress::Denied,
        "authorization-required" => Progress::AuthorizationRequired,
        "registration-timeout" => Progress::TimedOut,
        "requires-app-bundle" => Progress::BundleRequired,
        "requesting-permission"
        | "checking-authorization"
        | "requesting-authorization"
        | "registering" => {
            if elapsed_millis >= TIMEOUT_MILLIS {
                Progress::TimedOut
            } else {
                Progress::Pending
            }
        }
        _ => Progress::Failed,
    }
}

pub fn status_kind(status: &str) -> &'static str {
    match progress(status, true, 0) {
        Progress::NotRequested => "not-requested",
        Progress::Pending if status == "registering" => "registering",
        Progress::Pending => "authorization-pending",
        Progress::Ready => "registered",
        Progress::Denied => "authorization-denied",
        Progress::AuthorizationRequired => "authorization-required",
        Progress::TimedOut => "registration-timeout",
        Progress::AuthorizationError => "authorization-error",
        Progress::RegistrationError => "registration-error",
        Progress::BundleRequired => "requires-app-bundle",
        _ => "registration-failed",
    }
}

pub fn resume_allowed(enabled: bool, permission: &str) -> bool {
    enabled && matches!(permission, "authorized" | "provisional")
}

pub fn permission_settings_available(native_authorization: &str) -> bool {
    native_authorization == "denied"
}

pub fn fixed_settings_url(focus: bool) -> &'static str {
    if focus {
        "x-apple.systempreferences:com.apple.Focus-Settings.extension"
    } else {
        "x-apple.systempreferences:com.apple.preference.notifications?id=com.tex8.monerowallet.desktop"
    }
}

// Generation prevents a late callback from overwriting an off/on change that
// happens within the same second, even if the final boolean is the same.
pub fn preference_matches(expected: (u64, bool, &str), current: (u64, bool, &str)) -> bool {
    expected == current
}

pub fn error_metadata(status: &str) -> Option<(&str, i64)> {
    let mut fields = status.split('|');
    if !matches!(fields.next()?, "authorization-error" | "registration-error") {
        return None;
    }
    let domain = fields.next()?;
    if domain.is_empty()
        || domain.len() > 128
        || !domain
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
    {
        return None;
    }
    let code = fields.next()?.parse().ok()?;
    if fields.next().is_some() {
        return None;
    }
    Some((domain, code))
}

pub fn gateway_current(status: &str, expires: Option<u64>, checked: Option<u64>, now: u64) -> bool {
    status == "active"
        && expires.is_some_and(|value| value > now)
        && checked.is_some_and(|value| {
            value > 0 && value <= now && value.saturating_add(24 * 60 * 60) > now
        })
}

pub async fn wait_for_callback<O, S, F>(mut observe: O, mut sleep: S) -> Progress
where
    O: FnMut() -> (String, bool, u128),
    S: FnMut() -> F,
    F: std::future::Future<Output = ()>,
{
    loop {
        let (status, token_present, elapsed_millis) = observe();
        let decision = progress(&status, token_present, elapsed_millis);
        if decision != Progress::Pending {
            return decision;
        }
        sleep().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        cell::Cell,
        collections::VecDeque,
        future::Future,
        pin::pin,
        task::{Context, Poll, Waker},
    };

    #[test]
    fn asynchronous_wait_finishes_on_delayed_callback_without_restart() {
        let mut states = VecDeque::from([
            ("requesting-permission".to_owned(), true, 0),
            ("registering".to_owned(), true, 200),
            ("registered".to_owned(), true, 400),
        ]);
        let sleeps = Cell::new(0);
        let mut future = pin!(wait_for_callback(
            || states
                .pop_front()
                .expect("unexpected polling after callback"),
            || {
                sleeps.set(sleeps.get() + 1);
                std::future::ready(())
            },
        ));
        assert_eq!(
            future
                .as_mut()
                .poll(&mut Context::from_waker(Waker::noop())),
            Poll::Ready(Progress::Ready)
        );
        assert_eq!(sleeps.get(), 2);
    }

    #[test]
    fn pending_native_callback_yields_instead_of_blocking_the_executor() {
        let mut future = pin!(wait_for_callback(
            || ("registering".to_owned(), false, 200),
            std::future::pending,
        ));
        assert_eq!(
            future
                .as_mut()
                .poll(&mut Context::from_waker(Waker::noop())),
            Poll::Pending
        );
    }

    #[test]
    fn native_denial_and_timeout_stop_the_asynchronous_wait() {
        for (status, elapsed, expected) in [
            ("permission-denied", 200, Progress::Denied),
            ("failed: registration", 200, Progress::RegistrationError),
            ("registering", TIMEOUT_MILLIS, Progress::TimedOut),
        ] {
            let mut future = pin!(wait_for_callback(
                || (status.to_owned(), true, elapsed),
                || -> std::future::Ready<()> { panic!("terminal state must not sleep") },
            ));
            assert_eq!(
                future
                    .as_mut()
                    .poll(&mut Context::from_waker(Waker::noop())),
                Poll::Ready(expected)
            );
        }
    }

    #[test]
    fn delayed_callback_can_complete_the_same_attempt() {
        let observations = [
            ("requesting-permission", false, 0),
            ("requesting-permission", false, 500),
            ("registering", false, 1_000),
            ("registered", true, 1_200),
        ];
        let decisions: Vec<_> = observations
            .into_iter()
            .map(|(state, token, elapsed)| progress(state, token, elapsed))
            .collect();
        assert_eq!(
            decisions,
            [
                Progress::Pending,
                Progress::Pending,
                Progress::Pending,
                Progress::Ready
            ]
        );
    }

    #[test]
    fn old_token_does_not_complete_a_new_permission_attempt() {
        assert_eq!(
            progress("requesting-permission", true, 0),
            Progress::Pending
        );
        assert_eq!(progress("registering", true, 500), Progress::Pending);
        assert_eq!(progress("permission-denied", true, 600), Progress::Denied);
    }

    #[test]
    fn bounded_wait_allows_a_callback_at_the_deadline() {
        assert_eq!(
            progress("registering", false, TIMEOUT_MILLIS - 1),
            Progress::Pending
        );
        assert_eq!(
            progress("registering", false, TIMEOUT_MILLIS),
            Progress::TimedOut
        );
        assert_eq!(
            progress("registered", true, TIMEOUT_MILLIS),
            Progress::Ready
        );
    }

    #[test]
    fn native_failures_never_become_readiness() {
        for state in ["empty-token", "registered", "unknown"] {
            assert_eq!(progress(state, false, 100), Progress::Failed);
        }
        assert_eq!(
            progress("requires-app-bundle", true, 100),
            Progress::BundleRequired
        );
        assert_eq!(
            progress("failed: registration", true, 100),
            Progress::RegistrationError
        );
    }

    #[test]
    fn authorization_errors_are_not_user_denials_even_with_an_old_token() {
        for token in [false, true] {
            assert_eq!(
                progress("authorization-error|UNErrorDomain|1", token, 10),
                Progress::AuthorizationError
            );
            assert_eq!(
                progress("permission-failed: old description", token, 10),
                Progress::AuthorizationError
            );
            assert_eq!(
                progress("authorization-denied", token, 10),
                Progress::Denied
            );
            assert_eq!(
                progress("registration-error|NSCocoaErrorDomain|-1", token, 10),
                Progress::RegistrationError
            );
        }
        assert_eq!(
            progress("checking-authorization", true, 0),
            Progress::Pending
        );
        assert_eq!(
            progress("requesting-authorization", true, TIMEOUT_MILLIS),
            Progress::TimedOut
        );
    }

    #[test]
    fn diagnostics_accept_only_domain_and_integer_code() {
        assert_eq!(
            error_metadata("authorization-error|UNErrorDomain|1"),
            Some(("UNErrorDomain", 1))
        );
        assert_eq!(
            error_metadata("registration-error|NSCocoaErrorDomain|-1"),
            Some(("NSCocoaErrorDomain", -1))
        );
        for invalid in [
            "authorization-error|user info|1",
            "authorization-error|UNErrorDomain|private",
            "authorization-error|UNErrorDomain|1|token",
            "permission-failed: private description",
        ] {
            assert_eq!(error_metadata(invalid), None);
        }
        assert_eq!(
            status_kind("authorization-error|UNErrorDomain|1"),
            "authorization-error"
        );
    }

    #[test]
    fn cached_gateway_activity_requires_a_current_check_and_live_lease() {
        let now = 10 * 24 * 60 * 60;
        assert!(gateway_current(
            "active",
            Some(now + 100),
            Some(now - 5),
            now
        ));
        assert!(!gateway_current(
            "active",
            Some(now - 1),
            Some(now - 5),
            now
        ));
        assert!(!gateway_current(
            "active",
            Some(now + 100),
            Some(now - 24 * 60 * 60),
            now
        ));
        assert!(!gateway_current(
            "active",
            Some(now + 100),
            Some(now + 1),
            now
        ));
        assert!(!gateway_current("active", Some(now + 100), None, now));
    }

    #[test]
    fn ordinary_status_read_does_not_start_an_opt_in() {
        assert_eq!(progress("not-requested", false, 0), Progress::NotRequested);
        assert_eq!(progress("not-requested", true, 0), Progress::NotRequested);
    }

    #[test]
    fn resume_requires_the_existing_opt_in_and_never_confuses_missing_permission_with_denial() {
        assert!(resume_allowed(true, "authorized"));
        assert!(resume_allowed(true, "provisional"));
        for permission in ["authorized", "unknown", "denied"] {
            assert!(!resume_allowed(false, permission));
        }
        assert!(!resume_allowed(true, "unknown"));
        assert!(!resume_allowed(true, "denied"));
        assert_eq!(progress("authorization-required", true, 0), Progress::AuthorizationRequired);
        assert_eq!(status_kind("registration-timeout"), "registration-timeout");
    }

    #[test]
    fn native_attempt_deadline_survives_a_new_waiter() {
        assert_eq!(progress("registering", true, TIMEOUT_MILLIS - 1), Progress::Pending);
        assert_eq!(progress("registering", true, TIMEOUT_MILLIS), Progress::TimedOut);
        assert_eq!(progress("registration-timeout", true, 0), Progress::TimedOut);
        assert_eq!(progress("checking-authorization", true, 0), Progress::Pending);
        assert_eq!(progress("registered", false, 0), Progress::Failed);
    }

    #[test]
    fn late_registration_cannot_restore_an_old_preference_even_after_off_on() {
        assert!(preference_matches((4, true, "authorized"), (4, true, "authorized")));
        assert!(!preference_matches((4, true, "authorized"), (5, false, "denied")));
        assert!(!preference_matches((4, true, "authorized"), (6, true, "authorized")));
        assert!(!preference_matches((4, true, "authorized"), (4, false, "authorized")));
    }

    #[test]
    fn settings_shortcut_requires_the_current_native_denial() {
        assert!(permission_settings_available("denied"));
        for state in ["unknown", "checking", "authorized", "provisional", "not-determined",
            "permission-required", "disabled", "apns-authorization-denied"] {
            assert!(!permission_settings_available(state));
        }
    }

    #[test]
    fn settings_actions_have_only_the_two_fixed_os_owned_targets() {
        assert_eq!(fixed_settings_url(false),
            "x-apple.systempreferences:com.apple.preference.notifications?id=com.tex8.monerowallet.desktop");
        assert_eq!(fixed_settings_url(true),
            "x-apple.systempreferences:com.apple.Focus-Settings.extension");
        assert_ne!(fixed_settings_url(false), fixed_settings_url(true));
    }
}
