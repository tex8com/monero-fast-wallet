use community_chat_report_core::ChatReportStore;
use community_notification_core::{
    CommunityNotification, DeliveryTarget, NotificationStore, ProviderDelivery,
    ProviderDeliveryResult, TargetKind,
};
use community_publication_core::{PublicationStore, ScheduledAction};
use rusqlite::{params, Connection};
use std::{
    collections::HashSet,
    path::Path,
    sync::{Arc, Mutex},
    time::Duration,
};

const OPERATIONS_ACTOR: &str = "community-provider-dispatcher";
const FAILED_ATTEMPT_BACKOFF: Duration = Duration::from_secs(60);
const COMPLETED_DELIVERY_RETENTION_MS: u64 = 30 * 24 * 60 * 60 * 1_000;
const MODERATION_OVERDUE_MS: u64 = 30 * 60 * 1_000;

pub struct OperationsRunner {
    publication: Arc<PublicationStore>,
    chat_reports: Option<Arc<ChatReportStore>>,
    notifications: Arc<NotificationStore>,
    delivery: Arc<dyn ProviderDelivery>,
    jobs: OperationStore,
}

#[derive(Clone, Copy)]
enum DeliveryAcknowledgement {
    None,
    Publication,
    ChatReport,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct RunStats {
    pub actions: usize,
    pub provider_attempts: usize,
    pub delivered: usize,
    pub invalid_tokens: usize,
    pub deferred: usize,
    pub acknowledged: usize,
    pub missing_administrator: usize,
}

impl OperationsRunner {
    pub fn open(
        operation_db: impl AsRef<Path>,
        publication: Arc<PublicationStore>,
        notifications: Arc<NotificationStore>,
        delivery: Arc<dyn ProviderDelivery>,
    ) -> Result<Self, String> {
        Ok(Self {
            publication,
            chat_reports: None,
            notifications,
            delivery,
            jobs: OperationStore::open(operation_db)?,
        })
    }

    pub fn open_with_chat_reports(
        operation_db: impl AsRef<Path>,
        publication: Arc<PublicationStore>,
        chat_reports: Arc<ChatReportStore>,
        notifications: Arc<NotificationStore>,
        delivery: Arc<dyn ProviderDelivery>,
    ) -> Result<Self, String> {
        Ok(Self {
            publication,
            chat_reports: Some(chat_reports),
            notifications,
            delivery,
            jobs: OperationStore::open(operation_db)?,
        })
    }

    pub fn run_once(&self, now_ms: u64) -> Result<RunStats, String> {
        self.jobs
            .cleanup_completed(now_ms.saturating_sub(COMPLETED_DELIVERY_RETENTION_MS))?;
        let actions = self
            .publication
            .run_scheduled(now_ms)
            .map_err(|error| error.to_string())?;
        let mut stats = RunStats {
            actions: actions.len(),
            ..RunStats::default()
        };
        for action in actions {
            self.dispatch_action(action, now_ms, &mut stats)?;
        }
        if let Some(chat_reports) = &self.chat_reports {
            let cases = chat_reports.queue(100).map_err(|error| error.to_string())?;
            stats.actions += cases.len();
            for case in cases {
                self.dispatch_chat_report(
                    &format!("chat-report-alert:{}", case.case_id),
                    false,
                    now_ms,
                    &mut stats,
                )?;
                if case.acknowledged_at_ms.is_none()
                    && now_ms.saturating_sub(case.created_at_ms) >= MODERATION_OVERDUE_MS
                {
                    self.dispatch_chat_report(
                        &format!("chat-report-overdue:{}", case.case_id),
                        true,
                        now_ms,
                        &mut stats,
                    )?;
                }
            }
            let notices = chat_reports
                .claim_notices(now_ms, 100)
                .map_err(|error| error.to_string())?;
            stats.actions += notices.len();
            for notice in notices {
                let notification = CommunityNotification {
                    delivery_id: notice.delivery_id.clone(),
                    category: "tex8.community.moderation.outcome",
                    title: "Monero Enthusiast",
                    body: "A moderation decision is ready. Open the app to review it.",
                    deep_link: "monerofastwallet://community/moderation",
                };
                self.dispatch_notification(
                    &notice.delivery_id,
                    TargetKind::Identity,
                    Some(&notice.recipient_public_id),
                    &notification,
                    DeliveryAcknowledgement::ChatReport,
                    now_ms,
                    &mut stats,
                )?;
            }
        }
        Ok(stats)
    }

