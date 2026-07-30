use community_search_core::{
    ModelContract, QueryCatalogPayload, QueryCatalogSnapshot, SignedQueryCatalogPackage,
    QUERY_NORMALIZATION_VERSION,
};
use ed25519_dalek::SigningKey;
use std::{
    collections::HashMap,
    env, fs,
    path::{Path, PathBuf},
    process::ExitCode,
};
use zeroize::Zeroizing;

const ALLOWED_ARGUMENTS: &[&str] = &[
    "scope",
    "sequence",
    "signing-key-file",
    "review-id",
    "policy-version",
    "created-at-ms",
    "expires-at-ms",
    "output",
];

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("empty Common-Query publication failed: {error}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<(), String> {
    let arguments = parse_arguments()?;
    let scope = required(&arguments, "scope")?;
    let sequence = required_u64(&arguments, "sequence")?;
    let signing_key_file = required_path(&arguments, "signing-key-file")?;
    let review_id = required(&arguments, "review-id")?;
    let policy_version = required(&arguments, "policy-version")?;
    let created_at_ms = required_u64(&arguments, "created-at-ms")?;
    let expires_at_ms = required_u64(&arguments, "expires-at-ms")?;
    let output = required_path(&arguments, "output")?;
    if expires_at_ms <= created_at_ms {
        return Err("expires-at-ms must be after created-at-ms".to_owned());
    }

    let payload = QueryCatalogPayload::Snapshot(QueryCatalogSnapshot {
        schema_version: 1,
        catalog_scope_id: scope,
        sequence,
        normalization_version: QUERY_NORMALIZATION_VERSION.to_owned(),
        model: ModelContract::harrier_v1(),
        entries: Vec::new(),
        tombstones: Vec::new(),
    });
    let seed = read_secret_key(&signing_key_file)?;
    let signing_key = SigningKey::from_bytes(&seed);
    let signed = SignedQueryCatalogPackage::create(
        &payload,
        &signing_key,
        review_id,
        policy_version,
        created_at_ms,
        expires_at_ms,
    )
    .map_err(|error| error.to_string())?;
    publish_files(&output, &signed.manifest_json, &signed.payload_json)?;
    println!(
        "published immutable empty Common-Query sequence {sequence} to {}",
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

fn read_secret_key(path: &Path) -> Result<Zeroizing<[u8; 32]>, String> {
    require_private_file(path)?;
    let encoded = Zeroizing::new(
        fs::read_to_string(path)
            .map_err(|error| format!("could not read catalog signing key: {error}"))?,
    );
    let decoded = Zeroizing::new(
        hex::decode(encoded.trim())
            .map_err(|_| "catalog signing key must be hexadecimal".to_owned())?,
    );
    let key = decoded
        .as_slice()
        .try_into()
        .map_err(|_| "catalog signing key must contain exactly 32 bytes".to_owned())?;
    Ok(Zeroizing::new(key))
}

#[cfg(unix)]
fn require_private_file(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("could not inspect catalog signing key: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("catalog signing key must be a regular non-symlink file".to_owned());
    }
    if metadata.permissions().mode() & 0o077 != 0 {
        return Err("catalog signing key permissions must be 0600 or stricter".to_owned());
    }
    Ok(())
}

#[cfg(not(unix))]
fn require_private_file(path: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("could not inspect catalog signing key: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("catalog signing key must be a regular non-symlink file".to_owned());
    }
    Ok(())
}

fn publish_files(output: &Path, manifest_json: &[u8], payload_json: &[u8]) -> Result<(), String> {
    match fs::symlink_metadata(output) {
        Ok(_) => return Err("output directory already exists".to_owned()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("could not inspect output directory: {error}")),
    }
    fs::create_dir_all(output)
        .map_err(|error| format!("could not create output directory: {error}"))?;
    if let Err(error) = fs::write(output.join("manifest.json"), manifest_json)
        .and_then(|_| fs::write(output.join("queries.json"), payload_json))
    {
        let _ = fs::remove_dir_all(output);
        return Err(format!("could not publish Common-Query package: {error}"));
    }
    Ok(())
}
