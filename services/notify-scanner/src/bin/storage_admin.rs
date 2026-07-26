use anyhow::{bail, Context};
use notify_scanner::{
    backup_storage_file, parse_storage_key, restore_storage_file, rotate_storage_key,
    verify_storage_file,
};
use std::{env, path::PathBuf};
use zeroize::Zeroize;

fn main() -> anyhow::Result<()> {
    let mut args = env::args().skip(1);
    let command = args.next().unwrap_or_default();
    let source = args.next().map(PathBuf::from);
    let destination = args.next().map(PathBuf::from);
    if args.next().is_some() {
        bail!("too many arguments");
    }

    match command.as_str() {
        "verify" => {
            let path = required_path(source, "verify requires <database-path>")?;
            let mut key = storage_key("NOTIFY_SCANNER_STORAGE_KEY")?;
            let result = verify_storage_file(path, key);
            key.zeroize();
            result?;
        }
        "rotate-key" => {
            let path = required_path(source, "rotate-key requires <database-path>")?;
            let mut old_key = storage_key("NOTIFY_SCANNER_OLD_STORAGE_KEY")?;
            let mut new_key = match storage_key("NOTIFY_SCANNER_NEW_STORAGE_KEY") {
                Ok(key) => key,
                Err(error) => {
                    old_key.zeroize();
                    return Err(error);
                }
            };
            let result = rotate_storage_key(path, old_key, new_key);
            old_key.zeroize();
            new_key.zeroize();
            result?;
        }
        "backup" => {
            let source = required_path(source, "backup requires <database-path> <backup-path>")?;
            let destination =
                required_path(destination, "backup requires <database-path> <backup-path>")?;
            let mut key = storage_key("NOTIFY_SCANNER_STORAGE_KEY")?;
            let result = backup_storage_file(source, destination, key);
            key.zeroize();
            result?;
        }
        "restore" => {
            let source = required_path(source, "restore requires <backup-path> <database-path>")?;
            let destination = required_path(
                destination,
                "restore requires <backup-path> <database-path>",
            )?;
            let mut key = storage_key("NOTIFY_SCANNER_STORAGE_KEY")?;
            let result = restore_storage_file(source, destination, key);
            key.zeroize();
            result?;
        }
        _ => {
            bail!("usage: storage_admin <verify|rotate-key|backup|restore> <source> [destination]")
        }
    }

    println!("storage operation completed and authenticated successfully");
    Ok(())
}

fn storage_key(name: &str) -> anyhow::Result<[u8; 32]> {
    let mut value = env::var(name).with_context(|| format!("{name} is required"))?;
    let parsed = parse_storage_key(&value);
    value.zeroize();
    parsed
}

fn required_path(path: Option<PathBuf>, message: &str) -> anyhow::Result<PathBuf> {
    path.ok_or_else(|| anyhow::anyhow!(message.to_owned()))
}
