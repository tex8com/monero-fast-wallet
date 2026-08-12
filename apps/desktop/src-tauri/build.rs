use std::{env, fs, path::PathBuf, process::Command};

const COMMANDS: &[&str] = &[
    "wallet_core_status",
    "compute_backend_status",
    "set_compute_backend",
    "derivation_performance",
    "app_protection_status",
    "retry_app_protection_status",
    "set_app_protection_password",
    "verify_app_protection_password",
    "set_app_protection_mode",
    "verify_system_auth",
    "lock_app",
    "record_app_user_activity",
    "auto_lock_settings",
    "set_auto_lock_timeout",
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
    "reconcile_ledger_balance",
    "wallet_open_requires_password",
    "open_wallet",
    "close_wallet",
    "rename_wallet",
    "remove_registered_wallet",
    "list_registered_wallets",
    "activate_registered_wallet",
    "recover_registered_wallet_session",
    "queue_registered_wallet_sync",
    "list_fast_wallets",
    "open_fast_wallet",
    "close_fast_wallet",
    "remove_fast_wallet",
    "remove_fast_wallet_entry",
    "present_fast_wallet_recovery_seed",
    "confirm_fast_wallet_recovery_seed_backup",
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
    "network_sync_status",
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
    "confirm_recovery_seed_backup",
    "wallet_snapshot",
    "registered_wallet_snapshots",
    "wallet_balance",
    "wallet_unlocked_balance",
    "create_subaddress",
    "list_subaddresses",
    "wallet_transactions",
    "registered_wallet_transactions",
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
    "enthusiast_v1_search",
    "enthusiast_v1_suggestions",
    "enthusiast_v1_clear_search_history",
    "enthusiast_v1_enable_notifications",
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

fn expected_monero_core_tree(repo_root: &std::path::Path) -> String {
    let lock_path = repo_root.join("third_party/monero-patches/upstream.lock");
    let lock = fs::read_to_string(&lock_path)
        .unwrap_or_else(|error| panic!("read {}: {error}", lock_path.display()));
    let tree = lock
        .lines()
        .find_map(|line| line.strip_prefix("patched_tree="))
        .unwrap_or_else(|| panic!("{} has no patched_tree", lock_path.display()));
    if tree.len() != 40 || !tree.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        panic!("{} has an invalid patched_tree", lock_path.display());
    }
    tree.to_owned()
}

fn verify_monero_source_tree(source_dir: &std::path::Path, expected: &str) {
    let output = Command::new("git")
        .args(["-C"])
        .arg(source_dir)
        .args(["rev-parse", "HEAD^{tree}"])
        .output()
        .unwrap_or_else(|error| {
            panic!(
                "run git for common Monero Core {}: {error}",
                source_dir.display()
            )
        });
    if !output.status.success() {
        panic!(
            "DESKTOP_MONERO_SOURCE_DIR is not a readable Git checkout: {}",
            source_dir.display()
        );
    }
    let actual = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    if actual != expected {
        panic!(
            "Desktop Monero Core source is stale or unauthenticated: expected tree {expected}, got {actual}"
        );
    }
}

fn main() {
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("manifest path"));
    configure_fast_wallet_release(&manifest_dir);
    configure_community_harrier();

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
    remove_stale_tauri_resources();
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
    let expected_core_tree = expected_monero_core_tree(&repo_root);
    let bridge_dir = repo_root.join("native/monero-bridge");
    let desktop_bridge_dir = repo_root.join("native/desktop-bridge");
    let fast_wallet_protocol_dir = repo_root.join("native/fast-wallet-protocol");
    let source_dir = env::var_os("DESKTOP_MONERO_SOURCE_DIR").map(PathBuf::from);
    let wallet_api = env::var_os("DESKTOP_MONERO_WALLET_API_LIBRARY").map(PathBuf::from);
    let windows_core_dll = env::var_os("DESKTOP_WINDOWS_MONERO_CORE_DLL").map(PathBuf::from);
    let windows_core_tree = env::var("DESKTOP_WINDOWS_MONERO_CORE_TREE").ok();
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
    let grpc_stream_enabled = env::var("DESKTOP_MONERO_GRPC_STREAM").as_deref() == Ok("1");
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
    if linked_with_monero {
        if cfg!(target_os = "windows") {
            if windows_core_tree.as_deref() != Some(expected_core_tree.as_str()) {
                panic!(
                    "Windows Monero Core DLL is stale or unauthenticated: expected tree {expected_core_tree}"
                );
            }
        } else {
            verify_monero_source_tree(
                source_dir.as_deref().expect("linked Core source path"),
                &expected_core_tree,
            );
        }
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
        "DESKTOP_WINDOWS_MONERO_CORE_TREE",
        "DESKTOP_MONERO_EXTRA_LINK_ARGS",
        "DESKTOP_MONERO_GRPC_STREAM",
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
        native.define(
            "TEX8_WALLET_BRIDGE_WITH_GRPC_STREAM",
            Some(if grpc_stream_enabled { "1" } else { "0" }),
        );
        let wallet_api_header = source_dir.join("src/wallet/api/wallet2_api.h");
        let wallet_api_source = fs::read_to_string(&wallet_api_header)
            .unwrap_or_else(|error| panic!("read {}: {error}", wallet_api_header.display()));
        if !wallet_api_source.contains("hardwarePrivateViewKey") {
            panic!(
                "authenticated Monero Core is missing the required TEX8 Ledger extension: {}",
                wallet_api_header.display()
            );
        }
        native.define("TEX8_WALLET_BRIDGE_WITH_TEX8_EXTENSIONS", Some("1"));
    } else if !cfg!(target_os = "windows") {
        native
            .define("TEX8_WALLET_BRIDGE_WITH_MONERO", Some("0"))
            .define("TEX8_WALLET_BRIDGE_WITH_GRPC_STREAM", Some("0"))
            .define("TEX8_WALLET_BRIDGE_WITH_TEX8_EXTENSIONS", Some("0"));
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
    println!(
        "cargo:rustc-env=TEX8_DESKTOP_MONERO_CORE_TREE={}",
        if linked_with_monero {
            expected_core_tree.as_str()
        } else {
            "unlinked"
        }
    );
}

