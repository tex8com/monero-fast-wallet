//! Current-user interactive scheduled task: sign-in autostart and crash recovery.
//! No administrator token, stored password or global startup policy.
#[cfg(any(target_os = "windows", test))]
#[path = "windows_notification_task.rs"]
mod task;
#[cfg(target_os = "windows")]
use sha2::{Digest, Sha256};
#[cfg(target_os = "windows")]
use std::{
    env, fs,
    io::{Read, Write},
    os::windows::process::CommandExt,
    path::{Path, PathBuf},
    process::{Command, Output, Stdio},
    time::{Duration, Instant},
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
    let sid = current_user_sid()?;
    let task_name = task::task_name(&sid).map_err(str::to_owned)?;
    let existing = query_task(&task_name)?;
    let owned = existing
        .as_deref()
        .is_some_and(|xml| task::owned_task(xml, &sid));
    let config = app
        .path()
        .app_data_dir()
        .map_err(|_| "Windows notification directory is unavailable.".to_owned())?
        .join("notifications/background-agent.json");
    if !enabled {
        // Config.enabled is already false. Stop only our verified task;
        // old Run instances also observe that flag within one second.
        if owned {
            let _ = run_tool("schtasks.exe", &["/End", "/TN", &task_name]);
            if !run_tool("schtasks.exe", &["/Delete", "/TN", &task_name, "/F"])?
                .status
                .success()
            {
                return Err("Windows notification startup could not be disabled.".to_owned());
            }
        }
        remove_protocol_handler(&sid)?;
        return remove_legacy_run(&config);
    }
    if existing.is_some() && !owned {
        return Err(
            "The notification startup task belongs to another configuration. It was preserved."
                .to_owned(),
        );
    }
    let (agent, fingerprint) = install_agent(app, &config)?;
    register_protocol_handler(&sid, &agent, &config)?;
    let definition = hex::encode(Sha256::digest(
        format!(
            "{}\0{}\0{}\0{}",
            task::TASK_POLICY_VERSION,
            fingerprint,
            path_text(&agent)?,
            path_text(&config)?
        )
        .as_bytes(),
    ));
    let xml = task::fingerprinted_xml(
        task::task_xml(&sid, path_text(&agent)?, path_text(&config)?).map_err(str::to_owned)?,
        &definition,
    )
    .map_err(str::to_owned)?;
    let unchanged = existing.as_deref().is_some_and(|value| {
        value.contains(&format!(
            "<Documentation>definition-sha256:{definition}</Documentation>"
        ))
    });
    if unchanged {
        if !run_tool("schtasks.exe", &["/Change", "/TN", &task_name, "/ENABLE"])?
            .status
            .success()
            || !run_tool("schtasks.exe", &["/Run", "/TN", &task_name])?
                .status
                .success()
        {
            return Err("Windows notification startup could not be resumed.".to_owned());
        }
        return remove_legacy_run(&config);
    }
    let directory = config
        .parent()
        .ok_or_else(|| "Windows notification directory is unavailable.".to_owned())?;
    fs::create_dir_all(directory)
        .map_err(|_| "Windows notification directory could not be created.".to_owned())?;
    let task_file = directory.join("startup-task.xml");
    let result = (|| {
        let mut file = fs::File::create(&task_file)
            .map_err(|_| "Windows notification task could not be prepared.".to_owned())?;
        file.write_all(&task::utf16_file(&xml))
            .and_then(|_| file.sync_all())
            .map_err(|_| "Windows notification task could not be prepared.".to_owned())?;
        let mut args = vec!["/Create", "/TN", &task_name, "/XML", path_text(&task_file)?];
        // Never overwrite an unknown/unreadable task. /F only follows proof
        // of this app's source marker and the current user's principal.
        if existing.is_some() {
            args.push("/F");
        }
        if existing.is_some() {
            let _ = run_tool("schtasks.exe", &["/End", "/TN", &task_name]);
        }
        if !run_tool("schtasks.exe", &args)?.status.success() {
            if existing.is_some() {
                let _ = run_tool("schtasks.exe", &["/Run", "/TN", &task_name]);
            }
            return Err("Windows could not register the current-user notification task. No administrator password is required.".to_owned());
        }
        if !run_tool("schtasks.exe", &["/Run", "/TN", &task_name])?
            .status
            .success()
        {
            return Err(
                "Windows notification startup was registered but could not be started.".to_owned(),
            );
        }
        // Migrate only after supervised startup exists. A compatible Run
        // instance is protected by the singleton, and task repetition covers
        // its later exit. A pre-singleton helper still needs a sign-in handoff.
        remove_legacy_run(&config)
    })();
    let _ = fs::remove_file(task_file);
    result
}
#[cfg(target_os = "windows")]
fn run_tool(name: &str, args: &[&str]) -> Result<Output, String> {
    let system = env::var_os("SystemRoot")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
    let mut child = Command::new(system.join("System32").join(name))
        .args(args)
        .creation_flags(0x08000000)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|_| "Windows notification startup manager is unavailable.".to_owned())?;
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");
    let read = |stream: Box<dyn Read + Send>| {
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            stream.take(65537).read_to_end(&mut bytes).map(|_| bytes)
        })
    };
    let out = read(Box::new(stdout));
    let err = read(Box::new(stderr));
    let started = Instant::now();
    let status = loop {
        if let Some(status) = child
            .try_wait()
            .map_err(|_| "Windows notification startup status is unavailable.".to_owned())?
        {
            break status;
        }
        if started.elapsed() >= Duration::from_secs(15) {
            let _ = child.kill();
            let _ = child.wait();
            return Err("Windows notification startup manager timed out.".to_owned());
        }
        std::thread::sleep(Duration::from_millis(50));
    };
    let stdout = out
        .join()
        .ok()
        .and_then(Result::ok)
        .ok_or_else(|| "Windows notification startup response is unavailable.".to_owned())?;
    let stderr = err
        .join()
        .ok()
        .and_then(Result::ok)
        .ok_or_else(|| "Windows notification startup response is unavailable.".to_owned())?;
    if stdout.len() > 65536 || stderr.len() > 65536 {
        return Err("Windows notification startup response exceeds its limit.".to_owned());
    }
    Ok(Output {
        status,
        stdout,
        stderr,
    })
}

