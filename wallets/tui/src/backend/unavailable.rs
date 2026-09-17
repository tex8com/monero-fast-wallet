use super::{
    BackendError, BackendKind, CreateRequest, CreatedWallet, OpenRequest, PreparedPayment,
    RestoreRequest, SendRequest, Subaddress, SubmittedPayment, Transaction, WalletBackend,
    WalletSnapshot,
};
use crate::action::NetworkChoice;

pub struct UnavailableBackend;

impl WalletBackend for UnavailableBackend {
    fn kind(&self) -> BackendKind {
        BackendKind::Unavailable
    }

    fn status_line(&self) -> String {
        "Native Monero CLI missing — set MFW_PRODUCT_CLI=/path/to/monero-fast-wallet-cli".into()
    }

    fn create_wallet(&mut self, _request: CreateRequest) -> Result<CreatedWallet, BackendError> {
        Err(BackendError::ProductCliMissing)
    }
    fn create_from_device(
        &mut self,
        _request: super::HardwareCreateRequest,
    ) -> Result<WalletSnapshot, BackendError> {
        Err(BackendError::ProductCliMissing)
    }
    fn restore_wallet(&mut self, _request: RestoreRequest) -> Result<WalletSnapshot, BackendError> {
        Err(BackendError::ProductCliMissing)
    }
    fn open_wallet(&mut self, _request: OpenRequest) -> Result<WalletSnapshot, BackendError> {
        Err(BackendError::ProductCliMissing)
    }
    fn snapshot(&self) -> Result<WalletSnapshot, BackendError> {
        Err(BackendError::ProductCliMissing)
    }
    fn refresh(&mut self) -> Result<WalletSnapshot, BackendError> {
        Err(BackendError::ProductCliMissing)
    }
    fn address(&self, _account: u32, _index: u32) -> Result<String, BackendError> {
        Err(BackendError::ProductCliMissing)
    }
    fn create_subaddress(
        &mut self,
        _account: u32,
        _label: &str,
    ) -> Result<Subaddress, BackendError> {
        Err(BackendError::ProductCliMissing)
    }
    fn transactions(&self, _limit: u32) -> Result<Vec<Transaction>, BackendError> {
        Err(BackendError::ProductCliMissing)
    }
    fn validate_address(
        &self,
        _address: &str,
        _network: NetworkChoice,
    ) -> Result<String, BackendError> {
        Err(BackendError::ProductCliMissing)
    }
    fn prepare_send(&mut self, _request: SendRequest) -> Result<PreparedPayment, BackendError> {
        Err(BackendError::ProductCliMissing)
    }
    fn commit_send(
        &mut self,
        _prepared: &PreparedPayment,
    ) -> Result<SubmittedPayment, BackendError> {
        Err(BackendError::ProductCliMissing)
    }
    fn cancel_send(&mut self) -> Result<(), BackendError> {
        Err(BackendError::ProductCliMissing)
    }
    fn confirm_seed_backup(&mut self) -> Result<(), BackendError> {
        Err(BackendError::ProductCliMissing)
    }
    fn close(&mut self) -> Result<(), BackendError> {
        Ok(())
    }
}
