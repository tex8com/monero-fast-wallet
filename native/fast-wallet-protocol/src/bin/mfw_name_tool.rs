use std::{
    env,
    error::Error,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};

use mfw_recipient_protocol::{
    extract_mfw_payloads, AddressKind, CanonicalName, NameOperation, NameRecord, NameSigningKey,
    Network as MfwNetwork, PublicAddress,
};
use monero_address::{AddressType as MoneroAddressType, MoneroAddress, Network as MoneroNetwork};

const OWNER_KEY_FILE: &str = "owner-key.bin";
const CLAIM_SALT_FILE: &str = "claim-salt.bin";
const CLAIM_RECORD_FILE: &str = "claim-record.bin";
const COMMIT_EXTRA_FILE: &str = "commit-extra.bin";
const CLAIM_EXTRA_FILE: &str = "claim-extra.bin";
const METADATA_FILE: &str = "metadata.txt";
const MAX_FLOW_FILE_BYTES: u64 = 4_096;

type ToolResult<T> = Result<T, Box<dyn Error>>;

#[derive(Clone, Copy)]
struct Network {
    protocol: MfwNetwork,
    address: MoneroNetwork,
    label: &'static str,
}

impl Network {
    fn parse(value: &str) -> ToolResult<Self> {
        match value {
            "mainnet" => Ok(Self {
                protocol: MfwNetwork::Mainnet,
                address: MoneroNetwork::Mainnet,
                label: "mainnet",
            }),
            "testnet" => Ok(Self {
                protocol: MfwNetwork::Testnet,
                address: MoneroNetwork::Testnet,
                label: "testnet",
            }),
            "stagenet" => Ok(Self {
                protocol: MfwNetwork::Stagenet,
                address: MoneroNetwork::Stagenet,
                label: "stagenet",
            }),
            _ => Err("network must be mainnet, testnet, or stagenet".into()),
        }
    }
}

fn main() {
    if let Err(error) = run() {
        eprintln!("error={error}");
        std::process::exit(1);
    }
}

fn run() -> ToolResult<()> {
    let arguments: Vec<String> = env::args().collect();
    match arguments.get(1).map(String::as_str) {
        Some("create") if arguments.len() == 6 => create_flow(
            Network::parse(&arguments[2])?,
            &arguments[3],
            &arguments[4],
            Path::new(&arguments[5]),
        ),
        Some("renew") if arguments.len() == 4 => {
            renew_flow(Network::parse(&arguments[2])?, Path::new(&arguments[3]))
        }
        Some("inspect") if arguments.len() == 4 => {
            inspect_flow(Network::parse(&arguments[2])?, Path::new(&arguments[3]))
        }
        Some("address-parts") if arguments.len() == 4 => {
            print_address_parts(Network::parse(&arguments[2])?, &arguments[3])
        }
        Some("verify-extra") if arguments.len() == 6 => verify_extra(
            Network::parse(&arguments[2])?,
            Path::new(&arguments[3]),
            &arguments[4],
            &arguments[5],
        ),
        _ => {
            eprintln!(
                "usage:\n  mfw_name_tool create <network> <name> <address> <new-flow-dir>\n  \
                 mfw_name_tool renew <network> <flow-dir>\n  \
                 mfw_name_tool inspect <network> <flow-dir>\n  \
                 mfw_name_tool address-parts <network> <address>\n  \
                 mfw_name_tool verify-extra <network> <flow-dir> \
                 <commit|claim|renew-N> <tx-extra-hex>"
            );
            Err("invalid command line".into())
        }
    }
}

