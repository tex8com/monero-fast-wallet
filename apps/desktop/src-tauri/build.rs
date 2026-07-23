use std::{env, fs, path::PathBuf};

const COMMANDS: &[&str] = &[
    "wallet_core_status",
    "fetch_market_backup",
    "ledger_transport_status",
    "store_wallet_password",
    "delete_wallet_password",
    "create_wallet",
    "restore_wallet",
    "create_hardware_wallet",
    "enable_ledger_read_only",
    "create_ledger_read_only_from_device",
    "open_wallet",
    "close_wallet",
    "change_wallet_password",
    "rename_wallet",
    "remove_registered_wallet",
    "list_registered_wallets",
    "activate_registered_wallet",
    "mark_wallet_seed_backed_up",
    "list_fast_wallets",
    "open_fast_wallet",
    "close_fast_wallet",
    "create_fast_wallet",
    "enable_fast_wallet",
    "refresh_fast_wallet_status",
    "poll_fast_wallet_push_signals",
    "notification_installation_status",
    "request_notification_installation",
    "disable_notification_installation",
    "consume_pending_notification_open",
    "background_notification_agent_config_path",
    "disable_fast_wallet",
    "load_node_settings",
    "save_node_settings",
    "set_daemon",
    "start_wallet_refresh",
    "stop_wallet_refresh",
    "wallet_address",
    "wallet_recovery_seed",
    "wallet_snapshot",
    "wallet_balance",
    "wallet_unlocked_balance",
    "create_subaddress",
    "wallet_transactions",
    "prepare_transaction",
    "commit_transaction",
    "wallet_hardware_status",
    "reconnect_hardware_wallet",
    "show_hardware_wallet_address",
    "community_load_profile",
    "community_update_profile",
    "community_list_nearby",
    "community_list_contacts",
    "community_request_contact",
    "community_accept_contact",
    "community_list_messages",
    "community_send_message",
    "community_block_profile",
    "community_report_profile",
    "community_delete_identity",
];

