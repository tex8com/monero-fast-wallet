use std::{
    collections::{BTreeMap, HashMap},
    env,
    fs::{self, OpenOptions},
    io::Write,
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Instant,
};

use anyhow::{bail, Context, Result};
use curve25519_dalek::{
    constants::{ED25519_BASEPOINT_POINT, ED25519_BASEPOINT_TABLE},
    edwards::EdwardsPoint,
    Scalar,
};
use monero_address::{AddressType, MoneroAddress, Network};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use sha3::{Digest, Keccak256};
use zeroize::{Zeroize, Zeroizing};

const BASE58: &[u8; 58] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const SUBADDRESS_NETWORK_TAG: u8 = 42;
const CHUNK_SIZE: u64 = 1 << 22;

struct MasterKeys {
    source_address: String,
    spend_public: EdwardsPoint,
    view_secret: Zeroizing<Scalar>,
}

#[derive(Clone, Deserialize, Serialize)]
struct ManifestEntry {
    account_index: u32,
    subaddress_index: u32,
    address: String,
}

#[derive(Deserialize, Serialize)]
struct Manifest {
    entries: Vec<ManifestEntry>,
}

#[derive(Clone, Deserialize, Serialize)]
struct SearchEntry {
    target: String,
    account_index: u32,
    subaddress_index: u32,
    address: String,
}

#[derive(Deserialize, Serialize)]
struct SearchCheckpoint {
    version: u32,
    source_address: String,
    next_account_index: u64,
    next_subaddress_index: u64,
    entries: Vec<SearchEntry>,
}

#[derive(Serialize)]
struct SearchManifest {
    version: u32,
    kind: &'static str,
    source_address: String,
    entries: Vec<SearchEntry>,
}

fn usage(program: &str) {
    eprintln!(
        "Usage:\n  {program} verify SECRET_STATE MANIFEST\n  \
         {program} benchmark SECRET_STATE TARGETS CANDIDATES [ACCOUNT] [START_INDEX]\n  \
         {program} search SECRET_STATE TARGETS OUTPUT_MANIFEST [START_ACCOUNT] [START_INDEX] [END_ACCOUNT_EXCLUSIVE]"
    );
}

fn parse_key_values(path: &Path) -> Result<HashMap<String, String>> {
    let metadata = fs::metadata(path).context("read secret-state metadata")?;
    if metadata.permissions().mode() & 0o077 != 0 {
        bail!("secret-state file must not be accessible by group or others");
    }
    let mut result = HashMap::new();
    for (number, raw) in fs::read_to_string(path)
        .context("read secret-state file")?
        .lines()
        .enumerate()
    {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let (key, value) = line
            .split_once('=')
            .with_context(|| format!("invalid secret-state line {}", number + 1))?;
        if result.insert(key.to_owned(), value.to_owned()).is_some() {
            bail!("duplicate secret-state key: {key}");
        }
    }
    Ok(result)
}

fn required<'a>(values: &'a HashMap<String, String>, key: &str) -> Result<&'a str> {
    values
        .get(key)
        .map(String::as_str)
        .with_context(|| format!("missing secret-state key: {key}"))
}

fn decode_scalar(value: &str, label: &str) -> Result<Scalar> {
    let bytes = hex::decode(value).with_context(|| format!("decode {label}"))?;
    let bytes: [u8; 32] = bytes
        .try_into()
        .map_err(|_| anyhow::anyhow!("{label} must contain exactly 32 bytes"))?;
    Option::<Scalar>::from(Scalar::from_canonical_bytes(bytes))
        .filter(|scalar| *scalar != Scalar::ZERO)
        .with_context(|| format!("{label} is not a canonical non-zero scalar"))
}

