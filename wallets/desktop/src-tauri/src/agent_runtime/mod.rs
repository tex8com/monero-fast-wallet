//! Private agent bookkeeping. No credential or wallet material belongs here.
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
    time::{SystemTime, UNIX_EPOCH},
};

pub const MAX_EVENTS: usize = 512;
const MAX_LOG_BYTES: u64 = 256 * 1024;

pub fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

pub fn opaque_id(id: &str) -> bool {
    let valid = ((id.starts_with("evt_") || id.starts_with("sig_")) && id.len() == 68)
        || (id.starts_with("fwpush_") && id.len() == 39);
    valid
        && id.split_once('_').is_some_and(|(_, suffix)| {
            suffix
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        })
}

pub struct InstanceGuard {
    _file: File,
}
impl InstanceGuard {
    pub fn acquire(config: &Path) -> Result<Option<Self>, String> {
        let path = config
            .canonicalize()
            .map_err(|_| "agent_config_path_invalid")?
            .with_extension("agent.lock");
        let file = private_file(&path, false)?;
        match file.try_lock() {
            Ok(()) => Ok(Some(Self { _file: file })),
            Err(fs::TryLockError::WouldBlock) => Ok(None),
            Err(_) => Err("agent_lock_unavailable".into()),
        }
    }
}

fn private_file(path: &Path, append: bool) -> Result<File, String> {
    let mut options = OpenOptions::new();
    options.create(true).write(true).read(true).append(append);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options
        .open(path)
        .map_err(|_| "agent_private_file_unavailable".into())
}

pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    // Activation processes may write a pending-open receipt concurrently.
    let mut nonce = [0u8; 8];
    getrandom::getrandom(&mut nonce).map_err(|_| "agent_write_random_failed")?;
    let temporary = path.with_extension(format!("atomic-{}.tmp", hex::encode(nonce)));
    let result = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary).map_err(|_| "agent_write_failed")?;
        file.write_all(bytes)
            .and_then(|_| file.sync_all())
            .map_err(|_| "agent_write_failed")?;
        drop(file);
        #[cfg(windows)]
        {
            use std::os::windows::ffi::OsStrExt;
            #[link(name = "kernel32")]
            unsafe extern "system" {
                fn MoveFileExW(from: *const u16, to: *const u16, flags: u32) -> i32;
            }
            let from: Vec<u16> = temporary.as_os_str().encode_wide().chain(Some(0)).collect();
            let to: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
            if unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), 0x1 | 0x8) } == 0 {
                return Err("agent_replace_failed".into());
            }
        }
        #[cfg(not(windows))]
        fs::rename(&temporary, path).map_err(|_| "agent_replace_failed")?;
        #[cfg(unix)]
        File::open(path.parent().ok_or("agent_directory_invalid")?)
            .and_then(|directory| directory.sync_all())
            .map_err(|_| "agent_directory_sync_failed")?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeliveryStage {
    Received,
    PresentationPending,
    PresentationUnknown,
    OsAccepted,
    Acknowledged,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeliveryRecord {
    pub stage: DeliveryStage,
    pub received_at: u64,
    #[serde(default)]
    pub category: Option<String>,
    #[serde(default)]
    pub deep_link: Option<String>,
}
impl DeliveryRecord {
    pub fn os_accepted(&self) -> bool {
        matches!(
            self.stage,
            DeliveryStage::OsAccepted | DeliveryStage::Acknowledged
        )
    }
    pub fn uncertain(&self) -> bool {
        matches!(
            self.stage,
            DeliveryStage::PresentationPending | DeliveryStage::PresentationUnknown
        )
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct JournalDisk {
    version: u8,
    events: BTreeMap<String, DeliveryRecord>,
}
pub struct Journal {
    path: PathBuf,
    disk: JournalDisk,
}
impl Journal {
    pub fn open(directory: &Path) -> Result<Self, String> {
        let path = directory.join("agent-state.json");
        let disk = match File::open(&path) {
            Ok(file) => {
                let mut bytes = Vec::new();
                file.take(256 * 1024 + 1)
                    .read_to_end(&mut bytes)
                    .map_err(|_| "agent_journal_unreadable")?;
                if bytes.len() > 256 * 1024 {
                    return Err("agent_journal_too_large".into());
                }
                serde_json::from_slice::<JournalDisk>(&bytes)
                    .map_err(|_| "agent_journal_invalid")?
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => JournalDisk {
                version: 1,
                events: BTreeMap::new(),
            },
            Err(_) => return Err("agent_journal_unreadable".into()),
        };
        if disk.version != 1
            || disk.events.len() > MAX_EVENTS
            || disk
                .events
                .iter()
                .any(|(id, record)| !opaque_id(id) || record.received_at == 0)
        {
            return Err("agent_journal_invalid".into());
        }
        Ok(Self { path, disk })
    }
    pub fn receive(&mut self, id: &str, at: u64) -> Result<DeliveryRecord, String> {
        if !opaque_id(id) || at == 0 {
            return Err("agent_event_invalid".into());
        }
        if let Some(record) = self.disk.events.get(id) {
            return Ok(record.clone());
        }
        let evicted = if self.disk.events.len() >= MAX_EVENTS {
            let oldest = self
                .disk
                .events
                .iter()
                .filter(|(_, record)| record.stage == DeliveryStage::Acknowledged)
                .min_by_key(|(_, record)| record.received_at)
                .map(|(id, _)| id.clone())
                .ok_or("agent_journal_full")?;
            self.disk.events.remove_entry(&oldest)
        } else {
            None
        };
        let record = DeliveryRecord {
            stage: DeliveryStage::Received,
            received_at: at,
            category: None,
            deep_link: None,
        };
        self.disk.events.insert(id.into(), record.clone());
        if let Err(error) = self.save() {
            self.disk.events.remove(id);
            if let Some((id, old)) = evicted {
                self.disk.events.insert(id, old);
            }
            return Err(error);
        }
        Ok(record)
    }
    pub fn receive_event(
        &mut self,
        id: &str,
        category: &str,
        deep_link: &str,
        at: u64,
    ) -> Result<DeliveryRecord, String> {
        if !valid_metadata(category, deep_link) {
            return Err("agent_event_metadata_invalid".into());
        }
        let mut record = self.receive(id, at)?;
        if record.category.as_deref() == Some(category)
            && record.deep_link.as_deref() == Some(deep_link)
        {
            return Ok(record);
        }
        if record.category.is_some() || record.deep_link.is_some() {
            return Err("agent_event_metadata_changed".into());
        }
        record.category = Some(category.into());
        record.deep_link = Some(deep_link.into());
        let old = self.disk.events.insert(id.into(), record.clone()).unwrap();
        if let Err(error) = self.save() {
            self.disk.events.insert(id.into(), old);
            return Err(error);
        }
        Ok(record)
    }
    pub fn accepted_event(&self, id: &str) -> Result<DeliveryRecord, String> {
        let record = self
            .disk
            .events
            .get(id)
            .filter(|record| record.os_accepted())
            .ok_or("agent_notification_not_accepted")?;
        if !record
            .category
            .as_deref()
            .zip(record.deep_link.as_deref())
            .is_some_and(|(category, link)| valid_metadata(category, link))
        {
            return Err("agent_notification_metadata_missing".into());
        }
        Ok(record.clone())
    }
    pub fn pending_activation(&self, id: &str) -> bool {
        self.disk.events.get(id).is_some_and(|record| {
            record.uncertain()
                && record
                    .category
                    .as_deref()
                    .zip(record.deep_link.as_deref())
                    .is_some_and(|(category, link)| valid_metadata(category, link))
        })
    }
    pub fn mark(&mut self, id: &str, stage: DeliveryStage) -> Result<(), String> {
        let old = self.disk.events.get(id).ok_or("agent_event_missing")?.stage;
        let allowed = old == stage
            || matches!(
                (old, stage),
                (DeliveryStage::Received, DeliveryStage::PresentationPending)
                    | (
                        DeliveryStage::PresentationPending,
                        DeliveryStage::PresentationUnknown | DeliveryStage::OsAccepted
                    )
                    | (
                        DeliveryStage::PresentationUnknown,
                        DeliveryStage::PresentationPending
                    )
                    | (DeliveryStage::OsAccepted, DeliveryStage::Acknowledged)
            );
        if !allowed {
            return Err("agent_stage_regression".into());
        }
        self.disk.events.get_mut(id).unwrap().stage = stage;
        if let Err(error) = self.save() {
            self.disk.events.get_mut(id).unwrap().stage = old;
            return Err(error);
        }
        Ok(())
    }
    fn save(&self) -> Result<(), String> {
        atomic_write(
            &self.path,
            &serde_json::to_vec(&self.disk).map_err(|_| "agent_journal_invalid")?,
        )
    }
}

#[derive(Clone)]
pub struct AgentLog {
    directory: PathBuf,
    writer: Arc<Mutex<()>>,
}
impl AgentLog {
    pub fn new(directory: &Path) -> Self {
        Self {
            directory: directory.into(),
            writer: Arc::new(Mutex::new(())),
        }
    }
    pub fn event(&self, phase: &'static str, id: Option<&str>) {
        // Callers supply fixed phase literals. Reject detail-like payloads.
        if phase.len() > 48
            || !phase
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte == b'_')
            || id.is_some_and(|id| !opaque_id(id))
        {
            return;
        }
        let Ok(_writer) = self.writer.lock() else {
            return;
        };
        let path = self.directory.join("agent.log");
        if fs::metadata(&path).is_ok_and(|metadata| metadata.len() >= MAX_LOG_BYTES) {
            let old = self.directory.join("agent.log.1");
            let _ = fs::remove_file(&old);
            if fs::rename(&path, old).is_err() {
                return;
            }
        }
        let Ok(mut file) = private_file(&path, true) else {
            return;
        };
        let mut line = serde_json::json!({"at":now(),"phase":phase});
        if let Some(id) = id {
            line["eventId"] = id.into();
        }
        if let Ok(mut bytes) = serde_json::to_vec(&line) {
            bytes.push(b'\n');
            let _ = file.write_all(&bytes);
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Health {
    pub version: u8,
    pub pid: u32,
    pub instance_id: &'static str,
    pub heartbeat_at: u64,
    pub connected: bool,
    pub last_peer_at: Option<u64>,
    pub phase: &'static str,
    pub os_phase: Option<&'static str>,
}
impl Health {
    pub fn write(
        directory: &Path,
        phase: &'static str,
        connected: bool,
        last_peer_at: Option<u64>,
        os_phase: Option<&'static str>,
    ) {
        static INSTANCE: OnceLock<Option<String>> = OnceLock::new();
        let Some(instance_id) = INSTANCE
            .get_or_init(|| {
                let mut bytes = [0_u8; 16];
                getrandom::getrandom(&mut bytes)
                    .ok()
                    .map(|_| hex::encode(bytes))
            })
            .as_deref()
        else {
            return;
        };
        let view = Self {
            version: 1,
            pid: std::process::id(),
            instance_id,
            heartbeat_at: now(),
            connected,
            last_peer_at,
            phase,
            os_phase,
        };
        if let Ok(bytes) = serde_json::to_vec(&view) {
            let _ = atomic_write(&directory.join("agent-health.json"), &bytes);
        }
    }
}

pub fn retry_delay(previous: u64, healthy: bool) -> u64 {
    if healthy {
        1
    } else {
        previous.saturating_mul(2).clamp(1, 30)
    }
}

pub enum Activation<'a> {
    Body,
    Action(&'a str),
    Dismissed,
}
pub fn opens_wallet(activation: Activation<'_>) -> bool {
    matches!(
        activation,
        Activation::Body | Activation::Action("open" | "default")
    )
}
pub fn replacement_keys(id: &str) -> Result<(String, String), String> {
    use sha2::{Digest, Sha256};
    if !opaque_id(id) {
        return Err("toast_event_invalid".into());
    }
    let digest = hex::encode(Sha256::digest(id.as_bytes()));
    Ok((digest[..16].into(), digest[16..32].into()))
}

pub const OPEN_SCHEME: &str = "tex8-mfw-notification://open/";
pub fn notification_uri(id: &str) -> Result<String, String> {
    if !opaque_id(id) {
        return Err("agent_notification_uri_invalid".into());
    }
    Ok(format!("{OPEN_SCHEME}{id}"))
}
pub fn notification_id(uri: &str) -> Result<String, String> {
    uri.strip_prefix(OPEN_SCHEME)
        .filter(|id| opaque_id(id))
        .map(str::to_owned)
        .ok_or_else(|| "agent_notification_uri_invalid".into())
}
pub fn arguments(args: Vec<String>) -> Result<(String, Option<String>), String> {
    if (args.len() != 2 && args.len() != 4)
        || args[0] != "--config"
        || args[1].chars().any(char::is_control)
        || !local_config_path(&args[1])
    {
        return Err("agent_arguments_invalid".into());
    }
    let notification = if args.len() == 4 {
        if args[2] != "--open-notification" {
            return Err("agent_arguments_invalid".into());
        }
        Some(notification_id(&args[3])?)
    } else {
        None
    };
    Ok((args[1].clone(), notification))
}
fn local_config_path(value: &str) -> bool {
    if value.contains("://") || !Path::new(value).is_absolute() {
        return false;
    }
    #[cfg(windows)]
    {
        let value = value.strip_prefix(r"\\?\").unwrap_or(value).as_bytes();
        value.len() > 2
            && value[0].is_ascii_alphabetic()
            && value[1] == b':'
            && matches!(value[2], b'\\' | b'/')
    }
    #[cfg(not(windows))]
    {
        !value.starts_with("//")
    }
}
fn valid_metadata(category: &str, link: &str) -> bool {
    match category {
        "monero.fast_wallet.test" => link == "tex8://notification/test",
        "monero.fast_wallet.incoming" => link == "tex8://notification/incoming",
        "monero.fast_wallet.vanity" => link.strip_prefix("mfw://vanity/order/").is_some_and(|id| {
            id.len() == 36
                && id.bytes().enumerate().all(|(index, byte)| {
                    if matches!(index, 8 | 13 | 18 | 23) {
                        byte == b'-'
                    } else {
                        byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()
                    }
                })
        }),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn directory() -> PathBuf {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "mfw-agent-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }
    fn id() -> String {
        format!("evt_{}", "a".repeat(64))
    }
    #[test]
    fn singleton_is_os_owned_and_released_after_owner_drops() {
        let dir = directory();
        let config = dir.join("background-agent.json");
        fs::write(&config, b"{}").unwrap();
        let guard = InstanceGuard::acquire(&config).unwrap().unwrap();
        assert!(InstanceGuard::acquire(&config).unwrap().is_none());
        drop(guard);
        assert!(InstanceGuard::acquire(&config).unwrap().is_some());
        let _ = fs::remove_dir_all(dir);
    }
    #[test]
    fn crash_pending_is_not_accepted_and_retries_but_accepted_survives_restart() {
        let dir = directory();
        let mut journal = Journal::open(&dir).unwrap();
        assert!(!journal.receive(&id(), 100).unwrap().os_accepted());
        journal
            .mark(&id(), DeliveryStage::PresentationPending)
            .unwrap();
        drop(journal);
        let mut journal = Journal::open(&dir).unwrap();
        let record = journal.receive(&id(), 200).unwrap();
        assert!(record.uncertain());
        assert!(!record.os_accepted());
        assert_eq!(record.received_at, 100);
        journal
            .mark(&id(), DeliveryStage::PresentationUnknown)
            .unwrap();
        assert!(
            journal.mark(&id(), DeliveryStage::Acknowledged).is_err(),
            "unknown OS outcome must remain queued"
        );
        journal
            .mark(&id(), DeliveryStage::PresentationPending)
            .unwrap();
        journal.mark(&id(), DeliveryStage::OsAccepted).unwrap();
        drop(journal);
        let mut journal = Journal::open(&dir).unwrap();
        assert!(journal.receive(&id(), 300).unwrap().os_accepted());
        journal.mark(&id(), DeliveryStage::Acknowledged).unwrap();
        assert!(journal
            .mark(&id(), DeliveryStage::PresentationPending)
            .is_err());
        let _ = fs::remove_dir_all(dir);
    }
    #[test]
    fn corrupt_journal_fails_closed_instead_of_forgetting_previous_deliveries() {
        let dir = directory();
        fs::write(dir.join("agent-state.json"), b"broken").unwrap();
        assert!(Journal::open(&dir).is_err());
        let _ = fs::remove_dir_all(dir);
    }
    #[test]
    fn failed_persistence_cannot_turn_an_unaccepted_record_into_an_accepted_one() {
        let dir = directory();
        let mut journal = Journal::open(&dir).unwrap();
        journal.receive(&id(), 100).unwrap();
        journal
            .mark(&id(), DeliveryStage::PresentationPending)
            .unwrap();
        journal.path = dir.join("missing/state.json");
        assert!(journal.mark(&id(), DeliveryStage::OsAccepted).is_err());
        assert!(!journal.receive(&id(), 200).unwrap().os_accepted());
        let _ = fs::remove_dir_all(dir);
    }
    #[test]
    fn logs_rotate_and_only_allow_phase_and_opaque_correlation() {
        let dir = directory();
        let log = AgentLog::new(&dir);
        fs::write(dir.join("agent.log"), vec![b'x'; MAX_LOG_BYTES as usize]).unwrap();
        log.event("socket_received", Some(&id()));
        log.event("secret=value", None);
        log.event("ack_sent", Some("address"));
        let lines = fs::read_to_string(dir.join("agent.log")).unwrap();
        assert_eq!(lines.lines().count(), 1);
        let value: serde_json::Value = serde_json::from_str(lines.trim()).unwrap();
        assert_eq!(value.as_object().unwrap().len(), 3);
        assert_eq!(value["phase"], "socket_received");
        assert_eq!(
            fs::metadata(dir.join("agent.log.1")).unwrap().len(),
            MAX_LOG_BYTES
        );
        let _ = fs::remove_dir_all(dir);
    }
    #[test]
    fn healthy_connection_resets_backoff() {
        assert_eq!(retry_delay(30, true), 1);
        assert_eq!(retry_delay(16, false), 30);
        assert_eq!(retry_delay(1, false), 2);
    }
    #[test]
    fn body_and_open_activate_but_dismissal_and_unknown_actions_never_do() {
        assert!(opens_wallet(Activation::Body));
        assert!(opens_wallet(Activation::Action("open")));
        assert!(!opens_wallet(Activation::Dismissed));
        assert!(!opens_wallet(Activation::Action("__closed")));
        assert!(!opens_wallet(Activation::Action("untrusted")));
    }
    #[test]
    fn replacements_are_stable_bounded_and_different_for_different_events() {
        let keys = replacement_keys(&id()).unwrap();
        assert_eq!(keys.0.len(), 16);
        assert_eq!(keys.1.len(), 16);
        assert_eq!(keys, replacement_keys(&id()).unwrap());
        assert_ne!(
            keys,
            replacement_keys(&format!("evt_{}", "b".repeat(64))).unwrap()
        );
        assert!(replacement_keys("address-or-secret").is_err());
    }
    #[test]
    fn activation_after_restart_requires_exact_accepted_owned_metadata() {
        let dir = directory();
        let mut journal = Journal::open(&dir).unwrap();
        journal
            .receive_event(
                &id(),
                "monero.fast_wallet.test",
                "tex8://notification/test",
                100,
            )
            .unwrap();
        journal
            .mark(&id(), DeliveryStage::PresentationPending)
            .unwrap();
        assert!(journal.accepted_event(&id()).is_err());
        assert!(journal.pending_activation(&id()));
        assert!(!journal.pending_activation(&format!("evt_{}", "b".repeat(64))));
        journal.mark(&id(), DeliveryStage::OsAccepted).unwrap();
        drop(journal);
        let mut restarted = Journal::open(&dir).unwrap();
        let event = restarted.accepted_event(&id()).unwrap();
        assert_eq!(event.received_at, 100);
        assert_eq!(event.category.as_deref(), Some("monero.fast_wallet.test"));
        assert!(restarted
            .accepted_event(&format!("evt_{}", "b".repeat(64)))
            .is_err());
        assert!(restarted
            .receive_event(
                &id(),
                "monero.fast_wallet.incoming",
                "tex8://notification/incoming",
                200
            )
            .is_err());
        assert!(restarted
            .receive_event(
                &id(),
                "monero.fast_wallet.test",
                "https://attacker/path",
                200
            )
            .is_err());
        let _ = fs::remove_dir_all(dir);
    }
    #[test]
    fn protocol_and_cli_reject_extra_args_paths_queries_and_foreign_handlers() {
        let uri = notification_uri(&id()).unwrap();
        assert_eq!(notification_id(&uri).unwrap(), id());
        for uri in [
            format!("{uri}?file=/tmp/x"),
            format!("{uri}/extra"),
            format!("{uri}%22"),
            format!("{uri}\" --config \\\\attacker\\share"),
            format!("{uri} --config /untrusted"),
            "https://example/open".into(),
            "tex8-mfw-notification://other/anything".into(),
        ] {
            assert!(notification_id(&uri).is_err());
        }
        let fixed_config = std::env::temp_dir()
            .join("fixed-config.json")
            .to_string_lossy()
            .into_owned();
        let args = vec![
            "--config".into(),
            fixed_config,
            "--open-notification".into(),
            uri,
        ];
        assert_eq!(arguments(args.clone()).unwrap().1, Some(id()));
        let mut duplicate = args.clone();
        duplicate[2] = "--config".into();
        assert!(arguments(duplicate).is_err());
        let mut extra = args;
        extra.extend(["--config".into(), "/untrusted".into()]);
        assert!(arguments(extra).is_err());
        assert!(arguments(vec![]).is_err());
        for config in [
            r"\\attacker\share\config.json",
            "//attacker/share/config.json",
            "https://attacker/config",
            "relative.json",
        ] {
            assert!(arguments(vec!["--config".into(), config.into()]).is_err());
        }
    }
}