fn configure_community_harrier() {
    println!("cargo:rustc-check-cfg=cfg(desktop_community_harrier)");
    const VARIABLES: [&str; 3] = [
        "DESKTOP_COMMUNITY_HARRIER_RUNTIME_LIBRARY",
        "DESKTOP_COMMUNITY_HARRIER_TOKENIZERS_LIBRARY",
        "DESKTOP_COMMUNITY_EXECUTORCH_APPLE_ROOT",
    ];
    for variable in VARIABLES {
        println!("cargo:rerun-if-env-changed={variable}");
    }

    let configured = VARIABLES.map(|variable| env::var_os(variable).map(PathBuf::from));
    if configured.iter().all(Option::is_none) {
        return;
    }
    if configured.iter().any(Option::is_none) {
        panic!(
            "the desktop Community runtime library, tokenizers library, and ExecuTorch Apple root must be configured together"
        );
    }
    if env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("macos")
        || env::var("CARGO_CFG_TARGET_ARCH").as_deref() != Ok("aarch64")
    {
        panic!("the configured desktop Community runtime currently supports Apple Silicon macOS");
    }

    let runtime = configured[0].as_ref().expect("checked runtime library");
    let tokenizers = configured[1].as_ref().expect("checked tokenizers library");
    let executorch = configured[2].as_ref().expect("checked ExecuTorch root");
    let dependencies = runtime
        .parent()
        .expect("Community runtime library has a parent directory")
        .join("libtex8_community_harrier_dependencies.a");
    let archives = [
        runtime.clone(),
        tokenizers.clone(),
        dependencies,
        executorch.join("executorch.xcframework/macos-arm64/libexecutorch_macos.a"),
        executorch.join("backend_xnnpack.xcframework/macos-arm64/libbackend_xnnpack_macos.a"),
        executorch.join("kernels_optimized.xcframework/macos-arm64/libkernels_optimized_macos.a"),
        executorch.join("kernels_quantized.xcframework/macos-arm64/libkernels_quantized_macos.a"),
        executorch.join("kernels_torchao.xcframework/macos-arm64/libkernels_torchao_macos.a"),
        executorch.join("threadpool.xcframework/macos-arm64/libthreadpool_macos.a"),
    ];
    for archive in archives {
        if !archive.is_file() {
            panic!(
                "configured desktop Community archive does not exist: {}",
                archive.display()
            );
        }
        let force_load = format!("-Wl,-force_load,{}", archive.display());
        // This Cargo package also contains the small Windows/Linux notification
        // agent. It never embeds or calls the macOS Harrier runtime, so global
        // link arguments would bloat it and make its independent link depend
        // on Apple's Accelerate/BLAS symbols.
        println!("cargo:rustc-link-arg-cdylib={force_load}");
        println!("cargo:rustc-link-arg-bin=monero-wallet-desktop={force_load}");
    }

    let swiftc = Command::new("xcrun")
        .args(["--find", "swiftc"])
        .output()
        .expect("locate the Apple Swift runtime");
    if !swiftc.status.success() {
        panic!("xcrun could not locate the Apple Swift runtime");
    }
    let swiftc = String::from_utf8(swiftc.stdout).expect("Swift compiler path is UTF-8");
    let swift_bin = PathBuf::from(swiftc.trim())
        .parent()
        .expect("Swift compiler has a parent directory")
        .to_path_buf();
    let swift_library = swift_bin.join("../lib/swift/macosx");
    if !swift_library.is_dir() {
        panic!(
            "Apple Swift runtime library directory does not exist: {}",
            swift_library.display()
        );
    }
    println!("cargo:rustc-link-search=native={}", swift_library.display());
    println!("cargo:rustc-link-lib=c++");
    println!("cargo:rustc-link-lib=framework=Accelerate");
    println!("cargo:rustc-link-lib=framework=Foundation");
    println!("cargo:rustc-cfg=desktop_community_harrier");
}

fn remove_stale_tauri_resources() {
    let Some(out_dir) = env::var_os("OUT_DIR").map(PathBuf::from) else {
        return;
    };
    let Some(profile_dir) = out_dir.ancestors().nth(3) else {
        return;
    };

    // tauri-build copies bundle resources directly into target/{debug,release}
    // without first removing an existing destination. Older staged Community
    // assets were read-only, so the next incremental build failed with EACCES.
    // Remove only our exact generated resource names before Tauri copies the
    // verified, owner-writable staging files again.
    for resource in [
        "artifact-manifest.json",
        "harrier-v1.pte",
        "tokenizer.json",
        "conformance.json",
    ] {
        let path = profile_dir.join(resource);
        match fs::remove_file(&path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => panic!("remove stale Tauri resource {}: {error}", path.display()),
        }
    }
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
    let configured_gateway_origin = manifest
        .pointer("/parameters/fastWalletOfficialWorker/gatewayOrigin")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    let configured_official_root = manifest
        .pointer("/parameters/fastWalletOfficialWorker/rootIdHex")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    let gateway_origin = env::var("FAST_WALLET_GATEWAY_ORIGIN")
        .unwrap_or_else(|_| configured_gateway_origin.to_owned());
    let official_root = env::var("FAST_WALLET_OFFICIAL_WORKER_ROOT_ID")
        .unwrap_or_else(|_| configured_official_root.to_owned());
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
