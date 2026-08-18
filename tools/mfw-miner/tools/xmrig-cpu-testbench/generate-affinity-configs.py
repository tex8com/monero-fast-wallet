#!/usr/bin/env python3
"""Generate reproducible RandomX CPU-affinity sweep configurations."""

from __future__ import annotations

import argparse
import json
from pathlib import Path


def config_for(cpus: list[int]) -> dict:
    return {
        "autosave": False,
        "randomx": {
            "init": -1,
            "init-avx2": -1,
            "mode": "auto",
            "1gb-pages": True,
            "rdmsr": True,
            "wrmsr": True,
            "cache_qos": False,
            "numa": True,
            "scratchpad_prefetch_mode": 1,
        },
        "cpu": {
            "enabled": True,
            "huge-pages": True,
            "huge-pages-jit": False,
            "memory-pool": False,
            "yield": True,
            "asm": True,
            "rx": cpus,
        },
        "opencl": False,
        "cuda": False,
        "benchmark": {
            "size": "100K",
            "algo": "rx/0",
            "submit": False,
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("output_dir", type=Path)
    parser.add_argument("--logical-cpus", type=int, default=32)
    parser.add_argument(
        "--order",
        choices=("sequential", "smt-interleaved"),
        default="sequential",
    )
    args = parser.parse_args()

    args.output_dir.mkdir(parents=True, exist_ok=True)
    if args.order == "smt-interleaved":
        if args.logical_cpus % 2:
            raise SystemExit("--order=smt-interleaved requires an even CPU count")
        sibling_offset = args.logical_cpus // 2
        all_cpus = [
            cpu
            for core in range(sibling_offset)
            for cpu in (core, core + sibling_offset)
        ]
    else:
        all_cpus = list(range(args.logical_cpus))

    for omitted in all_cpus:
        cpus = [cpu for cpu in all_cpus if cpu != omitted]
        output = args.output_dir / f"omit-cpu-{omitted:02d}.json"
        output.write_text(json.dumps(config_for(cpus), indent=2) + "\n")


if __name__ == "__main__":
    main()
