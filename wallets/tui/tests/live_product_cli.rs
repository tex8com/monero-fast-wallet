use monero_fast_wallet_tui::action::NetworkChoice;
use monero_fast_wallet_tui::backend::{
    CreateRequest, OpenRequest, ProductCliBackend, WalletBackend,
};
use std::path::PathBuf;
use zeroize::Zeroizing;

#[test]
#[ignore = "set MFW_TUI_LIVE_CLI to a real monero-fast-wallet-cli"]
fn live_offline_create_open_and_balance() {
    let cli = std::env::var("MFW_TUI_LIVE_CLI").expect("MFW_TUI_LIVE_CLI");
    let dir = tempfile::tempdir().unwrap();
    chmod700(dir.path());
    let wallet = dir.path().join("live-wallet");
    let mut backend = ProductCliBackend::new(PathBuf::from(cli));
    let created = backend
        .create_wallet(CreateRequest {
            path: wallet.clone(),
            password: Zeroizing::new("live-test-password".into()),
            network: NetworkChoice::Stagenet,
        })
        .expect("create");
    assert_eq!(created.seed.split_whitespace().count(), 25);
    assert!(created.address.starts_with('5') || created.address.starts_with('4'));
    let balance = created.snapshot.balance_atomic;
    drop(created);

    backend.close().unwrap();
    let opened = backend
        .open_wallet(OpenRequest {
            path: wallet,
            password: Zeroizing::new("live-test-password".into()),
            network: NetworkChoice::Stagenet,
        })
        .expect("open");
    assert_eq!(opened.balance_atomic, balance);
    assert!(!opened.primary_address.is_empty());
}

fn chmod700(path: &std::path::Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700));
    }
}
