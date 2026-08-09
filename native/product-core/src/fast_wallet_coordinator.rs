//! Shared Fast Wallet operation planner.
//!
//! This is deliberately a *pure* control-plane contract.  It never receives a
//! seed, private/view key, address, account data, worker token or network
//! handle.  The platform adapters execute an approved plan through their own
//! secure storage and transport implementations.  Keeping the decision here
//! makes the CLI, React Native and Tauri follow the same safety gates without
//! making Product Core a second wallet implementation.

use crate::contract;
use crate::wallet_lifecycle::{removal_plan, MfwWalletRemovalInputV1};
use std::mem::size_of;

pub const OPERATION_CREATE: u32 = 1;
pub const OPERATION_RESTORE: u32 = 2;
pub const OPERATION_CONFIRM_SEED_BACKUP: u32 = 3;
pub const OPERATION_SELECT: u32 = 4;
pub const OPERATION_RECEIVE: u32 = 5;
pub const OPERATION_SEND: u32 = 6;
pub const OPERATION_ENROLL_WORKER: u32 = 7;
pub const OPERATION_RENEW_WORKER: u32 = 8;
pub const OPERATION_REVOKE_WORKER: u32 = 9;
pub const OPERATION_REMOVE: u32 = 10;
/// Pairing verifies and pins a public Worker identity locally. It neither
/// uploads a watch nor discloses a private view key.
pub const OPERATION_PAIR_WORKER: u32 = 11;

/// The adapter must generate a fresh, Fast-Wallet-specific seed.  It must not
/// derive the Fast Wallet from, or reuse, a main wallet seed.
pub const REQUIREMENT_INDEPENDENT_SEED: u32 = 1 << 24;
/// A local seed wallet stays non-operational until backup confirmation.
pub const REQUIREMENT_CONFIRM_SEED_BACKUP: u32 = 1 << 25;

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MfwFastWalletCoordinatorInputV1 {
    pub struct_size: u32,
    pub state_version: u32,
    pub operation: u32,
    pub lifecycle_state: u32,
    pub seed_backup_confirmed: u32,
    pub worker_enrolled: u32,
    pub notifications_enabled: u32,
    pub balance_state: u32,
    pub reserved: u32,
}

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MfwFastWalletCoordinatorPlanV1 {
    pub struct_size: u32,
    pub state_version: u32,
    /// The requested operation is meaningful in the current state.
    pub operation_allowed: u32,
    /// All required prerequisites are currently met, so an adapter may commit.
    pub execution_allowed: u32,
    /// Product-Core requirement flags.  Removal flags retain their existing
    /// `MFW_WALLET_REMOVAL_REQUIREMENT_*` values; Fast-only flags use bits 24+
    /// to avoid collisions.
    pub requirement_flags: u32,
    pub result_lifecycle_state: u32,
    pub reserved: u32,
}

impl Default for MfwFastWalletCoordinatorPlanV1 {
    fn default() -> Self {
        Self {
            struct_size: size_of::<Self>() as u32,
            state_version: contract::WALLET_LIFECYCLE_STATE_VERSION,
            operation_allowed: 0,
            execution_allowed: 0,
            requirement_flags: 0,
            result_lifecycle_state: contract::WALLET_LIFECYCLE_EMPTY,
            reserved: 0,
        }
    }
}

fn valid_boolean(value: u32) -> bool {
    matches!(value, 0 | 1)
}

fn valid_lifecycle(value: u32) -> bool {
    matches!(
        value,
        contract::WALLET_LIFECYCLE_EMPTY
            | contract::WALLET_LIFECYCLE_AWAITING_SEED_BACKUP
            | contract::WALLET_LIFECYCLE_READY
            | contract::WALLET_LIFECYCLE_REMOVAL_PENDING
            | contract::WALLET_LIFECYCLE_REMOVED
    )
}

fn valid_balance(value: u32) -> bool {
    matches!(
        value,
        contract::WALLET_BALANCE_UNKNOWN
            | contract::WALLET_BALANCE_KNOWN_ZERO
            | contract::WALLET_BALANCE_KNOWN_POSITIVE
    )
}