fn create_flow(network: Network, name: &str, address: &str, flow_dir: &Path) -> ToolResult<()> {
    let name = CanonicalName::parse(name)?;
    let public_address = decode_address(network, address)?;
    create_private_dir(flow_dir)?;

    let owner_key = NameSigningKey::generate()?;
    let mut salt = [0_u8; 16];
    getrandom::fill(&mut salt)?;
    let claim = NameRecord::signed_claim(
        network.protocol,
        name.clone(),
        public_address,
        salt,
        &owner_key,
    )?;
    let commit = claim.claim_commitment(network.protocol)?;

    write_new(&flow_dir.join(OWNER_KEY_FILE), &owner_key.export_bytes())?;
    write_new(&flow_dir.join(CLAIM_SALT_FILE), &salt)?;
    write_new(&flow_dir.join(CLAIM_RECORD_FILE), &claim.encode()?)?;
    write_new(
        &flow_dir.join(COMMIT_EXTRA_FILE),
        &commit.to_tx_extra_nonce_field()?,
    )?;
    write_new(
        &flow_dir.join(CLAIM_EXTRA_FILE),
        &claim.to_tx_extra_nonce_field()?,
    )?;
    write_metadata(flow_dir, network, &name, address, &owner_key.public_key())?;

    println!("status=created");
    println!("network={}", network.label);
    println!("name={}", name.display_name());
    println!("owner_public_key={}", hex::encode(owner_key.public_key()));
    println!(
        "commit_extra_bytes={}",
        commit.to_tx_extra_nonce_field()?.len()
    );
    println!("claim_record_bytes={}", claim.encode()?.len());
    println!(
        "claim_extra_bytes={}",
        claim.to_tx_extra_nonce_field()?.len()
    );
    println!("secret_material_logged=false");
    Ok(())
}

fn renew_flow(network: Network, flow_dir: &Path) -> ToolResult<()> {
    ensure_private_dir(flow_dir)?;
    let owner_key = NameSigningKey::from_bytes(read_array(&flow_dir.join(OWNER_KEY_FILE))?);
    let (predecessor, next_sequence) = latest_record(network.protocol, flow_dir)?;
    predecessor.verify_with_signer(network.protocol, owner_key.public_key())?;
    let renewal = NameRecord::signed_transition(
        network.protocol,
        NameOperation::Renew,
        next_sequence,
        predecessor.name.clone(),
        predecessor.owner_public_key,
        predecessor.address,
        &predecessor,
        &owner_key,
    )?;
    renewal.verify_transition(network.protocol, &predecessor)?;

    let record_path = renewal_record_path(flow_dir, next_sequence);
    let extra_path = renewal_extra_path(flow_dir, next_sequence);
    write_new(&record_path, &renewal.encode()?)?;
    write_new(&extra_path, &renewal.to_tx_extra_nonce_field()?)?;

    println!("status=renewal-created");
    println!("network={}", network.label);
    println!("name={}", renewal.name.display_name());
    println!("sequence={next_sequence}");
    println!("renew_record_bytes={}", renewal.encode()?.len());
    println!(
        "renew_extra_bytes={}",
        renewal.to_tx_extra_nonce_field()?.len()
    );
    println!("secret_material_logged=false");
    Ok(())
}

fn inspect_flow(network: Network, flow_dir: &Path) -> ToolResult<()> {
    ensure_private_dir(flow_dir)?;
    let owner_key = NameSigningKey::from_bytes(read_array(&flow_dir.join(OWNER_KEY_FILE))?);
    let claim = NameRecord::decode(&read_bounded(&flow_dir.join(CLAIM_RECORD_FILE))?)?;
    claim.verify_claim(network.protocol)?;
    if claim.owner_public_key != owner_key.public_key() {
        return Err("owner key does not match claim record".into());
    }
    let commit_extra = read_bounded(&flow_dir.join(COMMIT_EXTRA_FILE))?;
    let claim_extra = read_bounded(&flow_dir.join(CLAIM_EXTRA_FILE))?;
    let expected_commit = claim
        .claim_commitment(network.protocol)?
        .to_tx_extra_nonce_field()?;
    if commit_extra != expected_commit || claim_extra != claim.to_tx_extra_nonce_field()? {
        return Err("stored tx_extra does not match the signed claim".into());
    }
    let (latest, next_sequence) = latest_record(network.protocol, flow_dir)?;
    latest.verify_with_signer(network.protocol, owner_key.public_key())?;

    println!("status=valid");
    println!("network={}", network.label);
    println!("name={}", claim.name.display_name());
    println!("owner_public_key={}", hex::encode(owner_key.public_key()));
    println!("latest_sequence={}", next_sequence.saturating_sub(1));
    println!("secret_material_logged=false");
    Ok(())
}

