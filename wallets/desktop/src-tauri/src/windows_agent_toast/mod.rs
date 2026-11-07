//! Native toast identity and stable replacement keys for the installed wallet.
//! Protocol activation survives helper restarts; dismissal never opens the app.
use windows::{
    core::{Interface, HSTRING},
    Data::Xml::Dom::XmlDocument,
    Foundation::{DateTime, IReference, PropertyValue, TypedEventHandler},
    UI::Notifications::{
        NotificationSetting, ToastDismissedEventArgs, ToastFailedEventArgs, ToastNotification,
        ToastNotificationManager, ToastNotifier,
    },
};

mod identity;
mod policy;
use policy::{
    bootstrap_expiration_ticks, notification_setting_phase, setting_with_registration, WALLET_AUMID,
};
thread_local! {
    // Keep callback sources alive while this process runs. Old toasts still
    // activate through the persistent protocol after eviction or restart.
    static LIVE_TOASTS: std::cell::RefCell<std::collections::VecDeque<ToastNotification>> =
        const { std::cell::RefCell::new(std::collections::VecDeque::new()) };
}

pub fn show(
    app_command: &str,
    event_id: &str,
    body: &str,
    log: &super::agent_runtime::AgentLog,
) -> Result<(), String> {
    // Reject an invalid server identifier before touching shell identity.
    let (tag, group) = super::agent_runtime::replacement_keys(event_id)?;
    let uri = super::agent_runtime::notification_uri(event_id)?;
    match identity::ensure(std::path::Path::new(app_command)) {
        Ok(changed) => log.event(
            if changed {
                "os_identity_registered"
            } else {
                "os_identity_verified"
            },
            Some(event_id),
        ),
        Err(error) => {
            log.event_with_windows_status(error.phase, Some(event_id), Some(error.code), None);
            return Err("notification-toast-identity-failed".into());
        }
    }
    let notifier =
        ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(WALLET_AUMID))
            .map_err(|error| os_error(log, "os_notifier_create_failed", event_id, error))?;
    let setting = setting_with_registration(
        || {
            notifier
                .Setting()
                .map(|setting| setting.0)
                .map_err(|error| {
                    log.event_with_windows_status(
                        "os_setting_query_failed",
                        Some(event_id),
                        Some(error.code().0),
                        None,
                    );
                    error.code().0
                })
        },
        || bootstrap_registration(&notifier, event_id, log).map_err(|error| error.code().0),
    )
    .map_err(|_| "os_setting_unavailable".to_owned())?;
    log.event_with_windows_status(
        notification_setting_phase(setting),
        Some(event_id),
        None,
        Some(setting),
    );
    if setting != NotificationSetting::Enabled.0 {
        return Err(notification_setting_phase(setting).into());
    }
    // Windows limits both Tag and Group to 16 characters. Together they bind
    // 128 bits of the opaque id's hash without placing it in visible content.
    let tag = HSTRING::from(tag);
    let group = HSTRING::from(group);
    let xml = XmlDocument::new()
        .map_err(|error| os_error(log, "os_xml_create_failed", event_id, error))?;
    xml.LoadXml(&HSTRING::from(format!(
        "<toast activationType=\"protocol\" launch=\"{uri}\"><visual><binding template=\"ToastGeneric\"><text>Monero Fast Wallet</text><text>{body}</text></binding></visual><actions><action content=\"Open wallet\" arguments=\"{uri}\" activationType=\"protocol\"/></actions></toast>"
    ))).map_err(|error| os_error(log, "os_xml_load_failed", event_id, error))?;
    let toast = ToastNotification::CreateToastNotification(&xml)
        .map_err(|error| os_error(log, "os_toast_create_failed", event_id, error))?;
    let dismissed_log = log.clone();
    let dismissed_id = event_id.to_owned();
    toast
        .SetTag(&tag)
        .and_then(|_| toast.SetGroup(&group))
        .map_err(|error| os_error(log, "os_toast_tag_failed", event_id, error))?;
    toast
        .Dismissed(&TypedEventHandler::<
            ToastNotification,
            ToastDismissedEventArgs,
        >::new(move |_, _| {
            dismissed_log.event("dismissed", Some(&dismissed_id));
            Ok(())
        }))
        .map_err(|error| os_error(log, "os_dismiss_handler_failed", event_id, error))?;
    let failed_log = log.clone();
    let failed_id = event_id.to_owned();
    toast
        .Failed(
            &TypedEventHandler::<ToastNotification, ToastFailedEventArgs>::new(move |_, args| {
                match args.as_ref().map(ToastFailedEventArgs::ErrorCode) {
                    Some(Ok(code)) => failed_log.event_with_windows_status(
                        "os_failed",
                        Some(&failed_id),
                        Some(code.0),
                        None,
                    ),
                    Some(Err(error)) => failed_log.event_with_windows_status(
                        "os_failed_code_unavailable",
                        Some(&failed_id),
                        Some(error.code().0),
                        None,
                    ),
                    None => failed_log.event("os_failed_code_unavailable", Some(&failed_id)),
                }
                Ok(())
            }),
        )
        .map_err(|error| os_error(log, "os_failed_handler_failed", event_id, error))?;
    notifier
        .Show(&toast)
        .map_err(|error| os_error(log, "os_show_failed", event_id, error))?;
    LIVE_TOASTS.with(|live| {
        let mut live = live.borrow_mut();
        live.push_back(toast);
        if live.len() > 64 {
            live.pop_front();
        }
    });
    Ok(())
}

