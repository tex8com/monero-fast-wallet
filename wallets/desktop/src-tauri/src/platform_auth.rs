use serde::Serialize;
use tauri::AppHandle;
use zeroize::Zeroizing;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemAuthStatus {
    pub available: bool,
    pub label: &'static str,
    pub detail: String,
    pub requires_recovery_password: bool,
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
mod native {
    use super::{AppHandle, SystemAuthStatus};
    use std::{
        ffi::{CStr, CString},
        os::raw::{c_char, c_void},
    };
    use zeroize::{Zeroize, Zeroizing};

    extern "C" {
        fn tex8_desktop_system_auth_available() -> i32;
        fn tex8_desktop_system_authenticate(
            reason: *const std::os::raw::c_char,
            parent_window: *mut c_void,
        ) -> i32;
        fn tex8_desktop_prompt_recovery_seed(
            output: *mut c_char,
            output_length: usize,
            parent_window: *mut c_void,
        ) -> i32;
    }

    #[cfg(target_os = "windows")]
    fn parent_window(app: &AppHandle) -> Result<*mut c_void, String> {
        use raw_window_handle::{HasWindowHandle, RawWindowHandle};
        use tauri::Manager;

        let window = app
            .get_webview_window("main")
            .ok_or_else(|| "The main wallet window is unavailable.".to_owned())?;
        let handle = window
            .window_handle()
            .map_err(|_| "The wallet window handle is unavailable.".to_owned())?;
        match handle.as_raw() {
            RawWindowHandle::Win32(handle) => Ok(handle.hwnd.get() as *mut c_void),
            _ => Err("Windows Hello requires a Win32 wallet window.".to_owned()),
        }
    }

    #[cfg(target_os = "macos")]
    fn parent_window(_app: &AppHandle) -> Result<*mut c_void, String> {
        Ok(std::ptr::null_mut())
    }

    pub async fn status() -> SystemAuthStatus {
        let available = unsafe { tex8_desktop_system_auth_available() == 1 };
        #[cfg(target_os = "macos")]
        let (label, detail) = (
            "Touch ID",
            if available {
                "Use Touch ID, Apple Watch, or the Mac login password.".to_owned()
            } else {
                "Touch ID is not set up on this Mac.".to_owned()
            },
        );
        #[cfg(target_os = "windows")]
        let (label, detail) = (
            "Windows Hello",
            if available {
                "Use Windows Hello with its secure device fallback.".to_owned()
            } else {
                "Windows Hello is not available or is not set up.".to_owned()
            },
        );
        SystemAuthStatus {
            available,
            label,
            detail,
            requires_recovery_password: false,
        }
    }

    pub async fn authenticate(app: AppHandle, reason: String) -> Result<(), String> {
        let reason = CString::new(reason)
            .map_err(|_| "The system-authentication message is invalid.".to_owned())?;
        let parent = parent_window(&app)? as usize;
        let result = tauri::async_runtime::spawn_blocking(move || unsafe {
            tex8_desktop_system_authenticate(reason.as_ptr(), parent as *mut c_void)
        })
        .await
        .map_err(|_| "System authentication could not be started.".to_owned())?;
        if result == 1 {
            Ok(())
        } else {
            Err("System authentication was cancelled or rejected.".to_owned())
        }
    }

    pub async fn prompt_recovery_seed(app: AppHandle) -> Result<Zeroizing<String>, String> {
        let parent = parent_window(&app)? as usize;
        tauri::async_runtime::spawn_blocking(move || {
            let mut output = vec![0_i8; 2048];
            let accepted = unsafe {
                tex8_desktop_prompt_recovery_seed(
                    output.as_mut_ptr(),
                    output.len(),
                    parent as *mut c_void,
                )
            };
            if accepted != 1 {
                output.zeroize();
                return Err("Wallet recovery was cancelled.".to_owned());
            }
            let seed = unsafe { CStr::from_ptr(output.as_ptr()) }
                .to_str()
                .map_err(|_| "The recovery words contain invalid text.".to_owned())?
                .to_owned();
            output.zeroize();
            if seed.split_whitespace().count() != 25 {
                return Err("Enter all 25 recovery words.".to_owned());
            }
            Ok(Zeroizing::new(seed))
        })
        .await
        .map_err(|_| "The secure recovery screen could not be started.".to_owned())?
    }
}

#[cfg(target_os = "linux")]
mod native {
    use super::{AppHandle, SystemAuthStatus};
    use futures_util::{future::Either, FutureExt, StreamExt};
    use gtk::prelude::*;
    use std::{
        sync::mpsc,
        time::{Duration, Instant},
    };
    use zbus::zvariant::OwnedObjectPath;
    use zbus::{Connection, Proxy};
    use zeroize::Zeroizing;

    const SERVICE: &str = "net.reactivated.Fprint";
    const MANAGER_PATH: &str = "/net/reactivated/Fprint/Manager";
    const MANAGER_INTERFACE: &str = "net.reactivated.Fprint.Manager";
    const DEVICE_INTERFACE: &str = "net.reactivated.Fprint.Device";

    async fn device(connection: &Connection) -> Result<Proxy<'_>, String> {
        let manager = Proxy::new(connection, SERVICE, MANAGER_PATH, MANAGER_INTERFACE)
            .await
            .map_err(|_| "The Linux fingerprint service is unavailable.".to_owned())?;
        let path: OwnedObjectPath = manager
            .call("GetDefaultDevice", &())
            .await
            .map_err(|_| "No supported fingerprint reader was found.".to_owned())?;
        Proxy::new(connection, SERVICE, path, DEVICE_INTERFACE)
            .await
            .map_err(|_| "The fingerprint reader could not be opened.".to_owned())
    }

    async fn enrolled(proxy: &Proxy<'_>) -> Result<bool, String> {
        let fingers: Vec<String> = proxy
            // fprintd documents an empty username as the secure current-user
            // path and lets PolicyKit resolve the account.
            .call("ListEnrolledFingers", &(""))
            .await
            .map_err(|_| "No fingerprint is enrolled for this Linux user.".to_owned())?;
        Ok(!fingers.is_empty())
    }

    pub async fn status() -> SystemAuthStatus {
        let result = async {
            let connection = Connection::system()
                .await
                .map_err(|_| "The Linux system bus is unavailable.".to_owned())?;
            let proxy = device(&connection).await?;
            enrolled(&proxy).await
        }
        .await;
        let available = matches!(&result, Ok(true));
        SystemAuthStatus {
            available,
            label: "Fingerprint",
            detail: match result {
                Ok(true) => "Use your enrolled Linux fingerprint.".to_owned(),
                Ok(false) => "No fingerprint is enrolled for this Linux user.".to_owned(),
                Err(error) => error,
            },
            // fprintd verifies a fingerprint but does not provide the unified
            // device-password fallback that macOS and Windows expose.
            requires_recovery_password: true,
        }
    }

    pub async fn authenticate(_app: AppHandle, _reason: String) -> Result<(), String> {
        let connection = Connection::system()
            .await
            .map_err(|_| "The Linux system bus is unavailable.".to_owned())?;
        let proxy = device(&connection).await?;
        if !enrolled(&proxy).await? {
            return Err("No fingerprint is enrolled for this Linux user.".to_owned());
        }
        let _: () = proxy
            .call("Claim", &(""))
            .await
            .map_err(|_| "The fingerprint reader is busy or permission was denied.".to_owned())?;

        let result = async {
            let mut signals = proxy.receive_signal("VerifyStatus").await.map_err(|_| {
                "Fingerprint verification could not listen for a result.".to_owned()
            })?;
            let _: () = proxy
                .call("VerifyStart", &("any"))
                .await
                .map_err(|_| "Fingerprint verification could not start.".to_owned())?;
            let deadline = Instant::now() + Duration::from_secs(45);
            loop {
                let remaining = deadline.saturating_duration_since(Instant::now());
                if remaining.is_zero() {
                    break Err("Fingerprint verification timed out.".to_owned());
                }
                let signal = signals.next().fuse();
                let timeout = futures_timer::Delay::new(remaining).fuse();
                futures_util::pin_mut!(signal, timeout);
                match futures_util::future::select(signal, timeout).await {
                    Either::Left((Some(message), _)) => {
                        let (status, done): (String, bool) = message
                            .body()
                            .deserialize()
                            .map_err(|_| "The fingerprint result was invalid.".to_owned())?;
                        if !done {
                            // fprintd can request another swipe before it emits
                            // the final match/no-match result.
                            continue;
                        }
                        break if status == "verify-match" {
                            Ok(())
                        } else {
                            Err("The fingerprint was not accepted.".to_owned())
                        };
                    }
                    Either::Left((None, _)) => {
                        break Err("The fingerprint reader stopped responding.".to_owned())
                    }
                    Either::Right(_) => break Err("Fingerprint verification timed out.".to_owned()),
                }
            }
        }
        .await;
        let _: Result<(), _> = proxy.call("VerifyStop", &()).await;
        let _: Result<(), _> = proxy.call("Release", &()).await;
        result
    }

    pub async fn prompt_recovery_seed(app: AppHandle) -> Result<Zeroizing<String>, String> {
        let (sender, receiver) = mpsc::sync_channel(1);
        app.run_on_main_thread(move || {
            let german = std::env::var("LANG")
                .map(|language| language.to_ascii_lowercase().starts_with("de"))
                .unwrap_or(false);
            let dialog = gtk::Dialog::with_buttons(
                Some(if german {
                    "Wallet wiederherstellen"
                } else {
                    "Restore wallet"
                }),
                None::<&gtk::Window>,
                gtk::DialogFlags::MODAL,
                &[
                    (
                        if german { "Abbrechen" } else { "Cancel" },
                        gtk::ResponseType::Cancel,
                    ),
                    (
                        if german {
                            "Wiederherstellen"
                        } else {
                            "Restore"
                        },
                        gtk::ResponseType::Accept,
                    ),
                ],
            );
            dialog.set_default_size(560, 420);
            let content = dialog.content_area();
            content.set_spacing(12);
            content.set_margin_top(18);
            content.set_margin_bottom(18);
            content.set_margin_start(18);
            content.set_margin_end(18);

            let title = gtk::Label::new(Some(if german {
                "Gib alle 25 Wiederherstellungswörter ein"
            } else {
                "Enter all 25 recovery words"
            }));
            title.set_xalign(0.0);
            let detail = gtk::Label::new(Some(if german {
                "Die Wörter bleiben auf diesem Gerät."
            } else {
                "The words stay on this device."
            }));
            detail.set_line_wrap(true);
            detail.set_xalign(0.0);
            let seed_input = gtk::TextView::new();
            seed_input.set_wrap_mode(gtk::WrapMode::WordChar);
            seed_input.set_size_request(500, 220);
            seed_input.set_accepts_tab(false);
            content.add(&title);
            content.add(&detail);
            content.add(&seed_input);
            dialog.show_all();

            let result = loop {
                if dialog.run() != gtk::ResponseType::Accept {
                    break Err("Wallet recovery was cancelled.".to_owned());
                }
                let Some(buffer) = seed_input.buffer() else {
                    break Err("The secure recovery field is unavailable.".to_owned());
                };
                let text = buffer
                    .text(&buffer.start_iter(), &buffer.end_iter(), true)
                    .map(|value| value.to_string())
                    .unwrap_or_default();
                buffer.set_text("");
                let normalized = text
                    .split_whitespace()
                    .map(str::to_lowercase)
                    .collect::<Vec<_>>();
                if normalized.len() == 25 {
                    break Ok(Zeroizing::new(normalized.join(" ")));
                }
                let warning = gtk::MessageDialog::new(
                    Some(&dialog),
                    gtk::DialogFlags::MODAL,
                    gtk::MessageType::Warning,
                    gtk::ButtonsType::Ok,
                    if german {
                        "Bitte gib alle 25 Wörter ein."
                    } else {
                        "Please enter all 25 words."
                    },
                );
                warning.run();
                warning.close();
            };
            dialog.close();
            let _ = sender.send(result);
        })
        .map_err(|_| "The secure recovery screen could not be started.".to_owned())?;
        tauri::async_runtime::spawn_blocking(move || {
            receiver
                .recv_timeout(Duration::from_secs(10 * 60))
                .map_err(|_| "The secure recovery screen stopped responding.".to_owned())?
        })
        .await
        .map_err(|_| "The secure recovery screen could not be completed.".to_owned())?
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
mod native {
    use super::{AppHandle, SystemAuthStatus};
    use zeroize::Zeroizing;

    pub async fn status() -> SystemAuthStatus {
        SystemAuthStatus {
            available: false,
            label: "System authentication",
            detail: "System authentication is not supported on this platform.".to_owned(),
            requires_recovery_password: true,
        }
    }

    pub async fn authenticate(_app: AppHandle, _reason: String) -> Result<(), String> {
        Err("System authentication is not supported on this platform.".to_owned())
    }

    pub async fn prompt_recovery_seed(_app: AppHandle) -> Result<Zeroizing<String>, String> {
        Err("Native wallet recovery is not supported on this platform.".to_owned())
    }
}

pub async fn status() -> SystemAuthStatus {
    native::status().await
}

pub async fn authenticate(app: AppHandle, reason: impl Into<String>) -> Result<(), String> {
    native::authenticate(app, reason.into()).await
}

pub async fn prompt_recovery_seed(app: AppHandle) -> Result<Zeroizing<String>, String> {
    native::prompt_recovery_seed(app).await
}
