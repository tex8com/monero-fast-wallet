use std::{
    env, fs,
    io::Read,
    net::SocketAddr,
    path::{Path, PathBuf},
};

use mfw_private_directory::{
    directory_router, load_directory_state, phone_verification_router, voprf_router,
    DirectoryServiceState, DirectoryStateKey, PhoneVerificationIssuer,
    PhoneVerificationServiceState, RemotePhoneTokenDeriver, VoprfServiceState,
    WebhookPhoneVerificationProvider,
};
use mfw_recipient_protocol::{ContactSigningKey, OprfServerKey};
use tokio::net::TcpListener;
use zeroize::Zeroize;

#[tokio::main]
async fn main() -> Result<(), String> {
    harden_process()?;
    let bind: SocketAddr = env::var("MFW_PRIVATE_SERVICE_BIND")
        .unwrap_or_else(|_| "127.0.0.1:8094".to_owned())
        .parse()
        .map_err(|_| "MFW_PRIVATE_SERVICE_BIND is invalid")?;
    validate_bind(bind)?;
    let mode = required_env("MFW_PRIVATE_SERVICE_MODE")?;
    let router = match mode.as_str() {
        "voprf" => {
            let epoch = required_env("MFW_VOPRF_EPOCH")?
                .parse::<u64>()
                .map_err(|_| "MFW_VOPRF_EPOCH is invalid")?;
            let mut seed = read_secret_32(&required_path("MFW_VOPRF_SEED_FILE")?)?;
            let server =
                OprfServerKey::from_seed(epoch, &seed).map_err(|_| "VOPRF seed is invalid")?;
            seed.zeroize();
            let mut permit_key = read_secret_32(&required_path("MFW_VOPRF_PERMIT_KEY_FILE")?)?;
            let state = VoprfServiceState::new(server, permit_key);
            permit_key.zeroize();
            eprintln!(
                "mfw-private-directory VOPRF node listening on {bind}; epoch={epoch}; public_key={}",
                hex::encode(state.public_key())
            );
            voprf_router(state)
        }
        "verification" => {
            let epoch = required_env("MFW_VOPRF_EPOCH")?
                .parse::<u64>()
                .map_err(|_| "MFW_VOPRF_EPOCH is invalid")?;
            let evaluator_origins = [
                required_env("MFW_VOPRF_EVALUATOR_1_ORIGIN")?,
                required_env("MFW_VOPRF_EVALUATOR_2_ORIGIN")?,
            ];
            let evaluator_public_keys = [
                read_public_32(&required_path("MFW_VOPRF_EVALUATOR_1_PUBLIC_KEY_FILE")?)?,
                read_public_32(&required_path("MFW_VOPRF_EVALUATOR_2_PUBLIC_KEY_FILE")?)?,
            ];
            let mut evaluator_permit_keys = [
                read_secret_32(&required_path("MFW_VOPRF_EVALUATOR_1_PERMIT_KEY_FILE")?)?,
                read_secret_32(&required_path("MFW_VOPRF_EVALUATOR_2_PERMIT_KEY_FILE")?)?,
            ];
            let deriver = RemotePhoneTokenDeriver::new(
                epoch,
                [&evaluator_origins[0], &evaluator_origins[1]],
                evaluator_public_keys,
                evaluator_permit_keys,
            )
            .map_err(|_| "VOPRF evaluator configuration is invalid")?;
            let provider_origin = required_env("MFW_PHONE_PROVIDER_ORIGIN")?;
            let mut provider_authentication_key =
                read_secret_32(&required_path("MFW_PHONE_PROVIDER_AUTH_KEY_FILE")?)?;
            let provider = WebhookPhoneVerificationProvider::new(
                &provider_origin,
                provider_authentication_key,
            )
            .map_err(|_| "phone provider configuration is invalid")?;
            provider_authentication_key.zeroize();
            let mut verification_seed =
                read_secret_32(&required_path("MFW_PHONE_VERIFICATION_SIGNING_KEY_FILE")?)?;
            let verification_signing_key = ContactSigningKey::from_bytes(verification_seed);
            verification_seed.zeroize();
            let verification_public_key = verification_signing_key.public_key();
            let mut abuse_key =
                read_secret_32(&required_path("MFW_PHONE_VERIFICATION_ABUSE_KEY_FILE")?)?;
            let issuer = PhoneVerificationIssuer::new(
                epoch,
                provider,
                deriver,
                verification_signing_key,
                evaluator_permit_keys,
                abuse_key,
            );
            evaluator_permit_keys.zeroize();
            abuse_key.zeroize();
            let mut raw_state_key =
                read_secret_32(&required_path("MFW_DIRECTORY_STATE_KEY_FILE")?)?;
            let state_key = DirectoryStateKey::from_bytes(raw_state_key);
            raw_state_key.zeroize();
            let state_path = required_path("MFW_DIRECTORY_STATE_FILE")?;
            load_directory_state(&state_path, epoch, verification_public_key, &state_key)
                .map_err(|_| "authenticated directory state could not be loaded")?;
            eprintln!(
                "mfw-private-directory phone verification listening on {bind}; epoch={epoch}; verification_public_key={}",
                hex::encode(verification_public_key)
            );
            phone_verification_router(PhoneVerificationServiceState::new(
                issuer,
                epoch,
                verification_public_key,
                state_path,
                state_key,
            ))
        }
        "directory" => {
            let encoded = read_bounded_regular_file(
                &required_path("MFW_DIRECTORY_SNAPSHOT_FILE")?,
                mfw_recipient_protocol::phone::MAX_SNAPSHOT_BYTES,
            )?;
            let directory_key = read_public_32(&required_path("MFW_DIRECTORY_PUBLIC_KEY_FILE")?)?;
            let verification_key =
                read_public_32(&required_path("MFW_PHONE_VERIFICATION_PUBLIC_KEY_FILE")?)?;
            let state = DirectoryServiceState::verified(
                encoded,
                directory_key,
                verification_key,
                unix_seconds(),
            )?;
            eprintln!("mfw-private-directory read-only snapshot listening on {bind}");
            directory_router(state)
        }
        _ => {
            return Err(
                "MFW_PRIVATE_SERVICE_MODE must be voprf, verification, or directory".to_owned(),
            )
        }
    };
    let listener = TcpListener::bind(bind)
        .await
        .map_err(|_| "private directory could not bind")?;
    axum::serve(listener, router)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .map_err(|_| "private directory stopped unexpectedly".to_owned())
}

