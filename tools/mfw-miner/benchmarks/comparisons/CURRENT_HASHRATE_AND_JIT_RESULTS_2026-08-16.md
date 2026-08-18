# Current MFW-Miner performance and JIT-profile results

Date: 2026-08-16

## Fast-mode H/s comparisons

Der vollständige aktuelle Bericht mit Rohbelegen ist
`HARDWARE_XMRIG_VS_MFW_2026-08-16.md`. Die Tabelle unten ersetzt die frühere
Zwischenbilanz. `Valid for promotion` bleibt absichtlich strenger als ein
korrekter Hash und sauberer Prozess-Exit.

| CPU | Workload | Official XMRig | Tested MFW variant | Delta | Decision |
|---|---|---:|---:|---:|---|
| Apple M4, 10 workers | rx/0 Fast 100K, ABBA | 4,117.60 H/s mean | 4,120.55 H/s mean, M4 CBRANCH profile | +0.0716% | valid parity; MFW narrowly ahead |
| Apple M1 MacBook Air, 8 workers | rx/0 Fast 100K, ABBA | 1,012.30 H/s mean | 1,012.65 H/s mean, generic A64 profile | +0.0346% | valid parity |
| Intel Xeon E3-1585L v5, 7 workers | rx/0 Fast 250K, ABBA | 2,368.85 H/s mean | 2,357.35 H/s mean, Mode 0 | -0.4855% | valid; XMRig remains faster |
| AMD EPYC 9634 KVM, 12 workers | rx/0 Fast 250K, earlier ABBA | 5,166.60 H/s mean | 5,157.65 H/s mean, Mode 0 | -0.1732% | provisional; XMRig drift 3.20% |

The final warm Intel `ISWAP_R` block measured 2,373.60 H/s for Mode 0 and
2,371.65 H/s for the candidate (`-0.0822%`). The candidate remains default-off.

The EPYC AVX-512VL Group-E candidate also remains default-off. Its direct,
same-build comparison against MFW Mode 0 was `-3.05%`, while the separate
release-packaging comparison against official XMRig was `+1.05%`; both failed
the predeclared drift gate and contradict one another.

## New JIT corpus profiles

These are exact PC-to-VM-instruction sample mappings from deterministic
RandomX v2 Light replay. They select optimization candidates; they are not H/s
measurements and cannot be mixed into the table above.

| CPU | Replay ROI samples | Exact JIT mappings | Coverage | Hottest mapped instruction |
|---|---:|---:|---:|---|
| Apple M4 | 5,876 | 291 (4.9523%) | 16/16 programs | `CBRANCH` 211 / 72.509% |
| Apple M1 | 11,349 | 1,045 (9.2079%) | 16/16 programs | `CBRANCH` 543 / 51.962% |
| Intel Xeon E3-1585L v5 | 17,247 | 2,398 (13.9039%) | 16/16 programs | `ISTORE` 253 / 10.550% |
| AMD EPYC 9634 KVM | — | — | correctness/replay PASS | guest lacks unprivileged `perf` |

## Correctness status

- M4, M1, Intel, and EPYC pass v1 64-program and v2 64-program natural corpus
  checks where run.
- Stable v2 8-program × 2 replay passes on all four platforms.
- M4, M1, and Intel complete the 16-program × 200 profiler replay with all
  differential hashes correct.
- Normal feature-off build contains neither corpus symbols nor corpus CLI.
- All profiling entrypoints are offline and exit before pool, DNS, donation,
  or share initialization.

## Next promotion gates

1. The AArch64 `CBRANCH` candidate is complete: runtime-select it on M4 and
   retain the reference form on M1/unknown AArch64 CPUs.
2. Intel `ISWAP_R` is rejected; profile the next memory/dependency candidate
   only on a host capable of stable sub-percent controls.
3. Obtain a non-production Zen-4 host with PMU access before choosing the next
   EPYC JIT instruction; do not infer it from the virtual guest's H/s drift.
4. M1 matched Fast ABBA is complete; next optimize a different M1-specific
   hotspot rather than inheriting the M4 instruction form.
