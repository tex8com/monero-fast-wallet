//! Shared wallet lifecycle and payment-presentation state contracts.
//!
//! This module deliberately does not implement Monero ownership, balances,
//! transaction construction or signing. Those remain authoritative in
//! `wallet2`. It only makes product policy and UI state transitions identical
//! for CLI, React Native and Tauri.

use crate::contract;
use std::mem::size_of;
use std::slice;

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MfwWalletCreationPolicyV1 {
    pub struct_size: u32,
    pub state_version: u32,
    pub preference: u32,
    pub fast_wallet_enabled: u32,
    pub main_wallet_kind: u32,
    pub fast_wallet_kind: u32,
    pub fast_wallet_independent_seed: u32,
    pub reserved: u32,
}

impl Default for MfwWalletCreationPolicyV1 {
    fn default() -> Self {
        Self {
            struct_size: size_of::<Self>() as u32,
            state_version: contract::WALLET_LIFECYCLE_STATE_VERSION,
            preference: contract::WALLET_PREFERENCE_PRIVACY_ONLY,
            fast_wallet_enabled: 0,
            main_wallet_kind: contract::WALLET_KIND_SOFTWARE,
            fast_wallet_kind: contract::WALLET_KIND_FAST,
            fast_wallet_independent_seed: 1,
            reserved: 0,
        }
    }
}

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MfwWalletLifecycleStateV1 {
    pub struct_size: u32,
    pub state_version: u32,
    pub wallet_kind: u32,
    pub lifecycle_state: u32,
    pub seed_backup_confirmed: u32,
    pub selected: u32,
    pub reserved0: u32,
    pub reserved1: u32,
}

impl Default for MfwWalletLifecycleStateV1 {
    fn default() -> Self {
        Self {
            struct_size: size_of::<Self>() as u32,
            state_version: contract::WALLET_LIFECYCLE_STATE_VERSION,
            wallet_kind: contract::WALLET_KIND_UNSPECIFIED,
            lifecycle_state: contract::WALLET_LIFECYCLE_EMPTY,
            seed_backup_confirmed: 0,
            selected: 0,
            reserved0: 0,
            reserved1: 0,
        }
    }
}

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MfwWalletLifecycleEventV1 {
    pub struct_size: u32,
    pub event: u32,
    pub value: u32,
    pub reserved: u32,
}

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MfwWalletRemovalInputV1 {
    pub struct_size: u32,
    pub state_version: u32,
    pub wallet_kind: u32,
    pub balance_state: u32,
    pub seed_backup_confirmed: u32,
    pub fast_worker_enrolled: u32,
    pub notifications_enabled: u32,
    pub reserved: u32,
}

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MfwWalletRemovalPlanV1 {
    pub struct_size: u32,
    pub state_version: u32,
    pub requirement_flags: u32,
    pub immediate_removal_allowed: u32,
}

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MfwSendStateV1 {
    pub struct_size: u32,
    pub state_version: u32,
    pub state: u32,
    pub reserved: u32,
}

impl Default for MfwSendStateV1 {
    fn default() -> Self {
        Self {
            struct_size: size_of::<Self>() as u32,
            state_version: contract::WALLET_LIFECYCLE_STATE_VERSION,
            state: contract::SEND_STATE_EMPTY,
            reserved: 0,
        }
    }
}

fn valid_wallet_kind(kind: u32) -> bool {
    matches!(
        kind,
        contract::WALLET_KIND_SOFTWARE
            | contract::WALLET_KIND_LEDGER_VIEW
            | contract::WALLET_KIND_VIEW_ONLY
            | contract::WALLET_KIND_FAST
    )
}

fn valid_boolean(value: u32) -> bool {
    matches!(value, 0 | 1)
}

