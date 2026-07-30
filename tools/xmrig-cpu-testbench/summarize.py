#!/usr/bin/env python3
"""Summarize XMRig CPU benchmark evidence without third-party packages."""

from __future__ import annotations

import argparse
import csv
import json
import math
import re
from pathlib import Path


BENCHMARK_RE = re.compile(
    r"benchmark finished in\s+([0-9.]+) seconds \(([0-9.]+) h/s\).*?"
    r"hash sum =\s+([0-9A-Fa-f]+)"
)
ANSI_RE = re.compile(r"\x1b\[[0-9;]*m")


def read_metadata(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for line in path.read_text(errors="replace").splitlines():
        if "=" in line:
            key, value = line.split("=", 1)
            values[key] = value
    return values


def number(value: str | None) -> float | None:
    if value is None:
        return None
    cleaned = value.strip().replace(",", "")
    if not cleaned or cleaned.startswith("<"):
        return None
    try:
        return float(cleaned)
    except ValueError:
        return None


def perf_events(path: Path) -> dict[str, float]:
    if not path.exists():
        return {}
    events: dict[str, float] = {}
    for row in csv.reader(path.read_text(errors="replace").splitlines(), delimiter=";"):
        if len(row) < 3:
            continue
        count = number(row[0])
        event = row[2].strip()
        if count is not None and event:
            events[event] = count
    return events


def summarize(run_dir: Path) -> dict[str, object]:
    metadata = read_metadata(run_dir / "metadata.env")
    log = ANSI_RE.sub("", (run_dir / "xmrig.log").read_text(errors="replace"))
    match = BENCHMARK_RE.search(log)

    rows: list[dict[str, str]] = []
    telemetry_path = run_dir / "telemetry.csv"
    if telemetry_path.exists():
        with telemetry_path.open(newline="") as handle:
            rows = list(csv.DictReader(handle))

    elapsed_sampled = None
    process_cpu_percent = None
    process_cpu_percent_machine = None
    system_cpu_percent = None
    max_rss_mb = None
    max_hugetlb_mb = None
    max_total_resident_mb = None
    max_vsize_mb = None
    average_mhz = None
    network_rx_bytes = None
    network_tx_bytes = None

    if len(rows) >= 2:
        first, last = rows[0], rows[-1]
        elapsed_sampled = (
            int(last["timestamp_ns"]) - int(first["timestamp_ns"])
        ) / 1_000_000_000
        tick_hz = int(metadata["clock_ticks"])
        logical_cpus = int(metadata["logical_cpus"])

        process_ticks = (
            int(last["proc_user_ticks"])
            + int(last["proc_system_ticks"])
            - int(first["proc_user_ticks"])
            - int(first["proc_system_ticks"])
        )
        if elapsed_sampled > 0:
            process_cpu_percent = process_ticks / tick_hz / elapsed_sampled * 100
            process_cpu_percent_machine = process_cpu_percent / logical_cpus

        def system_values(row: dict[str, str]) -> tuple[int, int]:
            values = [
                int(row[key])
                for key in (
                    "system_user",
                    "system_nice",
                    "system_system",
                    "system_idle",
                    "system_iowait",
                    "system_irq",
                    "system_softirq",
                    "system_steal",
                )
            ]
            return sum(values), values[3] + values[4]

        total_first, idle_first = system_values(first)
        total_last, idle_last = system_values(last)
        total_delta = total_last - total_first
        if total_delta > 0:
            system_cpu_percent = (
                total_delta - (idle_last - idle_first)
            ) / total_delta * 100

        max_rss_mb = max(int(row["proc_rss_pages"]) for row in rows) * int(
            metadata["page_size"]
        ) / 1024 / 1024
        if "proc_hugetlb_kb" in rows[0]:
            max_hugetlb_mb = max(
                int(row["proc_hugetlb_kb"] or "0") for row in rows
            ) / 1024
            max_total_resident_mb = max(
                (
                    int(row["proc_rss_pages"]) * int(metadata["page_size"]) / 1024
                    + int(row["proc_hugetlb_kb"] or "0")
                )
                / 1024
                for row in rows
            )
        max_vsize_mb = max(int(row["proc_vsize_bytes"]) for row in rows) / 1024 / 1024
        frequencies = [float(row["average_mhz"]) for row in rows]
        average_mhz = sum(frequencies) / len(frequencies)
        network_rx_bytes = int(last["net_rx_bytes"]) - int(first["net_rx_bytes"])
        network_tx_bytes = int(last["net_tx_bytes"]) - int(first["net_tx_bytes"])

    df_events = perf_events(run_dir / "perf-amd-df.csv")
    process_events = perf_events(run_dir / "perf-process.csv")
    perf_df_elapsed = None
    if "perf_df_started_ns" in metadata and "perf_df_finished_ns" in metadata:
        perf_df_elapsed = (
            int(metadata["perf_df_finished_ns"]) - int(metadata["perf_df_started_ns"])
        ) / 1_000_000_000

    df_read_count = next(
        (value for key, value in df_events.items() if "umask=0x38" in key), None
    )
    df_write_count = next(
        (value for key, value in df_events.items() if "umask=0xc0" in key.lower()), None
    )

    def mib_per_second(count: float | None) -> float | None:
        if count is None or not perf_df_elapsed or perf_df_elapsed <= 0:
            return None
        return count * 64 / perf_df_elapsed / 1024 / 1024

    def event(name: str) -> float | None:
        return next(
            (value for key, value in process_events.items() if key == name),
            None,
        )

    cycles = event("cycles")
    instructions = event("instructions")
    cache_references = event("cache-references")
    cache_misses = event("cache-misses")
    branches = event("branches")
    branch_misses = event("branch-misses")

    def ratio(numerator: float | None, denominator: float | None) -> float | None:
        if numerator is None or denominator is None or denominator == 0:
            return None
        return numerator / denominator

    summary: dict[str, object] = {
        "run_id": metadata.get("run_id", run_dir.name),
        "label": metadata.get("label"),
        "cpu": metadata.get("cpu"),
        "command": metadata.get("command"),
        "benchmark_seconds": float(match.group(1)) if match else None,
        "hashes_per_second": float(match.group(2)) if match else None,
        "hash_sum": match.group(3).upper() if match else None,
        "sampled_seconds": elapsed_sampled,
        "process_cpu_percent_one_core_scale": process_cpu_percent,
        "process_cpu_percent_whole_machine": process_cpu_percent_machine,
        "system_cpu_percent": system_cpu_percent,
        "peak_rss_mib": max_rss_mb,
        "peak_hugetlb_mib": max_hugetlb_mb,
        "peak_total_resident_mib": max_total_resident_mb,
        "peak_vsize_mib": max_vsize_mb,
        "average_observed_mhz": average_mhz,
        "perf_instructions_per_cycle": ratio(instructions, cycles),
        "perf_cache_miss_percent": (
            None
            if ratio(cache_misses, cache_references) is None
            else ratio(cache_misses, cache_references) * 100
        ),
        "perf_branch_miss_percent": (
            None
            if ratio(branch_misses, branches) is None
            else ratio(branch_misses, branches) * 100
        ),
        "perf_context_switches": event("context-switches"),
        "perf_cpu_migrations": event("cpu-migrations"),
        "perf_page_faults": event("page-faults"),
        "network_rx_bytes": network_rx_bytes,
        "network_tx_bytes": network_tx_bytes,
        "amd_df_read_mib_per_second_estimate": mib_per_second(df_read_count),
        "amd_df_write_mib_per_second_estimate": mib_per_second(df_write_count),
        "timed_out": metadata.get("timed_out") == "1",
        "miner_exit_status": int(metadata.get("miner_exit_status", "-1")),
    }
    return {
        key: (None if isinstance(value, float) and not math.isfinite(value) else value)
        for key, value in summary.items()
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("run_dirs", nargs="+", type=Path)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    summaries = [summarize(path) for path in args.run_dirs]
    if args.json:
        print(json.dumps(summaries, indent=2, sort_keys=True))
        return

    columns = (
        "label",
        "hashes_per_second",
        "benchmark_seconds",
        "system_cpu_percent",
        "peak_total_resident_mib",
        "average_observed_mhz",
        "amd_df_read_mib_per_second_estimate",
        "amd_df_write_mib_per_second_estimate",
    )
    print("\t".join(columns))
    for summary in summaries:
        print(
            "\t".join(
                "" if summary[column] is None else str(summary[column])
                for column in columns
            )
        )


if __name__ == "__main__":
    main()