fn validate(input: &MfwFastWalletCoordinatorInputV1) -> Result<(), u32> {
    if input.struct_size as usize != size_of::<MfwFastWalletCoordinatorInputV1>()
        || input.state_version != contract::WALLET_LIFECYCLE_STATE_VERSION
        || input.reserved != 0
        || !valid_boolean(input.seed_backup_confirmed)
        || !valid_boolean(input.worker_enrolled)
        || !valid_boolean(input.notifications_enabled)
        || !valid_lifecycle(input.lifecycle_state)
        || !valid_balance(input.balance_state)
    {
        return Err(contract::ERROR_INVALID_ARGUMENT);
    }
    Ok(())
}

fn base_plan(input: &MfwFastWalletCoordinatorInputV1) -> MfwFastWalletCoordinatorPlanV1 {
    MfwFastWalletCoordinatorPlanV1 {
        result_lifecycle_state: input.lifecycle_state,
        ..MfwFastWalletCoordinatorPlanV1::default()
    }
}

/// Produces the policy decision for one Fast Wallet lifecycle operation.
///
/// `operation_allowed` distinguishes an invalid state transition from a valid
/// action that still has stated prerequisites.  `execution_allowed` becomes
/// true only when the adapter may perform the irreversible side effect.
pub fn operation_plan(
    input: &MfwFastWalletCoordinatorInputV1,
) -> Result<MfwFastWalletCoordinatorPlanV1, u32> {
    validate(input)?;
    let mut plan = base_plan(input);
    match input.operation {
        OPERATION_CREATE | OPERATION_RESTORE => {
            if input.lifecycle_state != contract::WALLET_LIFECYCLE_EMPTY {
                return Err(contract::ERROR_INVALID_ARGUMENT);
            }
            plan.operation_allowed = 1;
            plan.execution_allowed = 1;
            plan.requirement_flags = REQUIREMENT_INDEPENDENT_SEED | REQUIREMENT_CONFIRM_SEED_BACKUP;
            plan.result_lifecycle_state = contract::WALLET_LIFECYCLE_AWAITING_SEED_BACKUP;
        }
        OPERATION_CONFIRM_SEED_BACKUP => {
            if input.lifecycle_state != contract::WALLET_LIFECYCLE_AWAITING_SEED_BACKUP
                || input.seed_backup_confirmed != 0
            {
                return Err(contract::ERROR_INVALID_ARGUMENT);
            }
            plan.operation_allowed = 1;
            plan.execution_allowed = 1;
            plan.result_lifecycle_state = contract::WALLET_LIFECYCLE_READY;
        }
        OPERATION_SELECT | OPERATION_RECEIVE | OPERATION_SEND => {
            if !matches!(
                input.lifecycle_state,
                contract::WALLET_LIFECYCLE_AWAITING_SEED_BACKUP | contract::WALLET_LIFECYCLE_READY
            ) {
                return Err(contract::ERROR_INVALID_ARGUMENT);
            }
            plan.operation_allowed = 1;
            if input.lifecycle_state == contract::WALLET_LIFECYCLE_READY
                && input.seed_backup_confirmed == 1
            {
                plan.execution_allowed = 1;
            } else {
                plan.requirement_flags = REQUIREMENT_CONFIRM_SEED_BACKUP;
            }
        }
        OPERATION_PAIR_WORKER | OPERATION_ENROLL_WORKER => {
            if input.lifecycle_state != contract::WALLET_LIFECYCLE_READY
                || input.seed_backup_confirmed != 1
            {
                return Err(contract::ERROR_INVALID_ARGUMENT);
            }
            plan.operation_allowed = 1;
            plan.execution_allowed = 1;
        }
        OPERATION_RENEW_WORKER | OPERATION_REVOKE_WORKER => {
            if !matches!(
                input.lifecycle_state,
                contract::WALLET_LIFECYCLE_READY | contract::WALLET_LIFECYCLE_REMOVAL_PENDING
            ) || input.worker_enrolled != 1
            {
                return Err(contract::ERROR_INVALID_ARGUMENT);
            }
            plan.operation_allowed = 1;
            plan.execution_allowed = 1;
        }
        OPERATION_REMOVE => {
            if !matches!(
                input.lifecycle_state,
                contract::WALLET_LIFECYCLE_READY | contract::WALLET_LIFECYCLE_REMOVAL_PENDING
            ) {
                return Err(contract::ERROR_INVALID_ARGUMENT);
            }
            let removal = removal_plan(&MfwWalletRemovalInputV1 {
                struct_size: size_of::<MfwWalletRemovalInputV1>() as u32,
                state_version: contract::WALLET_LIFECYCLE_STATE_VERSION,
                wallet_kind: contract::WALLET_KIND_FAST,
                balance_state: input.balance_state,
                seed_backup_confirmed: input.seed_backup_confirmed,
                fast_worker_enrolled: input.worker_enrolled,
                notifications_enabled: input.notifications_enabled,
                reserved: 0,
            })?;
            plan.operation_allowed = 1;
            plan.execution_allowed = removal.immediate_removal_allowed;
            plan.requirement_flags = removal.requirement_flags;
            plan.result_lifecycle_state = if removal.immediate_removal_allowed == 1 {
                contract::WALLET_LIFECYCLE_REMOVED
            } else {
                contract::WALLET_LIFECYCLE_REMOVAL_PENDING
            };
        }
        _ => return Err(contract::ERROR_UNKNOWN_ENUM),
    }
    Ok(plan)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(operation: u32) -> MfwFastWalletCoordinatorInputV1 {
        MfwFastWalletCoordinatorInputV1 {
            struct_size: size_of::<MfwFastWalletCoordinatorInputV1>() as u32,
            state_version: contract::WALLET_LIFECYCLE_STATE_VERSION,
            operation,
            lifecycle_state: contract::WALLET_LIFECYCLE_EMPTY,
            seed_backup_confirmed: 0,
            worker_enrolled: 0,
            notifications_enabled: 0,
            balance_state: contract::WALLET_BALANCE_KNOWN_ZERO,
            reserved: 0,
        }
    }

    #[test]
    fn create_requires_an_independent_seed_and_backup_gate() {
        let plan = operation_plan(&input(OPERATION_CREATE)).unwrap();
        assert_eq!(plan.operation_allowed, 1);
        assert_eq!(plan.execution_allowed, 1);
        assert_eq!(
            plan.requirement_flags,
            REQUIREMENT_INDEPENDENT_SEED | REQUIREMENT_CONFIRM_SEED_BACKUP
        );
        assert_eq!(
            plan.result_lifecycle_state,
            contract::WALLET_LIFECYCLE_AWAITING_SEED_BACKUP
        );
    }

    #[test]
    fn unbacked_fast_wallet_cannot_be_selected_or_used() {
        let mut unbacked = input(OPERATION_SELECT);
        unbacked.lifecycle_state = contract::WALLET_LIFECYCLE_AWAITING_SEED_BACKUP;
        let plan = operation_plan(&unbacked).unwrap();
        assert_eq!(plan.operation_allowed, 1);
        assert_eq!(plan.execution_allowed, 0);
        assert_eq!(plan.requirement_flags, REQUIREMENT_CONFIRM_SEED_BACKUP);
    }

    #[test]
    fn removal_requires_worker_and_notification_detach() {
        let mut remove = input(OPERATION_REMOVE);
        remove.lifecycle_state = contract::WALLET_LIFECYCLE_READY;
        remove.seed_backup_confirmed = 1;
        remove.worker_enrolled = 1;
        remove.notifications_enabled = 1;
        let plan = operation_plan(&remove).unwrap();
        assert_eq!(plan.execution_allowed, 0);
        assert_eq!(
            plan.requirement_flags,
            contract::WALLET_REMOVAL_REQUIREMENT_DETACH_FAST_WORKER
                | contract::WALLET_REMOVAL_REQUIREMENT_DISABLE_NOTIFICATIONS
        );
        assert_eq!(
            plan.result_lifecycle_state,
            contract::WALLET_LIFECYCLE_REMOVAL_PENDING
        );
    }

    #[test]
    fn worker_pairing_requires_a_ready_backed_up_fast_wallet() {
        let mut pairing = input(OPERATION_PAIR_WORKER);
        pairing.lifecycle_state = contract::WALLET_LIFECYCLE_READY;
        pairing.seed_backup_confirmed = 1;
        let plan = operation_plan(&pairing).unwrap();
        assert_eq!(plan.operation_allowed, 1);
        assert_eq!(plan.execution_allowed, 1);

        pairing.seed_backup_confirmed = 0;
        assert_eq!(
            operation_plan(&pairing),
            Err(contract::ERROR_INVALID_ARGUMENT)
        );
    }
}
