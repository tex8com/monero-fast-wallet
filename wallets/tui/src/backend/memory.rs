use super::{
    BackendError, BackendKind, CreateRequest, CreatedWallet, OpenRequest, PreparedPayment,
    RestoreRequest, SendRequest, Subaddress, SubmittedPayment, Transaction, TxDirection,
    WalletBackend, WalletSnapshot,
};
use crate::action::NetworkChoice;
use crate::format::ATOMIC_PER_XMR;
use std::collections::HashMap;
use std::path::PathBuf;
use zeroize::Zeroizing;

const TEST_FEE: u128 = 100_000_000; // 0.0001 XMR

pub struct MemoryBackend {
    wallets: HashMap<PathBuf, StoredWallet>,
    open: Option<PathBuf>,
    pending: Option<PreparedPayment>,
    next_txid: u64,
}

struct StoredWallet {
    password: Zeroizing<String>,
    seed: Zeroizing<String>,
    network: NetworkChoice,
    snapshot: WalletSnapshot,
    subaddresses: Vec<Subaddress>,
    transactions: Vec<Transaction>,
    seed_backup_confirmed: bool,
}

impl Default for MemoryBackend {
    fn default() -> Self {
        Self::new()
    }
}

impl MemoryBackend {
    pub fn new() -> Self {
        Self {
            wallets: HashMap::new(),
            open: None,
            pending: None,
            next_txid: 1,
        }
    }

    fn dummy_address(prefix: char, n: u64, index: u32) -> String {
        let alphabet = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
        let mut out = String::with_capacity(95);
        out.push(prefix);
        let mut state = n.wrapping_mul(0x9E37_79B9_7F4A_7C15) ^ u64::from(index);
        while out.len() < 95 {
            state = state.wrapping_mul(6364136223846793005).wrapping_add(1);
            out.push(alphabet[(state as usize) % alphabet.len()] as char);
        }
        out
    }

    fn test_seed() -> Zeroizing<String> {
        let words: Vec<String> = (0..25).map(|i| format!("test{i:03}")).collect();
        Zeroizing::new(words.join(" "))
    }

    fn open_stored(&self) -> Result<&StoredWallet, BackendError> {
        let path = self.open.as_ref().ok_or(BackendError::NoWallet)?;
        self.wallets
            .get(path)
            .ok_or_else(|| BackendError::msg("wallet disappeared"))
    }

    fn open_stored_mut(&mut self) -> Result<&mut StoredWallet, BackendError> {
        let path = self.open.as_ref().ok_or(BackendError::NoWallet)?.clone();
        self.wallets
            .get_mut(&path)
            .ok_or_else(|| BackendError::msg("wallet disappeared"))
    }
}

fn looks_like_address(address: &str) -> bool {
    let len = address.len();
    if !(len == 95 || len == 106) {
        return false;
    }
    matches!(address.as_bytes().first(), Some(b'4' | b'8' | b'5' | b'9'))
        && address.chars().all(|c| c.is_ascii_alphanumeric())
}

impl WalletBackend for MemoryBackend {
    fn kind(&self) -> BackendKind {
        BackendKind::Memory
    }

    fn status_line(&self) -> String {
        "in-memory test backend (not for real funds)".into()
    }

    fn create_wallet(&mut self, request: CreateRequest) -> Result<CreatedWallet, BackendError> {
        if self.wallets.contains_key(&request.path) {
            return Err(BackendError::msg("wallet file already exists"));
        }
        let address = Self::dummy_address('4', self.wallets.len() as u64 + 1, 0);
        let seed = Self::test_seed();
        let snapshot = WalletSnapshot {
            path: request.path.clone(),
            primary_address: address.clone(),
            balance_atomic: 0,
            unlocked_atomic: 0,
            network: request.network,
            synchronized: true,
            height: 1,
            daemon_height: 1,
            daemon_target_height: 1,
            connection_failed: false,
            hardware: false,
        };
        self.wallets.insert(
            request.path.clone(),
            StoredWallet {
                password: request.password,
                seed: seed.clone(),
                network: request.network,
                snapshot: snapshot.clone(),
                subaddresses: vec![Subaddress {
                    index: 0,
                    address: address.clone(),
                    label: "Primary address".into(),
                }],
                transactions: Vec::new(),
                seed_backup_confirmed: false,
            },
        );
        self.open = Some(request.path);
        self.pending = None;
        Ok(CreatedWallet {
            address,
            seed,
            snapshot,
        })
    }

