use std::{
    ffi::{c_char, c_int, CStr, CString},
    ptr::NonNull,
};

#[repr(C)]
struct RawCore {
    _private: [u8; 0],
}
#[repr(C)]
struct RawResult {
    ok: c_int,
    value: *mut c_char,
    error: *mut c_char,
}

unsafe extern "C" {
    fn tex8_desktop_wallet_core_new() -> *mut RawCore;
    fn tex8_desktop_wallet_core_free(core: *mut RawCore);
    fn tex8_desktop_result_free(result: *mut RawResult);
    fn tex8_desktop_wallet_ledger_transport_status(core: *mut RawCore) -> RawResult;
    fn tex8_desktop_wallet_create(
        core: *mut RawCore,
        path: *const c_char,
        password: *const c_char,
        language: *const c_char,
        network: u8,
    ) -> RawResult;
    fn tex8_desktop_wallet_restore(
        core: *mut RawCore,
        path: *const c_char,
        password: *const c_char,
        mnemonic: *const c_char,
        seed_offset: *const c_char,
        network: u8,
        restore_height: u64,
    ) -> RawResult;
    fn tex8_desktop_wallet_create_from_device(
        core: *mut RawCore,
        path: *const c_char,
        password: *const c_char,
        network: u8,
        device_name: *const c_char,
        restore_height: u64,
        subaddress_lookahead: *const c_char,
        account_index: u32,
    ) -> RawResult;
    fn tex8_desktop_wallet_create_view_only(
        core: *mut RawCore,
        path: *const c_char,
        password: *const c_char,
        network: u8,
        restore_height: u64,
        address: *const c_char,
        private_view_key: *const c_char,
    ) -> RawResult;
    fn tex8_desktop_wallet_open(
        core: *mut RawCore,
        path: *const c_char,
        password: *const c_char,
        network: u8,
        restore_height: u64,
    ) -> RawResult;
    fn tex8_desktop_wallet_close(
        core: *mut RawCore,
        wallet_id: *const c_char,
        store: c_int,
    ) -> RawResult;
    fn tex8_desktop_wallet_set_daemon(
        core: *mut RawCore,
        wallet_id: *const c_char,
        address: *const c_char,
        trusted: c_int,
        use_ssl: c_int,
        username: *const c_char,
        password: *const c_char,
        proxy_address: *const c_char,
    ) -> RawResult;
    fn tex8_desktop_wallet_start_refresh(core: *mut RawCore, wallet_id: *const c_char)
        -> RawResult;
    fn tex8_desktop_wallet_stop_refresh(core: *mut RawCore, wallet_id: *const c_char) -> RawResult;
    fn tex8_desktop_wallet_get_address(
        core: *mut RawCore,
        wallet_id: *const c_char,
        account_index: u32,
        address_index: u32,
    ) -> RawResult;
    fn tex8_desktop_wallet_get_seed(
        core: *mut RawCore,
        wallet_id: *const c_char,
        seed_offset: *const c_char,
    ) -> RawResult;
    fn tex8_desktop_wallet_snapshot(core: *mut RawCore, wallet_id: *const c_char) -> RawResult;
    fn tex8_desktop_wallet_get_balance(
        core: *mut RawCore,
        wallet_id: *const c_char,
        account_index: u32,
        unlocked_only: c_int,
    ) -> RawResult;
    fn tex8_desktop_wallet_get_transactions(
        core: *mut RawCore,
        wallet_id: *const c_char,
        limit: u32,
    ) -> RawResult;
    fn tex8_desktop_wallet_prepare_transaction(
        core: *mut RawCore,
        wallet_id: *const c_char,
        address: *const c_char,
        amount_atomic: *const c_char,
        payment_id: *const c_char,
        priority: *const c_char,
        account_index: u32,
    ) -> RawResult;
    fn tex8_desktop_wallet_commit_transaction(
        core: *mut RawCore,
        wallet_id: *const c_char,
        pending_id: *const c_char,
    ) -> RawResult;
    fn tex8_desktop_wallet_hardware_status(
        core: *mut RawCore,
        wallet_id: *const c_char,
    ) -> RawResult;
    fn tex8_desktop_wallet_reconnect_hardware(
        core: *mut RawCore,
        wallet_id: *const c_char,
    ) -> RawResult;
    fn tex8_desktop_wallet_export_hardware_private_view_key(
        core: *mut RawCore,
        wallet_id: *const c_char,
    ) -> RawResult;
    fn tex8_desktop_wallet_show_hardware_address(
        core: *mut RawCore,
        wallet_id: *const c_char,
        account_index: u32,
        address_index: u32,
        payment_id: *const c_char,
    ) -> RawResult;
    fn tex8_desktop_wallet_create_subaddress(
        core: *mut RawCore,
        wallet_id: *const c_char,
        account_index: u32,
        label: *const c_char,
    ) -> RawResult;
    fn tex8_desktop_wallet_create_fast_receive_identity(
        core: *mut RawCore,
        source_wallet_id: *const c_char,
        identity_id: *const c_char,
        path: *const c_char,
        password: *const c_char,
        label: *const c_char,
        restore_height: u64,
        derivation_index: u64,
    ) -> RawResult;
    fn tex8_desktop_wallet_fast_receive_registration_payload(
        core: *mut RawCore,
        identity_id: *const c_char,
        path: *const c_char,
        password: *const c_char,
        network: u8,
        restore_height: u64,
    ) -> RawResult;
}

