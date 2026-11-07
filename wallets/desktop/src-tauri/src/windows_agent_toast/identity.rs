//! Per-user unpackaged desktop toast identity. The existing installer shortcut
//! is adopted only after its executable, arguments and app identity are checked.
use super::policy::{shortcut_action, ShortcutAction, WALLET_AUMID};
use std::{
    ffi::OsString,
    mem::ManuallyDrop,
    os::windows::ffi::{OsStrExt, OsStringExt},
    path::{Path, PathBuf},
};
use windows::{
    core::{Interface, GUID, PCWSTR, PWSTR},
    Win32::{
        Foundation::PROPERTYKEY,
        System::{
            Com::{
                CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, IPersistFile,
                StructuredStorage::{
                    PropVariantClear, PropVariantToStringAlloc, PROPVARIANT, PROPVARIANT_0,
                    PROPVARIANT_0_0, PROPVARIANT_0_0_0,
                },
                CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, STGM_READWRITE,
            },
            Variant::{VT_EMPTY, VT_LPWSTR},
        },
        UI::Shell::{
            FOLDERID_Programs, IShellLinkW, PropertiesSystem::IPropertyStore, SHChangeNotify,
            SHGetKnownFolderPath, ShellLink, KF_FLAG_DEFAULT, SHCNE_UPDATEITEM, SHCNF_FLUSH,
            SHCNF_PATHW, SLGP_RAWPATH,
        },
    },
};

// PKEY_AppUserModel_ID, as documented by the Windows property system.
const APP_USER_MODEL_ID: PROPERTYKEY = PROPERTYKEY {
    fmtid: GUID::from_u128(0x9f4c2855_9f79_4b39_a8d0_e1d42de1d5f3),
    pid: 5,
};
const E_INVALIDARG: i32 = 0x80070057_u32 as i32;
const E_ACCESSDENIED: i32 = 0x80070005_u32 as i32;

pub struct Failure {
    pub phase: &'static str,
    pub code: i32,
}
fn failure(phase: &'static str, error: windows::core::Error) -> Failure {
    Failure {
        phase,
        code: error.code().0,
    }
}
fn invalid(phase: &'static str) -> Failure {
    Failure {
        phase,
        code: E_INVALIDARG,
    }
}
fn wide(value: &std::ffi::OsStr) -> Result<Vec<u16>, Failure> {
    let mut result = value.encode_wide().collect::<Vec<_>>();
    if result.is_empty() || result.contains(&0) || result.len() >= 32767 {
        return Err(invalid("os_identity_invalid_path"));
    }
    result.push(0);
    Ok(result)
}
fn from_wide(value: &[u16]) -> OsString {
    OsString::from_wide(&value[..value.iter().position(|v| *v == 0).unwrap_or(value.len())])
}
fn same_file(left: &Path, right: &Path) -> bool {
    match (left.canonicalize(), right.canonicalize()) {
        (Ok(left), Ok(right)) => left == right,
        _ => false,
    }
}

struct Apartment;
impl Drop for Apartment {
    fn drop(&mut self) {
        unsafe { CoUninitialize() }
    }
}
struct Property(PROPVARIANT);
impl Drop for Property {
    fn drop(&mut self) {
        let _ = unsafe { PropVariantClear(&mut self.0) };
    }
}

unsafe fn read_identity(store: &IPropertyStore) -> Result<Option<String>, Failure> {
    let value = Property(
        unsafe { store.GetValue(&APP_USER_MODEL_ID) }
            .map_err(|error| failure("os_identity_read_failed", error))?,
    );
    if unsafe { value.0.Anonymous.Anonymous.vt } == VT_EMPTY {
        return Ok(None);
    }
    let text = unsafe { PropVariantToStringAlloc(&value.0) }
        .map_err(|error| failure("os_identity_read_failed", error))?;
    let result = unsafe { text.to_string() };
    unsafe { CoTaskMemFree(Some(text.0.cast())) };
    result
        .map(Some)
        .map_err(|_| invalid("os_identity_read_failed"))
}