fn main() {
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("manifest path"));

    // On macOS, `tauri dev` embeds the .icns data into the debug executable
    // before assigning it to NSApplication. Track every configured icon so an
    // icon refresh triggers the build script as well as the Tauri restart.
    for icon in [
        "tauri.conf.json",
        "icons/app-icon.svg",
        "icons/32x32.png",
        "icons/128x128.png",
        "icons/128x128@2x.png",
        "icons/icon.icns",
        "icons/icon.ico",
    ] {
        println!(
            "cargo:rerun-if-changed={}",
            manifest_dir.join(icon).display()
        );
    }

    let attributes = tauri_build::Attributes::new()
        .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS));
    tauri_build::try_build(attributes).expect("failed to build Tauri application manifest");

    let capability_path = manifest_dir.join("capabilities/main.json");
    println!("cargo:rerun-if-changed={}", capability_path.display());
    let capability = fs::read_to_string(&capability_path).expect("read main Tauri capability");
    for command in COMMANDS {
        let permission = format!("\"allow-{}\"", command.replace('_', "-"));
        if !capability.contains(&permission) {
            panic!("main Tauri capability must explicitly allow {command}");
        }
    }
    let repo_root = manifest_dir.join("../../..");
    let bridge_dir = repo_root.join("native/monero-bridge");
    let desktop_bridge_dir = repo_root.join("native/desktop-bridge");
    let source_dir = env::var_os("DESKTOP_MONERO_SOURCE_DIR").map(PathBuf::from);
    let wallet_api = env::var_os("DESKTOP_MONERO_WALLET_API_LIBRARY").map(PathBuf::from);
    let windows_core_dll = env::var_os("DESKTOP_WINDOWS_MONERO_CORE_DLL").map(PathBuf::from);
    let fast_crypto = env::var_os("DESKTOP_MONERO_FAST_CRYPTO_LIBRARY")
        .map(PathBuf::from)
        .or_else(|| {
            source_dir.as_ref().map(|source| {
                if cfg!(target_os = "linux") {
                    source
                        .join("external/monero-fast-crypto/target/release/libmonero_fast_crypto.so")
                } else {
                    source
                        .join("external/monero-fast-crypto/target/release/libmonero_fast_crypto.a")
                }
            })
        });
    let require_monero = env::var("DESKTOP_REQUIRE_MONERO").as_deref() == Ok("1");
    let linked_with_monero = if cfg!(target_os = "windows") {
        windows_core_dll.as_ref().is_some_and(|path| path.is_file())
    } else {
        source_dir.is_some() && wallet_api.is_some() && fast_crypto.is_some()
    };

    if source_dir.is_some() != wallet_api.is_some() {
        panic!(
            "DESKTOP_MONERO_SOURCE_DIR and DESKTOP_MONERO_WALLET_API_LIBRARY must be configured together"
        );
    }
    if require_monero && !linked_with_monero {
        panic!(
            "release packages require DESKTOP_MONERO_SOURCE_DIR, DESKTOP_MONERO_WALLET_API_LIBRARY, and DESKTOP_MONERO_FAST_CRYPTO_LIBRARY"
        );
    }

    for file in [
        bridge_dir.join("cpp/WalletEngine.cpp"),
        bridge_dir.join("cpp/WalletEngine.h"),
        bridge_dir.join("cpp/WalletEngineTypes.h"),
        desktop_bridge_dir.join("cpp/DesktopWalletCore.cpp"),
        desktop_bridge_dir.join("cpp/DesktopNotificationsMac.mm"),
        desktop_bridge_dir.join("cpp/DesktopLedgerBleMac.mm"),
        desktop_bridge_dir.join("include/DesktopWalletCore.h"),
        desktop_bridge_dir.join("include/DesktopLedgerBle.h"),
    ] {
        println!("cargo:rerun-if-changed={}", file.display());
    }
    for variable in [
        "DESKTOP_MONERO_SOURCE_DIR",
        "DESKTOP_MONERO_WALLET_API_LIBRARY",
        "DESKTOP_MONERO_FAST_CRYPTO_LIBRARY",
        "DESKTOP_WINDOWS_MONERO_CORE_DLL",
        "DESKTOP_MONERO_EXTRA_LINK_ARGS",
        "DESKTOP_REQUIRE_MONERO",
    ] {
        println!("cargo:rerun-if-env-changed={variable}");
    }

    let mut native = cc::Build::new();
    native
        .cpp(true)
        .warnings(true)
        // MSVC does not accept the GCC/Clang spelling below.  Keep the
        // native bridge on the same C++ standard on every desktop target.
        .flag_if_supported("/std:c++17")
        .flag_if_supported("-std=c++17")
        .include(bridge_dir.join("cpp"))
        .include(desktop_bridge_dir.join("include"));

    if cfg!(target_os = "windows") {
        // The Windows host uses MSVC while the real Monero core is a separate
        // GNU/ARM64 DLL. Keep this host on the stable C ABI proxy only.
        native.file(desktop_bridge_dir.join("cpp/DesktopWalletCoreWindowsProxy.cpp"));
    } else {
        native
            .file(bridge_dir.join("cpp/WalletEngine.cpp"))
            .file(desktop_bridge_dir.join("cpp/DesktopWalletCore.cpp"));
    }

    if cfg!(target_os = "macos") {
        native
            .flag_if_supported("-fobjc-arc")
            .file(desktop_bridge_dir.join("cpp/DesktopNotificationsMac.mm"))
            .file(desktop_bridge_dir.join("cpp/DesktopLedgerBleMac.mm"));
        println!("cargo:rustc-link-lib=framework=AppKit");
        println!("cargo:rustc-link-lib=framework=CoreBluetooth");
        println!("cargo:rustc-link-lib=framework=Foundation");
        println!("cargo:rustc-link-lib=framework=UserNotifications");
    }

    if linked_with_monero && !cfg!(target_os = "windows") {
        let source_dir = source_dir.as_ref().expect("checked Monero source path");
        native
            .define("TEX8_WALLET_BRIDGE_WITH_MONERO", Some("1"))
            .include(source_dir.join("src/wallet/api"));
    } else if !cfg!(target_os = "windows") {
        native.define("TEX8_WALLET_BRIDGE_WITH_MONERO", Some("0"));
    }
    native.compile("tex8_desktop_wallet_bridge");

    if !cfg!(target_os = "windows") {
        if let (Some(wallet_api), Some(fast_crypto)) = (wallet_api, fast_crypto) {
            if !wallet_api.is_file() {
                panic!(
                    "DESKTOP_MONERO_WALLET_API_LIBRARY does not exist: {}",
                    wallet_api.display()
                );
            }
            if !fast_crypto.is_file() {
                panic!(
                    "DESKTOP_MONERO_FAST_CRYPTO_LIBRARY does not exist: {}",
                    fast_crypto.display()
                );
            }
            println!("cargo:rustc-link-arg={}", wallet_api.display());
            if cfg!(target_os = "linux")
                && fast_crypto.extension().is_some_and(|value| value == "so")
            {
                let directory = fast_crypto
                    .parent()
                    .expect("Fast Crypto library has a parent directory");
                println!("cargo:rustc-link-search=native={}", directory.display());
                println!("cargo:rustc-link-lib=dylib=monero_fast_crypto");
                // Tauri preserves resources below its `_up_` resource directory
                // within AppImage's `usr/lib/<product>/`.  Keep the runtime
                // lookup relative to the executable, never to a developer path.
                // This is intentionally separate from the generic `../lib`
                // lookup used by GTK/WebKit.
                println!(
                "cargo:rustc-link-arg=-Wl,-rpath,$ORIGIN/../lib/Monero Fast Wallet/_up_/native-libs"
            );
            } else {
                println!("cargo:rustc-link-arg={}", fast_crypto.display());
            }
            if let Ok(extra_args) = env::var("DESKTOP_MONERO_EXTRA_LINK_ARGS") {
                for arg in extra_args
                    .split(';')
                    .filter(|value| !value.trim().is_empty())
                {
                    println!("cargo:rustc-link-arg={}", arg.trim());
                }
            }
        }
    }

    println!(
        "cargo:rustc-env=TEX8_DESKTOP_MONERO_LINKED={}",
        if linked_with_monero { "1" } else { "0" }
    );
}