pub struct NativeWallet {
    core: NonNull<RawCore>,
}
pub struct DaemonConfig<'a> {
    pub wallet_id: &'a str,
    pub address: &'a str,
    pub trusted: bool,
    pub use_ssl: bool,
    pub username: &'a str,
    pub password: &'a str,
    pub proxy_address: &'a str,
}
pub struct HardwareWalletCreate<'a> {
    pub path: &'a str,
    pub password: &'a str,
    pub network: u8,
    pub device_name: &'a str,
    pub restore_height: u64,
    pub subaddress_lookahead: &'a str,
    pub account_index: u32,
}
pub struct ViewOnlyWalletCreate<'a> {
    pub path: &'a str,
    pub password: &'a str,
    pub network: u8,
    pub restore_height: u64,
    pub address: &'a str,
    pub private_view_key: &'a str,
}
pub struct FastReceiveIdentityCreate<'a> {
    pub source_wallet_id: &'a str,
    pub identity_id: &'a str,
    pub path: &'a str,
    pub password: &'a str,
    pub label: &'a str,
    pub restore_height: u64,
    pub derivation_index: u64,
}
unsafe impl Send for NativeWallet {}

impl NativeWallet {
    pub fn new() -> Result<Self, String> {
        NonNull::new(unsafe { tex8_desktop_wallet_core_new() })
            .map(|core| Self { core })
            .ok_or_else(|| "Native wallet core could not be initialized.".to_owned())
    }
    pub fn create(
        &self,
        path: &str,
        password: &str,
        language: &str,
        network: u8,
    ) -> Result<String, String> {
        let path = c(path)?;
        let password = c(password)?;
        let language = c(language)?;
        self.result(unsafe {
            tex8_desktop_wallet_create(
                self.core.as_ptr(),
                path.as_ptr(),
                password.as_ptr(),
                language.as_ptr(),
                network,
            )
        })
    }
    pub fn ledger_transport_status(&self) -> Result<String, String> {
        self.result(unsafe { tex8_desktop_wallet_ledger_transport_status(self.core.as_ptr()) })
    }
    pub fn restore(
        &self,
        path: &str,
        password: &str,
        mnemonic: &str,
        seed_offset: &str,
        network: u8,
        restore_height: u64,
    ) -> Result<String, String> {
        let path = c(path)?;
        let password = c(password)?;
        let mnemonic = c(mnemonic)?;
        let seed_offset = c(seed_offset)?;
        self.result(unsafe {
            tex8_desktop_wallet_restore(
                self.core.as_ptr(),
                path.as_ptr(),
                password.as_ptr(),
                mnemonic.as_ptr(),
                seed_offset.as_ptr(),
                network,
                restore_height,
            )
        })
    }
    pub fn open(
        &self,
        path: &str,
        password: &str,
        network: u8,
        restore_height: u64,
    ) -> Result<String, String> {
        self.call(
            |core, path, password| unsafe {
                tex8_desktop_wallet_open(core, path, password, network, restore_height)
            },
            path,
            password,
        )
    }
    pub fn create_from_device(&self, request: HardwareWalletCreate<'_>) -> Result<String, String> {
        let path = c(request.path)?;
        let password = c(request.password)?;
        let device_name = c(request.device_name)?;
        let subaddress_lookahead = c(request.subaddress_lookahead)?;
        self.result(unsafe {
            tex8_desktop_wallet_create_from_device(
                self.core.as_ptr(),
                path.as_ptr(),
                password.as_ptr(),
                request.network,
                device_name.as_ptr(),
                request.restore_height,
                subaddress_lookahead.as_ptr(),
                request.account_index,
            )
        })
    }
    pub fn create_view_only(&self, request: ViewOnlyWalletCreate<'_>) -> Result<String, String> {
        let path = c(request.path)?;
        let password = c(request.password)?;
        let address = c(request.address)?;
        let private_view_key = c(request.private_view_key)?;
        self.result(unsafe {
            tex8_desktop_wallet_create_view_only(
                self.core.as_ptr(),
                path.as_ptr(),
                password.as_ptr(),
                request.network,
                request.restore_height,
                address.as_ptr(),
                private_view_key.as_ptr(),
            )
        })
    }
    pub fn close(&self, wallet_id: &str, store: bool) -> Result<(), String> {
        let wallet_id = c(wallet_id)?;
        self.result(unsafe {
            tex8_desktop_wallet_close(self.core.as_ptr(), wallet_id.as_ptr(), store.into())
        })
        .map(|_| ())
    }
    pub fn set_daemon(&self, config: DaemonConfig<'_>) -> Result<(), String> {
        let wallet_id = c(config.wallet_id)?;
        let address = c(config.address)?;
        let username = c(config.username)?;
        let password = c(config.password)?;
        let proxy_address = c(config.proxy_address)?;
        self.result(unsafe {
            tex8_desktop_wallet_set_daemon(
                self.core.as_ptr(),
                wallet_id.as_ptr(),
                address.as_ptr(),
                config.trusted.into(),
                config.use_ssl.into(),
                username.as_ptr(),
                password.as_ptr(),
                proxy_address.as_ptr(),
            )
        })
        .map(|_| ())
    }
    pub fn start_refresh(&self, wallet_id: &str) -> Result<(), String> {
        let wallet_id = c(wallet_id)?;
        self.result(unsafe {
            tex8_desktop_wallet_start_refresh(self.core.as_ptr(), wallet_id.as_ptr())
        })
        .map(|_| ())
    }
    pub fn stop_refresh(&self, wallet_id: &str) -> Result<(), String> {
        let wallet_id = c(wallet_id)?;
        self.result(unsafe {
            tex8_desktop_wallet_stop_refresh(self.core.as_ptr(), wallet_id.as_ptr())
        })
        .map(|_| ())
    }
    pub fn address(
        &self,
        wallet_id: &str,
        account_index: u32,
        address_index: u32,
    ) -> Result<String, String> {
        let wallet_id = c(wallet_id)?;
        self.result(unsafe {
            tex8_desktop_wallet_get_address(
                self.core.as_ptr(),
                wallet_id.as_ptr(),
                account_index,
                address_index,
            )
        })
    }
    pub fn recovery_seed(&self, wallet_id: &str) -> Result<String, String> {
        let wallet_id = c(wallet_id)?;
        let seed_offset = c("")?;
        self.result(unsafe {
            tex8_desktop_wallet_get_seed(
                self.core.as_ptr(),
                wallet_id.as_ptr(),
                seed_offset.as_ptr(),
            )
        })
    }
    pub fn snapshot(&self, wallet_id: &str) -> Result<String, String> {
        let wallet_id = c(wallet_id)?;
        self.result(unsafe { tex8_desktop_wallet_snapshot(self.core.as_ptr(), wallet_id.as_ptr()) })
    }
    pub fn balance(
        &self,
        wallet_id: &str,
        account_index: u32,
        unlocked_only: bool,
    ) -> Result<String, String> {
        let wallet_id = c(wallet_id)?;
        self.result(unsafe {
            tex8_desktop_wallet_get_balance(
                self.core.as_ptr(),
                wallet_id.as_ptr(),
                account_index,
                unlocked_only.into(),
            )
        })
    }
    pub fn create_subaddress(
        &self,
        wallet_id: &str,
        account_index: u32,
        label: &str,
    ) -> Result<String, String> {
        let wallet_id = c(wallet_id)?;
        let label = c(label)?;
        self.result(unsafe {
            tex8_desktop_wallet_create_subaddress(
                self.core.as_ptr(),
                wallet_id.as_ptr(),
                account_index,
                label.as_ptr(),
            )
        })
    }
    pub fn create_fast_receive_identity(
        &self,
        request: FastReceiveIdentityCreate<'_>,
    ) -> Result<String, String> {
        let source_wallet_id = c(request.source_wallet_id)?;
        let identity_id = c(request.identity_id)?;
        let path = c(request.path)?;
        let password = c(request.password)?;
        let label = c(request.label)?;
        self.result(unsafe {
            tex8_desktop_wallet_create_fast_receive_identity(
                self.core.as_ptr(),
                source_wallet_id.as_ptr(),
                identity_id.as_ptr(),
                path.as_ptr(),
                password.as_ptr(),
                label.as_ptr(),
                request.restore_height,
                request.derivation_index,
            )
        })
    }
    /// This result contains the isolated fast-wallet private view key. It is
    /// intentionally callable only from the Rust host, never a Tauri command.
    pub fn fast_receive_registration_payload(
        &self,
        identity_id: &str,
        path: &str,
        password: &str,
        network: u8,
        restore_height: u64,
    ) -> Result<String, String> {
        let identity_id = c(identity_id)?;
        let path = c(path)?;
        let password = c(password)?;
        self.result(unsafe {
            tex8_desktop_wallet_fast_receive_registration_payload(
                self.core.as_ptr(),
                identity_id.as_ptr(),
                path.as_ptr(),
                password.as_ptr(),
                network,
                restore_height,
            )
        })
    }
    pub fn transactions(&self, wallet_id: &str) -> Result<String, String> {
        let wallet_id = c(wallet_id)?;
        self.result(unsafe {
            // A limit of zero is the native bridge's explicit "all history" value.
            // Preview surfaces slice this result locally; the Activity screen must
            // remain a complete history rather than an arbitrary first 100 rows.
            tex8_desktop_wallet_get_transactions(self.core.as_ptr(), wallet_id.as_ptr(), 0)
        })
    }
    pub fn prepare_transaction(
        &self,
        wallet_id: &str,
        address: &str,
        amount_atomic: &str,
        payment_id: &str,
        priority: &str,
        account_index: u32,
    ) -> Result<String, String> {
        let wallet_id = c(wallet_id)?;
        let address = c(address)?;
        let amount_atomic = c(amount_atomic)?;
        let payment_id = c(payment_id)?;
        let priority = c(priority)?;
        self.result(unsafe {
            tex8_desktop_wallet_prepare_transaction(
                self.core.as_ptr(),
                wallet_id.as_ptr(),
                address.as_ptr(),
                amount_atomic.as_ptr(),
                payment_id.as_ptr(),
                priority.as_ptr(),
                account_index,
            )
        })
    }
    pub fn commit_transaction(&self, wallet_id: &str, pending_id: &str) -> Result<String, String> {
        let wallet_id = c(wallet_id)?;
        let pending_id = c(pending_id)?;
        self.result(unsafe {
            tex8_desktop_wallet_commit_transaction(
                self.core.as_ptr(),
                wallet_id.as_ptr(),
                pending_id.as_ptr(),
            )
        })
    }
    pub fn hardware_status(&self, wallet_id: &str) -> Result<String, String> {
        let wallet_id = c(wallet_id)?;
        self.result(unsafe {
            tex8_desktop_wallet_hardware_status(self.core.as_ptr(), wallet_id.as_ptr())
        })
    }
    pub fn reconnect_hardware(&self, wallet_id: &str) -> Result<String, String> {
        let wallet_id = c(wallet_id)?;
        self.result(unsafe {
            tex8_desktop_wallet_reconnect_hardware(self.core.as_ptr(), wallet_id.as_ptr())
        })
    }
    pub fn export_hardware_private_view_key(&self, wallet_id: &str) -> Result<String, String> {
        let wallet_id = c(wallet_id)?;
        self.result(unsafe {
            tex8_desktop_wallet_export_hardware_private_view_key(
                self.core.as_ptr(),
                wallet_id.as_ptr(),
            )
        })
    }
    pub fn show_hardware_address(
        &self,
        wallet_id: &str,
        account_index: u32,
        address_index: u32,
    ) -> Result<String, String> {
        let wallet_id = c(wallet_id)?;
        let payment_id = c("")?;
        self.result(unsafe {
            tex8_desktop_wallet_show_hardware_address(
                self.core.as_ptr(),
                wallet_id.as_ptr(),
                account_index,
                address_index,
                payment_id.as_ptr(),
            )
        })
    }
    fn call<F>(&self, operation: F, path: &str, password: &str) -> Result<String, String>
    where
        F: FnOnce(*mut RawCore, *const c_char, *const c_char) -> RawResult,
    {
        let path = c(path)?;
        let password = c(password)?;
        self.result(operation(
            self.core.as_ptr(),
            path.as_ptr(),
            password.as_ptr(),
        ))
    }
    fn result(&self, mut result: RawResult) -> Result<String, String> {
        let output = unsafe {
            if result.ok == 1 && !result.value.is_null() {
                Ok(CStr::from_ptr(result.value).to_string_lossy().into_owned())
            } else if !result.error.is_null() {
                Err(CStr::from_ptr(result.error).to_string_lossy().into_owned())
            } else {
                Err("Native wallet operation failed.".to_owned())
            }
        };
        unsafe { tex8_desktop_result_free(&mut result) };
        output
    }
}
impl Drop for NativeWallet {
    fn drop(&mut self) {
        unsafe { tex8_desktop_wallet_core_free(self.core.as_ptr()) }
    }
}
fn c(value: &str) -> Result<CString, String> {
    CString::new(value).map_err(|_| "Invalid text input.".to_owned())
}