    fn dispatch_action(
        &self,
        action: ScheduledAction,
        now_ms: u64,
        stats: &mut RunStats,
    ) -> Result<(), String> {
        let Some((delivery_id, target_kind, target_id, notification)) =
            notification_for_action(&action)
        else {
            return Ok(());
        };
        self.dispatch_notification(
            &delivery_id,
            target_kind,
            target_id.as_deref(),
            &notification,
            DeliveryAcknowledgement::Publication,
            now_ms,
            stats,
        )
    }

    fn dispatch_chat_report(
        &self,
        delivery_id: &str,
        overdue: bool,
        now_ms: u64,
        stats: &mut RunStats,
    ) -> Result<(), String> {
        let notification = CommunityNotification {
            delivery_id: delivery_id.to_owned(),
            category: if overdue {
                "tex8.community.moderation.overdue"
            } else {
                "tex8.community.moderation.waiting"
            },
            title: "Monero Enthusiast",
            body: if overdue {
                "A moderation case needs attention."
            } else {
                "A moderation case is waiting."
            },
            deep_link: "monerofastwallet://moderation",
        };
        self.dispatch_notification(
            delivery_id,
            TargetKind::Administrator,
            None,
            &notification,
            DeliveryAcknowledgement::None,
            now_ms,
            stats,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn dispatch_notification(
        &self,
        delivery_id: &str,
        target_kind: TargetKind,
        target_id: Option<&str>,
        notification: &CommunityNotification,
        acknowledgement: DeliveryAcknowledgement,
        now_ms: u64,
        stats: &mut RunStats,
    ) -> Result<(), String> {
        let available = self
            .notifications
            .delivery_targets(target_kind, target_id)
            .map_err(|error| error.to_string())?;
        if available.is_empty() {
            if target_kind == TargetKind::Identity
                && !matches!(acknowledgement, DeliveryAcknowledgement::None)
            {
                self.acknowledge_delivery(acknowledgement, delivery_id, now_ms)?;
                stats.acknowledged += 1;
            } else {
                stats.missing_administrator += 1;
            }
            return Ok(());
        }

        self.jobs
            .prepare(delivery_id, target_kind, target_id, &available, now_ms)?;
        let pending = self.jobs.pending(delivery_id, now_ms)?;
        for job in pending {
            let current = self
                .notifications
                .delivery_targets(job.target_kind, Some(&job.target_id))
                .map_err(|error| error.to_string())?
                .into_iter()
                .find(|target| target.installation_id == job.installation_id);
            let Some(target) = current else {
                self.jobs
                    .complete(delivery_id, &job.target_id, &job.installation_id, "removed")?;
                continue;
            };
            stats.provider_attempts += 1;
            match self
                .delivery
                .deliver(target.provider, target.token.as_str(), notification)
            {
                Ok(ProviderDeliveryResult::Delivered) => {
                    self.jobs.complete(
                        delivery_id,
                        &target.target_id,
                        &target.installation_id,
                        "delivered",
                    )?;
                    stats.delivered += 1;
                }
                Ok(ProviderDeliveryResult::InvalidToken) => {
                    self.notifications
                        .disable(
                            target.target_kind,
                            &target.target_id,
                            &target.installation_id,
                        )
                        .map_err(|error| error.to_string())?;
                    self.jobs.complete(
                        delivery_id,
                        &target.target_id,
                        &target.installation_id,
                        "invalid",
                    )?;
                    stats.invalid_tokens += 1;
                }
                Ok(ProviderDeliveryResult::RetryAfter(delay)) => {
                    self.jobs.defer(
                        delivery_id,
                        &target.target_id,
                        &target.installation_id,
                        next_attempt_at(now_ms, delay),
                    )?;
                    stats.deferred += 1;
                }
                Err(_) => {
                    self.jobs.defer(
                        delivery_id,
                        &target.target_id,
                        &target.installation_id,
                        next_attempt_at(now_ms, FAILED_ATTEMPT_BACKOFF),
                    )?;
                    stats.deferred += 1;
                }
            }
        }

        if self.jobs.complete_delivery(delivery_id)?
            && !matches!(acknowledgement, DeliveryAcknowledgement::None)
        {
            self.acknowledge_delivery(acknowledgement, delivery_id, now_ms)?;
            stats.acknowledged += 1;
        }
        Ok(())
    }

    fn acknowledge_delivery(
        &self,
        acknowledgement: DeliveryAcknowledgement,
        delivery_id: &str,
        now_ms: u64,
    ) -> Result<(), String> {
        match acknowledgement {
            DeliveryAcknowledgement::None => Ok(()),
            DeliveryAcknowledgement::Publication => self
                .publication
                .acknowledge_scheduled_delivery(delivery_id, OPERATIONS_ACTOR, now_ms)
                .map_err(|error| error.to_string()),
            DeliveryAcknowledgement::ChatReport => self
                .chat_reports
                .as_ref()
                .ok_or_else(|| "chat report acknowledgement store is unavailable".to_owned())?
                .acknowledge_notice(delivery_id, OPERATIONS_ACTOR, now_ms)
                .map_err(|error| error.to_string()),
        }
    }
}

fn notification_for_action(
    action: &ScheduledAction,
) -> Option<(String, TargetKind, Option<String>, CommunityNotification)> {
    match action {
        ScheduledAction::ListingExpiryReminder {
            delivery_id,
            owner_public_id,
            ..
        } => Some((
            delivery_id.clone(),
            TargetKind::Identity,
            Some(owner_public_id.clone()),
            CommunityNotification {
                delivery_id: delivery_id.clone(),
                category: "tex8.community.listing.reminder",
                title: "Monero Enthusiast",
                body: "Your public entry expires soon. Open the app to review it.",
                deep_link: "monerofastwallet://community/my-content",
            },
        )),
        ScheduledAction::ModerationQueueAlert { delivery_id, .. } => Some((
            delivery_id.clone(),
            TargetKind::Administrator,
            None,
            CommunityNotification {
                delivery_id: delivery_id.clone(),
                category: "tex8.community.moderation.waiting",
                title: "Monero Enthusiast",
                body: "A moderation case is waiting.",
                deep_link: "monerofastwallet://moderation",
            },
        )),
        ScheduledAction::ModerationOverdue { delivery_id, .. } => Some((
            delivery_id.clone(),
            TargetKind::Administrator,
            None,
            CommunityNotification {
                delivery_id: delivery_id.clone(),
                category: "tex8.community.moderation.overdue",
                title: "Monero Enthusiast",
                body: "A moderation case needs attention.",
                deep_link: "monerofastwallet://moderation",
            },
        )),
        ScheduledAction::ModerationOutcomeNotice {
            delivery_id,
            recipient_public_id,
            ..
        } => Some((
            delivery_id.clone(),
            TargetKind::Identity,
            Some(recipient_public_id.clone()),
            CommunityNotification {
                delivery_id: delivery_id.clone(),
                category: "tex8.community.moderation.outcome",
                title: "Monero Enthusiast",
                body: "A moderation decision is ready. Open the app to review it.",
                deep_link: "monerofastwallet://community/moderation",
            },
        )),
        ScheduledAction::ListingExpired { .. } => None,
    }
}

struct OperationStore {
    connection: Mutex<Connection>,
}

#[derive(Clone)]
struct PendingJob {
    target_kind: TargetKind,
    target_id: String,
    installation_id: String,
}

impl OperationStore {
    fn open(path: impl AsRef<Path>) -> Result<Self, String> {
        let path = path.as_ref();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let connection = Connection::open(path).map_err(|error| error.to_string())?;
        connection
            .execute_batch(
                "
                PRAGMA trusted_schema = OFF;
                PRAGMA foreign_keys = ON;
                PRAGMA journal_mode = DELETE;
                CREATE TABLE IF NOT EXISTS delivery (
                    delivery_id TEXT PRIMARY KEY,
                    target_kind TEXT NOT NULL,
                    target_id TEXT,
                    created_at_ms INTEGER NOT NULL DEFAULT 0
                ) STRICT;
                CREATE TABLE IF NOT EXISTS delivery_target (
                    delivery_id TEXT NOT NULL,
                    target_kind TEXT NOT NULL,
                    target_id TEXT NOT NULL,
                    installation_id TEXT NOT NULL,
                    terminal_status TEXT,
                    next_attempt_at_ms INTEGER NOT NULL DEFAULT 0,
                    attempts INTEGER NOT NULL DEFAULT 0,
                    PRIMARY KEY(delivery_id, target_id, installation_id),
                    FOREIGN KEY(delivery_id) REFERENCES delivery(delivery_id)
                ) STRICT;
                ",
            )
            .map_err(|error| error.to_string())?;
        ensure_operation_column(
            &connection,
            "delivery_target",
            "next_attempt_at_ms",
            "INTEGER NOT NULL DEFAULT 0",
        )?;
        ensure_operation_column(
            &connection,
            "delivery_target",
            "attempts",
            "INTEGER NOT NULL DEFAULT 0",
        )?;
        migrate_delivery_target_primary_key(&connection)?;
        Ok(Self {
            connection: Mutex::new(connection),
        })
    }

    fn prepare(
        &self,
        delivery_id: &str,
        target_kind: TargetKind,
        target_id: Option<&str>,
        targets: &[DeliveryTarget],
        now_ms: u64,
    ) -> Result<(), String> {
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| "operations store lock was poisoned".to_owned())?;
        let transaction = connection
            .transaction()
            .map_err(|error| error.to_string())?;
        let inserted = transaction
            .execute(
                "INSERT INTO delivery(delivery_id, target_kind, target_id, created_at_ms)
                 VALUES (?1, ?2, ?3, ?4) ON CONFLICT(delivery_id) DO NOTHING",
                params![
                    delivery_id,
                    target_kind_name(target_kind),
                    target_id,
                    to_sql_i64(now_ms)?
                ],
            )
            .map_err(|error| error.to_string())?;
        if inserted == 1 {
            let mut unique = HashSet::new();
            for target in targets {
                if target.target_kind != target_kind
                    || target_id.is_some_and(|id| id != target.target_id)
                    || !unique.insert((target.target_id.clone(), target.installation_id.clone()))
                {
                    return Err("notification target snapshot is inconsistent".to_owned());
                }
                transaction
                    .execute(
                        "INSERT INTO delivery_target(
                            delivery_id, target_kind, target_id, installation_id
                         ) VALUES (?1, ?2, ?3, ?4)",
                        params![
                            delivery_id,
                            target_kind_name(target_kind),
                            target.target_id,
                            target.installation_id
                        ],
                    )
                    .map_err(|error| error.to_string())?;
            }
        }
        transaction.commit().map_err(|error| error.to_string())
    }

