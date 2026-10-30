//! Pure contract for the current user's notification task. No credentials.
pub const TASK_NAME_PREFIX: &str = "TEX8.MoneroFastWallet.Notifications";
pub fn task_name(sid: &str) -> Result<String, &'static str> {
    if !valid_sid(sid) {
        return Err("The notification task user is invalid.");
    }
    Ok(format!("{TASK_NAME_PREFIX}.{sid}"))
}
pub const TASK_SOURCE: &str = "com.tex8.monerowallet.desktop.notification-agent.v1";
pub const TASK_POLICY_VERSION: u32 = 2;
pub const ACTIVATION_SCHEME: &str = "tex8-mfw-notification";

pub fn legacy_command_matches(command: &str, config: &str) -> bool {
    let Some(command) = command.trim().strip_prefix('"') else {
        return false;
    };
    let Some((executable, argument)) = command.split_once("\" --config \"") else {
        return false;
    };
    let Some(argument) = argument.strip_suffix('"') else {
        return false;
    };
    if executable.contains('"') || argument.contains('"') {
        return false;
    }
    executable
        .rsplit(['/', '\\'])
        .next()
        .is_some_and(|name| name.eq_ignore_ascii_case("monero-fast-walletd.exe"))
        && argument.replace('/', "\\").to_lowercase() == config.replace('/', "\\").to_lowercase()
}