fn validate_lifecycle(state: &MfwWalletLifecycleStateV1) -> bool {
    state.struct_size as usize == size_of::<MfwWalletLifecycleStateV1>()
        && state.state_version == contract::WALLET_LIFECYCLE_STATE_VERSION
        && state.reserved0 == 0
        && state.reserved1 == 0
        && valid_boolean(state.seed_backup_confirmed)
        && valid_boolean(state.selected)
        && matches!(
            state.lifecycle_state,
            contract::WALLET_LIFECYCLE_EMPTY
                | contract::WALLET_LIFECYCLE_AWAITING_SEED_BACKUP
                | contract::WALLET_LIFECYCLE_READY
                | contract::WALLET_LIFECYCLE_REMOVAL_PENDING
                | contract::WALLET_LIFECYCLE_REMOVED
        )
        && if state.lifecycle_state == contract::WALLET_LIFECYCLE_EMPTY {
            state.wallet_kind == contract::WALLET_KIND_UNSPECIFIED
        } else {
            valid_wallet_kind(state.wallet_kind)
        }
}

pub fn creation_policy(
    preference: u32,
    fast_override: u32,
) -> Result<MfwWalletCreationPolicyV1, u32> {
    if !matches!(
        preference,
        contract::WALLET_PREFERENCE_PRIVACY_ONLY | contract::WALLET_PREFERENCE_PRIVACY_CONVENIENCE
    ) || !matches!(
        fast_override,
        contract::FAST_WALLET_OVERRIDE_DEFAULT
            | contract::FAST_WALLET_OVERRIDE_DISABLED
            | contract::FAST_WALLET_OVERRIDE_ENABLED
    ) {
        return Err(contract::ERROR_UNKNOWN_ENUM);
    }
    let enabled = match fast_override {
        contract::FAST_WALLET_OVERRIDE_DEFAULT => {
            preference == contract::WALLET_PREFERENCE_PRIVACY_CONVENIENCE
        }
        contract::FAST_WALLET_OVERRIDE_DISABLED => false,
        contract::FAST_WALLET_OVERRIDE_ENABLED => true,
        _ => unreachable!(),
    };
    Ok(MfwWalletCreationPolicyV1 {
        preference,
        fast_wallet_enabled: u32::from(enabled),
        ..MfwWalletCreationPolicyV1::default()
    })
}

pub fn apply_lifecycle_event(
    state: &MfwWalletLifecycleStateV1,
    event: &MfwWalletLifecycleEventV1,
) -> Result<MfwWalletLifecycleStateV1, u32> {
    if !validate_lifecycle(state)
        || event.struct_size as usize != size_of::<MfwWalletLifecycleEventV1>()
        || event.reserved != 0
    {
        return Err(contract::ERROR_INVALID_ARGUMENT);
    }
    let mut next = *state;
    match event.event {
        contract::WALLET_EVENT_BEGIN_CREATE | contract::WALLET_EVENT_BEGIN_RESTORE => {
            if state.lifecycle_state != contract::WALLET_LIFECYCLE_EMPTY
                || !matches!(
                    event.value,
                    contract::WALLET_KIND_SOFTWARE | contract::WALLET_KIND_FAST
                )
            {
                return Err(contract::ERROR_INVALID_ARGUMENT);
            }
            next.wallet_kind = event.value;
            next.lifecycle_state = contract::WALLET_LIFECYCLE_AWAITING_SEED_BACKUP;
            next.seed_backup_confirmed = 0;
        }
        contract::WALLET_EVENT_REGISTER_NON_SEED_WALLET => {
            if state.lifecycle_state != contract::WALLET_LIFECYCLE_EMPTY
                || !matches!(
                    event.value,
                    contract::WALLET_KIND_LEDGER_VIEW | contract::WALLET_KIND_VIEW_ONLY
                )
            {
                return Err(contract::ERROR_INVALID_ARGUMENT);
            }
            next.wallet_kind = event.value;
            next.lifecycle_state = contract::WALLET_LIFECYCLE_READY;
            next.seed_backup_confirmed = 0;
        }
        contract::WALLET_EVENT_CONFIRM_SEED_BACKUP => {
            if state.lifecycle_state != contract::WALLET_LIFECYCLE_AWAITING_SEED_BACKUP
                || event.value != 1
            {
                return Err(contract::ERROR_INVALID_ARGUMENT);
            }
            next.lifecycle_state = contract::WALLET_LIFECYCLE_READY;
            next.seed_backup_confirmed = 1;
        }
        contract::WALLET_EVENT_SELECT => {
            if state.lifecycle_state != contract::WALLET_LIFECYCLE_READY {
                return Err(contract::ERROR_INVALID_ARGUMENT);
            }
            next.selected = 1;
        }
        contract::WALLET_EVENT_DESELECT => next.selected = 0,
        contract::WALLET_EVENT_REQUEST_REMOVE => {
            if state.lifecycle_state != contract::WALLET_LIFECYCLE_READY {
                return Err(contract::ERROR_INVALID_ARGUMENT);
            }
            next.lifecycle_state = contract::WALLET_LIFECYCLE_REMOVAL_PENDING;
            next.selected = 0;
        }
        contract::WALLET_EVENT_CANCEL_REMOVE => {
            if state.lifecycle_state != contract::WALLET_LIFECYCLE_REMOVAL_PENDING {
                return Err(contract::ERROR_INVALID_ARGUMENT);
            }
            next.lifecycle_state = contract::WALLET_LIFECYCLE_READY;
        }
        contract::WALLET_EVENT_CONFIRM_REMOVE => {
            if state.lifecycle_state != contract::WALLET_LIFECYCLE_REMOVAL_PENDING
                || event.value != 1
            {
                return Err(contract::ERROR_INVALID_ARGUMENT);
            }
            next.lifecycle_state = contract::WALLET_LIFECYCLE_REMOVED;
            next.selected = 0;
        }
        _ => return Err(contract::ERROR_UNKNOWN_ENUM),
    }
    Ok(next)
}

