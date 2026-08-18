use ed25519_dalek::SigningKey;
use notification_registration_adapter::{router, AdapterState, FirebaseAppCheckVerifier};
use std::{env, fs::OpenOptions, io::Read, net::SocketAddr, path::Path, sync::Arc, time::Duration};
use tokio::net::TcpListener;
use zeroize::{Zeroize, Zeroizing};

#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

const FIREBASE_JWKS: &str = "https://firebaseappcheck.googleapis.com/v1/jwks";

fn main() -> Result<(), String> {
    harden_process()?;
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|_| "registration adapter runtime could not be created".to_owned())?
        .block_on(run())
}

async fn run() -> Result<(), String> {
    let bind: SocketAddr = env::var("NOTIFICATION_REGISTRATION_ADAPTER_BIND")
        .unwrap_or_else(|_| "127.0.0.1:8093".to_owned())
        .parse()
        .map_err(|_| "NOTIFICATION_REGISTRATION_ADAPTER_BIND is invalid".to_owned())?;
    let project_number = required_env("NOTIFICATION_REGISTRATION_FIREBASE_PROJECT_NUMBER")?;
    let app_ids = required_env("NOTIFICATION_REGISTRATION_FIREBASE_APP_IDS")?
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .collect::<Vec<_>>();
    let jwks = env::var("NOTIFICATION_REGISTRATION_FIREBASE_JWKS_URL")
        .unwrap_or_else(|_| FIREBASE_JWKS.to_owned());
    let verifier =
        FirebaseAppCheckVerifier::new(project_number, app_ids, jwks, Duration::from_secs(5))?;
    let mut signing_secret = load_secret_file(Path::new(&required_env(
        "NOTIFICATION_REGISTRATION_SIGNING_KEY_FILE",
    )?))?;
    let signing_key = SigningKey::from_bytes(&signing_secret);
    signing_secret.zeroize();
    let listener = TcpListener::bind(bind)
        .await
        .map_err(|_| "registration adapter could not bind".to_owned())?;
    eprintln!("notification-registration-adapter listening on {bind}");
    axum::serve(
        listener,
        router(AdapterState::new(Arc::new(verifier), signing_key)),
    )
    .with_graceful_shutdown(shutdown_signal())
    .await
    .map_err(|_| "registration adapter stopped unexpectedly".to_owned())
}

fn required_env(name: &str) -> Result<String, String> {
    env::var(name)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("{name} is required"))
}

fn load_secret_file(path: &Path) -> Result<[u8; 32], String> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    options.custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW);
    let mut file = options
        .open(path)
        .map_err(|_| "registration adapter signing key could not be opened securely".to_owned())?;
    let metadata = file
        .metadata()
        .map_err(|_| "registration adapter signing-key metadata is unavailable".to_owned())?;
    if !metadata.is_file() || metadata.len() > 1_024 {
        return Err("registration adapter signing key is invalid".to_owned());
    }
    #[cfg(unix)]
    if metadata.permissions().mode() & 0o077 != 0 {
        return Err("registration adapter signing-key permissions are unsafe".to_owned());
    }
    let mut raw = Zeroizing::new(Vec::new());
    file.read_to_end(&mut raw)
        .map_err(|_| "registration adapter signing key could not be read".to_owned())?;
    let value = std::str::from_utf8(&raw)
        .map_err(|_| "registration adapter signing key must be lowercase hex".to_owned())?
        .trim();
    if value.len() != 64
        || value
            .bytes()
            .any(|byte| byte.is_ascii_uppercase() || !byte.is_ascii_hexdigit())
    {
        return Err("registration adapter signing key must be 32 lowercase-hex bytes".to_owned());
    }
    let decoded = Zeroizing::new(
        hex::decode(value).map_err(|_| "registration adapter signing key is invalid".to_owned())?,
    );
    decoded
        .as_slice()
        .try_into()
        .map_err(|_| "registration adapter signing key must be 32 bytes".to_owned())
}

fn harden_process() -> Result<(), String> {
    #[cfg(unix)]
    {
        let limit = libc::rlimit {
            rlim_cur: 0,
            rlim_max: 0,
        };
        if unsafe { libc::setrlimit(libc::RLIMIT_CORE, &limit) } != 0 {
            return Err("registration adapter could not disable core dumps".to_owned());
        }
        if unsafe { libc::mlockall(libc::MCL_CURRENT | libc::MCL_FUTURE) } != 0 {
            return Err("registration adapter could not lock memory".to_owned());
        }
    }
    #[cfg(target_os = "linux")]
    if unsafe { libc::prctl(libc::PR_SET_DUMPABLE, 0, 0, 0, 0) } != 0 {
        return Err("registration adapter could not become non-dumpable".to_owned());
    }
    Ok(())
}

async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
}
