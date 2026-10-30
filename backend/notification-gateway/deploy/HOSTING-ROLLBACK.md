# Hosting check rollback

Rollback is an operator action requiring the deployment's existing approval.
This document performs no action by itself.

Restore the saved Gateway, Relay and Worker executables and the matching saved
Nginx configuration as one set. Verify the saved checksums, owners and modes,
validate the proxy configuration, then restart/reload only those affected
services according to the normal maintenance process. Confirm ordinary Worker
pull/ACK activity and provider delivery health.

Keep every existing environment file, secret, signed Worker descriptor,
installation/provider state file, encrypted watch store, assignment, receipt
and Node data in place. The hosting feature adds no persistent state format
migration: pending hosting challenges are bounded in-memory observations.
They may be lost during restart/rollback and clients then report unknown or
unsupported. They must never be converted to signed missing results.

Do not restore older wallet or server databases over newer payment state. Do
not reprovision keys, re-register Firebase/Apple accounts, revoke assignments,
create wallets, or send test payments as part of rollback. A previous hosted
proof remains historical display metadata and cannot authorize a new repair.
