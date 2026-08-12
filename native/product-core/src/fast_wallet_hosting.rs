//! Shared Fast Wallet hosted-watch state machine.
//!
//! This module owns the crash-safe ordering of a hosted receive watch without
//! knowing any wallet secret or network payload.  Adapters keep the assignment
//! handle, installation capability, descriptor and HPKE envelope in their
//! secure stores and execute only the next action this module returns.
//!
//! A restart is safe: an adapter durably commits the returned stage only after
//! the corresponding action succeeded, then calls this planner again.  It
//! must never mark a Worker as enrolled before a descriptor-bound Worker
//! receipt proves durable acceptance of the sealed envelope.

use crate::contract;
use std::mem::size_of;

pub const OPERATION_ENROLL: u32 = 1;
pub const OPERATION_REVOKE: u32 = 2;

pub const STAGE_NONE: u32 = 0;
pub const STAGE_PENDING_LOCAL: u32 = 1;
pub const STAGE_INSTALLATION_REGISTERED: u32 = 2;
pub const STAGE_ASSIGNMENT_ACCEPTED: u32 = 3;
pub const STAGE_DELIVERY_ENABLED: u32 = 4;
pub const STAGE_WATCH_SEALED: u32 = 5;
pub const STAGE_RELAY_ACCEPTED: u32 = 6;
pub const STAGE_ACTIVE: u32 = 7;
pub const STAGE_REVOCATION_REMOTE_DELETED: u32 = 8;
pub const STAGE_WORKER_CONFIRMED: u32 = 9;

pub const REQUIREMENT_INSTALLATION_AUTHORIZED: u32 = 1 << 26;
pub const REQUIREMENT_TRUSTED_WORKER_DESCRIPTOR: u32 = 1 << 27;
pub const REQUIREMENT_ACTIVE_ASSIGNMENT: u32 = 1 << 28;

pub const ACTION_PERSIST_PENDING: u32 = 1 << 0;
pub const ACTION_REGISTER_INSTALLATION: u32 = 1 << 1;
pub const ACTION_SPONSOR_ASSIGNMENT: u32 = 1 << 2;
pub const ACTION_ENABLE_DELIVERY: u32 = 1 << 3;
pub const ACTION_SEAL_WATCH: u32 = 1 << 4;
pub const ACTION_SUBMIT_WATCH: u32 = 1 << 5;
pub const ACTION_COMMIT_ACTIVE: u32 = 1 << 6;
pub const ACTION_DELETE_ASSIGNMENT: u32 = 1 << 7;
pub const ACTION_CLEAR_LOCAL_ASSIGNMENT: u32 = 1 << 8;
pub const ACTION_VERIFY_WORKER_RECEIPT: u32 = 1 << 9;

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MfwFastWalletHostingInputV1 {
    pub struct_size: u32,
    pub state_version: u32,
    pub operation: u32,
    pub lifecycle_state: u32,
    pub seed_backup_confirmed: u32,
    /// The adapter has a registered installation plus an authenticated,
    /// protected installation capability.  The capability itself is never an
    /// input to Product Core.
    pub installation_authorized: u32,
    /// A fresh signed descriptor was checked for network, signature, expiry,
    /// and equality with the immutable locally pinned Worker root.  Neither
    /// the descriptor nor the root is carried through this ABI.
    pub trusted_worker_descriptor: u32,
    pub enrollment_stage: u32,
    pub reserved: u32,
}

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MfwFastWalletHostingPlanV1 {
    pub struct_size: u32,
    pub state_version: u32,
    pub operation_allowed: u32,
    pub execution_allowed: u32,
    pub requirement_flags: u32,
    /// Exactly one durable or remote action may be performed. A caller commits
    /// `result_enrollment_stage` only after that action succeeds.
    pub next_action: u32,
    pub result_enrollment_stage: u32,
    /// This becomes one only after the Worker's signed durable-acceptance
    /// receipt was verified and committed locally.
    pub worker_enrolled: u32,
    pub reserved: u32,
}

