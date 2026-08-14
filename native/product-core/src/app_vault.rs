//! Platform-neutral AppVault, authorization and local-session state machine.
//!
//! Cryptographic storage and OS authentication remain platform adapters. This
//! module owns the decisions that must be byte-for-byte equivalent in the CLI,
//! React Native and Tauri: first-run presentation, one global authorization,
//! persistent non-destructive backoff, monotonic auto-lock, migration order,
//! bounded wallet prewarming and one-use step-up grants.

use crate::contract;
use argon2::{Algorithm, Argon2, Params, Version};
use std::mem::size_of;
use std::ptr;
use std::slice;
use zeroize::Zeroizing;

pub const DEFAULT_AUTO_LOCK_SECONDS: u64 = contract::APP_VAULT_DEFAULT_AUTO_LOCK_SECONDS;
pub const PASSWORD_MINIMUM_CHARACTERS: usize = contract::APP_VAULT_PASSWORD_MINIMUM_CHARACTERS;
pub const PASSWORD_MAXIMUM_CHARACTERS: usize = contract::APP_VAULT_PASSWORD_MAXIMUM_CHARACTERS;
pub const PASSWORD_KDF_MEMORY_KIB: u32 = contract::APP_VAULT_PASSWORD_KDF_MEMORY_KIB;
pub const PASSWORD_KDF_ITERATIONS: u32 = contract::APP_VAULT_PASSWORD_KDF_ITERATIONS;
pub const PASSWORD_KDF_PARALLELISM: u32 = contract::APP_VAULT_PASSWORD_KDF_PARALLELISM;

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MfwAppVaultPasswordVerifierV1 {
    pub struct_size: u32,
    pub state_version: u32,
    pub kdf_version: u32,
    pub memory_kib: u32,
    pub iterations: u32,
    pub parallelism: u32,
    pub salt: [u8; 16],
    pub digest: [u8; 32],
}

impl Default for MfwAppVaultPasswordVerifierV1 {
    fn default() -> Self {
        Self {
            struct_size: size_of::<Self>() as u32,
            state_version: contract::APP_VAULT_STATE_SCHEMA_VERSION,
            kdf_version: contract::APP_VAULT_PASSWORD_KDF_VERSION,
            memory_kib: PASSWORD_KDF_MEMORY_KIB,
            iterations: PASSWORD_KDF_ITERATIONS,
            parallelism: PASSWORD_KDF_PARALLELISM,
            salt: [0; 16],
            digest: [0; 32],
        }
    }
}

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MfwAppVaultStateV1 {
    pub struct_size: u32,
    pub state_version: u32,
    pub ready: u32,
    pub onboarding_complete: u32,
    pub configured: u32,
    pub protection_mode: u32,
    pub session_authorized: u32,
    pub migration_state: u32,
    pub failed_attempts: u32,
    pub reserved: u32,
    pub auto_lock_seconds: u64,
    pub blocked_until_unix_seconds: u64,
    pub last_activity_monotonic_ms: u64,
}