pub fn removal_plan(input: &MfwWalletRemovalInputV1) -> Result<MfwWalletRemovalPlanV1, u32> {
    if input.struct_size as usize != size_of::<MfwWalletRemovalInputV1>()
        || input.state_version != contract::WALLET_LIFECYCLE_STATE_VERSION
        || input.reserved != 0
        || !valid_wallet_kind(input.wallet_kind)
        || !matches!(
            input.balance_state,
            contract::WALLET_BALANCE_UNKNOWN
                | contract::WALLET_BALANCE_KNOWN_ZERO
                | contract::WALLET_BALANCE_KNOWN_POSITIVE
        )
        || !valid_boolean(input.seed_backup_confirmed)
        || !valid_boolean(input.fast_worker_enrolled)
        || !valid_boolean(input.notifications_enabled)
    {
        return Err(contract::ERROR_INVALID_ARGUMENT);
    }
    let mut flags = 0;
    if matches!(
        input.wallet_kind,
        contract::WALLET_KIND_SOFTWARE | contract::WALLET_KIND_FAST
    ) && input.seed_backup_confirmed == 0
    {
        flags |= contract::WALLET_REMOVAL_REQUIREMENT_BACKUP_SEED;
    }
    match input.balance_state {
        contract::WALLET_BALANCE_UNKNOWN => {
            flags |= contract::WALLET_REMOVAL_REQUIREMENT_ACKNOWLEDGE_UNKNOWN_BALANCE
        }
        contract::WALLET_BALANCE_KNOWN_POSITIVE => {
            flags |= contract::WALLET_REMOVAL_REQUIREMENT_ACKNOWLEDGE_POSITIVE_BALANCE
        }
        _ => {}
    }
    if input.fast_worker_enrolled == 1 {
        flags |= contract::WALLET_REMOVAL_REQUIREMENT_DETACH_FAST_WORKER;
    }
    if input.notifications_enabled == 1 {
        flags |= contract::WALLET_REMOVAL_REQUIREMENT_DISABLE_NOTIFICATIONS;
    }
    Ok(MfwWalletRemovalPlanV1 {
        struct_size: size_of::<MfwWalletRemovalPlanV1>() as u32,
        state_version: contract::WALLET_LIFECYCLE_STATE_VERSION,
        requirement_flags: flags,
        immediate_removal_allowed: u32::from(flags == 0),
    })
}

pub fn checked_total_balance(accounts: &[u64]) -> Result<u64, u32> {
    accounts.iter().try_fold(0_u64, |total, value| {
        total
            .checked_add(*value)
            .ok_or(contract::ERROR_INVALID_ARGUMENT)
    })
}

pub fn restore_floor(estimated_height: u64, safety_blocks: u64) -> Result<u64, u32> {
    if safety_blocks > contract::WALLET_RESTORE_MAXIMUM_SAFETY_BLOCKS {
        return Err(contract::ERROR_INVALID_ARGUMENT);
    }
    Ok(estimated_height.saturating_sub(safety_blocks))
}

