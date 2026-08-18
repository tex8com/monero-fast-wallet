# Apple M4 — RandomX v2 JIT corpus profile

Date: 2026-08-16

## Gate and workload

The profile was deferred while an unrelated Android NDK build occupied the
host. It started only after that build completed, 20 minutes of passive
cooldown elapsed, and ten consecutive live samples reported at least 95% CPU
idle. The final opening sample was 98.72% idle at load1 1.19.

- Engine: MFW-Miner / XMRig 6.26.0, commit
  `b2ca72480c58d197e18c885d9fc1a0c8d517e60a`.
- Binary SHA-256:
  `a1d200369eafe350ed42086700855c228b240cd79c2ad6e2d46b22ae660aac2e`.
- RandomX: v2 Light replay, 16 deterministic programs × 200 iterations.
- Differential gate: 16 interpreter comparisons PASS.
- Network boundary: offline entry before pool, DNS, donation, or share paths.
- Profiler: macOS Time Profiler, 1 ms samples.

No miner process remained after the run; post-run idle was 97.28%.

## Result

There are 5,876 samples inside deterministic replay windows. 291 samples
(4.9523%) map exactly to native byte ranges emitted for virtual RandomX
instructions. All 16 programs have mapped coverage. All 291 mapped samples ran
on P cores; none ran on E cores.

| Instruction type | Samples | Mapped share |
|---|---:|---:|
| CBRANCH | 211 | 72.509% |
| IADD_M | 12 | 4.124% |
| ISTORE | 11 | 3.780% |
| ISUB_M | 11 | 3.780% |
| IXOR_M | 8 | 2.749% |
| IADD_RS | 8 | 2.749% |
| IXOR_R | 6 | 2.062% |
| IMUL_R | 3 | 1.031% |
| FADD_M | 3 | 1.031% |

The first M4 JIT candidate should therefore target AArch64 `CBRANCH` code
shape, layout, and dependency behavior. It must be evaluated across the entire
deterministic corpus rather than against one generated program. M1 receives a
separate promotion decision because its mapped `CBRANCH` share is 51.962%, not
72.509%, and its secondary hotspots differ.

## Boundary

This is a Light-mode JIT-body profile, not Fast-mode mining H/s. It excludes
the full dataset-memory bottleneck, and the sample percentage is not a possible
speedup percentage. A candidate is promotable only after bit-exact natural and
replay gates plus cold matched Fast-mode ABBA/BAAB H/s blocks.

Evidence is stored under the prefix
`benchmark-results/jit-corpus/m4-v2-time-16x200-20260816`. The associated
218-file SHA-256 manifest verifies successfully.