fn bootstrap_registration(
    notifier: &ToastNotifier,
    event_id: &str,
    log: &super::agent_runtime::AgentLog,
) -> windows::core::Result<()> {
    // Microsoft's ToastNotifierCompat primes unpackaged apps before reading
    // Setting: a silent, expiring toast is immediately removed from history.
    // https://github.com/CommunityToolkit/WindowsCommunityToolkit/blob/main/Microsoft.Toolkit.Uwp.Notifications/Toasts/Compat/ToastNotificationManagerCompat.cs
    // This is OS identity initialization only. It neither acknowledges the
    // server event nor changes notification permissions; the real event still
    // goes through Setting, Show, its journal and its server acknowledgement.
    log.event("os_bootstrap_started", Some(event_id));
    let result: windows::core::Result<()> = (|| {
        let xml = XmlDocument::new()?;
        xml.LoadXml(&HSTRING::from(
            "<toast><visual><binding template=\"ToastGeneric\"><text>Monero Fast Wallet</text></binding></visual></toast>",
        ))?;
        let toast = ToastNotification::CreateToastNotification(&xml)?;
        let tag = HSTRING::from("mfw-initialize");
        let group = HSTRING::from("mfw-bootstrap");
        toast.SetTag(&tag)?;
        toast.SetGroup(&group)?;
        toast.SetSuppressPopup(true)?;
        let ticks = bootstrap_expiration_ticks(super::agent_runtime::now()).ok_or_else(|| {
            windows::core::Error::from_hresult(windows::core::HRESULT(0x80070057_u32 as i32))
        })?;
        let expiration: IReference<DateTime> = PropertyValue::CreateDateTime(DateTime {
            UniversalTime: ticks,
        })?
        .cast()?;
        toast.SetExpirationTime(&expiration)?;
        let history = ToastNotificationManager::History()?;
        let submitted = notifier.Show(&toast);
        // Remove only our reserved primer, never another notification. Even
        // an uncertain Show result gets cleanup; expiration remains a backup.
        let removed = history.RemoveGroupedTagWithId(&tag, &group, &HSTRING::from(WALLET_AUMID));
        submitted?;
        removed?;
        Ok(())
    })();
    match &result {
        Ok(()) => log.event("os_bootstrap_completed", Some(event_id)),
        Err(error) => log.event_with_windows_status(
            "os_bootstrap_failed",
            Some(event_id),
            Some(error.code().0),
            None,
        ),
    }
    result
}

fn os_error(
    log: &super::agent_runtime::AgentLog,
    phase: &'static str,
    event_id: &str,
    error: windows::core::Error,
) -> String {
    log.event_with_windows_status(phase, Some(event_id), Some(error.code().0), None);
    phase.to_owned()
}
