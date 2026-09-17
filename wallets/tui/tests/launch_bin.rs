use std::process::Command;

fn bin() -> Command {
    let path = std::env::var("CARGO_BIN_EXE_fast_wallet_cli")
        .or_else(|_| std::env::var("CARGO_BIN_EXE_fast-wallet-cli"))
        .expect("CARGO_BIN_EXE_fast_wallet_cli");
    Command::new(path)
}

#[test]
fn tui_version_prints_json_identity() {
    let output = bin()
        .arg("--tui-version")
        .output()
        .expect("run --tui-version");
    assert!(output.status.success());
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("\"product\":\"fast-wallet-tui\""));
    assert!(stdout.contains("\"classic_binary\":\"monero-fast-wallet-cli\""));
}

#[test]
fn classic_without_sibling_fails_closed() {
    let output = bin()
        .arg("--classic")
        .env_remove("MFW_PRODUCT_CLI")
        .env("MFW_SEARCH_BUILD_CLI", "0")
        .output()
        .expect("run --classic");
    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("monero-fast-wallet-cli was not found"));
}

#[test]
fn quickstart_without_sibling_does_not_start_tui() {
    let output = bin()
        .arg("quickstart")
        .env_remove("MFW_PRODUCT_CLI")
        .env("MFW_SEARCH_BUILD_CLI", "0")
        .output()
        .expect("run quickstart");
    assert!(!output.status.success());
}
