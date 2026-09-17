use monero_fast_wallet_tui::backend::{CreateRequest, MemoryBackend, WalletBackend};
use monero_fast_wallet_tui::{Action, App, RunOutcome, ScreenKind, Tab};

fn open_funded_wallet() -> App {
    let mut app = App::new(Box::new(MemoryBackend::new()));
    assert_eq!(app.handle(Action::SelectCreate), RunOutcome::Continue);
    type_path_and_password(&mut app, "alice", "secret");
    assert_eq!(app.handle(Action::Submit), RunOutcome::Continue);
    let view = app.view_model();
    assert_eq!(view.screen, ScreenKind::SeedBackup);
    assert_eq!(view.seed_word_count, 25);
    assert!(view.seed_visible);
    assert_eq!(app.handle(Action::GoTab(Tab::Send)), RunOutcome::Continue);
    assert_eq!(
        app.view_model().error.as_deref(),
        Some("Confirm the recovery seed backup first.")
    );
    assert_eq!(app.handle(Action::ConfirmSeedBackup), RunOutcome::Continue);
    assert_eq!(app.view_model().screen, ScreenKind::Home);
    assert!(!app.view_model().seed_visible);
    app
}

#[test]
fn mfw_page_has_check_and_continue_buttons() {
    let mut app = open_funded_wallet();
    assert_eq!(
        app.handle(Action::OpenMenu(
            monero_fast_wallet_tui::settings::MenuItem::MfwNames
        )),
        RunOutcome::Continue
    );
    assert_eq!(app.view_model().screen, ScreenKind::Mfw);
    assert!(app
        .view_model()
        .buttons
        .iter()
        .any(|item| item == "Check name"));
    assert!(app
        .view_model()
        .buttons
        .iter()
        .any(|item| item == "Continue"));
    app.handle(Action::Settings(
        monero_fast_wallet_tui::action::SettingsAction::CheckMfwName,
    ));
    assert!(
        app.view_model()
            .error
            .as_deref()
            .is_some_and(|error| error.contains("1-63")),
        "{:?}",
        app.view_model().error
    );
}

#[test]
fn node_status_starts_a_connection_check() {
    let mut app = open_funded_wallet();
    assert_eq!(
        app.handle(Action::OpenMenu(
            monero_fast_wallet_tui::settings::MenuItem::Node
        )),
        RunOutcome::Continue
    );
    assert_eq!(app.view_model().screen, ScreenKind::Node);
    assert!(
        app.view_model().settings.node_checking
            || app.view_model().status.contains("Checking")
            || app
                .view_model()
                .buttons
                .iter()
                .any(|item| item.contains("Check")),
        "{:?}",
        app.view_model().status
    );
}

#[test]
fn confirming_the_seed_leaves_the_backup_screen_immediately() {
    let mut app = App::new(Box::new(MemoryBackend::new()));
    app.handle(Action::SelectCreate);
    type_path_and_password(&mut app, "seed-confirm", "secret");
    app.handle(Action::Submit);
    assert_eq!(app.view_model().screen, ScreenKind::SeedBackup);
    assert_eq!(app.handle(Action::ConfirmSeedBackup), RunOutcome::Continue);
    assert_eq!(app.view_model().screen, ScreenKind::Home);
    assert!(
        app.view_model().status.contains("Connecting")
            || app.view_model().status.contains("Seed backup confirmed"),
        "{}",
        app.view_model().status
    );
}

fn type_path_and_password(app: &mut App, path: &str, password: &str) {
    app.handle(Action::Focus(
        monero_fast_wallet_tui::action::Field::WalletPath,
    ));
    for ch in path.chars() {
        app.handle(Action::InsertChar(ch));
    }
    app.handle(Action::Focus(
        monero_fast_wallet_tui::action::Field::Password,
    ));
    for ch in password.chars() {
        app.handle(Action::InsertChar(ch));
    }
}

#[test]
fn open_screen_header_is_open_not_welcome() {
    let mut app = App::new(Box::new(MemoryBackend::new()));
    app.handle(Action::SelectOpen);
    let view = app.view_model();
    assert_eq!(view.header, "Open");
    assert_eq!(view.screen, ScreenKind::Open);
    assert!(view.buttons.iter().any(|item| item == "Open"));
}

#[test]
fn opening_a_missing_wallet_explains_the_folder() {
    let mut app = App::new(Box::new(MemoryBackend::new()));
    app.handle(Action::SelectOpen);
    type_path_and_password(&mut app, "test", "password1");
    app.handle(Action::Submit);
    let error = app.view_model().error.expect("error");
    assert!(error.contains("No wallet"), "{error}");
    assert!(error.contains("Create"), "{error}");
}

