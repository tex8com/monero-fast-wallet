use crate::action::{Action, Field, LedgerTransport, NetworkChoice, SettingsAction, Tab};
use crate::backend::{
    CreatedWallet, HardwareCreateRequest, PreparedPayment, SendRequest, Subaddress, Transaction,
    WalletBackend, WalletSnapshot,
};
use crate::format::{format_atomic_xmr, mask_secret, parse_xmr_to_atomic};
use crate::settings::{
    menu_items, ComputeBackend, MenuEntry, MenuItem, NodeMode, ProtectionMode, SettingsState,
    WorkerKind,
};
use crate::sync::{
    compact_status, format_block_count, format_eta_seconds, phase_label, present_wallet_sync,
    SyncPhase,
};
use std::path::PathBuf;
use std::time::Instant;
use zeroize::{Zeroize, Zeroizing};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScreenKind {
    Welcome,
    Create,
    Restore,
    Ledger,
    Open,
    SeedBackup,
    Home,
    Receive,
    Send,
    Activity,
    Help,
    Menu,
    Settings,
    Wallets,
    Node,
    Mfw,
    Project,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ViewModel {
    pub screen: ScreenKind,
    pub tab: Tab,
    pub title: String,
    pub backend: String,
    pub network: String,
    pub error: Option<String>,
    pub status: String,
    pub buttons: Vec<String>,
    pub balance: Option<String>,
    pub unlocked: Option<String>,
    pub address: Option<String>,
    pub seed_visible: bool,
    pub seed_word_count: usize,
    pub password_masked: Option<String>,
    pub wallet_path: String,
    pub amount: String,
    pub recipient: String,
    pub review: Option<PaymentReviewView>,
    pub transactions: Vec<String>,
    pub subaddresses: Vec<String>,
    pub command: String,
    pub wallet_open: bool,
    pub header: String,
    pub working_dir: String,
    pub known_wallets: Vec<crate::wallets::KnownWallet>,
    pub wallet_roots: Vec<String>,
    pub restore_height: String,
    pub focused: Field,
    pub sync: SyncView,
    pub hardware: bool,
    pub ledger_transport: LedgerTransport,
    pub settings: SettingsView,
    pub menu_items: Vec<MenuEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SettingsView {
    pub worker: WorkerKind,
    pub worker_label: String,
    pub show_private_worker: bool,
    pub private_worker: String,
    pub language_code: String,
    pub language_name: String,
    pub compute: ComputeBackend,
    pub share_searches: bool,
    pub protection: ProtectionMode,
    pub auto_lock_label: String,
    pub auto_lock_seconds: u32,
    pub node_network: String,
    pub node_mode: NodeMode,
    pub daemon_address: String,
    pub grpc_endpoint: String,
    pub proxy_address: String,
    pub cli_daemon: String,
    pub scroll: u16,
    pub seed_revealed: bool,
    pub locked: bool,
    pub system_auth: String,
    pub mfw_name: String,
    pub mfw_years: u32,
    pub app_password_len: usize,
    pub app_password_confirm_len: usize,
    pub current_app_password_len: usize,
    pub node_checking: bool,
    pub node_probes: Vec<crate::node_probe::ProbeResult>,
    pub mfw_checking: bool,
    pub mfw_available: bool,
    pub mfw_status: String,
    pub mfw_step: u8,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SyncView {
    pub compact: String,
    pub ready: bool,
    pub failed: bool,
    pub working: bool,
    pub percent: Option<u8>,
    pub phase: String,
    pub height: Option<String>,
    pub remaining: Option<String>,
    pub eta: Option<String>,
    pub blockchain_percent: Option<u8>,
    pub blockchain_height: Option<String>,
    pub blockchain_detail: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PaymentReviewView {
    pub address: String,
    pub amount: String,
    pub fee: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunOutcome {
    Continue,
    Exit(i32),
    Classic,
}

struct Form {
    wallet_path: String,
    password: Zeroizing<String>,
    seed: Zeroizing<String>,
    restore_height: String,
    network: NetworkChoice,
    address: String,
    amount: String,
    subaddress_label: String,
    command: String,
    focus: Field,
    ledger_transport: LedgerTransport,
}

struct SeedBackup {
    words: Zeroizing<String>,
    address: String,
}

pub struct App {
    backend: Box<dyn WalletBackend>,
    screen: ScreenKind,
    tab: Tab,
    form: Form,
    snapshot: Option<WalletSnapshot>,
    seed_backup: Option<SeedBackup>,
    review: Option<PreparedPayment>,
    transactions: Vec<Transaction>,
    subaddresses: Vec<Subaddress>,
    error: Option<String>,
    status: String,
    pub hits: Vec<Hit>,
    start_height: Option<u64>,
    ticks_since_refresh: u8,
    eta_started: Option<Instant>,
    eta_start_remaining: Option<u64>,
    settings: SettingsState,
    known_wallets: Vec<crate::wallets::KnownWallet>,
    working_dir: String,
    wallet_roots: Vec<String>,
    node_probes: Vec<crate::node_probe::ProbeResult>,
    node_checking: bool,
    node_probe_rx: Option<std::sync::mpsc::Receiver<Vec<crate::node_probe::ProbeResult>>>,
    mfw_checking: bool,
    mfw_available: bool,
    mfw_status: String,
    mfw_step: u8,
    mfw_rx: Option<std::sync::mpsc::Receiver<Result<crate::mfw_check::Availability, String>>>,
}

#[derive(Debug, Clone)]
pub struct Hit {
    pub x: u16,
    pub y: u16,
    pub width: u16,
    pub height: u16,
    pub action: Action,
}

impl App {
    pub fn new(backend: Box<dyn WalletBackend>) -> Self {
        let status = backend.status_line();
        let mut app = Self {
            backend,
            screen: ScreenKind::Welcome,
            tab: Tab::Home,
            form: Form {
                wallet_path: String::new(),
                password: Zeroizing::new(String::new()),
                seed: Zeroizing::new(String::new()),
                restore_height: "0".into(),
                network: NetworkChoice::Stagenet,
                address: String::new(),
                amount: String::new(),
                subaddress_label: String::new(),
                command: String::new(),
                focus: Field::WalletPath,
                ledger_transport: LedgerTransport::Usb,
            },
            snapshot: None,
            seed_backup: None,
            review: None,
            transactions: Vec::new(),
            subaddresses: Vec::new(),
            error: None,
            status,
            hits: Vec::new(),
            start_height: None,
            ticks_since_refresh: 0,
            eta_started: None,
            eta_start_remaining: None,
            settings: SettingsState::load(),
            known_wallets: Vec::new(),
            working_dir: String::new(),
            wallet_roots: Vec::new(),
            node_probes: Vec::new(),
            node_checking: false,
            node_probe_rx: None,
            mfw_checking: false,
            mfw_available: false,
            mfw_status: "Enter a name, then Check name.".into(),
            mfw_step: 1,
            mfw_rx: None,
        };
        app.reload_wallet_list();
        app.apply_node();
        app
    }

    fn reload_wallet_list(&mut self) {
        self.known_wallets = crate::wallets::discover_wallets();
        let roots = crate::wallets::search_roots();
        self.working_dir = roots
            .iter()
            .map(|(label, path)| format!("{label}: {}", path.display()))
            .collect::<Vec<_>>()
            .join("  ·  ");
        self.wallet_roots = roots
            .into_iter()
            .map(|(label, path)| format!("{} · {}", label, path.display()))
            .collect();
    }

    fn apply_node(&mut self) {
        self.backend.set_node(self.settings.cli_connection());
    }

    pub fn handle(&mut self, action: Action) -> RunOutcome {
        match action {
            Action::Quit => {
                let _ = self.backend.close();
                return RunOutcome::Exit(0);
            }
            Action::LaunchClassic => {
                let _ = self.backend.close();
                return RunOutcome::Classic;
            }
            Action::MouseClick { column, row } => {
                if let Some(mapped) = self.action_at(column, row) {
                    return self.handle(mapped);
                }
            }
            Action::GoTab(tab) => {
                if self.seed_backup.is_some() {
                    self.error = Some("Confirm the recovery seed backup first.".into());
                } else if self.snapshot.is_some() {
                    self.tab = primary_tab(tab);
                    self.screen = screen_for_tab(tab);
                    self.error = None;
                    self.settings.seed_reveal = None;
                    if matches!(tab, Tab::Activity) {
                        self.reload_activity();
                    }
                    if matches!(tab, Tab::Receive) {
                        self.reload_receive();
                    }
                }
            }
            Action::OpenMenu(item) => {
                if self.seed_backup.is_some() {
                    self.error = Some("Confirm the recovery seed backup first.".into());
                } else if self.snapshot.is_some() {
                    self.open_menu_item(item);
                }
            }
            Action::Settings(action) => {
                if self.snapshot.is_some() {
                    self.handle_settings(action);
                }
            }
            Action::SelectOpen => {
                self.reload_wallet_list();
                self.screen = ScreenKind::Open;
                self.form.focus = Field::WalletPath;
                self.error = None;
            }
            Action::SelectCreate => {
                self.screen = ScreenKind::Create;
                self.form.focus = Field::WalletPath;
                self.error = None;
            }
            Action::SelectRestore => {
                self.screen = ScreenKind::Restore;
                self.form.focus = Field::WalletPath;
                self.error = None;
            }
            Action::SelectLedger => {
                self.screen = ScreenKind::Ledger;
                self.form.network = NetworkChoice::Mainnet;
                self.form.focus = Field::WalletPath;
                if self.form.wallet_path.trim().is_empty() {
                    self.form.wallet_path = default_ledger_path();
                }
                if self.form.restore_height == "0" {
                    self.form.restore_height.clear();
                }
                self.error = None;
            }
            Action::SetLedgerTransport(transport) => {
                self.form.ledger_transport = transport;
                self.error = None;
            }
            Action::Cancel => self.cancel(),
            Action::Submit => self.submit(),
            Action::ConfirmSeedBackup => self.confirm_seed(),
            Action::CycleNetwork => self.form.network = self.form.network.next(),
            Action::SetNetwork(network) => self.form.network = network,
            Action::Focus(field) => self.form.focus = field,
            Action::InsertChar(ch) => self.insert_char(ch),
            Action::Backspace => self.backspace(),
            Action::Refresh => self.request_refresh(),
            Action::NewSubaddress => self.new_subaddress(),
            Action::ReviewSend => self.review_send(),
            Action::ConfirmSend => self.confirm_send(),
            Action::CancelSend => {
                let _ = self.backend.cancel_send();
                self.review = None;
                self.status = "Payment cancelled.".into();
            }
            Action::RunCommand => return self.run_command(),
            Action::SetWalletPath(path) => {
                if let Some(wallet) = self.known_wallets.iter().find(|wallet| wallet.path == path) {
                    match wallet.network.as_str() {
                        "mainnet" => self.form.network = NetworkChoice::Mainnet,
                        "stagenet" => self.form.network = NetworkChoice::Stagenet,
                        "testnet" => self.form.network = NetworkChoice::Testnet,
                        _ => {}
                    }
                }
                self.form.wallet_path = path;
                self.form.focus = Field::Password;
                self.error = None;
                if matches!(self.screen, ScreenKind::Wallets | ScreenKind::Menu) {
                    self.screen = ScreenKind::Open;
                }
            }
            Action::Tick => self.on_tick(),
        }
        RunOutcome::Continue
    }

    pub fn view_model(&self) -> ViewModel {
        let (balance, unlocked, address) = match &self.snapshot {
            Some(snapshot) => (
                Some(format_atomic_xmr(snapshot.balance_atomic)),
                Some(format_atomic_xmr(snapshot.unlocked_atomic)),
                Some(snapshot.primary_address.clone()),
            ),
            None => (None, None, None),
        };
        ViewModel {
            screen: self.screen,
            tab: self.tab,
            title: "Monero Fast Wallet".into(),
            backend: self.backend.status_line(),
            network: self
                .snapshot
                .as_ref()
                .map(|snapshot| snapshot.network.label().to_owned())
                .unwrap_or_else(|| self.form.network.label().to_owned()),
            error: self.error.clone(),
            status: self.status.clone(),
            buttons: self.visible_buttons(),
            balance,
            unlocked,
            address: self.current_address().or(address),
            seed_visible: self.seed_backup.is_some(),
            seed_word_count: self
                .seed_backup
                .as_ref()
                .map(|backup| backup.words.split_whitespace().count())
                .unwrap_or(0),
            password_masked: if matches!(
                self.screen,
                ScreenKind::Create | ScreenKind::Open | ScreenKind::Restore | ScreenKind::Ledger
            ) {
                Some(mask_secret(&self.form.password))
            } else {
                None
            },
            wallet_path: self.form.wallet_path.clone(),
            amount: self.form.amount.clone(),
            recipient: self.form.address.clone(),
            review: self.review.as_ref().map(|payment| PaymentReviewView {
                address: payment.address.clone(),
                amount: format_atomic_xmr(payment.amount_atomic),
                fee: format_atomic_xmr(payment.fee_atomic),
            }),
            transactions: self
                .transactions
                .iter()
                .map(|tx| {
                    format!(
                        "{:?} {} {}",
                        tx.direction,
                        format_atomic_xmr(tx.amount_atomic),
                        tx.txid
                    )
                })
                .collect(),
            subaddresses: self
                .subaddresses
                .iter()
                .map(|item| format!("{}  {}", item.label, item.address))
                .collect(),
            command: self.form.command.clone(),
            wallet_open: self.snapshot.is_some(),
            header: header_for(self.screen),
            working_dir: self.working_dir.clone(),
            known_wallets: self.known_wallets.clone(),
            wallet_roots: self.wallet_roots.clone(),
            restore_height: self.form.restore_height.clone(),
            focused: self.form.focus,
            sync: self.sync_view(),
            hardware: self.snapshot.as_ref().is_some_and(|item| item.hardware),
            ledger_transport: self.form.ledger_transport,
            settings: SettingsView {
                worker: self.settings.worker,
                worker_label: self.settings.worker_label.clone(),
                show_private_worker: self.settings.show_private_worker,
                private_worker: self.settings.private_worker.clone(),
                language_code: self.settings.language.to_owned(),
                language_name: self.settings.language_name().to_owned(),
                compute: self.settings.compute,
                share_searches: self.settings.share_searches,
                protection: self.settings.protection,
                auto_lock_label: self.settings.auto_lock_label().to_owned(),
                auto_lock_seconds: self.settings.auto_lock_seconds,
                node_network: self.settings.node_network.label().to_owned(),
                node_mode: self.settings.node_mode,
                daemon_address: self.settings.daemon_address.clone(),
                grpc_endpoint: self.settings.grpc_endpoint.clone(),
                proxy_address: self.settings.proxy_address.clone(),
                cli_daemon: self.settings.cli_connection().daemon_address,
                scroll: self.settings.scroll,
                seed_revealed: self.settings.seed_reveal.is_some(),
                locked: self.settings.locked,
                system_auth: SettingsState::system_auth_label().to_owned(),
                mfw_name: self.settings.mfw_name.clone(),
                mfw_years: self.settings.mfw_years,
                app_password_len: self.settings.app_password.len(),
                app_password_confirm_len: self.settings.app_password_confirm.len(),
                current_app_password_len: self.settings.current_app_password.len(),
                node_checking: self.node_checking,
                node_probes: self.node_probes.clone(),
                mfw_checking: self.mfw_checking,
                mfw_available: self.mfw_available,
                mfw_status: self.mfw_status.clone(),
                mfw_step: self.mfw_step,
            },
            menu_items: menu_items(),
        }
    }

    pub fn action_at(&self, column: u16, row: u16) -> Option<Action> {
        self.hits.iter().rev().find_map(|hit| {
            if column >= hit.x
                && column < hit.x.saturating_add(hit.width)
                && row >= hit.y
                && row < hit.y.saturating_add(hit.height)
            {
                Some(hit.action.clone())
            } else {
                None
            }
        })
    }

    pub fn focused_field(&self) -> Field {
        self.form.focus
    }

    pub fn seed_words(&self) -> Option<&str> {
        self.seed_backup
            .as_ref()
            .map(|backup| backup.words.as_str())
    }

    pub fn form_network(&self) -> NetworkChoice {
        self.form.network
    }

    pub fn snapshot(&self) -> Option<&WalletSnapshot> {
        self.snapshot.as_ref()
    }

    fn visible_buttons(&self) -> Vec<String> {
        match self.screen {
            ScreenKind::Welcome => vec![
                "Open wallet".into(),
                "Create wallet".into(),
                "Ledger Nano".into(),
                "Restore from seed".into(),
                "Classic CLI".into(),
                "Quit".into(),
            ],
            ScreenKind::Create => vec!["Create".into(), "Cancel".into()],
            ScreenKind::Restore => vec!["Restore".into(), "Cancel".into()],
            ScreenKind::Ledger => vec!["Connect Ledger".into(), "Cancel".into()],
            ScreenKind::Open => vec!["Open".into(), "Cancel".into()],
            ScreenKind::SeedBackup => vec!["I have written the seed down".into()],
            ScreenKind::Home => vec!["Refresh".into()],
            ScreenKind::Receive => vec!["New subaddress".into()],
            ScreenKind::Send if self.review.is_some() => {
                vec!["Confirm and submit".into(), "Cancel payment".into()]
            }
            ScreenKind::Send => vec!["Review payment".into()],
            ScreenKind::Activity => vec!["Refresh".into()],
            ScreenKind::Help => vec![],
            ScreenKind::Menu => self.settings_menu_titles(),
            ScreenKind::Settings => vec!["Show recovery seed".into(), "Lock app now".into()],
            ScreenKind::Wallets => vec!["Open wallet".into(), "Create wallet".into()],
            ScreenKind::Node => vec!["Check connections".into(), "Reset defaults".into()],
            ScreenKind::Mfw => vec!["Check name".into(), "Continue".into()],
            ScreenKind::Project => vec!["Back".into()],
        }
    }

    fn settings_menu_titles(&self) -> Vec<String> {
        menu_items()
            .into_iter()
            .map(|item| item.title.to_owned())
            .collect()
    }

    fn current_address(&self) -> Option<String> {
        if let Some(backup) = &self.seed_backup {
            return Some(backup.address.clone());
        }
        self.subaddresses
            .first()
            .map(|item| item.address.clone())
            .or_else(|| {
                self.snapshot
                    .as_ref()
                    .map(|snapshot| snapshot.primary_address.clone())
            })
    }

    fn insert_char(&mut self, ch: char) {
        if ch == '\n' {
            return;
        }
        match self.form.focus {
            Field::WalletPath => self.form.wallet_path.push(ch),
            Field::Password => self.form.password.push(ch),
            Field::Seed => self.form.seed.push(ch),
            Field::RestoreHeight => {
                if ch.is_ascii_digit() {
                    self.form.restore_height.push(ch);
                }
            }
            Field::Address => self.form.address.push(ch),
            Field::Amount => {
                if ch.is_ascii_digit() || ch == '.' {
                    self.form.amount.push(ch);
                }
            }
            Field::SubaddressLabel => self.form.subaddress_label.push(ch),
            Field::Command => self.form.command.push(ch),
            Field::PrivateWorker => self.settings.private_worker.push(ch),
            Field::AppPassword => self.settings.app_password.push(ch),
            Field::AppPasswordConfirm => self.settings.app_password_confirm.push(ch),
            Field::CurrentAppPassword => self.settings.current_app_password.push(ch),
            Field::MfwName => {
                if ch.is_ascii_alphanumeric() || ch == '-' {
                    self.settings.mfw_name.push(ch.to_ascii_lowercase());
                    self.mfw_available = false;
                    self.mfw_step = 1;
                    self.mfw_status = "Name changed. Check availability again.".into();
                }
            }
            Field::NodeDaemon => {
                self.settings.daemon_address.push(ch);
                self.settings.persist();
            }
            Field::NodeGrpc => {
                self.settings.grpc_endpoint.push(ch);
                self.settings.persist();
            }
            Field::NodeProxy => {
                self.settings.proxy_address.push(ch);
                self.settings.persist();
            }
        }
    }

    fn backspace(&mut self) {
        match self.form.focus {
            Field::WalletPath => {
                self.form.wallet_path.pop();
            }
            Field::Password => {
                self.form.password.pop();
            }
            Field::Seed => {
                self.form.seed.pop();
            }
            Field::RestoreHeight => {
                self.form.restore_height.pop();
            }
            Field::Address => {
                self.form.address.pop();
            }
            Field::Amount => {
                self.form.amount.pop();
            }
            Field::SubaddressLabel => {
                self.form.subaddress_label.pop();
            }
            Field::Command => {
                self.form.command.pop();
            }
            Field::PrivateWorker => {
                self.settings.private_worker.pop();
            }
            Field::AppPassword => {
                self.settings.app_password.pop();
            }
            Field::AppPasswordConfirm => {
                self.settings.app_password_confirm.pop();
            }
            Field::CurrentAppPassword => {
                self.settings.current_app_password.pop();
            }
            Field::MfwName => {
                self.settings.mfw_name.pop();
            }
            Field::NodeDaemon => {
                self.settings.daemon_address.pop();
                self.settings.persist();
            }
            Field::NodeGrpc => {
                self.settings.grpc_endpoint.pop();
                self.settings.persist();
            }
            Field::NodeProxy => {
                self.settings.proxy_address.pop();
                self.settings.persist();
            }
        }
    }

    fn cancel(&mut self) {
        self.error = None;
        self.settings.seed_reveal = None;
        if self.snapshot.is_some() {
            if matches!(
                self.screen,
                ScreenKind::Settings
                    | ScreenKind::Wallets
                    | ScreenKind::Node
                    | ScreenKind::Mfw
                    | ScreenKind::Project
            ) {
                self.tab = Tab::Menu;
                self.screen = ScreenKind::Menu;
                return;
            }
            self.screen = ScreenKind::Home;
            self.tab = Tab::Home;
            return;
        }
        self.screen = ScreenKind::Welcome;
    }

    fn submit(&mut self) {
        self.error = None;
        match self.screen {
            ScreenKind::Create => self.create(),
            ScreenKind::Restore => self.restore(),
            ScreenKind::Ledger => self.create_ledger(),
            ScreenKind::Open => self.open(),
            ScreenKind::Send => self.review_send(),
            ScreenKind::Welcome => {}
            _ => {}
        }
    }

    fn create_ledger(&mut self) {
        self.error = None;
        let height = self.form.restore_height.parse().unwrap_or(0);
        if height <= 1 {
            self.error =
                Some("Choose a Ledger scan start height before its first transaction.".into());
            return;
        }
        let path = if self.form.wallet_path.trim().is_empty() {
            default_ledger_path()
        } else {
            self.form.wallet_path.trim().to_owned()
        };
        self.status =
            "Keep the Ledger unlocked, open the Monero app, and confirm on the device.".into();
        match self.backend.create_from_device(HardwareCreateRequest {
            path: PathBuf::from(&path),
            password: self.form.password.clone(),
            network: self.form.network,
            restore_height: height,
            transport: self.form.ledger_transport,
        }) {
            Ok(snapshot) => {
                self.form.password.zeroize();
                self.enter_open(snapshot);
                self.status = "Ledger wallet created. Seed remains on the Nano.".into();
            }
            Err(error) => self.error = Some(error.to_string()),
        }
    }

    fn create(&mut self) {
        if self.form.wallet_path.trim().is_empty() {
            self.error = Some("Enter a wallet file name.".into());
            return;
        }
        match self.backend.create_wallet(crate::backend::CreateRequest {
            path: PathBuf::from(self.form.wallet_path.trim()),
            password: self.form.password.clone(),
            network: self.form.network,
        }) {
            Ok(created) => self.enter_seed_backup(created),
            Err(error) => self.error = Some(error.to_string()),
        }
    }

    fn restore(&mut self) {
        let height = self.form.restore_height.parse().unwrap_or(0);
        match self.backend.restore_wallet(crate::backend::RestoreRequest {
            path: PathBuf::from(self.form.wallet_path.trim()),
            password: self.form.password.clone(),
            seed: self.form.seed.clone(),
            restore_height: height,
            network: self.form.network,
        }) {
            Ok(snapshot) => {
                self.form.seed.zeroize();
                self.enter_open(snapshot);
                self.status =
                    "Wallet restored. Confirm the seed backup before receiving funds.".into();
                self.screen = ScreenKind::SeedBackup;
                self.seed_backup = Some(SeedBackup {
                    words: Zeroizing::new(
                        "Write the original 25 words down again if you have not already.".into(),
                    ),
                    address: self
                        .snapshot
                        .as_ref()
                        .map(|item| item.primary_address.clone())
                        .unwrap_or_default(),
                });
            }
            Err(error) => self.error = Some(error.to_string()),
        }
    }

    fn open(&mut self) {
        let path = crate::wallets::resolve_existing_wallet(&self.form.wallet_path);
        match self.backend.open_wallet(crate::backend::OpenRequest {
            path: path.clone(),
            password: self.form.password.clone(),
            network: self.form.network,
        }) {
            Ok(snapshot) => self.enter_open(snapshot),
            Err(error) => {
                self.error = Some(explain_open_error(&error.to_string(), &path));
            }
        }
    }

    fn enter_seed_backup(&mut self, created: CreatedWallet) {
        self.snapshot = Some(created.snapshot);
        self.seed_backup = Some(SeedBackup {
            words: created.seed,
            address: created.address,
        });
        self.screen = ScreenKind::SeedBackup;
        self.status = "Write these 25 words down offline. They are the only recovery path.".into();
        self.form.password.zeroize();
    }

    fn confirm_seed(&mut self) {
        if self.seed_backup.is_none() {
            self.error = Some("No recovery seed is waiting for confirmation.".into());
            return;
        }
        if let Err(error) = self.backend.confirm_seed_backup() {
            self.error = Some(error.to_string());
            return;
        }
        if let Some(mut backup) = self.seed_backup.take() {
            backup.words.zeroize();
        }
        self.enter_home();
        self.status = format!(
            "Seed backup confirmed. Connecting to {}…",
            self.settings.cli_connection().daemon_address
        );
    }

    fn enter_open(&mut self, snapshot: WalletSnapshot) {
        self.snapshot = Some(snapshot);
        self.form.password.zeroize();
        self.enter_home();
    }

    fn enter_home(&mut self) {
        self.screen = ScreenKind::Home;
        self.tab = Tab::Home;
        self.capture_start_height();
        self.reload_receive();
        self.status = format!(
            "Connecting to {}…",
            self.settings.cli_connection().daemon_address
        );
        // Refresh on the next tick so the Home screen can paint first.
        self.ticks_since_refresh = 14;
    }

    fn on_tick(&mut self) {
        self.poll_node_diagnostics();
        self.poll_mfw_check();
        if let Some(result) = self.backend.poll_background_refresh() {
            self.apply_refresh_result(result);
            return;
        }
        let scanning = self
            .snapshot
            .as_ref()
            .is_some_and(|snapshot| !snapshot.synchronized && self.seed_backup.is_none());
        if !scanning {
            return;
        }
        self.ticks_since_refresh = self.ticks_since_refresh.saturating_add(1);
        if self.ticks_since_refresh >= 15 {
            self.ticks_since_refresh = 0;
            self.request_refresh();
        }
    }

    fn capture_start_height(&mut self) {
        if self.start_height.is_some() {
            return;
        }
        let restore: u64 = self.form.restore_height.parse().unwrap_or(0);
        if restore > 0 {
            self.start_height = Some(restore);
            return;
        }
        if let Some(snapshot) = &self.snapshot {
            if snapshot.height > 0 {
                self.start_height = Some(snapshot.height);
            }
        }
    }

    fn update_eta_baseline(&mut self) {
        let Some(snapshot) = &self.snapshot else {
            return;
        };
        if snapshot.synchronized {
            self.eta_started = None;
            self.eta_start_remaining = None;
            return;
        }
        let remaining = present_wallet_sync(
            snapshot.height,
            snapshot.daemon_height,
            snapshot.daemon_target_height,
            snapshot.synchronized,
            self.start_height,
        )
        .remaining_blocks;
        if self.eta_started.is_none() {
            self.eta_started = Some(Instant::now());
            self.eta_start_remaining = remaining;
        }
    }

    fn request_refresh(&mut self) {
        self.apply_node();
        if self.backend.start_background_refresh() {
            if self.status.is_empty() || self.status.contains("Connecting") {
                self.status = format!(
                    "Connecting to {}…",
                    self.settings.cli_connection().daemon_address
                );
            }
            return;
        }
        self.refresh();
    }

    fn apply_refresh_result(
        &mut self,
        result: Result<crate::backend::WalletSnapshot, crate::backend::BackendError>,
    ) {
        match result {
            Ok(snapshot) => {
                if self.start_height.is_none() && snapshot.height > 0 {
                    self.start_height = Some(snapshot.height);
                }
                self.snapshot = Some(snapshot);
                self.update_eta_baseline();
                let sync = self.sync_view();
                self.status = if sync.ready {
                    "Synchronized.".into()
                } else {
                    sync.compact
                };
            }
            Err(error) => self.error = Some(error.to_string()),
        }
    }

    fn refresh(&mut self) {
        self.apply_node();
        let result = self.backend.refresh();
        self.apply_refresh_result(result);
    }

    fn sync_view(&self) -> SyncView {
        let Some(snapshot) = &self.snapshot else {
            return SyncView {
                compact: "Connecting node".into(),
                ready: false,
                failed: false,
                working: false,
                percent: None,
                phase: "Connecting node".into(),
                height: None,
                remaining: None,
                eta: None,
                blockchain_percent: None,
                blockchain_height: None,
                blockchain_detail: "Selecting sync source".into(),
            };
        };
        let presented = present_wallet_sync(
            snapshot.height,
            snapshot.daemon_height,
            snapshot.daemon_target_height,
            snapshot.synchronized,
            self.start_height,
        );
        let failed = snapshot.connection_failed && !snapshot.synchronized;
        let height = presented.target_height.map(|target| {
            format!(
                "Block {} of {}",
                format_block_count(presented.wallet_height),
                format_block_count(target)
            )
        });
        let remaining = presented
            .remaining_blocks
            .filter(|count| *count > 0)
            .map(|count| format!("{} blocks remaining", format_block_count(count)));
        let eta = match (
            presented.phase,
            presented.remaining_blocks,
            self.eta_started,
            self.eta_start_remaining,
        ) {
            (SyncPhase::Syncing, Some(remaining), Some(started), Some(start_remaining))
                if start_remaining > remaining && started.elapsed().as_secs() >= 3 =>
            {
                let scanned = start_remaining - remaining;
                let seconds =
                    started.elapsed().as_secs().saturating_mul(remaining) / scanned.max(1);
                Some(format_eta_seconds(seconds))
            }
            (SyncPhase::Syncing, Some(_), _, _) => Some("Calculating time remaining".into()),
            (SyncPhase::Finalizing, _, _, _) => Some("Waiting for wallet confirmation".into()),
            _ => None,
        };
        let blockchain_ready = snapshot.daemon_height > 0 && !failed;
        let blockchain_percent = if snapshot.synchronized {
            Some(100)
        } else if snapshot.daemon_target_height > 0 {
            Some(
                ((snapshot.daemon_height.saturating_mul(100))
                    / snapshot.daemon_target_height.max(1))
                .min(99) as u8,
            )
        } else {
            presented.progress
        };
        SyncView {
            compact: compact_status(presented.phase, presented.progress, failed),
            ready: presented.core_confirmed,
            failed,
            working: matches!(presented.phase, SyncPhase::Syncing | SyncPhase::Finalizing)
                && !failed,
            percent: presented.progress,
            phase: phase_label(presented.phase, failed).into(),
            height,
            remaining,
            eta,
            blockchain_percent: if failed { None } else { blockchain_percent },
            blockchain_height: if snapshot.daemon_target_height > 0 || snapshot.daemon_height > 0 {
                Some(format!(
                    "Block {} of {}",
                    format_block_count(snapshot.daemon_height.max(presented.wallet_height)),
                    format_block_count(
                        snapshot
                            .daemon_target_height
                            .max(snapshot.daemon_height)
                            .max(presented.target_height.unwrap_or(0))
                    )
                ))
            } else {
                None
            },
            blockchain_detail: if failed {
                format!("Retrying {}", self.settings.cli_connection().daemon_address)
            } else if blockchain_ready && snapshot.synchronized {
                "Up to date".into()
            } else if blockchain_ready {
                "Downloading blocks".into()
            } else {
                "Selecting sync source".into()
            },
        }
    }

    fn new_subaddress(&mut self) {
        let label = self.form.subaddress_label.trim().to_owned();
        match self.backend.create_subaddress(0, &label) {
            Ok(sub) => {
                self.status = format!("Created {}", sub.label);
                self.form.subaddress_label.clear();
                self.reload_receive();
            }
            Err(error) => self.error = Some(error.to_string()),
        }
    }

    fn review_send(&mut self) {
        self.error = None;
        let amount = match parse_xmr_to_atomic(&self.form.amount) {
            Ok(value) => value,
            Err(error) => {
                self.error = Some(error.to_string());
                return;
            }
        };
        match self.backend.prepare_send(SendRequest {
            address: self.form.address.trim().to_owned(),
            amount_atomic: amount,
        }) {
            Ok(prepared) => {
                self.review = Some(prepared);
                self.screen = ScreenKind::Send;
                self.tab = Tab::Send;
                self.status = "Review the payment. Nothing has been broadcast.".into();
            }
            Err(error) => self.error = Some(error.to_string()),
        }
    }

    fn confirm_send(&mut self) {
        let Some(prepared) = self.review.clone() else {
            self.error = Some("Review the payment before submitting it.".into());
            return;
        };
        match self.backend.commit_send(&prepared) {
            Ok(submitted) => {
                self.review = None;
                self.form.address.clear();
                self.form.amount.clear();
                self.status = format!("Submitted {}", submitted.txid);
                self.reload_activity();
                if let Ok(snapshot) = self.backend.snapshot() {
                    self.snapshot = Some(snapshot);
                }
            }
            Err(error) => self.error = Some(error.to_string()),
        }
    }

    fn reload_activity(&mut self) {
        match self.backend.transactions(25) {
            Ok(items) => self.transactions = items,
            Err(error) => self.error = Some(error.to_string()),
        }
    }

    fn reload_receive(&mut self) {
        if let Ok(address) = self.backend.address(0, 0) {
            self.subaddresses = vec![Subaddress {
                index: 0,
                address,
                label: "Primary address".into(),
            }];
        }
    }

    fn run_command(&mut self) -> RunOutcome {
        let command = self.form.command.trim().to_owned();
        self.form.command.clear();
        if command.is_empty() {
            return RunOutcome::Continue;
        }
        match command.as_str() {
            "q" | "quit" | "exit" => self.handle(Action::Quit),
            "h" | "?" | "help" => self.handle(Action::GoTab(Tab::Help)),
            "b" | "balance" => self.handle(Action::GoTab(Tab::Home)),
            "a" | "address" => self.handle(Action::GoTab(Tab::Receive)),
            "m" | "menu" => self.handle(Action::GoTab(Tab::Menu)),
            "settings" => self.handle(Action::OpenMenu(MenuItem::Settings)),
            "wallets" => self.handle(Action::OpenMenu(MenuItem::Wallets)),
            "node" => self.handle(Action::OpenMenu(MenuItem::Node)),
            "mfw" => self.handle(Action::OpenMenu(MenuItem::MfwNames)),
            "r" | "refresh" => {
                self.request_refresh();
                RunOutcome::Continue
            }
            "txs" | "show_transfers" => self.handle(Action::GoTab(Tab::Activity)),
            other if other.starts_with("send ") => {
                let mut parts = other.split_whitespace();
                parts.next();
                self.form.address = parts.next().unwrap_or("").to_owned();
                self.form.amount = parts.next().unwrap_or("").to_owned();
                self.tab = Tab::Send;
                self.screen = ScreenKind::Send;
                self.review_send();
                RunOutcome::Continue
            }
            other if other.starts_with("a new ") => {
                self.form.subaddress_label = other.trim_start_matches("a new ").to_owned();
                self.new_subaddress();
                RunOutcome::Continue
            }
            _ => {
                self.error = Some(format!("Unknown command: {command}"));
                RunOutcome::Continue
            }
        }
    }

    fn open_menu_item(&mut self, item: MenuItem) {
        self.tab = Tab::Menu;
        self.error = None;
        self.settings.seed_reveal = None;
        self.settings.scroll = 0;
        self.screen = match item {
            MenuItem::Wallets => ScreenKind::Wallets,
            MenuItem::MfwNames => ScreenKind::Mfw,
            MenuItem::Settings => ScreenKind::Settings,
            MenuItem::Node => ScreenKind::Node,
            MenuItem::Project => ScreenKind::Project,
        };
        self.status = match item {
            MenuItem::Settings => "Settings".into(),
            MenuItem::Wallets => "Manage wallets".into(),
            MenuItem::MfwNames => "Your Address Names".into(),
            MenuItem::Node => "Node Status".into(),
            MenuItem::Project => "Project Page".into(),
        };
        if item == MenuItem::Wallets {
            self.reload_wallet_list();
        }
        if item == MenuItem::Node && !cfg!(test) {
            self.start_node_diagnostics();
        }
        if item == MenuItem::Settings {
            self.form.focus = Field::Command;
        }
        if item == MenuItem::MfwNames {
            self.form.focus = Field::MfwName;
        }
    }

    fn handle_settings(&mut self, action: SettingsAction) {
        self.error = None;
        match action {
            SettingsAction::ChooseRecommendedWorker => {
                self.settings.worker = WorkerKind::Recommended;
                self.settings.worker_label = "Recommended".into();
                self.settings.persist();
                self.settings.message = Some("Fast Wallet Worker selected.".into());
                self.status = "Fast Wallet Worker selected.".into();
            }
            SettingsAction::TogglePrivateWorker => {
                self.settings.show_private_worker = !self.settings.show_private_worker;
                if self.settings.show_private_worker {
                    self.form.focus = Field::PrivateWorker;
                }
            }
            SettingsAction::UsePrivateWorker => {
                let descriptor = self.settings.private_worker.trim().to_owned();
                if descriptor.is_empty() {
                    self.error = Some("Paste Worker QR text or descriptor".into());
                    return;
                }
                self.settings.worker = WorkerKind::Private;
                self.settings.worker_label = "Private Worker".into();
                self.settings.show_private_worker = false;
                self.settings.persist();
                self.status = "Fast Wallet Worker selected.".into();
            }
            SettingsAction::CycleLanguage => self.settings.cycle_language(),
            SettingsAction::SetCompute(backend) => self.settings.set_compute(backend),
            SettingsAction::ToggleShareSearches => {
                self.settings.share_searches = !self.settings.share_searches;
                self.settings.persist();
                self.status = if self.settings.share_searches {
                    "Community search sharing is on.".into()
                } else {
                    "Community search sharing is off.".into()
                };
            }
            SettingsAction::RevealSeed => self.reveal_recovery_seed(),
            SettingsAction::RecheckLedger => {
                if self.snapshot.as_ref().is_some_and(|item| item.hardware) {
                    self.status = "Ledger spend outputs are up to date.".into();
                    self.refresh();
                } else {
                    self.error = Some("Recheck with Ledger is only for a hardware wallet.".into());
                }
            }
            SettingsAction::LockNow => {
                if self.settings.protection == ProtectionMode::None {
                    self.error = Some(
                        "No app protection is active. Choose a method below to enable it.".into(),
                    );
                } else {
                    self.settings.locked = true;
                    self.status = "App locked.".into();
                }
            }
            SettingsAction::SetProtection(mode) => {
                self.settings.protection = mode;
                self.settings.app_password.clear();
                self.settings.app_password_confirm.clear();
                if mode == ProtectionMode::Password {
                    self.form.focus = Field::AppPassword;
                }
            }
            SettingsAction::SaveProtection => self.save_app_protection(),
            SettingsAction::CycleAutoLock => self.settings.cycle_auto_lock(),
            SettingsAction::OpenProject => self.open_menu_item(MenuItem::Project),
            SettingsAction::OpenMfwRegistry => self.open_menu_item(MenuItem::MfwNames),
            SettingsAction::Scroll(delta) => {
                let next = i32::from(self.settings.scroll) + i32::from(delta);
                self.settings.scroll = next.max(0) as u16;
            }
            SettingsAction::CycleNodeNetwork => {
                self.settings.node_network = self.settings.node_network.next();
                self.settings.persist();
                self.apply_node();
            }
            SettingsAction::SetNodeMode(mode) => {
                self.settings.node_mode = mode;
                self.settings.persist();
                self.apply_node();
            }
            SettingsAction::ChooseClearnet(preset) => {
                self.settings.apply_node_preset(preset, false);
            }
            SettingsAction::ChooseOnion(preset) => {
                self.settings.apply_node_preset(preset, true);
            }
            SettingsAction::ResetNodeDefaults => self.settings.reset_node_defaults(),
            SettingsAction::RunDiagnostics => self.start_node_diagnostics(),
            SettingsAction::CheckMfwName => self.start_mfw_check(),
            SettingsAction::ContinueMfw => self.continue_mfw(),
            SettingsAction::CycleMfwYears => {
                self.settings.mfw_years = match self.settings.mfw_years {
                    1 => 2,
                    2 => 5,
                    5 => 10,
                    10 => 25,
                    25 => 100,
                    _ => 1,
                };
            }
        }
        if let Some(message) = &self.settings.message {
            self.status = message.clone();
        }
        self.apply_node();
    }

    fn reveal_recovery_seed(&mut self) {
        if self.snapshot.as_ref().is_some_and(|item| item.hardware) {
            self.error = Some("The recovery seed remains on the Ledger device.".into());
            return;
        }
        match self.backend.recovery_seed() {
            Ok(seed) => {
                self.settings.seed_reveal = Some(seed);
                self.status = "Show it only when you need to verify your backup.".into();
            }
            Err(error) => self.error = Some(error.to_string()),
        }
    }

    fn save_app_protection(&mut self) {
        match self.settings.protection {
            ProtectionMode::None => {
                self.error = Some("Choose Touch ID or an app password first.".into());
            }
            ProtectionMode::System => {
                self.settings.persist();
                self.status = format!(
                    "{} now protects this app.",
                    SettingsState::system_auth_label()
                );
            }
            ProtectionMode::Password => {
                if self.settings.app_password.len() < 12 {
                    self.error = Some("Use an app password with at least 12 characters.".into());
                    return;
                }
                if self.settings.app_password.as_str()
                    != self.settings.app_password_confirm.as_str()
                {
                    self.error = Some("The two app passwords do not match.".into());
                    return;
                }
                self.settings.app_password.clear();
                self.settings.app_password_confirm.clear();
                self.settings.current_app_password.clear();
                self.settings.persist();
                self.status = "Your app password now protects this app.".into();
            }
        }
    }

    pub fn revealed_seed(&self) -> Option<&str> {
        self.settings.seed_reveal.as_ref().map(|seed| seed.as_str())
    }

    fn start_node_diagnostics(&mut self) {
        if self.node_checking {
            return;
        }
        self.node_checking = true;
        self.status = "Checking node routes…".into();
        let daemon = self.settings.daemon_address.clone();
        let grpc = self.settings.grpc_endpoint.clone();
        let proxy = self.settings.proxy_address.clone();
        let optimized = self.settings.node_mode == crate::settings::NodeMode::OptimizedGrpc;
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let results =
                crate::node_probe::run_node_diagnostics(&daemon, &grpc, &proxy, optimized);
            let _ = tx.send(results);
        });
        self.node_probe_rx = Some(rx);
    }

    fn poll_node_diagnostics(&mut self) {
        let received = match self.node_probe_rx.as_ref() {
            Some(rx) => match rx.try_recv() {
                Ok(results) => Some(Ok(results)),
                Err(std::sync::mpsc::TryRecvError::Empty) => return,
                Err(std::sync::mpsc::TryRecvError::Disconnected) => Some(Err(())),
            },
            None => return,
        };
        self.node_probe_rx = None;
        self.node_checking = false;
        match received {
            Some(Ok(results)) => {
                let failed = results.iter().filter(|item| !item.connected).count();
                let ok = results.iter().filter(|item| item.connected).count();
                self.node_probes = results;
                self.status = format!("Node check: {ok} reachable, {failed} failed");
            }
            _ => {
                self.error = Some("Node check stopped.".into());
            }
        }
    }

    fn start_mfw_check(&mut self) {
        if self.mfw_checking {
            return;
        }
        let name = self.settings.mfw_name.clone();
        match crate::mfw_check::canonical_name(&name) {
            Ok(canonical) => {
                self.mfw_checking = true;
                self.mfw_available = false;
                self.mfw_status = format!("Checking {canonical} privately through Tor…");
                self.status = self.mfw_status.clone();
            }
            Err(error) => {
                self.mfw_status = error.clone();
                self.error = Some(error);
                return;
            }
        }
        let network = self
            .snapshot
            .as_ref()
            .map(|item| item.network.label().to_owned())
            .unwrap_or_else(|| self.form.network.label().to_owned());
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let _ = tx.send(crate::mfw_check::check_name(&name, &network));
        });
        self.mfw_rx = Some(rx);
    }

    fn poll_mfw_check(&mut self) {
        let received = match self.mfw_rx.as_ref() {
            Some(rx) => match rx.try_recv() {
                Ok(result) => Some(result),
                Err(std::sync::mpsc::TryRecvError::Empty) => return,
                Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                    Some(Err("Name check stopped.".into()))
                }
            },
            None => return,
        };
        self.mfw_rx = None;
        self.mfw_checking = false;
        match received {
            Some(Ok(result)) => {
                self.mfw_available = crate::mfw_check::is_free(&result.status);
                self.mfw_status = if result.chain_tip_height > 0 {
                    format!("{}  Chain tip {}.", result.detail, result.chain_tip_height)
                } else {
                    result.detail
                };
                self.status = self.mfw_status.clone();
            }
            Some(Err(error)) => {
                self.mfw_available = false;
                self.mfw_status = error.clone();
                self.error = Some(error);
            }
            None => {
                self.mfw_available = false;
                self.mfw_status = "Name check stopped.".into();
            }
        }
    }

    fn continue_mfw(&mut self) {
        if self.mfw_checking {
            self.error = Some("Wait for the name check to finish.".into());
            return;
        }
        match self.mfw_step {
            1 => {
                if !self.mfw_available {
                    self.error =
                        Some("Check the name first. Continue is enabled when it is available.".into());
                    return;
                }
                self.mfw_step = 2;
                self.mfw_status = format!(
                    "Step 2: confirm {} year(s) and the receive address.",
                    self.settings.mfw_years
                );
            }
            2 => {
                self.mfw_step = 3;
                self.mfw_status =
                    "Step 3: on-chain commit still requires the desktop wallet (review + spend)."
                        .into();
            }
            _ => {
                self.mfw_status = format!(
                    "Ready to commit {}.mfw for {} year(s) in the desktop app.",
                    self.settings.mfw_name.trim_end_matches(".mfw"),
                    self.settings.mfw_years
                );
            }
        }
        self.status = self.mfw_status.clone();
    }
}