unsafe fn set_identity(store: &IPropertyStore) -> Result<(), Failure> {
    let mut value = wide(std::ffi::OsStr::new(WALLET_AUMID))?;
    // SetValue copies this borrowed string. Do not PropVariantClear a borrowed
    // Vec buffer; only GetValue's owned PROPVARIANT above needs that cleanup.
    let property = PROPVARIANT {
        Anonymous: PROPVARIANT_0 {
            Anonymous: ManuallyDrop::new(PROPVARIANT_0_0 {
                vt: VT_LPWSTR,
                Anonymous: PROPVARIANT_0_0_0 {
                    pwszVal: PWSTR(value.as_mut_ptr()),
                },
                ..Default::default()
            }),
        },
    };
    unsafe {
        store
            .SetValue(&APP_USER_MODEL_ID, &property)
            .and_then(|_| store.Commit())
    }
    .map_err(|error| failure("os_identity_write_failed", error))
}

fn ensure_on_shell_thread(app_command: &Path) -> Result<bool, Failure> {
    unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok() }
        .map_err(|error| failure("os_identity_com_failed", error))?;
    let _apartment = Apartment;
    let programs = unsafe { SHGetKnownFolderPath(&FOLDERID_Programs, KF_FLAG_DEFAULT, None) }
        .map_err(|error| failure("os_identity_folder_failed", error))?;
    let folder = unsafe { programs.to_string() };
    unsafe { CoTaskMemFree(Some(programs.0.cast())) };
    let shortcut = PathBuf::from(folder.map_err(|_| invalid("os_identity_folder_failed"))?)
        .join("Monero Fast Wallet.lnk");
    let shortcut_wide = wide(shortcut.as_os_str())?;
    let link: IShellLinkW = unsafe { CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER) }
        .map_err(|error| failure("os_identity_link_failed", error))?;
    let persist: IPersistFile = link
        .cast()
        .map_err(|error| failure("os_identity_link_failed", error))?;
    let store: IPropertyStore = link
        .cast()
        .map_err(|error| failure("os_identity_link_failed", error))?;
    if shortcut.exists() {
        unsafe { persist.Load(PCWSTR(shortcut_wide.as_ptr()), STGM_READWRITE) }
            .map_err(|error| failure("os_identity_link_failed", error))?;
        let mut target = vec![0u16; 32768];
        let mut arguments = vec![0u16; 32768];
        unsafe {
            link.GetPath(&mut target, std::ptr::null_mut(), SLGP_RAWPATH.0 as u32)
                .and_then(|_| link.GetArguments(&mut arguments))
        }
        .map_err(|error| failure("os_identity_link_failed", error))?;
        let existing_identity = unsafe { read_identity(&store) }?;
        let action = shortcut_action(
            same_file(&PathBuf::from(from_wide(&target)), app_command),
            from_wide(&arguments).is_empty(),
            existing_identity.as_deref(),
        )
        .map_err(|_| Failure {
            phase: "os_identity_conflict",
            code: E_ACCESSDENIED,
        })?;
        if action == ShortcutAction::Keep {
            return Ok(false);
        }
    } else {
        let target = wide(app_command.as_os_str())?;
        unsafe { link.SetPath(PCWSTR(target.as_ptr())) }
            .map_err(|error| failure("os_identity_link_failed", error))?;
        let description = wide(std::ffi::OsStr::new("Monero Fast Wallet"))?;
        unsafe { link.SetDescription(PCWSTR(description.as_ptr())) }
            .map_err(|error| failure("os_identity_link_failed", error))?;
    }
    unsafe { set_identity(&store) }?;
    unsafe { persist.Save(PCWSTR(shortcut_wide.as_ptr()), true) }
        .map_err(|error| failure("os_identity_save_failed", error))?;
    // Notify the shell that the per-user Start menu identity has changed.
    unsafe {
        SHChangeNotify(
            SHCNE_UPDATEITEM,
            SHCNF_PATHW | SHCNF_FLUSH,
            Some(shortcut_wide.as_ptr().cast()),
            None,
        )
    };
    Ok(true)
}

pub fn ensure(app_command: &Path) -> Result<bool, Failure> {
    if !app_command.is_absolute() || !app_command.is_file() {
        return Err(invalid("os_identity_invalid_path"));
    }
    // A dedicated STA keeps Shell COM work separate from the helper's WinRT
    // apartment and does not change the notification callback threading model.
    let command = app_command.to_owned();
    std::thread::Builder::new()
        .name("mfw-toast-identity".into())
        .spawn(move || ensure_on_shell_thread(&command))
        .map_err(|_| Failure {
            phase: "os_identity_thread_failed",
            code: 0x8007000E_u32 as i32,
        })?
        .join()
        .map_err(|_| Failure {
            phase: "os_identity_thread_failed",
            code: 0x80004005_u32 as i32,
        })?
}