#[test]
fn clicking_a_listed_wallet_fills_the_path() {
    let mut app = App::new(Box::new(MemoryBackend::new()));
    app.handle(Action::SelectOpen);
    app.handle(Action::SetWalletPath("/tmp/example-wallet".into()));
    assert_eq!(app.view_model().wallet_path, "/tmp/example-wallet");
}

#[test]
fn home_sync_card_shows_gui_style_progress() {
    let mut backend = MemoryBackend::new();
    backend
        .create_wallet(CreateRequest {
            path: "sync-wallet".into(),
            password: zeroize::Zeroizing::new("secret".into()),
            network: monero_fast_wallet_tui::action::NetworkChoice::Stagenet,
        })
        .unwrap();
    backend.confirm_seed_backup().unwrap();
    backend.begin_historic_sync(1_250, 2_000).unwrap();
    let mut app = App::new(Box::new(backend));
    app.handle(Action::SelectOpen);
    type_path_and_password(&mut app, "sync-wallet", "secret");
    app.handle(Action::Submit);
    let sync = app.view_model().sync;
    assert!(!sync.ready, "{sync:?}");
    assert!(sync.working || sync.percent.is_some(), "{sync:?}");
    assert!(
        sync.compact.contains('%')
            || sync.compact.contains("Scanning")
            || sync.compact.contains("Verifying"),
        "{}",
        sync.compact
    );
    assert!(
        sync.height
            .as_deref()
            .is_some_and(|value| value.contains("Block") && value.contains("of")),
        "{:?}",
        sync.height
    );
}

#[test]
fn welcome_lists_clickable_actions() {
    let app = App::new(Box::new(MemoryBackend::new()));
    let view = app.view_model();
    assert_eq!(view.screen, ScreenKind::Welcome);
    assert!(view.buttons.iter().any(|item| item == "Create wallet"));
    assert!(view.buttons.iter().any(|item| item == "Open wallet"));
    assert!(view.buttons.iter().any(|item| item == "Ledger Nano"));
}

#[test]
fn ledger_requires_scan_height_like_the_gui() {
    let mut app = App::new(Box::new(MemoryBackend::new()));
    app.handle(Action::SelectLedger);
    assert_eq!(app.view_model().screen, ScreenKind::Ledger);
    assert_eq!(
        app.view_model().network,
        "mainnet",
        "GUI Ledger setup defaults to mainnet"
    );
    app.handle(Action::Submit);
    assert!(
        app.view_model()
            .error
            .as_deref()
            .unwrap()
            .contains("scan start height"),
        "{:?}",
        app.view_model().error
    );
}

#[test]
fn ledger_create_keeps_seed_on_device() {
    let mut app = App::new(Box::new(MemoryBackend::new()));
    app.handle(Action::SelectLedger);
    app.handle(Action::SetWalletPath("nano".into()));
    app.handle(Action::Focus(
        monero_fast_wallet_tui::action::Field::RestoreHeight,
    ));
    for ch in "2000000".chars() {
        app.handle(Action::InsertChar(ch));
    }
    app.handle(Action::Submit);
    let view = app.view_model();
    assert_eq!(view.screen, ScreenKind::Home, "{:?}", view.error);
    assert!(view.hardware);
    assert!(!view.seed_visible);
}

#[test]
fn create_open_refresh_receive_and_command_bar() {
    let mut app = open_funded_wallet();
    let address = app.view_model().address.clone().unwrap();
    assert!(address.starts_with('4'));
    assert_eq!(app.view_model().balance.as_deref(), Some("0.000000000000"));

    assert_eq!(
        app.handle(Action::GoTab(Tab::Receive)),
        RunOutcome::Continue
    );
    assert_eq!(app.view_model().screen, ScreenKind::Receive);
    app.handle(Action::Focus(
        monero_fast_wallet_tui::action::Field::SubaddressLabel,
    ));
    for ch in "Savings".chars() {
        app.handle(Action::InsertChar(ch));
    }
    app.handle(Action::NewSubaddress);
    assert!(app.view_model().status.contains("Created"));

    app.handle(Action::Focus(
        monero_fast_wallet_tui::action::Field::Command,
    ));
    for ch in "b".chars() {
        app.handle(Action::InsertChar(ch));
    }
    app.handle(Action::RunCommand);
    assert_eq!(app.view_model().tab, Tab::Home);

    app.handle(Action::Refresh);
    assert_eq!(app.view_model().status, "Synchronized.");
}

