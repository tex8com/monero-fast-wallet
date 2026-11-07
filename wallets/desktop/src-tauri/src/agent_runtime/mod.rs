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
pub mod windows_delivery;

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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub windows_retry: Option<windows_delivery::Retry>,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    windows_os_phase: Option<windows_delivery::OsPhase>,
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
                windows_os_phase: None,
            },
            Err(_) => return Err("agent_journal_unreadable".into()),
        };
        if disk.version != 1
            || disk.events.len() > MAX_EVENTS
            || disk.events.iter().any(|(id, record)| {
                !opaque_id(id)
                    || record.received_at == 0
                    || record.windows_retry.is_some_and(|retry| !retry.valid())
            })
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
            windows_retry: None,
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
    #[cfg(any(target_os = "windows", test))]
    pub fn windows_os_phase(&self) -> Option<&'static str> {
        self.disk
            .windows_os_phase
            .map(windows_delivery::OsPhase::as_str)
    }
    #[cfg(any(target_os = "windows", test))]
    pub fn clear_windows_os_phase(&mut self) -> Result<(), String> {
        let previous = self.disk.windows_os_phase.take();
        if let Err(error) = self.save() {
            self.disk.windows_os_phase = previous;
            return Err(error);
        }
        Ok(())
    }
    /// Call only after acquiring the agent's exclusive InstanceGuard. A
    /// notification activation may read this journal while an OS Show is in
    /// progress and must never classify that live attempt as a crash.
    #[cfg(any(target_os = "windows", test))]
    pub fn recover_windows_pending(&mut self) -> Result<Vec<String>, String> {
        let pending = self
            .disk
            .events
            .iter()
            .filter(|(_, record)| record.stage == DeliveryStage::PresentationPending)
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        if pending.is_empty() {
            return Ok(pending);
        }
        let old_phase = self.disk.windows_os_phase;
        for id in &pending {
            self.disk.events.get_mut(id).unwrap().stage = DeliveryStage::PresentationUnknown;
        }
        if !old_phase.is_some_and(windows_delivery::OsPhase::is_failure) {
            self.disk.windows_os_phase = Some(windows_delivery::OsPhase::PresentationUnknown);
        }
        if let Err(error) = self.save() {
            for id in &pending {
                self.disk.events.get_mut(id).unwrap().stage = DeliveryStage::PresentationPending;
            }
            self.disk.windows_os_phase = old_phase;
            return Err(error);
        }
        Ok(pending)
    }
    #[cfg(any(target_os = "windows", test))]
    pub fn present_windows(
        &mut self,
        id: &str,
        now: u64,
        show: impl FnOnce(Option<&'static str>) -> Result<(), String>,
    ) -> Result<windows_delivery::PresentationOutcome, String> {
        use windows_delivery::PresentationOutcome;
        let record = self.disk.events.get(id).ok_or("agent_event_missing")?;
        if record.os_accepted() {
            return Ok(PresentationOutcome::AlreadyAccepted);
        }
        if record.windows_retry.is_some_and(|retry| !retry.due(now)) {
            return Ok(PresentationOutcome::Deferred);
        }
        let retry = self.begin_windows_presentation(id, now)?;
        let result = show(self.windows_os_phase());
        self.finish_windows_presentation(id, result.as_ref().map(|_| ()).map_err(String::as_str))?;
        Ok(if result.is_ok() {
            PresentationOutcome::Accepted
        } else {
            PresentationOutcome::Retry(retry)
        })
    }
    #[cfg(any(target_os = "windows", test))]
    pub fn acknowledge_windows(
        &mut self,
        id: &str,
        acknowledge: impl FnOnce() -> Result<(), String>,
    ) -> Result<(), String> {
        // An OS failure, a network receipt or a pending retry never qualifies
        // for ACK. A failed ACK leaves OsAccepted persisted for replay.
        self.accepted_event(id)?;
        acknowledge()?;
        self.mark(id, DeliveryStage::Acknowledged)
    }
    /// Only events authenticated on this connection may enter the local
    /// presentation lane. Metadata and retry budgets remain in the journal;
    /// the caller's bounded set contains opaque identifiers only.
    #[cfg(any(target_os = "windows", test))]
    pub fn next_windows_presentation(
        &self,
        authenticated_ids: &std::collections::BTreeSet<String>,
        now: u64,
    ) -> Option<(String, DeliveryRecord)> {
        self.disk
            .events
            .iter()
            .filter(|(id, record)| {
                authenticated_ids.contains(*id)
                    && !record.os_accepted()
                    && record.windows_retry.is_none_or(|retry| retry.due(now))
                    && record
                        .category
                        .as_deref()
                        .zip(record.deep_link.as_deref())
                        .is_some_and(|(category, link)| valid_metadata(category, link))
            })
            .min_by_key(|(_, record)| {
                (
                    record
                        .windows_retry
                        .map_or(record.received_at, |retry| retry.next_attempt_at),
                    record.received_at,
                )
            })
            .map(|(id, record)| (id.clone(), record.clone()))
    }
    #[cfg(any(target_os = "windows", test))]
    pub fn windows_has_event_capacity(&self) -> bool {
        self.disk.events.len() < MAX_EVENTS
            || self
                .disk
                .events
                .values()
                .any(|record| record.stage == DeliveryStage::Acknowledged)
    }
    /// Reserve the attempt before touching the OS. A crash cannot repeatedly
    /// reset the short initial retry intervals.
    #[cfg(any(target_os = "windows", test))]
    pub fn begin_windows_presentation(
        &mut self,
        id: &str,
        now: u64,
    ) -> Result<windows_delivery::Retry, String> {
        let old = self
            .disk
            .events
            .get(id)
            .cloned()
            .ok_or("agent_event_missing")?;
        if old.os_accepted() || old.windows_retry.is_some_and(|retry| !retry.due(now)) {
            return Err("agent_presentation_not_due".into());
        }
        if !old
            .category
            .as_deref()
            .zip(old.deep_link.as_deref())
            .is_some_and(|(category, link)| valid_metadata(category, link))
        {
            return Err("agent_event_metadata_invalid".into());
        }
        let retry = windows_delivery::Retry::after_attempt(old.windows_retry, now);
        let old_phase = self.disk.windows_os_phase;
        let record = self.disk.events.get_mut(id).unwrap();
        record.stage = DeliveryStage::PresentationPending;
        record.windows_retry = Some(retry);
        // Keep an existing concrete OS failure visible during the next
        // attempt instead of flashing back to pending every few seconds.
        if !old_phase.is_some_and(windows_delivery::OsPhase::is_failure) {
            self.disk.windows_os_phase = Some(windows_delivery::OsPhase::Pending);
        }
        if let Err(error) = self.save() {
            self.disk.events.insert(id.into(), old);
            self.disk.windows_os_phase = old_phase;
            return Err(error);
        }
        Ok(retry)
    }
    #[cfg(any(target_os = "windows", test))]
    pub fn finish_windows_presentation(
        &mut self,
        id: &str,
        result: Result<(), &str>,
    ) -> Result<(), String> {
        let old = self
            .disk
            .events
            .get(id)
            .cloned()
            .ok_or("agent_event_missing")?;
        if old.stage != DeliveryStage::PresentationPending || old.windows_retry.is_none() {
            return Err("agent_presentation_not_started".into());
        }
        let old_phase = self.disk.windows_os_phase;
        let record = self.disk.events.get_mut(id).unwrap();
        match result {
            Ok(()) => {
                record.stage = DeliveryStage::OsAccepted;
                record.windows_retry = None;
                self.disk.windows_os_phase = Some(windows_delivery::OsPhase::Accepted);
            }
            Err(error) => {
                record.stage = DeliveryStage::PresentationUnknown;
                self.disk.windows_os_phase = Some(windows_delivery::OsPhase::from_error(error));
            }
        }
        if let Err(error) = self.save() {
            self.disk.events.insert(id.into(), old);
            self.disk.windows_os_phase = old_phase;
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
        self.event_with_windows_status(phase, id, None, None);
    }

    /// Windows supplies numeric OS status only. Never accept free-form error
    /// descriptions: those can contain user paths or notification content.
    pub fn event_with_windows_status(
        &self,
        phase: &'static str,
        id: Option<&str>,
        hresult: Option<i32>,
        setting: Option<i32>,
    ) {
        self.write_event(phase, id, hresult, setting, None);
    }

    #[cfg(any(target_os = "windows", test))]
    pub fn event_with_retry(&self, id: &str, retry: windows_delivery::Retry) {
        if retry.valid() {
            self.write_event("os_retry_scheduled", Some(id), None, None, Some(retry));
        }
    }

    fn write_event(
        &self,
        phase: &'static str,
        id: Option<&str>,
        hresult: Option<i32>,
        setting: Option<i32>,
        retry: Option<windows_delivery::Retry>,
    ) {
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
        if let Some(hresult) = hresult {
            line["windowsHresult"] = hresult.into();
        }
        if let Some(setting) = setting {
            line["notificationSetting"] = setting.into();
        }
        if let Some(retry) = retry {
            line["attempt"] = retry.attempts.into();
            line["retryAfter"] = retry.next_attempt_at.into();
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
    fn windows_status_logging_keeps_only_numeric_codes_and_opaque_correlation() {
        let dir = directory();
        let log = AgentLog::new(&dir);
        log.event_with_windows_status("os_failed", Some(&id()), Some(-2147024891), Some(1));
        log.event_with_windows_status("secret=value", None, Some(1), None);
        log.event_with_windows_status("os_failed", Some("wallet address"), Some(1), None);
        let lines = fs::read_to_string(dir.join("agent.log")).unwrap();
        assert_eq!(lines.lines().count(), 1);
        let value: serde_json::Value = serde_json::from_str(lines.trim()).unwrap();
        assert_eq!(value.as_object().unwrap().len(), 5);
        assert_eq!(value["phase"], "os_failed");
        assert_eq!(value["windowsHresult"], -2147024891_i32);
        assert_eq!(value["notificationSetting"], 1);
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

    fn windows_test_event(journal: &mut Journal) {
        journal
            .receive_event(
                &id(),
                "monero.fast_wallet.test",
                "tex8://notification/test",
                100,
            )
            .unwrap();
    }

    #[test]
    fn windows_os_failure_defers_locally_and_never_acknowledges_the_event() {
        use windows_delivery::PresentationOutcome;
        let dir = directory();
        let mut journal = Journal::open(&dir).unwrap();
        windows_test_event(&mut journal);
        let outcome = journal
            .present_windows(&id(), 100, |phase| {
                assert_eq!(phase, Some("presentation_pending"));
                Err("os_setting_unavailable".into())
            })
            .unwrap();
        assert_eq!(
            outcome,
            PresentationOutcome::Retry(windows_delivery::Retry {
                attempts: 1,
                next_attempt_at: 101
            })
        );
        assert_eq!(journal.windows_os_phase(), Some("os_setting_unavailable"));
        let ack_called = std::cell::Cell::new(false);
        assert!(journal
            .acknowledge_windows(&id(), || {
                ack_called.set(true);
                Ok(())
            })
            .is_err());
        assert!(!ack_called.get());
        assert!(!journal.disk.events[&id()].os_accepted());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn windows_replay_and_restart_preserve_retry_deadline_and_os_failure() {
        use windows_delivery::PresentationOutcome;
        let dir = directory();
        let mut journal = Journal::open(&dir).unwrap();
        windows_test_event(&mut journal);
        journal
            .present_windows(&id(), 100, |_| Err("os_disabled_for_application".into()))
            .unwrap();
        drop(journal);
        let mut journal = Journal::open(&dir).unwrap();
        let replay = journal
            .receive_event(
                &id(),
                "monero.fast_wallet.test",
                "tex8://notification/test",
                101,
            )
            .unwrap();
        assert_eq!(replay.received_at, 100);
        assert_eq!(replay.windows_retry.unwrap().attempts, 1);
        assert_eq!(
            journal.windows_os_phase(),
            Some("os_disabled_for_application")
        );
        let mut authenticated = std::collections::BTreeSet::new();
        assert!(journal
            .next_windows_presentation(&authenticated, 101)
            .is_none());
        authenticated.insert(id());
        assert!(journal
            .next_windows_presentation(&authenticated, 100)
            .is_none());
        assert!(journal
            .next_windows_presentation(&authenticated, 101)
            .is_some());
        assert_eq!(
            journal
                .present_windows(&id(), 100, |_| panic!("not due"))
                .unwrap(),
            PresentationOutcome::Deferred
        );
        let outcome = journal
            .present_windows(&id(), 101, |phase| {
                // Retrying does not flash the concrete OS error back to pending.
                assert_eq!(phase, Some("os_disabled_for_application"));
                Err("os_disabled_for_application".into())
            })
            .unwrap();
        assert_eq!(
            outcome,
            PresentationOutcome::Retry(windows_delivery::Retry {
                attempts: 2,
                next_attempt_at: 103
            })
        );
        drop(journal);
        let journal = Journal::open(&dir).unwrap();
        assert_eq!(
            journal.disk.events[&id()]
                .windows_retry
                .unwrap()
                .next_attempt_at,
            103
        );
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn windows_failed_ack_after_os_acceptance_retries_only_the_ack() {
        use windows_delivery::PresentationOutcome;
        let dir = directory();
        let mut journal = Journal::open(&dir).unwrap();
        windows_test_event(&mut journal);
        assert_eq!(
            journal.present_windows(&id(), 100, |_| Ok(())).unwrap(),
            PresentationOutcome::Accepted
        );
        assert!(journal
            .acknowledge_windows(&id(), || Err("transport interrupted".into()))
            .is_err());
        assert_eq!(journal.disk.events[&id()].stage, DeliveryStage::OsAccepted);
        drop(journal);
        let mut journal = Journal::open(&dir).unwrap();
        assert_eq!(
            journal
                .present_windows(&id(), 200, |_| panic!(
                    "accepted toast must never be shown again"
                ))
                .unwrap(),
            PresentationOutcome::AlreadyAccepted
        );
        let acknowledgements = std::cell::Cell::new(0);
        journal
            .acknowledge_windows(&id(), || {
                acknowledgements.set(acknowledgements.get() + 1);
                Ok(())
            })
            .unwrap();
        assert_eq!(acknowledgements.get(), 1);
        assert_eq!(
            journal.disk.events[&id()].stage,
            DeliveryStage::Acknowledged
        );
        assert_eq!(journal.windows_os_phase(), Some("os_accepted"));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn windows_crash_after_attempt_reservation_cannot_reset_the_budget() {
        use windows_delivery::PresentationOutcome;
        let dir = directory();
        let mut journal = Journal::open(&dir).unwrap();
        windows_test_event(&mut journal);
        journal.begin_windows_presentation(&id(), 100).unwrap();
        drop(journal); // crash between the durable reservation and OS return
        let mut journal = Journal::open(&dir).unwrap();
        // A read-only activation leaves a possibly still-running OS call
        // alone. Only the next exclusive agent startup performs recovery.
        assert_eq!(
            journal.disk.events[&id()].stage,
            DeliveryStage::PresentationPending
        );
        assert_eq!(journal.recover_windows_pending().unwrap(), vec![id()]);
        assert_eq!(
            journal.disk.events[&id()].stage,
            DeliveryStage::PresentationUnknown
        );
        assert_eq!(journal.windows_os_phase(), Some("presentation_unknown"));
        assert_eq!(
            journal
                .present_windows(&id(), 100, |_| panic!("deadline survives restart"))
                .unwrap(),
            PresentationOutcome::Deferred
        );
        let outcome = journal
            .present_windows(&id(), 101, |_| Err("arbitrary private OS error".into()))
            .unwrap();
        assert_eq!(
            outcome,
            PresentationOutcome::Retry(windows_delivery::Retry {
                attempts: 2,
                next_attempt_at: 103
            })
        );
        assert_eq!(journal.windows_os_phase(), Some("presentation_unknown"));
        let raw = fs::read_to_string(dir.join("agent-state.json")).unwrap();
        assert!(!raw.contains("arbitrary private OS error"));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn windows_disable_clears_status_without_resetting_a_failed_event_budget() {
        let dir = directory();
        let mut journal = Journal::open(&dir).unwrap();
        windows_test_event(&mut journal);
        journal
            .present_windows(&id(), 100, |_| Err("os_setting_unavailable".into()))
            .unwrap();
        journal.clear_windows_os_phase().unwrap();
        drop(journal);
        let journal = Journal::open(&dir).unwrap();
        assert_eq!(journal.windows_os_phase(), None);
        assert_eq!(
            journal.disk.events[&id()]
                .windows_retry
                .unwrap()
                .next_attempt_at,
            101
        );
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn windows_retry_reservation_must_be_durable_before_touching_the_os() {
        let dir = directory();
        let mut journal = Journal::open(&dir).unwrap();
        windows_test_event(&mut journal);
        journal.path = dir.join("missing-parent").join("state.json");
        let called = std::cell::Cell::new(false);
        assert!(journal
            .present_windows(&id(), 100, |_| {
                called.set(true);
                Ok(())
            })
            .is_err());
        assert!(!called.get());
        assert_eq!(journal.disk.events[&id()].stage, DeliveryStage::Received);
        assert_eq!(journal.disk.events[&id()].windows_retry, None);
        assert_eq!(journal.windows_os_phase(), None);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn windows_retry_logs_have_only_bounded_numeric_details_and_opaque_ids() {
        let dir = directory();
        let log = AgentLog::new(&dir);
        log.event_with_retry(
            &id(),
            windows_delivery::Retry {
                attempts: 2,
                next_attempt_at: 103,
            },
        );
        log.event_with_retry(
            "PRIVATE_TOKEN",
            windows_delivery::Retry {
                attempts: 2,
                next_attempt_at: 103,
            },
        );
        log.event_with_retry(
            &id(),
            windows_delivery::Retry {
                attempts: 0,
                next_attempt_at: 103,
            },
        );
        let lines = fs::read_to_string(dir.join("agent.log")).unwrap();
        assert_eq!(lines.lines().count(), 1);
        let line: serde_json::Value = serde_json::from_str(lines.trim()).unwrap();
        assert_eq!(line["phase"], "os_retry_scheduled");
        assert_eq!(line["eventId"], id());
        assert_eq!(line["attempt"], 2);
        assert_eq!(line["retryAfter"], 103);
        assert!(!lines.contains("PRIVATE_TOKEN"));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn optional_windows_metadata_preserves_legacy_serialization_and_storage_bound() {
        let dir = directory();
        let mut journal = Journal::open(&dir).unwrap();
        windows_test_event(&mut journal);
        let legacy = fs::read_to_string(dir.join("agent-state.json")).unwrap();
        assert!(!legacy.contains("windowsRetry"));
        assert!(!legacy.contains("windowsOsPhase"));
        journal.disk.events.clear();
        for index in 0..MAX_EVENTS {
            journal.disk.events.insert(
                format!("evt_{index:064x}"),
                DeliveryRecord {
                    stage: DeliveryStage::PresentationUnknown,
                    received_at: u64::MAX,
                    category: Some("monero.fast_wallet.vanity".into()),
                    deep_link: Some(
                        "mfw://vanity/order/00000000-0000-0000-0000-000000000000".into(),
                    ),
                    windows_retry: Some(windows_delivery::Retry {
                        attempts: u16::MAX,
                        next_attempt_at: u64::MAX,
                    }),
                },
            );
        }
        journal.disk.windows_os_phase = Some(windows_delivery::OsPhase::DisabledByGroupPolicy);
        journal.save().unwrap();
        assert!(fs::metadata(dir.join("agent-state.json")).unwrap().len() <= 256 * 1024);
        let mut journal = Journal::open(&dir).unwrap();
        assert_eq!(journal.disk.events.len(), MAX_EVENTS);
        assert!(!journal.windows_has_event_capacity());
        let new_id = format!("evt_{:064x}", MAX_EVENTS);
        assert!(journal
            .receive_event(
                &new_id,
                "monero.fast_wallet.test",
                "tex8://notification/test",
                100
            )
            .is_err());
        assert_eq!(journal.disk.events.len(), MAX_EVENTS);
        assert!(!journal.disk.events.contains_key(&new_id));
        let drained = format!("evt_{:064x}", 0);
        assert_eq!(
            journal
                .present_windows(&drained, u64::MAX, |_| Ok(()))
                .unwrap(),
            windows_delivery::PresentationOutcome::Accepted
        );
        // Merely handing a toast to the OS cannot release the durable slot.
        assert!(!journal.windows_has_event_capacity());
        assert!(journal
            .acknowledge_windows(&drained, || Err("network interrupted".into()))
            .is_err());
        assert!(!journal.windows_has_event_capacity());
        journal.acknowledge_windows(&drained, || Ok(())).unwrap();
        assert!(journal.windows_has_event_capacity());
        journal
            .receive_event(
                &new_id,
                "monero.fast_wallet.test",
                "tex8://notification/test",
                100,
            )
            .unwrap();
        assert_eq!(journal.disk.events.len(), MAX_EVENTS);
        assert!(journal.disk.events.contains_key(&new_id));
        assert!(!journal.disk.events.contains_key(&drained));
        let _ = fs::remove_dir_all(dir);
    }
}
