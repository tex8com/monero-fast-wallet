use std::{
    env, fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

use mfw_private_directory::{
    begin_directory_state_transaction, load_directory_state, store_directory_state,
    DirectorySnapshotBuilder, DirectoryStateKey,
};
use mfw_recipient_protocol::{
    ContactEnvelope, ContactRevocation, ContactSigningKey, ParticipantRecord, ParticipantRevocation,
};
use zeroize::Zeroize;

const DEFAULT_SNAPSHOT_LIFETIME_SECONDS: u64 = 15 * 60;
static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

fn main() -> Result<(), String> {
    harden_process()?;
    let command = env::args()
        .nth(1)
        .ok_or_else(|| usage("a command is required"))?;
    let epoch = required_env("MFW_VOPRF_EPOCH")?
        .parse::<u64>()
        .map_err(|_| "MFW_VOPRF_EPOCH is invalid")?;
    let verification_public_key = read_hex_32(
        &required_path("MFW_PHONE_VERIFICATION_PUBLIC_KEY_FILE")?,
        false,
    )?;
    let mut raw_state_key = read_hex_32(&required_path("MFW_DIRECTORY_STATE_KEY_FILE")?, true)?;
    let state_key = DirectoryStateKey::from_bytes(raw_state_key);
    raw_state_key.zeroize();
    let state_path = required_path("MFW_DIRECTORY_STATE_FILE")?;

    match command.as_str() {
        "init" => {
            if fs::symlink_metadata(&state_path).is_ok() {
                return Err("directory state already exists".to_owned());
            }
            let builder = DirectorySnapshotBuilder::new(epoch, verification_public_key);
            store_directory_state(&state_path, &builder, &state_key)
                .map_err(|error| error.to_string())
        }
        "add-participant" => {
            let input = required_argument(2)?;
            let encoded = read_bounded_regular_file(
                Path::new(&input),
                mfw_recipient_protocol::phone::PARTICIPANT_RECORD_BYTES,
            )?;
            let record = ParticipantRecord::decode(&encoded)
                .map_err(|_| "participant record is invalid".to_owned())?;
            mutate_state(
                &state_path,
                epoch,
                verification_public_key,
                &state_key,
                |builder, now| builder.upsert_participant(record, now),
            )
        }
        "revoke-participant" => {
            let input = required_argument(2)?;
            let encoded = read_bounded_regular_file(
                Path::new(&input),
                mfw_recipient_protocol::phone::PARTICIPANT_REVOCATION_BYTES,
            )?;
            let revocation = ParticipantRevocation::decode(&encoded)
                .map_err(|_| "participant revocation is invalid".to_owned())?;
            mutate_state(
                &state_path,
                epoch,
                verification_public_key,
                &state_key,
                |builder, now| builder.revoke_participant(revocation, now),
            )
        }
        "add-contact" => {
            let input = required_argument(2)?;
            let encoded = read_bounded_regular_file(
                Path::new(&input),
                mfw_recipient_protocol::phone::CONTACT_ENVELOPE_BYTES,
            )?;
            let envelope = ContactEnvelope::decode(&encoded)
                .map_err(|_| "contact envelope is invalid".to_owned())?;
            mutate_state(
                &state_path,
                epoch,
                verification_public_key,
                &state_key,
                |builder, now| builder.upsert_contact(envelope, now),
            )
        }
        "revoke-contact" => {
            let input = required_argument(2)?;
            let encoded = read_bounded_regular_file(
                Path::new(&input),
                mfw_recipient_protocol::phone::CONTACT_REVOCATION_BYTES,
            )?;
            let revocation = ContactRevocation::decode(&encoded)
                .map_err(|_| "contact revocation is invalid".to_owned())?;
            mutate_state(
                &state_path,
                epoch,
                verification_public_key,
                &state_key,
                |builder, now| builder.revoke_contact(revocation, now),
            )
        }
        "publish" => {
            let snapshot_path = required_path("MFW_DIRECTORY_SNAPSHOT_FILE")?;
            let lifetime = env::var("MFW_DIRECTORY_SNAPSHOT_LIFETIME_SECONDS")
                .unwrap_or_else(|_| DEFAULT_SNAPSHOT_LIFETIME_SECONDS.to_string())
                .parse::<u64>()
                .map_err(|_| "MFW_DIRECTORY_SNAPSHOT_LIFETIME_SECONDS is invalid")?;
            if lifetime == 0
                || lifetime > mfw_recipient_protocol::phone::MAX_SNAPSHOT_LIFETIME_SECONDS
            {
                return Err("snapshot lifetime is outside the protocol bound".to_owned());
            }
            let mut directory_seed =
                read_hex_32(&required_path("MFW_DIRECTORY_SIGNING_KEY_FILE")?, true)?;
            let directory_signing_key = ContactSigningKey::from_bytes(directory_seed);
            directory_seed.zeroize();
            let mut transaction = begin_directory_state_transaction(
                &state_path,
                epoch,
                verification_public_key,
                &state_key,
            )
            .map_err(|error| error.to_string())?;
            let issued_at = unix_seconds()?;
            let expires_at = issued_at
                .checked_add(lifetime)
                .ok_or_else(|| "snapshot expiry overflow".to_owned())?;
            let snapshot = transaction
                .builder_mut()
                .publish_snapshot(issued_at, expires_at, &directory_signing_key)
                .map_err(|error| error.to_string())?;
            let encoded = snapshot
                .encode()
                .map_err(|_| "snapshot encoding failed".to_owned())?;

            // Persist the increased high-water generation before making the
            // new snapshot visible. A crash may skip a generation, but can
            // never publish a generation that state forgot.
            transaction.commit().map_err(|error| error.to_string())?;
            atomic_write(&snapshot_path, &encoded, 0o644)?;
            println!(
                "generation={} participants={} entries={} expires_at={}",
                snapshot.generation,
                snapshot.participants.len(),
                snapshot.entries.len(),
                snapshot.expires_at
            );
            Ok(())
        }
        "status" => {
            let builder =
                load_directory_state(&state_path, epoch, verification_public_key, &state_key)
                    .map_err(|error| error.to_string())?;
            println!(
                "generation={} participants={} entries={}",
                builder.generation(),
                builder.participant_count(),
                builder.entry_count()
            );
            Ok(())
        }
        _ => Err(usage("unknown command")),
    }
}

fn mutate_state<F>(
    state_path: &Path,
    epoch: u64,
    verification_public_key: [u8; 32],
    state_key: &DirectoryStateKey,
    mutation: F,
) -> Result<(), String>
where
    F: FnOnce(
        &mut DirectorySnapshotBuilder,
        u64,
    ) -> Result<
        mfw_private_directory::MutationOutcome,
        mfw_private_directory::DirectoryMutationError,
    >,
{
    let mut transaction =
        begin_directory_state_transaction(state_path, epoch, verification_public_key, state_key)
            .map_err(|error| error.to_string())?;
    let outcome =
        mutation(transaction.builder_mut(), unix_seconds()?).map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())?;
    println!("{outcome:?}");
    Ok(())
}

