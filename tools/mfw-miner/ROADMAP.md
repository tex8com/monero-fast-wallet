# MFW-Miner Roadmap

Status: active development, 2026-08-15.

MFW-Miner is a GPLv3 fork of XMRig. The production engine starts from XMRig
`v6.26.0`, commit `b2ca72480c58d197e18c885d9fc1a0c8d517e60a`. The archived
pure-Rust prototype is not a production backend.

The goal is to beat upstream XMRig where reproducible architecture-specific
changes make that possible, while also providing better automatic tuning,
benchmark evidence, CLI/Desktop integration, pool and solo workflows.

## Donation policy and remaining release gates

- [x] Record the public standard Monero mainnet receiving address:
  `49aaK7WgMCQABhjHt1UyXijKRwbjjbtSq2xbDbB4AgYLGqtXpudonJq58aM4j7fhTWdph4LD7VxjpEwEzBXBdzK2K9vybrL`.
  Never store or request a seed, private spend key or private view key.
- [x] Set the disclosed official-build donation-mining percentage to **1% of
  mining time**.
- [x] Select a stable MFW Donation Gateway so the backend can change between a
  conventional pool, P2Pool and coordinated solo mining without changing the
  endpoint shipped in the miner.
- [x] Keep the public donation wallet address in validated server-side gateway
  configuration, not in the miner binary. Official miners contain only the
  redundant gateway endpoints plus the disclosed 1% scheduler; pool, P2Pool or
  solo backend selection and payout credentials remain gateway-controlled.
- [ ] Complete the first-run disclosure and final official-build enablement
  decision before production release.
- [ ] Deploy at least two health-checked gateway instances and prove that the
  miner fails open to the user's work when all gateways are unavailable.
- [ ] Obtain operator approval before sending fleet traffic to any third-party
  pool.

Donation mining remains hard-disabled in the miner until the remaining release
gates pass. Every current miner hash therefore still uses the wallet address
configured by the user, and the inherited XMRig donation endpoint must not be
reached by an MFW-Miner build.

## Mandatory upstream-reference rule

- [ ] Every hardware comparison includes an unmodified, pinned XMRig reference
  and the MFW fork candidate.
- [ ] Both sides use the same host state, RandomX variant, thread count,
  measurement size/duration, affinity and huge-page/MSR mode.
- [ ] Promotable comparisons use interleaved `A/B/B/A` and `B/A/A/B` order.
- [ ] Store source revisions, binary hashes, compiler/build flags, raw output,
  thermals/load and the official RandomX result hash.
- [ ] A result without its matched upstream reference is `exploratory` and
  cannot support a faster-than-XMRig claim.

## Phase 1 — Establish the fork

- [x] Replace the experimental Rust engine with pinned XMRig `v6.26.0`.
- [x] Preserve the existing benchmark harness and host evidence.
- [x] Rename product, executable, configuration and API identity to MFW-Miner
  without erasing upstream copyright or provenance.
- [x] Hard-disable donation until the public address and percentage are set.
- [x] Add the standalone Rust `mfw-donation-gateway` with strict address
  validation, Stratum credential rewriting, TLS upstreams, explicit failover,
  loopback-only authenticated backend switching and local mock integration
  tests.
- [ ] Build and validate official offline `rx/0` hashes on macOS and Linux.
- [ ] Add a machine-readable MFW-vs-upstream comparison ledger.
- [ ] Define the separate Rust controller/IPC protocol used by CLI and Desktop.
- [ ] Keep the GPL miner process separate from the MPL wallet application.

## Phase 2 — Apple M4

### JIT architecture

- [x] Keep one consensus-correct RandomX implementation and generic fallback;
  never fork RandomX semantics per processor.
- [ ] Maintain shared JIT backends per instruction set (`AArch64` and `x86-64`)
  with small runtime-selected microarchitecture profiles instead of a separate
  source fork for every CPU SKU.
- [ ] Add explicit profiles for Apple M4, relevant Cortex/Raspberry Pi and ARM
  Neoverse generations, AMD Zen 3/4/5 and the tested Intel generations.
- [ ] Let each profile select only measured code generation details such as
  instruction form/order, register allocation, code layout, branches and
  prefetch distance. Unknown CPUs must select the generic upstream-compatible
  profile.
- [ ] Require official RandomX hashes plus interleaved upstream A/B evidence on
  every profile and automatically fall back when detection or validation is
  uncertain.

- [x] Establish upstream XMRig thread-sweep and 250K reference results.
- [x] Establish the first upstream-versus-fork interleaved comparison and
  reject it from performance claims because of severe sustained drift.