#[cfg(target_os = "windows")]
fn install_agent(app: &AppHandle, config: &Path) -> Result<(PathBuf, String), String> {
    let source = bundled_agent(app)?;
    let bytes = fs::read(&source)
        .map_err(|_| "The packaged notification helper could not be read.".to_owned())?;
    if !bytes.starts_with(b"MZ") {
        return Err("The packaged Windows notification helper is not a PE executable.".to_owned());
    }
    let fingerprint = hex::encode(Sha256::digest(&bytes));
    // Run a private versioned copy so an active helper never locks the
    // package resource during an application update.
    let directory = config
        .parent()
        .ok_or_else(|| "Windows notification directory is unavailable.".to_owned())?
        .join("runtime")
        .join(&fingerprint[..24]);
    fs::create_dir_all(&directory)
        .map_err(|_| "The notification runtime directory could not be created.".to_owned())?;
    let target = directory.join(AGENT_NAME);
    if !target.exists() {
        let mut nonce = [0u8; 8];
        getrandom::getrandom(&mut nonce)
            .map_err(|_| "Notification staging could not be created.".to_owned())?;
        let temporary = directory.join(format!("helper-{}.tmp", hex::encode(nonce)));
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|_| "The notification helper could not be staged.".to_owned())?;
        let result = file
            .write_all(&bytes)
            .and_then(|_| file.sync_all())
            .and_then(|_| fs::rename(&temporary, &target));
        if result.is_err() {
            let _ = fs::remove_file(temporary);
            return Err("The notification helper could not be installed.".to_owned());
        }
    }
    if hex::encode(Sha256::digest(
        fs::read(&target).map_err(|_| "The installed helper is unavailable.".to_owned())?,
    )) != fingerprint
    {
        return Err("The installed notification helper was modified.".to_owned());
    }
    Ok((target, fingerprint))
}
#[cfg(target_os = "windows")]
fn current_user_sid() -> Result<String, String> {
    let output = run_tool("whoami.exe", &["/user", "/fo", "csv", "/nh"])?;
    if !output.status.success() || output.stdout.len() > 8192 {
        return Err("The current Windows user could not be identified.".to_owned());
    }
    String::from_utf8_lossy(&output.stdout)
        .split([',', '"', '\r', '\n'])
        .map(str::trim)
        .find(|v| task::valid_sid(v))
        .map(str::to_owned)
        .ok_or_else(|| "The current Windows user could not be identified.".to_owned())
}
#[cfg(target_os = "windows")]
fn query_task(task_name: &str) -> Result<Option<String>, String> {
    let output = run_tool("schtasks.exe", &["/Query", "/TN", task_name, "/XML"])?;
    if !output.status.success() {
        return Ok(None);
    }
    task::decode_xml_output(&output.stdout)
        .map(Some)
        .map_err(str::to_owned)
}
#[cfg(target_os = "windows")]
#[link(name = "advapi32")]
unsafe extern "system" {
    fn RegOpenKeyExW(
        key: isize,
        subkey: *const u16,
        options: u32,
        access: u32,
        opened: *mut isize,
    ) -> i32;
    fn RegQueryValueExW(
        key: isize,
        name: *const u16,
        reserved: *mut u32,
        kind: *mut u32,
        data: *mut u8,
        bytes: *mut u32,
    ) -> i32;
    fn RegDeleteValueW(key: isize, name: *const u16) -> i32;
    fn RegCloseKey(key: isize) -> i32;
    fn RegCreateKeyExW(
        key: isize,
        subkey: *const u16,
        reserved: u32,
        class: *mut u16,
        options: u32,
        access: u32,
        security: *mut std::ffi::c_void,
        opened: *mut isize,
        disposition: *mut u32,
    ) -> i32;
    fn RegSetValueExW(
        key: isize,
        name: *const u16,
        reserved: u32,
        kind: u32,
        data: *const u8,
        bytes: u32,
    ) -> i32;
    fn RegDeleteTreeW(key: isize, subkey: *const u16) -> i32;
}
#[cfg(target_os = "windows")]
#[link(name = "shell32")]
unsafe extern "system" {
    fn SHChangeNotify(
        event: i32,
        flags: u32,
        first: *const std::ffi::c_void,
        second: *const std::ffi::c_void,
    );
}
#[cfg(target_os = "windows")]
fn refresh_protocol_registration() {
    // Notify Explorer about this registration; no default-app or global
    // notification setting is written.
    unsafe {
        SHChangeNotify(0x08000000, 0, std::ptr::null(), std::ptr::null());
    }
}
#[cfg(target_os = "windows")]
struct RunKey(isize);
#[cfg(target_os = "windows")]
impl Drop for RunKey {
    fn drop(&mut self) {
        unsafe {
            RegCloseKey(self.0);
        }
    }
}

