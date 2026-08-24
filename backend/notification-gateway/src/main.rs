use ed25519_dalek::VerifyingKey;
use fast_wallet_protocol::WorkerDescriptor;
use notification_gateway::{
    provider::{ApnsDeliveryConfig, DirectProviderDelivery, FcmCredentials, FcmDeliveryConfig},
    router, GatewayState, HttpRelayControl, HttpWorkerAdmissionDirectory,
};
use std::{
    env,
    fs::OpenOptions,
    io::Read,
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::net::TcpListener;
use zeroize::{Zeroize, Zeroizing};

#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

fn main() -> Result<(), String> {
    harden_process()?;
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|_| "notification Gateway runtime could not be created".to_owned())?
        .block_on(run())
}

async fn run() -> Result<(), String> {
    let bind: SocketAddr = env::var("NOTIFICATION_GATEWAY_BIND")
        .unwrap_or_else(|_| "127.0.0.1:8090".to_owned())
        .parse()
        .map_err(|_| "NOTIFICATION_GATEWAY_BIND is invalid".to_owned())?;
    let event_storage = required_path("NOTIFICATION_GATEWAY_EVENT_STORE")?;
    let provider_storage = required_path("NOTIFICATION_GATEWAY_PROVIDER_STORE")?;
    let mut provider_storage_key = load_secret_file(&required_path(
        "NOTIFICATION_GATEWAY_PROVIDER_STORAGE_KEY_FILE",
    )?)?;
    let registration_key = VerifyingKey::from_bytes(&load_public_key_file(&required_path(
        "NOTIFICATION_GATEWAY_REGISTRATION_PUBLIC_KEY_FILE",
    )?)?)
    .map_err(|_| "Gateway registration public key is invalid".to_owned())?;
    let fcm_project_id = optional_env("NOTIFICATION_GATEWAY_FCM_PROJECT_ID");
    let fcm_access_token_file = optional_env("NOTIFICATION_GATEWAY_FCM_ACCESS_TOKEN_FILE");
    let fcm_service_account_file = optional_env("NOTIFICATION_GATEWAY_FCM_SERVICE_ACCOUNT_FILE");
    let fcm = match (fcm_project_id, fcm_access_token_file, fcm_service_account_file) {
        (None, None, None) => None,
        (Some(project_id), Some(token_file), None) => Some(FcmDeliveryConfig {
            project_id,
            credentials: FcmCredentials::AccessTokenFile(PathBuf::from(token_file)),
        }),
        (Some(project_id), None, Some(service_account_file)) => Some(FcmDeliveryConfig {
            project_id,
            credentials: FcmCredentials::ServiceAccountFile(PathBuf::from(service_account_file)),
        }),
        _ => return Err("NOTIFICATION_GATEWAY_FCM_PROJECT_ID and exactly one FCM credential source must be configured together".to_owned()),
    };
    let apns = optional_pair(
        "NOTIFICATION_GATEWAY_APNS_TOPIC",
        "NOTIFICATION_GATEWAY_APNS_PROVIDER_JWT_FILE",
    )?
    .map(
        |(topic, provider_jwt_file)| -> Result<ApnsDeliveryConfig, String> {
            Ok(ApnsDeliveryConfig {
                topic,
                provider_jwt_file: PathBuf::from(provider_jwt_file),
                sandbox: env_bool("NOTIFICATION_GATEWAY_APNS_SANDBOX", false)?,
            })
        },
    )
    .transpose()?;
    let delivery = Arc::new(DirectProviderDelivery::new(
        fcm,
        apns,
        Duration::from_millis(env_u64("NOTIFICATION_GATEWAY_PROVIDER_TIMEOUT_MS", 10_000)?),
    )?);
    delivery.validate_credentials()?;
    let mut relay_internal_auth = load_secret_file(&required_path(
        "NOTIFICATION_GATEWAY_RELAY_INTERNAL_AUTH_FILE",
    )?)?;
    let relay_control = HttpRelayControl::new(
        required_env("NOTIFICATION_GATEWAY_RELAY_ORIGIN")?,
        relay_internal_auth,
        Duration::from_millis(env_u64("NOTIFICATION_GATEWAY_RELAY_TIMEOUT_MS", 10_000)?),
    );
    relay_internal_auth.zeroize();
    let relay_control = Arc::new(relay_control?);
    let state_result = GatewayState::open_with_provider_adapter(
        event_storage,
        provider_storage,
        provider_storage_key,
        registration_key,
        delivery,
    );
    provider_storage_key.zeroize();
    let official_worker_descriptor = load_worker_descriptor_file(&required_path(
        "NOTIFICATION_GATEWAY_OFFICIAL_WORKER_DESCRIPTOR_FILE",
    )?)?;
    let worker_directory = Arc::new(HttpWorkerAdmissionDirectory::new(
        required_env("NOTIFICATION_GATEWAY_WORKER_DIRECTORY_ORIGIN")?,
        load_public_key_file(&required_path(
            "NOTIFICATION_GATEWAY_WORKER_DIRECTORY_PUBLIC_KEY_FILE",
        )?)?,
        Duration::from_millis(env_u64(
            "NOTIFICATION_GATEWAY_WORKER_DIRECTORY_TIMEOUT_MS",
            5_000,
        )?),
    )?);
    let official_maximum = env_usize(
        "NOTIFICATION_GATEWAY_OFFICIAL_WORKER_MAXIMUM_ASSIGNMENTS",
        100_000,
    )?;
    let private_maximum = env_usize("NOTIFICATION_GATEWAY_PRIVATE_WORKER_MAXIMUM_ASSIGNMENTS", 8)?;
    let mut state = state_result?
        .with_relay_control(relay_control)
        .with_official_worker_descriptor(official_worker_descriptor, unix_seconds())?
        .with_worker_admission_directory(worker_directory)
        .with_worker_assignment_limits(official_maximum, private_maximum)?;
    if let Some(path) = optional_env("NOTIFICATION_GATEWAY_VANITY_SERVICE_AUTH_FILE") {
        let mut auth = load_secret_file(Path::new(&path))?;
        state = state.with_vanity_service_auth(auth);
        auth.zeroize();
    }
    let listener = TcpListener::bind(bind)
        .await
        .map_err(|_| "notification gateway could not bind".to_owned())?;
    let dispatch_state = state.clone();
    let dispatch_interval =
        Duration::from_millis(env_u64("NOTIFICATION_GATEWAY_PROVIDER_DISPATCH_MS", 500)?);
    let dispatcher = tokio::spawn(async move {
        let mut timer = tokio::time::interval(dispatch_interval);
        loop {
            timer.tick().await;
            match dispatch_state.dispatch_provider_once(unix_seconds(), 100).await {
                Ok(result) if result.attempted > 0 => eprintln!(
                    "FAST_WALLET_DIAGNOSTICS service=notification-gateway event=provider-dispatch.complete attempted={} delivered={} deferred={} invalidTokens={}",
                    result.attempted,
                    result.delivered,
                    result.deferred,
                    result.invalid_tokens
                ),
                Ok(_) => {}
                Err(error) => {
                    eprintln!("notification Gateway provider dispatch deferred: {error}");
                    eprintln!("FAST_WALLET_DIAGNOSTICS service=notification-gateway event=provider-dispatch.error");
                }
            }
        }
    });
    eprintln!("notification-gateway listening on {bind}");
    let served = axum::serve(listener, router(state))
        .with_graceful_shutdown(shutdown_signal())
        .await
        .map_err(|_| "notification gateway stopped unexpectedly".to_owned());
    dispatcher.abort();
    served
}

