# Apple M4 RandomX profile, 2026-08-15

## Result

Two short profiles of the MFW-Miner XMRig fork place **93-94% of worker
samples directly in anonymous ARM64 JIT code**. The highest-value M4 work is
therefore generated-code and memory-latency tuning, not CLI, networking,
worker-control or general C++ cleanup.

Both profiled thread counts completed the offline Monero `rx/0` Fast-mode
100K correctness vector with hash `BC4EF98B60B98579`. Network access was
denied by the macOS sandbox. No pool or daemon endpoint was configured, no
foreign process was stopped, and no source file was changed by this profiling
task.

The observed rates are diagnostic only. The host was not benchmark-quiet,
`sample` adds overhead, and a matched XMRig reference was not interleaved in
this specific profiling window. They must not be used in performance claims.
The repository's existing pinned XMRig references remain the correctness and
baseline reference, but do not make these profiled rates promotable.

## Profiled artifact

| Field | Value |
|---|---|
| Product | MFW-Miner 0.1.0 |
| Engine | XMRig 6.26.0, upstream commit `b2ca72480c58d197e18c885d9fc1a0c8d517e60a` |
| Profiled binary SHA-256 | `b10a09a88dfcfc9710bde1f8954ad63dbb34c4deb82f6726caed68a64e5833bb` |
| Binary format | Mach-O ARM64 |
| Build | Release, `-O3 -DNDEBUG`, ASM and hwloc enabled |
| Worker policy | `MFW_APPLE_WORKER_QOS=0`, upstream scheduling |
| Secure JIT | disabled in the profiled build |
| Compiler | Apple clang 21.0.0 |
| Libraries | libuv 1.52.1, OpenSSL 3.6.3, hwloc 2.14.0 |

The shared worktree was being used in parallel. After the profiles completed,
another task rebuilt `build-mfw-m4/mfw-miner` with a different binary hash.
The SHA-256 above, not the mutable build path, is the authoritative identity
of the profiled artifact. The raw profiles also contain their launch times.

## Machine topology and state

| Item | Value |
|---|---:|
| CPU | Apple M4, ARM64 |
| Physical/logical cores | 10 / 10 |
| Performance cluster | 4 cores, shared 16 MiB L2, 192 KiB L1I and 128 KiB L1D reported per core |
| Efficiency cluster | 6 cores, shared 4 MiB L2, 128 KiB L1I and 64 KiB L1D reported per core |
| Cache line | 128 bytes |
| Memory | 16 GiB installed |
| OS/kernel | macOS 26.5.2 / Darwin 25.5.0 arm64 |
| Power | AC, battery charged |
| Thermal API | no warning; no quantitative package temperature/power exposed |

Preflight load average was approximately `2.85 2.51 4.36`, with WindowServer,
ChatGPT/Codex and ordinary desktop services active. Postflight load was higher
because other repository tasks were also running. No attempt was made to stop
them. This invalidates throughput comparison but does not hide the dominant
in-process call-path distribution.

RandomX allocated 2,336 MiB (`2080+256`) with JIT and no Huge Pages. Dataset
initialization used ten threads for both profiles. Mining used the requested
four or ten workers, each with a 2 MiB scratchpad.

## Commands and correctness

The miner command for each run was executed through:

```sh
sandbox-exec -p '(version 1)(allow default)(deny network*)' \
  ./build-mfw-m4/mfw-miner \
  --bench=100K -a rx/0 --randomx-mode=fast --threads=THREADS --no-color
```

Profiling commands were:

```sh
sample PID 10 20 -fullPaths -file /dev/stdout   # four workers
sample PID 8 50 -fullPaths -file /dev/stdout    # ten workers
ps -M -p PID -o pid,%cpu,state,pri,nice,time,comm
```

`taskinfo` was attempted read-only but requires root on this macOS build, so it
was not used and no privilege escalation was attempted.

| Run | Threads | Correct hash | Core time | Reported rate | Status |
|---|---:|---|---:|---:|---|
| full initial profile | 10 | `BC4EF98B60B98579` | 29.563 s | 3382.6 H/s | exploratory |
| compact saved profile | 10 | `BC4EF98B60B98579` | 29.477 s | 3392.5 H/s | exploratory |
| compact saved profile | 4 | `BC4EF98B60B98579` | 44.239 s | 2260.4 H/s | exploratory |

The compact profiles are the preserved raw evidence. The initial 15-second,
5-ms ten-thread profile produced an unnecessarily large call graph and is not
retained; it independently showed the same JIT dominance.

## Quantified hotspots

`sample` cannot symbolicate per-hash RandomX JIT buffers, so they appear as
worker-specific `<unknown binary>` address ranges. The addresses are outside
the static MFW-Miner Mach-O image, and every range is reached directly from a
RandomX worker. They are therefore attributed to generated JIT code, not to
an unknown third-party module.