#[cfg(target_os = "windows")]
fn protocol_key() -> String {
    format!(r"Software\Classes\{}", task::ACTIVATION_SCHEME)
}
#[cfg(target_os = "windows")]
fn registry_key(subkey: &str, create: bool) -> Result<Option<RunKey>, String> {
    let name = subkey.encode_utf16().chain(Some(0)).collect::<Vec<_>>();
    let mut key = 0isize;
    let status = unsafe {
        if create {
            RegCreateKeyExW(
                -2147483647isize,
                name.as_ptr(),
                0,
                std::ptr::null_mut(),
                0,
                0x0007,
                std::ptr::null_mut(),
                &mut key,
                std::ptr::null_mut(),
            )
        } else {
            RegOpenKeyExW(-2147483647isize, name.as_ptr(), 0, 0x0007, &mut key)
        }
    };
    if status == 2 && !create {
        Ok(None)
    } else if status == 0 {
        Ok(Some(RunKey(key)))
    } else {
        Err("The current-user notification activation handler is unavailable.".to_owned())
    }
}
#[cfg(target_os = "windows")]
fn registry_string(key: &RunKey, name: &str) -> Result<Option<String>, String> {
    let name = name.encode_utf16().chain(Some(0)).collect::<Vec<_>>();
    let mut kind = 0u32;
    let mut size = 0u32;
    let result = unsafe {
        RegQueryValueExW(
            key.0,
            name.as_ptr(),
            std::ptr::null_mut(),
            &mut kind,
            std::ptr::null_mut(),
            &mut size,
        )
    };
    if result == 2 {
        return Ok(None);
    }
    if result != 0 || kind != 1 || size > 32768 || size % 2 != 0 {
        return Err("An unrecognised activation registry value was preserved.".to_owned());
    }
    let mut data = vec![0u16; size as usize / 2 + 1];
    if unsafe {
        RegQueryValueExW(
            key.0,
            name.as_ptr(),
            std::ptr::null_mut(),
            &mut kind,
            data.as_mut_ptr().cast(),
            &mut size,
        )
    } != 0
        || kind != 1
    {
        return Err(
            "The notification activation handler changed while being inspected.".to_owned(),
        );
    }
    let end = data.iter().position(|c| *c == 0).unwrap_or(data.len());
    String::from_utf16(&data[..end])
        .map(Some)
        .map_err(|_| "The notification activation handler is invalid.".to_owned())
}
#[cfg(target_os = "windows")]
fn set_registry_string(key: &RunKey, name: &str, value: &str) -> Result<(), String> {
    let name = name.encode_utf16().chain(Some(0)).collect::<Vec<_>>();
    let data = value.encode_utf16().chain(Some(0)).collect::<Vec<_>>();
    if unsafe {
        RegSetValueExW(
            key.0,
            name.as_ptr(),
            0,
            1,
            data.as_ptr().cast(),
            (data.len() * 2) as u32,
        )
    } == 0
    {
        Ok(())
    } else {
        Err("The current-user notification activation handler could not be registered.".to_owned())
    }
}
#[cfg(target_os = "windows")]
fn register_protocol_handler(sid: &str, executable: &Path, config: &Path) -> Result<(), String> {
    let owner = format!("{}:{sid}", task::TASK_SOURCE);
    let path = protocol_key();
    if let Some(existing) = registry_key(&path, false)? {
        if registry_string(&existing, "MfwOwner")?.as_deref() != Some(owner.as_str()) {
            return Err("An unrelated notification URI handler was preserved.".to_owned());
        }
    }
    let command = task::protocol_command(path_text(executable)?, path_text(config)?)
        .map_err(str::to_owned)?;
    let key = registry_key(&path, true)?
        .ok_or_else(|| "Notification activation registration failed.".to_owned())?;
    // Mark a new key first so a partially failed own registration can recover.
    set_registry_string(&key, "MfwOwner", &owner)?;
    set_registry_string(&key, "", "Monero Fast Wallet notification")?;
    set_registry_string(&key, "URL Protocol", "")?;
    let command_key = registry_key(&format!(r"{path}\shell\open\command"), true)?
        .ok_or_else(|| "Notification activation registration failed.".to_owned())?;
    set_registry_string(&command_key, "", &command)?;
    refresh_protocol_registration();
    Ok(())
}
#[cfg(target_os = "windows")]
fn remove_protocol_handler(sid: &str) -> Result<(), String> {
    let path = protocol_key();
    let Some(key) = registry_key(&path, false)? else {
        return Ok(());
    };
    let owner = format!("{}:{sid}", task::TASK_SOURCE);
    if registry_string(&key, "MfwOwner")?.as_deref() != Some(owner.as_str()) {
        return Ok(());
    }
    drop(key);
    let name = path.encode_utf16().chain(Some(0)).collect::<Vec<_>>();
    if unsafe { RegDeleteTreeW(-2147483647isize, name.as_ptr()) } == 0 {
        refresh_protocol_registration();
        Ok(())
    } else {
        Err("The notification activation handler could not be removed.".to_owned())
    }
}
#[cfg(target_os = "windows")]
fn remove_legacy_run(config: &Path) -> Result<(), String> {
    // Unicode registry API avoids lossy OEM-console parsing of user paths.
    // Access is restricted to this fixed current-user key and named value.
    let subkey = RUN_KEY
        .strip_prefix("HKCU\\")
        .expect("fixed HKCU key")
        .encode_utf16()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let name = RUN_VALUE.encode_utf16().chain(Some(0)).collect::<Vec<_>>();
    let mut opened = 0isize;
    let result = unsafe {
        RegOpenKeyExW(
            -2147483647isize,
            subkey.as_ptr(),
            0,
            0x0001 | 0x0002,
            &mut opened,
        )
    };
    if result == 2 {
        return Ok(());
    }
    if result != 0 {
        return Err("The previous Windows startup entry could not be inspected.".to_owned());
    }
    let key = RunKey(opened);
    let mut kind = 0u32;
    let mut size = 0u32;
    let result = unsafe {
        RegQueryValueExW(
            key.0,
            name.as_ptr(),
            std::ptr::null_mut(),
            &mut kind,
            std::ptr::null_mut(),
            &mut size,
        )
    };
    if result == 2 {
        return Ok(());
    }
    if result != 0 || kind != 1 || size > 32768 || size % 2 != 0 {
        return Err("An unrecognised Windows startup entry was preserved.".to_owned());
    }
    let mut data = vec![0u16; (size as usize / 2) + 1];
    let result = unsafe {
        RegQueryValueExW(
            key.0,
            name.as_ptr(),
            std::ptr::null_mut(),
            &mut kind,
            data.as_mut_ptr().cast(),
            &mut size,
        )
    };
    if result == 2 {
        return Ok(());
    }
    if result != 0 || kind != 1 {
        return Err("The previous Windows startup entry changed while being inspected.".to_owned());
    }
    let end = data.iter().position(|c| *c == 0).unwrap_or(data.len());
    let value = String::from_utf16(&data[..end])
        .map_err(|_| "The previous Windows startup entry is invalid.".to_owned())?
        .to_lowercase()
        .replace('/', "\\");
    let expected = path_text(config)?.to_lowercase().replace('/', "\\");
    if !task::legacy_command_matches(&value, &expected) {
        return Ok(());
    }
    if unsafe { RegDeleteValueW(key.0, name.as_ptr()) } == 0 {
        Ok(())
    } else {
        Err("The previous Windows notification startup entry could not be removed.".to_owned())
    }
}
#[cfg(target_os = "windows")]
fn path_text(path: &Path) -> Result<&str, String> {
    path.to_str()
        .ok_or_else(|| "The Windows notification path is invalid.".to_owned())
}
#[cfg(target_os = "windows")]
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
        .map_err(|_| "Windows notification agent resource could not be resolved.".to_owned())?;
    if resource.is_file() {
        Ok(resource)
    } else {
        Err("This Windows package does not contain the notification agent.".to_owned())
    }
}
#[cfg(not(target_os = "windows"))]
pub fn reconcile(_: &tauri::AppHandle, _: bool) -> Result<(), String> {
    Ok(())
}