#[test]
fn send_requires_review_and_sufficient_funds() {
    let mut app = open_funded_wallet();
    let destination = MemoryBackend::funded_destination();
    app.handle(Action::GoTab(Tab::Send));
    app.handle(Action::Focus(
        monero_fast_wallet_tui::action::Field::Address,
    ));
    for ch in destination.chars() {
        app.handle(Action::InsertChar(ch));
    }
    app.handle(Action::Focus(monero_fast_wallet_tui::action::Field::Amount));
    for ch in "1".chars() {
        app.handle(Action::InsertChar(ch));
    }
    app.handle(Action::ReviewSend);
    assert!(app
        .view_model()
        .error
        .as_deref()
        .unwrap()
        .contains("unlocked balance is too low"));
    assert!(app.view_model().review.is_none());
}

#[test]
fn send_review_then_commit() {
    let mut backend = MemoryBackend::new();
    // Drive backend directly to fund, then wrap remaining behaviour via App
    // after reconstructing state is awkward; use trait test_credit through App
    // by keeping backend inside App and using command flow after credit helper
    // on a dedicated session object.
    backend
        .create_wallet(CreateRequest {
            path: "carol".into(),
            password: zeroize::Zeroizing::new("secret".into()),
            network: monero_fast_wallet_tui::action::NetworkChoice::Stagenet,
        })
        .unwrap();
    backend.confirm_seed_backup().unwrap();
    backend.credit_open_wallet(5).unwrap();

    let mut app = App::new(Box::new(backend));
    // App starts on welcome with a fresh backend... the funded backend is moved
    // in already open. Snapshot is not imported. Open the same in-memory wallet.
    app.handle(Action::SelectOpen);
    type_path_and_password(&mut app, "carol", "secret");
    app.handle(Action::Submit);
    assert_eq!(app.view_model().screen, ScreenKind::Home);
    assert_eq!(app.view_model().balance.as_deref(), Some("5.000000000000"));

    let destination = MemoryBackend::funded_destination();
    app.handle(Action::GoTab(Tab::Send));
    app.handle(Action::Focus(
        monero_fast_wallet_tui::action::Field::Address,
    ));
    for ch in destination.chars() {
        app.handle(Action::InsertChar(ch));
    }
    app.handle(Action::Focus(monero_fast_wallet_tui::action::Field::Amount));
    for ch in "1.5".chars() {
        app.handle(Action::InsertChar(ch));
    }
    app.handle(Action::ConfirmSend);
    assert_eq!(
        app.view_model().error.as_deref(),
        Some("Review the payment before submitting it.")
    );

    app.handle(Action::ReviewSend);
    let review = app.view_model().review.expect("review missing");
    assert_eq!(review.amount, "1.500000000000");
    assert_eq!(review.address, destination);

    app.handle(Action::ConfirmSend);
    assert!(app.view_model().status.contains("Submitted"));
    assert!(app.view_model().review.is_none());
    assert_eq!(app.view_model().balance.as_deref(), Some("3.499900000000"));

    app.handle(Action::GoTab(Tab::Activity));
    assert!(!app.view_model().transactions.is_empty());
}

#[test]
fn password_is_masked_in_the_view() {
    let mut app = App::new(Box::new(MemoryBackend::new()));
    app.handle(Action::SelectOpen);
    type_path_and_password(&mut app, "dave", "super-secret");
    let view = app.view_model();
    assert_eq!(view.password_masked.as_deref(), Some("••••••••••••"));
    assert!(!format!("{view:?}").contains("super-secret"));
}

#[test]
fn classic_button_requests_classic_cli() {
    let mut app = App::new(Box::new(MemoryBackend::new()));
    assert_eq!(app.handle(Action::LaunchClassic), RunOutcome::Classic);
}

#[test]
fn restore_rejects_short_seed() {
    let mut app = App::new(Box::new(MemoryBackend::new()));
    app.handle(Action::SelectRestore);
    type_path_and_password(&mut app, "erin", "secret");
    app.handle(Action::Focus(monero_fast_wallet_tui::action::Field::Seed));
    for ch in "only a few words".chars() {
        app.handle(Action::InsertChar(ch));
    }
    app.handle(Action::Submit);
    assert!(app
        .view_model()
        .error
        .as_deref()
        .unwrap()
        .contains("25 words"));
}