pub fn apply_send_event(state: &MfwSendStateV1, event: u32) -> Result<MfwSendStateV1, u32> {
    if state.struct_size as usize != size_of::<MfwSendStateV1>()
        || state.state_version != contract::WALLET_LIFECYCLE_STATE_VERSION
        || state.reserved != 0
    {
        return Err(contract::ERROR_INVALID_ARGUMENT);
    }
    let next_state = match (state.state, event) {
        (contract::SEND_STATE_EMPTY, contract::SEND_EVENT_VALIDATE_RECIPIENT) => {
            contract::SEND_STATE_RECIPIENT_VALIDATED
        }
        (contract::SEND_STATE_RECIPIENT_VALIDATED, contract::SEND_EVENT_PREPARE) => {
            contract::SEND_STATE_PREPARED
        }
        (contract::SEND_STATE_PREPARED, contract::SEND_EVENT_REVIEW) => {
            contract::SEND_STATE_REVIEWED
        }
        (contract::SEND_STATE_REVIEWED, contract::SEND_EVENT_AUTHORIZE) => {
            contract::SEND_STATE_AUTHORIZED
        }
        (contract::SEND_STATE_AUTHORIZED, contract::SEND_EVENT_SUBMIT) => {
            contract::SEND_STATE_SUBMITTED
        }
        (current, contract::SEND_EVENT_CANCEL)
            if !matches!(
                current,
                contract::SEND_STATE_SUBMITTED | contract::SEND_STATE_CANCELLED
            ) =>
        {
            contract::SEND_STATE_CANCELLED
        }
        _ => return Err(contract::ERROR_INVALID_ARGUMENT),
    };
    Ok(MfwSendStateV1 {
        state: next_state,
        ..*state
    })
}

#[no_mangle]
/// Resolves the product preference and per-wallet Fast Wallet override.
///
/// # Safety
/// `output` must point to writable storage for one creation-policy value.
pub unsafe extern "C" fn mfw_wallet_creation_policy_resolve_v1(
    preference: u32,
    fast_override: u32,
    output: *mut MfwWalletCreationPolicyV1,
) -> u32 {
    if output.is_null() {
        return contract::ERROR_INVALID_ARGUMENT;
    }
    match creation_policy(preference, fast_override) {
        Ok(policy) => {
            *output = policy;
            contract::ERROR_OK
        }
        Err(error) => error,
    }
}

#[no_mangle]
/// Creates the empty lifecycle state.
///
/// # Safety
/// `output` must point to writable storage for one lifecycle-state value.
pub unsafe extern "C" fn mfw_wallet_lifecycle_default_v1(
    output: *mut MfwWalletLifecycleStateV1,
) -> u32 {
    if output.is_null() {
        return contract::ERROR_INVALID_ARGUMENT;
    }
    *output = MfwWalletLifecycleStateV1::default();
    contract::ERROR_OK
}

#[no_mangle]
/// Applies one validated wallet-lifecycle transition.
///
/// # Safety
/// `state` and `event` must be readable V1 values and `output` must be writable.
pub unsafe extern "C" fn mfw_wallet_lifecycle_apply_event_v1(
    state: *const MfwWalletLifecycleStateV1,
    event: *const MfwWalletLifecycleEventV1,
    output: *mut MfwWalletLifecycleStateV1,
) -> u32 {
    if state.is_null() || event.is_null() || output.is_null() {
        return contract::ERROR_INVALID_ARGUMENT;
    }
    match apply_lifecycle_event(&*state, &*event) {
        Ok(next) => {
            *output = next;
            contract::ERROR_OK
        }
        Err(error) => error,
    }
}

#[no_mangle]
/// Computes explicit prerequisites before a local wallet may be removed.
///
/// # Safety
/// `input` must be a readable V1 value and `output` must be writable.
pub unsafe extern "C" fn mfw_wallet_removal_plan_compute_v1(
    input: *const MfwWalletRemovalInputV1,
    output: *mut MfwWalletRemovalPlanV1,
) -> u32 {
    if input.is_null() || output.is_null() {
        return contract::ERROR_INVALID_ARGUMENT;
    }
    match removal_plan(&*input) {
        Ok(plan) => {
            *output = plan;
            contract::ERROR_OK
        }
        Err(error) => error,
    }
}