- [x] Screen interactive worker QoS in `B/A/A/B` order and reject it as the
  default after a measured 1.655% loss.
- [x] Profile RandomX JIT, scratchpad AES, dataset access and worker scheduling;
  93.14% (10 threads) and 94.15% (4 threads) of sampled worker time is in
  generated ARM64 JIT code.
- [x] Backport RandomX ARM64 `ISUB_R` correctness fix `0dea273`; screen the
  Group-E `BIF` JIT optimization `9fbab826` and reject its compact form on M4.
- [x] Re-audit the earlier M4 Group-E `BIF` result. The former +1.6838%
  C-A-A-C screen did **not** preserve XMRig's VM-code start: four prologue
  NOPs plus the extra mask instruction moved it by four bytes. Treat that
  historical result as invalid for promotion.
- [x] Correct the test-only candidate to three prologue NOPs, statically prove
  the same initial VM-code start (`0x170`) and run a cold four-worker
  A-B-B-A screen. It passed every 100K hash but measured -1.4287% by block
  mean (-1.4270% paired geometric), so it remains disabled.
- [x] Run the first opposite-order 10-thread A-B-B-A/B-A-A-B validation. Strong
  thermal drift made the two blocks disagree (+2.99% versus -2.63%); the
  symmetric estimate was effectively neutral (+0.14%). Do not enable this
  candidate for the 10-thread profile.
- [x] Screen layout-stable Group-E mode 3, which retains the exact reference
  instruction address after every generated `FDIV`. It passed all hashes but
  lost 4.7421% by block mean (4.8542% paired-geometric) at four threads, so hot
  per-instruction NOP padding is rejected. Runtime profile selection must patch
  compact templates without executing padding in the RandomX hot path.
- [x] Add an ARM64 JIT dataset-prefetch selector; the first correct exploratory
  M4 screen measured a 33.0% loss with the hot-loop prefetch disabled.
- [x] Reject the corrected three-NOP Group-E candidate for M4 after its valid
  cold four-performance-core block measured -1.43%. A later opposite-order
  attempt was contaminated by concurrent filesystem/Android work and is
  excluded; it does not overturn the valid negative block.
- [ ] Validate the independent default-off M4 front-end load-scheduling
  candidate after the foreign Android build and a sustained passive cooldown.
  Its static main-loop and VM-code offsets match the reference; no H/s result
  exists yet.
- [ ] Validate performance/efficiency-core topology and macOS QoS policies.
- [ ] Investigate Apple-specific AArch64 code generation, prefetch and code
  placement without changing RandomX consensus output.
- [x] Add the first production microarchitecture selector. Korpus-guided
  `CBRANCH` changes from `TST x` to bit-equivalent `TST w` only on Apple M4;
  M1 and unknown AArch64 CPUs fail closed to the upstream form. Two cold M4
  orderings measured +0.2893% combined, while M1 measured -0.2239% and is
  therefore explicitly excluded from the optimization.
- [x] Complete matched maximum-throughput Apple comparisons: M4 10-thread
  MFW 4,120.55 versus XMRig 4,117.60 H/s; M1 8-thread MFW 1,012.65 versus
  XMRig 1,012.30 H/s. Both are technical parity, not a broad faster claim.
- [ ] Record sustained H/s and H/s/W when privileged power telemetry is
  explicitly available.

## Phase 3 — Server and architecture matrix

- [x] Ryzen 9 5950X upstream baseline and retained 31-thread configuration.
- [x] Xeon E3-1585L v5 upstream Fast-mode 250K reference.
- [x] TEX8 EPYC reference during controlled quiet windows, with all recorded
  application services restored and health-checked after every window. At
  12 workers/250K/no HugeTLB, official XMRig measured 5,249.2/5,084.0 H/s
  against MFW mode 0 at 5,151.9/5,163.4 H/s (-0.17%; no claim because XMRig
  drift was 3.20%).
- [ ] Raspberry Pi ARM64 work is intentionally paused by operator decision.
  The attempted reference produced no valid H/s result and must not be resumed
  without a new explicit request.
- [x] Optimize the guest-visible TEX8 EPYC worker count and screen 2 MiB
  HugeTLB: 12 workers retained; fully allocated 2 MiB pages measured -0.95%
  in a noisy corrected A-B-B-A block and remain disabled. Physical NUMA,
  CCD/cache ownership and memory channels are not exposed by this KVM guest
  and cannot be tuned defensibly here.