fn harden_process() -> Result<(), String> {
    #[cfg(unix)]
    {
        let limit = libc::rlimit {
            rlim_cur: 0,
            rlim_max: 0,
        };
        // SAFETY: setrlimit and mlockall receive documented values only.
        if unsafe { libc::setrlimit(libc::RLIMIT_CORE, &limit) } != 0 {
            return Err("notification Gateway could not disable core dumps".to_owned());
        }
        if unsafe { libc::mlockall(libc::MCL_CURRENT | libc::MCL_FUTURE) } != 0 {
            return Err(
                "notification Gateway could not lock memory; raise its memlock limit".to_owned(),
            );
        }
    }
    #[cfg(target_os = "linux")]
    {
        // SAFETY: prctl uses PR_SET_DUMPABLE with scalar arguments only.
        if unsafe { libc::prctl(libc::PR_SET_DUMPABLE, 0, 0, 0, 0) } != 0 {
            return Err("notification Gateway could not become non-dumpable".to_owned());
        }
    }
    Ok(())
}

fn load_secret_file(path: &Path) -> Result<[u8; 32], String> {
    let raw = read_credential_file(path, true)?;
    decode_lower_hex_32(&raw, "Gateway secret credential")
}

fn load_public_key_file(path: &Path) -> Result<[u8; 32], String> {
    let raw = read_credential_file(path, false)?;
    decode_lower_hex_32(&raw, "Gateway registration public key")
}

