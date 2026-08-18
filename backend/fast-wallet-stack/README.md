# Fast Wallet production stack

This directory deploys the secure Fast Wallet V1 boundaries as separate
processes. They may run on one host now and can move to separate hosts later
without changing the client protocol:

- `fast-wallet-relay` stores fixed-size HPKE ciphertext envelopes and opaque
  assignment metadata only;
- `fast-wallet-worker` alone holds the HPKE private key, decrypts the private
  view key, and stores the resulting watch registration encrypted at rest;
- `fast-wallet-scanner-core` is its internal scan engine and has no listener or
  standalone server binary;
- `notification-registration-adapter` verifies Firebase App Check and issues a
  short-lived, one-use provider-registration grant;
- `notification-gateway` owns assignments and generic notification delivery.
- `fast-wallet-directory` publishes only TEX8-approved Community Workers and
  issues their short-lived, descriptor-bound admission certificates.

The Worker root signing key is deliberately absent from the server. Generate
the release material on an offline/admin Mac with
`provision_official_worker`, upload every generated file except
`worker-root-signing.key`, and keep that root key offline for descriptor
rotation.

## Co-located TEX8 ports

| Process | Bind | Public ingress |
| --- | --- | --- |
| Notification Gateway | `127.0.0.1:8090` | selected `/api/v1/*` routes |
| Fast Wallet Relay | `127.0.0.1:8094` | `/v1/envelopes` and authenticated Worker pull/ACK |
| Registration Adapter | `127.0.0.1:8095` | `/api/v1/provider-grants` |
| Community Worker Directory | `127.0.0.1:8096` | approved list plus signed registration/heartbeat |
| Fast Wallet Worker | outbound only | none |

Port 8091 remains reserved for Monero News. The Relay's internal assignment
routes and the Directory's approval routes are never exposed by Nginx. The
public Worker-wake route accepts only an assignment-bound Worker signature and
fixed generic event data.
The retired Notify Scanner and its plaintext `/v1/fast-receive` API are absent.

## Monero Fast Node source gate

The node binary must be built from the exact commit in `cuprate-source.lock`.
That combined source contains all three required capabilities: the existing
optimized wallet ScanPack cache, the canonical MFW name index, and the signed
read-only ScanPack writer used by the hosted Worker. Activation rejects a
binary whose embedded commit does not match the lock.

## Release gate

`config/v1-release-features.json` must keep `officialWorker` disabled until:

1. Relay, Worker, Directory, Gateway and registration adapter are active;
2. the signed ScanPack directory is healthy and current;
3. the public descriptor and ciphertext-envelope routes pass the contract test;
4. an actual client enrollment reaches the Worker and persists one encrypted
   watch registration;
5. closed-app delivery is verified on each claimed target platform.

The local Fast Wallet is not a successful substitute for step 4. Clients must
show an explicit enrollment error while the official service is selected but
the ciphertext upload cannot complete.

The opt-in `live_enrollment_probe` has passed step 4's protocol boundary with
a valid synthetic Monero address/private-view pair generated only in RAM. The
public host accepted only the 484-byte HPKE ciphertext; the outbound Worker
decrypted it, durably persisted the watch in its encrypted `0600` database,
signed a descriptor- and message-bound acceptance receipt, and then processed
the authenticated cleanup. The probe cryptographically verified that receipt.
This proves the service path, but does not replace the still-required
enrollment from an actual product CLI wallet or the closed-app platform checks
in step 5.

The CLI now keeps Relay acceptance pending and persists
`worker_enrolled=true` only after verifying the exact Worker-signed receipt.
Old sidecars that predate receipts migrate fail-closed and must repeat the
ciphertext hand-off; a Relay upload acknowledgement alone can never activate
hosted scanning.