- [x] Correct Family 19h Model 10h-1Fh/A0h-AFh detection so EPYC 9634 Model
  11h is selected as Zen 4 instead of Zen 3. TEX8 GCC syntax/object builds and
  full offline MFW hashes pass using pinned user-local libuv.
- [x] Add a default-off Zen-4 AVX-512VL Group-E JIT prototype with explicit
  AVX512F/AVX512VL/OS-state runtime gates, proven `VPTERNLOGQ 0xEA` truth table
  and unchanged SSE fallback. Both paths passed offline hashes. The 12-worker
  250K screen showed +1.05% versus XMRig once but failed the 2% control-drift
  gate; the direct matched-build block was -3.05% with high drift. Mode 1
  remains default-off.
- [x] Run the first quiet TEX8 maintenance-window A-B-B-A JIT screen at four
  workers. Upstream SSE averaged 1,740.25 H/s and MFW AVX-512VL averaged
  1,674.35 H/s (-3.7868%; paired geometric -3.7836%). Keep the candidate
  default-off and require a later B-A-A-B confirmation plus an unmodified
  XMRig packaging reference.
- [ ] Optimize Intel AES-NI/AVX2, BMI2 and relevant AVX-512 generations.
- [x] Add a default-off Skylake-S `ISWAP_R` JIT candidate that replaces
  register `XCHG` with three `MOV`s only on Intel Model 5Eh with AVX2/BMI2.
  All nine 250K hashes passed; the load-contaminated ABBA/BAAB aggregate was
  +1.5057%, so promotion requires a quiet confirmation.
- [x] Run the quiet-gated ISWAP ABBA+BAAB confirmation. Its aggregate was
  +2.88%, but the opposite-order half reversed to -1.37%, while mode-0 and
  mode-1 ranges were 9.14% and 4.42%. Keep ISWAP default-off; a thermally
  controlled environment is required before any retest can be promotable.
- [x] Apply a microarchitecture stopgate before adding another Skylake mode.
  The next plausible `IMUL_RCP` form has the same two µops and modeled
  throughput but grows from 6 to 14 bytes; exact `FDIV_M`/`FSQRT_R` have no
  shorter bit-exact instruction. Do not add speculative code until the ISWAP
  candidate passes or fails its quiet retest.
- [x] Close the Skylake ISWAP retest under stable warm controls: Mode 0
  2,373.60 versus Mode 1 2,371.65 H/s (-0.0822%). Reject the candidate. The
  direct XMRig/MFW block is 2,368.85 versus 2,357.35 H/s (-0.4855%), so Intel
  remains an open optimization target.
- [ ] Validate ARM Neoverse, additional Apple Silicon and RISC-V 64.

## Phase 4 — Pool, solo and product integration

- [ ] Harden Stratum/TLS reconnect, job replacement, nonce allocation, target
  checking and share submission.
- [x] Create a backend-independent Rust donation gateway; keep its example
  configuration local-only and all public backends disabled.
- [ ] Implement the Stratum-compatible Rust solo coordinator backed by trusted
  `monerod` JSON-RPC (`get_block_template` and `submit_block`) with collision-free
  work allocation. A raw daemon is not a Stratum backend.
- [ ] Add public client TLS termination, regional gateway failover, rate limits
  and abuse monitoring without wallet or source-IP retention.
- [ ] Wire the miner's disclosed 1% scheduler to the gateway only after the
  fail-open and first-run disclosure tests pass.
- [ ] Add an independently verified solo-mining path through Monero daemon RPC.
- [ ] Implement the Rust CLI/controller and authenticated local IPC.
- [ ] Integrate with MFW Desktop without linking GPL engine code into the MPL
  wallet process.
- [ ] Add transparent presets for quiet, balanced and maximum-performance modes.

## Phase 5 — Public benchmark network

- [ ] Define a signed benchmark schema and reproducibility rules.
- [ ] Ask for explicit first-run consent before uploading anything.
- [ ] Upload only minimized hardware facts, OS/architecture, miner version,
  settings and H/s; never wallet addresses, credentials or device identifiers.
- [ ] Add abuse resistance, duplicate detection, retention and deletion rules.

## Release gates

- Official RandomX hashes pass on every advertised backend.
- Pool and solo mining never redirect work to an undisclosed address.
- Donation behavior is local, visible and deterministic.
- Every binary ships corresponding GPL source access and upstream notices.
- Every performance claim has a matched, unmodified XMRig reference.
- Services stopped for benchmarks are restored and health-verified.
