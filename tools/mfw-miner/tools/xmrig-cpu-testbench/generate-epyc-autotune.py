#!/usr/bin/env python3
"""Generate deterministic, offline EPYC RandomX autotune batch matrices.

The generator performs no benchmark and does not inspect or modify the host.
Its TSV output is consumed by run-epyc-autotune-batch.sh, which is dry-run by
default and applies the live host-safety gates.
"""

from __future__ import annotations

import argparse
import csv
import itertools
import math
from pathlib import Path


CPU_COUNT = 12
ALL_CPUS = tuple(range(CPU_COUNT))
FIELDS = (
    "order",
    "phase",
    "variant",
    "binary_role",
    "benchmark",
    "worker_cpus",
    "process_cpus",
    "init_threads",
    "page_mode",
    "numa_mode",
    "msr_mode",
    "estimated_seconds",
)


def parse_cpu_list(value: str) -> tuple[int, ...]:
    cpus: list[int] = []
    for item in value.split(","):
        item = item.strip()
        if not item:
            raise argparse.ArgumentTypeError(f"empty CPU in list: {value!r}")
        try:
            cpu = int(item)
        except ValueError as error:
            raise argparse.ArgumentTypeError(f"non-numeric CPU: {item!r}") from error
        if cpu not in ALL_CPUS:
            raise argparse.ArgumentTypeError(
                f"CPU {cpu} is outside the expected EPYC guest set 0-{CPU_COUNT - 1}"
            )
        if cpu in cpus:
            raise argparse.ArgumentTypeError(f"duplicate CPU {cpu}: {value!r}")
        cpus.append(cpu)
    if not cpus:
        raise argparse.ArgumentTypeError("CPU list must not be empty")
    return tuple(cpus)


def cpu_text(cpus: tuple[int, ...]) -> str:
    return ",".join(str(cpu) for cpu in cpus)