fn required_env(name: &str) -> Result<String, String> {
    env::var(name).map_err(|_| format!("{name} is required"))
}

fn validate_bind(bind: SocketAddr) -> Result<(), String> {
    if bind.ip().is_loopback() {
        Ok(())
    } else {
        Err(
            "MFW_PRIVATE_SERVICE_BIND must be loopback; expose it only through reviewed TLS"
                .to_owned(),
        )
    }
}

fn required_path(name: &str) -> Result<PathBuf, String> {
    let value = required_env(name)?;
    if value.is_empty() {
        return Err(format!("{name} must not be empty"));
    }
    Ok(PathBuf::from(value))
}

fn read_secret_32(path: &Path) -> Result<[u8; 32], String> {
    read_canonical_hex_32(path, true)
}

fn read_public_32(path: &Path) -> Result<[u8; 32], String> {
    read_canonical_hex_32(path, false)
}

fn read_canonical_hex_32(path: &Path, secret: bool) -> Result<[u8; 32], String> {
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let file = options
        .open(path)
        .map_err(|_| "credential file could not be opened safely")?;
    let metadata = file
        .metadata()
        .map_err(|_| "credential file could not be inspected")?;
    if !metadata.is_file() || metadata.len() > 256 {
        return Err("credential must be a small regular file".to_owned());
    }
    #[cfg(unix)]
    if secret {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err("secret file grants group or world access".to_owned());
        }
    }
    #[cfg(not(unix))]
    let _ = secret;
    let mut raw = zeroize::Zeroizing::new(Vec::with_capacity(65));
    file.take(257)
        .read_to_end(&mut raw)
        .map_err(|_| "credential file could not be read")?;
    let value = raw.strip_suffix(b"\n").unwrap_or(&raw);
    if value.len() != 64 {
        return Err("credential must be 64 lowercase hexadecimal characters".to_owned());
    }
    let mut decoded = [0; 32];
    for (index, pair) in value.chunks_exact(2).enumerate() {
        decoded[index] = (lower_hex_nibble(pair[0])? << 4) | lower_hex_nibble(pair[1])?;
    }
    Ok(decoded)
}

