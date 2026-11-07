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
    // PathBuf::join with a multi-component string can retain '/' on Windows.
    // Emit one separator convention so the scheduler's export is stable.
    let arguments = xml(&format!(
        "--config {}",
        quote_argument(&config.replace('/', "\\"))
    ));
    let command = xml(&executable.replace('/', "\\"));
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
pub fn task_query_not_found(exit_code: Option<i32>) -> bool {
    // /HRESULT makes this distinction independent of the Windows language.
    // Access-denied and service failures must never authorize replacement.
    exit_code.is_some_and(|code| code as u32 == 0x8007_0002)
}
fn section<'a>(document: &'a str, tag: &str) -> Option<&'a str> {
    let start = format!("<{tag}");
    let (before, after) = document.split_once(&start)?;
    if before.contains(&start) || !after.starts_with(|c: char| c == '>' || c.is_ascii_whitespace())
    {
        return None;
    }
    let (_, body) = after.split_once('>')?;
    let (body, remaining) = body.split_once(&format!("</{tag}>"))?;
    (!remaining.contains(&start)).then_some(body)
}

fn text(document: &str, tag: &str) -> Option<String> {
    let value = section(document, tag)?.trim();
    if value.contains('<') {
        return None;
    }
    let mut decoded = String::new();
    let mut rest = value;
    while let Some((plain, entity)) = rest.split_once('&') {
        decoded.push_str(plain);
        let (name, tail) = entity.split_once(';')?;
        decoded.push(match name {
            "amp" => '&',
            "lt" => '<',
            "gt" => '>',
            "quot" => '"',
            "apos" => '\'',
            _ => return None,
        });
        rest = tail;
    }
    decoded.push_str(rest);
    Some(decoded)
}