fn print_address_parts(network: Network, value: &str) -> ToolResult<()> {
    let address = MoneroAddress::from_str(network.address, value)?;
    match address.kind() {
        MoneroAddressType::Legacy | MoneroAddressType::Subaddress => {}
        _ => return Err("integrated and featured addresses are not supported".into()),
    }
    println!("status=valid");
    println!("network={}", network.label);
    println!(
        "spend_public_key={}",
        hex::encode(address.spend().compress().to_bytes())
    );
    println!(
        "view_public_key={}",
        hex::encode(address.view().compress().to_bytes())
    );
    Ok(())
}

fn verify_extra(
    network: Network,
    flow_dir: &Path,
    record_kind: &str,
    extra_hex: &str,
) -> ToolResult<()> {
    ensure_private_dir(flow_dir)?;
    let expected = if record_kind == "commit" {
        let claim = NameRecord::decode(&read_bounded(&flow_dir.join(CLAIM_RECORD_FILE))?)?;
        claim.verify_claim(network.protocol)?;
        claim.claim_commitment(network.protocol)?.encode()
    } else if record_kind == "claim" {
        let claim = NameRecord::decode(&read_bounded(&flow_dir.join(CLAIM_RECORD_FILE))?)?;
        claim.verify_claim(network.protocol)?;
        claim.encode()?
    } else if let Some(sequence) = record_kind.strip_prefix("renew-") {
        let sequence: u32 = sequence.parse()?;
        if sequence == 0 {
            return Err("renewal sequence must be positive".into());
        }
        let record = NameRecord::decode(&read_bounded(&renewal_record_path(flow_dir, sequence))?)?;
        if record.operation != NameOperation::Renew || record.sequence != sequence {
            return Err("stored renewal record has the wrong operation or sequence".into());
        }
        record.encode()?
    } else {
        return Err("record kind must be commit, claim, or renew-N".into());
    };

    let extra = hex::decode(extra_hex)?;
    let payloads = extract_mfw_payloads(&extra)?;
    if payloads.len() != 1 || payloads[0] != expected {
        return Err("on-chain tx_extra does not contain exactly the expected record".into());
    }
    println!("status=verified");
    println!("network={}", network.label);
    println!("record_kind={record_kind}");
    println!("tx_extra_bytes={}", extra.len());
    println!("payload_bytes={}", expected.len());
    Ok(())
}

fn decode_address(network: Network, value: &str) -> ToolResult<PublicAddress> {
    let address = MoneroAddress::from_str(network.address, value)?;
    let kind = match address.kind() {
        MoneroAddressType::Legacy => AddressKind::Standard,
        MoneroAddressType::Subaddress => AddressKind::Subaddress,
        _ => return Err("integrated and featured addresses are not supported".into()),
    };
    Ok(PublicAddress::new(
        kind,
        address.spend().compress().to_bytes(),
        address.view().compress().to_bytes(),
    )?)
}

fn latest_record(network: MfwNetwork, flow_dir: &Path) -> ToolResult<(NameRecord, u32)> {
    let mut record = NameRecord::decode(&read_bounded(&flow_dir.join(CLAIM_RECORD_FILE))?)?;
    let mut next_sequence = 1_u32;
    loop {
        let path = renewal_record_path(flow_dir, next_sequence);
        if !path.exists() {
            return Ok((record, next_sequence));
        }
        let candidate = NameRecord::decode(&read_bounded(&path)?)?;
        candidate.verify_transition(network, &record)?;
        record = candidate;
        next_sequence = next_sequence
            .checked_add(1)
            .ok_or("renewal sequence overflow")?;
    }
}

fn renewal_record_path(flow_dir: &Path, sequence: u32) -> PathBuf {
    flow_dir.join(format!("renew-record-{sequence}.bin"))
}

fn renewal_extra_path(flow_dir: &Path, sequence: u32) -> PathBuf {
    flow_dir.join(format!("renew-extra-{sequence}.bin"))
}