impl Default for MfwAppVaultStateV1 {
    fn default() -> Self {
        Self {
            struct_size: size_of::<Self>() as u32,
            state_version: contract::APP_VAULT_STATE_SCHEMA_VERSION,
            ready: 0,
            onboarding_complete: 0,
            configured: 0,
            protection_mode: contract::APP_VAULT_PROTECTION_MODE_UNCONFIGURED,
            session_authorized: 0,
            migration_state: contract::APP_VAULT_MIGRATION_LEGACY_AUTHORITATIVE,
            failed_attempts: 0,
            reserved: 0,
            auto_lock_seconds: DEFAULT_AUTO_LOCK_SECONDS,
            blocked_until_unix_seconds: 0,
            last_activity_monotonic_ms: 0,
        }
    }
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct MfwAppVaultEventV1 {
    pub struct_size: u32,
    pub event: u32,
    pub value: u32,
    pub reserved: u32,
    pub now_unix_seconds: u64,
    pub now_monotonic_ms: u64,
}

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MfwAppVaultStepUpGrantV1 {
    pub struct_size: u32,
    pub state_version: u32,
    pub action: u32,
    pub consumed: u32,
    pub expires_at_monotonic_ms: u64,
    pub wallet_pseudonym: [u8; 16],
}

impl Default for MfwAppVaultStepUpGrantV1 {
    fn default() -> Self {
        Self {
            struct_size: size_of::<Self>() as u32,
            state_version: contract::APP_VAULT_STATE_SCHEMA_VERSION,
            action: 0,
            consumed: 0,
            expires_at_monotonic_ms: 0,
            wallet_pseudonym: [0; 16],
        }
    }
}

pub fn unlock_delay_seconds(failures: u32) -> u64 {
    if failures == 0 {
        return 0;
    }
    let index = (failures as usize).min(contract::APP_VAULT_UNLOCK_BACKOFF_SECONDS.len() - 1);
    contract::APP_VAULT_UNLOCK_BACKOFF_SECONDS[index]
}

pub fn auto_lock_seconds_allowed(seconds: u64) -> bool {
    contract::APP_VAULT_AUTO_LOCK_SECONDS.contains(&seconds)
}

pub fn validate_state(state: &MfwAppVaultStateV1) -> Result<(), u32> {
    if state.struct_size != size_of::<MfwAppVaultStateV1>() as u32
        || state.state_version != contract::APP_VAULT_STATE_SCHEMA_VERSION
        || state.reserved != 0
    {
        return Err(contract::ERROR_UNSUPPORTED_ABI);
    }
    if !matches!(state.ready, 0 | 1)
        || !matches!(state.onboarding_complete, 0 | 1)
        || !matches!(state.configured, 0 | 1)
        || !matches!(state.session_authorized, 0 | 1)
        || !auto_lock_seconds_allowed(state.auto_lock_seconds)
        || state.migration_state > contract::APP_VAULT_MIGRATION_CLEANUP_COMPLETE
    {
        return Err(contract::ERROR_INVALID_ARGUMENT);
    }
    if state.configured == 0 {
        if state.protection_mode != contract::APP_VAULT_PROTECTION_MODE_UNCONFIGURED
            || state.session_authorized != 0
        {
            return Err(contract::ERROR_INVALID_ARGUMENT);
        }
    } else {
        if !matches!(
            state.protection_mode,
            contract::APP_VAULT_PROTECTION_MODE_PASSWORD
                | contract::APP_VAULT_PROTECTION_MODE_SYSTEM
                | contract::APP_VAULT_PROTECTION_MODE_NONE
        ) {
            return Err(contract::ERROR_UNKNOWN_ENUM);
        }
        if state.protection_mode == contract::APP_VAULT_PROTECTION_MODE_NONE
            && state.session_authorized != 1
        {
            return Err(contract::ERROR_INVALID_ARGUMENT);
        }
    }
    Ok(())
}

pub fn presentation(state: &MfwAppVaultStateV1, now_unix_seconds: u64) -> Result<u32, u32> {
    validate_state(state)?;
    if state.ready == 0 {
        return Ok(contract::APP_VAULT_PRESENTATION_PREPARING);
    }
    if state.configured == 0 {
        return Ok(if state.onboarding_complete == 0 {
            contract::APP_VAULT_PRESENTATION_WELCOME
        } else {
            contract::APP_VAULT_PRESENTATION_PROTECTION_SETUP
        });
    }
    if state.session_authorized == 1 {
        return Ok(contract::APP_VAULT_PRESENTATION_CONTENT);
    }
    if state.blocked_until_unix_seconds > now_unix_seconds {
        return Ok(contract::APP_VAULT_PRESENTATION_BACKOFF);
    }
    Ok(
        if state.protection_mode == contract::APP_VAULT_PROTECTION_MODE_SYSTEM {
            contract::APP_VAULT_PRESENTATION_UNLOCK_SYSTEM
        } else {
            contract::APP_VAULT_PRESENTATION_UNLOCK_PASSWORD
        },
    )
}

pub fn apply_event(
    state: &MfwAppVaultStateV1,
    event: &MfwAppVaultEventV1,
) -> Result<MfwAppVaultStateV1, u32> {
    validate_state(state)?;
    if event.struct_size != size_of::<MfwAppVaultEventV1>() as u32 || event.reserved != 0 {
        return Err(contract::ERROR_UNSUPPORTED_ABI);
    }
    let mut next = *state;
    match event.event {
        contract::APP_VAULT_EVENT_WELCOME_CONTINUE => {
            if state.configured != 0 {
                return Err(contract::ERROR_INVALID_ARGUMENT);
            }
            next.onboarding_complete = 1;
        }
        contract::APP_VAULT_EVENT_CONFIGURE_PASSWORD_SUCCESS
        | contract::APP_VAULT_EVENT_CONFIGURE_SYSTEM_SUCCESS => {
            if state.configured != 0 || state.onboarding_complete == 0 || event.value != 1 {
                return Err(contract::ERROR_INVALID_ARGUMENT);
            }
            next.configured = 1;
            next.protection_mode =
                if event.event == contract::APP_VAULT_EVENT_CONFIGURE_SYSTEM_SUCCESS {
                    contract::APP_VAULT_PROTECTION_MODE_SYSTEM
                } else {
                    contract::APP_VAULT_PROTECTION_MODE_PASSWORD
                };
            next.session_authorized = 1;
            next.failed_attempts = 0;
            next.blocked_until_unix_seconds = 0;
            next.last_activity_monotonic_ms = event.now_monotonic_ms;
        }
        contract::APP_VAULT_EVENT_SKIP_PROTECTION => {
            if state.configured != 0 || state.onboarding_complete == 0 || event.value != 1 {
                return Err(contract::ERROR_INVALID_ARGUMENT);
            }
            next.configured = 1;
            next.protection_mode = contract::APP_VAULT_PROTECTION_MODE_NONE;
            next.session_authorized = 1;
            next.failed_attempts = 0;
            next.blocked_until_unix_seconds = 0;
            next.last_activity_monotonic_ms = event.now_monotonic_ms;
        }
        contract::APP_VAULT_EVENT_UNLOCK_SUCCESS => {
            if state.configured == 0 || state.blocked_until_unix_seconds > event.now_unix_seconds {
                return Err(contract::ERROR_INVALID_ARGUMENT);
            }
            next.session_authorized = 1;
            next.failed_attempts = 0;
            next.blocked_until_unix_seconds = 0;
            next.last_activity_monotonic_ms = event.now_monotonic_ms;
        }
        contract::APP_VAULT_EVENT_UNLOCK_FAILURE => {
            if state.configured == 0 || state.session_authorized != 0 {
                return Err(contract::ERROR_INVALID_ARGUMENT);
            }
            next.failed_attempts = state.failed_attempts.saturating_add(1);
            next.blocked_until_unix_seconds = event
                .now_unix_seconds
                .saturating_add(unlock_delay_seconds(next.failed_attempts));
        }
        contract::APP_VAULT_EVENT_USER_ACTIVITY => {
            if state.session_authorized == 0 {
                return Err(contract::ERROR_INVALID_ARGUMENT);
            }
            next.last_activity_monotonic_ms = event.now_monotonic_ms;
        }
        contract::APP_VAULT_EVENT_TIMEOUT => {
            if state.protection_mode == contract::APP_VAULT_PROTECTION_MODE_NONE
                || state.session_authorized == 0
                || state.auto_lock_seconds == 0
                || event
                    .now_monotonic_ms
                    .saturating_sub(state.last_activity_monotonic_ms)
                    < state.auto_lock_seconds.saturating_mul(1000)
            {
                return Err(contract::ERROR_INVALID_ARGUMENT);
            }
            next.session_authorized = 0;
        }
        contract::APP_VAULT_EVENT_MANUAL_LOCK => {
            if state.configured == 0
                || state.protection_mode == contract::APP_VAULT_PROTECTION_MODE_NONE
            {
                return Err(contract::ERROR_INVALID_ARGUMENT);
            }
            next.session_authorized = 0;
        }
        contract::APP_VAULT_EVENT_CHANGE_TO_PASSWORD
        | contract::APP_VAULT_EVENT_CHANGE_TO_SYSTEM => {
            if state.session_authorized == 0 || event.value != 1 {
                return Err(contract::ERROR_INVALID_ARGUMENT);
            }
            next.protection_mode = if event.event == contract::APP_VAULT_EVENT_CHANGE_TO_SYSTEM {
                contract::APP_VAULT_PROTECTION_MODE_SYSTEM
            } else {
                contract::APP_VAULT_PROTECTION_MODE_PASSWORD
            };
        }
        contract::APP_VAULT_EVENT_MIGRATION_ADVANCE => {
            let expected = state.migration_state.saturating_add(1);
            if expected > contract::APP_VAULT_MIGRATION_CLEANUP_COMPLETE || event.value != expected
            {
                return Err(contract::ERROR_INVALID_ARGUMENT);
            }
            next.migration_state = expected;
        }
        _ => return Err(contract::ERROR_UNKNOWN_ENUM),
    }
    validate_state(&next)?;
    Ok(next)
}

pub fn local_wallet_switch_allowed(
    state: &MfwAppVaultStateV1,
    registry_entry_available: bool,
    sanitized_snapshot_available: bool,
) -> bool {
    validate_state(state).is_ok()
        && state.session_authorized == 1
        && registry_entry_available
        && sanitized_snapshot_available
}

pub fn warmup_batch(wallet_count: usize, completed: usize) -> (usize, usize) {
    if completed >= wallet_count {
        return (wallet_count, 0);
    }
    (
        completed,
        (wallet_count - completed).min(contract::APP_VAULT_WARMUP_MAXIMUM_CONCURRENT_WALLETS),
    )
}

fn valid_step_up_action(action: u32) -> bool {
    matches!(
        action,
        contract::APP_VAULT_STEP_UP_SEED_EXPORT
            | contract::APP_VAULT_STEP_UP_PRIVATE_KEY_EXPORT
            | contract::APP_VAULT_STEP_UP_SEND_COMMIT
            | contract::APP_VAULT_STEP_UP_PROTECTION_CHANGE
            | contract::APP_VAULT_STEP_UP_LOCAL_RESET
            | contract::APP_VAULT_STEP_UP_HOSTED_DATA_DELETE
    )
}

pub fn issue_step_up_grant(
    state: &MfwAppVaultStateV1,
    action: u32,
    wallet_pseudonym: [u8; 16],
    now_monotonic_ms: u64,
    ttl_ms: u64,
) -> Result<MfwAppVaultStepUpGrantV1, u32> {
    validate_state(state)?;
    if state.session_authorized == 0
        || !valid_step_up_action(action)
        || !(1..=300_000).contains(&ttl_ms)
    {
        return Err(contract::ERROR_INVALID_ARGUMENT);
    }
    Ok(MfwAppVaultStepUpGrantV1 {
        action,
        expires_at_monotonic_ms: now_monotonic_ms.saturating_add(ttl_ms),
        wallet_pseudonym,
        ..Default::default()
    })
}

pub fn consume_step_up_grant(
    grant: &mut MfwAppVaultStepUpGrantV1,
    action: u32,
    wallet_pseudonym: [u8; 16],
    now_monotonic_ms: u64,
) -> Result<(), u32> {
    if grant.struct_size != size_of::<MfwAppVaultStepUpGrantV1>() as u32
        || grant.state_version != contract::APP_VAULT_STATE_SCHEMA_VERSION
        || grant.consumed != 0
        || grant.action != action
        || grant.wallet_pseudonym != wallet_pseudonym
        || now_monotonic_ms > grant.expires_at_monotonic_ms
    {
        return Err(contract::ERROR_INVALID_ARGUMENT);
    }
    grant.consumed = 1;
    Ok(())
}

fn password_bytes(password: &[u8]) -> Result<&str, u32> {
    let password = std::str::from_utf8(password).map_err(|_| contract::ERROR_INVALID_ARGUMENT)?;
    let characters = password.chars().count();
    if !(contract::APP_VAULT_PASSWORD_MINIMUM_CHARACTERS
        ..=contract::APP_VAULT_PASSWORD_MAXIMUM_CHARACTERS)
        .contains(&characters)
    {
        return Err(contract::ERROR_INVALID_ARGUMENT);
    }
    Ok(password)
}

fn password_kdf(password: &[u8], salt: &[u8; 16]) -> Result<Zeroizing<[u8; 32]>, u32> {
    password_bytes(password)?;
    let params = Params::new(
        PASSWORD_KDF_MEMORY_KIB,
        PASSWORD_KDF_ITERATIONS,
        PASSWORD_KDF_PARALLELISM,
        Some(32),
    )
    .map_err(|_| contract::ERROR_INTERNAL)?;
    let mut output = Zeroizing::new([0u8; 32]);
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
        .hash_password_into(password, salt, output.as_mut())
        .map_err(|_| contract::ERROR_INTERNAL)?;
    Ok(output)
}

pub fn create_password_verifier(password: &[u8]) -> Result<MfwAppVaultPasswordVerifierV1, u32> {
    password_bytes(password)?;
    let mut verifier = MfwAppVaultPasswordVerifierV1::default();
    getrandom::getrandom(&mut verifier.salt).map_err(|_| contract::ERROR_INTERNAL)?;
    verifier
        .digest
        .copy_from_slice(password_kdf(password, &verifier.salt)?.as_ref());
    Ok(verifier)
}

pub fn verify_password(
    password: &[u8],
    verifier: &MfwAppVaultPasswordVerifierV1,
) -> Result<bool, u32> {
    validate_password_verifier(verifier)?;
    let candidate = password_kdf(password, &verifier.salt)?;
    let difference = candidate
        .iter()
        .zip(verifier.digest.iter())
        .fold(0u8, |difference, (left, right)| difference | (left ^ right));
    Ok(difference == 0)
}

pub fn validate_password_verifier(verifier: &MfwAppVaultPasswordVerifierV1) -> Result<(), u32> {
    if verifier.struct_size != size_of::<MfwAppVaultPasswordVerifierV1>() as u32
        || verifier.state_version != contract::APP_VAULT_STATE_SCHEMA_VERSION
        || verifier.kdf_version != contract::APP_VAULT_PASSWORD_KDF_VERSION
        || verifier.memory_kib != PASSWORD_KDF_MEMORY_KIB
        || verifier.iterations != PASSWORD_KDF_ITERATIONS
        || verifier.parallelism != PASSWORD_KDF_PARALLELISM
    {
        return Err(contract::ERROR_UNSUPPORTED_ABI);
    }
    Ok(())
}

#[no_mangle]
/// Creates an Argon2id verifier for the UTF-8 password bytes.
///
/// # Safety
///
/// `password` must point to `password_size` readable bytes and `output` to
/// writable, correctly aligned storage for one verifier. Neither pointer is
/// retained. The password buffer is never written or logged.
pub unsafe extern "C" fn mfw_app_vault_password_verifier_create_v1(
    password: *const u8,
    password_size: usize,
    output: *mut MfwAppVaultPasswordVerifierV1,
) -> u32 {
    if password.is_null() || output.is_null() {
        return contract::ERROR_INVALID_ARGUMENT;
    }
    match create_password_verifier(slice::from_raw_parts(password, password_size)) {
        Ok(verifier) => {
            ptr::write(output, verifier);
            contract::ERROR_OK
        }
        Err(error) => error,
    }
}

#[no_mangle]
/// Validates an AppVault verifier's ABI and canonical KDF parameters without
/// running Argon2id.
///
/// # Safety
///
/// `verifier` must point to one readable, correctly aligned verifier. The
/// pointer is not retained.
pub unsafe extern "C" fn mfw_app_vault_password_verifier_validate_v1(
    verifier: *const MfwAppVaultPasswordVerifierV1,
) -> u32 {
    if verifier.is_null() {
        return contract::ERROR_INVALID_ARGUMENT;
    }
    match validate_password_verifier(&*verifier) {
        Ok(()) => contract::ERROR_OK,
        Err(error) => error,
    }
}

#[no_mangle]
/// Verifies UTF-8 password bytes against an AppVault Argon2id verifier.
///
/// # Safety
///
/// `password` must point to `password_size` readable bytes, `verifier` to one
/// readable, correctly aligned verifier, and `matches` to one writable `u32`.
/// No pointer is retained and the password is never logged.
pub unsafe extern "C" fn mfw_app_vault_password_verifier_verify_v1(
    password: *const u8,
    password_size: usize,
    verifier: *const MfwAppVaultPasswordVerifierV1,
    matches: *mut u32,
) -> u32 {
    if password.is_null() || verifier.is_null() || matches.is_null() {
        return contract::ERROR_INVALID_ARGUMENT;
    }
    match verify_password(slice::from_raw_parts(password, password_size), &*verifier) {
        Ok(value) => {
            ptr::write(matches, u32::from(value));
            contract::ERROR_OK
        }
        Err(error) => error,
    }
}

#[no_mangle]
/// Writes the canonical version-1 AppVault state into `output`.
///
/// # Safety
///
/// `output` must be null or point to writable, correctly aligned storage for one
/// [`MfwAppVaultStateV1`]. The function rejects null and never retains the pointer.
pub unsafe extern "C" fn mfw_app_vault_state_default_v1(output: *mut MfwAppVaultStateV1) -> u32 {
    if output.is_null() {
        return contract::ERROR_INVALID_ARGUMENT;
    }
    ptr::write(output, MfwAppVaultStateV1::default());
    contract::ERROR_OK
}

#[no_mangle]
/// Applies one AppVault event and writes the resulting state into `output`.
///
/// # Safety
///
/// `state` and `event` must point to readable, correctly aligned instances of
/// their declared types. `output` must point to writable, correctly aligned
/// storage for one [`MfwAppVaultStateV1`]. Pointers must remain valid for the
/// duration of this call; none are retained.
pub unsafe extern "C" fn mfw_app_vault_apply_event_v1(
    state: *const MfwAppVaultStateV1,
    event: *const MfwAppVaultEventV1,
    output: *mut MfwAppVaultStateV1,
) -> u32 {
    if state.is_null() || event.is_null() || output.is_null() {
        return contract::ERROR_INVALID_ARGUMENT;
    }
    match apply_event(&*state, &*event) {
        Ok(next) => {
            ptr::write(output, next);
            contract::ERROR_OK
        }
        Err(error) => error,
    }
}

#[no_mangle]
/// Resolves the presentation required for an AppVault state.
///
/// # Safety
///
/// `state` must point to a readable, correctly aligned [`MfwAppVaultStateV1`]
/// and `output` to a writable, correctly aligned `u32`. Both pointers must stay
/// valid for this call and are never retained.
pub unsafe extern "C" fn mfw_app_vault_presentation_v1(
    state: *const MfwAppVaultStateV1,
    now_unix_seconds: u64,
    output: *mut u32,
) -> u32 {
    if state.is_null() || output.is_null() {
        return contract::ERROR_INVALID_ARGUMENT;
    }
    match presentation(&*state, now_unix_seconds) {
        Ok(value) => {
            ptr::write(output, value);
            contract::ERROR_OK
        }
        Err(error) => error,
    }
}

#[no_mangle]
/// Evaluates whether a wallet selection can be completed only from the local
/// registry and sanitized snapshot.
///
/// # Safety
///
/// `state` must point to a readable, aligned state and `output` to a writable
/// `u32`. Neither pointer is retained.
pub unsafe extern "C" fn mfw_app_vault_wallet_switch_allowed_v1(
    state: *const MfwAppVaultStateV1,
    registry_entry_available: u32,
    sanitized_snapshot_available: u32,
    output: *mut u32,
) -> u32 {
    if state.is_null()
        || output.is_null()
        || !matches!(registry_entry_available, 0 | 1)
        || !matches!(sanitized_snapshot_available, 0 | 1)
    {
        return contract::ERROR_INVALID_ARGUMENT;
    }
    let allowed = local_wallet_switch_allowed(
        &*state,
        registry_entry_available == 1,
        sanitized_snapshot_available == 1,
    );
    ptr::write(output, u32::from(allowed));
    contract::ERROR_OK
}

#[no_mangle]
/// Returns the next bounded local wallet-prewarm batch.
///
/// # Safety
///
/// `output_start` and `output_count` must point to writable, aligned `size_t`
/// values. Neither pointer is retained.
pub unsafe extern "C" fn mfw_app_vault_warmup_batch_v1(
    wallet_count: usize,
    completed: usize,
    output_start: *mut usize,
    output_count: *mut usize,
) -> u32 {
    if output_start.is_null() || output_count.is_null() || completed > wallet_count {
        return contract::ERROR_INVALID_ARGUMENT;
    }
    let (start, count) = warmup_batch(wallet_count, completed);
    ptr::write(output_start, start);
    ptr::write(output_count, count);
    contract::ERROR_OK
}

#[no_mangle]
/// Issues a short, exact and single-use step-up grant.
///
/// # Safety
///
/// `state` and `wallet_pseudonym` must be readable for their declared sizes;
/// `output` must be writable and aligned for one grant. No pointer is retained.
pub unsafe extern "C" fn mfw_app_vault_step_up_issue_v1(
    state: *const MfwAppVaultStateV1,
    action: u32,
    wallet_pseudonym: *const u8,
    now_monotonic_ms: u64,
    ttl_ms: u64,
    output: *mut MfwAppVaultStepUpGrantV1,
) -> u32 {
    if state.is_null() || wallet_pseudonym.is_null() || output.is_null() {
        return contract::ERROR_INVALID_ARGUMENT;
    }
    let mut pseudonym = [0u8; 16];
    pseudonym.copy_from_slice(slice::from_raw_parts(wallet_pseudonym, 16));
    match issue_step_up_grant(&*state, action, pseudonym, now_monotonic_ms, ttl_ms) {
        Ok(grant) => {
            ptr::write(output, grant);
            contract::ERROR_OK
        }
        Err(error) => error,
    }
}

#[no_mangle]
/// Consumes an exact step-up grant once.
///
/// # Safety
///
/// `grant` must point to one writable, aligned grant and `wallet_pseudonym` to
/// 16 readable bytes. Neither pointer is retained.
pub unsafe extern "C" fn mfw_app_vault_step_up_consume_v1(
    grant: *mut MfwAppVaultStepUpGrantV1,
    action: u32,
    wallet_pseudonym: *const u8,
    now_monotonic_ms: u64,
) -> u32 {
    if grant.is_null() || wallet_pseudonym.is_null() {
        return contract::ERROR_INVALID_ARGUMENT;
    }
    let mut pseudonym = [0u8; 16];
    pseudonym.copy_from_slice(slice::from_raw_parts(wallet_pseudonym, 16));
    match consume_step_up_grant(&mut *grant, action, pseudonym, now_monotonic_ms) {
        Ok(()) => contract::ERROR_OK,
        Err(error) => error,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(kind: u32, value: u32, unix: u64, monotonic: u64) -> MfwAppVaultEventV1 {
        MfwAppVaultEventV1 {
            struct_size: size_of::<MfwAppVaultEventV1>() as u32,
            event: kind,
            value,
            reserved: 0,
            now_unix_seconds: unix,
            now_monotonic_ms: monotonic,
        }
    }

    #[test]
    fn one_unlock_serves_one_hundred_local_wallet_switches() {
        let mut state = MfwAppVaultStateV1 {
            ready: 1,
            ..Default::default()
        };
        assert_eq!(
            presentation(&state, 100).unwrap(),
            contract::APP_VAULT_PRESENTATION_WELCOME
        );
        state = apply_event(
            &state,
            &event(contract::APP_VAULT_EVENT_WELCOME_CONTINUE, 0, 100, 10),
        )
        .unwrap();
        state = apply_event(
            &state,
            &event(
                contract::APP_VAULT_EVENT_CONFIGURE_SYSTEM_SUCCESS,
                1,
                100,
                11,
            ),
        )
        .unwrap();
        for _ in 0..100 {
            assert!(local_wallet_switch_allowed(&state, true, true));
        }
        assert!(!local_wallet_switch_allowed(&state, true, false));
        assert_eq!(warmup_batch(100, 0), (0, 4));
        assert_eq!(warmup_batch(100, 96), (96, 4));
        assert_eq!(warmup_batch(100, 100), (100, 0));
    }

    #[test]
    fn skipped_protection_is_persisted_authorized_and_never_auto_locks() {
        let mut state = MfwAppVaultStateV1 {
            ready: 1,
            ..Default::default()
        };
        state = apply_event(
            &state,
            &event(contract::APP_VAULT_EVENT_WELCOME_CONTINUE, 0, 100, 10),
        )
        .unwrap();
        state = apply_event(
            &state,
            &event(contract::APP_VAULT_EVENT_SKIP_PROTECTION, 1, 100, 11),
        )
        .unwrap();
        assert_eq!(state.protection_mode, contract::APP_VAULT_PROTECTION_MODE_NONE);
        assert_eq!(state.session_authorized, 1);
        assert_eq!(
            presentation(&state, 100).unwrap(),
            contract::APP_VAULT_PRESENTATION_CONTENT
        );
        assert!(apply_event(
            &state,
            &event(contract::APP_VAULT_EVENT_TIMEOUT, 0, 200, 9_999_999)
        )
        .is_err());
        assert!(apply_event(
            &state,
            &event(contract::APP_VAULT_EVENT_MANUAL_LOCK, 0, 200, 20)
        )
        .is_err());
    }

    #[test]
    fn failures_only_back_off_and_never_change_wallet_or_migration_state() {
        let mut state = MfwAppVaultStateV1 {
            ready: 1,
            onboarding_complete: 1,
            configured: 1,
            protection_mode: contract::APP_VAULT_PROTECTION_MODE_PASSWORD,
            ..Default::default()
        };
        for failure in 1..=10 {
            let migration = state.migration_state;
            state = apply_event(
                &state,
                &event(
                    contract::APP_VAULT_EVENT_UNLOCK_FAILURE,
                    0,
                    1000 + failure,
                    0,
                ),
            )
            .unwrap();
            assert_eq!(state.configured, 1);
            assert_eq!(state.migration_state, migration);
            assert_eq!(state.failed_attempts, failure as u32);
        }
        assert_eq!(unlock_delay_seconds(10), 300);
        assert_eq!(
            presentation(&state, 1000).unwrap(),
            contract::APP_VAULT_PRESENTATION_BACKOFF
        );
    }

    #[test]
    fn monotonic_timeout_and_migration_boundaries_fail_closed() {
        let mut state = MfwAppVaultStateV1 {
            ready: 1,
            onboarding_complete: 1,
            configured: 1,
            protection_mode: contract::APP_VAULT_PROTECTION_MODE_PASSWORD,
            session_authorized: 1,
            last_activity_monotonic_ms: 5_000,
            ..Default::default()
        };
        assert!(apply_event(
            &state,
            &event(contract::APP_VAULT_EVENT_TIMEOUT, 0, 9_999_999, 5_001)
        )
        .is_err());
        state = apply_event(
            &state,
            &event(contract::APP_VAULT_EVENT_TIMEOUT, 0, 1, 1_805_000),
        )
        .unwrap();
        assert_eq!(state.session_authorized, 0);
        for boundary in 1..=contract::APP_VAULT_MIGRATION_CLEANUP_COMPLETE {
            assert!(apply_event(
                &state,
                &event(
                    contract::APP_VAULT_EVENT_MIGRATION_ADVANCE,
                    boundary + 1,
                    0,
                    0
                )
            )
            .is_err());
            state = apply_event(
                &state,
                &event(contract::APP_VAULT_EVENT_MIGRATION_ADVANCE, boundary, 0, 0),
            )
            .unwrap();
            let resumed = state;
            assert_eq!(resumed.migration_state, boundary);
        }
    }

    #[test]
    fn step_up_grant_is_short_exact_and_single_use() {
        let state = MfwAppVaultStateV1 {
            ready: 1,
            onboarding_complete: 1,
            configured: 1,
            protection_mode: contract::APP_VAULT_PROTECTION_MODE_SYSTEM,
            session_authorized: 1,
            ..Default::default()
        };
        let wallet = [7; 16];
        let mut grant = issue_step_up_grant(
            &state,
            contract::APP_VAULT_STEP_UP_SEND_COMMIT,
            wallet,
            1000,
            30_000,
        )
        .unwrap();
        assert!(consume_step_up_grant(
            &mut grant,
            contract::APP_VAULT_STEP_UP_SEED_EXPORT,
            wallet,
            1001
        )
        .is_err());
        assert!(consume_step_up_grant(
            &mut grant,
            contract::APP_VAULT_STEP_UP_SEND_COMMIT,
            [8; 16],
            1001
        )
        .is_err());
        consume_step_up_grant(
            &mut grant,
            contract::APP_VAULT_STEP_UP_SEND_COMMIT,
            wallet,
            1001,
        )
        .unwrap();
        assert!(consume_step_up_grant(
            &mut grant,
            contract::APP_VAULT_STEP_UP_SEND_COMMIT,
            wallet,
            1002
        )
        .is_err());
    }

    #[test]
    fn password_verifier_is_argon2id_versioned_and_constant_shape() {
        let verifier = create_password_verifier("correct horse battery".as_bytes()).unwrap();
        assert_eq!(verifier.kdf_version, 19);
        assert_eq!(verifier.memory_kib, 65_536);
        assert_eq!(verifier.iterations, 3);
        assert_eq!(verifier.parallelism, 1);
        assert!(verify_password("correct horse battery".as_bytes(), &verifier).unwrap());
        assert!(!verify_password("incorrect horse value".as_bytes(), &verifier).unwrap());
        assert!(create_password_verifier("too-short".as_bytes()).is_err());
    }
}
