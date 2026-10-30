//! Native toast identity and stable replacement keys for the installed wallet.
//! Protocol activation survives helper restarts; dismissal never opens the app.
use windows::{
    core::HSTRING,
    Data::Xml::Dom::XmlDocument,
    Foundation::TypedEventHandler,
    UI::Notifications::{
        ToastDismissedEventArgs, ToastFailedEventArgs, ToastNotification, ToastNotificationManager,
    },
};

const WALLET_AUMID: &str = "com.tex8.monerowallet.desktop";
thread_local! {
    // Keep callback sources alive while this process runs. Old toasts still
    // activate through the persistent protocol after eviction or restart.
    static LIVE_TOASTS: std::cell::RefCell<std::collections::VecDeque<ToastNotification>> =
        const { std::cell::RefCell::new(std::collections::VecDeque::new()) };
}

pub fn show(
    event_id: &str,
    body: &str,
    log: &super::agent_runtime::AgentLog,
) -> Result<(), String> {
    let (tag, group) = super::agent_runtime::replacement_keys(event_id)?;
    // Windows limits both Tag and Group to 16 characters. Together they bind
    // 128 bits of the opaque id's hash without placing it in visible content.
    let tag = HSTRING::from(tag);
    let group = HSTRING::from(group);
    let uri = super::agent_runtime::notification_uri(event_id)?;
    let xml = XmlDocument::new().map_err(|_| "toast_xml_unavailable")?;
    xml.LoadXml(&HSTRING::from(format!(
        "<toast activationType=\"protocol\" launch=\"{uri}\"><visual><binding template=\"ToastGeneric\"><text>Monero Fast Wallet</text><text>{body}</text></binding></visual><actions><action content=\"Open wallet\" arguments=\"{uri}\" activationType=\"protocol\"/></actions></toast>"
    ))).map_err(|_| "toast_xml_invalid")?;
    let toast =
        ToastNotification::CreateToastNotification(&xml).map_err(|_| "toast_creation_failed")?;
    let dismissed_log = log.clone();
    let dismissed_id = event_id.to_owned();
    toast
        .SetTag(&tag)
        .and_then(|_| toast.SetGroup(&group))
        .map_err(|_| "toast_identity_failed")?;
    toast
        .Dismissed(&TypedEventHandler::<
            ToastNotification,
            ToastDismissedEventArgs,
        >::new(move |_, _| {
            dismissed_log.event("dismissed", Some(&dismissed_id));
            Ok(())
        }))
        .map_err(|_| "toast_dismissal_failed")?;
    let failed_log = log.clone();
    let failed_id = event_id.to_owned();
    toast
        .Failed(
            &TypedEventHandler::<ToastNotification, ToastFailedEventArgs>::new(move |_, _| {
                failed_log.event("os_failed", Some(&failed_id));
                Ok(())
            }),
        )
        .map_err(|_| "toast_failure_handler_failed")?;
    ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(WALLET_AUMID))
        .and_then(|notifier| notifier.Show(&toast))
        .map_err(|_| "toast_submit_failed".to_owned())?;
    LIVE_TOASTS.with(|live| {
        let mut live = live.borrow_mut();
        live.push_back(toast);
        if live.len() > 64 {
            live.pop_front();
        }
    });
    Ok(())
}
