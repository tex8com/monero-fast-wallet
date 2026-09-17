use crate::action::{LedgerTransport, NetworkChoice};
use std::path::PathBuf;
use thiserror::Error;
use zeroize::Zeroizing;

#[derive(Debug, Error)]
pub enum BackendError {
    #[error("{0}")]
    Message(String),
    #[error(
        "native Monero CLI was not found. Set MFW_PRODUCT_CLI to monero-fast-wallet-cli, or place that binary beside fast-wallet-cli"
    )]
    ProductCliMissing,
    #[error("no wallet is open")]
    NoWallet,
    #[error("payment must be reviewed before it is submitted")]
    ReviewRequired,
    #[error("no pending payment to confirm")]
    NoPendingPayment,
}

impl BackendError {
    pub fn msg(text: impl Into<String>) -> Self {
        Self::Message(text.into())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BackendKind {
    Memory,
    ProductCli,
    Unavailable,
}

#[derive(Debug, Clone)]
pub struct CreateRequest {
    pub path: PathBuf,
    pub password: Zeroizing<String>,
    pub network: NetworkChoice,
}

#[derive(Debug, Clone)]
pub struct RestoreRequest {
    pub path: PathBuf,
    pub password: Zeroizing<String>,
    pub seed: Zeroizing<String>,
    pub restore_height: u64,
    pub network: NetworkChoice,
}

#[derive(Debug, Clone)]
pub struct OpenRequest {
    pub path: PathBuf,
    pub password: Zeroizing<String>,
    pub network: NetworkChoice,
}

#[derive(Debug, Clone)]
pub struct HardwareCreateRequest {
    pub path: PathBuf,
    pub password: Zeroizing<String>,
    pub network: NetworkChoice,
    pub restore_height: u64,
    pub transport: LedgerTransport,
}

#[derive(Debug, Clone)]
pub struct CreatedWallet {
    pub address: String,
    pub seed: Zeroizing<String>,
    pub snapshot: WalletSnapshot,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct NodeConnection {
    pub daemon_address: String,
    pub proxy_address: String,
    pub trusted: bool,
    pub use_ssl: bool,
}

impl NodeConnection {
    pub fn cli_args(&self) -> Vec<String> {
        let mut args = Vec::new();
        if self.daemon_address.trim().is_empty() {
            return args;
        }
        args.push("--daemon-address".into());
        args.push(self.daemon_address.trim().to_owned());
        if !self.proxy_address.trim().is_empty() {
            args.push("--proxy".into());
            args.push(self.proxy_address.trim().to_owned());
        }
        if self.trusted {
            args.push("--trusted-daemon".into());
        }
        args
    }
}

#[derive(Debug, Clone)]
pub struct WalletSnapshot {
    pub path: PathBuf,
    pub primary_address: String,
    pub balance_atomic: u128,
    pub unlocked_atomic: u128,
    pub network: NetworkChoice,
    pub synchronized: bool,
    pub height: u64,
    pub daemon_height: u64,
    pub daemon_target_height: u64,
    pub connection_failed: bool,
    pub hardware: bool,
}

#[derive(Debug, Clone)]
pub struct Subaddress {
    pub index: u32,
    pub address: String,
    pub label: String,
}

#[derive(Debug, Clone)]
pub struct Transaction {
    pub direction: TxDirection,
    pub amount_atomic: u128,
    pub txid: String,
    pub height: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TxDirection {
    In,
    Out,
    Pending,
}

#[derive(Debug, Clone)]
pub struct SendRequest {
    pub address: String,
    pub amount_atomic: u128,
}

#[derive(Debug, Clone)]
pub struct PreparedPayment {
    pub address: String,
    pub amount_atomic: u128,
    pub fee_atomic: u128,
    pub token: String,
}

#[derive(Debug, Clone)]
pub struct SubmittedPayment {
    pub txid: String,
}

pub trait WalletBackend {
    fn kind(&self) -> BackendKind;
    fn status_line(&self) -> String;

    fn create_wallet(&mut self, request: CreateRequest) -> Result<CreatedWallet, BackendError>;
    fn create_from_device(
        &mut self,
        request: HardwareCreateRequest,
    ) -> Result<WalletSnapshot, BackendError>;
    fn restore_wallet(&mut self, request: RestoreRequest) -> Result<WalletSnapshot, BackendError>;
    fn open_wallet(&mut self, request: OpenRequest) -> Result<WalletSnapshot, BackendError>;
    fn snapshot(&self) -> Result<WalletSnapshot, BackendError>;
    fn refresh(&mut self) -> Result<WalletSnapshot, BackendError>;
    fn address(&self, account: u32, index: u32) -> Result<String, BackendError>;
    fn create_subaddress(&mut self, account: u32, label: &str) -> Result<Subaddress, BackendError>;
    fn transactions(&self, limit: u32) -> Result<Vec<Transaction>, BackendError>;
    fn validate_address(
        &self,
        address: &str,
        network: NetworkChoice,
    ) -> Result<String, BackendError>;
    fn prepare_send(&mut self, request: SendRequest) -> Result<PreparedPayment, BackendError>;
    fn commit_send(&mut self, prepared: &PreparedPayment)
        -> Result<SubmittedPayment, BackendError>;
    fn cancel_send(&mut self) -> Result<(), BackendError>;
    fn confirm_seed_backup(&mut self) -> Result<(), BackendError>;
    fn recovery_seed(&mut self) -> Result<Zeroizing<String>, BackendError> {
        Err(BackendError::msg(
            "recovery seed is not available in this backend",
        ))
    }
    fn close(&mut self) -> Result<(), BackendError>;

    fn set_node(&mut self, _node: NodeConnection) {}

    /// Start a non-blocking refresh. Returns true if the caller must poll.
    fn start_background_refresh(&mut self) -> bool {
        false
    }

    fn poll_background_refresh(&mut self) -> Option<Result<WalletSnapshot, BackendError>> {
        None
    }

    fn test_credit(&mut self, _atomic: u128) -> Result<(), BackendError> {
        Err(BackendError::msg(
            "test credit is only available in the in-memory test backend",
        ))
    }
}
