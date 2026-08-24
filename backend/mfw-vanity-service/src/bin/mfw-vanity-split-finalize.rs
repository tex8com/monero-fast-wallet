use std::{
    collections::HashMap,
    fs::{self, OpenOptions},
    io::Write,
    os::unix::fs::OpenOptionsExt,
    path::Path,
};

use anyhow::{bail, Context, Result};
use curve25519_dalek::{constants::ED25519_BASEPOINT_POINT, scalar::Scalar};
use monero_address::{AddressType, MoneroAddress, Network};
use serde_json::json;
use zeroize::{Zeroize, Zeroizing};

fn main() -> Result<()> {
    let args = std::env::args().collect::<Vec<_>>();
    if args.len() != 6 {
        bail!(
            "usage: {} SECRET_STATE WORKER_RESULT PATTERNS WALLET_PATH IMPORT_JSON",
            args.first()
                .map(String::as_str)
                .unwrap_or("mfw-vanity-split-finalize")
        );
    }

    let state = parse_key_values(Path::new(&args[1]))?;
    if state.get("format").map(String::as_str) != Some("mfw-monero-vanity-split-secret-v1") {
        bail!("unsupported split secret-state format");
    }

    let source_address = required(&state, "source_address")?;
    let mut base_spend_bytes = decode_scalar(required(&state, "base_spend_secret")?)?;
    let mut base_view_bytes = decode_scalar(required(&state, "base_view_secret")?)?;
    let base_spend = canonical_nonzero_scalar(&base_spend_bytes, "base spend key")?;
    let base_view = canonical_nonzero_scalar(&base_view_bytes, "base view key")?;

    let source = MoneroAddress::from_str(Network::Mainnet, source_address)
        .context("invalid source Monero address")?;
    if *source.kind() != AddressType::Legacy {
        bail!("source address is not a mainnet primary address");
    }
    if source.spend() != (base_spend * ED25519_BASEPOINT_POINT)
        || source.view() != (base_view * ED25519_BASEPOINT_POINT)
    {
        bail!("offline base private keys do not match the source address");
    }

    let result_line = fs::read_to_string(&args[2]).context("read worker result")?;
    let fields = result_line.split_whitespace().collect::<Vec<_>>();
    if fields.len() != 3 || fields[0] != "SPLIT" {
        bail!("worker result must be exactly: SPLIT <offset> <address>");
    }
    let mut offset_bytes = decode_scalar(fields[1])?;
    let offset = canonical_nonzero_scalar(&offset_bytes, "worker offset")?;

    let result = MoneroAddress::from_str(Network::Mainnet, fields[2])
        .context("invalid worker result address")?;
    if *result.kind() != AddressType::Legacy || result.view() != source.view() {
        bail!("worker result changed the address type or public view key");
    }
    if source.spend() + offset * ED25519_BASEPOINT_POINT != result.spend() {
        bail!("worker offset does not produce the returned public spend key");
    }

    let final_spend = base_spend + offset;
    if final_spend == Scalar::ZERO {
        bail!("final spend key is zero");
    }
    let locally_derived = MoneroAddress::new(
        Network::Mainnet,
        AddressType::Legacy,
        final_spend * ED25519_BASEPOINT_POINT,
        base_view * ED25519_BASEPOINT_POINT,
    );
    let final_address = locally_derived.to_string();
    if final_address != fields[2] {
        bail!("locally reconstructed split keys do not produce the worker address");
    }

    let patterns = fs::read_to_string(&args[3]).context("read pattern file")?;
    let matched = patterns
        .lines()
        .map(str::trim)
        .filter(|pattern| !pattern.is_empty())
        .find(|pattern| final_address.starts_with(pattern))
        .context("locally derived deterministic address does not match any requested prefix")?;

    let final_spend_hex = Zeroizing::new(hex::encode(final_spend.to_bytes()));
    let final_view_hex = Zeroizing::new(hex::encode(base_view.to_bytes()));
    let import = json!({
        "version": 1,
        "method": "generate_from_keys",
        "params": {
            "filename": args[4],
            "address": final_address,
            "restore_height": 0,
            "password": "",
            "spendkey": final_spend_hex.as_str(),
            "viewkey": final_view_hex.as_str(),
            "autosave_current": true
        }
    });

    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&args[5])
        .context("create one-time wallet import JSON")?;
    serde_json::to_writer(&mut output, &import).context("write one-time wallet import JSON")?;
    output.write_all(b"\n")?;
    output.sync_all()?;

    base_spend_bytes.zeroize();
    base_view_bytes.zeroize();
    offset_bytes.zeroize();
    println!("verified address={final_address} matched_prefix={matched}");
    Ok(())
}

fn parse_key_values(path: &Path) -> Result<HashMap<String, String>> {
    let source = fs::read_to_string(path).with_context(|| format!("read {}", path.display()))?;
    let mut values = HashMap::new();
    for (index, line) in source.lines().enumerate() {
        let (key, value) = line
            .split_once('=')
            .with_context(|| format!("invalid secret-state line {}", index + 1))?;
        if key.is_empty()
            || value.is_empty()
            || values.insert(key.to_owned(), value.to_owned()).is_some()
        {
            bail!(
                "invalid or duplicate secret-state field on line {}",
                index + 1
            );
        }
    }
    Ok(values)
}

fn required<'a>(values: &'a HashMap<String, String>, key: &str) -> Result<&'a str> {
    values
        .get(key)
        .map(String::as_str)
        .with_context(|| format!("missing secret-state field {key}"))
}

fn decode_scalar(value: &str) -> Result<[u8; 32]> {
    if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        bail!("scalar must be exactly 64 hexadecimal characters");
    }
    let mut bytes = [0_u8; 32];
    hex::decode_to_slice(value, &mut bytes).context("decode scalar")?;
    Ok(bytes)
}

fn canonical_nonzero_scalar(bytes: &[u8; 32], label: &str) -> Result<Scalar> {
    let scalar = Option::<Scalar>::from(Scalar::from_canonical_bytes(*bytes))
        .with_context(|| format!("{label} is not canonical"))?;
    if scalar == Scalar::ZERO {
        bail!("{label} is zero");
    }
    Ok(scalar)
}