fn load_worker_descriptor_file(path: &Path) -> Result<WorkerDescriptor, String> {
    let raw = read_credential_file(path, false)?;
    let value = std::str::from_utf8(&raw)
        .map_err(|_| "official Worker descriptor must be lowercase hex")?
        .trim();
    if value.is_empty()
        || value.len() > 8_192
        || value.len() % 2 != 0
        || value
            .bytes()
            .any(|byte| byte.is_ascii_uppercase() || !byte.is_ascii_hexdigit())
    {
        return Err("official Worker descriptor must be canonical lowercase hex".to_owned());
    }
    let decoded =
        hex::decode(value).map_err(|_| "official Worker descriptor is invalid".to_owned())?;
    let descriptor = WorkerDescriptor::decode(&decoded)
        .map_err(|_| "official Worker descriptor is invalid".to_owned())?;
    descriptor
        .verify(descriptor.network, unix_seconds())
        .map_err(|_| "official Worker descriptor is expired or invalid".to_owned())?;
    Ok(descriptor)
}

fn read_credential_file(path: &Path, private: bool) -> Result<Zeroizing<Vec<u8>>, String> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    options.custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW);
    let mut file = options
        .open(path)
        .map_err(|_| "Gateway credential file could not be opened securely".to_owned())?;
    let metadata = file
        .metadata()
        .map_err(|_| "Gateway credential metadata is unavailable".to_owned())?;
    if !metadata.is_file() || metadata.len() > 1_024 {
        return Err("Gateway credential file is invalid".to_owned());
    }
    #[cfg(unix)]
    if (private && metadata.permissions().mode() & 0o077 != 0)
        || (!private && metadata.permissions().mode() & 0o022 != 0)
    {
        return Err("Gateway credential file permissions are unsafe".to_owned());
    }
    let mut raw = Zeroizing::new(Vec::new());
    file.read_to_end(&mut raw)
        .map_err(|_| "Gateway credential file could not be read".to_owned())?;
    Ok(raw)
}

fn decode_lower_hex_32(raw: &[u8], label: &str) -> Result<[u8; 32], String> {
    let value = std::str::from_utf8(raw)
        .map_err(|_| format!("{label} must be lowercase hex"))?
        .trim();
    if value.len() != 64
        || value
            .bytes()
            .any(|byte| byte.is_ascii_uppercase() || !byte.is_ascii_hexdigit())
    {
        return Err(format!(
            "{label} must contain exactly 32 lowercase-hex bytes"
        ));
    }
    let decoded = Zeroizing::new(hex::decode(value).map_err(|_| format!("{label} is invalid"))?);
    decoded
        .as_slice()
        .try_into()
        .map_err(|_| format!("{label} must contain exactly 32 bytes"))
}

fn required_path(name: &str) -> Result<PathBuf, String> {
    Ok(PathBuf::from(required_env(name)?))
}

fn required_env(name: &str) -> Result<String, String> {
    env::var(name)
        .map(|value| value.trim().to_owned())
        .ok()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("{name} is required"))
}

fn optional_pair(first: &str, second: &str) -> Result<Option<(String, String)>, String> {
    let first_value = env::var(first)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty());
    let second_value = env::var(second)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty());
    match (first_value, second_value) {
        (None, None) => Ok(None),
        (Some(first_value), Some(second_value)) => Ok(Some((first_value, second_value))),
        _ => Err(format!("{first} and {second} must be configured together")),
    }
}

fn optional_env(name: &str) -> Option<String> {
    env::var(name)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

fn env_u64(name: &str, default: u64) -> Result<u64, String> {
    env::var(name)
        .ok()
        .map(|value| value.parse::<u64>())
        .transpose()
        .map_err(|_| format!("{name} must be an unsigned integer"))
        .map(|value| value.unwrap_or(default))
}

fn env_usize(name: &str, default: usize) -> Result<usize, String> {
    env::var(name)
        .ok()
        .map(|value| value.parse::<usize>())
        .transpose()
        .map_err(|_| format!("{name} must be an unsigned integer"))
        .map(|value| value.unwrap_or(default))
}

fn env_bool(name: &str, default: bool) -> Result<bool, String> {
    match env::var(name).ok().as_deref() {
        None => Ok(default),
        Some("true") => Ok(true),
        Some("false") => Ok(false),
        Some(_) => Err(format!("{name} must be true or false")),
    }
}

fn unix_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        let Ok(mut signal) =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        else {
            return;
        };
        signal.recv().await;
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! { _ = ctrl_c => {}, _ = terminate => {} }
}
