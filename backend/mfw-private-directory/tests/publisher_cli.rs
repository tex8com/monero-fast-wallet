use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Output},
    time::{SystemTime, UNIX_EPOCH},
};

use mfw_recipient_protocol::{
    generate_hpke_keypair, ContactSigningKey, ParticipantRecord, PhoneToken,
    SignedDirectorySnapshot,
};

const EPOCH: u64 = 17;

#[test]
fn publisher_cli_persists_mutations_and_monotone_snapshots() {
    let directory = tempfile::tempdir().unwrap();
    let state_path = directory.path().join("directory.state");
    let snapshot_path = directory.path().join("snapshot.bin");
    let state_key_path = directory.path().join("state.key");
    let verification_key_path = directory.path().join("verification.pub");
    let signing_key_path = directory.path().join("directory.key");
    let participant_path = directory.path().join("participant.bin");
    let verification = ContactSigningKey::from_bytes([61; 32]);
    let directory_signing = ContactSigningKey::from_bytes([62; 32]);
    write_hex_key(&state_key_path, [63; 32], true);
    write_hex_key(&verification_key_path, verification.public_key(), false);
    write_hex_key(&signing_key_path, [62; 32], true);

    assert_success(run(
        "init",
        None,
        &state_path,
        &snapshot_path,
        &state_key_path,
        &verification_key_path,
        &signing_key_path,
    ));

    let participant_signing = ContactSigningKey::from_bytes([64; 32]);
    let (_, hpke_public_key) = generate_hpke_keypair().unwrap();
    let now = unix_seconds();
    let participant = ParticipantRecord::authorized(
        EPOCH,
        PhoneToken([65; 32]),
        participant_signing.public_key(),
        hpke_public_key,
        now.saturating_sub(1),
        now + 3_600,
        1,
        &verification,
    )
    .unwrap();
    fs::write(&participant_path, participant.encode()).unwrap();

    assert_success(run(
        "add-participant",
        Some(&participant_path),
        &state_path,
        &snapshot_path,
        &state_key_path,
        &verification_key_path,
        &signing_key_path,
    ));
    let idempotent = run(
        "add-participant",
        Some(&participant_path),
        &state_path,
        &snapshot_path,
        &state_key_path,
        &verification_key_path,
        &signing_key_path,
    );
    assert_success(idempotent.clone());
    assert!(String::from_utf8(idempotent.stdout)
        .unwrap()
        .contains("Idempotent"));

    assert_success(run(
        "publish",
        None,
        &state_path,
        &snapshot_path,
        &state_key_path,
        &verification_key_path,
        &signing_key_path,
    ));
    let first = SignedDirectorySnapshot::decode(&fs::read(&snapshot_path).unwrap()).unwrap();
    assert_eq!(first.generation, 1);
    assert_eq!(first.participants.len(), 1);
    first
        .verify(
            directory_signing.public_key(),
            verification.public_key(),
            unix_seconds(),
        )
        .unwrap();

    assert_success(run(
        "publish",
        None,
        &state_path,
        &snapshot_path,
        &state_key_path,
        &verification_key_path,
        &signing_key_path,
    ));
    let second = SignedDirectorySnapshot::decode(&fs::read(&snapshot_path).unwrap()).unwrap();
    assert_eq!(second.generation, 2);

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&state_path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            fs::metadata(&snapshot_path).unwrap().permissions().mode() & 0o777,
            0o644
        );
    }
}

#[allow(clippy::too_many_arguments)]
fn run(
    command: &str,
    input: Option<&Path>,
    state_path: &Path,
    snapshot_path: &Path,
    state_key_path: &Path,
    verification_key_path: &Path,
    signing_key_path: &Path,
) -> Output {
    let mut process = Command::new(env!("CARGO_BIN_EXE_mfw-directory-publisher"));
    process
        .arg(command)
        .env("MFW_VOPRF_EPOCH", EPOCH.to_string())
        .env("MFW_DIRECTORY_STATE_FILE", state_path)
        .env("MFW_DIRECTORY_SNAPSHOT_FILE", snapshot_path)
        .env("MFW_DIRECTORY_STATE_KEY_FILE", state_key_path)
        .env(
            "MFW_PHONE_VERIFICATION_PUBLIC_KEY_FILE",
            verification_key_path,
        )
        .env("MFW_DIRECTORY_SIGNING_KEY_FILE", signing_key_path)
        .env("MFW_DIRECTORY_SNAPSHOT_LIFETIME_SECONDS", "600");
    if let Some(input) = input {
        process.arg(input);
    }
    process.output().unwrap()
}

fn assert_success(output: Output) {
    assert!(
        output.status.success(),
        "stdout={}\nstderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

fn write_hex_key(path: &PathBuf, bytes: [u8; 32], secret: bool) {
    fs::write(path, format!("{}\n", hex::encode(bytes))).unwrap();
    #[cfg(unix)]
    if secret {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
    }
    #[cfg(not(unix))]
    let _ = secret;
}

fn unix_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
}