def spread_cpus(workers: int) -> tuple[int, ...]:
    """Choose a deterministic first-pass mask spread over all 12 vCPUs."""
    if not 1 <= workers <= CPU_COUNT:
        raise ValueError(f"workers must be in 1..{CPU_COUNT}")
    return tuple((index * CPU_COUNT) // workers for index in range(workers))


def affinity_candidates(workers: int, count: int = 6) -> list[tuple[int, ...]]:
    """Select balanced, mutually different masks without assuming CCD topology."""
    if workers == CPU_COUNT:
        return [ALL_CPUS]

    masks = list(itertools.combinations(ALL_CPUS, workers))
    seed = spread_cpus(workers)
    selected = [seed]
    usage = [int(cpu in seed) for cpu in ALL_CPUS]

    while len(selected) < min(count, len(masks)):
        best: tuple[int, ...] | None = None
        best_score: tuple[float, ...] | None = None
        for mask in masks:
            if mask in selected:
                continue
            after = [usage[cpu] + int(cpu in mask) for cpu in ALL_CPUS]
            min_distance = min(
                len(set(mask).symmetric_difference(existing)) for existing in selected
            )
            score = (
                float(min_distance),
                -float(max(after) - min(after)),
                -float(sum(value * value for value in after)),
            )
            if best_score is None or score > best_score or (
                score == best_score and mask < (best or mask)
            ):
                best = mask
                best_score = score
        assert best is not None
        selected.append(best)
        for cpu in best:
            usage[cpu] += 1
    return selected


def estimated_seconds(benchmark: str, workers: int, init_threads: int) -> int:
    hashes = {"100K": 100_000, "250K": 250_000}[benchmark]
    useful_workers = min(workers, 8)
    cache_penalty = 1.0 if workers <= 8 else max(0.65, 1.0 - 0.08 * (workers - 8))
    estimated_hps = 425.0 * useful_workers * cache_penalty
    hash_time = hashes / estimated_hps
    init_time = max(4.0, 42.0 / init_threads)
    # Includes the four live vmstat gate samples and normal process/log teardown.
    return math.ceil(hash_time + init_time + 8.0)


def row(
    phase: str,
    variant: str,
    role: str,
    benchmark: str,
    workers: tuple[int, ...],
    init_threads: int,
    *,
    page_mode: str = "none",
    numa_mode: str = "off",
    msr_mode: str = "off",
) -> dict[str, str]:
    return {
        "order": "0",
        "phase": phase,
        "variant": variant,
        "binary_role": role,
        "benchmark": benchmark,
        "worker_cpus": cpu_text(workers),
        "process_cpus": cpu_text(ALL_CPUS),
        "init_threads": str(init_threads),
        "page_mode": page_mode,
        "numa_mode": numa_mode,
        "msr_mode": msr_mode,
        "estimated_seconds": str(estimated_seconds(benchmark, len(workers), init_threads)),
    }


def worker_rows() -> list[dict[str, str]]:
    workers = (4, 6, 8, 10, 12)
    sequence = workers + tuple(reversed(workers))
    seen: dict[int, int] = {}
    rows = []
    for count in sequence:
        seen[count] = seen.get(count, 0) + 1
        rows.append(
            row(
                "workers",
                f"w{count}-r{seen[count]}",
                "mfw-mode0",
                "100K",
                spread_cpus(count),
                8,
            )
        )
    return rows


def init_rows(workers: tuple[int, ...]) -> list[dict[str, str]]:
    init_counts = (1, 2, 4, 6, 8, 12)
    sequence = init_counts + tuple(reversed(init_counts))
    seen: dict[int, int] = {}
    rows = []
    for count in sequence:
        seen[count] = seen.get(count, 0) + 1
        rows.append(
            row(
                "init",
                f"init{count}-r{seen[count]}",
                "mfw-mode0",
                "100K",
                workers,
                count,
            )
        )
    return rows


def affinity_rows(workers: int, init_threads: int) -> list[dict[str, str]]:
    candidates = affinity_candidates(workers)
    sequence = candidates + list(reversed(candidates))
    seen: dict[tuple[int, ...], int] = {}
    names = {mask: f"mask{index + 1}" for index, mask in enumerate(candidates)}
    rows = []
    for mask in sequence:
        seen[mask] = seen.get(mask, 0) + 1
        rows.append(
            row(
                "affinity",
                f"{names[mask]}-r{seen[mask]}",
                "mfw-mode0",
                "100K",
                mask,
                init_threads,
            )
        )
    return rows


def validation_rows(workers: tuple[int, ...], init_threads: int) -> list[dict[str, str]]:
    # Three explicit ABBA blocks keep packaging, MFW mode 0 and the default-off
    # mode 1 candidate distinct. No result can silently stand in for another.
    order = (
        ("xmrig-vs-mode0-a1", "xmrig-reference"),
        ("xmrig-vs-mode0-b1", "mfw-mode0"),
        ("xmrig-vs-mode0-b2", "mfw-mode0"),
        ("xmrig-vs-mode0-a2", "xmrig-reference"),
        ("xmrig-vs-mode1-a1", "xmrig-reference"),
        ("xmrig-vs-mode1-b1", "mfw-mode1"),
        ("xmrig-vs-mode1-b2", "mfw-mode1"),
        ("xmrig-vs-mode1-a2", "xmrig-reference"),
        ("mode0-vs-mode1-a1", "mfw-mode0"),
        ("mode0-vs-mode1-b1", "mfw-mode1"),
        ("mode0-vs-mode1-b2", "mfw-mode1"),
        ("mode0-vs-mode1-a2", "mfw-mode0"),
    )
    return [
        row("validation", variant, role, "250K", workers, init_threads)
        for variant, role in order
    ]


def page_rows(workers: tuple[int, ...], init_threads: int) -> list[dict[str, str]]:
    order = (
        ("no-pages-vs-2m-a1", "none"),
        ("no-pages-vs-2m-b1", "2m"),
        ("no-pages-vs-2m-b2", "2m"),
        ("no-pages-vs-2m-a2", "none"),
    )
    return [
        row(
            "pages",
            variant,
            "mfw-mode0",
            "100K",
            workers,
            init_threads,
            page_mode=page_mode,
        )
        for variant, page_mode in order
    ]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "phase", choices=("workers", "init", "affinity", "pages", "validation")
    )
    parser.add_argument("output", type=Path)
    parser.add_argument(
        "--worker-cpus",
        type=parse_cpu_list,
        help="required for init/validation; optional explicit mask for validation",
    )
    parser.add_argument("--workers", type=int, help="required for affinity")
    parser.add_argument("--init-threads", type=int, default=8)
    args = parser.parse_args()

    if not 1 <= args.init_threads <= CPU_COUNT:
        parser.error(f"--init-threads must be in 1..{CPU_COUNT}")

    if args.phase == "workers":
        rows = worker_rows()
    elif args.phase == "init":
        if args.worker_cpus is None:
            parser.error("init requires --worker-cpus")
        rows = init_rows(args.worker_cpus)
    elif args.phase == "affinity":
        if args.workers is None or not 1 <= args.workers <= CPU_COUNT:
            parser.error(f"affinity requires --workers in 1..{CPU_COUNT}")
        rows = affinity_rows(args.workers, args.init_threads)
    elif args.phase == "pages":
        if args.worker_cpus is None:
            parser.error("pages requires --worker-cpus")
        rows = page_rows(args.worker_cpus, args.init_threads)
    else:
        if args.worker_cpus is None:
            parser.error("validation requires --worker-cpus")
        rows = validation_rows(args.worker_cpus, args.init_threads)

    for index, item in enumerate(rows, 1):
        item["order"] = str(index)

    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("w", newline="", encoding="utf-8") as output:
        writer = csv.DictWriter(
            output, fieldnames=FIELDS, dialect="excel-tab", lineterminator="\n"
        )
        writer.writeheader()
        writer.writerows(rows)

    total = sum(int(item["estimated_seconds"]) for item in rows)
    print(f"matrix={args.output}")
    print(f"runs={len(rows)}")
    print(f"estimated_active_seconds={total}")


if __name__ == "__main__":
    main()
