# Monero Fast Wallet

**A fast, self-custodial Monero wallet for iOS, Android, and desktop.**

Monero Fast Wallet combines the official Monero wallet core with an optimized
Monero Fast Node data path, native CPU and Metal acceleration, and optional
privacy-preserving payment notifications. Your seed and spend key always remain
under your control.

## Product components

This monorepo contains the complete Monero Fast Wallet product. Its main
components are deliberately kept separate while sharing the same versioned
contracts:

| Component | Purpose |
| --- | --- |
| **Monero Fast Wallet (MFW)** | Self-custodial mobile and desktop wallets. Seeds, spend keys, primary view keys, transaction construction and final payment verification stay local or on a Ledger. |
| **MFN — Monero Fast Node** | The integrated, upstream-derived node under `node/mfn-monero-fast-node/`. It supplies compatible RPC, wallet gRPC streaming and signed ScanPacks. It is the one MFN source and deployment path for this product. |
| **Fast Wallet Worker** | An optional outbound-only scanner for an isolated Fast Wallet view key. It reads the shared MFN/ScanPack stream, stores encrypted watch state locally and can request only an opaque notification wake-up. |
| **MFM — Monero Fast Miner** | The separate, performance-focused RandomX miner and benchmark suite under `tools/mfw-miner/`. It is based on XMRig and is not part of wallet key custody, transaction signing, or the MFN node runtime. |
| **Monero Fast Wallet Registry** | The release-gated `.mfw` naming service. It resolves blockchain-anchored name records to a receive address that the wallet verifies before a payment is prepared. It is application naming, not ICANN DNS. |

### Upstream-derived core and security boundary

MFW intentionally extends proven implementations instead of rewriting the
security-critical Monero wallet and node foundations. The wallet bridge uses
the established Monero `wallet2` / `libwallet_api` implementation; MFN is the
integrated Cuprate-derived node implementation. Both are materialized from
pinned upstream revisions with ordered, reviewable patch series.

The product keeps Monero consensus validation, wallet-file semantics, key
custody, transaction construction and signing on those established core paths.
Our additions focus on transport and throughput (gRPC, ScanPacks, bounded
prefetching and platform-selected acceleration), platform integration and
wallet usability. They do not introduce a hosted spending path or replace
local final wallet verification.

This is a risk-reduction approach, not a claim that a patch is automatically
safe: every core-adjacent change remains security-sensitive, is kept narrow and
versioned, and must pass the applicable build, compatibility and security
gates before release.

> **Development status:** The source code is advanced, but it is **not yet
> approved for a public mainnet release**. Signed release artifacts, physical
> platform and Ledger validation, an independent security review, and several
> operational and recovery tests remain open release gates. See the
> [V1 Execution Plan](docs/V1_EXECUTION_PLAN.md),
> [Release Gate Matrix](docs/RELEASE_GATE_MATRIX.md) and
> [Security Audit](docs/SECURITY_AUDIT_2026-07-24.md) for details.
>
> **V1 scope:** The first public version is planned to include complete `.mfw`
> registration and resolution through the **Monero Fast Wallet Registry**, plus
> the replacement Monero Enthusiast feature.
> Both are required deliverables, but their production flags remain disabled
> until their separate security, service, signed-artifact, physical-platform,
> legal, and independent-review gates pass. The legacy non-E2EE Community is
> not part of V1.

