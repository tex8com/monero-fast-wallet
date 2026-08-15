use anyhow::{Context, Result};
use fast_wallet_worker::{load_worker_descriptor_file, private_worker_pairing_code};
use std::{env, path::PathBuf, time::SystemTime};

fn main() -> Result<()> {
    let descriptor_path = env::var("FAST_WALLET_WORKER_DESCRIPTOR_FILE")
        .map(PathBuf::from)
        .context("FAST_WALLET_WORKER_DESCRIPTOR_FILE is required")?;
    let descriptor = load_worker_descriptor_file(&descriptor_path)?;
    let now = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    descriptor
        .verify(descriptor.network, now)
        .map_err(|error| anyhow::anyhow!("Worker descriptor is invalid: {error}"))?;
    println!("{}", private_worker_pairing_code(&descriptor)?);
    Ok(())
}
