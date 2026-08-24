use std::sync::{Arc, Mutex};

use anyhow::{anyhow, Context, Result};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::Serialize;
use sha2::Digest;

#[derive(Clone)]
pub struct Database {
    connection: Arc<Mutex<Connection>>,
}

#[derive(Clone, Debug)]
pub struct NewOrder {
    pub id: String,
    pub public_address: String,
    pub prefixes: Vec<String>,
    pub price_atomic: u64,
    pub list_price_atomic: u64,
    pub discount_atomic: u64,
    pub payment_id: String,
    pub payment_address: String,
    pub created_at: i64,
    pub quote_expires_at: i64,
    pub required_confirmations: u64,
    pub status_token_hash: String,
    pub notification_installation_id: Option<String>,
    pub notification_platform: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct OrderRecord {
    pub id: String,
    pub status: String,
    pub network: String,
    pub public_address: String,
    pub prefixes: Vec<String>,
    #[serde(serialize_with = "serialize_u64_as_string")]
    pub price_atomic: u64,
    #[serde(serialize_with = "serialize_u64_as_string")]
    pub list_price_atomic: u64,
    #[serde(serialize_with = "serialize_u64_as_string")]
    pub discount_atomic: u64,
    pub payment_id: String,
    pub payment_address: String,
    pub created_at: i64,
    pub quote_expires_at: i64,
    pub required_confirmations: u64,
    #[serde(serialize_with = "serialize_u64_as_string")]
    pub observed_atomic: u64,
    pub payment_txid: Option<String>,
    pub payment_height: Option<u64>,
    pub confirmations: u64,
    pub paid_at: Option<i64>,
    pub updated_at: i64,
    pub notification_installation_id: Option<String>,
    pub notification_platform: Option<String>,
}

#[derive(Clone, Debug)]
pub struct PaymentObservation {
    pub payment_id: String,
    pub tx_hash: String,
    pub amount_atomic: u64,
    pub block_height: u64,
    pub confirmations: u64,
    pub unlocked: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct JobRecord {
    pub id: String,
    pub prefix: String,
    pub status: String,
    pub result_address: Option<String>,
    pub result_key_offset: Option<String>,
    pub error: Option<String>,
    pub search_expires_at: Option<i64>,
    pub result_guaranteed: bool,
    pub non_refundable_after_start: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct SearchGroupRecord {
    pub id: String,
    pub status: String,
    pub prefix_length: usize,
    pub prefixes: Vec<String>,
    #[serde(serialize_with = "serialize_u64_as_string")]
    pub price_atomic: u64,
    pub created_at: i64,
    pub started_at: Option<i64>,
    pub search_expires_at: Option<i64>,
    pub completed_at: Option<i64>,
    pub matched_prefix: Option<String>,
    pub result_address: Option<String>,
    pub result_key_offset: Option<String>,
    pub maximum_search_seconds: u64,
    pub candidates: Vec<JobRecord>,
}

#[derive(Clone, Debug)]
pub struct PendingNotification {
    pub id: String,
    pub order_id: String,
    pub installation_id: String,
    pub platform: String,
    pub category: String,
    pub deep_link: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct ActiveCandidate {
    pub id: String,
    pub group_id: String,
    pub order_id: String,
    pub prefix: String,
    pub public_address: String,
    pub search_expires_at: i64,
}

impl Database {
    pub fn open(path: &std::path::Path) -> Result<Self> {
        if let Some(parent) = path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
        {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("create database directory {}", parent.display()))?;
        }
        let connection = Connection::open(path)
            .with_context(|| format!("open SQLite database {}", path.display()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
                .with_context(|| format!("protect SQLite database {}", path.display()))?;
        }
        connection.pragma_update(None, "journal_mode", "WAL")?;
        Self::from_connection(connection)
    }

    pub fn in_memory() -> Result<Self> {
        Self::from_connection(Connection::open_in_memory()?)
    }

    fn from_connection(connection: Connection) -> Result<Self> {
        connection.pragma_update(None, "foreign_keys", "ON")?;
        connection.busy_timeout(std::time::Duration::from_secs(5))?;
        connection.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS orders (
                id TEXT PRIMARY KEY,
                status TEXT NOT NULL,
                network TEXT NOT NULL CHECK (network = 'mainnet'),
                public_address TEXT NOT NULL,
                prefixes_json TEXT NOT NULL,
                price_atomic TEXT NOT NULL,
                payment_id TEXT NOT NULL UNIQUE,
                payment_address TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                quote_expires_at INTEGER NOT NULL,
                required_confirmations INTEGER NOT NULL,
                observed_atomic TEXT NOT NULL DEFAULT '0',
                payment_txid TEXT,
                payment_height INTEGER,
                confirmations INTEGER NOT NULL DEFAULT 0,
                paid_at INTEGER,
                updated_at INTEGER NOT NULL
                ,list_price_atomic TEXT NOT NULL DEFAULT '0'
                ,discount_atomic TEXT NOT NULL DEFAULT '0'
                ,status_token_hash TEXT NOT NULL DEFAULT ''
                ,notification_installation_id TEXT
                ,notification_platform TEXT
            );
            CREATE INDEX IF NOT EXISTS orders_status_idx ON orders(status);
            CREATE TABLE IF NOT EXISTS observed_payments (
                payment_id TEXT NOT NULL,
                tx_hash TEXT NOT NULL,
                amount_atomic TEXT NOT NULL,
                block_height INTEGER NOT NULL,
                confirmations INTEGER NOT NULL,
                unlocked INTEGER NOT NULL,
                observed_at INTEGER NOT NULL,
                PRIMARY KEY (payment_id, tx_hash),
                FOREIGN KEY (payment_id) REFERENCES orders(payment_id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS vanity_jobs (
                id TEXT PRIMARY KEY,
                order_id TEXT NOT NULL,
                prefix_index INTEGER NOT NULL,
                prefix TEXT NOT NULL,
                public_address TEXT NOT NULL,
                status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed')),
                created_at INTEGER NOT NULL,
                claimed_at INTEGER,
                completed_at INTEGER,
                result_address TEXT,
                result_key_offset TEXT,
                error TEXT,
                search_expires_at INTEGER,
                result_guaranteed INTEGER NOT NULL DEFAULT 1,
                non_refundable_after_start INTEGER NOT NULL DEFAULT 0,
                group_id TEXT,
                UNIQUE (order_id, prefix_index),
                FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS vanity_jobs_status_idx ON vanity_jobs(status, created_at);
            CREATE TABLE IF NOT EXISTS vanity_search_groups (
                id TEXT PRIMARY KEY,
                order_id TEXT NOT NULL,
                group_index INTEGER NOT NULL,
                prefix_length INTEGER NOT NULL,
                prefixes_json TEXT NOT NULL,
                price_atomic TEXT NOT NULL,
                maximum_search_seconds INTEGER NOT NULL,
                status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'expired', 'failed')),
                created_at INTEGER NOT NULL,
                started_at INTEGER,
                search_expires_at INTEGER,
                completed_at INTEGER,
                matched_prefix TEXT,
                result_address TEXT,
                result_key_offset TEXT,
                UNIQUE(order_id, group_index),
                FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS vanity_search_groups_pool_idx
                ON vanity_search_groups(status, created_at);
            CREATE TABLE IF NOT EXISTS vanity_notification_outbox (
                id TEXT PRIMARY KEY,
                order_id TEXT NOT NULL,
                installation_id TEXT NOT NULL,
                platform TEXT NOT NULL,
                category TEXT NOT NULL,
                deep_link TEXT NOT NULL,
                status TEXT NOT NULL CHECK (status IN ('pending', 'sent')),
                created_at INTEGER NOT NULL,
                sent_at INTEGER,
                FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS vanity_notification_outbox_status_idx
                ON vanity_notification_outbox(status, created_at);
            "#,
        )?;
        ensure_column(
            &connection,
            "orders",
            "list_price_atomic",
            "TEXT NOT NULL DEFAULT '0'",
        )?;
        ensure_column(
            &connection,
            "orders",
            "status_token_hash",
            "TEXT NOT NULL DEFAULT ''",
        )?;
        ensure_column(
            &connection,
            "orders",
            "notification_installation_id",
            "TEXT",
        )?;
        ensure_column(&connection, "orders", "notification_platform", "TEXT")?;
        ensure_column(&connection, "vanity_jobs", "group_id", "TEXT")?;
        ensure_column(
            &connection,
            "orders",
            "discount_atomic",
            "TEXT NOT NULL DEFAULT '0'",
        )?;
        ensure_column(&connection, "vanity_jobs", "search_expires_at", "INTEGER")?;
        ensure_column(
            &connection,
            "vanity_jobs",
            "result_guaranteed",
            "INTEGER NOT NULL DEFAULT 1",
        )?;
        ensure_column(
            &connection,
            "vanity_jobs",
            "non_refundable_after_start",
            "INTEGER NOT NULL DEFAULT 0",
        )?;
        Ok(Self {
            connection: Arc::new(Mutex::new(connection)),
        })
    }

    pub fn insert_order(&self, order: &NewOrder) -> Result<()> {
        let prefixes_json = serde_json::to_string(&order.prefixes)?;
        let connection = self.lock()?;
        connection.execute(
            r#"INSERT INTO orders (
                id, status, network, public_address, prefixes_json, price_atomic,
                payment_id, payment_address, created_at, quote_expires_at,
                required_confirmations, updated_at, list_price_atomic, discount_atomic
                ,status_token_hash, notification_installation_id, notification_platform
            ) VALUES (?1, 'awaiting_payment', 'mainnet', ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?7, ?10, ?11, ?12, ?13, ?14)"#,
            params![
                order.id,
                order.public_address,
                prefixes_json,
                order.price_atomic.to_string(),
                order.payment_id,
                order.payment_address,
                order.created_at,
                order.quote_expires_at,
                i64::try_from(order.required_confirmations)?,
                order.list_price_atomic.to_string(),
                order.discount_atomic.to_string(),
                order.status_token_hash,
                order.notification_installation_id,
                order.notification_platform,
            ],
        )?;
        Ok(())
    }

    pub fn get_order(&self, id: &str) -> Result<Option<OrderRecord>> {
        let connection = self.lock()?;
        connection
            .query_row(
                "SELECT id, status, network, public_address, prefixes_json, price_atomic, payment_id, payment_address, created_at, quote_expires_at, required_confirmations, observed_atomic, payment_txid, payment_height, confirmations, paid_at, updated_at, list_price_atomic, discount_atomic, status_token_hash, notification_installation_id, notification_platform FROM orders WHERE id = ?1",
                [id],
                order_from_row,
            )
            .optional()
            .map_err(Into::into)
    }

    pub fn get_authorized_order(
        &self,
        id: &str,
        status_token_hash: &str,
    ) -> Result<Option<OrderRecord>> {
        let connection = self.lock()?;
        connection
            .query_row(
                "SELECT id, status, network, public_address, prefixes_json, price_atomic, payment_id, payment_address, created_at, quote_expires_at, required_confirmations, observed_atomic, payment_txid, payment_height, confirmations, paid_at, updated_at, list_price_atomic, discount_atomic, status_token_hash, notification_installation_id, notification_platform FROM orders WHERE id = ?1 AND status_token_hash = ?2",
                params![id, status_token_hash],
                order_from_row,
            )
            .optional()
            .map_err(Into::into)
    }

    pub fn get_jobs(&self, order_id: &str) -> Result<Vec<JobRecord>> {
        let connection = self.lock()?;
        let mut statement = connection.prepare(
            "SELECT id, prefix, status, result_address, result_key_offset, error, search_expires_at, result_guaranteed, non_refundable_after_start FROM vanity_jobs WHERE order_id = ?1 ORDER BY prefix_index ASC",
        )?;
        let rows = statement.query_map([order_id], |row| {
            Ok(JobRecord {
                id: row.get(0)?,
                prefix: row.get(1)?,
                status: row.get(2)?,
                result_address: row.get(3)?,
                result_key_offset: row.get(4)?,
                error: row.get(5)?,
                search_expires_at: row.get(6)?,
                result_guaranteed: row.get(7)?,
                non_refundable_after_start: row.get(8)?,
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(Into::into)
    }

    pub fn get_search_groups(&self, order_id: &str) -> Result<Vec<SearchGroupRecord>> {
        let connection = self.lock()?;
        let mut statement = connection.prepare(
            "SELECT id, status, prefix_length, prefixes_json, price_atomic, created_at, started_at, search_expires_at, completed_at, matched_prefix, result_address, result_key_offset, maximum_search_seconds FROM vanity_search_groups WHERE order_id = ?1 ORDER BY group_index ASC",
        )?;
        let rows = statement.query_map([order_id], |row| {
            let raw_prefixes: String = row.get(3)?;
            let raw_price: String = row.get(4)?;
            Ok(SearchGroupRecord {
                id: row.get(0)?,
                status: row.get(1)?,
                prefix_length: row.get(2)?,
                prefixes: serde_json::from_str(&raw_prefixes).map_err(to_sql_error)?,
                price_atomic: raw_price.parse().map_err(to_sql_error)?,
                created_at: row.get(5)?,
                started_at: row.get(6)?,
                search_expires_at: row.get(7)?,
                completed_at: row.get(8)?,
                matched_prefix: row.get(9)?,
                result_address: row.get(10)?,
                result_key_offset: row.get(11)?,
                maximum_search_seconds: row.get(12)?,
                candidates: Vec::new(),
            })
        })?;
        let mut groups = rows
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(anyhow::Error::from)?;
        for group in &mut groups {
            let mut jobs = connection.prepare(
                "SELECT id, prefix, status, result_address, result_key_offset, error, search_expires_at, result_guaranteed, non_refundable_after_start FROM vanity_jobs WHERE group_id = ?1 ORDER BY prefix_index ASC",
            )?;
            group.candidates = jobs
                .query_map([&group.id], |row| {
                    Ok(JobRecord {
                        id: row.get(0)?,
                        prefix: row.get(1)?,
                        status: row.get(2)?,
                        result_address: row.get(3)?,
                        result_key_offset: row.get(4)?,
                        error: row.get(5)?,
                        search_expires_at: row.get(6)?,
                        result_guaranteed: row.get(7)?,
                        non_refundable_after_start: row.get(8)?,
                    })
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
        }
        Ok(groups)
    }

    pub fn active_prefix_slots(&self) -> Result<usize> {
        let connection = self.lock()?;
        let count: u64 = connection.query_row(
            "SELECT COUNT(*) FROM vanity_jobs WHERE status = 'running' AND group_id IS NOT NULL",
            [],
            |row| row.get(0),
        )?;
        usize::try_from(count).context("active Vanity slot count overflow")
    }

    pub fn active_candidates(&self) -> Result<Vec<ActiveCandidate>> {
        let connection = self.lock()?;
        let mut statement = connection.prepare(
            "SELECT id, group_id, order_id, prefix, public_address, search_expires_at FROM vanity_jobs WHERE status = 'running' AND group_id IS NOT NULL ORDER BY claimed_at ASC, prefix_index ASC LIMIT 2000",
        )?;
        let rows = statement.query_map([], |row| {
            Ok(ActiveCandidate {
                id: row.get(0)?,
                group_id: row.get(1)?,
                order_id: row.get(2)?,
                prefix: row.get(3)?,
                public_address: row.get(4)?,
                search_expires_at: row.get(5)?,
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(Into::into)
    }

    pub fn activate_queued_groups(&self, now: i64, maximum_slots: usize) -> Result<usize> {
        let mut connection = self.lock()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let activated = activate_queued_groups_tx(&transaction, now, maximum_slots)?;
        transaction.commit()?;
        Ok(activated)
    }

    pub fn complete_candidate(
        &self,
        candidate_id: &str,
        result_address: &str,
        result_key_offset: &str,
        now: i64,
    ) -> Result<()> {
        let mut connection = self.lock()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let candidate = transaction
            .query_row(
                "SELECT group_id, order_id, prefix, status FROM vanity_jobs WHERE id = ?1",
                [candidate_id],
                |row| {
                    Ok((
                        row.get::<_, Option<String>>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                    ))
                },
            )
            .optional()?;
        let Some((Some(group_id), order_id, matched_prefix, status)) = candidate else {
            return Err(anyhow!("Vanity candidate was not found"));
        };
        if status != "running" || !result_address.starts_with(&matched_prefix) {
            return Err(anyhow!(
                "Vanity candidate result is invalid or no longer active"
            ));
        }
        let group_status: String = transaction.query_row(
            "SELECT status FROM vanity_search_groups WHERE id = ?1",
            [&group_id],
            |row| row.get(0),
        )?;
        if group_status != "running" {
            return Err(anyhow!("Vanity search group is no longer active"));
        }
        transaction.execute(
            "UPDATE vanity_jobs SET status = 'completed', completed_at = ?1, result_address = ?2, result_key_offset = ?3 WHERE id = ?4",
            params![now, result_address, result_key_offset, candidate_id],
        )?;
        transaction.execute(
            "UPDATE vanity_jobs SET status = 'failed', completed_at = ?1, error = 'Cancelled because another alternative in this search group matched.' WHERE group_id = ?2 AND id <> ?3 AND status IN ('queued', 'running')",
            params![now, group_id, candidate_id],
        )?;
        transaction.execute(
            "UPDATE vanity_search_groups SET status = 'completed', completed_at = ?1, matched_prefix = ?2, result_address = ?3, result_key_offset = ?4 WHERE id = ?5",
            params![now, matched_prefix, result_address, result_key_offset, group_id],
        )?;
        update_order_search_status_tx(&transaction, &order_id, now)?;
        enqueue_order_notification_tx(&transaction, &order_id, "completed", &group_id, now)?;
        activate_queued_groups_tx(&transaction, now, crate::pricing::MAX_ACTIVE_PREFIX_SLOTS)?;
        transaction.commit()?;
        Ok(())
    }

    pub fn pending_notifications(&self, limit: usize) -> Result<Vec<PendingNotification>> {
        let connection = self.lock()?;
        let bounded_limit = i64::try_from(limit.min(100))?;
        let mut statement = connection.prepare(
            "SELECT id, order_id, installation_id, platform, category, deep_link FROM vanity_notification_outbox WHERE status = 'pending' ORDER BY created_at ASC LIMIT ?1",
        )?;
        let rows = statement.query_map([bounded_limit], |row| {
            Ok(PendingNotification {
                id: row.get(0)?,
                order_id: row.get(1)?,
                installation_id: row.get(2)?,
                platform: row.get(3)?,
                category: row.get(4)?,
                deep_link: row.get(5)?,
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(Into::into)
    }

    pub fn mark_notification_sent(&self, id: &str, now: i64) -> Result<()> {
        let connection = self.lock()?;
        connection.execute(
            "UPDATE vanity_notification_outbox SET status = 'sent', sent_at = ?1 WHERE id = ?2 AND status = 'pending'",
            params![now, id],
        )?;
        Ok(())
    }

    pub fn monitored_payment_ids(&self) -> Result<Vec<String>> {
        let connection = self.lock()?;
        let mut statement = connection.prepare(
            "SELECT payment_id FROM orders WHERE status IN ('awaiting_payment', 'underpaid', 'payment_seen', 'expired')",
        )?;
        let rows = statement.query_map([], |row| row.get(0))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(Into::into)
    }

    pub fn expire_quotes(&self, now: i64) -> Result<usize> {
        let connection = self.lock()?;
        Ok(connection.execute(
            "UPDATE orders SET status = 'expired', updated_at = ?1 WHERE quote_expires_at < ?1 AND status IN ('awaiting_payment', 'underpaid')",
            [now],
        )?)
    }

    pub fn expire_limited_searches(&self, now: i64) -> Result<usize> {
        let mut connection = self.lock()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut statement = transaction.prepare(
            "SELECT id, order_id FROM vanity_search_groups WHERE status = 'running' AND search_expires_at IS NOT NULL AND search_expires_at <= ?1",
        )?;
        let expired = statement
            .query_map([now], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(statement);
        for (group_id, order_id) in &expired {
            transaction.execute(
                "UPDATE vanity_search_groups SET status = 'expired', completed_at = ?1 WHERE id = ?2 AND status = 'running'",
                params![now, group_id],
            )?;
            transaction.execute(
                "UPDATE vanity_jobs SET status = 'failed', completed_at = ?1, error = 'The maximum search window ended without a match.' WHERE group_id = ?2 AND status IN ('queued', 'running')",
                params![now, group_id],
            )?;
            update_order_search_status_tx(&transaction, order_id, now)?;
            enqueue_order_notification_tx(&transaction, order_id, "expired", group_id, now)?;
        }
        activate_queued_groups_tx(&transaction, now, crate::pricing::MAX_ACTIVE_PREFIX_SLOTS)?;
        transaction.commit()?;
        Ok(expired.len())
    }

    pub fn record_payment(&self, payment: &PaymentObservation, now: i64) -> Result<()> {
        let mut connection = self.lock()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let order = transaction
            .query_row(
                "SELECT id, status, price_atomic, quote_expires_at, required_confirmations, public_address, prefixes_json FROM orders WHERE payment_id = ?1",
                [&payment.payment_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, i64>(3)?,
                        row.get::<_, u64>(4)?,
                        row.get::<_, String>(5)?,
                        row.get::<_, String>(6)?,
                    ))
                },
            )
            .optional()?;
        let Some((
            order_id,
            current_status,
            raw_price,
            expires_at,
            required_confirmations,
            public_address,
            prefixes_json,
        )) = order
        else {
            return Ok(());
        };
        let price_atomic = parse_atomic(&raw_price)?;
        transaction.execute(
            r#"INSERT INTO observed_payments (
                payment_id, tx_hash, amount_atomic, block_height, confirmations, unlocked, observed_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
            ON CONFLICT(payment_id, tx_hash) DO UPDATE SET
                amount_atomic = excluded.amount_atomic,
                block_height = excluded.block_height,
                confirmations = excluded.confirmations,
                unlocked = excluded.unlocked,
                observed_at = excluded.observed_at"#,
            params![
                payment.payment_id,
                payment.tx_hash,
                payment.amount_atomic.to_string(),
                i64::try_from(payment.block_height)?,
                i64::try_from(payment.confirmations)?,
                payment.unlocked,
                now,
            ],
        )?;

        let (observed_atomic, confirmed_atomic, max_confirmations) =
            payment_totals(&transaction, &payment.payment_id, required_confirmations)?;
        let late = current_status == "expired" || now > expires_at;
        let new_status = if confirmed_atomic >= price_atomic {
            if late {
                "late_payment"
            } else {
                "paid"
            }
        } else if observed_atomic >= price_atomic {
            "payment_seen"
        } else if observed_atomic > 0 {
            "underpaid"
        } else {
            "awaiting_payment"
        };
        let paid_at = (new_status == "paid").then_some(now);
        transaction.execute(
            "UPDATE orders SET status = ?1, observed_atomic = ?2, payment_txid = ?3, payment_height = ?4, confirmations = ?5, paid_at = COALESCE(paid_at, ?6), updated_at = ?7 WHERE id = ?8",
            params![
                new_status,
                observed_atomic.to_string(),
                payment.tx_hash,
                i64::try_from(payment.block_height)?,
                i64::try_from(max_confirmations)?,
                paid_at,
                now,
                order_id,
            ],
        )?;
        if new_status == "paid" {
            let prefixes: Vec<String> = serde_json::from_str(&prefixes_json)?;
            let groups = crate::pricing::PricingCatalog::fixed().search_groups(&prefixes)?;
            let mut candidate_index = 0_usize;
            for (group_index, group) in groups.into_iter().enumerate() {
                let group_id = format!("{order_id}:group:{group_index}");
                transaction.execute(
                    "INSERT OR IGNORE INTO vanity_search_groups (id, order_id, group_index, prefix_length, prefixes_json, price_atomic, maximum_search_seconds, status, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'queued', ?8)",
                    params![
                        group_id,
                        order_id,
                        i64::try_from(group_index)?,
                        i64::try_from(group.prefix_length)?,
                        serde_json::to_string(&group.prefixes)?,
                        group.price_atomic.to_string(),
                        i64::try_from(group.maximum_search_seconds)?,
                        now,
                    ],
                )?;
                for prefix in group.prefixes {
                    transaction.execute(
                        "INSERT OR IGNORE INTO vanity_jobs (id, order_id, prefix_index, prefix, public_address, status, created_at, result_guaranteed, non_refundable_after_start, group_id) VALUES (?1, ?2, ?3, ?4, ?5, 'queued', ?6, 0, 1, ?7)",
                        params![
                            format!("{order_id}:{candidate_index}"),
                            order_id,
                            i64::try_from(candidate_index)?,
                            prefix,
                            public_address,
                            now,
                            group_id,
                        ],
                    )?;
                    candidate_index = candidate_index.saturating_add(1);
                }
            }
            activate_queued_groups_tx(&transaction, now, crate::pricing::MAX_ACTIVE_PREFIX_SLOTS)?;
        }
        transaction.commit()?;
        Ok(())
    }

    #[cfg(test)]
    fn queued_job_count(&self, order_id: &str) -> Result<u64> {
        let connection = self.lock()?;
        let count = connection.query_row(
            "SELECT COUNT(*) FROM vanity_jobs WHERE order_id = ?1 AND status = 'queued'",
            [order_id],
            |row| row.get(0),
        )?;
        Ok(count)
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, Connection>> {
        self.connection
            .lock()
            .map_err(|_| anyhow!("SQLite connection lock poisoned"))
    }
}

fn activate_queued_groups_tx(
    transaction: &rusqlite::Transaction<'_>,
    now: i64,
    maximum_slots: usize,
) -> Result<usize> {
    let active: u64 = transaction.query_row(
        "SELECT COUNT(*) FROM vanity_jobs WHERE status = 'running' AND group_id IS NOT NULL",
        [],
        |row| row.get(0),
    )?;
    let mut available = maximum_slots.saturating_sub(usize::try_from(active)?);
    let mut statement = transaction.prepare(
        "SELECT id, order_id, maximum_search_seconds FROM vanity_search_groups WHERE status = 'queued' ORDER BY created_at ASC, group_index ASC",
    )?;
    let queued = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, u64>(2)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(statement);
    let mut activated = 0_usize;
    for (group_id, order_id, maximum_search_seconds) in queued {
        let slots: u64 = transaction.query_row(
            "SELECT COUNT(*) FROM vanity_jobs WHERE group_id = ?1 AND status = 'queued'",
            [&group_id],
            |row| row.get(0),
        )?;
        let slots = usize::try_from(slots)?;
        if slots == 0 || slots > available {
            continue;
        }
        let expires_at = now
            .checked_add(i64::try_from(maximum_search_seconds)?)
            .context("Vanity search expiry overflow")?;
        transaction.execute(
            "UPDATE vanity_search_groups SET status = 'running', started_at = ?1, search_expires_at = ?2 WHERE id = ?3 AND status = 'queued'",
            params![now, expires_at, group_id],
        )?;
        transaction.execute(
            "UPDATE vanity_jobs SET status = 'running', claimed_at = ?1, search_expires_at = ?2 WHERE group_id = ?3 AND status = 'queued'",
            params![now, expires_at, group_id],
        )?;
        transaction.execute(
            "UPDATE orders SET status = 'searching', updated_at = ?1 WHERE id = ?2 AND status IN ('paid', 'queued', 'searching')",
            params![now, order_id],
        )?;
        available -= slots;
        activated = activated.saturating_add(1);
    }
    Ok(activated)
}

fn update_order_search_status_tx(
    transaction: &rusqlite::Transaction<'_>,
    order_id: &str,
    now: i64,
) -> Result<()> {
    let (queued, running, completed, expired, failed): (u64, u64, u64, u64, u64) =
        transaction.query_row(
            "SELECT SUM(status = 'queued'), SUM(status = 'running'), SUM(status = 'completed'), SUM(status = 'expired'), SUM(status = 'failed') FROM vanity_search_groups WHERE order_id = ?1",
            [order_id],
            |row| {
                Ok((
                    row.get::<_, Option<u64>>(0)?.unwrap_or(0),
                    row.get::<_, Option<u64>>(1)?.unwrap_or(0),
                    row.get::<_, Option<u64>>(2)?.unwrap_or(0),
                    row.get::<_, Option<u64>>(3)?.unwrap_or(0),
                    row.get::<_, Option<u64>>(4)?.unwrap_or(0),
                ))
            },
        )?;
    let status = if running > 0 {
        "searching"
    } else if queued > 0 {
        "queued"
    } else if completed > 0 && expired + failed > 0 {
        "partially_completed"
    } else if completed > 0 {
        "completed"
    } else {
        "expired"
    };
    transaction.execute(
        "UPDATE orders SET status = ?1, updated_at = ?2 WHERE id = ?3",
        params![status, now, order_id],
    )?;
    Ok(())
}

fn enqueue_order_notification_tx(
    transaction: &rusqlite::Transaction<'_>,
    order_id: &str,
    outcome: &str,
    discriminator: &str,
    now: i64,
) -> Result<()> {
    let target = transaction
        .query_row(
            "SELECT notification_installation_id, notification_platform FROM orders WHERE id = ?1",
            [order_id],
            |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, Option<String>>(1)?,
                ))
            },
        )
        .optional()?;
    let Some((Some(installation_id), Some(platform))) = target else {
        return Ok(());
    };
    let digest = sha2::Sha256::digest(format!("{order_id}:{outcome}:{discriminator}").as_bytes());
    let event_id = format!("evt_{}", hex::encode(digest));
    transaction.execute(
        "INSERT OR IGNORE INTO vanity_notification_outbox (id, order_id, installation_id, platform, category, deep_link, status, created_at) VALUES (?1, ?2, ?3, ?4, 'monero.fast_wallet.vanity', ?5, 'pending', ?6)",
        params![
            event_id,
            order_id,
            installation_id,
            platform,
            format!("mfw://vanity/order/{order_id}"),
            now,
        ],
    )?;
    Ok(())
}

fn payment_totals(
    transaction: &rusqlite::Transaction<'_>,
    payment_id: &str,
    required_confirmations: u64,
) -> Result<(u64, u64, u64)> {
    let mut statement = transaction.prepare(
        "SELECT amount_atomic, confirmations, unlocked FROM observed_payments WHERE payment_id = ?1",
    )?;
    let mut rows = statement.query([payment_id])?;
    let mut observed = 0_u64;
    let mut confirmed = 0_u64;
    let mut max_confirmations = 0_u64;
    while let Some(row) = rows.next()? {
        let amount = parse_atomic(&row.get::<_, String>(0)?)?;
        let confirmations = row.get::<_, u64>(1)?;
        let unlocked = row.get::<_, bool>(2)?;
        observed = observed
            .checked_add(amount)
            .context("observed payment overflow")?;
        if unlocked && confirmations >= required_confirmations {
            confirmed = confirmed
                .checked_add(amount)
                .context("confirmed payment overflow")?;
        }
        max_confirmations = max_confirmations.max(confirmations);
    }
    Ok((observed, confirmed, max_confirmations))
}

fn ensure_column(
    connection: &Connection,
    table: &str,
    column: &str,
    declaration: &str,
) -> Result<()> {
    let mut statement = connection.prepare(&format!("PRAGMA table_info({table})"))?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if !columns.iter().any(|existing| existing == column) {
        connection.execute_batch(&format!(
            "ALTER TABLE {table} ADD COLUMN {column} {declaration}"
        ))?;
    }
    Ok(())
}

fn order_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<OrderRecord> {
    let prefixes_json: String = row.get(4)?;
    let raw_price: String = row.get(5)?;
    let raw_observed: String = row.get(11)?;
    let raw_list_price: String = row.get(17)?;
    let raw_discount: String = row.get(18)?;
    Ok(OrderRecord {
        id: row.get(0)?,
        status: row.get(1)?,
        network: row.get(2)?,
        public_address: row.get(3)?,
        prefixes: serde_json::from_str(&prefixes_json).map_err(to_sql_error)?,
        price_atomic: raw_price.parse::<u64>().map_err(to_sql_error)?,
        list_price_atomic: raw_list_price.parse::<u64>().map_err(to_sql_error)?,
        discount_atomic: raw_discount.parse::<u64>().map_err(to_sql_error)?,
        payment_id: row.get(6)?,
        payment_address: row.get(7)?,
        created_at: row.get(8)?,
        quote_expires_at: row.get(9)?,
        required_confirmations: row.get(10)?,
        observed_atomic: raw_observed.parse::<u64>().map_err(to_sql_error)?,
        payment_txid: row.get(12)?,
        payment_height: row.get(13)?,
        confirmations: row.get(14)?,
        paid_at: row.get(15)?,
        updated_at: row.get(16)?,
        notification_installation_id: row.get(20)?,
        notification_platform: row.get(21)?,
    })
}

fn parse_atomic(value: &str) -> Result<u64> {
    value.parse().context("invalid atomic amount in database")
}

fn to_sql_error(error: impl std::error::Error + Send + Sync + 'static) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(error))
}

fn serialize_u64_as_string<S>(value: &u64, serializer: S) -> Result<S::Ok, S::Error>
where
    S: serde::Serializer,
{
    serializer.serialize_str(&value.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn order() -> NewOrder {
        NewOrder {
            id: "order-1".into(),
            public_address: "public".into(),
            prefixes: vec!["4MFW".into(), "4TST".into()],
            price_atomic: 300,
            list_price_atomic: 400,
            discount_atomic: 100,
            payment_id: "0011223344556677".into(),
            payment_address: "integrated".into(),
            created_at: 100,
            quote_expires_at: 200,
            required_confirmations: 2,
            status_token_hash: "status-token-hash".into(),
            notification_installation_id: Some("mfw_test_0123456789abcdef0123456789abcdef".into()),
            notification_platform: Some("android".into()),
        }
    }

    #[test]
    fn order_becomes_paid_only_after_unlock_and_confirmations() {
        let database = Database::in_memory().unwrap();
        database.insert_order(&order()).unwrap();
        let mut payment = PaymentObservation {
            payment_id: "0011223344556677".into(),
            tx_hash: "tx".into(),
            amount_atomic: 300,
            block_height: 120,
            confirmations: 1,
            unlocked: false,
        };
        database.record_payment(&payment, 150).unwrap();
        assert_eq!(
            database.get_order("order-1").unwrap().unwrap().status,
            "payment_seen"
        );

        payment.confirmations = 2;
        payment.unlocked = true;
        database.record_payment(&payment, 151).unwrap();
        let stored = database.get_order("order-1").unwrap().unwrap();
        assert_eq!(stored.status, "searching");
        assert_eq!(stored.observed_atomic, 300);
        assert_eq!(database.queued_job_count("order-1").unwrap(), 0);
        assert_eq!(database.active_prefix_slots().unwrap(), 2);
    }

    #[test]
    fn late_payments_are_never_queued_as_paid() {
        let database = Database::in_memory().unwrap();
        database.insert_order(&order()).unwrap();
        database.expire_quotes(201).unwrap();
        database
            .record_payment(
                &PaymentObservation {
                    payment_id: "0011223344556677".into(),
                    tx_hash: "late".into(),
                    amount_atomic: 300,
                    block_height: 130,
                    confirmations: 10,
                    unlocked: true,
                },
                202,
            )
            .unwrap();
        assert_eq!(
            database.get_order("order-1").unwrap().unwrap().status,
            "late_payment"
        );
        assert_eq!(database.queued_job_count("order-1").unwrap(), 0);
    }

    #[test]
    fn first_match_completes_the_group_and_removes_its_alternatives_from_the_pool() {
        let database = Database::in_memory().unwrap();
        database.insert_order(&order()).unwrap();
        database
            .record_payment(
                &PaymentObservation {
                    payment_id: "0011223344556677".into(),
                    tx_hash: "paid".into(),
                    amount_atomic: 300,
                    block_height: 120,
                    confirmations: 10,
                    unlocked: true,
                },
                150,
            )
            .unwrap();
        assert_eq!(database.active_prefix_slots().unwrap(), 2);
        database
            .complete_candidate("order-1:0", "4MFW-result", &"ab".repeat(32), 151)
            .unwrap();
        assert_eq!(database.active_prefix_slots().unwrap(), 0);
        let groups = database.get_search_groups("order-1").unwrap();
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].status, "completed");
        assert_eq!(groups[0].candidates[0].status, "completed");
        assert_eq!(groups[0].candidates[1].status, "failed");
        assert_eq!(
            database.get_order("order-1").unwrap().unwrap().status,
            "completed"
        );
        let notifications = database.pending_notifications(10).unwrap();
        assert_eq!(notifications.len(), 1);
        assert_eq!(notifications[0].order_id, "order-1");
    }

    #[test]
    fn ten_character_groups_expire_after_exactly_sixty_days() {
        let database = Database::in_memory().unwrap();
        let mut limited_order = order();
        limited_order.prefixes = vec!["4MFW123456".into()];
        database.insert_order(&limited_order).unwrap();
        database
            .record_payment(
                &PaymentObservation {
                    payment_id: "0011223344556677".into(),
                    tx_hash: "paid".into(),
                    amount_atomic: 300,
                    block_height: 120,
                    confirmations: 10,
                    unlocked: true,
                },
                150,
            )
            .unwrap();
        let jobs = database.get_jobs("order-1").unwrap();
        assert_eq!(jobs.len(), 1);
        assert_eq!(jobs[0].search_expires_at, Some(150 + 5_184_000));
        assert!(!jobs[0].result_guaranteed);
        assert!(jobs[0].non_refundable_after_start);

        assert_eq!(
            database.expire_limited_searches(150 + 5_183_999).unwrap(),
            0
        );
        assert_eq!(
            database.expire_limited_searches(150 + 5_184_000).unwrap(),
            1
        );
        assert_eq!(database.get_jobs("order-1").unwrap()[0].status, "failed");
    }
}