fn load_master(path: &Path) -> Result<MasterKeys> {
    let values = parse_key_values(path)?;
    if required(&values, "format")? != "mfw-monero-subaddress-vanity-secret-v1" {
        bail!("unsupported subaddress secret-state format");
    }
    let source_address = required(&values, "source_address")?.to_owned();
    let mut spend_secret = decode_scalar(required(&values, "spend_secret")?, "spend secret")?;
    let view_secret = Zeroizing::new(decode_scalar(
        required(&values, "view_secret")?,
        "view secret",
    )?);
    let source = MoneroAddress::from_str(Network::Mainnet, &source_address)
        .context("invalid source address")?;
    if *source.kind() != AddressType::Legacy
        || source.spend() != spend_secret * ED25519_BASEPOINT_POINT
        || source.view() != *view_secret * ED25519_BASEPOINT_POINT
    {
        bail!("secret-state keys do not match the source primary address");
    }
    spend_secret.zeroize();
    Ok(MasterKeys {
        source_address,
        spend_public: source.spend(),
        view_secret,
    })
}

fn subaddress_spend(master: &MasterKeys, account: u32, index: u32) -> EdwardsPoint {
    let mut input = [0_u8; 48];
    input[..8].copy_from_slice(b"SubAddr\0");
    input[8..40].copy_from_slice(&master.view_secret.to_bytes());
    input[40..44].copy_from_slice(&account.to_le_bytes());
    input[44..48].copy_from_slice(&index.to_le_bytes());
    let digest: [u8; 32] = Keccak256::digest(input).into();
    let scalar = Scalar::from_bytes_mod_order(digest);
    master.spend_public + &scalar * ED25519_BASEPOINT_TABLE
}

fn subaddress_string(master: &MasterKeys, spend: EdwardsPoint) -> String {
    let view = *master.view_secret * spend;
    MoneroAddress::new(Network::Mainnet, AddressType::Subaddress, spend, view).to_string()
}

fn first_block(spend: &EdwardsPoint) -> [u8; 11] {
    let compressed = spend.compress().to_bytes();
    let mut value = u64::from(SUBADDRESS_NETWORK_TAG);
    for byte in &compressed[..7] {
        value = (value << 8) | u64::from(*byte);
    }
    let mut encoded = [0_u8; 11];
    for index in (0..11).rev() {
        encoded[index] = BASE58[(value % 58) as usize];
        value /= 58;
    }
    encoded
}

fn matches_target(spend: &EdwardsPoint, target: &[u8]) -> bool {
    let encoded = first_block(spend);
    encoded[0] == b'8' && encoded[2..2 + target.len()] == *target
}

fn validate_first_block(master: &MasterKeys) -> Result<()> {
    let spend = subaddress_spend(master, 0, 1);
    let address = subaddress_string(master, spend);
    if address.as_bytes().get(..11) != Some(first_block(&spend).as_slice()) {
        bail!("optimized first-block encoder disagrees with Monero address encoding");
    }
    Ok(())
}

fn load_targets(path: &Path) -> Result<Vec<String>> {
    let mut targets = Vec::new();
    for (number, raw) in fs::read_to_string(path)
        .context("read target file")?
        .lines()
        .enumerate()
    {
        let target = raw.trim();
        if target.is_empty() || target.starts_with('#') {
            continue;
        }
        if target.len() > 9
            || target.is_empty()
            || !target.bytes().all(|character| BASE58.contains(&character))
        {
            bail!("invalid target on line {}", number + 1);
        }
        if !targets.iter().any(|existing| existing == target) {
            targets.push(target.to_owned());
        }
    }
    if targets.is_empty() {
        bail!("target file is empty");
    }
    Ok(targets)
}

fn verify(master: &MasterKeys, path: &Path) -> Result<()> {
    let manifest: Manifest =
        serde_json::from_str(&fs::read_to_string(path).context("read manifest")?)
            .context("parse manifest")?;
    for entry in &manifest.entries {
        let spend = subaddress_spend(master, entry.account_index, entry.subaddress_index);
        let actual = subaddress_string(master, spend);
        if actual != entry.address {
            bail!(
                "manifest address mismatch at {}:{}",
                entry.account_index,
                entry.subaddress_index
            );
        }
    }
    println!("VERIFY_OK addresses={}", manifest.entries.len());
    Ok(())
}