#[cfg(test)]
mod tests {
    use super::{FastReceiveIdentityCreate, NativeWallet};
    use std::{
        fs,
        time::{SystemTime, UNIX_EPOCH},
    };
    use zeroize::Zeroize;

    #[test]
    fn linked_core_creates_opens_and_exposes_a_software_wallet() {
        if option_env!("TEX8_DESKTOP_MONERO_LINKED") != Some("1") {
            return;
        }

        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("tex8-monero-core-smoke-{nonce}"));
        fs::create_dir_all(&root).expect("create isolated wallet test directory");
        let wallet_path = root.join("wallet");
        let wallet_path = wallet_path.to_string_lossy().into_owned();

        let result = (|| -> Result<(), String> {
            let wallet = NativeWallet::new()?;
            let wallet_id = wallet.create(&wallet_path, "test-password", "English", 0)?;
            let address = wallet.address(&wallet_id, 0, 0)?;
            assert!(
                address.starts_with('4'),
                "expected a mainnet primary address"
            );
            assert_eq!(
                wallet.recovery_seed(&wallet_id)?.split_whitespace().count(),
                25
            );
            let subaddress = wallet.create_subaddress(&wallet_id, 0, "desktop smoke")?;
            assert!(subaddress.contains("address"));

            let fast_path = root.join("fast-receive").to_string_lossy().into_owned();
            let fast_identity = wallet.create_fast_receive_identity(FastReceiveIdentityCreate {
                source_wallet_id: &wallet_id,
                identity_id: "fast-receive-0-desktop-smoke",
                path: &fast_path,
                password: "test-password",
                label: "Fast Wallet",
                restore_height: 0,
                derivation_index: 0,
            })?;
            assert!(fast_identity.contains("fast-receive-0-desktop-smoke"));
            assert!(fast_identity.contains("\"address\":\"4"));
            let mut registration_payload = wallet.fast_receive_registration_payload(
                "fast-receive-0-desktop-smoke",
                &fast_path,
                "test-password",
                0,
                0,
            )?;
            assert!(registration_payload.contains("privateViewKey"));
            assert!(registration_payload.contains("fast-receive-0-desktop-smoke"));
            registration_payload.zeroize();
            let opened_fast_id = wallet.open(&fast_path, "test-password", 0, 0)?;
            let fast_address = wallet.address(&opened_fast_id, 0, 0)?;
            assert!(fast_address.starts_with('4'));
            assert!(wallet.snapshot(&opened_fast_id)?.contains("primaryAddress"));
            wallet.close(&opened_fast_id, true)?;
            wallet.close(&wallet_id, true)?;

            let reopened_id = wallet.open(&wallet_path, "test-password", 0, 0)?;
            assert_eq!(wallet.address(&reopened_id, 0, 0)?, address);
            wallet.close(&reopened_id, false)
        })();

        fs::remove_dir_all(&root).expect("remove only the isolated wallet test directory");
        result.expect("real Monero WalletEngine smoke test");
    }
}
