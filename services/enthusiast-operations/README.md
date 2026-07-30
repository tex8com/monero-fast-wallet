# Monero Enthusiast operations worker

Outbound-only scheduler and generic notification dispatcher.

It opens the publication and Community notification databases, claims durable
scheduled actions, snapshots the intended installations, calls FCM/APNs, and
acknowledges an action only when every snapshotted target is terminal. A
transient provider failure remains retryable; already delivered installations
are not called again. Invalid tokens are disabled.

The worker has no public listener. Community notifications use separate
provider registration storage and credentials from Fast Wallet incoming-payment
notifications. Push text is selected from closed enums in Rust and cannot
contain a report, reporter, profile/listing text, Matrix content, wallet data,
amount or transaction.

Required environment:

```bash
ENTHUSIAST_V1_PUBLICATION_DB=/var/lib/monero-enthusiast/publication.sqlite3
ENTHUSIAST_V1_CHAT_REPORT_DB=/var/lib/monero-enthusiast/chat-reports.sqlite3
ENTHUSIAST_V1_NOTIFICATION_DB=/var/lib/monero-enthusiast/notifications.sqlite3
ENTHUSIAST_OPERATIONS_DB=/var/lib/monero-enthusiast/operations.sqlite3
ENTHUSIAST_V1_STORAGE_KEY=<64 hex>
ENTHUSIAST_V1_CHAT_REPORT_KEY=<64 hex>
ENTHUSIAST_V1_NOTIFICATION_KEY=<64 hex>
```

Configure FCM, APNs, or both using the `COMMUNITY_FCM_*` and
`COMMUNITY_APNS_*` variables in `src/main.rs`. Credential files are read on
each delivery so a supervisor can rotate short-lived bearer/JWT material
without restarting this worker.