pub fn protocol_command(executable: &str, config: &str) -> Result<String, &'static str> {
    if [executable, config]
        .iter()
        .any(|value| value.is_empty() || value.chars().any(char::is_control))
    {
        return Err("The notification activation path is invalid.");
    }
    Ok(format!(
        "{} --config {} --open-notification \"%1\"",
        quote_argument(executable),
        quote_argument(config)
    ))
}
fn xml(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}
pub fn valid_sid(value: &str) -> bool {
    value.starts_with("S-1-")
        && value.len() <= 184
        && value
            .split('-')
            .skip(1)
            .all(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit()))
}
pub fn quote_argument(value: &str) -> String {
    let mut out = String::from("\"");
    let mut slashes = 0;
    for c in value.chars() {
        if c == '\\' {
            slashes += 1;
            continue;
        }
        if c == '"' {
            out.extend(std::iter::repeat_n('\\', slashes * 2 + 1));
        } else {
            out.extend(std::iter::repeat_n('\\', slashes));
        }
        slashes = 0;
        out.push(c);
    }
    out.extend(std::iter::repeat_n('\\', slashes * 2));
    out.push('"');
    out
}
pub fn task_xml(sid: &str, executable: &str, config: &str) -> Result<String, &'static str> {
    if !valid_sid(sid)
        || [executable, config]
            .iter()
            .any(|v| v.is_empty() || v.chars().any(char::is_control))
    {
        return Err("Notification task parameters are invalid.");
    }
    let arguments = xml(&format!("--config {}", quote_argument(config)));
    let command = xml(executable);
    let boundary = utc_boundary(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|_| "The notification task clock is invalid.")?
            .as_secs(),
    )?;
    Ok(format!(
        r#"<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
 <RegistrationInfo><Description>Monero Fast Wallet private notification helper</Description><Source>{TASK_SOURCE}</Source></RegistrationInfo>
 <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>{sid}</UserId></LogonTrigger><TimeTrigger><Repetition><Interval>PT1M</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition><StartBoundary>{boundary}</StartBoundary><Enabled>true</Enabled></TimeTrigger></Triggers>
 <Principals><Principal id="User"><UserId>{sid}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
 <Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><AllowHardTerminate>true</AllowHardTerminate><StartWhenAvailable>true</StartWhenAvailable><RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable><AllowStartOnDemand>true</AllowStartOnDemand><Enabled>true</Enabled><Hidden>true</Hidden><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure></Settings>
 <Actions Context="User"><Exec><Command>{command}</Command><Arguments>{arguments}</Arguments></Exec></Actions>
</Task>
"#
    ))
}
fn utc_boundary(seconds: u64) -> Result<String, &'static str> {
    if seconds > 253402300799 {
        return Err("The notification task clock is invalid.");
    }
    // Gregorian conversion for the UTC task boundary, independent of locale,
    // daylight-saving changes, PowerShell and external date commands.
    let days = (seconds / 86400) as i64 + 719468;
    let era = days / 146097;
    let day = days - era * 146097;
    let year = (day - day / 1460 + day / 36524 - day / 146096) / 365;
    let ordinal = day - (365 * year + year / 4 - year / 100);
    let month = (5 * ordinal + 2) / 153;
    let date = ordinal - (153 * month + 2) / 5 + 1;
    let month = month + if month < 10 { 3 } else { -9 };
    let year = year + era * 400 + if month <= 2 { 1 } else { 0 };
    let time = seconds % 86400;
    Ok(format!(
        "{year:04}-{month:02}-{date:02}T{:02}:{:02}:{:02}Z",
        time / 3600,
        time / 60 % 60,
        time % 60
    ))
}
pub fn utf16_file(value: &str) -> Vec<u8> {
    let mut bytes = vec![0xff, 0xfe];
    bytes.extend(value.encode_utf16().flat_map(u16::to_le_bytes));
    bytes
}
pub fn fingerprinted_xml(document: String, fingerprint: &str) -> Result<String, &'static str> {
    if fingerprint.len() != 64
        || !fingerprint
            .bytes()
            .all(|b| b.is_ascii_digit() || matches!(b, b'a'..=b'f'))
    {
        return Err("The notification executable fingerprint is invalid.");
    }
    Ok(document.replace(
        "<Source>",
        &format!("<Documentation>definition-sha256:{fingerprint}</Documentation><Source>"),
    ))
}
pub fn decode_xml_output(bytes: &[u8]) -> Result<String, &'static str> {
    if bytes.len() > 64 * 1024 {
        return Err("Notification task response exceeds its limit.");
    }
    if bytes.starts_with(&[0xff, 0xfe]) || (bytes.len() > 4 && bytes[1] == 0 && bytes[3] == 0) {
        let start = if bytes.starts_with(&[0xff, 0xfe]) {
            2
        } else {
            0
        };
        if (bytes.len() - start) % 2 != 0 {
            return Err("Notification task response is invalid.");
        }
        let words = bytes[start..]
            .chunks_exact(2)
            .map(|b| u16::from_le_bytes([b[0], b[1]]))
            .collect::<Vec<_>>();
        return String::from_utf16(&words).map_err(|_| "Notification task response is invalid.");
    }
    String::from_utf8(bytes.to_vec()).map_err(|_| "Notification task response is invalid.")
}
pub fn owned_task(document: &str, sid: &str) -> bool {
    let Some((_, principal)) = document.split_once("<Principals>") else {
        return false;
    };
    let Some((principal, _)) = principal.split_once("</Principals>") else {
        return false;
    };
    valid_sid(sid)
        && document.contains(&format!("<Source>{TASK_SOURCE}</Source>"))
        && principal.contains(&format!("<UserId>{sid}</UserId>"))
        && principal.contains("<LogonType>InteractiveToken</LogonType>")
        && principal.contains("<RunLevel>LeastPrivilege</RunLevel>")
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn interactive_user_restart_without_password_or_elevation() {
        let body = task_xml(
            "S-1-5-21-123-456-789-1001",
            r"C:\Program Files\Wallet\helper.exe",
            r"C:\Users\Müller\a&b\background-agent.json",
        )
        .unwrap();
        assert!(owned_task(&body, "S-1-5-21-123-456-789-1001"));
        for expected in [
            "<RunLevel>LeastPrivilege</RunLevel>",
            "<Interval>PT1M</Interval>",
            "<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>",
            "<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>",
            "<TimeTrigger><Repetition><Interval>PT1M</Interval>",
            "a&amp;b",
            "Müller",
        ] {
            assert!(body.contains(expected));
        }
        for forbidden in ["Password", "HighestAvailable", "SYSTEM", "ServiceAccount"] {
            assert!(!body.contains(forbidden));
        }
    }
    #[test]
    fn ownership_never_accepts_other_tasks_or_users() {
        let body = task_xml("S-1-5-21-1001", "helper.exe", "config.json").unwrap();
        assert!(!owned_task(&body, "S-1-5-21-1002"));
        assert!(!owned_task(
            &body.replace(TASK_SOURCE, "other"),
            "S-1-5-21-1001"
        ));
        assert!(task_xml("S-1-5-21-1001<bad>", "x", "y").is_err());
        assert!(task_xml("S-1-5-21-1001", "x\ny", "z").is_err());
    }
    #[test]
    fn unicode_task_file_and_query_roundtrip() {
        let body = task_xml("S-1-5-21-1001", "Müller.exe", "ä.json").unwrap();
        assert_eq!(decode_xml_output(&utf16_file(&body)).unwrap(), body);
        assert_eq!(decode_xml_output(body.as_bytes()).unwrap(), body);
        assert!(decode_xml_output(&[0xff, 0xfe, 1]).is_err());
        assert!(decode_xml_output(&vec![b'x'; 65537]).is_err());
    }
    #[test]
    fn arguments_preserve_spaces_quotes_and_final_slashes() {
        assert_eq!(quote_argument("a b"), "\"a b\"");
        assert_eq!(quote_argument("a\"b"), "\"a\\\"b\"");
        assert_eq!(quote_argument("C:\\end\\"), "\"C:\\end\\\\\"");
    }
    #[test]
    fn executable_update_is_bound_to_the_task_definition() {
        let body = fingerprinted_xml(
            task_xml("S-1-5-21-1001", "helper.exe", "config.json").unwrap(),
            &"a".repeat(64),
        )
        .unwrap();
        assert!(body.contains(&format!(
            "<Documentation>definition-sha256:{}</Documentation>",
            "a".repeat(64)
        )));
        assert!(fingerprinted_xml(body, "<invalid>").is_err());
    }
    #[test]
    fn protocol_handler_has_one_fixed_url_argument_and_no_shell() {
        let command = protocol_command(
            r"C:\Users\Müller\private helper.exe",
            r"C:\data\config.json",
        )
        .unwrap();
        assert_eq!(command, "\"C:\\Users\\Müller\\private helper.exe\" --config \"C:\\data\\config.json\" --open-notification \"%1\"");
        assert!(!command.contains("cmd.exe"));
        assert!(protocol_command("/bad\npath", "config").is_err());
        assert_eq!(ACTIVATION_SCHEME, "tex8-mfw-notification");
    }
    #[test]
    fn watchdog_time_is_utc_and_ownership_uses_principal_not_trigger_user() {
        assert_eq!(utc_boundary(0).unwrap(), "1970-01-01T00:00:00Z");
        assert_eq!(utc_boundary(951782400).unwrap(), "2000-02-29T00:00:00Z");
        assert_eq!(utc_boundary(1793321825).unwrap(), "2026-10-30T00:57:05Z");
        assert!(utc_boundary(u64::MAX).is_err());
        let body = task_xml("S-1-5-21-1001", "helper.exe", "config.json").unwrap();
        let other = body.replace(
            "<Principals><Principal id=\"User\"><UserId>S-1-5-21-1001</UserId>",
            "<Principals><Principal id=\"User\"><UserId>S-1-5-21-1002</UserId>",
        );
        assert!(!owned_task(&other, "S-1-5-21-1001"));
    }
    #[test]
    fn task_names_are_scoped_to_each_user_in_the_machine_wide_namespace() {
        assert_ne!(
            task_name("S-1-5-21-1001").unwrap(),
            task_name("S-1-5-21-1002").unwrap()
        );
        assert!(task_name("S-1-5-21-1001\\other").is_err());
    }
    #[test]
    fn legacy_run_cleanup_requires_exact_helper_and_config_arguments() {
        let command = r#""C:\Users\Müller\monero-fast-walletd.exe" --config "C:\data space\background-agent.json""#;
        assert!(legacy_command_matches(
            command,
            r"C:\data space\background-agent.json"
        ));
        assert!(!legacy_command_matches(
            &command.replace(".json\"", ".json.other\""),
            r"C:\data space\background-agent.json"
        ));
        assert!(!legacy_command_matches(
            &command.replace("monero-fast-walletd.exe", "other-monero-fast-walletd.exe"),
            r"C:\data space\background-agent.json"
        ));
        assert!(!legacy_command_matches(
            &format!("{command} --other"),
            r"C:\data space\background-agent.json"
        ));
    }
}
