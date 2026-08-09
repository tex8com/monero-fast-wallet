use mfw_product_core::app_vault::{local_wallet_switch_allowed, MfwAppVaultStateV1};
use std::{hint::black_box, time::Instant};

const TRIALS: u64 = 20_000;
const SWITCHES_PER_TRIAL: u64 = 100;

fn main() {
    let state = MfwAppVaultStateV1 {
        ready: 1,
        onboarding_complete: 1,
        configured: 1,
        protection_mode: 1,
        session_authorized: 1,
        ..Default::default()
    };
    let started = Instant::now();
    let mut allowed = 0u64;
    for _ in 0..TRIALS {
        for _ in 0..SWITCHES_PER_TRIAL {
            if black_box(local_wallet_switch_allowed(
                black_box(&state),
                black_box(true),
                black_box(true),
            )) {
                allowed += 1;
            }
        }
    }
    let elapsed = started.elapsed();
    let switches = TRIALS * SWITCHES_PER_TRIAL;
    let elapsed_ns = elapsed.as_nanos() as u64;
    let ns_per_switch = elapsed_ns as f64 / switches as f64;
    let switches_per_second = switches as f64 / elapsed.as_secs_f64();
    println!(
        "{{\"schema_version\":1,\"measurement\":\"local_registry_snapshot_wallet_switch_guard\",\"build_profile\":\"{}\",\"trials\":{},\"switches_per_trial\":{},\"switches\":{},\"allowed\":{},\"network_calls\":0,\"prompts\":0,\"elapsed_ns\":{},\"ns_per_switch\":{:.3},\"switches_per_second\":{:.3}}}",
        if cfg!(debug_assertions) {
            "debug"
        } else {
            "release"
        },
        TRIALS,
        SWITCHES_PER_TRIAL,
        switches,
        allowed,
        elapsed_ns,
        ns_per_switch,
        switches_per_second,
    );
}
