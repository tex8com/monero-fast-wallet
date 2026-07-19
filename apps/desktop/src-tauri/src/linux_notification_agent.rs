//! Linux closed-app notification agent installation.
//!
//! The agent is deliberately a user service: it has no root privileges, only
//! receives opaque event identifiers, and can be disabled at any time.

#[cfg(target_os = "linux")]
use std::{
    env, fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::Command,
};
#[cfg(target_os = "linux")]
use tauri::{path::BaseDirectory, AppHandle, Manager};

#[cfg(target_os = "linux")]
const SERVICE_NAME: &str = "monero-fast-walletd.service";
#[cfg(target_os = "linux")]
const AGENT_NAME: &str = "monero-fast-walletd";
#[cfg(target_os = "linux")]
const BUNDLED_AGENT_RESOURCE: &str = "target/release/monero-fast-walletd";
#[cfg(target_os = "linux")]
const UNIT_TEMPLATE: &str = include_str!("../../packaging/linux/monero-fast-walletd.service");

#[cfg(target_os = "linux")]
pub fn reconcile(app: &AppHandle, enabled: bool) -> Result<(), String> {
    if !enabled {
        let _ = systemctl(&["disable", "--now", SERVICE_NAME]);
        return Ok(());
    }

    let source = bundled_agent(app)?;
    let home = home_directory()?;
    let target = home.join(".local/bin").join(AGENT_NAME);
    let unit = home.join(".config/systemd/user").join(SERVICE_NAME);
    fs::create_dir_all(target.parent().expect("agent target has parent"))
        .map_err(|_| "Linux notification agent directory could not be created.".to_owned())?;
    fs::create_dir_all(unit.parent().expect("unit target has parent"))
        .map_err(|_| "Linux user-service directory could not be created.".to_owned())?;
    fs::copy(&source, &target)
        .map_err(|_| "Linux notification agent could not be installed.".to_owned())?;
    fs::set_permissions(&target, fs::Permissions::from_mode(0o700))
        .map_err(|_| "Linux notification agent permissions could not be set.".to_owned())?;
    fs::write(&unit, UNIT_TEMPLATE)
        .map_err(|_| "Linux notification user service could not be installed.".to_owned())?;

    systemctl(&["daemon-reload"])?;
    systemctl(&["enable", "--now", SERVICE_NAME])
}

#[cfg(not(target_os = "linux"))]
pub fn reconcile(_: &tauri::AppHandle, _: bool) -> Result<(), String> {
    Ok(())
}

#[cfg(target_os = "linux")]
fn bundled_agent(app: &AppHandle) -> Result<PathBuf, String> {
    // Development builds keep both Rust binaries next to each other. Release
    // builds use Tauri's resource resolver, so AppImage mount paths never
    // leak into the user service configuration.
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
        .map_err(|_| "Linux notification agent resource could not be resolved.".to_owned())?;
    if executable_file(&resource) {
        Ok(resource)
    } else {
        Err("This Linux package does not contain the notification agent.".to_owned())
    }
}

#[cfg(target_os = "linux")]
fn executable_file(path: &Path) -> bool {
    fs::metadata(path)
        .map(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(target_os = "linux")]
fn home_directory() -> Result<PathBuf, String> {
    env::var_os("HOME")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .ok_or_else(|| "Linux home directory is unavailable.".to_owned())
}

#[cfg(target_os = "linux")]
fn systemctl(args: &[&str]) -> Result<(), String> {
    let status = Command::new("systemctl")
        .arg("--user")
        .args(args)
        .status()
        .map_err(|_| "Linux user-service manager is unavailable.".to_owned())?;
    if status.success() {
        Ok(())
    } else {
        Err("Linux notification user service could not be updated.".to_owned())
    }
}
