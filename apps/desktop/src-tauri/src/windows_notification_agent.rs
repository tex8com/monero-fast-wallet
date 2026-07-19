//! Windows closed-app notification agent installation.
//!
//! This is deliberately a per-user Run entry (HKCU), never a Windows service:
//! it does not need administrator rights and starts after the user signs in.

#[cfg(target_os = "windows")]
use std::{
    env, fs,
    path::{Path, PathBuf},
    process::Command,
};
#[cfg(target_os = "windows")]
use tauri::{path::BaseDirectory, AppHandle, Manager};

#[cfg(target_os = "windows")]
const RUN_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
#[cfg(target_os = "windows")]
const RUN_VALUE: &str = "Monero Fast Wallet Notifications";
#[cfg(target_os = "windows")]
const AGENT_NAME: &str = "monero-fast-walletd.exe";
#[cfg(target_os = "windows")]
const BUNDLED_AGENT_RESOURCE: &str = "target/release/monero-fast-walletd.exe";

#[cfg(target_os = "windows")]
pub fn reconcile(app: &AppHandle, enabled: bool) -> Result<(), String> {
    if !enabled {
        let _ = Command::new("reg.exe")
            .args(["delete", RUN_KEY, "/v", RUN_VALUE, "/f"])
            .status();
        // The agent re-reads its config every cycle and exits as soon as it
        // sees the disabled state written by desktop_notifications.
        return Ok(());
    }

    let agent = bundled_agent(app)?;
    let config = app
        .path()
        .app_data_dir()
        .map_err(|_| "Windows notification directory is unavailable.".to_owned())?
        .join("notifications/background-agent.json");
    let command = format!("{} --config {}", quote(&agent), quote(&config));
    let status = Command::new("reg.exe")
        .args([
            "add", RUN_KEY, "/v", RUN_VALUE, "/t", "REG_SZ", "/d", &command, "/f",
        ])
        .status()
        .map_err(|_| "Windows notification startup entry could not be installed.".to_owned())?;
    if !status.success() {
        return Err("Windows notification startup entry could not be installed.".to_owned());
    }
    // Deliver in this sign-in session as well; the Run key covers later
    // sessions. A duplicate is harmless: the gateway removes events when one
    // agent receives them.
    Command::new(agent)
        .arg("--config")
        .arg(config)
        .spawn()
        .map_err(|_| "Windows notification agent could not be started.".to_owned())?;
    Ok(())
}

#[cfg(target_os = "windows")]
fn bundled_agent(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(executable) = env::current_exe() {
        if let Some(parent) = executable.parent() {
            let sibling = parent.join(AGENT_NAME);
            if executable_file(&sibling) {
                return Ok(sibling);
            }
        }
    }
    let resource = app
        .path()
        .resolve(BUNDLED_AGENT_RESOURCE, BaseDirectory::Resource)
        .map_err(|_| "Windows notification agent resource could not be resolved.".to_owned())?;
    if executable_file(&resource) {
        Ok(resource)
    } else {
        Err("This Windows package does not contain the notification agent.".to_owned())
    }
}

#[cfg(target_os = "windows")]
fn executable_file(path: &Path) -> bool {
    fs::metadata(path)
        .map(|metadata| metadata.is_file())
        .unwrap_or(false)
}

#[cfg(target_os = "windows")]
fn quote(path: &Path) -> String {
    format!("\"{}\"", path.to_string_lossy().replace('"', ""))
}

#[cfg(not(target_os = "windows"))]
pub fn reconcile(_: &tauri::AppHandle, _: bool) -> Result<(), String> {
    Ok(())
}