fn read_bounded_regular_file(path: &Path, maximum: usize) -> Result<Vec<u8>, String> {
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let file = options
        .open(path)
        .map_err(|_| "snapshot file could not be opened safely")?;
    let metadata = file
        .metadata()
        .map_err(|_| "snapshot file could not be inspected")?;
    if !metadata.is_file()
        || metadata.len() > u64::try_from(maximum).map_err(|_| "snapshot size is invalid")?
    {
        return Err("snapshot exceeds its size limit or is not a regular file".to_owned());
    }
    let capacity = usize::try_from(metadata.len()).map_err(|_| "snapshot size is invalid")?;
    let mut encoded = Vec::with_capacity(capacity);
    file.take(
        u64::try_from(maximum)
            .map_err(|_| "snapshot size is invalid")?
            .saturating_add(1),
    )
    .read_to_end(&mut encoded)
    .map_err(|_| "snapshot file could not be read")?;
    if encoded.len() > maximum {
        return Err("snapshot exceeds its size limit".to_owned());
    }
    Ok(encoded)
}

fn lower_hex_nibble(byte: u8) -> Result<u8, String> {
    match byte {
        b'0'..=b'9' => Ok(byte - b'0'),
        b'a'..=b'f' => Ok(byte - b'a' + 10),
        _ => Err("credential must be 64 lowercase hexadecimal characters".to_owned()),
    }
}

fn harden_process() -> Result<(), String> {
    #[cfg(unix)]
    {
        let limit = libc::rlimit {
            rlim_cur: 0,
            rlim_max: 0,
        };
        // SAFETY: documented setrlimit arguments only.
        if unsafe { libc::setrlimit(libc::RLIMIT_CORE, &limit) } != 0 {
            return Err("could not disable core dumps".to_owned());
        }
    }
    #[cfg(target_os = "linux")]
    {
        // SAFETY: PR_SET_DUMPABLE accepts scalar arguments.
        if unsafe { libc::prctl(libc::PR_SET_DUMPABLE, 0, 0, 0, 0) } != 0 {
            return Err("could not disable process dumping".to_owned());
        }
    }
    Ok(())
}

fn unix_seconds() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |duration| duration.as_secs())
}

async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn secret_loader_requires_private_regular_non_symlink_file() {
        use std::os::unix::fs::{symlink, PermissionsExt};

        let directory = tempfile::tempdir().unwrap();
        let secret = directory.path().join("secret");
        fs::write(&secret, format!("{}\n", "ab".repeat(32))).unwrap();
        fs::set_permissions(&secret, fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(read_secret_32(&secret).unwrap(), [0xab; 32]);

        fs::set_permissions(&secret, fs::Permissions::from_mode(0o640)).unwrap();
        assert!(read_secret_32(&secret).is_err());
        fs::set_permissions(&secret, fs::Permissions::from_mode(0o600)).unwrap();

        let link = directory.path().join("secret-link");
        symlink(&secret, &link).unwrap();
        assert!(read_secret_32(&link).is_err());

        fs::write(&secret, "AB".repeat(32)).unwrap();
        assert!(read_secret_32(&secret).is_err());
    }

    #[test]
    fn service_bind_is_loopback_only() {
        assert!(validate_bind("127.0.0.1:8094".parse().unwrap()).is_ok());
        assert!(validate_bind("[::1]:8094".parse().unwrap()).is_ok());
        assert!(validate_bind("0.0.0.0:8094".parse().unwrap()).is_err());
        assert!(validate_bind("[::]:8094".parse().unwrap()).is_err());
    }
}
