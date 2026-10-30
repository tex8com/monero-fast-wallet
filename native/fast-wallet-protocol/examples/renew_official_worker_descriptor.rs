use fast_wallet_protocol::{
    HpkePrivateKey, Network, SigningKeyMaterial, WorkerDescriptor, WorkerDescriptorInput,
};
use std::{
    env,
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use zeroize::{Zeroize, Zeroizing};

#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

const DESCRIPTOR_LIFETIME_SECONDS: u64 = 30 * 24 * 60 * 60;

fn main() -> Result<(), String> {
    let mut arguments = env::args().skip(1);
    let material = arguments.next().map(PathBuf::from).ok_or_else(usage)?;
    let output = arguments.next().map(PathBuf::from).ok_or_else(usage)?;
    let relay_origin = arguments.next().ok_or_else(usage)?;
    let network = match arguments.next().as_deref() {
        Some("mainnet") => Network::Mainnet,
        Some("testnet") => Network::Testnet,
        Some("stagenet") => Network::Stagenet,
        _ => return Err(usage()),
    };
    if arguments.next().is_some() {
        return Err(usage());
    }

    let existing = read_descriptor(&material.join("worker-descriptor.hex"))?;
    existing
        .verify(existing.network, existing.issued_at)
        .map_err(|_| "Existing Worker descriptor signature is invalid".to_owned())?;

    let mut root_secret = read_secret(&material.join("worker-root-signing.key"))?;
    let root = SigningKeyMaterial::from_bytes(root_secret);
    root_secret.zeroize();
    let mut online_secret = read_secret(&material.join("worker-online-signing.key"))?;
    let online = SigningKeyMaterial::from_bytes(online_secret);
    online_secret.zeroize();
    let mut hpke_secret = read_secret(&material.join("worker-hpke.key"))?;
    let hpke = HpkePrivateKey::from_bytes(hpke_secret);
    hpke_secret.zeroize();
    let hpke_public = hpke
        .public_key()
        .map_err(|_| "Worker HPKE public key could not be derived".to_owned())?;

    if existing.network != network
        || existing.relay_origin != relay_origin
        || existing.worker_root_public_key != root.public_key()
        || existing.worker_online_public_key != online.public_key()
        || existing.hpke_public_key != hpke_public
    {
        return Err(
            "Existing descriptor does not match the requested network, origin, or key material"
                .to_owned(),
        );
    }

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "System clock is invalid".to_owned())?
        .as_secs();
    let renewed = WorkerDescriptor::sign(
        WorkerDescriptorInput {
            network,
            issued_at: now,
            expires_at: now + DESCRIPTOR_LIFETIME_SECONDS,
            worker_online_public_key: online.public_key(),
            hpke_public_key: hpke_public,
            relay_origin,
        },
        &root,
    )
    .map_err(|_| "Official Worker descriptor could not be renewed".to_owned())?;

    create_private_directory(&output)?;
    let encoded = renewed
        .encode()
        .map_err(|_| "Renewed Worker descriptor could not be encoded".to_owned())?;
    write_new(
        &output.join("worker-descriptor.hex"),
        &format!("{}\n", hex::encode(encoded)),
        0o644,
    )?;
    println!("Official Worker descriptor renewed without rotating Worker keys.");
    println!("Descriptor expires at Unix time {}.", renewed.expires_at);
    println!("Only worker-descriptor.hex may be uploaded; keep all key files offline.");
    Ok(())
}

fn usage() -> String {
    "Usage: renew_official_worker_descriptor <existing-private-directory> <new-output-directory> <https-relay-origin> <mainnet|testnet|stagenet>".to_owned()
}

fn read_descriptor(path: &Path) -> Result<WorkerDescriptor, String> {
    let encoded = read_bounded(path, false)?;
    let value = std::str::from_utf8(&encoded)
        .map_err(|_| "Existing Worker descriptor must be lowercase hex".to_owned())?
        .trim();
    if value.is_empty() || value.bytes().any(|byte| byte.is_ascii_uppercase()) {
        return Err("Existing Worker descriptor must be lowercase hex".to_owned());
    }
    let bytes =
        hex::decode(value).map_err(|_| "Existing Worker descriptor is not valid hex".to_owned())?;
    WorkerDescriptor::decode(&bytes).map_err(|_| "Existing Worker descriptor is invalid".to_owned())
}

fn read_secret(path: &Path) -> Result<[u8; 32], String> {
    let material = Zeroizing::new(read_bounded(path, true)?);
    let result = if material.len() == 32 {
        material
            .as_slice()
            .try_into()
            .map_err(|_| "Worker key must contain exactly 32 bytes".to_owned())?
    } else {
        let value = std::str::from_utf8(&material)
            .map_err(|_| "Worker key must be 32 raw bytes or lowercase hex".to_owned())?
            .trim();
        if value.bytes().any(|byte| byte.is_ascii_uppercase()) {
            return Err("Worker key hex must be lowercase".to_owned());
        }
        hex::decode(value)
            .map_err(|_| "Worker key is invalid hex".to_owned())?
            .try_into()
            .map_err(|_| "Worker key must contain exactly 32 bytes".to_owned())?
    };
    Ok(result)
}

fn read_bounded(path: &Path, require_private: bool) -> Result<Vec<u8>, String> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    options.custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW);
    let mut file = options
        .open(path)
        .map_err(|_| format!("{} could not be opened securely", path.display()))?;
    let metadata = file
        .metadata()
        .map_err(|_| format!("{} metadata is unavailable", path.display()))?;
    if !metadata.is_file() || metadata.len() > 1_024 {
        return Err(format!("{} is invalid", path.display()));
    }
    #[cfg(unix)]
    if require_private && metadata.permissions().mode() & 0o077 != 0 {
        return Err(format!(
            "{} must not grant group/world access",
            path.display()
        ));
    }
    let mut value = Vec::new();
    file.read_to_end(&mut value)
        .map_err(|_| format!("{} could not be read", path.display()))?;
    Ok(value)
}

fn create_private_directory(path: &Path) -> Result<(), String> {
    fs::create_dir(path).map_err(|_| {
        format!(
            "Refusing to overwrite or reuse output directory {}",
            path.display()
        )
    })?;
    #[cfg(unix)]
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
        .map_err(|_| "Output directory permissions could not be secured".to_owned())?;
    Ok(())
}

fn write_new(path: &Path, value: &str, mode: u32) -> Result<(), String> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(mode);
    let mut file = options
        .open(path)
        .map_err(|_| format!("Refusing to overwrite {}", path.display()))?;
    file.write_all(value.as_bytes())
        .and_then(|_| file.sync_all())
        .map_err(|_| format!("{} could not be written safely", path.display()))
}