fn header_for(screen: ScreenKind) -> String {
    match screen {
        ScreenKind::Welcome => "Welcome".into(),
        ScreenKind::Open => "Open".into(),
        ScreenKind::Create => "Create".into(),
        ScreenKind::Restore => "Restore".into(),
        ScreenKind::Ledger => "Ledger".into(),
        ScreenKind::SeedBackup => "Backup".into(),
        ScreenKind::Home => "Home".into(),
        ScreenKind::Receive => "Receive".into(),
        ScreenKind::Send => "Send".into(),
        ScreenKind::Activity => "Activity".into(),
        ScreenKind::Help => "Help".into(),
        ScreenKind::Menu => "Menu".into(),
        ScreenKind::Settings => "Settings".into(),
        ScreenKind::Wallets => "Wallets".into(),
        ScreenKind::Node => "Node".into(),
        ScreenKind::Mfw => "Names".into(),
        ScreenKind::Project => "Project".into(),
    }
}

fn default_ledger_path() -> String {
    crate::wallets::search_roots()
        .into_iter()
        .find(|(label, _)| label == "Desktop app")
        .map(|(_, root)| root.join("ledger-nano").display().to_string())
        .unwrap_or_else(|| "ledger-nano".into())
}

fn resolve_wallet_path(input: &str) -> PathBuf {
    let trimmed = input.trim();
    let path = PathBuf::from(trimmed);
    if path.is_absolute() || trimmed.is_empty() {
        path
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(path)
    }
}