fn benchmark(
    master: &MasterKeys,
    targets: &[String],
    candidates: u64,
    account: u32,
    start: u32,
) -> Result<()> {
    if candidates == 0 || u64::from(start) + candidates > u64::from(u32::MAX) + 1 {
        bail!("invalid benchmark candidate range");
    }
    let targets = targets
        .iter()
        .map(|target| target.as_bytes())
        .collect::<Vec<_>>();
    let started = Instant::now();
    let matches = (u64::from(start)..u64::from(start) + candidates)
        .into_par_iter()
        .map(|index| {
            let spend = subaddress_spend(master, account, index as u32);
            usize::from(targets.iter().any(|target| matches_target(&spend, target)))
        })
        .sum::<usize>();
    let elapsed = started.elapsed().as_secs_f64();
    println!(
        "BENCHMARK_OK candidates={} elapsed_seconds={:.6} candidates_per_second={:.3} matches={}",
        candidates,
        elapsed,
        candidates as f64 / elapsed,
        matches
    );
    Ok(())
}

fn search(
    master: &MasterKeys,
    targets: &[String],
    output: &Path,
    start_account: u32,
    start_index: u32,
    end_account: u64,
) -> Result<()> {
    if output.exists() {
        bail!("output manifest already exists");
    }
    if u64::from(start_account) >= end_account || end_account > u64::from(u32::MAX) + 1 {
        bail!("invalid account search range");
    }

    let targets = Arc::new(targets.to_vec());
    let checkpoint_path = PathBuf::from(format!("{}.partial", output.display()));
    let (initial_found, mut account, mut index) = if checkpoint_path.exists() {
        let checkpoint: SearchCheckpoint = serde_json::from_str(
            &fs::read_to_string(&checkpoint_path).context("read search checkpoint")?,
        )
        .context("parse search checkpoint")?;
        if checkpoint.version != 1 || checkpoint.source_address != master.source_address {
            bail!("search checkpoint does not match this master wallet");
        }
        let mut restored = BTreeMap::new();
        for entry in checkpoint.entries {
            if !targets.iter().any(|target| target == &entry.target) {
                bail!("search checkpoint contains an unknown target");
            }
            restored.insert(entry.target.clone(), entry);
        }
        (
            restored,
            checkpoint.next_account_index,
            checkpoint.next_subaddress_index,
        )
    } else {
        (
            BTreeMap::new(),
            u64::from(start_account),
            u64::from(start_index),
        )
    };
    if account < u64::from(start_account) || account >= end_account || index > u64::from(u32::MAX) {
        bail!("search checkpoint cursor is outside the requested range");
    }
    let found = Arc::new(Mutex::new(initial_found));
    let overall_started = Instant::now();
    let mut checked = 0_u64;
    while account < end_account {
        let remaining = {
            let found = found.lock().expect("found mutex");
            targets
                .iter()
                .filter(|target| !found.contains_key(*target))
                .cloned()
                .collect::<Vec<_>>()
        };
        if remaining.is_empty() {
            break;
        }
        let chunk_end = (index + CHUNK_SIZE).min(u64::from(u32::MAX) + 1);
        let current_account = account as u32;
        let found_ref = Arc::clone(&found);
        (index..chunk_end).into_par_iter().for_each(|candidate| {
            let spend = subaddress_spend(master, current_account, candidate as u32);
            for target in &remaining {
                if matches_target(&spend, target.as_bytes()) {
                    let entry = SearchEntry {
                        target: target.clone(),
                        account_index: current_account,
                        subaddress_index: candidate as u32,
                        address: subaddress_string(master, spend),
                    };
                    found_ref
                        .lock()
                        .expect("found mutex")
                        .entry(target.clone())
                        .or_insert(entry);
                }
            }
        });
        checked += chunk_end - index;
        index = chunk_end;
        if index == u64::from(u32::MAX) + 1 {
            account += 1;
            index = 0;
        }
        let found_count = found.lock().expect("found mutex").len();
        let elapsed = overall_started.elapsed().as_secs_f64();
        let checkpoint = SearchCheckpoint {
            version: 1,
            source_address: master.source_address.clone(),
            next_account_index: account,
            next_subaddress_index: index,
            entries: found
                .lock()
                .expect("found mutex")
                .values()
                .cloned()
                .collect(),
        };
        write_json_atomic(&checkpoint_path, &checkpoint).context("write search checkpoint")?;
        eprintln!(
            "progress checked={} rate={:.3}/s account={} index={} found={}/{}",
            checked,
            checked as f64 / elapsed,
            account,
            index,
            found_count,
            targets.len()
        );
        if found_count == targets.len() {
            break;
        }
    }

    let found = found.lock().expect("found mutex");
    if found.len() != targets.len() {
        bail!(
            "search range exhausted with {}/{} targets found",
            found.len(),
            targets.len()
        );
    }
    let manifest = SearchManifest {
        version: 1,
        kind: "mfw-monero-subaddress-vanity-index-v1",
        source_address: master.source_address.clone(),
        entries: targets
            .iter()
            .map(|target| found.get(target).expect("target result").clone())
            .collect(),
    };
    write_json_new(output, &manifest)?;
    println!(
        "SEARCH_OK targets={} manifest={}",
        targets.len(),
        output.display()
    );
    Ok(())
}

