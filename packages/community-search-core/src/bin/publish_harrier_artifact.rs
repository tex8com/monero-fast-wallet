use community_search_core::{HarrierArtifactTarget, SignedHarrierArtifactPackage};
use ed25519_dalek::SigningKey;
use std::{
    collections::HashMap,
    env, fs,
    path::{Path, PathBuf},
    process::ExitCode,
};
use zeroize::Zeroizing;

const ALLOWED_ARGUMENTS: &[&str] = &[
    "artifact-id",
    "sequence",
    "minimum-platform-version",
    "pte",
    "tokenizer",
    "conformance",
    "reference-cases",
    "minimum-reference-cosine-ppm",
    "created-at-ms",
    "signing-key-file",
    "output",
];

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("Harrier artifact publication failed: {error}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<(), String> {
    let arguments = parse_arguments()?;
    let artifact_id = required(&arguments, "artifact-id")?;
    let sequence = required_u64(&arguments, "sequence")?;
    let minimum_platform_version = required(&arguments, "minimum-platform-version")?;
    let pte_path = required_path(&arguments, "pte")?;
    let tokenizer_path = required_path(&arguments, "tokenizer")?;
    let conformance_path = required_path(&arguments, "conformance")?;
    let reference_cases = required_u32(&arguments, "reference-cases")?;
    let minimum_reference_cosine_ppm = required_u32(&arguments, "minimum-reference-cosine-ppm")?;
    let created_at_ms = required_u64(&arguments, "created-at-ms")?;
    let signing_key_file = required_path(&arguments, "signing-key-file")?;
    let output = required_path(&arguments, "output")?;

    require_new_output(&output)?;
    let pte = read_regular_file(&pte_path, "Harrier PTE")?;
    let tokenizer = read_regular_file(&tokenizer_path, "Harrier tokenizer")?;
    let conformance = read_regular_file(&conformance_path, "Harrier conformance report")?;
    let signing_seed = read_secret_key(&signing_key_file)?;
    let signing_key = SigningKey::from_bytes(&signing_seed);
    let package = SignedHarrierArtifactPackage::create(
        artifact_id,
        sequence,
        HarrierArtifactTarget::XnnpackA8w8,
        minimum_platform_version,
        &pte,
        &tokenizer,
        &conformance,
        reference_cases,
        minimum_reference_cosine_ppm,
        created_at_ms,
        &signing_key,
    )
    .map_err(|error| error.to_string())?;

    if let Some(parent) = output.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("could not create output directory: {error}"))?;
    }
    fs::write(&output, package.manifest_json)
        .map_err(|error| format!("could not write signed artifact manifest: {error}"))?;
    println!(
        "published signed Harrier artifact manifest sequence {sequence} to {}",
        output.display()
    );
    Ok(())
}

fn parse_arguments() -> Result<HashMap<String, String>, String> {
    let mut result = HashMap::new();
    let mut arguments = env::args().skip(1);
    while let Some(flag) = arguments.next() {
        let Some(name) = flag.strip_prefix("--") else {
            return Err(format!("unexpected argument: {flag}"));
        };
        if !ALLOWED_ARGUMENTS.contains(&name) {
            return Err(format!("unknown argument: --{name}"));
        }
        let value = arguments
            .next()
            .ok_or_else(|| format!("missing value for --{name}"))?;
        if value.starts_with("--") || result.insert(name.to_owned(), value).is_some() {
            return Err(format!("invalid or duplicate --{name}"));
        }
    }
    Ok(result)
}

fn required(arguments: &HashMap<String, String>, name: &str) -> Result<String, String> {
    arguments
        .get(name)
        .filter(|value| !value.is_empty())
        .cloned()
        .ok_or_else(|| format!("missing --{name}"))
}

fn required_path(arguments: &HashMap<String, String>, name: &str) -> Result<PathBuf, String> {
    required(arguments, name).map(PathBuf::from)
}

fn required_u64(arguments: &HashMap<String, String>, name: &str) -> Result<u64, String> {
    required(arguments, name)?
        .parse()
        .map_err(|_| format!("--{name} must be an unsigned integer"))
}

fn required_u32(arguments: &HashMap<String, String>, name: &str) -> Result<u32, String> {
    required(arguments, name)?
        .parse()
        .map_err(|_| format!("--{name} must be a 32-bit unsigned integer"))
}

fn require_new_output(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(_) => Err("output already exists; signed artifacts are immutable".to_owned()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("could not inspect output: {error}")),
    }
}

fn read_regular_file(path: &Path, label: &str) -> Result<Vec<u8>, String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("could not inspect {label}: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(format!("{label} must be a regular non-symlink file"));
    }
    fs::read(path).map_err(|error| format!("could not read {label}: {error}"))
}

fn read_secret_key(path: &Path) -> Result<Zeroizing<[u8; 32]>, String> {
    require_private_file(path)?;
    let encoded = Zeroizing::new(
        fs::read_to_string(path)
            .map_err(|error| format!("could not read artifact signing key: {error}"))?,
    );
    let decoded = Zeroizing::new(
        hex::decode(encoded.trim())
            .map_err(|_| "artifact signing key must be hexadecimal".to_owned())?,
    );
    let key = decoded
        .as_slice()
        .try_into()
        .map_err(|_| "artifact signing key must contain exactly 32 bytes".to_owned())?;
    Ok(Zeroizing::new(key))
}

#[cfg(unix)]
fn require_private_file(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("could not inspect artifact signing key: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("artifact signing key must be a regular non-symlink file".to_owned());
    }
    if metadata.permissions().mode() & 0o077 != 0 {
        return Err("artifact signing key permissions must be 0600 or stricter".to_owned());
    }
    Ok(())
}

#[cfg(not(unix))]
fn require_private_file(path: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("could not inspect artifact signing key: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("artifact signing key must be a regular non-symlink file".to_owned());
    }
    Ok(())
}