pub fn discover_wallets() -> Vec<crate::wallets::KnownWallet> {
    crate::wallets::discover_wallets()
}

fn explain_open_error(raw: &str, path: &std::path::Path) -> String {
    let lower = raw.to_ascii_lowercase();
    if lower.contains("key file not found") || lower.contains("wallet file not found") {
        let cwd = std::env::current_dir()
            .map(|dir| dir.display().to_string())
            .unwrap_or_else(|_| ".".into());
        let nearby = discover_wallets();
        let nearby_text = if nearby.is_empty() {
            "No .keys wallets in this folder.".to_owned()
        } else {
            format!(
                "Wallets here: {}",
                nearby
                    .iter()
                    .map(|wallet| wallet.label.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        };
        format!(
            "No wallet '{}' in {}. {} Use Create for a new name, or click a listed wallet.",
            resolve_wallet_path(&path.to_string_lossy()).display(),
            cwd,
            nearby_text
        )
    } else {
        raw.to_owned()
    }
}

fn screen_for_tab(tab: Tab) -> ScreenKind {
    match tab {
        Tab::Home => ScreenKind::Home,
        Tab::Receive => ScreenKind::Receive,
        Tab::Send => ScreenKind::Send,
        Tab::Menu => ScreenKind::Menu,
        Tab::Activity => ScreenKind::Activity,
        Tab::Help => ScreenKind::Help,
    }
}

fn primary_tab(tab: Tab) -> Tab {
    match tab {
        Tab::Activity => Tab::Home,
        Tab::Help => Tab::Menu,
        other => other,
    }
}