pub fn owned_task(document: &str, sid: &str, config: &str) -> bool {
    let Some((_, principal)) = document.split_once("<Principals>") else {
        return false;
    };
    let Some((principal, _)) = principal.split_once("</Principals>") else {
        return false;
    };
    // Task Scheduler removes default-valued RunLevel when exporting a task.
    // Its absent value is TASK_RUNLEVEL_LUA (0), not an elevated principal.
    let least_privilege = if principal.contains("<RunLevel") {
        text(principal, "RunLevel").as_deref() == Some("LeastPrivilege")
    } else {
        true
    };
    let Some(actions) = section(document, "Actions") else {
        return false;
    };
    let Some(exec) = section(actions, "Exec") else {
        return false;
    };
    if actions.contains("<ComHandler") {
        return false;
    }
    let Some(command) = text(exec, "Command") else {
        return false;
    };
    let Some(arguments) = text(exec, "Arguments") else {
        return false;
    };
    let config = config.replace('/', "\\");
    let Some((directory, _)) = config.rsplit_once('\\') else {
        return false;
    };
    let prefix = format!("{directory}\\runtime\\");
    let command = command.replace('/', "\\");
    let Some(rest) = command.get(prefix.len()..) else {
        return false;
    };
    let command_owned = command[..prefix.len()].eq_ignore_ascii_case(&prefix)
        && rest.split_once('\\').is_some_and(|(fingerprint, binary)| {
            fingerprint.len() == 24
                && fingerprint.bytes().all(|b| b.is_ascii_hexdigit())
                && binary.eq_ignore_ascii_case("monero-fast-walletd.exe")
        });
    valid_sid(sid)
        && text(document, "Source").as_deref() == Some(TASK_SOURCE)
        && text(principal, "UserId").as_deref() == Some(sid)
        && text(principal, "LogonType").as_deref() == Some("InteractiveToken")
        && least_privilege
        && command_owned
        // Existing app-created tasks can contain mixed separators in their
        // quoted config path. Only separator equivalence is accepted: the
        // complete switch, quoting, and exact config path must still match.
        && arguments
            .replace('/', "\\")
            .eq_ignore_ascii_case(&format!("--config {}", quote_argument(&config)))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn interactive_user_restart_without_password_or_elevation() {
        let config = r"C:\Users\Müller\a&b\background-agent.json";
        let helper = format!(
            r"C:\Users\Müller\a&b\runtime\{}\monero-fast-walletd.exe",
            "a".repeat(24)
        );
        let body = task_xml("S-1-5-21-123-456-789-1001", &helper, config).unwrap();
        assert!(owned_task(&body, "S-1-5-21-123-456-789-1001", config));
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
        let config = r"C:\data\notifications\background-agent.json";
        let helper = format!(
            r"C:\data\notifications\runtime\{}\monero-fast-walletd.exe",
            "a".repeat(24)
        );
        let body = task_xml("S-1-5-21-1001", &helper, config).unwrap();
        assert!(owned_task(&body, "S-1-5-21-1001", config));
        assert!(!owned_task(&body, "S-1-5-21-1002", config));
        assert!(!owned_task(
            &body.replace(TASK_SOURCE, "other"),
            "S-1-5-21-1001",
            config,
        ));
        assert!(task_xml("S-1-5-21-1001<bad>", "x", "y").is_err());
        assert!(task_xml("S-1-5-21-1001", "x\ny", "z").is_err());
    }
    #[test]
    fn task_query_errors_do_not_imply_that_a_task_is_absent() {
        assert!(task_query_not_found(Some(0x8007_0002_u32 as i32)));
        assert!(!task_query_not_found(Some(0x8007_0005_u32 as i32)));
        assert!(!task_query_not_found(Some(0x8007_06BA_u32 as i32)));
        assert!(!task_query_not_found(Some(1)));
        assert!(!task_query_not_found(Some(0)));
        assert!(!task_query_not_found(None));
    }
    #[test]
    fn scheduler_export_omits_default_run_level_without_losing_ownership() {
        // Real Windows 11 export; user identifiers and paths are synthetic.
        let exported = include_str!("test-fixtures/windows-notification-task.normalized.xml");
        let config = r"C:\Users\Example\AppData\Roaming\com.tex8.monerowallet.desktop\notifications\background-agent.json";
        assert!(!exported.contains("<RunLevel>"));
        assert!(owned_task(exported, "S-1-5-21-1001", config));
        let elevated = exported.replace(
            "</Principal>",
            "<RunLevel>HighestAvailable</RunLevel></Principal>",
        );
        assert!(!owned_task(&elevated, "S-1-5-21-1001", config));
        assert!(!owned_task(exported, "S-1-5-21-1002", config));
        assert!(!owned_task(
            &exported.replace(TASK_SOURCE, "other"),
            "S-1-5-21-1001",
            config
        ));
    }
    #[test]
    fn cli_query_roundtrip_accepts_only_the_same_mixed_separator_config() {
        // Actual schtasks /Query /XML /HRESULT output from Windows 11,
        // with identifiers and paths replaced by synthetic values.
        let exported =
            include_str!("test-fixtures/windows-notification-task.cli-mixed-separators.xml");
        let config = r"C:\Users\Example\AppData\Roaming\com.tex8.monerowallet.desktop\notifications/background-agent.json";
        assert!(exported.contains("notifications/background-agent.json"));
        assert!(owned_task(exported, "S-1-5-21-1001", config));
        assert!(owned_task(
            exported,
            "S-1-5-21-1001",
            &config.replace('/', "\\")
        ));
        assert!(!owned_task(
            &exported.replace("background-agent.json\"", "background-agent.json\" --other"),
            "S-1-5-21-1001",
            config
        ));
        assert!(!owned_task(
            &exported.replace(
                "notifications/background-agent.json",
                "other/background-agent.json"
            ),
            "S-1-5-21-1001",
            config
        ));
    }
    #[test]
    fn task_creation_canonicalizes_windows_path_separators() {
        let config = r"C:/data/notifications/background-agent.json";
        let helper = format!(
            "C:/data/notifications/runtime/{}/monero-fast-walletd.exe",
            "b".repeat(24)
        );
        let body = task_xml("S-1-5-21-1001", &helper, config).unwrap();
        assert!(body.contains(r"<Arguments>--config &quot;C:\data\notifications\background-agent.json&quot;</Arguments>"));
        assert!(body.contains(r"<Command>C:\data\notifications\runtime\bbbbbbbbbbbbbbbbbbbbbbbb\monero-fast-walletd.exe</Command>"));
        assert!(owned_task(&body, "S-1-5-21-1001", config));
    }
    #[test]
    fn task_ownership_binds_the_single_action_to_private_helper_and_exact_config() {
        let config = r"C:\data\a&b\background-agent.json";
        let helper = format!(
            r"C:\data\a&b\runtime\{}\monero-fast-walletd.exe",
            "b".repeat(24)
        );
        let body = task_xml("S-1-5-21-1001", &helper, config).unwrap();
        assert!(owned_task(&body, "S-1-5-21-1001", config));
        assert!(!owned_task(
            &body,
            "S-1-5-21-1001",
            r"C:\other\background-agent.json"
        ));
        assert!(!owned_task(
            &body.replace("monero-fast-walletd.exe", "other.exe"),
            "S-1-5-21-1001",
            config
        ));
        assert!(!owned_task(
            &body.replace(&"b".repeat(24), r"..\..\outside"),
            "S-1-5-21-1001",
            config
        ));
        let extra = body.replace(
            "</Actions>",
            "<Exec><Command>other.exe</Command><Arguments>x</Arguments></Exec></Actions>",
        );
        assert!(!owned_task(&extra, "S-1-5-21-1001", config));
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
        assert!(!owned_task(&other, "S-1-5-21-1001", "config.json"));
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