    fn create_from_device(
        &mut self,
        request: crate::backend::HardwareCreateRequest,
    ) -> Result<WalletSnapshot, BackendError> {
        if request.restore_height <= 1 {
            return Err(BackendError::msg(
                "Choose a Ledger scan start height before its first transaction.",
            ));
        }
        let _created = self.create_wallet(CreateRequest {
            path: request.path,
            password: request.password,
            network: request.network,
        })?;
        let wallet = self.open_stored_mut()?;
        wallet.snapshot.hardware = true;
        wallet.snapshot.height = request.restore_height;
        wallet.seed = Zeroizing::new(String::new());
        wallet.seed_backup_confirmed = true;
        Ok(wallet.snapshot.clone())
    }

    fn restore_wallet(&mut self, request: RestoreRequest) -> Result<WalletSnapshot, BackendError> {
        let words: Vec<_> = request.seed.split_whitespace().collect();
        if words.len() != 25 {
            return Err(BackendError::msg("recovery seed must be 25 words"));
        }
        let created = self.create_wallet(CreateRequest {
            path: request.path,
            password: request.password,
            network: request.network,
        })?;
        if let Some(wallet) = self.wallets.get_mut(&created.snapshot.path) {
            wallet.seed = request.seed;
            wallet.snapshot.height = request.restore_height;
        }
        Ok(created.snapshot)
    }

    fn open_wallet(&mut self, request: OpenRequest) -> Result<WalletSnapshot, BackendError> {
        let wallet = self
            .wallets
            .get(&request.path)
            .ok_or_else(|| BackendError::msg("wallet file not found"))?;
        if *wallet.password != *request.password {
            return Err(BackendError::msg("wrong password"));
        }
        if wallet.network != request.network {
            return Err(BackendError::msg("network does not match this wallet"));
        }
        self.open = Some(request.path);
        self.pending = None;
        Ok(wallet.snapshot.clone())
    }

    fn snapshot(&self) -> Result<WalletSnapshot, BackendError> {
        Ok(self.open_stored()?.snapshot.clone())
    }

    fn refresh(&mut self) -> Result<WalletSnapshot, BackendError> {
        let wallet = self.open_stored_mut()?;
        if !wallet.snapshot.synchronized {
            let target = wallet.snapshot.daemon_target_height.max(1);
            wallet.snapshot.height = (wallet.snapshot.height + target / 4).min(target);
            wallet.snapshot.daemon_height = target;
            if wallet.snapshot.height >= target {
                wallet.snapshot.synchronized = true;
            }
        } else {
            wallet.snapshot.daemon_height =
                wallet.snapshot.height.max(wallet.snapshot.daemon_height);
            wallet.snapshot.daemon_target_height = wallet.snapshot.daemon_height;
        }
        wallet.snapshot.connection_failed = false;
        Ok(wallet.snapshot.clone())
    }

    fn address(&self, _account: u32, index: u32) -> Result<String, BackendError> {
        let wallet = self.open_stored()?;
        wallet
            .subaddresses
            .iter()
            .find(|item| item.index == index)
            .map(|item| item.address.clone())
            .ok_or_else(|| BackendError::msg("unknown subaddress"))
    }

    fn create_subaddress(
        &mut self,
        _account: u32,
        label: &str,
    ) -> Result<Subaddress, BackendError> {
        let n = self.wallets.len() as u64;
        let wallet = self.open_stored_mut()?;
        let index = wallet.subaddresses.len() as u32;
        let sub = Subaddress {
            index,
            address: Self::dummy_address('8', n, index),
            label: if label.is_empty() {
                format!("Address {index}")
            } else {
                label.to_owned()
            },
        };
        wallet.subaddresses.push(sub.clone());
        Ok(sub)
    }

    fn transactions(&self, limit: u32) -> Result<Vec<Transaction>, BackendError> {
        let wallet = self.open_stored()?;
        Ok(wallet
            .transactions
            .iter()
            .rev()
            .take(limit as usize)
            .cloned()
            .collect())
    }

    fn validate_address(
        &self,
        address: &str,
        _network: NetworkChoice,
    ) -> Result<String, BackendError> {
        if looks_like_address(address) {
            Ok(address.to_owned())
        } else {
            Err(BackendError::msg("not a Monero address"))
        }
    }

