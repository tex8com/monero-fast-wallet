use community_search_core::{QueryCatalogPayload, SignedQueryCatalogPackage};
use ed25519_dalek::SigningKey;
use std::{
    collections::HashMap,
    env, fs,
    path::{Path, PathBuf},
    process::ExitCode,
};
use zeroize::Zeroizing;

const ALLOWED_ARGUMENTS: &[&str] = &[
    "input",
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
            eprintln!("Common-Query publication failed: {error}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<(), String> {
    let arguments = parse_arguments()?;
    let input = required_path(&arguments, "input")?;
    let signing_key_file = required_path(&arguments, "signing-key-file")?;
    let output = required_path(&arguments, "output")?;
    let review_id = required(&arguments, "review-id")?;
    let policy_version = required(&arguments, "policy-version")?;
    let created_at_ms = required_u64(&arguments, "created-at-ms")?;
    let expires_at_ms = required_u64(&arguments, "expires-at-ms")?;
    if expires_at_ms <= created_at_ms {
        return Err("expires-at-ms must be after created-at-ms".to_owned());
    }

    let input_metadata = fs::symlink_metadata(&input)
        .map_err(|error| format!("could not inspect query payload: {error}"))?;
    if input_metadata.file_type().is_symlink() || !input_metadata.is_file() {
        return Err("query payload must be a regular non-symlink file".to_owned());
    }
    let input_bytes =
        fs::read(&input).map_err(|error| format!("could not read query payload: {error}"))?;
    let payload: QueryCatalogPayload = serde_json::from_slice(&input_bytes)
        .map_err(|error| format!("query payload is invalid: {error}"))?;
    let signing_seed = read_secret_key(&signing_key_file)?;
    let signing_key = SigningKey::from_bytes(&signing_seed);
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
        "published immutable signed Common-Query package to {}",
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

fn publish_files(output: &Path, manifest: &[u8], payload: &[u8]) -> Result<(), String> {
    if output.exists() {
        return Err("output directory already exists; publication never overwrites".to_owned());
    }
    let parent = output
        .parent()
        .ok_or_else(|| "output directory needs a parent".to_owned())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("could not create output parent: {error}"))?;
    let name = output
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "output directory name is invalid".to_owned())?;
    let staging = parent.join(format!(".{name}.staging-{}", std::process::id()));
    if staging.exists() {
        return Err("publication staging directory already exists".to_owned());
    }
    fs::create_dir(&staging)
        .map_err(|error| format!("could not create publication staging directory: {error}"))?;
    let result = (|| {
        write_synced(&staging.join("manifest.json"), manifest)?;
        write_synced(&staging.join("queries.json"), payload)?;
        fs::rename(&staging, output)
            .map_err(|error| format!("could not atomically publish query catalog: {error}"))?;
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn immutable_publication_never_overwrites_a_generation() {
        let directory = tempfile::tempdir().unwrap();
        let output = directory.path().join("00000000000000000001");
        publish_files(&output, b"manifest", b"payload").unwrap();
        assert_eq!(fs::read(output.join("manifest.json")).unwrap(), b"manifest");
        assert_eq!(fs::read(output.join("queries.json")).unwrap(), b"payload");
        assert!(publish_files(&output, b"changed", b"changed").is_err());
        assert_eq!(fs::read(output.join("manifest.json")).unwrap(), b"manifest");
    }

    #[cfg(unix)]
    #[test]
    fn signing_key_rejects_group_readable_and_symlink_files() {
        use std::os::unix::{fs::symlink, fs::PermissionsExt};

        let directory = tempfile::tempdir().unwrap();
        let key = directory.path().join("key");
        fs::write(&key, "11".repeat(32)).unwrap();
        fs::set_permissions(&key, fs::Permissions::from_mode(0o640)).unwrap();
        assert!(read_secret_key(&key).is_err());
        fs::set_permissions(&key, fs::Permissions::from_mode(0o600)).unwrap();
        assert!(read_secret_key(&key).is_ok());
        let link = directory.path().join("link");
        symlink(&key, &link).unwrap();
        assert!(read_secret_key(&link).is_err());
    }
}