| Profile | Worker samples | JIT-buffer samples | JIT share | Native worker-entry share |
|---|---:|---:|---:|---:|
| four workers, 20-ms interval | 1,896 | 1,785 | **94.15%** | 5.85% |
| ten workers, 50-ms interval | 1,560 | 1,453 | **93.14%** | 6.86% |

The remaining symbolicated worker stacks contain:

1. `hashAndFillAes1Rx4<0,2>`: AES scratchpad hash/fill and software prefetch;
2. `randomx::CompiledVm<0>::run`: program generation and execution entry;
3. `sys_icache_invalidate` and, rarely, `pthread_jit_write_protect_np`: JIT
   publication/cache coherency;
4. negligible worker/control overhead outside RandomX.

The four-worker snapshot showed all workers at 98.7-99.7% CPU. The ten-worker
snapshot showed 91.5-96.0% per worker. The ten-thread rate was only about 50%
higher than the four-thread rate in this noisy, profiled window despite 150%
more workers. This is not a publishable scaling result, but it justifies
explicit P/E-cluster experiments.

## Ranked optimization candidates

### 1. AArch64 JIT main loop and dataset latency — highest priority

The 93-94% sample share makes the generated ARM64 program the only place where
a large engine gain can originate. Screen one change at a time in the JIT
template/generator:

- dataset prefetch target (`pldl2strm`, `pldl1keep`, `pldl2keep`, none);
- placement/distance of the v2 next-dataset-line prefetch;
- load/use separation around the dataset and scratchpad `ldp` sequences;
- dependency-breaking instruction order and register choices;
- conditional-branch layout and fall-through without changing RandomX
  semantics.

The profile proves where to experiment, not which prefetch hint wins. Each
candidate still requires an interleaved upstream A/B/B/A screen and known-hash
validation. Hardware counters for cache misses, stalls and branch misses would
make this diagnosis stronger; `sample` alone does not expose them.

### 2. P-core/E-core topology policy — high priority

The M4 has asymmetric L2 capacity: four P cores share 16 MiB, while six E
cores share only 4 MiB. Six 2-MiB E-core scratchpads cannot reside together in
that L2. Test 4, 5, 6, 8 and 10 workers, then mixed policies that keep four
high-priority workers on the performance cluster and add E workers only when
they improve total H/s or H/J.

macOS affinity tags and QoS are hints, not stable CPU-number pinning. The
existing interactive-QoS screen was negative, so do not retry global
interactive QoS as the default. Prefer a measured topology policy with an
automatic fallback to upstream behavior.

### 3. Scratchpad AES fill for the 128-byte cache line — medium priority

The native `hashAndFillAes1Rx4<0,2>` path is the next visible hotspot, but it
is only a few percent of total worker samples. On AArch64 both RandomX T0 and
NTA helpers currently emit `pldl1strm`. The hard-AES loop prefetches addresses
64 bytes apart, while the M4 cache line is 128 bytes, so two adjacent hints
can target the same cache line. Screen Apple-only variants for:

- one hint per 128-byte line rather than two 64-byte hints;
- prefetch distance around the current 7,168-byte value;
- unroll/layout changes that preserve the exact hash.

Amdahl's law limits this path: even eliminating a measured 3-5% component
cannot deliver a large overall gain. Treat it after the JIT/dataset screens.

### 4. JIT publication and I-cache work — lower priority

`sys_icache_invalidate` appears, but at well below the JIT execution share.
Measure generated-code bytes and invalidation time before changing W^X or
cache-flush behavior. Never weaken executable-memory safety for a small gain.
A useful profiling-only aid would record JIT buffer ranges and disassemble the
generated program after a fixed seed; it must be disabled in production.

### Not supported by this profile

- Metal/GPU acceleration: no GPU/Metal path appears in the CPU profile, and
  the RandomX working set/control flow remains CPU- and latency-oriented.
- CLI/network optimization: these paths are idle in the offline benchmark.
- global interactive QoS: already failed the repository's interleaved screen.
- broad compiler-flag tuning without a localized hypothesis.

## Validation gate for every candidate

1. exact 100K hash screen, then 250K hash `7D6054757BB08A63`;
2. pinned upstream XMRig reference with identical threads, Fast mode, work,
   sandbox, binary state and host state;
3. cooldown and interleaved A/B/B/A order;
4. reject if the host is not quiet or if drift exceeds the candidate effect;
5. repeat at 4 and 10 workers, because P-only and full-chip behavior differ;
6. promote only a repeatable median gain with no correctness, stability or
   safety regression.

## Files

- `sample-rx0-fast-t4-100k-20260815.txt`: complete call graph and summaries;
- `sample-rx0-fast-t10-100k-20260815.txt`: complete call graph and summaries;
- `environment-and-correctness-20260815.txt`: commands, topology and run log.

The bulky system `Binary Images` appendix was removed from the saved text
profiles. Target identity is stronger through the recorded SHA-256, version,
architecture and build settings.