    fn prepare_send(&mut self, request: SendRequest) -> Result<PreparedPayment, BackendError> {
        if !looks_like_address(&request.address) {
            return Err(BackendError::msg("not a Monero address"));
        }
        if request.amount_atomic == 0 {
            return Err(BackendError::msg("amount must be greater than zero"));
        }
        let wallet = self.open_stored()?;
        if !wallet.seed_backup_confirmed {
            return Err(BackendError::msg("confirm the recovery seed backup first"));
        }
        let total = request
            .amount_atomic
            .checked_add(TEST_FEE)
            .ok_or_else(|| BackendError::msg("amount overflow"))?;
        if wallet.snapshot.unlocked_atomic < total {
            return Err(BackendError::msg("unlocked balance is too low"));
        }
        let prepared = PreparedPayment {
            address: request.address,
            amount_atomic: request.amount_atomic,
            fee_atomic: TEST_FEE,
            token: format!("pending-{}", self.next_txid),
        };
        self.pending = Some(prepared.clone());
        Ok(prepared)
    }

    fn commit_send(
        &mut self,
        prepared: &PreparedPayment,
    ) -> Result<SubmittedPayment, BackendError> {
        let pending = self
            .pending
            .as_ref()
            .ok_or(BackendError::NoPendingPayment)?;
        if pending.token != prepared.token {
            return Err(BackendError::ReviewRequired);
        }
        let total = prepared.amount_atomic + prepared.fee_atomic;
        let txid = format!("tui-test-tx-{:08}", self.next_txid);
        self.next_txid += 1;
        let wallet = self.open_stored_mut()?;
        if wallet.snapshot.unlocked_atomic < total {
            return Err(BackendError::msg("unlocked balance is too low"));
        }
        wallet.snapshot.unlocked_atomic -= total;
        wallet.snapshot.balance_atomic -= total;
        wallet.transactions.push(Transaction {
            direction: TxDirection::Out,
            amount_atomic: prepared.amount_atomic,
            txid: txid.clone(),
            height: wallet.snapshot.height,
        });
        self.pending = None;
        Ok(SubmittedPayment { txid })
    }

    fn cancel_send(&mut self) -> Result<(), BackendError> {
        self.pending = None;
        Ok(())
    }

    fn confirm_seed_backup(&mut self) -> Result<(), BackendError> {
        self.open_stored_mut()?.seed_backup_confirmed = true;
        Ok(())
    }

    fn recovery_seed(&mut self) -> Result<Zeroizing<String>, BackendError> {
        let wallet = self.open_stored()?;
        if wallet.snapshot.hardware || wallet.seed.is_empty() {
            return Err(BackendError::msg(
                "The recovery seed remains on the Ledger device.",
            ));
        }
        Ok(wallet.seed.clone())
    }

    fn close(&mut self) -> Result<(), BackendError> {
        self.open = None;
        self.pending = None;
        Ok(())
    }

    fn test_credit(&mut self, atomic: u128) -> Result<(), BackendError> {
        let wallet = self.open_stored_mut()?;
        wallet.snapshot.balance_atomic += atomic;
        wallet.snapshot.unlocked_atomic += atomic;
        wallet.transactions.push(Transaction {
            direction: TxDirection::In,
            amount_atomic: atomic,
            txid: format!("tui-test-in-{}", wallet.transactions.len()),
            height: wallet.snapshot.height,
        });
        Ok(())
    }
}

impl MemoryBackend {
    pub fn unlocked(&self) -> u128 {
        self.open_stored()
            .map(|wallet| wallet.snapshot.unlocked_atomic)
            .unwrap_or(0)
    }

    pub fn funded_destination() -> String {
        Self::dummy_address('4', 99, 7)
    }

    pub fn credit_open_wallet(&mut self, xmr: u64) -> Result<(), BackendError> {
        self.test_credit(u128::from(xmr) * ATOMIC_PER_XMR)
    }

    pub fn begin_historic_sync(&mut self, start: u64, target: u64) -> Result<(), BackendError> {
        let wallet = self.open_stored_mut()?;
        wallet.snapshot.synchronized = false;
        wallet.snapshot.height = start;
        wallet.snapshot.daemon_height = target;
        wallet.snapshot.daemon_target_height = target;
        wallet.snapshot.connection_failed = false;
        Ok(())
    }
}