    fn pending(&self, delivery_id: &str, now_ms: u64) -> Result<Vec<PendingJob>, String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "operations store lock was poisoned".to_owned())?;
        let mut statement = connection
            .prepare(
                "SELECT target_kind, target_id, installation_id
                 FROM delivery_target
                 WHERE delivery_id = ?1 AND terminal_status IS NULL
                   AND next_attempt_at_ms <= ?2
                 ORDER BY target_id, installation_id",
            )
            .map_err(|error| error.to_string())?;
        let jobs = statement
            .query_map(params![delivery_id, to_sql_i64(now_ms)?], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(|error| error.to_string())?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        jobs.into_iter()
            .map(|(target_kind, target_id, installation_id)| {
                Ok(PendingJob {
                    target_kind: parse_target_kind(&target_kind)?,
                    target_id,
                    installation_id,
                })
            })
            .collect()
    }

    fn complete(
        &self,
        delivery_id: &str,
        target_id: &str,
        installation_id: &str,
        terminal_status: &str,
    ) -> Result<(), String> {
        if !matches!(terminal_status, "delivered" | "invalid" | "removed") {
            return Err("invalid delivery terminal status".to_owned());
        }
        let changed = self
            .connection
            .lock()
            .map_err(|_| "operations store lock was poisoned".to_owned())?
            .execute(
                "UPDATE delivery_target SET terminal_status = ?1
                 WHERE delivery_id = ?2 AND target_id = ?3 AND installation_id = ?4
                   AND terminal_status IS NULL",
                params![terminal_status, delivery_id, target_id, installation_id],
            )
            .map_err(|error| error.to_string())?;
        if changed != 1 {
            return Err("delivery target was not found".to_owned());
        }
        Ok(())
    }