#[test]
fn open_wallet_sidebar_matches_tauri2_primary_nav() {
    let mut app = open_funded_wallet();
    let backend = ratatui::backend::TestBackend::new(100, 32);
    let mut terminal = ratatui::Terminal::new(backend).unwrap();
    terminal
        .draw(|frame| monero_fast_wallet_tui::ui::draw(&mut app, frame))
        .unwrap();
    let rendered = format!("{:?}", terminal.backend());
    for label in ["Home", "Send", "Receive", "Menu"] {
        assert!(
            rendered.contains(label),
            "missing primary nav {label}: {rendered}"
        );
    }
    assert!(
        !rendered.contains("Activity") || rendered.contains("recent activity"),
        "Activity must not be a primary sidebar item"
    );
}

#[test]
fn menu_lists_settings_and_desktop_children() {
    let mut app = open_funded_wallet();
    assert_eq!(app.handle(Action::GoTab(Tab::Menu)), RunOutcome::Continue);
    let view = app.view_model();
    assert_eq!(view.screen, ScreenKind::Menu);
    assert_eq!(view.tab, Tab::Menu);
    assert!(view.buttons.iter().any(|item| item == "Settings"));
    assert!(view.buttons.iter().any(|item| item == "Manage wallets"));
    assert!(view.buttons.iter().any(|item| item == "Your Address Names"));
    assert!(view.buttons.iter().any(|item| item == "Node Status"));
    assert!(!view.buttons.iter().any(|item| item.contains("Vanity")));
    assert!(!view.buttons.iter().any(|item| item.contains("Assistant")));
}

#[test]
fn settings_contains_every_tauri2_lean_settings_section() {
    let mut app = open_funded_wallet();
    assert_eq!(
        app.handle(Action::OpenMenu(
            monero_fast_wallet_tui::settings::MenuItem::Settings
        )),
        RunOutcome::Continue
    );
    assert_eq!(app.view_model().screen, ScreenKind::Settings);
    assert_eq!(app.view_model().tab, Tab::Menu);

    let backend = ratatui::backend::TestBackend::new(120, 40);
    let mut terminal = ratatui::Terminal::new(backend).unwrap();
    let mut rendered = String::new();
    for _ in 0..10 {
        terminal
            .draw(|frame| monero_fast_wallet_tui::ui::draw(&mut app, frame))
            .unwrap();
        rendered.push_str(&format!("{:?}", terminal.backend()));
        app.handle(Action::Settings(
            monero_fast_wallet_tui::action::SettingsAction::Scroll(8),
        ));
    }
    for needle in [
        "Settings",
        "Fast Wallet Worker",
        "Recommended",
        "Private Worker",
        "Project Page",
        "Monero Name Registry",
        "Language",
        "Performance",
        "CPU",
        "Metal",
        "CUDA",
        "Community privacy",
        "Recovery seed",
        "App lock",
        "Automatic app lock",
        "About",
        "Privacy by design",
        "Market display",
    ] {
        assert!(rendered.contains(needle), "Settings is missing {needle}");
    }

    app.handle(Action::Settings(
        monero_fast_wallet_tui::action::SettingsAction::RevealSeed,
    ));
    assert!(
        app.revealed_seed()
            .is_some_and(|seed| seed.split_whitespace().count() == 25),
        "software wallet must reveal the 25-word seed from Settings"
    );
}

#[test]
fn welcome_renders_brand_in_terminal_buffer() {
    let mut app = App::new(Box::new(MemoryBackend::new()));
    let backend = ratatui::backend::TestBackend::new(100, 28);
    let mut terminal = ratatui::Terminal::new(backend).unwrap();
    terminal
        .draw(|frame| monero_fast_wallet_tui::ui::draw(&mut app, frame))
        .unwrap();
    let buffer = terminal.backend();
    let rendered = format!("{buffer:?}");
    assert!(
        rendered.contains("MONERO FAST WALLET") || rendered.contains("Welcome"),
        "TUI did not render the welcome brand"
    );
    assert!(!app.hits.is_empty(), "welcome buttons must be clickable");
}

#[test]
fn mouse_hits_can_open_create() {
    let mut app = App::new(Box::new(MemoryBackend::new()));
    app.hits.push(monero_fast_wallet_tui::app::Hit {
        x: 2,
        y: 10,
        width: 20,
        height: 1,
        action: Action::SelectCreate,
    });
    app.handle(Action::MouseClick { column: 5, row: 10 });
    assert_eq!(app.view_model().screen, ScreenKind::Create);
}