fn write_json_new(path: &Path, value: &impl Serialize) -> Result<()> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
        .context("create JSON file")?;
    serde_json::to_writer_pretty(&mut file, value).context("write JSON file")?;
    file.write_all(b"\n")?;
    file.sync_all()?;
    Ok(())
}

fn write_json_atomic(path: &Path, value: &impl Serialize) -> Result<()> {
    let temporary = PathBuf::from(format!("{}.tmp.{}", path.display(), std::process::id()));
    if temporary.exists() {
        fs::remove_file(&temporary).context("remove stale checkpoint temporary file")?;
    }
    write_json_new(&temporary, value)?;
    fs::rename(&temporary, path).context("publish search checkpoint")?;
    Ok(())
}

fn parse_u32(value: Option<&String>, default: u32, label: &str) -> Result<u32> {
    value
        .map(|value| value.parse().with_context(|| format!("parse {label}")))
        .unwrap_or(Ok(default))
}

fn main() -> Result<()> {
    let args = env::args().collect::<Vec<_>>();
    let program = args
        .first()
        .map(String::as_str)
        .unwrap_or("mfw-subaddress-vanity-local");
    if args.len() < 4 {
        usage(program);
        bail!("missing arguments");
    }
    let master = load_master(Path::new(&args[2]))?;
    validate_first_block(&master)?;
    match args[1].as_str() {
        "verify" if args.len() == 4 => verify(&master, Path::new(&args[3])),
        "benchmark" if (5..=7).contains(&args.len()) => {
            let targets = load_targets(Path::new(&args[3]))?;
            let candidates = args[4].parse().context("parse candidate count")?;
            let account = parse_u32(args.get(5), 0, "account")?;
            let start = parse_u32(args.get(6), 4, "start index")?;
            benchmark(&master, &targets, candidates, account, start)
        }
        "search" if (5..=8).contains(&args.len()) => {
            let targets = load_targets(Path::new(&args[3]))?;
            let start_account = parse_u32(args.get(5), 0, "start account")?;
            let start_index = parse_u32(args.get(6), 4, "start index")?;
            let end_account = args
                .get(7)
                .map(|value| value.parse().context("parse end account"))
                .unwrap_or(Ok(u64::from(u32::MAX) + 1))?;
            search(
                &master,
                &targets,
                Path::new(&args[4]),
                start_account,
                start_index,
                end_account,
            )
        }
        _ => {
            usage(program);
            bail!("invalid command or argument count")
        }
    }
}