    fn defer(
        &self,
        delivery_id: &str,
        target_id: &str,
        installation_id: &str,
        next_attempt_at_ms: u64,
    ) -> Result<(), String> {
        let changed = self
            .connection
            .lock()
            .map_err(|_| "operations store lock was poisoned".to_owned())?
            .execute(
                "UPDATE delivery_target
                 SET next_attempt_at_ms = ?1, attempts = attempts + 1
                 WHERE delivery_id = ?2 AND target_id = ?3 AND installation_id = ?4
                   AND terminal_status IS NULL",
                params![
                    to_sql_i64(next_attempt_at_ms)?,
                    delivery_id,
                    target_id,
                    installation_id
                ],
            )
            .map_err(|error| error.to_string())?;
        if changed != 1 {
            return Err("delivery target was not found".to_owned());
        }
        Ok(())
    }

    fn complete_delivery(&self, delivery_id: &str) -> Result<bool, String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "operations store lock was poisoned".to_owned())?;
        let (total, pending): (i64, i64) = connection
            .query_row(
                "SELECT COUNT(*),
                        COALESCE(SUM(CASE WHEN terminal_status IS NULL THEN 1 ELSE 0 END), 0)
                 FROM delivery_target WHERE delivery_id = ?1",
                [delivery_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(|error| error.to_string())?;
        Ok(total > 0 && pending == 0)
    }

    fn cleanup_completed(&self, before_ms: u64) -> Result<(), String> {
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| "operations store lock was poisoned".to_owned())?;
        let transaction = connection
            .transaction()
            .map_err(|error| error.to_string())?;
        transaction
            .execute(
                "DELETE FROM delivery_target
                 WHERE delivery_id IN (
                   SELECT delivery_id FROM delivery
                   WHERE created_at_ms < ?1
                     AND NOT EXISTS (
                       SELECT 1 FROM delivery_target
                       WHERE delivery_target.delivery_id = delivery.delivery_id
                         AND terminal_status IS NULL
                     )
                 )",
                [to_sql_i64(before_ms)?],
            )
            .map_err(|error| error.to_string())?;
        transaction
            .execute(
                "DELETE FROM delivery
                 WHERE created_at_ms < ?1
                   AND NOT EXISTS (
                     SELECT 1 FROM delivery_target
                     WHERE delivery_target.delivery_id = delivery.delivery_id
                   )",
                [to_sql_i64(before_ms)?],
            )
            .map_err(|error| error.to_string())?;
        transaction.commit().map_err(|error| error.to_string())
    }
}