fn required_argument(index: usize) -> Result<String, String> {
    env::args()
        .nth(index)
        .ok_or_else(|| usage("a binary input file is required"))
}

fn required_env(name: &str) -> Result<String, String> {
    env::var(name).map_err(|_| format!("{name} is required"))
}

fn required_path(name: &str) -> Result<PathBuf, String> {
    let value = required_env(name)?;
    if value.is_empty() {
        return Err(format!("{name} must not be empty"));
    }
    Ok(PathBuf::from(value))
}

fn read_hex_32(path: &Path, secret: bool) -> Result<[u8; 32], String> {
    let raw = read_bounded_regular_file(path, 65)?;
    let value = raw.strip_suffix(b"\n").unwrap_or(&raw);
    if value.len() != 64 {
        return Err("key must be 64 lowercase hexadecimal characters".to_owned());
    }
    if secret {
        let metadata = fs::metadata(path).map_err(|_| "key metadata unavailable")?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if metadata.permissions().mode() & 0o077 != 0 {
                return Err("secret key file grants group or world access".to_owned());
            }
        }
        #[cfg(not(unix))]
        let _ = metadata;
    }
    let mut decoded = [0; 32];
    for (index, pair) in value.chunks_exact(2).enumerate() {
        decoded[index] = (lower_hex_nibble(pair[0])? << 4) | lower_hex_nibble(pair[1])?;
    }
    Ok(decoded)
}

