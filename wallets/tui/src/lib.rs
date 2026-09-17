//! Monero Fast Wallet TUI — thin terminal adapter over the product CLI.

pub mod action;
pub mod app;
pub mod backend;
pub mod format;
pub mod launch;
pub mod mfw_check;
pub mod node_probe;
pub mod settings;
pub mod sync;
pub mod ui;
pub mod wallets;

pub use action::{Action, Tab};
pub use app::{App, RunOutcome, ScreenKind, ViewModel};
pub use launch::{plan_launch, LaunchContext, LaunchPlan};
