pub const WALLET_AUMID: &str = "com.tex8.monerowallet.desktop";
const ERROR_NOT_FOUND: i32 = 0x80070490_u32 as i32;

/// Unpackaged Windows apps cannot query notification settings until their
/// first notification registers the identity. Only that exact missing-record
/// error permits initialization; a failed retry is returned without looping.
pub fn setting_with_registration(
    mut query: impl FnMut() -> Result<i32, i32>,
    register: impl FnOnce() -> Result<(), i32>,
) -> Result<i32, i32> {
    match query() {
        Err(ERROR_NOT_FOUND) => {
            register()?;
            query()
        }
        result => result,
    }
}

/// WinRT DateTime counts 100 ns ticks since 1601. The primer expires after
/// 15 seconds if Windows cannot remove it from notification history.
pub fn bootstrap_expiration_ticks(unix_seconds: u64) -> Option<i64> {
    let seconds = unix_seconds.checked_add(11_644_473_600)?.checked_add(15)?;
    let ticks = seconds.checked_mul(10_000_000)?;
    i64::try_from(ticks).ok()
}

#[derive(Debug, PartialEq, Eq)]
pub enum ShortcutAction {
    Keep,
    SetIdentity,
}

/// Only adopt the ordinary installer shortcut for this exact executable.
/// Other targets, custom launch arguments and another app's identity survive.
pub fn shortcut_action(
    same_executable: bool,
    empty_arguments: bool,
    identity: Option<&str>,
) -> Result<ShortcutAction, ()> {
    if !same_executable || !empty_arguments {
        return Err(());
    }
    match identity {
        Some(WALLET_AUMID) => Ok(ShortcutAction::Keep),
        None | Some("") => Ok(ShortcutAction::SetIdentity),
        Some(_) => Err(()),
    }
}

pub fn notification_setting_phase(setting: i32) -> &'static str {
    match setting {
        0 => "os_setting_enabled",
        1 => "os_disabled_for_application",
        2 => "os_disabled_for_user",
        3 => "os_disabled_by_group_policy",
        4 => "os_disabled_by_manifest",
        _ => "os_setting_unknown",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ordinary_owned_installer_shortcut_can_acquire_its_identity() {
        assert_eq!(
            shortcut_action(true, true, None),
            Ok(ShortcutAction::SetIdentity)
        );
        assert_eq!(
            shortcut_action(true, true, Some("")),
            Ok(ShortcutAction::SetIdentity)
        );
        assert_eq!(
            shortcut_action(true, true, Some(WALLET_AUMID)),
            Ok(ShortcutAction::Keep)
        );
    }

    #[test]
    fn unrelated_target_arguments_and_identity_are_preserved() {
        assert!(shortcut_action(false, true, None).is_err());
        assert!(shortcut_action(true, false, None).is_err());
        assert!(shortcut_action(true, true, Some("another.application")).is_err());
    }

    #[test]
    fn os_settings_have_distinct_stable_diagnostics() {
        let phases = (0..=4)
            .map(notification_setting_phase)
            .collect::<std::collections::HashSet<_>>();
        assert_eq!(phases.len(), 5);
        assert_eq!(notification_setting_phase(5), "os_setting_unknown");
    }

    #[test]
    fn missing_registration_is_initialized_once_then_settings_are_read_again() {
        let calls = std::cell::RefCell::new(Vec::new());
        let mut results = [Err(ERROR_NOT_FOUND), Ok(0)].into_iter();
        let setting = setting_with_registration(
            || {
                calls.borrow_mut().push("query");
                results.next().expect("only two setting queries")
            },
            || {
                calls.borrow_mut().push("register");
                Ok(())
            },
        );
        assert_eq!(setting, Ok(0));
        assert_eq!(*calls.borrow(), ["query", "register", "query"]);
    }

    #[test]
    fn disabled_policies_do_not_initialize_or_become_enabled() {
        for disabled in 1..=4 {
            assert_eq!(
                setting_with_registration(|| Ok(disabled), || panic!("already registered")),
                Ok(disabled)
            );
            let mut results = [Err(ERROR_NOT_FOUND), Ok(disabled)].into_iter();
            assert_eq!(
                setting_with_registration(|| results.next().unwrap(), || Ok(())),
                Ok(disabled)
            );
        }
    }

    #[test]
    fn unrelated_setting_errors_never_trigger_registration() {
        for error in [0x80070005_u32 as i32, 0x800401F0_u32 as i32, -1] {
            assert_eq!(
                setting_with_registration(|| Err(error), || panic!("unrelated failure")),
                Err(error)
            );
        }
    }

    #[test]
    fn failed_registration_and_failed_second_query_are_not_retried() {
        let calls = std::cell::Cell::new(0);
        let failed = setting_with_registration(
            || {
                calls.set(calls.get() + 1);
                Err(ERROR_NOT_FOUND)
            },
            || Err(0x80070005_u32 as i32),
        );
        assert_eq!(failed, Err(0x80070005_u32 as i32));
        assert_eq!(calls.get(), 1);

        calls.set(0);
        let failed = setting_with_registration(
            || {
                calls.set(calls.get() + 1);
                Err(ERROR_NOT_FOUND)
            },
            || Ok(()),
        );
        assert_eq!(failed, Err(ERROR_NOT_FOUND));
        assert_eq!(calls.get(), 2);
    }

    #[test]
    fn primer_expiration_uses_windows_epoch_and_a_short_bounded_lifetime() {
        assert_eq!(bootstrap_expiration_ticks(0), Some(116_444_736_150_000_000));
        let now = 1_794_071_592;
        let windows_now = (now + 11_644_473_600) * 10_000_000;
        assert_eq!(
            bootstrap_expiration_ticks(now),
            Some(windows_now as i64 + 150_000_000)
        );
        assert_eq!(bootstrap_expiration_ticks(u64::MAX), None);
        assert_eq!(
            bootstrap_expiration_ticks(i64::MAX as u64 / 10_000_000),
            None
        );
    }
}