fn read_bounded_regular_file(path: &Path, maximum: usize) -> Result<Vec<u8>, String> {
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let file = options
        .open(path)
        .map_err(|_| "input file could not be opened safely")?;
    let metadata = file
        .metadata()
        .map_err(|_| "input file metadata unavailable")?;
    if !metadata.is_file()
        || metadata.len() > u64::try_from(maximum).map_err(|_| "input size is invalid")?
    {
        return Err("input file is not a bounded regular file".to_owned());
    }
    let mut bytes =
        Vec::with_capacity(usize::try_from(metadata.len()).map_err(|_| "input size is invalid")?);
    file.take(
        u64::try_from(maximum)
            .map_err(|_| "input size is invalid")?
            .saturating_add(1),
    )
    .read_to_end(&mut bytes)
    .map_err(|_| "input file could not be read")?;
    if bytes.len() > maximum {
        return Err("input file exceeds its size limit".to_owned());
    }
    Ok(bytes)
}

fn atomic_write(path: &Path, bytes: &[u8], unix_mode: u32) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "output path has no parent".to_owned())?;
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "output filename is invalid".to_owned())?;
    let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let temporary_path = parent.join(format!(
        ".{file_name}.tmp.{}.{}",
        std::process::id(),
        counter
    ));
    let result = (|| {
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(unix_mode);
        }
        #[cfg(not(unix))]
        let _ = unix_mode;
        let mut file = options
            .open(&temporary_path)
            .map_err(|_| "temporary output could not be created")?;
        file.write_all(bytes)
            .map_err(|_| "temporary output write failed")?;
        file.sync_all()
            .map_err(|_| "temporary output sync failed")?;
        drop(file);
        fs::rename(&temporary_path, path).map_err(|_| "atomic output rename failed")?;
        #[cfg(unix)]
        fs::File::open(parent)
            .and_then(|directory| directory.sync_all())
            .map_err(|_| "output directory sync failed")?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary_path);
    }
    result
}

fn lower_hex_nibble(byte: u8) -> Result<u8, String> {
    match byte {
        b'0'..=b'9' => Ok(byte - b'0'),
        b'a'..=b'f' => Ok(byte - b'a' + 10),
        _ => Err("key must be lowercase hexadecimal".to_owned()),
    }
}

fn unix_seconds() -> Result<u64, String> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .map_err(|_| "system clock is before the Unix epoch".to_owned())
}

fn harden_process() -> Result<(), String> {
    #[cfg(unix)]
    {
        let limit = libc::rlimit {
            rlim_cur: 0,
            rlim_max: 0,
        };
        // SAFETY: documented setrlimit arguments only.
        if unsafe { libc::setrlimit(libc::RLIMIT_CORE, &limit) } != 0 {
            return Err("could not disable core dumps".to_owned());
        }
    }
    #[cfg(target_os = "linux")]
    {
        // SAFETY: PR_SET_DUMPABLE accepts scalar arguments.
        if unsafe { libc::prctl(libc::PR_SET_DUMPABLE, 0, 0, 0, 0) } != 0 {
            return Err("could not disable process dumping".to_owned());
        }
    }
    Ok(())
}

fn usage(message: &str) -> String {
    format!(
        "{message}; usage: mfw-directory-publisher \
         init|add-participant FILE|revoke-participant FILE|add-contact FILE|\
         revoke-contact FILE|publish|status"
    )
}