fn next_attempt_at(now_ms: u64, delay: Duration) -> u64 {
    let delay_ms = u64::try_from(delay.as_millis()).unwrap_or(u64::MAX);
    now_ms.saturating_add(delay_ms.clamp(1_000, 60 * 60 * 1_000))
}

fn to_sql_i64(value: u64) -> Result<i64, String> {
    i64::try_from(value).map_err(|_| "operations timestamp is out of range".to_owned())
}

fn ensure_operation_column(
    connection: &Connection,
    table: &str,
    column: &str,
    declaration: &str,
) -> Result<(), String> {
    let mut statement = connection
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(|error| error.to_string())?;
    let names = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|error| error.to_string())?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    drop(statement);
    if !names.iter().any(|name| name == column) {
        connection
            .execute_batch(&format!(
                "ALTER TABLE {table} ADD COLUMN {column} {declaration};"
            ))
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn migrate_delivery_target_primary_key(connection: &Connection) -> Result<(), String> {
    let mut statement = connection
        .prepare("PRAGMA table_info(delivery_target)")
        .map_err(|error| error.to_string())?;
    let mut primary_key = statement
        .query_map([], |row| {
            Ok((row.get::<_, i64>(5)?, row.get::<_, String>(1)?))
        })
        .map_err(|error| error.to_string())?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?
        .into_iter()
        .filter(|(position, _)| *position > 0)
        .collect::<Vec<_>>();
    drop(statement);
    primary_key.sort_by_key(|(position, _)| *position);
    let primary_key = primary_key
        .into_iter()
        .map(|(_, name)| name)
        .collect::<Vec<_>>();
    if primary_key == ["delivery_id", "target_id", "installation_id"] {
        return Ok(());
    }
    connection
        .execute_batch(
            "
            PRAGMA foreign_keys = OFF;
            BEGIN IMMEDIATE;
            ALTER TABLE delivery_target RENAME TO delivery_target_legacy;
            CREATE TABLE delivery_target (
                delivery_id TEXT NOT NULL,
                target_kind TEXT NOT NULL,
                target_id TEXT NOT NULL,
                installation_id TEXT NOT NULL,
                terminal_status TEXT,
                next_attempt_at_ms INTEGER NOT NULL DEFAULT 0,
                attempts INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY(delivery_id, target_id, installation_id),
                FOREIGN KEY(delivery_id) REFERENCES delivery(delivery_id)
            ) STRICT;
            INSERT OR IGNORE INTO delivery_target(
                delivery_id, target_kind, target_id, installation_id,
                terminal_status, next_attempt_at_ms, attempts
            )
            SELECT delivery_id, target_kind, target_id, installation_id,
                   terminal_status, next_attempt_at_ms, attempts
            FROM delivery_target_legacy;
            DROP TABLE delivery_target_legacy;
            COMMIT;
            PRAGMA foreign_keys = ON;
            ",
        )
        .map_err(|error| error.to_string())
}

fn target_kind_name(kind: TargetKind) -> &'static str {
    match kind {
        TargetKind::Identity => "identity",
        TargetKind::Administrator => "administrator",
    }
}

