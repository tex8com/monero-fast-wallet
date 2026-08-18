#!/usr/bin/env python3
"""Create one explicit, pool-free XMRig config for an EPYC matrix row."""

from __future__ import annotations

import argparse
import json
from pathlib import Path


def cpu_list(value: str) -> list[int]:
    values: list[int] = []
    for raw in value.split(","):
        try:
            cpu = int(raw)
        except ValueError as error:
            raise argparse.ArgumentTypeError(f"invalid CPU: {raw!r}") from error
        if cpu < 0 or cpu in values:
            raise argparse.ArgumentTypeError(f"invalid or duplicate CPU: {cpu}")
        values.append(cpu)
    if not values:
        raise argparse.ArgumentTypeError("at least one worker CPU is required")
    return values


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("output", type=Path)
    parser.add_argument("--worker-cpus", required=True, type=cpu_list)
    parser.add_argument("--init-threads", required=True, type=int)
    parser.add_argument("--benchmark", required=True, choices=("100K", "250K"))
    parser.add_argument("--page-mode", required=True, choices=("none", "2m", "1g"))
    parser.add_argument("--numa-mode", required=True, choices=("off", "auto"))
    parser.add_argument("--msr-mode", required=True, choices=("off", "auto"))
    args = parser.parse_args()

    if args.init_threads < 1:
        parser.error("--init-threads must be positive")

    affinity_mask = sum(1 << cpu for cpu in args.worker_cpus)

    config = {
        "api": {"id": None, "worker-id": None},
        "http": {
            "enabled": False,
            "host": "127.0.0.1",
            "port": 0,
            "access-token": None,
            "restricted": True,
        },
        "autosave": False,
        "background": False,
        "colors": False,
        "donate-level": 0,
        "donate-over-proxy": 0,
        "randomx": {
            "init": args.init_threads,
            "init-avx2": -1,
            "mode": "fast",
            "1gb-pages": args.page_mode == "1g",
            "rdmsr": args.msr_mode == "auto",
            "wrmsr": args.msr_mode == "auto",
            "cache_qos": False,
            "numa": args.numa_mode == "auto",
            "scratchpad_prefetch_mode": 1,
        },
        "cpu": {
            "enabled": True,
            "huge-pages": args.page_mode != "none",
            "huge-pages-jit": False,
            "priority": 0,
            "memory-pool": False,
            "yield": False,
            "asm": "ryzen",
            "*": {
                "intensity": 1,
                "threads": len(args.worker_cpus),
                "affinity": affinity_mask,
            },
        },
        "opencl": False,
        "cuda": False,
        "pools": [],
        "benchmark": {
            "size": args.benchmark,
            "algo": "rx/0",
            "submit": False,
        },
        "print-time": 1,
        "syslog": False,
        "watch": False,
        "pause-on-battery": False,
        "pause-on-active": False,
    }

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