fn write_metadata(
    flow_dir: &Path,
    network: Network,
    name: &CanonicalName,
    address: &str,
    owner_public_key: &[u8; 32],
) -> ToolResult<()> {
    let mut metadata = Vec::new();
    writeln!(&mut metadata, "version=1")?;
    writeln!(&mut metadata, "network={}", network.label)?;
    writeln!(&mut metadata, "name={}", name.display_name())?;
    writeln!(&mut metadata, "address={address}")?;
    writeln!(
        &mut metadata,
        "owner_public_key={}",
        hex::encode(owner_public_key)
    )?;
    writeln!(&mut metadata, "contains_secret=false")?;
    write_new(&flow_dir.join(METADATA_FILE), &metadata)
}

fn create_private_dir(path: &Path) -> ToolResult<()> {
    if path.exists() {
        return Err(format!("flow directory already exists: {}", path.display()).into());
    }
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(path)?;
    ensure_private_dir(path)
}

fn ensure_private_dir(path: &Path) -> ToolResult<()> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err("flow path must be a real directory".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err("flow directory permissions must be 0700 or stricter".into());
        }
    }
    Ok(())
}

fn write_new(path: &Path, bytes: &[u8]) -> ToolResult<()> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    Ok(())
}

fn read_bounded(path: &Path) -> ToolResult<Vec<u8>> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.len() > MAX_FLOW_FILE_BYTES
    {
        return Err(format!("invalid flow file: {}", path.display()).into());
    }
    let mut bytes = Vec::with_capacity(usize::try_from(metadata.len())?);
    File::open(path)?
        .take(MAX_FLOW_FILE_BYTES + 1)
        .read_to_end(&mut bytes)?;
    if u64::try_from(bytes.len())? > MAX_FLOW_FILE_BYTES {
        return Err(format!("oversized flow file: {}", path.display()).into());
    }
    Ok(bytes)
}

fn read_array<const N: usize>(path: &Path) -> ToolResult<[u8; N]> {
    read_bounded(path)?
        .try_into()
        .map_err(|_| format!("{} must contain exactly {N} bytes", path.display()).into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use curve25519_dalek::{constants::ED25519_BASEPOINT_POINT, scalar::Scalar};

    #[test]
    fn generated_flow_round_trips_without_logging_secrets() {
        let root = tempfile::tempdir().unwrap();
        let flow = root.path().join("flow");
        let address = MoneroAddress::new(
            MoneroNetwork::Mainnet,
            MoneroAddressType::Subaddress,
            Scalar::from(11_u64) * ED25519_BASEPOINT_POINT,
            Scalar::from(12_u64) * ED25519_BASEPOINT_POINT,
        )
        .to_string();
        let network = Network::parse("mainnet").unwrap();
        create_flow(network, "e2e-test", &address, &flow).unwrap();
        inspect_flow(network, &flow).unwrap();
        renew_flow(network, &flow).unwrap();
        inspect_flow(network, &flow).unwrap();

        let mut commit_extra = vec![1];
        commit_extra.extend_from_slice(
            &(Scalar::from(13_u64) * ED25519_BASEPOINT_POINT)
                .compress()
                .to_bytes(),
        );
        commit_extra.extend_from_slice(&read_bounded(&flow.join(COMMIT_EXTRA_FILE)).unwrap());
        verify_extra(network, &flow, "commit", &hex::encode(&commit_extra)).unwrap();
        verify_extra(
            network,
            &flow,
            "claim",
            &hex::encode(read_bounded(&flow.join(CLAIM_EXTRA_FILE)).unwrap()),
        )
        .unwrap();
        verify_extra(
            network,
            &flow,
            "renew-1",
            &hex::encode(read_bounded(&renewal_extra_path(&flow, 1)).unwrap()),
        )
        .unwrap();
        let mut tampered = commit_extra;
        *tampered.last_mut().unwrap() ^= 1;
        assert!(verify_extra(network, &flow, "commit", &hex::encode(tampered)).is_err());

        assert_eq!(read_bounded(&flow.join(OWNER_KEY_FILE)).unwrap().len(), 32);
        assert_eq!(read_bounded(&flow.join(CLAIM_SALT_FILE)).unwrap().len(), 16);
        assert!(
            !String::from_utf8(read_bounded(&flow.join(METADATA_FILE)).unwrap())
                .unwrap()
                .contains(&hex::encode(
                    read_bounded(&flow.join(OWNER_KEY_FILE)).unwrap()
                ))
        );
    }
}
