# MFW-Miner benchmark evidence

Every promoted hardware result requires a matched XMRig reference. Raw local
outputs live under `../benchmark-results/`; reviewed comparison records live
under `comparisons/`, and read-only machine inventories live under `hosts/`.

An `accepted` comparison must match RandomX variant and mode, thread count,
measurement duration, huge-page mode and host state, and should use interleaved
`A/B/B/A` ordering. Incomplete first baselines are kept as `exploratory` rather
than deleted or presented as performance claims.
