use std::{env, fs, path::PathBuf};

const COMMANDS: &[&str] = &[
    "wallet_core_status",
    "app_protection_status",
    "set_app_protection_password",
    "verify_app_protection_password",
    "set_app_protection_mode",
    "verify_system_auth",
    "lock_app",
    "fetch_market_backup",
    "ledger_transport_status",
    "store_wallet_password",
    "delete_wallet_password",
    "create_wallet",
    "restore_wallet_with_native_seed",
    "restore_fast_wallet_with_native_seed",
    "create_hardware_wallet",
    "enable_ledger_read_only",
    "create_ledger_read_only_from_device",
    "wallet_open_requires_password",
    "open_wallet",
    "close_wallet",
    "rename_wallet",
    "remove_registered_wallet",
    "list_registered_wallets",
    "activate_registered_wallet",
    "list_fast_wallets",
    "open_fast_wallet",
    "close_fast_wallet",
    "remove_fast_wallet",
    "present_fast_wallet_recovery_seed",
    "create_fast_wallet",
    "pair_private_fast_wallet_worker",
    "enable_encrypted_fast_wallet_alerts",
    "turn_off_fast_wallet_alerts",
    "delete_hosted_fast_wallet_data",
    "enable_fast_wallet",
    "enable_ledger_fast_wallet",
    "refresh_fast_wallet_status",
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
    "validate_recipient_address",
    "verify_mfw_name_record_address",
    "list_mfw_names",
    "resolve_mfw_name_for_payment",
    "check_mfw_name_availability",
    "prepare_mfw_name_registration",
    "prepare_mfw_name_claim",
    "prepare_mfw_name_transition",
    "export_mfw_name_recovery",
    "import_mfw_name_recovery",
    "refresh_mfw_name",
    "remove_mfw_name_local",
    "present_recovery_seed",
    "wallet_snapshot",
    "registered_wallet_snapshots",
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
    "enthusiast_v1_status",
    "enthusiast_v1_query_contribution_enabled",
    "enthusiast_v1_set_query_contribution_enabled",
    "enthusiast_v1_contribute_query",
    "enthusiast_v1_initialize",
    "enthusiast_v1_start",
    "enthusiast_v1_delete_identity",
    "enthusiast_v1_account_status",
    "enthusiast_v1_chat_report_outcome",
    "enthusiast_v1_appeal_chat_report",
    "enthusiast_v1_content_moderation_outcomes",
    "enthusiast_v1_appeal_content_moderation",
    "enthusiast_v1_submit_content",
    "enthusiast_v1_resubmit_content",
    "enthusiast_v1_content_status",
    "enthusiast_v1_list_content",
    "enthusiast_v1_request_contact",
    "enthusiast_v1_pending_contacts",
    "enthusiast_v1_accepted_contacts",
    "enthusiast_v1_respond_contact",
    "enthusiast_v1_open_chat",
    "enthusiast_v1_messages",
    "enthusiast_v1_send_message",
    "enthusiast_v1_report_preview",
    "enthusiast_v1_report_message",
    "enthusiast_v1_block_contact",
];

