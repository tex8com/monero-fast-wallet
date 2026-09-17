use crate::settings::{ComputeBackend, MenuItem, NodeMode, NodePreset, ProtectionMode};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tab {
    Home,
    Send,
    Receive,
    Menu,
    Activity,
    Help,
}

impl Tab {
    /// Desktop primary nav: Home, Send, Receive, Menu.
    pub const ALL: [Tab; 4] = [Tab::Home, Tab::Send, Tab::Receive, Tab::Menu];

    pub fn title(self) -> &'static str {
        match self {
            Tab::Home => "Home",
            Tab::Send => "Send",
            Tab::Receive => "Receive",
            Tab::Menu => "Menu",
            Tab::Activity => "Activity",
            Tab::Help => "Help",
        }
    }

    pub fn next(self) -> Tab {
        match self {
            Tab::Home => Tab::Send,
            Tab::Send => Tab::Receive,
            Tab::Receive => Tab::Menu,
            Tab::Menu | Tab::Activity | Tab::Help => Tab::Home,
        }
    }

    pub fn previous(self) -> Tab {
        match self {
            Tab::Home | Tab::Activity | Tab::Help => Tab::Menu,
            Tab::Send => Tab::Home,
            Tab::Receive => Tab::Send,
            Tab::Menu => Tab::Receive,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Field {
    WalletPath,
    Password,
    Seed,
    RestoreHeight,
    Address,
    Amount,
    SubaddressLabel,
    Command,
    PrivateWorker,
    AppPassword,
    AppPasswordConfirm,
    CurrentAppPassword,
    MfwName,
    NodeDaemon,
    NodeGrpc,
    NodeProxy,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NetworkChoice {
    Mainnet,
    Stagenet,
    Testnet,
}

impl NetworkChoice {
    pub fn label(self) -> &'static str {
        match self {
            NetworkChoice::Mainnet => "mainnet",
            NetworkChoice::Stagenet => "stagenet",
            NetworkChoice::Testnet => "testnet",
        }
    }

    pub fn next(self) -> Self {
        match self {
            NetworkChoice::Mainnet => NetworkChoice::Stagenet,
            NetworkChoice::Stagenet => NetworkChoice::Testnet,
            NetworkChoice::Testnet => NetworkChoice::Mainnet,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Action {
    Quit,
    LaunchClassic,
    SelectOpen,
    SelectCreate,
    SelectRestore,
    SelectLedger,
    Submit,
    Cancel,
    ConfirmSeedBackup,
    GoTab(Tab),
    CycleNetwork,
    SetNetwork(NetworkChoice),
    Focus(Field),
    InsertChar(char),
    Backspace,
    Tick,
    Refresh,
    NewSubaddress,
    ReviewSend,
    ConfirmSend,
    CancelSend,
    RunCommand,
    SetWalletPath(String),
    SetLedgerTransport(LedgerTransport),
    MouseClick { column: u16, row: u16 },
    OpenMenu(MenuItem),
    Settings(SettingsAction),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SettingsAction {
    ChooseRecommendedWorker,
    TogglePrivateWorker,
    UsePrivateWorker,
    CycleLanguage,
    SetCompute(ComputeBackend),
    ToggleShareSearches,
    RevealSeed,
    RecheckLedger,
    LockNow,
    SetProtection(ProtectionMode),
    SaveProtection,
    CycleAutoLock,
    OpenProject,
    OpenMfwRegistry,
    Scroll(i16),
    CycleNodeNetwork,
    SetNodeMode(NodeMode),
    ChooseClearnet(NodePreset),
    ChooseOnion(NodePreset),
    ResetNodeDefaults,
    RunDiagnostics,
    CheckMfwName,
    ContinueMfw,
    CycleMfwYears,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LedgerTransport {
    Usb,
    Ble,
}

impl LedgerTransport {
    pub fn label(self) -> &'static str {
        match self {
            LedgerTransport::Usb => "USB",
            LedgerTransport::Ble => "Bluetooth",
        }
    }

    pub fn device_name(self) -> &'static str {
        match self {
            LedgerTransport::Usb => "Ledger",
            LedgerTransport::Ble => "Ledger:ble",
        }
    }
}
