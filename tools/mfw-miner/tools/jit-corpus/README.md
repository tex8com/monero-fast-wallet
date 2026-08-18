# MFW RandomX JIT corpus profiler

This developer-only tool records the exact mapping from each RandomX virtual
instruction to the native bytes emitted by the active AArch64 or x86-64 JIT.
It is compiled out of normal builds unless `WITH_MFW_JIT_CORPUS=ON` is set.

The entrypoint is offline and is intercepted before normal miner, pool, DNS,
donation, or share-submission initialization.

## Natural corpus and differential correctness

```sh
cmake -S . -B build-jit-corpus -G Ninja \
  -DWITH_MFW_JIT_CORPUS=ON -DWITH_OPENCL=OFF -DWITH_CUDA=OFF
cmake --build build-jit-corpus
./build-jit-corpus/mfw-miner \
  --jit-corpus-profile corpus.ndjson \
  --jit-corpus-version both \
  --jit-corpus-programs 1000
python3 tools/jit-corpus/analyze.py corpus.ndjson \
  --json corpus-summary.json --markdown corpus-summary.md
```

Each generated hash is checked against the independent interpreter. RandomX
v1 records 256 virtual instructions per program and v2 records 384. The NDJSON
contains entropy, decoded virtual instructions, native offsets, and native
bytes. The analyzer rejects gaps, overlaps, malformed code ranges, incorrect
program sizes, unhealthy producer output, and broken sequence numbers.

`--jit-corpus-v2-tweak-mask` is a diagnostic-only four-bit mask
(`CFROUND=1`, `AES=2`, `PREFETCH=4`, `COMMITMENT=8`). Its default is `15`, the
real v2 behavior. Non-default values exist solely to isolate differential
failures and must never be used for performance claims.

## Stable replay for counters and PC sampling

```sh
tools/jit-corpus/profile-macos.sh \
  build-jit-corpus/mfw-miner \
  benchmark-results/jit-corpus/m4-v2-counters \
  2 1000 16
```

For every deterministic program, replay first compares the JIT and interpreter,
including the complete 2 MiB scratchpad and register file. It then repeatedly
executes that compiled code before advancing to the next program. Per-program
time windows make the reused JIT address range unambiguous in Time Profiler.
Run v1 and v2 separately because both reuse the same JIT address range.

The replay currently exercises RandomX light mode so it can run without a
2+ GiB initialized dataset. It validates the profiler and instruction body,
but it must not be used to claim Fast-mode mining H/s or dataset-memory costs.
Those require the matched offline Fast benchmark harness.

For exact PC attribution, select the Time Profiler template. The wrapper then
exports its samples and maps anonymous AArch64 PCs back to RandomX instruction
types and virtual PCs:

```sh
MFW_XCTRACE_TEMPLATE='Time Profiler' tools/jit-corpus/profile-macos.sh \
  build-jit-corpus/mfw-miner benchmark-results/jit-corpus/m4-v2-time 2 1000 16
```

## Linux perf on AMD, Intel, and ARM64

The Linux wrapper uses unprivileged `cycles:u` sampling and the same
per-program monotonic replay windows. It never installs packages, invokes
`sudo`, changes MSRs, reserves huge pages, or stops services. If the host's
`perf_event_paranoid` policy denies access, it fails closed.

```sh
tools/jit-corpus/profile-linux.sh \
  build-jit-corpus/mfw-miner benchmark-results/jit-corpus/epyc-v2-perf \
  2 1000 16
```

`analyze-perf.py` maps the sampled native PCs to program sequence, virtual PC,
and RandomX instruction type. Counter samples are statistical and the replay
is Light mode; final Fast-mode H/s decisions still require the separate,
matched, offline benchmark harness.

Run the platform-independent resolver regression with:

```sh
python3 tools/jit-corpus/test-analyzers.py
```

It deliberately reuses the same native JIT address for two different programs
and proves that both resolvers select the correct instruction through the
program's replay time window.

## AArch64 CBRANCH research mode

`MFW_A64_CBRANCH_MODE=1` forces the Apple Silicon candidate that emits
the 32-bit `TST` form for CBRANCH. Every legal RandomX condition mask occupies
bits 8..30, so this preserves the branch decision, instruction count, branch
displacement, and all generated-code addresses. Validate the actual emitted
corpus with:

```sh
python3 tools/jit-corpus/verify-a64-cbranch.py corpus.ndjson --mode 1
```

Mode 0 remains the upstream 64-bit `TST`. The candidate is not promotable from
code shape or Light replay timing; M1 and M4 require separate matched Fast-mode
ABBA/BAAB decisions.

`MFW_A64_CBRANCH_MODE=2` is the production profile: it selects the measured
32-bit form only when macOS reports an Apple M4-family brand string. Apple M1
and unknown AArch64 CPUs fail closed to the upstream 64-bit form.
