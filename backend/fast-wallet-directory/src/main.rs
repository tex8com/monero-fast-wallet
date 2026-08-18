use fast_wallet_directory::{router, DirectoryState};
use fast_wallet_protocol::{Network, SigningKeyMaterial};
use std::{
    env,
    fs::OpenOptions,
    io::Read,
    net::SocketAddr,
    path::{Path, PathBuf},
};
use tokio::net::TcpListener;
use zeroize::{Zeroize, Zeroizing};

#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

#[tokio::main]
async fn main() -> Result<(), String> {
    harden_process()?;
    let bind: SocketAddr = env::var("FAST_WALLET_DIRECTORY_BIND")
        .unwrap_or_else(|_| "127.0.0.1:8096".to_owned())
        .parse()
        .map_err(|_| "FAST_WALLET_DIRECTORY_BIND is invalid".to_owned())?;
    let state_path = required_path("FAST_WALLET_DIRECTORY_STATE")?;
    let expected_network = parse_network(
        &env::var("FAST_WALLET_DIRECTORY_NETWORK").unwrap_or_else(|_| "mainnet".to_owned()),
    )?;
    let expected_relay_origin = env::var("FAST_WALLET_DIRECTORY_RELAY_ORIGIN")
        .map_err(|_| "FAST_WALLET_DIRECTORY_RELAY_ORIGIN is required".to_owned())?;
    let mut signing_secret = load_secret_file(&required_path(
        "FAST_WALLET_DIRECTORY_ADMISSION_SIGNING_KEY_FILE",
    )?)?;
    let signing_key = SigningKeyMaterial::from_bytes(signing_secret);
    signing_secret.zeroize();
    let mut admin_token =
        load_secret_file(&required_path("FAST_WALLET_DIRECTORY_ADMIN_TOKEN_FILE")?)?;
    let state = DirectoryState::open(
        state_path,
        signing_key,
        admin_token,
        expected_network,
        expected_relay_origin,
    )?;
    admin_token.zeroize();
    eprintln!(
        "fast-wallet-directory admissionPublicKey={} listening={bind}",
        hex::encode(state.admission_public_key())
    );
    let listener = TcpListener::bind(bind)
        .await
        .map_err(|_| "Fast Wallet Directory could not bind".to_owned())?;
    axum::serve(listener, router(state))
        .with_graceful_shutdown(shutdown_signal())
        .await
        .map_err(|_| "Fast Wallet Directory stopped unexpectedly".to_owned())
}

fn parse_network(value: &str) -> Result<Network, String> {
    match value {
        "mainnet" => Ok(Network::Mainnet),
        "testnet" => Ok(Network::Testnet),
        "stagenet" => Ok(Network::Stagenet),
        _ => Err("FAST_WALLET_DIRECTORY_NETWORK is invalid".to_owned()),
    }
}

fn required_path(name: &str) -> Result<PathBuf, String> {
    env::var(name)
        .map(PathBuf::from)
        .map_err(|_| format!("{name} is required"))
}

fn load_secret_file(path: &Path) -> Result<[u8; 32], String> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    options.custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW);
    let mut file = options
        .open(path)
        .map_err(|_| "Directory credential file could not be opened securely".to_owned())?;
    let metadata = file
        .metadata()
        .map_err(|_| "Directory credential metadata is unavailable".to_owned())?;
    if !metadata.is_file() || metadata.len() > 1_024 {
        return Err("Directory credential file is invalid".to_owned());
    }
    #[cfg(unix)]
    if metadata.permissions().mode() & 0o077 != 0 {
        return Err("Directory credential file permissions are unsafe".to_owned());
    }
    let mut raw = Zeroizing::new(Vec::new());
    file.read_to_end(&mut raw)
        .map_err(|_| "Directory credential file could not be read".to_owned())?;
    let value = std::str::from_utf8(&raw)
        .map_err(|_| "Directory credential must be lowercase hex".to_owned())?
        .trim();
    if value.len() != 64
        || value
            .bytes()
            .any(|byte| !byte.is_ascii_hexdigit() || byte.is_ascii_uppercase())
    {
        return Err("Directory credential must contain 32 lowercase-hex bytes".to_owned());
    }
    let decoded = Zeroizing::new(
        hex::decode(value).map_err(|_| "Directory credential is invalid".to_owned())?,
    );
    decoded
        .as_slice()
        .try_into()
        .map_err(|_| "Directory credential must contain 32 bytes".to_owned())
}

fn harden_process() -> Result<(), String> {
    #[cfg(unix)]
    {
        let limit = libc::rlimit {
            rlim_cur: 0,
            rlim_max: 0,
        };
        if unsafe { libc::setrlimit(libc::RLIMIT_CORE, &limit) } != 0 {
            return Err("Fast Wallet Directory could not disable core dumps".to_owned());
        }
        if unsafe { libc::mlockall(libc::MCL_CURRENT | libc::MCL_FUTURE) } != 0 {
            return Err("Fast Wallet Directory could not lock memory".to_owned());
        }
    }
    #[cfg(target_os = "linux")]
    if unsafe { libc::prctl(libc::PR_SET_DUMPABLE, 0, 0, 0, 0) } != 0 {
        return Err("Fast Wallet Directory could not become non-dumpable".to_owned());
    }
    Ok(())
}

async fn shutdown_signal() {
    let ctrl_c = async {
        drop(tokio::signal::ctrl_c().await);
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
