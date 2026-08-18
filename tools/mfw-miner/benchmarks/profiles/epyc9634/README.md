# EPYC 9634 staged matrices

`workers-mirrored.tsv` is the first executable phase: ten mode-0 100K rows in
the mirrored order 4, 6, 8, 10, 12, 12, 10, 8, 6, 4. Its generator estimates
550 seconds of active gate/init/hash/teardown time before environmental wait.

`validation-provisional-w8.tsv` demonstrates the final role-separated gate at
the eight-worker cache heuristic: twelve 250K rows comprising three A-B-B-A
blocks (official XMRig versus MFW mode 0, official XMRig versus MFW mode 1,
and mode 0 versus mode 1). Its provisional estimate is 1,044 active seconds.
Do not execute it unchanged if the worker/affinity/init stages select a
different profile; regenerate it with the measured winner.

The intermediate matrices are generated in the same maintenance window:

```bash
python3 ../../../tools/xmrig-cpu-testbench/generate-epyc-autotune.py \
  init init.tsv --worker-cpus WINNING_CPU_LIST

python3 ../../../tools/xmrig-cpu-testbench/generate-epyc-autotune.py \
  affinity affinity.tsv --workers WINNING_WORKER_COUNT \
  --init-threads WINNING_INIT_COUNT

python3 ../../../tools/xmrig-cpu-testbench/generate-epyc-autotune.py \
  validation validation-final.tsv --worker-cpus WINNING_CPU_LIST \
  --init-threads WINNING_INIT_COUNT
```

The runner is dry-run by default. These matrices configure no pool, service,
HugeTLB pool or MSR state.