[Features](#features) ·
[Benefits](#key-benefits) ·
[Benchmarks](#performance-and-benchmarks) ·
[Privacy](#two-clear-privacy-modes) ·
[Platform status](#platform-status) ·
[Repository](#monorepo-layout) ·
[Development](#local-development-and-testing)

---

## What is Monero Fast Wallet?

This application is not a user interface layered on top of
`monero-wallet-cli` or `monero-wallet-rpc`. The mobile and desktop apps use
small native bridges to communicate directly with our compatible fork of
Monero's `libwallet_api` / `wallet2`.

```text
React Native (iOS / Android)        React + Tauri 2 (desktop)
              \                         /
               \                       /
                 native wallet bridge
                         |
                   Monero wallet2
                         |
          +--------------+---------------+
          |                              |
   original Monero RPC      Monero Fast Node (MFN) gRPC
                                         |
                                  optional ScanPack
```

The goal is a simple everyday wallet without changing Monero addresses,
transactions, spending rules, or consensus.

### Monero Fast Wallet Registry

The public `.mfw` name layer is called the **Monero Fast Wallet Registry**. It
maps a human-readable name such as `alice.mfw` to a Monero receive address
through blockchain-anchored records that wallets verify before payment. It is
an application naming protocol, not ICANN DNS, and remains release-gated until
its production genesis parameters and independent review are complete.

## Key benefits

| Benefit | What it means for users |
| --- | --- |
| **Much faster restore and synchronization** | In the current strictly comparable Mainnet matrix, the optimized wallet path was **3.49× faster** than the unchanged Monero wallet, while the ScanPack path reached **13.03×**. All three serial runs scanned the same 161,523 blocks to one frozen tip. |
| **Automatic use of suitable hardware** | The wallet selects CPU, AVX2, AVX-512 IFMA, or Apple Metal according to the platform and batch size. Small Metal batches deliberately remain on the CPU because launching the GPU would be slower. |
| **Self-custody by default** | The seed, spend key, primary private view key, and wallet files remain local or on the Ledger. The normal wallet mode never uploads a private view key to TEX8. |
| **Standard Monero compatibility** | The wallet can use the fast Monero Fast Node (MFN) gRPC path, a standard Monero daemon, or your own compatible node. Addresses, transactions, and consensus remain standard Monero. |
| **Fast but optional payment signals** | Fast Receive uses a separate receiving identity. The server cannot spend funds and sends only an opaque signal; the amount and transaction details are verified locally. |
| **Mobile and desktop in one product repository** | React Native for iOS and Android and Tauri 2 for macOS, Windows, and Linux share wallet rules, native-core contracts, services, tests, and release documentation. |
| **Verifiable optimizations** | CPU, Metal, Vulkan, CUDA, transport, and mainnet synchronization testbenches plus **1,678 text-based raw artifacts** are stored in this repository. Successful and rejected experiments are both documented. |
| **Ledger support is included in the design** | USB/HID and mobile BLE transport paths exist in the source code. The seed and signing authority remain on the device; complete physical release validation is still pending. |

## Features

### Wallets and payments

- Create a wallet or restore one from Monero recovery words
- Enter recovery words through a native interface so they never pass through
  React or Tauri state
- Manage multiple software, view-only, Ledger, and Fast wallets
- Create multiple receiving addresses and subaddresses
- Display the locally generated, wallet-core-confirmed address as a QR code
- View balance, synchronization status, activity, and structured transaction
  details
- Send in two explicit steps: prepare and review the transaction, then confirm
  and submit it
- Use a local address book and the three most recently used recipients. The
  dormant configurable donation entry is not enabled in the production plan.
- Claim/register, renew, owner-update or revoke a public `.mfw` name through the
  **Monero Fast Wallet Registry**, and resolve
  one into the exact selected Monero network before native Send review. This is
  required V1 scope, but remains release-gated until the Registry, payment,
  finality, expiry, recovery, reorganization, and physical-device tests pass.
- Choose a restore date backed by a shared, deliberately conservative
  restore-height model
- Switch between mainnet, stagenet, and supported test configurations

### On-device protection

- One application-wide lock instead of a separate, confusing password for
  every wallet
- Face ID, Touch ID, or device passcode on iOS
- Strong biometrics or device PIN on Android
- Touch ID or an application password on macOS
- Windows Hello or an application password on Windows
- `fprintd` fingerprint authentication plus a recovery password on Linux
- Argon2id for the native application-password path
- Platform credential stores for protected local metadata
- iOS Keychain and Android Keystore-backed AES-GCM storage for daemon
  credentials
- A native, single-use send confirmation bound to the recipient, amount, fee,
  wallet, and expiration time
- Screenshot capture remains available in development and release builds for
  reproducible visual debugging; app locking, secure storage, and redacted
  release logs remain the actual security boundaries

These protection paths are implemented and covered by contract tests. Full
physical validation on every platform remains a release gate.

### Nodes and synchronization

- **Clearnet block route:** Monero Fast Node (MFN) gRPC, with parallel hash
  prefetching, block streaming, range reads, and chain-drift/split diagnostics
- **Tor wallet route:** an independently selected Onion daemon through Tor
  integrated in the app
- **Global configuration:** one automatically saved route pair per network,
  shared by every wallet on the device
- Speculative block prefetching and a gzip-compatible binary RPC path
- Persistent MFN ScanPack cache for fast access to historical block ranges
- Controlled gRPC queues, HTTP/2 windows, and optional independent TCP lanes
- Wallet-core-confirmed synchronization status: equal heights alone are not
  reported as fully synchronized
- Reorganization, fallback, and diagnostic paths without changes to Monero
  consensus rules

### Ledger Nano

- The official Monero `device_ledger` path in the native wallet core
- USB/HID support
- Native-layer Ledger Nano X BLE transport for iOS and Android
- On-device address and signing confirmation
- Local read-only synchronization after an explicitly approved view-key export
- An optional separately backed-up software Fast Wallet for users who also use
  a Ledger

> The source path is implemented, but a feature becomes release-accepted only
> after repeatable create, open, reconnect, address-display, and signing tests
> on physical devices.
>
> Ledger support is feature-gated out of the minimal public V1 until that
> acceptance is complete. A Ledger account such as account 1 is not an isolated
> hosted Fast Wallet root and its private view key must not be uploaded.

### Fast Receive and notifications

Fast Receive is an explicitly optional convenience mode:

1. The application creates a **separate**, recoverable software wallet with its
   own view key, spend key, and mandatory recovery-seed backup.
2. The user explicitly selects the built-in TEX8 Worker or pairs one private
   Worker by signed QR descriptor.
3. Native code encrypts that Fast Wallet's watch directly to the exact selected
   Worker. A separate mailbox Relay stores only HPKE ciphertext.
4. The outbound-only Worker reads one shared block/mempool stream from
   Monero Fast Node/ScanPack for all watches and requests only a bounded generic wake for
   its exact active assignments.
5. The Gateway alone holds provider delivery data. The application receives an
   “activity detected” signal and uses its local wallet core to determine the
   amount, transaction, confirmation, and spendability again.

The Relay **never** receives plaintext wallet keys. The selected Worker receives
only the isolated Fast Wallet view key; no server component receives a seed,
private spend key, or primary-wallet view key, and no Worker receives a raw
FCM/APNs token. The broader signed public Directory, Community Worker,
capacity-reservation, and validator architecture is deliberately post-V1. See
the
[`V1 Execution Plan`](docs/V1_EXECUTION_PLAN.md),
[`FAST_WALLET_SLOT_RECOVERY_AND_PRIVATE_WORKERS.md`](docs/FAST_WALLET_SLOT_RECOVERY_AND_PRIVATE_WORKERS.md)
and
[`PUBLIC_SERVICE_DIRECTORY_RELAY_AND_MEMPOOL.md`](docs/PUBLIC_SERVICE_DIRECTORY_RELAY_AND_MEMPOOL.md)
for the minimal and later target contracts.

Notification paths:

| Platform | Path |
| --- | --- |
| macOS | APNs; notification delivery to a closed development app and launch on click have been observed |
| Windows | Unprivileged WSS user agent → local Windows notification |
| Linux | Unprivileged WSS user agent → DBus notification |
| iOS / Android | Shared anonymous push-subscription contract; physical provider validation is still pending |

All push messages remain generic. Wallet names, addresses, amounts,
transaction IDs, block heights, seeds, and keys are forbidden in the payload.

### Monero Enthusiast V1, News, and Assistant

The first public product version includes a new, optional **Monero Enthusiast
V1** surface:

- pseudonymous profiles and public listings that remain separate from wallet
  addresses, balances, transactions, seeds, and keys;
- immutable signed public catalogs, on-device Harrier inference, SQLite +
  USearch discovery, and optional local-only personalization;
- contact requests and Matrix end-to-end encrypted chat;
- encrypted local drafts, reporting, blocking, human-reviewable moderation,
  reasons, appeals, deletion, and automatic listing expiry after at most
  30 days;
- optional user-confirmed coarse location without storing or publishing an
  exact GPS point;
- no marketplace checkout, price matching, trading, escrow, custody, exchange,
  or payment intermediation.

The replacement implementation and its live V1/Matrix service stack are enabled
for integration testing. Signed catalog and Common-Query sequence 1 are live
and a product-listing create/read/delete smoke test passes. This is not public
release approval: model packaging on every platform, Matrix recovery and E2EE
evidence, moderation operations, physical two-client/platform runs, legal
approval, and independent review remain required. The older
`enthusiast-discovery` route and its server-readable chat are retained only as
disabled historical code. Its earlier 11/11 live contract result does not count
as acceptance of Monero Enthusiast V1, and the application must never fall back
to it.

News and Assistant remain separate, disabled capabilities rather than required
V1 features. A future News or sponsored-content decision must never use wallet
addresses, balances, transactions, contacts, view keys, or payment timing for
targeting.

### Deliberately not offered as finished features

These ideas are on the roadmap and must not be understood as completed
features:

- Phone-book or phone-number-based payments
- Trust and reputation system
- Marketplace or trading
- Escrow or a Monero multisig trading flow

## Two clear privacy modes

| | Privacy only | Privacy + convenience / Fast Receive |
| --- | --- | --- |
| Seed | Local / Ledger only | Local / Ledger only |
| Private spend key | Local / Ledger only | Local / Ledger only |
| Primary-wallet view key | Local only | Local only |
| Separate Fast view key | Does not exist | Encrypted to the selected Worker after consent |
| Server can spend | No | No |
| Payment signal while the app is closed | No | Yes, generic and opaque |
| Final payment verification | Local wallet core | Local wallet core |
| Strongest privacy model | **Yes** | Intentional convenience trade-off |

A private view key can inherently reveal more incoming-payment metadata. The
open-source implementation discards details and stores only opaque events, but
this is still a software-based trust boundary. Users who do not want to accept
that boundary can use the normal local-wallet mode.

Learn more:
[Privacy Model](docs/PRIVACY_MODEL.md) ·
[Decentralized Private View-Key Hosting](docs/DECENTRALIZED_PRIVATE_VIEW_KEY_HOSTING.md) ·
[Fast Wallet Slot, Recovery, And Private Workers](docs/FAST_WALLET_SLOT_RECOVERY_AND_PRIVATE_WORKERS.md) ·
[Public Service Directory, Relay, And Mempool](docs/PUBLIC_SERVICE_DIRECTORY_RELAY_AND_MEMPOOL.md) ·
[Directory/Relay/Worker Architecture Audit](docs/DIRECTORY_RELAY_WORKER_ARCHITECTURE_AUDIT_2026-07-26.md) ·
[Threat Model](docs/THREAT_MODEL.md) ·
[Security Policy](SECURITY.md)

## Performance and benchmarks

### What the cryptographic benchmarks measure

The cryptographic testbenches measure Monero's complete wallet key derivation:

```text
D = 8 × a × R

a = the wallet's private view scalar
R = the transaction's public key
```

`derivations/s` is a **cryptographic kernel metric**. It is not blocks per
second and it is not a wallet synchronization time. The separate end-to-end
mainnet tests below are therefore the important measure of user-visible speed.

Desktop and CUDA results are normalized against the archived, workload-matched
single-thread Ref10 series:

```text
Original Monero Ref10: 27,030.166 derivations/s = 1.00×
```

A normalized factor includes algorithmic improvements, parallelism, and
hardware differences. Only direct A/B rows measured on the same machine
isolate the software improvement itself.

### Cryptographic performance by platform

| Platform / path | Reliable result | Factor vs stated Ref10 baseline | Product status |
| --- | ---: | ---: | --- |
| Original Monero Ref10, 1 thread | 27,030.166/s | **1.00×** | Shared desktop/CUDA baseline |
| Apple M4 CPU, 10 workers | 262,888.292/s | **9.73×** normalized | Accepted CPU kernel |
| EPYC 9634 AVX-512 IFMA, 12 workers | 343,589.844/s | **12.71×** normalized | Accepted CPU kernel with AVX2 fallback |
| EPYC Hosted Scanner, batch of 16 | 520,437.272/s | **19.25×** normalized | Long product-integration run |
| EPYC Hosted Scanner, short smoke peak | 526,300.493/s | **19.47×** normalized | Peak only; not a replacement for the long run |
| Apple M4 Metal M17, real product boundary | 459,493.923/s | **17.00×** normalized | Packaged metallib with CPU fallback |
| Apple M4 Metal M16, kernel only | 521,626.293/s | **19.30×** normalized | Isolated kernel, not the product boundary |
| Pixel 8 Pro CPU, 9 workers, device 1 | 77,962.845/s | **7.826×** vs local Ref10 baseline of 9,961.612/s | Selected mobile path |
| Pixel 8 Pro CPU, 9 workers, device 2 | 75,586.545/s | **9.079×** vs local Ref10 baseline of 8,325.397/s | Selected mobile path |
| Pixel 8 Pro Vulkan, optimized | 20,693.944/s | **2.486×** vs local Ref10 baseline | Correct, but not enabled |
| RTX 3090 CUDA C6, formal median | 10,948,124.475/s | **405.03×** | Validated research testbench |
| RTX 3090 CUDA C6, sustained run | 10,790,157.075/s | **399.19×** | Validated research testbench |
| RTX 3090 CUDA, best single run | 11,532,473.446/s | **426.65×** | Short peak result |
| RTX 5090 CUDA C7, formal median | 26,818,054.526/s | **992.15×** | Validated research testbench |
| RTX 5090 CUDA C7, sustained run | 26,877,688.327/s | **994.36×** | Strongest reliable CUDA result |
| RTX 5090 CUDA, best single run | 27,323,459.974/s | **1,010.85×** | Short peak result |

A later historical Ref10 series with a larger corpus measured 16,294.622/s on
the same M4. M17 would be 28.20× faster against that different series. This
number is retained for context and is not mixed with the workload-matched
27,030.166/s normalization.

### Direct optimization gains

These factors come from equal or immediately paired A/B runs and show the
benefit of each change itself:

| Optimization | Before | After | Improvement |
| --- | ---: | ---: | ---: |
| M4: prepared scalar + pairing + batch compression + workspace reuse | 233,023.743/s | 262,888.292/s | **1.128× / +12.816%** |
| EPYC: stable AVX2 → AVX-512 IFMA | 269,406.083/s | 343,589.844/s | **1.275× / +27.536%** |
| Hosted Scanner: per item → batch of 16 | 447,343.589/s | 520,437.272/s | **1.163× / +16.339%** |
| Metal M17 product path vs CPU product path at 8,192 points | 229,459.565/s | 459,493.923/s | **2.003× / +100.251%** |
| Metal M12 → M16 kernel | 518,611.644/s | 521,626.293/s | **1.006× / +0.581%** |
| Pixel Vulkan: initial M12 → selective SPIR-V `-O` | 8,522.704/s | 20,677.429/s | **2.426×** |
| CUDA RTX 3090: C5 → C6 at 131,072 points | 10,331,329/s | 10,948,124/s | **1.060× / +5.97%** |
| RTX 3090 → RTX 5090, best single runs | 11,532,473/s | 27,323,460/s | **2.369×** |
| RTX 3090 → RTX 5090, sustained runs | 10,790,157/s | 26,877,688/s | **2.491×** |

**How to interpret the screenshot:** `526,300.493 / 343,589.844` is
mathematically **1.532×, or +53.2%**. The percentage is correct, but the two
numbers do not come from the same A/B series: 343,589.844/s was a historical
AVX-512 run, while 526,300.493/s was a short smoke test of the later scanner
batch path. The reliable direct software comparison is therefore
447,343.589 → 520,437.272/s, or **1.163× / +16.339%**.

### Why a GPU is not always faster

- Metal becomes faster in the measured product path at **2,048 points**. At
  1,024 points, Metal was **27.315% slower** than the CPU. The dispatcher
  therefore uses the CPU below the threshold and Metal above it; errors always
  fall back to the CPU.
- On the Pixel, the optimized Vulkan GPU was **3.65× slower** than the
  nine-worker CPU path despite producing correct results.
- Simultaneous Pixel CPU+GPU execution had a median result **3.75% below**
  CPU-only and increased the thermal state. It was rejected.
- The RTX 5090 sustained run reached **100% median and average GPU
  utilization**. Memory-controller utilization was 0%; power averaged 507.87 W
  and peaked at 540.40 W out of 550 W, with a maximum temperature of 63 °C.
  The kernel was compute, register, and power limited rather than
  memory-bandwidth limited.
- CUDA is currently a validated benchmark backend, **not yet a production
  wallet path**.

### Real mainnet synchronization

The wallet was restored from height 3,577,876 over the real
Panama-to-Germany connection. A run is accepted only if the wallet and node
finish cleanly on the same chain.

| Path | Synchronization time | Blocks/s | Factor vs original duration | Comparison quality |
| --- | ---: | ---: | ---: | --- |
| Original Monero Wallet, current-core P0085 R1 | 750.875 s | 215.113 | **1.00×** | Current strict baseline; same frozen tip and 161,523 blocks |
| Monero Fast Wallet gRPC, current-core P0085 R1 | 214.903 s | 751.609 | **3.49×** | Current strict comparison; same frozen tip and 161,523 blocks |
| ScanPack, current-core P0085 R1 | 57.640 s | 2,802.273 | **13.03×** | Current strict comparison; same frozen tip and 161,523 blocks |
| Original Monero Wallet, R3 | 1,007.483 s | 146.06 | **1.00×** | Valid baseline |
| Monero Fast Wallet gRPC, R3 | 375.166 s | 392.25 | **2.69×** | Strict comparison with the same restore contract |
| ScanPack C0, median of 3 runs | 173.760 s | 848.01 | **≈5.80×** context | Different live tip; not a strict R3 A/B test |
| ScanPack D4, 32 MiB window, median of 3 runs | 144.452 s | 1,020.734 | **≈6.97×** context | Accepted D4 median; live tip moved |
| ScanPack D5.3, 4 physical TCP lanes | 139.169 s | 1,059.633 | **≈7.24×** context | Fastest single run; experimental |

Additional measured subpaths:

| Subpath | Result | Interpretation |
| --- | ---: | --- |
| Parallel fast-hash prefetch | 246,240.61 vs 17,287.09 hashes/s | **14.24×**, but only one synchronization phase |
| Raw ScanPack transport with CUBIC | 34.99 MiB/s | Real payload transport, not wallet processing |
| Raw ScanPack transport with gRPC-specific BBR | 64.59 MiB/s median | **1.846× / +84.6%** vs CUBIC; not a wallet synchronization rate |
| Wallet cryptography: Rust 10 workers vs 1 worker | 4.92× Rust batch time | The existing C++ pool was already nearly as fast |

The product measurement with 7.45 million derivations also showed that the
existing C++ pool already used the CPU almost as effectively as the new
10-worker Rust batch: 32,819 ms versus 32,877 ms of key-derivation time. The
batch reduced FFI calls from approximately 7.45 million to 596, but did not
produce a measurable phase improvement and was therefore not made the default.

### Is hardware acceleration faster in a real wallet than in the testbench?

**Not automatically. The assumption is only partly correct.**

The private view scalar `a` is constant for a wallet and can be prepared once
per wallet and processed block window. Every transaction still has its own
public transaction key `R`; subaddress or multi-destination transactions can
contain additional keys. `D = 8 × a × R` must still be calculated for every
distinct key.

Work that can be reused or amortized in practice:

- Prepared scalar representation
- One-time decoding of a block window
- Collection and deduplication of identical transaction keys
- One derivation reused for multiple outputs of the same transaction
- Persistent worker pools, workspaces, and larger hardware batches
- Shared block retrieval for multiple hosted watches at the same cursor

Work that is still required for every transaction key:

- Point decoding or prepared point data
- Elliptic-curve scalar multiplication
- Multiplication by the cofactor 8
- Compression followed by output and view-tag checks

A pure cryptographic testbench is therefore normally the **upper limit of the
kernel**. A real wallet also performs networking, parsing, database operations,
queueing, FFI, transaction caching, and chain commits. Large restore windows
or many grouped hosted watches can benefit more from batching than a naive
per-item path, but the end-to-end acceleration factor is usually smaller than
the cryptographic factor because of the additional work.

Monero's official implementation decodes `R`, multiplies it by the view
scalar, multiplies the result by 8, and compresses it again:
[`generate_key_derivation`](https://github.com/monero-project/monero/blob/master/src/crypto/crypto.cpp).
The wallet core creates the primary and any additional derivations for the
transaction keys before it checks outputs. A detailed explanation is available
in [Zero to Monero, chapter 4](https://www.getmonero.org/library/Zero-to-Monero-2-0-0.pdf).

### Reproducibility and complete results

- [Testbench Index](docs/WALLET_ACCELERATION_TESTBENCH_INDEX.md)
- [CPU: M4 and EPYC](docs/WALLET_CRYPTO_CPU_TESTBENCH_RESULTS.md)
- [M4 CPU: Final Batch Path](tools/wallet-derivation-cpu-testbench/M4_CPU_RESULTS_20260725.md)
- [Apple Metal](docs/WALLET_CRYPTO_METAL_TESTBENCH_RESULTS.md)
- [Metal Product Integration](docs/DESKTOP_METAL_BACKEND_PACKAGING_2026-07-25.md)
- [Pixel 8 Pro CPU and Vulkan](tools/wallet-mobile-acceleration-testbench/PIXEL_8_PRO_RESULTS.md)
- [RTX 3090 and RTX 5090 CUDA](tools/wallet-cuda-testbench/RESULTS-2026-07-25.md)
- [Hosted Scanner on EPYC](docs/HOSTED_VIEW_KEY_SCANPACK_EPYC_2026-07-25.md)
- [Mainnet Synchronization and ScanPack](docs/WALLET_SYNC_BENCHMARK_RESULTS.md)
- [Raw Artifacts](docs/benchmark-evidence/2026-07-25)

All accepted cryptographic runs compare their output byte-for-byte against a
reference, validate the error path for invalid points, and use no real wallet
keys. CUDA C7/C11 passed checksum validation; the RTX 5090 C7 runs also passed
CUDA `memcheck` and `initcheck` without errors.

## Platform status

“Implemented” means that source code and focused tests exist; it does not
automatically mean that an end-user artifact has been released.

| Platform | Current status | Still required before release |
| --- | --- | --- |
| iOS | React Native app, native Monero core build path, native recovery input, app protection, BLE transport, and push contract are present | Physical wallet, Ledger, APNs, lifecycle, accessibility, and App Store validation |
| Android | React Native app, JNI/core, USB/HID, BLE, Keystore, native recovery input, and release build path are present | Physical wallet, Ledger, FCM, device, accessibility, and Google Play validation |
| macOS | Tauri 2 app with locally linked core; create/open/seed/subaddress tested; Metal backend packaged | Sign, notarize, staple, and repeat wallet, Ledger, and push validation for the exact app |
| Windows | UI, Rust host, protection contracts, and notification-agent contracts are present | Build and load the native core as a DLL, then complete wallet, Ledger, push, and installer validation |
| Linux | ARM64 AppImage assembled locally with the core; DBus agent contract is present | Clean-user, real-node, Ledger, notification, and package validation |
| Services | Scanner, Gateway, Monero Fast Node, and the replacement Monero Enthusiast V1 service stack exist as separate components; V1 API, private Synapse and signed sequence-1 catalogs are live and smoke-tested | Validate backups, rotation, restore, load, abuse operations, reorganization handling, provider delivery, and monitoring |

All five app targets are built from one authenticated Monero Core patch tree.
Mobile link manifests carry the exact tree identity, Unix desktop builds verify
the source tree, and Windows requires a matching DLL identity sidecar. Builds
fail instead of silently using an older Core. The current Apple-Silicon wallet
lifecycle reference is about **179 ms median / 194 ms P95** to create a wallet
and its primary address; address reads, validation, and subaddress generation
are below 1 ms. UI, AppVault, registry, and network time are measured
separately from this native Core budget.

The precise, auditable status is documented in
[Platform Integration Status](docs/PLATFORM_INTEGRATION_STATUS.md) and the
[Desktop/Mobile Parity Matrix](docs/DESKTOP_PARITY_MATRIX.md).

## Security

Important non-negotiable boundaries:

- No seeds or private spend keys on servers
- No wallet keys or wallet files in React Native or React
- No generic shell, file-system, or credential-store permission for the
  desktop renderer
- No transaction details in push payloads
- No primary-wallet view key in Fast Receive
- No exact coordinates in the Community service
- TLS with normal certificate validation for Scanner, Push, News, and
  Community
- Local wallet verification always remains authoritative
- Monero transaction format, addresses, spending rules, and consensus remain
  unchanged

The security review found historical critical, high, and medium issues. The
central source-code mitigations are implemented, but operational and physical
validation and an independent review are still pending. The current status is
therefore explicitly **MAINNET NO-GO**.

Documents:

- [SECURITY.md](SECURITY.md)
- [Threat Model](docs/THREAT_MODEL.md)
- [Security Audit](docs/SECURITY_AUDIT_2026-07-24.md)
- [Secure Release Checklist](docs/SECURE_RELEASE_CHECKLIST.md)
- [Incident Response](docs/SECURITY_INCIDENT_RESPONSE.md)

## Monorepo layout

This repository is the product and integration monorepo:

```text
apps/
  mobile/                         React Native for iOS and Android
  desktop/                        React + Tauri 2 for desktop

native/
  monero-bridge/                  C++ WalletEngine, iOS, and Android bridges
  desktop-bridge/                 small Rust ↔ C++ C ABI

packages/
  wallet-shared/                  shared wallet and synchronization rules

backend/
  fast-wallet-stack/              versioned build, migration, and deployment contracts
  fast-wallet-worker/             outbound encrypted hosted-view-key scanner
    scanner-core/                 internal Worker scan engine; no server API
  fast-wallet-directory/          public Worker admission and descriptor directory
  fast-wallet-relay/              ciphertext-only Worker mailbox
  mfw-private-directory/          release-gated private contact-directory components
  notification-registration-adapter/ attested provider registration
  notification-gateway/          opaque WSS/push delivery
  enthusiast-v1/                 replacement V1 publication/contact API
  enthusiast-moderation-console/ loopback-only moderation interface
  enthusiast-operations/         isolated operations and catalog tooling
  enthusiast-discovery/          disabled legacy Community reference
  monero-news/                    cache of official Monero news

node/
  mfn-monero-fast-node/           integrated Monero Fast Node engine snapshot

third_party/
  monero-patches/                 ordered Monero product patches
  cuprate-patches/                ordered Monero Fast Node engine patches
  curve25519-dalek-wallet-cpu/    reproducible CPU patches
  monero-experimental-patches/    separate research snapshots

tools/
  mfw-miner/                      MFM: Monero Fast Miner and RandomX benchmark suite
  wallet-original-crypto-testbench/
  wallet-crypto-testbench/
  wallet-derivation-cpu-testbench/
  wallet-metal-testbench/
  wallet-metal-product-testbench/
  wallet-mobile-acceleration-testbench/
  wallet-cuda-testbench/
  wallet-testbench/

ops/
  cuprate-sync-benchmark/

docs/
  product, architecture, security, release, and benchmark documents
```

The upstream provenance and reproducibility metadata are kept inside this
repository. `third_party/monero-patches/` and
`third_party/cuprate-patches/` contain ordered patch series and pinned base
revisions; `node/mfn-monero-fast-node/` is the only MFN source tree used by
this product. Patch reproduction verifies the expected source tree before a
core is built. Generated dependencies, wallet files, secrets, logs, and build
outputs do not belong in Git.

Learn more:
[Sources](docs/SOURCES.md) ·
[Repository Strategy](docs/REPOSITORY_STRATEGY.md) ·
[Local Consolidation Record](docs/LOCAL_WORKTREE_CLEANUP_2026-07-26.md)

## Local development and testing

### Requirements

- Node.js **22.11 or newer**
- The npm version appropriate for each lockfile
- Rust from [rust-toolchain.toml](rust-toolchain.toml)
- Xcode for iOS and macOS
- Android SDK/NDK and Java for Android
- Native Monero dependencies required by the build scripts
- CUDA Toolkit only for the CUDA research testbench

### Mobile

```bash
cd apps/mobile
npm ci
npm run lint
npm test -- --runInBand
```

Build paths:

```bash
npm run ios:build-simulator-core
npm run android:build
```

### Desktop

```bash
cd apps/desktop
npm ci
npm run build
npm run test:parity-contract
npm run test:platform-contract
npm run test:wallet-contract
npm run test:push-contract
cargo test --locked --manifest-path src-tauri/Cargo.toml
```

For macOS development with a locally prepared Monero core:

```bash
npm run dev:wallet
```

### Services

Each Rust service has its own `Cargo.toml` and lockfile. For example:

```bash
cargo test --locked --manifest-path backend/fast-wallet-worker/scanner-core/Cargo.toml
cargo test --locked --manifest-path backend/notification-gateway/Cargo.toml
cargo test --locked --manifest-path backend/enthusiast-v1/Cargo.toml
cargo test --locked --manifest-path backend/enthusiast-moderation-console/Cargo.toml
cargo test --locked --manifest-path backend/enthusiast-operations/Cargo.toml
cargo test --locked --manifest-path backend/monero-news/Cargo.toml
```

Never use a real wallet, seed, or production key in a testbench, log, or issue.

### Shared Product-Core ABI and diagnostics

The product CLI, React Native native adapters and Tauri use ABI version 1 from
`native/product-core`. Its schemas generate byte-identical C, Rust,
TypeScript, Kotlin and Swift contracts. The same registry defines diagnostic
IDs, profiles, timeouts, measurements, success criteria and existing runner
adapters; unknown result fields fail closed. Run its complete local gate with:

```bash
bash native/product-core/scripts/run-testbench.sh
```

### Most recently documented broad validation

| Area | Result |
| --- | --- |
| Mobile | 28 Jest suites / 131 tests passed; lint passed |
| Desktop renderer and platform contracts | Build and 42 contracts passed |
| Desktop Rust | 30 tests passed; 1 real credential-store test deliberately ignored |
| Legacy Community live check | 11/11 historical contract checks passed; this is not Monero Enthusiast V1 acceptance |
| Native bridge | ASan and UBSan smoke/hostile-input checks passed |
| Supply chain | npm audits found no known vulnerabilities; Rust exceptions are explicit and time-limited |
| Benchmarks | Accepted CPU, Metal, Vulkan, and CUDA output was validated byte-for-byte |

These numbers describe the documented audit revision, not automatically the
current state of a later modified working copy.

## Documentation

- [V1 Execution Plan](docs/V1_EXECUTION_PLAN.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Native Wallet Bridge](docs/NATIVE_WALLET_BRIDGE.md)
- [Desktop/Mobile Parity](docs/DESKTOP_PARITY_MATRIX.md)
- [Backend Testing](docs/BACKEND_TESTING.md)
- [Release Gates](docs/RELEASE_GATE_MATRIX.md)
- [Benchmark Index](docs/WALLET_ACCELERATION_TESTBENCH_INDEX.md)
- [Open Source And Sustainable Funding](docs/OPEN_SOURCE_AND_SUSTAINABILITY.md)
- [Decentralized Private View-Key Hosting](docs/DECENTRALIZED_PRIVATE_VIEW_KEY_HOSTING.md)
- [Fast Wallet Slot, Recovery, And Private Workers](docs/FAST_WALLET_SLOT_RECOVERY_AND_PRIVATE_WORKERS.md)
- [Public Service Directory, Relay, And Mempool](docs/PUBLIC_SERVICE_DIRECTORY_RELAY_AND_MEMPOOL.md)
- [Directory/Relay/Worker Architecture Audit](docs/DIRECTORY_RELAY_WORKER_ARCHITECTURE_AUDIT_2026-07-26.md)

## Project principles

1. **Self-custody first.**
2. **Ease of use is a security feature.**
3. **No fabricated wallet, Community, or service data.**
4. **Fast paths must be correct, reproducible, and able to fall back safely.**
5. **A benchmark is only as useful as its clearly stated measurement boundary.**
6. **Server signals never replace local wallet verification.**
7. **Compatibility with Monero is more important than a proprietary shortcut.**
8. **Project-authored software is open source; revenue comes from operation,
   sponsorship, and optional merchant services, never wallet-private data.**

---

**Repository:** <https://github.com/tex8com/monero-fast-wallet><br>
**Monero fork:** <https://github.com/tex8com/monero><br>
**MFN source:** [`node/mfn-monero-fast-node/`](node/mfn-monero-fast-node/)<br>
**MFM source:** [`tools/mfw-miner/`](tools/mfw-miner/)
