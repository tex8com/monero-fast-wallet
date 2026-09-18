use std::{
    ffi::{c_char, c_int, CStr, CString},
    fs,
    path::PathBuf,
    ptr::NonNull,
};
use zeroize::Zeroizing;

pub const SESSION_STALE_CODE: &str = "session-stale";

pub fn is_session_stale(error: &str) -> bool {
    error == SESSION_STALE_CODE
}

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
    fn tex8_desktop_wallet_configure_public_block_spool(
        directory: *const c_char,
        requested_maximum_bytes: u64,
    ) -> u64;
    fn tex8_desktop_wallet_core_new() -> *mut RawCore;
    fn tex8_desktop_wallet_core_free(core: *mut RawCore);
    fn tex8_desktop_result_free(result: *mut RawResult);
    fn tex8_desktop_wallet_ledger_transport_status(core: *mut RawCore) -> RawResult;
    fn tex8_desktop_wallet_ledger_connection_status(core: *mut RawCore) -> RawResult;
    fn tex8_desktop_wallet_compute_backend_status(core: *mut RawCore) -> RawResult;
    fn tex8_desktop_wallet_set_compute_backend(
        core: *mut RawCore,
        preference: *const c_char,
    ) -> RawResult;
    fn tex8_desktop_wallet_benchmark_derivation_performance(core: *mut RawCore) -> RawResult;
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
    fn tex8_desktop_wallet_set_grpc_endpoint(
        core: *mut RawCore,
        wallet_id: *const c_char,
        endpoint: *const c_char,
    ) -> RawResult;
    fn tex8_desktop_wallet_network_sync_status(core: *mut RawCore, network: u8) -> RawResult;
    fn tex8_desktop_wallet_prioritize_network_wallet(
        core: *mut RawCore,
        wallet_id: *const c_char,
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
    fn tex8_desktop_wallet_validate_recipient_address(
        core: *mut RawCore,
        address: *const c_char,
        network: u8,
    ) -> RawResult;
    fn tex8_desktop_wallet_get_seed(
        core: *mut RawCore,
        wallet_id: *const c_char,
        seed_offset: *const c_char,
    ) -> RawResult;
    fn tex8_desktop_wallet_snapshot(core: *mut RawCore, wallet_id: *const c_char) -> RawResult;
    fn tex8_desktop_wallet_sync_ledger_key_images(
        core: *mut RawCore,
        hardware_wallet_id: *const c_char,
        view_only_wallet_id: *const c_char,
    ) -> RawResult;
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
    fn tex8_desktop_wallet_prepare_mfw_name_registration(
        core: *mut RawCore,
        wallet_id: *const c_char,
        name: *const c_char,
        address: *const c_char,
        network: u8,
        registry_address: *const c_char,
        priority: *const c_char,
        account_index: u32,
    ) -> RawResult;
    fn tex8_desktop_wallet_prepare_mfw_name_claim(
        core: *mut RawCore,
        wallet_id: *const c_char,
        name: *const c_char,
        address: *const c_char,
        network: u8,
        registry_address: *const c_char,
        years: u32,
        priority: *const c_char,
        account_index: u32,
        owner_private_key_hex: *const c_char,
        commit_salt_hex: *const c_char,
    ) -> RawResult;
    fn tex8_desktop_wallet_prepare_mfw_name_transition(
        core: *mut RawCore,
        wallet_id: *const c_char,
        operation: *const c_char,
        name: *const c_char,
        address: *const c_char,
        network: u8,
        registry_address: *const c_char,
        years: u32,
        priority: *const c_char,
        account_index: u32,
        owner_private_key_hex: *const c_char,
        predecessor_record_hex: *const c_char,
        predecessor_signing_owner_public_key_hex: *const c_char,
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
    fn tex8_desktop_wallet_prime_hardware_from_view_only(
        core: *mut RawCore,
        hardware_wallet_id: *const c_char,
        view_only_wallet_id: *const c_char,
    ) -> RawResult;
    fn tex8_desktop_wallet_rebuild_hardware_wallet_cache_from_view_only(
        core: *mut RawCore,
        hardware_wallet_id: *const c_char,
        view_only_wallet_id: *const c_char,
        restore_height: u64,
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
    fn tex8_desktop_wallet_list_subaddresses(
        core: *mut RawCore,
        wallet_id: *const c_char,
        account_index: u32,
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
    fn tex8_desktop_wallet_seal_fast_receive_watch(
        core: *mut RawCore,
        identity_id: *const c_char,
        path: *const c_char,
        password: *const c_char,
        network: u8,
        restore_height: u64,
        worker_descriptor_hex: *const c_char,
        assignment_handle_hex: *const c_char,
        assignment_epoch: u64,
        issued_at: u64,
        expires_at: u64,
        now: u64,
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
        configure_public_block_spool();
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
        let password = secret_c(password)?;
        let language = c(language)?;
        self.result(unsafe {
            tex8_desktop_wallet_create(
                self.core.as_ptr(),
                path.as_ptr(),
                password.as_ptr().cast(),
                language.as_ptr(),
                network,
            )
        })
    }
    pub fn ledger_transport_status(&self) -> Result<String, String> {
        self.result(unsafe { tex8_desktop_wallet_ledger_transport_status(self.core.as_ptr()) })
    }
    pub fn ledger_connection_status(&self) -> Result<String, String> {
        self.result(unsafe { tex8_desktop_wallet_ledger_connection_status(self.core.as_ptr()) })
    }
    pub fn compute_backend_status(&self) -> Result<String, String> {
        self.result(unsafe { tex8_desktop_wallet_compute_backend_status(self.core.as_ptr()) })
    }
    pub fn set_compute_backend(&self, preference: &str) -> Result<String, String> {
        let preference = c(preference)?;
        self.result(unsafe {
            tex8_desktop_wallet_set_compute_backend(self.core.as_ptr(), preference.as_ptr())
        })
    }
    pub fn benchmark_derivation_performance(&self) -> Result<String, String> {
        self.result(unsafe {
            tex8_desktop_wallet_benchmark_derivation_performance(self.core.as_ptr())
        })
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
        let password = secret_c(password)?;
        let mnemonic = secret_c(mnemonic)?;
        let seed_offset = secret_c(seed_offset)?;
        self.result(unsafe {
            tex8_desktop_wallet_restore(
                self.core.as_ptr(),
                path.as_ptr(),
                password.as_ptr().cast(),
                mnemonic.as_ptr().cast(),
                seed_offset.as_ptr().cast(),
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
        let password = secret_c(request.password)?;
        let device_name = c(request.device_name)?;
        let subaddress_lookahead = c(request.subaddress_lookahead)?;
        self.result(unsafe {
            tex8_desktop_wallet_create_from_device(
                self.core.as_ptr(),
                path.as_ptr(),
                password.as_ptr().cast(),
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
        let password = secret_c(request.password)?;
        let address = c(request.address)?;
        let private_view_key = secret_c(request.private_view_key)?;
        self.result(unsafe {
            tex8_desktop_wallet_create_view_only(
                self.core.as_ptr(),
                path.as_ptr(),
                password.as_ptr().cast(),
                request.network,
                request.restore_height,
                address.as_ptr(),
                private_view_key.as_ptr().cast(),
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
        let password = secret_c(config.password)?;
        let proxy_address = c(config.proxy_address)?;
        self.result(unsafe {
            tex8_desktop_wallet_set_daemon(
                self.core.as_ptr(),
                wallet_id.as_ptr(),
                address.as_ptr(),
                config.trusted.into(),
                config.use_ssl.into(),
                username.as_ptr(),
                password.as_ptr().cast(),
                proxy_address.as_ptr(),
            )
        })
        .map(|_| ())
    }
    pub fn set_grpc_endpoint(&self, wallet_id: &str, endpoint: &str) -> Result<(), String> {
        let wallet_id = c(wallet_id)?;
        let endpoint = c(endpoint)?;
        self.result(unsafe {
            tex8_desktop_wallet_set_grpc_endpoint(
                self.core.as_ptr(),
                wallet_id.as_ptr(),
                endpoint.as_ptr(),
            )
        })
        .map(|_| ())
    }
    pub fn network_sync_status(&self, network: u8) -> Result<String, String> {
        self.result(unsafe { tex8_desktop_wallet_network_sync_status(self.core.as_ptr(), network) })
    }
    pub fn prioritize_network_wallet(&self, wallet_id: &str) -> Result<(), String> {
        let wallet_id = c(wallet_id)?;
        self.result(unsafe {
            tex8_desktop_wallet_prioritize_network_wallet(self.core.as_ptr(), wallet_id.as_ptr())
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
    pub fn validate_recipient_address(&self, address: &str, network: u8) -> Result<String, String> {
        let address = c(address)?;
        self.result(unsafe {
            tex8_desktop_wallet_validate_recipient_address(
                self.core.as_ptr(),
                address.as_ptr(),
                network,
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
    pub fn sync_ledger_key_images(
        &self,
        hardware_wallet_id: &str,
        view_only_wallet_id: &str,
    ) -> Result<String, String> {
        let hardware_wallet_id = c(hardware_wallet_id)?;
        let view_only_wallet_id = c(view_only_wallet_id)?;
        self.result(unsafe {
            tex8_desktop_wallet_sync_ledger_key_images(
                self.core.as_ptr(),
                hardware_wallet_id.as_ptr(),
                view_only_wallet_id.as_ptr(),
            )
        })
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
    pub fn list_subaddresses(&self, wallet_id: &str, account_index: u32) -> Result<String, String> {
        let wallet_id = c(wallet_id)?;
        self.result(unsafe {
            tex8_desktop_wallet_list_subaddresses(
                self.core.as_ptr(),
                wallet_id.as_ptr(),
                account_index,
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
        let password = secret_c(request.password)?;
        let label = c(request.label)?;
        self.result(unsafe {
            tex8_desktop_wallet_create_fast_receive_identity(
                self.core.as_ptr(),
                source_wallet_id.as_ptr(),
                identity_id.as_ptr(),
                path.as_ptr(),
                password.as_ptr().cast(),
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
        let password = secret_c(password)?;
        self.result(unsafe {
            tex8_desktop_wallet_fast_receive_registration_payload(
                self.core.as_ptr(),
                identity_id.as_ptr(),
                path.as_ptr(),
                password.as_ptr().cast(),
                network,
                restore_height,
            )
        })
    }
    #[allow(clippy::too_many_arguments, dead_code)]
    pub fn seal_fast_receive_watch(
        &self,
        identity_id: &str,
        path: &str,
        password: &str,
        network: u8,
        restore_height: u64,
        worker_descriptor_hex: &str,
        assignment_handle_hex: &str,
        assignment_epoch: u64,
        issued_at: u64,
        expires_at: u64,
        now: u64,
    ) -> Result<String, String> {
        let identity_id = c(identity_id)?;
        let path = c(path)?;
        let password = secret_c(password)?;
        let descriptor = c(worker_descriptor_hex)?;
        let handle = c(assignment_handle_hex)?;
        self.result(unsafe {
            tex8_desktop_wallet_seal_fast_receive_watch(
                self.core.as_ptr(),
                identity_id.as_ptr(),
                path.as_ptr(),
                password.as_ptr().cast(),
                network,
                restore_height,
                descriptor.as_ptr(),
                handle.as_ptr(),
                assignment_epoch,
                issued_at,
                expires_at,
                now,
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
    #[allow(clippy::too_many_arguments)]
    pub fn prepare_mfw_name_registration(
        &self,
        wallet_id: &str,
        name: &str,
        address: &str,
        network: u8,
        registry_address: &str,
        priority: &str,
        account_index: u32,
    ) -> Result<String, String> {
        let wallet_id = c(wallet_id)?;
        let name = c(name)?;
        let address = c(address)?;
        let registry_address = c(registry_address)?;
        let priority = c(priority)?;
        self.result(unsafe {
            tex8_desktop_wallet_prepare_mfw_name_registration(
                self.core.as_ptr(),
                wallet_id.as_ptr(),
                name.as_ptr(),
                address.as_ptr(),
                network,
                registry_address.as_ptr(),
                priority.as_ptr(),
                account_index,
            )
        })
    }
    #[allow(clippy::too_many_arguments)]
    pub fn prepare_mfw_name_claim(
        &self,
        wallet_id: &str,
        name: &str,
        address: &str,
        network: u8,
        registry_address: &str,
        years: u32,
        priority: &str,
        account_index: u32,
        owner_private_key_hex: &str,
        commit_salt_hex: &str,
    ) -> Result<String, String> {
        let wallet_id = c(wallet_id)?;
        let name = c(name)?;
        let address = c(address)?;
        let registry_address = c(registry_address)?;
        let priority = c(priority)?;
        let owner_private_key_hex = secret_c(owner_private_key_hex)?;
        let commit_salt_hex = secret_c(commit_salt_hex)?;
        self.result(unsafe {
            tex8_desktop_wallet_prepare_mfw_name_claim(
                self.core.as_ptr(),
                wallet_id.as_ptr(),
                name.as_ptr(),
                address.as_ptr(),
                network,
                registry_address.as_ptr(),
                years,
                priority.as_ptr(),
                account_index,
                owner_private_key_hex.as_ptr().cast(),
                commit_salt_hex.as_ptr().cast(),
            )
        })
    }
    #[allow(clippy::too_many_arguments)]
    pub fn prepare_mfw_name_transition(
        &self,
        wallet_id: &str,
        operation: &str,
        name: &str,
        address: &str,
        network: u8,
        registry_address: &str,
        years: u32,
        priority: &str,
        account_index: u32,
        owner_private_key_hex: &str,
        predecessor_record_hex: &str,
        predecessor_signing_owner_public_key_hex: &str,
    ) -> Result<String, String> {
        let wallet_id = c(wallet_id)?;
        let operation = c(operation)?;
        let name = c(name)?;
        let address = c(address)?;
        let registry_address = c(registry_address)?;
        let priority = c(priority)?;
        let owner_private_key_hex = secret_c(owner_private_key_hex)?;
        let predecessor_record_hex = c(predecessor_record_hex)?;
        let predecessor_signer = c(predecessor_signing_owner_public_key_hex)?;
        self.result(unsafe {
            tex8_desktop_wallet_prepare_mfw_name_transition(
                self.core.as_ptr(),
                wallet_id.as_ptr(),
                operation.as_ptr(),
                name.as_ptr(),
                address.as_ptr(),
                network,
                registry_address.as_ptr(),
                years,
                priority.as_ptr(),
                account_index,
                owner_private_key_hex.as_ptr().cast(),
                predecessor_record_hex.as_ptr(),
                predecessor_signer.as_ptr(),
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
    pub fn prime_hardware_from_view_only(
        &self,
        hardware_wallet_id: &str,
        view_only_wallet_id: &str,
    ) -> Result<(), String> {
        let hardware_wallet_id = c(hardware_wallet_id)?;
        let view_only_wallet_id = c(view_only_wallet_id)?;
        self.result(unsafe {
            tex8_desktop_wallet_prime_hardware_from_view_only(
                self.core.as_ptr(),
                hardware_wallet_id.as_ptr(),
                view_only_wallet_id.as_ptr(),
            )
        })
        .map(|_| ())
    }
    pub fn rebuild_hardware_wallet_cache_from_view_only(
        &self,
        hardware_wallet_id: &str,
        view_only_wallet_id: &str,
        restore_height: u64,
    ) -> Result<(), String> {
        let hardware_wallet_id = c(hardware_wallet_id)?;
        let view_only_wallet_id = c(view_only_wallet_id)?;
        self.result(unsafe {
            tex8_desktop_wallet_rebuild_hardware_wallet_cache_from_view_only(
                self.core.as_ptr(),
                hardware_wallet_id.as_ptr(),
                view_only_wallet_id.as_ptr(),
                restore_height,
            )
        })
        .map(|_| ())
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
        let password = secret_c(password)?;
        self.result(operation(
            self.core.as_ptr(),
            path.as_ptr(),
            password.as_ptr().cast(),
        ))
    }
    fn result(&self, mut result: RawResult) -> Result<String, String> {
        let output = unsafe {
            if result.ok == 1 && !result.value.is_null() {
                Ok(CStr::from_ptr(result.value).to_string_lossy().into_owned())
            } else if !result.error.is_null() {
                let error = CStr::from_ptr(result.error).to_string_lossy();
                // Native process-local handles are deliberately never exposed
                // or logged. Their one recoverable lookup failure crosses the
                // FFI boundary only as a fixed safe code.
                if error.starts_with("unknown wallet id:") {
                    Err(SESSION_STALE_CODE.to_owned())
                } else {
                    Err(error.into_owned())
                }
            } else {
                Err("Native wallet operation failed.".to_owned())
            }
        };
        unsafe { tex8_desktop_result_free(&mut result) };
        output
    }
}

fn configure_public_block_spool() {
    const PREFIX: &str = "mfw-public-block-spool-";
    const SUFFIX: &str = ".chunk";
    let data_root: Option<PathBuf> = if cfg!(target_os = "macos") {
        std::env::var_os("HOME")
            .map(PathBuf::from)
            .map(|path| path.join("Library/Application Support"))
    } else if cfg!(target_os = "windows") {
        std::env::var_os("LOCALAPPDATA").map(PathBuf::from)
    } else {
        std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .or_else(|| {
                std::env::var_os("HOME")
                    .map(PathBuf::from)
                    .map(|path| path.join(".local/share"))
            })
    };
    let Some(directory) = data_root.map(|path| {
        path.join("com.tex8.monerowallet.desktop")
            .join("public-block-spool")
    }) else {
        eprintln!("MONERO_DESKTOP_SPOOL enabled=false reason=data-directory");
        return;
    };
    if fs::create_dir_all(&directory).is_err() {
        eprintln!("MONERO_DESKTOP_SPOOL enabled=false reason=directory");
        return;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&directory, fs::Permissions::from_mode(0o700));
    }
    let mut removed_orphans = 0_u64;
    if let Ok(entries) = fs::read_dir(&directory) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.starts_with(PREFIX)
                && name.ends_with(SUFFIX)
                && entry.file_type().is_ok_and(|kind| kind.is_file())
                && fs::remove_file(entry.path()).is_ok()
            {
                removed_orphans += 1;
            }
        }
    }
    let Ok(directory) = CString::new(directory.to_string_lossy().as_bytes()) else {
        eprintln!("MONERO_DESKTOP_SPOOL enabled=false reason=path");
        return;
    };
    let requested_maximum_bytes = crate::spool_preferences::load_for_native();
    let limit = unsafe {
        tex8_desktop_wallet_configure_public_block_spool(
            directory.as_ptr(),
            requested_maximum_bytes,
        )
    };
    if limit == 0 {
        eprintln!(
            "MONERO_DESKTOP_SPOOL enabled=false reason=capacity orphan_files_removed={removed_orphans}"
        );
    } else {
        eprintln!(
            "MONERO_DESKTOP_SPOOL enabled=true max_mib={} orphan_files_removed={removed_orphans}",
            limit / (1024 * 1024)
        );
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

/// `CString` does not promise to wipe its allocation. Sensitive values use a
/// NUL-terminated zeroizing buffer so the Rust-side FFI copy is erased as soon
/// as the native call returns.
fn secret_c(value: &str) -> Result<Zeroizing<Vec<u8>>, String> {
    if value.as_bytes().contains(&0) {
        return Err("Invalid sensitive text input.".to_owned());
    }
    let mut bytes = Zeroizing::new(Vec::with_capacity(value.len() + 1));
    bytes.extend_from_slice(value.as_bytes());
    bytes.push(0);
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::{FastReceiveIdentityCreate, NativeWallet};
    use fast_wallet_protocol::{
        generate_hpke_keypair, Network, SigningKeyMaterial, WorkerDescriptor,
        WorkerDescriptorInput, WATCH_ENVELOPE_SIZE,
    };
    use std::{
        fs, thread,
        time::{Duration, SystemTime, UNIX_EPOCH},
    };
    use zeroize::Zeroize;

    #[test]
    fn compute_backend_policy_round_trips_through_the_native_c_abi() {
        let wallet = NativeWallet::new().expect("native wallet shell");
        for preference in ["auto", "cpu", "gpu"] {
            let encoded = wallet
                .set_compute_backend(preference)
                .expect("accepted compute policy");
            let status: serde_json::Value =
                serde_json::from_str(&encoded).expect("compute status JSON");
            assert_eq!(status["preference"], preference);
            assert_eq!(status["cpuFallback"], true);
        }
        assert!(wallet.set_compute_backend("cuda").is_err());
    }

    #[test]
    fn derivation_benchmark_crosses_the_native_c_abi_as_bounded_json() {
        let wallet = NativeWallet::new().expect("native wallet shell");
        let encoded = wallet
            .benchmark_derivation_performance()
            .expect("public derivation benchmark JSON");
        eprintln!("native derivation benchmark: {encoded}");
        let benchmark: serde_json::Value =
            serde_json::from_str(&encoded).expect("derivation benchmark JSON");
        assert_eq!(benchmark["schemaVersion"], 1);
        for backend in ["cpu", "metal", "cuda"] {
            assert!(benchmark[backend]["derivationsPerSecond"].is_number());
            assert!(benchmark[backend]["verified"].is_boolean());
        }
        #[cfg(target_os = "macos")]
        if option_env!("TEX8_DESKTOP_MONERO_LINKED") == Some("1") {
            assert_eq!(benchmark["metal"]["available"], true);
            assert_eq!(benchmark["metal"]["verified"], true);
            assert!(
                benchmark["metal"]["derivationsPerSecond"]
                    .as_u64()
                    .expect("Metal derivation rate")
                    > 0
            );
        }
    }

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
            assert_eq!(wallet.validate_recipient_address(&address, 0)?, address);
            assert!(
                wallet.validate_recipient_address(&address, 2).is_err(),
                "mainnet recipient must fail closed on stagenet"
            );
            assert_eq!(
                wallet.recovery_seed(&wallet_id)?.split_whitespace().count(),
                25
            );
            let subaddress = wallet.create_subaddress(&wallet_id, 0, "desktop smoke")?;
            assert!(subaddress.contains("address"));

            let fast_identity_id = "fast-receive-v2-1-desktop-smoke";
            let fast_path = root.join(fast_identity_id).to_string_lossy().into_owned();
            let fast_identity = wallet.create_fast_receive_identity(FastReceiveIdentityCreate {
                source_wallet_id: &wallet_id,
                identity_id: fast_identity_id,
                path: &fast_path,
                password: "independent-fast-password",
                label: "Fast Wallet",
                restore_height: 0,
                derivation_index: 1,
            })?;
            assert!(fast_identity.contains(fast_identity_id));
            assert!(fast_identity.contains("\"address\":\"4"));
            let mut registration_payload = wallet.fast_receive_registration_payload(
                fast_identity_id,
                &fast_path,
                "independent-fast-password",
                0,
                0,
            )?;
            assert!(registration_payload.contains("privateViewKey"));
            assert!(registration_payload.contains(fast_identity_id));
            registration_payload.zeroize();
            let protocol_now = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system clock")
                .as_secs();
            let root_key = SigningKeyMaterial::from_bytes([17_u8; 32]);
            let online_key = SigningKeyMaterial::from_bytes([18_u8; 32]);
            let (_, hpke_public_key) = generate_hpke_keypair().expect("HPKE key");
            let descriptor = WorkerDescriptor::sign(
                WorkerDescriptorInput {
                    network: Network::Mainnet,
                    issued_at: protocol_now.saturating_sub(1),
                    expires_at: protocol_now + 600,
                    worker_online_public_key: online_key.public_key(),
                    hpke_public_key,
                    relay_origin: "https://relay.test.invalid".to_owned(),
                },
                &root_key,
            )
            .expect("worker descriptor");
            let envelope = wallet.seal_fast_receive_watch(
                fast_identity_id,
                &fast_path,
                "independent-fast-password",
                0,
                0,
                &hex::encode(descriptor.encode().expect("descriptor encode")),
                &"11".repeat(32),
                1,
                protocol_now,
                protocol_now + 300,
                protocol_now,
            )?;
            assert_eq!(envelope.len(), WATCH_ENVELOPE_SIZE * 2);
            assert!(!envelope.contains("privateViewKey"));
            let opened_fast_id = wallet.open(&fast_path, "independent-fast-password", 0, 0)?;
            let fast_address = wallet.address(&opened_fast_id, 0, 0)?;
            assert!(fast_address.starts_with('4'));
            assert!(wallet.snapshot(&opened_fast_id)?.contains("primaryAddress"));
            wallet.close(&opened_fast_id, true)?;

            // Exercise the production close ordering against a live API
            // refresh worker. Closing must join that worker before wallet2
            // serializes its hash chain; otherwise this path can crash inside
            // get_cache_file_data() instead of returning a Rust error.
            wallet.start_refresh(&wallet_id)?;
            thread::sleep(Duration::from_millis(25));
            wallet.close(&wallet_id, true)?;

            let reopened_id = wallet.open(&wallet_path, "test-password", 0, 0)?;
            assert_eq!(wallet.address(&reopened_id, 0, 0)?, address);
            wallet.close(&reopened_id, false)
        })();

        fs::remove_dir_all(&root).expect("remove only the isolated wallet test directory");
        result.expect("real Monero WalletEngine smoke test");
    }
}