#[no_mangle]
/// Adds every Monero account balance using checked integer arithmetic.
///
/// # Safety
/// For a nonzero count, `account_balances` must reference that many readable
/// `u64` values. `output_total` must be writable.
pub unsafe extern "C" fn mfw_wallet_checked_total_balance_v1(
    account_balances: *const u64,
    account_count: usize,
    output_total: *mut u64,
) -> u32 {
    if output_total.is_null() || (account_count > 0 && account_balances.is_null()) {
        return contract::ERROR_INVALID_ARGUMENT;
    }
    let accounts = if account_count == 0 {
        &[]
    } else {
        slice::from_raw_parts(account_balances, account_count)
    };
    match checked_total_balance(accounts) {
        Ok(total) => {
            *output_total = total;
            contract::ERROR_OK
        }
        Err(error) => error,
    }
}

#[no_mangle]
/// Applies the conservative restore-height safety margin.
///
/// # Safety
/// `output_height` must point to writable storage for one `u64`.
pub unsafe extern "C" fn mfw_wallet_restore_floor_v1(
    estimated_height: u64,
    safety_blocks: u64,
    output_height: *mut u64,
) -> u32 {
    if output_height.is_null() {
        return contract::ERROR_INVALID_ARGUMENT;
    }
    match restore_floor(estimated_height, safety_blocks) {
        Ok(height) => {
            *output_height = height;
            contract::ERROR_OK
        }
        Err(error) => error,
    }
}

#[no_mangle]
/// Creates the initial send-review state.
///
/// # Safety
/// `output` must point to writable storage for one send-state value.
pub unsafe extern "C" fn mfw_send_state_default_v1(output: *mut MfwSendStateV1) -> u32 {
    if output.is_null() {
        return contract::ERROR_INVALID_ARGUMENT;
    }
    *output = MfwSendStateV1::default();
    contract::ERROR_OK
}

