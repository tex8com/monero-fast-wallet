use fast_wallet_relay::{router, RelayApiState, RelayMailbox};
use std::{env, fs::OpenOptions, io::Read, net::SocketAddr, path::Path};
use tokio::net::TcpListener;
use zeroize::Zeroize;

#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

#[tokio::main]
async fn main() -> Result<(), String> {
    disable_core_dumps()?;
    let bind: SocketAddr = env::var("FAST_WALLET_RELAY_BIND")
        .unwrap_or_else(|_| "127.0.0.1:8091".to_owned())
        .parse()
        .map_err(|_| "FAST_WALLET_RELAY_BIND is invalid".to_owned())?;
    let state_path = env::var("FAST_WALLET_RELAY_STATE")
        .unwrap_or_else(|_| "./fast-wallet-relay-state.json".to_owned());
    let credential_path = env::var("FAST_WALLET_RELAY_INTERNAL_AUTH_FILE")
        .map_err(|_| "FAST_WALLET_RELAY_INTERNAL_AUTH_FILE is required".to_owned())?;
    let internal_auth = load_secret_file(Path::new(&credential_path))?;
    let mailbox = RelayMailbox::open(state_path)
        .map_err(|error| format!("Fast Wallet Relay state could not be opened: {error}"))?;
    let listener = TcpListener::bind(bind)
        .await
        .map_err(|_| "Fast Wallet Relay could not bind".to_owned())?;
    eprintln!("fast-wallet-relay listening on {bind}");
    axum::serve(listener, router(RelayApiState::new(mailbox, internal_auth)))
        .with_graceful_shutdown(shutdown_signal())
        .await
        .map_err(|_| "Fast Wallet Relay stopped unexpectedly".to_owned())
}

fn load_secret_file(path: &Path) -> Result<[u8; 32], String> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    options.custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW);
    let mut file = options
        .open(path)
        .map_err(|_| "Relay credential file could not be opened securely".to_owned())?;
    let metadata = file
        .metadata()
        .map_err(|_| "Relay credential file metadata is unavailable".to_owned())?;
    if !metadata.is_file() || metadata.len() > 1_024 {
        return Err("Relay credential file is invalid".to_owned());
    }
    #[cfg(unix)]
    if metadata.permissions().mode() & 0o077 != 0 {
        return Err("Relay credential file must not grant group/world access".to_owned());
    }
    let mut material = Vec::new();
    file.read_to_end(&mut material)
        .map_err(|_| "Relay credential file could not be read".to_owned())?;
    let mut secret = if material.len() == 32 {
        let mut result = [0_u8; 32];
        result.copy_from_slice(&material);
        result
    } else {
        let value = std::str::from_utf8(&material)
            .map_err(|_| "Relay credential must be 32 raw bytes or lowercase hex".to_owned())?
            .trim();
        if value.bytes().any(|byte| byte.is_ascii_uppercase()) {
            return Err("Relay credential hex must be lowercase".to_owned());
        }
        hex::decode(value)
            .map_err(|_| "Relay credential is invalid".to_owned())?
            .try_into()
            .map_err(|_| "Relay credential must contain exactly 32 bytes".to_owned())?
    };
    material.zeroize();
    let result = secret;
    secret.zeroize();
    Ok(result)
}

fn disable_core_dumps() -> Result<(), String> {
    #[cfg(unix)]
    {
        let limit = libc::rlimit {
            rlim_cur: 0,
            rlim_max: 0,
        };
        if unsafe { libc::setrlimit(libc::RLIMIT_CORE, &limit) } != 0 {
            return Err("Relay could not disable core dumps".to_owned());
        }
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
