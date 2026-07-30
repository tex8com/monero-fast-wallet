use community_publication_core::PublicationStore;
use community_search_core::{CatalogPayload, CatalogSnapshot, ModelContract, SignedCatalogPackage};
use ed25519_dalek::SigningKey;
use std::{
    collections::HashMap,
    env, fs,
    path::{Path, PathBuf},
    process::ExitCode,
};
use zeroize::Zeroizing;

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("catalog publication failed: {error}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<(), String> {
    let arguments = parse_arguments()?;
    let publication_database = required_path(&arguments, "publication-db")?;
    let storage_key_file = required_path(&arguments, "storage-key-file")?;
    let signing_key_file = required_path(&arguments, "signing-key-file")?;
    let output_directory = required_path(&arguments, "output")?;
    let scope = required(&arguments, "scope")?;
    let review_id = required(&arguments, "review-id")?;
    let policy_version = required(&arguments, "policy-version")?;
    let sequence = required_u64(&arguments, "sequence")?;
    let created_at_ms = required_u64(&arguments, "created-at-ms")?;
    let expires_at_ms = required_u64(&arguments, "expires-at-ms")?;
    let model = ModelContract::harrier_v1();
    model.validate_v1().map_err(|error| error.to_string())?;
    if expires_at_ms <= created_at_ms {
        return Err("expires-at-ms must be after created-at-ms".to_owned());
    }

    let storage_key = read_secret_key(&storage_key_file, "publication storage key")?;
    let signing_seed = read_secret_key(&signing_key_file, "catalog signing key")?;
    let signing_key = SigningKey::from_bytes(&signing_seed);
    let store = PublicationStore::open(&publication_database, *storage_key)
        .map_err(|error| error.to_string())?;
    let items = store
        .catalog_records(created_at_ms)
        .map_err(|error| error.to_string())?;
    if items.iter().any(|item| item.model != model) {
        return Err("published records contain a different model contract".to_owned());
    }
    let tombstones = store
        .catalog_tombstones()
        .map_err(|error| error.to_string())?;
    let payload = CatalogPayload::Snapshot(CatalogSnapshot {
        schema_version: 1,
        catalog_scope_id: scope.clone(),
        sequence,
        model,
        items,
        tombstones,
    });
    let signed = SignedCatalogPackage::create(
        &payload,
        &signing_key,
        review_id,
        policy_version,
        created_at_ms,
        expires_at_ms,
    )
    .map_err(|error| error.to_string())?;
    publish_files(
        &output_directory,
        &signed.manifest_json,
        &signed.payload_json,
    )?;
    println!(
        "published signed Community catalog sequence {sequence} for scope {scope} to {}",
        output_directory.display()
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

fn read_secret_key(path: &Path, label: &str) -> Result<Zeroizing<[u8; 32]>, String> {
    require_private_file(path, label)?;
    let encoded = Zeroizing::new(
        fs::read_to_string(path).map_err(|error| format!("could not read {label}: {error}"))?,
    );
    let decoded = Zeroizing::new(
        hex::decode(encoded.trim())
            .map_err(|_| format!("{label} must contain 64 hexadecimal characters"))?,
    );
    let key: [u8; 32] = decoded
        .as_slice()
        .try_into()
        .map_err(|_| format!("{label} must contain exactly 32 bytes"))?;
    Ok(Zeroizing::new(key))
}

#[cfg(unix)]
fn require_private_file(path: &Path, label: &str) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("could not inspect {label}: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(format!("{label} must be a regular non-symlink file"));
    }
    if metadata.permissions().mode() & 0o077 != 0 {
        return Err(format!("{label} permissions must be 0600 or stricter"));
    }
    Ok(())
}

#[cfg(not(unix))]
fn require_private_file(path: &Path, label: &str) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("could not inspect {label}: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(format!("{label} must be a regular non-symlink file"));
    }
    Ok(())
}

fn publish_files(
    output_directory: &Path,
    manifest_json: &[u8],
    payload_json: &[u8],
) -> Result<(), String> {
    if output_directory.exists() {
        return Err(
            "output directory already exists; catalog publication never overwrites".to_owned(),
        );
    }
    let parent = output_directory
        .parent()
        .ok_or_else(|| "output directory needs a parent".to_owned())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("could not create output parent: {error}"))?;
    let file_name = output_directory
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "output directory name is invalid".to_owned())?;
    let staging = parent.join(format!(".{file_name}.staging-{}", std::process::id()));
    if staging.exists() {
        return Err("catalog staging directory already exists".to_owned());
    }
    fs::create_dir(&staging)
        .map_err(|error| format!("could not create catalog staging directory: {error}"))?;
    let result = (|| {
        write_synced(&staging.join("manifest.json"), manifest_json)?;
        write_synced(&staging.join("catalog.json"), payload_json)?;
        fs::rename(&staging, output_directory)
            .map_err(|error| format!("could not atomically publish catalog: {error}"))?;
        sync_directory(parent)
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(&staging);
    }
    result
}

fn write_synced(path: &Path, bytes: &[u8]) -> Result<(), String> {
    fs::write(path, bytes)
        .map_err(|error| format!("could not write {}: {error}", path.display()))?;
    fs::File::open(path)
        .and_then(|file| file.sync_all())
        .map_err(|error| format!("could not sync {}: {error}", path.display()))
}

#[cfg(unix)]
fn sync_directory(path: &Path) -> Result<(), String> {
    fs::File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| format!("could not sync {}: {error}", path.display()))
}

#[cfg(not(unix))]
fn sync_directory(_path: &Path) -> Result<(), String> {
    Ok(())
}
