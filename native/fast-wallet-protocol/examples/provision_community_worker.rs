use fast_wallet_protocol::{
    HpkePrivateKey, Network, SigningKeyMaterial, WorkerDescriptor, WorkerDescriptorInput,
};
use std::{
    env,
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use zeroize::Zeroize;

#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

const DESCRIPTOR_LIFETIME_SECONDS: u64 = 30 * 24 * 60 * 60;

fn main() -> Result<(), String> {
    let mut arguments = env::args().skip(1);
    let output = arguments.next().map(PathBuf::from).ok_or_else(usage)?;
    let relay_origin = arguments.next().ok_or_else(usage)?;
    let network_name = arguments.next().ok_or_else(usage)?;
    let network = parse_network(&network_name)?;
    if arguments.next().is_some() {
        return Err(usage());
    }

    create_private_directory(&output)?;
    if fs::read_dir(&output)
        .map_err(|_| "Provisioning directory could not be inspected".to_owned())?
        .next()
        .is_some()
    {
        return Err("Refusing to overwrite an existing Worker provisioning directory".to_owned());
    }

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "System clock is invalid".to_owned())?
        .as_secs();

    let mut root_secret = random_secret()?;
    let root = SigningKeyMaterial::from_bytes(root_secret);
    write_secret(&output.join("worker-root-signing.key"), &root_secret)?;
    root_secret.zeroize();

    let mut online_secret = random_secret()?;
    let online = SigningKeyMaterial::from_bytes(online_secret);
    write_secret(&output.join("worker-online-signing.key"), &online_secret)?;
    online_secret.zeroize();

    let mut hpke_secret = random_secret()?;
    let hpke = HpkePrivateKey::from_bytes(hpke_secret);
    let hpke_public = hpke
        .public_key()
        .map_err(|_| "Worker HPKE public key could not be derived".to_owned())?;
    write_secret(&output.join("worker-hpke.key"), &hpke_secret)?;
    hpke_secret.zeroize();

    let mut storage_secret = random_secret()?;
    write_secret(&output.join("worker-storage.key"), &storage_secret)?;
    storage_secret.zeroize();

    let descriptor = WorkerDescriptor::sign(
        WorkerDescriptorInput {
            network,
            issued_at: now,
            expires_at: now + DESCRIPTOR_LIFETIME_SECONDS,
            worker_online_public_key: online.public_key(),
            hpke_public_key: hpke_public,
            relay_origin: relay_origin.clone(),
        },
        &root,
    )
    .map_err(|_| "Community Worker descriptor could not be signed".to_owned())?;
    let descriptor_hex = hex::encode(
        descriptor
            .encode()
            .map_err(|_| "Community Worker descriptor could not be encoded".to_owned())?,
    );
    write_public(
        &output.join("worker-descriptor.hex"),
        &format!("{descriptor_hex}\n"),
    )?;
    write_public(
        &output.join("fast-wallet-worker.env.example"),
        &format!(
            "FAST_WALLET_WORKER_MODE=public\nFAST_WALLET_WORKER_DIRECTORY_ORIGIN={relay_origin}\nFAST_WALLET_WORKER_OPERATOR_LABEL=change-me\nFAST_WALLET_WORKER_REGION=\nFAST_WALLET_WORKER_POLICY_URL=\nFAST_WALLET_WORKER_MAXIMUM_ASSIGNMENTS=100\nFAST_WALLET_WORKER_DESCRIPTOR_FILE=/etc/monero-fast-wallet/worker-descriptor.hex\nFAST_WALLET_WORKER_HPKE_KEY_FILE=/etc/monero-fast-wallet/worker-hpke.key\nFAST_WALLET_WORKER_ONLINE_SIGNING_KEY_FILE=/etc/monero-fast-wallet/worker-online-signing.key\nFAST_WALLET_WORKER_STORAGE_KEY_FILE=/etc/monero-fast-wallet/worker-storage.key\n"
        ),
    )?;

    println!("Community Worker material created without overwriting existing files.");
    println!("Worker id: {}", hex::encode(descriptor.worker_root_id()));
    println!("Descriptor expires at Unix time {}.", descriptor.expires_at);
    println!("Keep worker-root-signing.key offline; do not copy it to the Worker server.");
    Ok(())
}

fn parse_network(value: &str) -> Result<Network, String> {
    match value {
        "mainnet" => Ok(Network::Mainnet),
        "testnet" => Ok(Network::Testnet),
        "stagenet" => Ok(Network::Stagenet),
        _ => Err(usage()),
    }
}

fn usage() -> String {
    "Usage: provision_community_worker <new-private-directory> <https-relay-origin> <mainnet|testnet|stagenet>".to_owned()
}

fn random_secret() -> Result<[u8; 32], String> {
    let mut value = [0_u8; 32];
    getrandom::fill(&mut value).map_err(|_| "Secure randomness is unavailable".to_owned())?;
    Ok(value)
}

fn create_private_directory(path: &Path) -> Result<(), String> {
    fs::create_dir(path).map_err(|_| "Provisioning directory could not be created".to_owned())?;
    #[cfg(unix)]
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
        .map_err(|_| "Provisioning directory permissions could not be secured".to_owned())?;
    Ok(())
}

fn write_secret(path: &Path, value: &[u8; 32]) -> Result<(), String> {
    write_new(path, &format!("{}\n", hex::encode(value)), 0o600)
}

fn write_public(path: &Path, value: &str) -> Result<(), String> {
    write_new(path, value, 0o644)
}

fn write_new(path: &Path, value: &str, mode: u32) -> Result<(), String> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(mode);
    let mut file = options
        .open(path)
        .map_err(|_| format!("Could not create {}", path.display()))?;
    file.write_all(value.as_bytes())
        .and_then(|_| file.sync_all())
        .map_err(|_| format!("Could not write {}", path.display()))
}