impl Default for MfwFastWalletHostingPlanV1 {
    fn default() -> Self {
        Self {
            struct_size: size_of::<Self>() as u32,
            state_version: contract::WALLET_LIFECYCLE_STATE_VERSION,
            operation_allowed: 0,
            execution_allowed: 0,
            requirement_flags: 0,
            next_action: 0,
            result_enrollment_stage: STAGE_NONE,
            worker_enrolled: 0,
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
        contract::WALLET_LIFECYCLE_READY | contract::WALLET_LIFECYCLE_REMOVAL_PENDING
    )
}

fn valid_stage(value: u32) -> bool {
    matches!(
        value,
        STAGE_NONE
            | STAGE_PENDING_LOCAL
            | STAGE_INSTALLATION_REGISTERED
            | STAGE_ASSIGNMENT_ACCEPTED
            | STAGE_DELIVERY_ENABLED
            | STAGE_WATCH_SEALED
            | STAGE_RELAY_ACCEPTED
            | STAGE_ACTIVE
            | STAGE_REVOCATION_REMOTE_DELETED
            | STAGE_WORKER_CONFIRMED
    )
}

fn validate(input: &MfwFastWalletHostingInputV1) -> Result<(), u32> {
    if input.struct_size as usize != size_of::<MfwFastWalletHostingInputV1>()
        || input.state_version != contract::WALLET_LIFECYCLE_STATE_VERSION
        || input.reserved != 0
        || !valid_boolean(input.seed_backup_confirmed)
        || !valid_boolean(input.installation_authorized)
        || !valid_boolean(input.trusted_worker_descriptor)
        || !valid_lifecycle(input.lifecycle_state)
        || !valid_stage(input.enrollment_stage)
    {
        return Err(contract::ERROR_INVALID_ARGUMENT);
    }
    Ok(())
}

fn ready_backed_up(input: &MfwFastWalletHostingInputV1) -> bool {
    input.lifecycle_state == contract::WALLET_LIFECYCLE_READY && input.seed_backup_confirmed == 1
}

fn enrollment_requirements(input: &MfwFastWalletHostingInputV1) -> u32 {
    let mut flags = 0;
    if input.installation_authorized == 0 {
        flags |= REQUIREMENT_INSTALLATION_AUTHORIZED;
    }
    if input.trusted_worker_descriptor == 0 {
        flags |= REQUIREMENT_TRUSTED_WORKER_DESCRIPTOR;
    }
    flags
}

/// Plans exactly one next hosted-watch action.  This performs no I/O and
/// receives no secret.  `STAGE_PENDING_LOCAL` means the adapter has generated
/// and protected a fresh assignment handle but has not registered its desktop
/// notification installation. `STAGE_ACTIVE` is only valid after a successful
/// Relay submission, a verified descriptor-bound Worker receipt and a durable
/// local commit.
pub fn operation_plan(
    input: &MfwFastWalletHostingInputV1,
) -> Result<MfwFastWalletHostingPlanV1, u32> {
    validate(input)?;
    let mut plan = MfwFastWalletHostingPlanV1 {
        result_enrollment_stage: input.enrollment_stage,
        worker_enrolled: u32::from(input.enrollment_stage == STAGE_ACTIVE),
        ..MfwFastWalletHostingPlanV1::default()
    };

    match input.operation {
        OPERATION_ENROLL => {
            if !ready_backed_up(input) {
                return Err(contract::ERROR_INVALID_ARGUMENT);
            }
            plan.operation_allowed = 1;
            // The first durable step creates the fresh installation
            // capability together with the pending assignment record. It
            // cannot be required before that record exists; every following
            // step requires that protected capability to be present.
            plan.requirement_flags = if input.enrollment_stage == STAGE_NONE {
                if input.trusted_worker_descriptor == 0 {
                    REQUIREMENT_TRUSTED_WORKER_DESCRIPTOR
                } else {
                    0
                }
            } else {
                enrollment_requirements(input)
            };
            if plan.requirement_flags != 0 {
                return Ok(plan);
            }
            plan.execution_allowed = 1;
            match input.enrollment_stage {
                STAGE_NONE => {
                    plan.next_action = ACTION_PERSIST_PENDING;
                    plan.result_enrollment_stage = STAGE_PENDING_LOCAL;
                }
                STAGE_PENDING_LOCAL => {
                    plan.next_action = ACTION_REGISTER_INSTALLATION;
                    plan.result_enrollment_stage = STAGE_INSTALLATION_REGISTERED;
                }
                STAGE_INSTALLATION_REGISTERED => {
                    plan.next_action = ACTION_SPONSOR_ASSIGNMENT;
                    plan.result_enrollment_stage = STAGE_ASSIGNMENT_ACCEPTED;
                }
                STAGE_ASSIGNMENT_ACCEPTED => {
                    plan.next_action = ACTION_ENABLE_DELIVERY;
                    plan.result_enrollment_stage = STAGE_DELIVERY_ENABLED;
                }
                STAGE_DELIVERY_ENABLED => {
                    plan.next_action = ACTION_SEAL_WATCH;
                    plan.result_enrollment_stage = STAGE_WATCH_SEALED;
                }
                STAGE_WATCH_SEALED => {
                    plan.next_action = ACTION_SUBMIT_WATCH;
                    plan.result_enrollment_stage = STAGE_RELAY_ACCEPTED;
                }
                STAGE_RELAY_ACCEPTED => {
                    plan.next_action = ACTION_VERIFY_WORKER_RECEIPT;
                    plan.result_enrollment_stage = STAGE_WORKER_CONFIRMED;
                }
                STAGE_WORKER_CONFIRMED => {
                    plan.next_action = ACTION_COMMIT_ACTIVE;
                    plan.result_enrollment_stage = STAGE_ACTIVE;
                    plan.worker_enrolled = 1;
                }
                STAGE_ACTIVE => {}
                _ => unreachable!(),
            }
            Ok(plan)
        }
        OPERATION_REVOKE => {
            if !matches!(
                input.lifecycle_state,
                contract::WALLET_LIFECYCLE_READY | contract::WALLET_LIFECYCLE_REMOVAL_PENDING
            ) || input.seed_backup_confirmed != 1
            {
                return Err(contract::ERROR_INVALID_ARGUMENT);
            }
            plan.operation_allowed = 1;
            match input.enrollment_stage {
                STAGE_ACTIVE => {
                    if input.installation_authorized == 0 {
                        plan.requirement_flags = REQUIREMENT_INSTALLATION_AUTHORIZED;
                        return Ok(plan);
                    }
                    plan.execution_allowed = 1;
                    plan.next_action = ACTION_DELETE_ASSIGNMENT;
                    plan.result_enrollment_stage = STAGE_REVOCATION_REMOTE_DELETED;
                    plan.worker_enrolled = 0;
                }
                STAGE_REVOCATION_REMOTE_DELETED => {
                    plan.execution_allowed = 1;
                    plan.next_action = ACTION_CLEAR_LOCAL_ASSIGNMENT;
                    plan.result_enrollment_stage = STAGE_NONE;
                    plan.worker_enrolled = 0;
                }
                _ => {
                    plan.requirement_flags = REQUIREMENT_ACTIVE_ASSIGNMENT;
                }
            }
            Ok(plan)
        }
        _ => Err(contract::ERROR_UNKNOWN_ENUM),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(operation: u32, stage: u32) -> MfwFastWalletHostingInputV1 {
        MfwFastWalletHostingInputV1 {
            struct_size: size_of::<MfwFastWalletHostingInputV1>() as u32,
            state_version: contract::WALLET_LIFECYCLE_STATE_VERSION,
            operation,
            lifecycle_state: contract::WALLET_LIFECYCLE_READY,
            seed_backup_confirmed: 1,
            installation_authorized: 1,
            trusted_worker_descriptor: 1,
            enrollment_stage: stage,
            reserved: 0,
        }
    }

    #[test]
    fn enrollment_is_one_durable_step_at_a_time() {
        let stages = [
            (STAGE_NONE, ACTION_PERSIST_PENDING, STAGE_PENDING_LOCAL),
            (
                STAGE_PENDING_LOCAL,
                ACTION_REGISTER_INSTALLATION,
                STAGE_INSTALLATION_REGISTERED,
            ),
            (
                STAGE_INSTALLATION_REGISTERED,
                ACTION_SPONSOR_ASSIGNMENT,
                STAGE_ASSIGNMENT_ACCEPTED,
            ),
            (
                STAGE_ASSIGNMENT_ACCEPTED,
                ACTION_ENABLE_DELIVERY,
                STAGE_DELIVERY_ENABLED,
            ),
            (
                STAGE_DELIVERY_ENABLED,
                ACTION_SEAL_WATCH,
                STAGE_WATCH_SEALED,
            ),
            (
                STAGE_WATCH_SEALED,
                ACTION_SUBMIT_WATCH,
                STAGE_RELAY_ACCEPTED,
            ),
            (
                STAGE_RELAY_ACCEPTED,
                ACTION_VERIFY_WORKER_RECEIPT,
                STAGE_WORKER_CONFIRMED,
            ),
            (STAGE_WORKER_CONFIRMED, ACTION_COMMIT_ACTIVE, STAGE_ACTIVE),
        ];
        for (stage, action, result) in stages {
            let plan = operation_plan(&input(OPERATION_ENROLL, stage)).unwrap();
            assert_eq!(plan.operation_allowed, 1);
            assert_eq!(plan.execution_allowed, 1);
            assert_eq!(plan.next_action, action);
            assert_eq!(plan.result_enrollment_stage, result);
            assert_eq!(plan.worker_enrolled, u32::from(result == STAGE_ACTIVE));
        }

        let active = operation_plan(&input(OPERATION_ENROLL, STAGE_ACTIVE)).unwrap();
        assert_eq!(active.execution_allowed, 1);
        assert_eq!(active.next_action, 0);
        assert_eq!(active.worker_enrolled, 1);
    }

    #[test]
    fn pending_record_creates_its_own_installation_capability() {
        let mut missing = input(OPERATION_ENROLL, STAGE_NONE);
        missing.installation_authorized = 0;
        missing.trusted_worker_descriptor = 0;
        let plan = operation_plan(&missing).unwrap();
        assert_eq!(plan.operation_allowed, 1);
        assert_eq!(plan.execution_allowed, 0);
        assert_eq!(
            plan.requirement_flags,
            REQUIREMENT_TRUSTED_WORKER_DESCRIPTOR
        );
        assert_eq!(plan.next_action, 0);

        missing.trusted_worker_descriptor = 1;
        let initial = operation_plan(&missing).unwrap();
        assert_eq!(initial.execution_allowed, 1);
        assert_eq!(initial.next_action, ACTION_PERSIST_PENDING);

        missing.enrollment_stage = STAGE_PENDING_LOCAL;
        let pending = operation_plan(&missing).unwrap();
        assert_eq!(pending.execution_allowed, 0);
        assert_eq!(
            pending.requirement_flags,
            REQUIREMENT_INSTALLATION_AUTHORIZED
        );
    }

    #[test]
    fn enrollment_never_runs_before_seed_backup() {
        let mut pending = input(OPERATION_ENROLL, STAGE_PENDING_LOCAL);
        pending.seed_backup_confirmed = 0;
        assert_eq!(
            operation_plan(&pending),
            Err(contract::ERROR_INVALID_ARGUMENT)
        );
    }

    #[test]
    fn revocation_has_two_ordered_stages_and_never_disables_shared_delivery() {
        let deleted = operation_plan(&input(OPERATION_REVOKE, STAGE_ACTIVE)).unwrap();
        assert_eq!(deleted.execution_allowed, 1);
        assert_eq!(deleted.next_action, ACTION_DELETE_ASSIGNMENT);
        assert_eq!(
            deleted.result_enrollment_stage,
            STAGE_REVOCATION_REMOTE_DELETED
        );
        assert_eq!(deleted.worker_enrolled, 0);

        let cleared =
            operation_plan(&input(OPERATION_REVOKE, STAGE_REVOCATION_REMOTE_DELETED)).unwrap();
        assert_eq!(cleared.execution_allowed, 1);
        assert_eq!(cleared.next_action, ACTION_CLEAR_LOCAL_ASSIGNMENT);
        assert_eq!(cleared.result_enrollment_stage, STAGE_NONE);
    }
}