#[no_mangle]
/// Applies one strict send-review transition.
///
/// # Safety
/// `state` must be a readable V1 value and `output` must be writable.
pub unsafe extern "C" fn mfw_send_apply_event_v1(
    state: *const MfwSendStateV1,
    event: u32,
    output: *mut MfwSendStateV1,
) -> u32 {
    if state.is_null() || output.is_null() {
        return contract::ERROR_INVALID_ARGUMENT;
    }
    match apply_send_event(&*state, event) {
        Ok(next) => {
            *output = next;
            contract::ERROR_OK
        }
        Err(error) => error,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lifecycle_event(event: u32, value: u32) -> MfwWalletLifecycleEventV1 {
        MfwWalletLifecycleEventV1 {
            struct_size: size_of::<MfwWalletLifecycleEventV1>() as u32,
            event,
            value,
            reserved: 0,
        }
    }

    #[test]
    fn preference_default_and_override_are_explicit() {
        let private = creation_policy(
            contract::WALLET_PREFERENCE_PRIVACY_ONLY,
            contract::FAST_WALLET_OVERRIDE_DEFAULT,
        )
        .unwrap();
        assert_eq!(private.fast_wallet_enabled, 0);
        let convenience = creation_policy(
            contract::WALLET_PREFERENCE_PRIVACY_CONVENIENCE,
            contract::FAST_WALLET_OVERRIDE_DEFAULT,
        )
        .unwrap();
        assert_eq!(convenience.fast_wallet_enabled, 1);
        assert_eq!(convenience.fast_wallet_independent_seed, 1);
        assert_eq!(
            creation_policy(
                contract::WALLET_PREFERENCE_PRIVACY_CONVENIENCE,
                contract::FAST_WALLET_OVERRIDE_DISABLED,
            )
            .unwrap()
            .fast_wallet_enabled,
            0
        );
    }

    #[test]
    fn seed_wallet_cannot_be_ready_or_selected_before_backup() {
        let empty = MfwWalletLifecycleStateV1::default();
        let created = apply_lifecycle_event(
            &empty,
            &lifecycle_event(
                contract::WALLET_EVENT_BEGIN_CREATE,
                contract::WALLET_KIND_SOFTWARE,
            ),
        )
        .unwrap();
        assert_eq!(
            created.lifecycle_state,
            contract::WALLET_LIFECYCLE_AWAITING_SEED_BACKUP
        );
        assert!(apply_lifecycle_event(
            &created,
            &lifecycle_event(contract::WALLET_EVENT_SELECT, 0)
        )
        .is_err());
        let backed_up = apply_lifecycle_event(
            &created,
            &lifecycle_event(contract::WALLET_EVENT_CONFIRM_SEED_BACKUP, 1),
        )
        .unwrap();
        assert_eq!(backed_up.lifecycle_state, contract::WALLET_LIFECYCLE_READY);
        assert_eq!(backed_up.seed_backup_confirmed, 1);
    }

    #[test]
    fn ledger_registers_without_claiming_a_local_seed() {
        let registered = apply_lifecycle_event(
            &MfwWalletLifecycleStateV1::default(),
            &lifecycle_event(
                contract::WALLET_EVENT_REGISTER_NON_SEED_WALLET,
                contract::WALLET_KIND_LEDGER_VIEW,
            ),
        )
        .unwrap();
        assert_eq!(registered.lifecycle_state, contract::WALLET_LIFECYCLE_READY);
        assert_eq!(registered.seed_backup_confirmed, 0);
    }

    #[test]
    fn removal_plan_exposes_every_required_action_without_dead_end() {
        let plan = removal_plan(&MfwWalletRemovalInputV1 {
            struct_size: size_of::<MfwWalletRemovalInputV1>() as u32,
            state_version: contract::WALLET_LIFECYCLE_STATE_VERSION,
            wallet_kind: contract::WALLET_KIND_FAST,
            balance_state: contract::WALLET_BALANCE_UNKNOWN,
            seed_backup_confirmed: 0,
            fast_worker_enrolled: 1,
            notifications_enabled: 1,
            reserved: 0,
        })
        .unwrap();
        assert_eq!(plan.immediate_removal_allowed, 0);
        assert_ne!(
            plan.requirement_flags & contract::WALLET_REMOVAL_REQUIREMENT_BACKUP_SEED,
            0
        );
        assert_ne!(
            plan.requirement_flags
                & contract::WALLET_REMOVAL_REQUIREMENT_ACKNOWLEDGE_UNKNOWN_BALANCE,
            0
        );
        assert_ne!(
            plan.requirement_flags & contract::WALLET_REMOVAL_REQUIREMENT_DETACH_FAST_WORKER,
            0
        );
        assert_ne!(
            plan.requirement_flags & contract::WALLET_REMOVAL_REQUIREMENT_DISABLE_NOTIFICATIONS,
            0
        );
    }

    #[test]
    fn total_balance_includes_every_account_and_detects_overflow() {
        assert_eq!(checked_total_balance(&[10, 20, 30]).unwrap(), 60);
        assert!(checked_total_balance(&[u64::MAX, 1]).is_err());
    }

    #[test]
    fn restore_floor_is_conservative_and_bounded() {
        assert_eq!(restore_floor(1_000, 100).unwrap(), 900);
        assert_eq!(restore_floor(50, 100).unwrap(), 0);
        assert!(restore_floor(1_000, 100_001).is_err());
    }

    #[test]
    fn send_state_requires_every_security_boundary_in_order() {
        let mut state = MfwSendStateV1::default();
        for (event, expected) in [
            (
                contract::SEND_EVENT_VALIDATE_RECIPIENT,
                contract::SEND_STATE_RECIPIENT_VALIDATED,
            ),
            (contract::SEND_EVENT_PREPARE, contract::SEND_STATE_PREPARED),
            (contract::SEND_EVENT_REVIEW, contract::SEND_STATE_REVIEWED),
            (
                contract::SEND_EVENT_AUTHORIZE,
                contract::SEND_STATE_AUTHORIZED,
            ),
            (contract::SEND_EVENT_SUBMIT, contract::SEND_STATE_SUBMITTED),
        ] {
            state = apply_send_event(&state, event).unwrap();
            assert_eq!(state.state, expected);
        }
        assert!(apply_send_event(&MfwSendStateV1::default(), contract::SEND_EVENT_SUBMIT).is_err());
        assert!(apply_send_event(&state, contract::SEND_EVENT_CANCEL).is_err());
    }
}