fn main() {
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("manifest path"));
    configure_fast_wallet_release(&manifest_dir);

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
    let fast_wallet_protocol_dir = repo_root.join("native/fast-wallet-protocol");
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
        desktop_bridge_dir.join("cpp/DesktopPlatformAuthMac.mm"),
        desktop_bridge_dir.join("cpp/DesktopPlatformAuthWindows.cpp"),
        desktop_bridge_dir.join("include/DesktopWalletCore.h"),
        desktop_bridge_dir.join("include/DesktopLedgerBle.h"),
        desktop_bridge_dir.join("include/DesktopPlatformAuth.h"),
        fast_wallet_protocol_dir.join("include/fast_wallet_protocol.h"),
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
        .include(desktop_bridge_dir.join("include"))
        .include(fast_wallet_protocol_dir.join("include"));

    if cfg!(target_os = "windows") {
        // The Windows host uses MSVC while the real Monero core is a separate
        // GNU/ARM64 DLL. Keep this host on the stable C ABI proxy only.
        native
            .file(desktop_bridge_dir.join("cpp/DesktopWalletCoreWindowsProxy.cpp"))
            .file(desktop_bridge_dir.join("cpp/DesktopPlatformAuthWindows.cpp"));
        println!("cargo:rustc-link-lib=runtimeobject");
        println!("cargo:rustc-link-lib=windowsapp");
    } else {
        native
            .file(bridge_dir.join("cpp/WalletEngine.cpp"))
            .file(desktop_bridge_dir.join("cpp/DesktopWalletCore.cpp"));
    }

    if cfg!(target_os = "macos") {
        native
            .flag_if_supported("-fobjc-arc")
            .file(desktop_bridge_dir.join("cpp/DesktopNotificationsMac.mm"))
            .file(desktop_bridge_dir.join("cpp/DesktopLedgerBleMac.mm"))
            .file(desktop_bridge_dir.join("cpp/DesktopPlatformAuthMac.mm"));
        println!("cargo:rustc-link-lib=framework=AppKit");
        println!("cargo:rustc-link-lib=framework=CoreBluetooth");
        println!("cargo:rustc-link-lib=framework=Foundation");
        println!("cargo:rustc-link-lib=framework=LocalAuthentication");
        println!("cargo:rustc-link-lib=framework=Metal");
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

fn configure_fast_wallet_release(manifest_dir: &std::path::Path) {
    let feature_manifest_path = manifest_dir.join("../../../config/v1-release-features.json");
    println!("cargo:rerun-if-changed={}", feature_manifest_path.display());
    for variable in [
        "FAST_WALLET_GATEWAY_ORIGIN",
        "FAST_WALLET_OFFICIAL_WORKER_ROOT_ID",
    ] {
        println!("cargo:rerun-if-env-changed={variable}");
    }

    let raw = fs::read_to_string(&feature_manifest_path)
        .expect("read immutable V1 release feature manifest");
    let manifest: serde_json::Value =
        serde_json::from_str(&raw).expect("parse immutable V1 release feature manifest");
    let official_enabled = manifest
        .get("schemaVersion")
        .and_then(serde_json::Value::as_u64)
        == Some(1)
        && manifest.get("profile").and_then(serde_json::Value::as_str) == Some("safe-wallet-v1")
        && manifest
            .pointer("/features/officialWorker")
            .and_then(serde_json::Value::as_bool)
            == Some(true);
    let private_enabled = manifest
        .pointer("/features/privateWorkerPairing")
        .and_then(serde_json::Value::as_bool)
        == Some(true);
    let gateway_origin = env::var("FAST_WALLET_GATEWAY_ORIGIN").unwrap_or_default();
    let official_root = env::var("FAST_WALLET_OFFICIAL_WORKER_ROOT_ID").unwrap_or_default();
    if (official_enabled || private_enabled) && !valid_https_origin(&gateway_origin) {
        panic!(
            "remote Fast Wallet alerts require FAST_WALLET_GATEWAY_ORIGIN as an exact HTTPS origin"
        );
    }
    if official_enabled && !canonical_hex_32(&official_root) {
        panic!(
            "officialWorker requires FAST_WALLET_OFFICIAL_WORKER_ROOT_ID as 32-byte lowercase hex"
        );
    }
    println!(
        "cargo:rustc-env=TEX8_FAST_WALLET_GATEWAY_ORIGIN={}",
        gateway_origin.trim().trim_end_matches('/')
    );
    println!(
        "cargo:rustc-env=TEX8_FAST_WALLET_OFFICIAL_WORKER_ROOT_ID={}",
        official_root.trim()
    );
}

fn valid_https_origin(value: &str) -> bool {
    let value = value.trim().trim_end_matches('/');
    let Some(authority) = value.strip_prefix("https://") else {
        return false;
    };
    !authority.is_empty()
        && !authority.contains(['/', '?', '#', '@'])
        && !authority.chars().any(char::is_whitespace)
}

fn canonical_hex_32(value: &str) -> bool {
    let value = value.trim();
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}
