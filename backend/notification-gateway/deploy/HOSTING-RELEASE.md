# Hosting check release

This is a build-only package. It contains Gateway, Relay and Worker binaries,
the matching Nginx routes, source checksums and a rollback plan. No service is
changed merely by building or unpacking it. Binary artifacts must be Linux
x86-64 ELF executables; macOS test binaries are not substitutes.

Before an authorized deployment, verify SHA256SUMS and preserve the currently
running three executables and the active Nginx configuration as one rollback
set. Record their hashes, permissions and service versions. Validate the new
Nginx configuration before activating its routes. Update every serving
virtual host, including Onion hosts with copied locations rather than the
shared snippet. Assignment URLs contain opaque handles: keep access logging
disabled for that prefix and use the safe Gateway hostingCheckId diagnostics.

Only replace the three executables and the reviewed proxy routes. Preserve all
existing service environment files, installation/provider stores, encrypted
Worker watches, trust state, Worker descriptors, root/online/HPKE keys, APNs/FCM
credentials and the Monero Node. Do not run provisioning or descriptor-renewal
scripts for this update. Firebase and Apple account changes are unnecessary.

The new Gateway/Relay/Worker protocol must be activated together. Native
clients authenticate assignment ownership, generate a fresh nonce and verify
the signed current WatchStore response. Network failures and unsupported old
services must remain unknown/unsupported, never proof of missing hosting.

Acceptance requires a synthetic or user-authorized empty Fast Wallet hosting
check, a verified hosted/missing proof with matching hostingCheckId on device
and server, and continued normal Worker pull/ACK health. No payment is needed.
Do not claim production/device acceptance from local source/unit tests alone.

The build script does not install or restart services, upload descriptors,
transfer credentials, change accounts, or access a real wallet key.