fn parse_target_kind(value: &str) -> Result<TargetKind, String> {
    match value {
        "identity" => Ok(TargetKind::Identity),
        "administrator" => Ok(TargetKind::Administrator),
        _ => Err("operations store contains an unknown target kind".to_owned()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use community_chat_report_core::{SelectedChatMessage, VoluntaryChatReport};
    use community_notification_core::{ProviderDeliveryResult, ProviderKind};
    use community_publication_core::{
        PublicContentDraft, PublicContentKind, ScreeningAssessment, ScreeningOutcome,
    };
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Mutex as StdMutex,
    };

    const NOW: u64 = 2_000_000_000_000;

    #[derive(Default)]
    struct RecordingDelivery {
        events: StdMutex<Vec<CommunityNotification>>,
    }

    impl ProviderDelivery for RecordingDelivery {
        fn deliver(
            &self,
            _provider: ProviderKind,
            _token: &str,
            notification: &CommunityNotification,
        ) -> Result<ProviderDeliveryResult, String> {
            self.events.lock().unwrap().push(notification.clone());
            Ok(ProviderDeliveryResult::Delivered)
        }
    }

    struct RetryOnceDelivery {
        attempts: AtomicUsize,
    }

    impl ProviderDelivery for RetryOnceDelivery {
        fn deliver(
            &self,
            _provider: ProviderKind,
            _token: &str,
            _notification: &CommunityNotification,
        ) -> Result<ProviderDeliveryResult, String> {
            if self.attempts.fetch_add(1, Ordering::SeqCst) == 0 {
                Ok(ProviderDeliveryResult::RetryAfter(Duration::from_secs(
                    10 * 60,
                )))
            } else {
                Ok(ProviderDeliveryResult::Delivered)
            }
        }
    }

    fn draft() -> PublicContentDraft {
        PublicContentDraft {
            kind: PublicContentKind::Profile,
            title: "Alice".to_owned(),
            summary: "Privacy-friendly software developer.".to_owned(),
            roles: vec!["developer".to_owned()],
            categories: vec!["software".to_owned()],
            languages: vec!["en".to_owned()],
            coarse_region: None,
            radius_km: None,
            media: Vec::new(),
        }
    }

    #[test]
    fn generic_moderation_push_is_durable_and_contains_no_case_content() {
        let directory = tempfile::tempdir().unwrap();
        let publication = Arc::new(PublicationStore::in_memory([7u8; 32]).unwrap());
        let notifications = Arc::new(NotificationStore::in_memory([8u8; 32]).unwrap());
        notifications
            .register_administrator(
                "primary-moderator",
                "admin-phone",
                ProviderKind::Apns,
                &"ab".repeat(32),
                NOW,
            )
            .unwrap();
        let submitted = publication.submit("person_alice", draft(), NOW).unwrap();
        publication
            .record_screening(
                &submitted.public_id,
                submitted.revision,
                &ScreeningAssessment {
                    model_version: "policy-v1".to_owned(),
                    rules_version: "rules-v1".to_owned(),
                    confidence: 0.7,
                    triggered_policy: "ambiguous".to_owned(),
                    outcome: ScreeningOutcome::Ambiguous,
                    optional_wording_suggestion: None,
                },
                NOW + 1,
            )
            .unwrap();
        let delivery = Arc::new(RecordingDelivery::default());
        let runner = OperationsRunner::open(
            directory.path().join("operations.sqlite3"),
            publication,
            notifications,
            delivery.clone(),
        )
        .unwrap();
        let stats = runner.run_once(NOW + 2).unwrap();
        assert_eq!(stats.delivered, 1);
        assert_eq!(stats.acknowledged, 1);
        assert_eq!(runner.run_once(NOW + 10 * 60_000).unwrap().actions, 0);
        let events = delivery.events.lock().unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].body, "A moderation case is waiting.");
        assert!(!events[0].body.contains("Alice"));
        assert!(!events[0].body.contains(&submitted.public_id));
    }

    #[test]
    fn provider_retry_delay_is_persisted_and_not_hammered() {
        let directory = tempfile::tempdir().unwrap();
        let publication = Arc::new(PublicationStore::in_memory([9u8; 32]).unwrap());
        let notifications = Arc::new(NotificationStore::in_memory([10u8; 32]).unwrap());
        notifications
            .register_administrator(
                "primary-moderator",
                "admin-phone",
                ProviderKind::Apns,
                &"ab".repeat(32),
                NOW,
            )
            .unwrap();
        let submitted = publication.submit("person_alice", draft(), NOW).unwrap();
        publication
            .record_screening(
                &submitted.public_id,
                submitted.revision,
                &ScreeningAssessment {
                    model_version: "policy-v1".to_owned(),
                    rules_version: "rules-v1".to_owned(),
                    confidence: 0.7,
                    triggered_policy: "ambiguous".to_owned(),
                    outcome: ScreeningOutcome::Ambiguous,
                    optional_wording_suggestion: None,
                },
                NOW + 1,
            )
            .unwrap();
        let delivery = Arc::new(RetryOnceDelivery {
            attempts: AtomicUsize::new(0),
        });
        let runner = OperationsRunner::open(
            directory.path().join("operations.sqlite3"),
            publication,
            notifications,
            delivery.clone(),
        )
        .unwrap();

        let first = runner.run_once(NOW + 2).unwrap();
        assert_eq!(first.provider_attempts, 1);
        assert_eq!(first.deferred, 1);
        let before_retry = runner.run_once(NOW + 5 * 60_000 + 3).unwrap();
        assert_eq!(before_retry.provider_attempts, 0);
        assert_eq!(delivery.attempts.load(Ordering::SeqCst), 1);
        let after_retry = runner.run_once(NOW + 10 * 60_000 + 3).unwrap();
        assert_eq!(after_retry.delivered, 1);
        assert_eq!(after_retry.acknowledged, 1);
        assert_eq!(delivery.attempts.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn administrator_installation_ids_are_scoped_to_each_administrator() {
        let directory = tempfile::tempdir().unwrap();
        let publication = Arc::new(PublicationStore::in_memory([11u8; 32]).unwrap());
        let notifications = Arc::new(NotificationStore::in_memory([12u8; 32]).unwrap());
        for (administrator, token) in [
            ("primary-moderator", "ab".repeat(32)),
            ("backup-moderator", "cd".repeat(32)),
        ] {
            notifications
                .register_administrator(
                    administrator,
                    "shared-installation-name",
                    ProviderKind::Apns,
                    &token,
                    NOW,
                )
                .unwrap();
        }
        let submitted = publication.submit("person_alice", draft(), NOW).unwrap();
        publication
            .record_screening(
                &submitted.public_id,
                submitted.revision,
                &ScreeningAssessment {
                    model_version: "policy-v1".to_owned(),
                    rules_version: "rules-v1".to_owned(),
                    confidence: 0.7,
                    triggered_policy: "ambiguous".to_owned(),
                    outcome: ScreeningOutcome::Ambiguous,
                    optional_wording_suggestion: None,
                },
                NOW + 1,
            )
            .unwrap();
        let delivery = Arc::new(RecordingDelivery::default());
        let runner = OperationsRunner::open(
            directory.path().join("operations.sqlite3"),
            publication,
            notifications,
            delivery.clone(),
        )
        .unwrap();

        let stats = runner.run_once(NOW + 2).unwrap();
        assert_eq!(stats.delivered, 2);
        assert_eq!(stats.acknowledged, 1);
        assert_eq!(delivery.events.lock().unwrap().len(), 2);
    }

    #[test]
    fn selected_chat_report_sends_only_one_generic_durable_alert() {
        let directory = tempfile::tempdir().unwrap();
        let publication = Arc::new(PublicationStore::in_memory([13u8; 32]).unwrap());
        let chat_reports = Arc::new(ChatReportStore::in_memory([14u8; 32]).unwrap());
        let notifications = Arc::new(NotificationStore::in_memory([15u8; 32]).unwrap());
        notifications
            .register_administrator(
                "primary-moderator",
                "admin-phone",
                ProviderKind::Apns,
                &"ef".repeat(32),
                NOW,
            )
            .unwrap();
        chat_reports
            .submit(
                "person_alice",
                "person_bob",
                &VoluntaryChatReport {
                    selected_message: SelectedChatMessage {
                        room_id: "!private:matrix.example".to_owned(),
                        event_id: "$selected:matrix.example".to_owned(),
                        sender_id: "@person_bob:matrix.example".to_owned(),
                        body: "Sensitive selected evidence".to_owned(),
                        timestamp_ms: NOW,
                    },
                    reason: "Threatening message".to_owned(),
                    illegal_content_notice: false,
                    confirmed_exact_message: true,
                },
                NOW,
            )
            .unwrap();
        let delivery = Arc::new(RecordingDelivery::default());
        let runner = OperationsRunner::open_with_chat_reports(
            directory.path().join("operations.sqlite3"),
            publication,
            chat_reports,
            notifications,
            delivery.clone(),
        )
        .unwrap();

        let first = runner.run_once(NOW + 1).unwrap();
        assert_eq!(first.delivered, 1);
        let second = runner.run_once(NOW + 2).unwrap();
        assert_eq!(second.provider_attempts, 0);
        let events = delivery.events.lock().unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].body, "A moderation case is waiting.");
        assert!(!events[0].body.contains("Sensitive"));
        assert!(!events[0].body.contains("Threatening"));
        assert!(!events[0].body.contains("person_bob"));
    }

    #[test]
    fn chat_decision_notifies_both_parties_once_without_evidence() {
        let directory = tempfile::tempdir().unwrap();
        let publication = Arc::new(PublicationStore::in_memory([16u8; 32]).unwrap());
        let chat_reports = Arc::new(ChatReportStore::in_memory([17u8; 32]).unwrap());
        let notifications = Arc::new(NotificationStore::in_memory([18u8; 32]).unwrap());
        for (identity, installation, token) in [
            ("person_alice", "alice-phone", "aa".repeat(32)),
            ("person_bob", "bob-phone", "bb".repeat(32)),
        ] {
            notifications
                .register_identity(identity, installation, ProviderKind::Apns, &token, NOW)
                .unwrap();
        }
        let receipt = chat_reports
            .submit(
                "person_alice",
                "person_bob",
                &VoluntaryChatReport {
                    selected_message: SelectedChatMessage {
                        room_id: "!private:matrix.example".to_owned(),
                        event_id: "$selected:matrix.example".to_owned(),
                        sender_id: "@person_bob:matrix.example".to_owned(),
                        body: "Sensitive selected evidence".to_owned(),
                        timestamp_ms: NOW,
                    },
                    reason: "Threatening message".to_owned(),
                    illegal_content_notice: false,
                    confirmed_exact_message: true,
                },
                NOW,
            )
            .unwrap();
        chat_reports
            .decide(
                &receipt.case_id,
                "moderator-one",
                community_chat_report_core::ChatReportDecision::WarnSender,
                "A warning was recorded.",
                NOW + 1,
            )
            .unwrap();
        let delivery = Arc::new(RecordingDelivery::default());
        let runner = OperationsRunner::open_with_chat_reports(
            directory.path().join("operations.sqlite3"),
            publication,
            chat_reports,
            notifications,
            delivery.clone(),
        )
        .unwrap();

        let first = runner.run_once(NOW + 2).unwrap();
        assert_eq!(first.delivered, 2);
        assert_eq!(first.acknowledged, 2);
        assert_eq!(runner.run_once(NOW + 3).unwrap().provider_attempts, 0);
        let events = delivery.events.lock().unwrap();
        assert_eq!(events.len(), 2);
        assert!(events.iter().all(
            |event| event.body == "A moderation decision is ready. Open the app to review it."
        ));
        let encoded = events
            .iter()
            .flat_map(|event| {
                [
                    event.delivery_id.as_str(),
                    event.category,
                    event.title,
                    event.body,
                    event.deep_link,
                ]
            })
            .collect::<Vec<_>>()
            .join("|");
        assert!(!encoded.contains("Sensitive selected evidence"));
        assert!(!encoded.contains("Threatening message"));
        assert!(!encoded.contains("A warning was recorded."));
        assert!(!encoded.contains("person_alice"));
        assert!(!encoded.contains("person_bob"));
    }
}
