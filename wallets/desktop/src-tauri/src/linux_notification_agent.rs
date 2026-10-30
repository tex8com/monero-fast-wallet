//! Stable per-user helper runtime, resolved from the packaged ELF itself.
#[cfg(any(target_os = "linux", test))]
#[path = "linux_notification_install.rs"]
mod install;
#[cfg(target_os = "linux")]
use sha2::{Digest, Sha256};
#[cfg(target_os = "linux")]
use std::{
    env, fs,
    io::{Read, Write},
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

pub fn persistent_app_command() -> Result<Option<String>, String> {
    #[cfg(target_os = "linux")]
    let executable = if let Some(original) = std::env::var_os("APPIMAGE") {
        std::path::PathBuf::from(original)
    } else {
        std::env::current_exe().map_err(|_| "The wallet launcher is unavailable.".to_owned())?
    };
    #[cfg(not(target_os = "linux"))]
    let executable =
        std::env::current_exe().map_err(|_| "The wallet launcher is unavailable.".to_owned())?;
    if !executable.is_absolute() || !executable.is_file() {
        return Err("The wallet launcher must be an existing absolute path.".to_owned());
    }
    let executable = executable
        .canonicalize()
        .map_err(|_| "The wallet launcher is unavailable.".to_owned())?;
    #[cfg(target_os = "linux")]
    if install::transient_appimage(&executable) {
        return Err("The original APPIMAGE path is unavailable. Reopen the installed AppImage before enabling notifications.".to_owned());
    }
    executable
        .to_str()
        .map(|value| Some(value.to_owned()))
        .ok_or_else(|| "The wallet launcher path is invalid.".to_owned())
}

#[cfg(target_os = "linux")]
pub fn reconcile(app: &AppHandle, enabled: bool) -> Result<(), String> {
    let data = app
        .path()
        .app_data_dir()
        .map_err(|_| "Linux notification data directory is unavailable.".to_owned())?;
    let config = data.join("notifications/background-agent.json");
    let home = env::var_os("HOME")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .ok_or_else(|| "Linux home directory is unavailable.".to_owned())?;
    let config_home = env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .unwrap_or_else(|| home.join(".config"));
    let unit = config_home.join("systemd/user").join(SERVICE_NAME);
    let previous = match fs::read(&unit) {
        Ok(bytes) => {
            let text = String::from_utf8_lossy(&bytes);
            if !text.contains("com.tex8.monerowallet.desktop.notification-agent.v1")
                && !(text.contains("Description=Monero Fast Wallet background notification agent")
                    && text.contains("monero-fast-walletd --config"))
            {
                return Err(
                    "An unrelated notification service definition was preserved.".to_owned(),
                );
            }
            Some(bytes)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(_) => return Err("Linux notification service could not be read.".to_owned()),
    };
    if !enabled {
        if previous.is_some() {
            systemctl(&["disable", "--now", SERVICE_NAME])?;
        }
        return Ok(());
    }
    let _ = persistent_app_command()?;
    let source = bundled_agent(app)?
        .canonicalize()
        .map_err(|_| "Linux notification helper is unavailable.".to_owned())?;
    let mut roots = vec![source.parent().expect("helper has parent").to_path_buf()];
    if let Ok(root) = app.path().resource_dir() {
        if let Ok(root) = root.canonicalize() {
            roots.push(root);
        }
    }
    if let Some(root) = env::var_os("APPDIR")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
    {
        if let Ok(root) = root.canonicalize() {
            roots.push(root);
        }
    }
    // The resource helper lives under target/release while private libraries
    // live elsewhere in the AppImage. Resolve from explicit package paths,
    // never an inherited developer LD_LIBRARY_PATH.
    let mut package_paths = Vec::new();
    for root in &roots {
        for relative in [
            "",
            "_up_/native-libs",
            "native-libs",
            "usr/lib",
            "usr/lib/Monero Fast Wallet/_up_/native-libs",
        ] {
            let candidate = root.join(relative);
            if candidate.is_dir() {
                package_paths.push(candidate);
            }
        }
    }
    let package_libraries = env::join_paths(package_paths)
        .map_err(|_| "The packaged notification library paths are invalid.".to_owned())?;
    let mut dependencies = Vec::new();
    for dependency in runtime_dependencies(&source, Some(&package_libraries))? {
        let resolved = dependency
            .path
            .canonicalize()
            .map_err(|_| "A notification runtime dependency is missing.".to_owned())?;
        if install::system_library(&resolved) {
            continue;
        }
        if !roots.iter().any(|root| resolved.starts_with(root)) {
            return Err(
                "The notification package references a private library outside its bundle."
                    .to_owned(),
            );
        }
        dependencies.push(install::Dependency {
            name: dependency.name,
            path: resolved,
        });
    }
    dependencies.sort_by(|a, b| a.name.cmp(&b.name));
    let mut digest = Sha256::new();
    digest.update(file_digest(&source)?);
    for dependency in &dependencies {
        digest.update(dependency.name.as_bytes());
        digest.update(file_digest(&dependency.path)?);
    }
    let version = hex::encode(digest.finalize());
    let runtime = data.join("notification-runtime");
    private_directory(&runtime)?;
    let target = runtime.join(&version[..24]);
    if !target.exists() {
        let mut random = [0u8; 8];
        getrandom::getrandom(&mut random)
            .map_err(|_| "Notification staging could not be created.".to_owned())?;
        let stage = runtime.join(format!(".stage-{}", hex::encode(random)));
        private_directory(&stage)?;
        let staged = (|| {
            private_directory(&stage.join("bin"))?;
            private_directory(&stage.join("lib"))?;
            copy_private(&source, &stage.join("bin").join(AGENT_NAME))?;
            for dependency in &dependencies {
                copy_private(&dependency.path, &stage.join("lib").join(&dependency.name))?;
            }
            // Validate the actual copied ELF with only its stable private libs;
            // this also checks transitive references and missing symbols.
            verify_installed_runtime(&stage.join("bin").join(AGENT_NAME), &stage.join("lib"))?;
            fs::File::open(&stage)
                .and_then(|file| file.sync_all())
                .map_err(|_| "Notification runtime could not be sealed.".to_owned())?;
            fs::rename(&stage, &target)
                .and_then(|_| fs::File::open(&runtime).and_then(|directory| directory.sync_all()))
                .map_err(|_| "Notification runtime could not be installed.".to_owned())
        })();
        if staged.is_err() {
            let _ = fs::remove_dir_all(&stage);
        }
        staged?;
    }
    if file_digest(&target.join("bin").join(AGENT_NAME))? != file_digest(&source)? {
        return Err("The installed notification helper was modified.".to_owned());
    }
    for dependency in &dependencies {
        if file_digest(&target.join("lib").join(&dependency.name))?
            != file_digest(&dependency.path)?
        {
            return Err("The installed notification runtime was modified.".to_owned());
        }
    }
    verify_installed_runtime(&target.join("bin").join(AGENT_NAME), &target.join("lib"))?;
    fs::File::open(&runtime)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| "The installed notification runtime could not be sealed.".to_owned())?;
    let text = install::render_unit(
        UNIT_TEMPLATE,
        &target.join("bin").join(AGENT_NAME),
        &config,
        &target.join("lib"),
    )
    .map_err(str::to_owned)?;
    fs::create_dir_all(unit.parent().expect("unit has parent"))
        .map_err(|_| "Linux user-service directory could not be created.".to_owned())?;
    let changed = previous.as_deref() != Some(text.as_bytes());
    if changed {
        atomic_write(&unit, text.as_bytes(), 0o600)?;
    }
    let activation = (|| {
        systemctl(&["daemon-reload"])?;
        systemctl(&[
            "enable",
            "--now",
            unit.to_str()
                .ok_or_else(|| "Linux service path is invalid.".to_owned())?,
        ])?;
        // A retry must not interrupt the unchanged healthy stream. Restart
        // only when the version or effective service configuration changed.
        if changed {
            systemctl(&["restart", SERVICE_NAME])?;
        }
        Ok(())
    })();
    if let Err(error) = activation {
        if let Some(bytes) = previous {
            let _ = atomic_write(&unit, &bytes, 0o600);
            let _ = systemctl(&["daemon-reload"]);
            let _ = systemctl(&["restart", SERVICE_NAME]);
        } else {
            let _ = systemctl(&["disable", "--now", SERVICE_NAME]);
            let _ = fs::remove_file(&unit);
            let _ = systemctl(&["daemon-reload"]);
        }
        return Err(error);
    }
    Ok(())
}
#[cfg(not(target_os = "linux"))]
pub fn reconcile(_: &tauri::AppHandle, _: bool) -> Result<(), String> {
    Ok(())
}

#[cfg(target_os = "linux")]
fn private_directory(path: &Path) -> Result<(), String> {
    fs::create_dir_all(path)
        .map_err(|_| "The notification runtime directory is unavailable.".to_owned())?;
    if fs::symlink_metadata(path)
        .map_err(|_| "The notification runtime directory is unavailable.".to_owned())?
        .file_type()
        .is_symlink()
    {
        return Err("A notification runtime directory must not be a symbolic link.".to_owned());
    }
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
        .map_err(|_| "The notification runtime directory could not be protected.".to_owned())
}
#[cfg(target_os = "linux")]
fn atomic_write(path: &Path, bytes: &[u8], mode: u32) -> Result<(), String> {
    let mut random = [0u8; 8];
    getrandom::getrandom(&mut random)
        .map_err(|_| "Notification staging could not be created.".to_owned())?;
    let temporary = path.with_extension(format!("mfw-{}.tmp", hex::encode(random)));
    let mut options = fs::OpenOptions::new();
    use std::os::unix::fs::OpenOptionsExt;
    let mut file = options
        .write(true)
        .create_new(true)
        .mode(mode)
        .open(&temporary)
        .map_err(|_| "The notification runtime could not be prepared.".to_owned())?;
    let result = file
        .write_all(bytes)
        .and_then(|_| file.sync_all())
        .and_then(|_| fs::rename(&temporary, path))
        .and_then(|_| {
            fs::File::open(path.parent().expect("runtime file has parent"))
                .and_then(|directory| directory.sync_all())
        });
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result.map_err(|_| "The notification runtime could not be installed.".to_owned())
}
#[cfg(target_os = "linux")]
fn copy_private(source: &Path, target: &Path) -> Result<(), String> {
    let bytes = fs::read(source)
        .map_err(|_| "A notification runtime file could not be read.".to_owned())?;
    atomic_write(target, &bytes, 0o700)
}
#[cfg(target_os = "linux")]
fn file_digest(path: &Path) -> Result<[u8; 32], String> {
    let mut file = fs::File::open(path)
        .map_err(|_| "A notification runtime file could not be read.".to_owned())?;
    let mut digest = Sha256::new();
    let mut bytes = [0u8; 65536];
    loop {
        let n = file
            .read(&mut bytes)
            .map_err(|_| "A notification runtime file could not be read.".to_owned())?;
        if n == 0 {
            break;
        }
        digest.update(&bytes[..n]);
    }
    Ok(digest.finalize().into())
}
#[cfg(target_os = "linux")]
fn runtime_dependencies(
    executable: &Path,
    library: Option<&std::ffi::OsStr>,
) -> Result<Vec<install::Dependency>, String> {
    let mut command = Command::new("ldd");
    command
        .arg("-r")
        .arg(executable)
        .env_remove("LD_PRELOAD")
        .env_remove("LD_AUDIT");
    if let Some(library) = library {
        command.env("LD_LIBRARY_PATH", library);
    } else {
        command.env_remove("LD_LIBRARY_PATH");
    }
    let result = command
        .output()
        .map_err(|_| "Install ldd (libc-bin) to verify the notification runtime.".to_owned())?;
    let text = format!(
        "{}\n{}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );
    if !result.status.success() {
        return Err("The notification helper's ELF runtime could not be resolved.".to_owned());
    }
    install::parse_ldd(&text).map_err(str::to_owned)
}
#[cfg(target_os = "linux")]
fn verify_installed_runtime(executable: &Path, library: &Path) -> Result<(), String> {
    let library = library
        .canonicalize()
        .map_err(|_| "The installed notification runtime is unavailable.".to_owned())?;
    for dependency in runtime_dependencies(executable, Some(library.as_os_str()))? {
        let path = dependency
            .path
            .canonicalize()
            .map_err(|_| "The installed notification runtime is unresolved.".to_owned())?;
        if !install::system_library(&path) && !path.starts_with(&library) {
            return Err(
                "The installed notification helper still depends on a temporary package path."
                    .to_owned(),
            );
        }
    }
    Ok(())
}
#[cfg(target_os = "linux")]
fn bundled_agent(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(executable) = env::current_exe() {
        if let Some(parent) = executable.parent() {
            let sibling = parent.join(AGENT_NAME);
            if sibling.is_file() {
                return Ok(sibling);
            }
        }
    }
    let resource = app
        .path()
        .resolve(BUNDLED_AGENT_RESOURCE, BaseDirectory::Resource)
        .map_err(|_| "Linux notification agent resource could not be resolved.".to_owned())?;
    if resource.is_file() {
        Ok(resource)
    } else {
        Err("This Linux package does not contain the notification agent.".to_owned())
    }
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
