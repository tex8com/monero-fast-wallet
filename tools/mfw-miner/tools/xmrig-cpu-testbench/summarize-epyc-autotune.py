#!/usr/bin/env python3
"""Validate and summarize EPYC autotune evidence without promoting noisy runs."""

from __future__ import annotations

import argparse
import csv
import json
import math
import re
import statistics
from collections import defaultdict
from pathlib import Path


OUTPUT_FIELDS = (
    "run_id",
    "order",
    "phase",
    "candidate",
    "variant",
    "binary_role",
    "benchmark",
    "eligible",
    "exclusion_reason",
    "workers",
    "worker_cpus",
    "init_threads",
    "page_mode",
    "numa_mode",
    "msr_mode",
    "dataset_init_ms",
    "worker_ready_ms",
    "benchmark_seconds",
    "end_to_end_seconds",
    "hashes_per_second",
    "expected_hash",
    "actual_hash",
    "binary_sha256",
    "host_gate_sha256",
)


def metadata(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        if "=" in line:
            key, value = line.split("=", 1)
            values[key] = value
    return values


def first_int(pattern: str, text: str) -> int | None:
    match = re.search(pattern, text, re.MULTILINE)
    return int(match.group(1)) if match else None


def first_float(pattern: str, text: str) -> float | None:
    match = re.search(pattern, text, re.MULTILINE)
    return float(match.group(1)) if match else None


def result_row(result_dir: Path) -> dict[str, object]:
    meta = metadata(result_dir / "metadata.env")
    log = (result_dir / "xmrig.log").read_text(encoding="utf-8", errors="replace")
    init_threads = first_int(r"init dataset .*\((\d+) threads\)", log)
    workers = first_int(r"READY threads (\d+)/\d+", log)
    dataset_ms = first_int(r"dataset ready \((\d+) ms\)", log)
    ready_ms = first_int(r"READY threads \d+/\d+ \(\d+\).*\((\d+) ms\)", log)
    benchmark_seconds = first_float(r"benchmark finished in ([0-9.]+) seconds", log)
    hps = first_float(r"benchmark finished in [0-9.]+ seconds \(([0-9.]+) h/s\)", log)
    hash_match = re.search(r"hash sum = ([0-9A-Fa-f]+)", log)
    actual_hash = (hash_match.group(1).upper() if hash_match else meta.get("actual_hash", ""))
    expected_hash = meta.get("expected_hash", "")

    reasons: list[str] = []
    required = (
        "autotune_order",
        "autotune_phase",
        "autotune_variant",
        "autotune_binary_role",
        "autotune_worker_cpus",
        "autotune_init_threads",
        "autotune_page_mode",
        "autotune_numa_mode",
        "autotune_msr_mode",
        "autotune_host_gate_sha256",
    )
    missing = [key for key in required if not meta.get(key)]
    if missing:
        reasons.append("missing-autotune-metadata:" + ",".join(missing))
    if meta.get("miner_exit_status") != "0":
        reasons.append("nonzero-miner-exit")
    if meta.get("timed_out") != "0":
        reasons.append("timeout")
    if meta.get("network_fallback_detected") != "0":
        reasons.append("network-fallback")
    if not expected_hash or actual_hash != expected_hash:
        reasons.append("wrong-or-missing-hash")
    if benchmark_seconds is None or hps is None:
        reasons.append("missing-benchmark-line")
    expected_workers = len(meta.get("autotune_worker_cpus", "").split(","))
    if workers is None or workers != expected_workers:
        reasons.append("worker-count-mismatch")
    if init_threads is None or str(init_threads) != meta.get("autotune_init_threads"):
        reasons.append("init-thread-mismatch")
    if dataset_ms is None or ready_ms is None:
        reasons.append("missing-init-timing")

    variant = meta.get("autotune_variant", "")
    candidate = re.sub(r"-(?:r\d+|[ab][12])$", "", variant)
    end_to_end = None
    if dataset_ms is not None and ready_ms is not None and benchmark_seconds is not None:
        end_to_end = benchmark_seconds + (dataset_ms + ready_ms) / 1000.0

    return {
        "run_id": result_dir.name,
        "order": int(meta.get("autotune_order", "0") or 0),
        "phase": meta.get("autotune_phase", ""),
        "candidate": candidate,
        "variant": variant,
        "binary_role": meta.get("autotune_binary_role", ""),
        "benchmark": meta.get("benchmark_size", ""),
        "eligible": not reasons,
        "exclusion_reason": ";".join(reasons),
        "workers": workers,
        "worker_cpus": meta.get("autotune_worker_cpus", ""),
        "init_threads": init_threads,
        "page_mode": meta.get("autotune_page_mode", ""),
        "numa_mode": meta.get("autotune_numa_mode", ""),
        "msr_mode": meta.get("autotune_msr_mode", ""),
        "dataset_init_ms": dataset_ms,
        "worker_ready_ms": ready_ms,
        "benchmark_seconds": benchmark_seconds,
        "end_to_end_seconds": end_to_end,
        "hashes_per_second": hps,
        "expected_hash": expected_hash,
        "actual_hash": actual_hash,
        "binary_sha256": meta.get("binary_sha256", ""),
        "host_gate_sha256": meta.get("autotune_host_gate_sha256", ""),
    }


def aggregates(rows: list[dict[str, object]]) -> list[dict[str, object]]:
    groups: dict[tuple[str, str, str], list[dict[str, object]]] = defaultdict(list)
    for row in rows:
        groups[(str(row["phase"]), str(row["candidate"]), str(row["binary_role"]))].append(row)

    output: list[dict[str, object]] = []
    for (phase, candidate, role), group in sorted(groups.items()):
        valid = [item for item in group if item["eligible"]]
        hps = [float(item["hashes_per_second"]) for item in valid]
        init = [int(item["dataset_init_ms"]) for item in valid]
        drift = None
        if len(hps) >= 2 and statistics.mean(hps):
            drift = (max(hps) - min(hps)) / statistics.mean(hps) * 100.0
        repeat_stable = len(valid) >= 2 and drift is not None and drift <= 2.0
        output.append(
            {
                "phase": phase,
                "candidate": candidate,
                "binary_role": role,
                "runs": len(group),
                "eligible_runs": len(valid),
                "median_hps": statistics.median(hps) if hps else None,
                "median_dataset_init_ms": statistics.median(init) if init else None,
                "within_candidate_drift_percent": drift,
                # Stability alone never promotes a performance candidate.
                "repeat_stable": repeat_stable,
            }
        )
    return output


def comparisons(rows: list[dict[str, object]]) -> list[dict[str, object]]:
    groups: dict[tuple[str, str], list[dict[str, object]]] = defaultdict(list)
    for row in rows:
        if row["phase"] in ("pages", "validation"):
            groups[(str(row["phase"]), str(row["candidate"]))].append(row)

    output: list[dict[str, object]] = []
    for (phase, candidate), group in sorted(groups.items()):
        sides: dict[str, list[dict[str, object]]] = {"a": [], "b": []}
        for row in group:
            match = re.search(r"-([ab])[12]$", str(row["variant"]))
            if match:
                sides[match.group(1)].append(row)
        control = [row for row in sides["a"] if row["eligible"]]
        contender = [row for row in sides["b"] if row["eligible"]]
        control_hps = [float(row["hashes_per_second"]) for row in control]
        contender_hps = [float(row["hashes_per_second"]) for row in contender]
        roles_a = sorted({str(row["binary_role"]) for row in sides["a"]})
        roles_b = sorted({str(row["binary_role"]) for row in sides["b"]})
        complete = (
            len(control_hps) == 2
            and len(contender_hps) == 2
            and len(roles_a) == 1
            and len(roles_b) == 1
        )
        control_mean = statistics.mean(control_hps) if control_hps else None
        contender_mean = statistics.mean(contender_hps) if contender_hps else None
        control_drift = None
        contender_drift = None
        delta = None
        geometric_delta = None
        if len(control_hps) >= 2 and control_mean:
            control_drift = (max(control_hps) - min(control_hps)) / control_mean * 100.0
        if len(contender_hps) >= 2 and contender_mean:
            contender_drift = (
                (max(contender_hps) - min(contender_hps)) / contender_mean * 100.0
            )
        if complete and control_mean and contender_mean:
            delta = (contender_mean / control_mean - 1.0) * 100.0
            geometric_delta = (
                math.prod(contender_hps) / math.prod(control_hps)
            ) ** (1.0 / len(contender_hps)) * 100.0 - 100.0
        repeat_gate = bool(
            complete
            and control_drift is not None
            and contender_drift is not None
            and control_drift <= 2.0
            and contender_drift <= 2.0
        )
        output.append(
            {
                "phase": phase,
                "comparison": candidate,
                "control_role": roles_a[0] if len(roles_a) == 1 else None,
                "contender_role": roles_b[0] if len(roles_b) == 1 else None,
                "control_hps": control_hps,
                "contender_hps": contender_hps,
                "control_mean_hps": control_mean,
                "contender_mean_hps": contender_mean,
                "delta_percent": delta,
                "geometric_delta_percent": geometric_delta,
                "control_drift_percent": control_drift,
                "contender_drift_percent": contender_drift,
                "complete": complete,
                "repeat_gate_pass": repeat_gate,
                "promotion_eligible": bool(repeat_gate and delta is not None and delta > 0.0),
            }
        )
    return output


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("results_root", type=Path)
    parser.add_argument("--tsv", required=True, type=Path)
    parser.add_argument("--json", required=True, type=Path)
    args = parser.parse_args()

    result_dirs = sorted(
        path.parent
        for path in args.results_root.glob("*/metadata.env")
        if (path.parent / "xmrig.log").is_file()
    )
    if not result_dirs:
        raise SystemExit(f"no benchmark evidence below {args.results_root}")
    rows = sorted((result_row(path) for path in result_dirs), key=lambda row: int(row["order"]))
    aggregate_rows = aggregates(rows)
    comparison_rows = comparisons(rows)

    args.tsv.parent.mkdir(parents=True, exist_ok=True)
    with args.tsv.open("w", newline="", encoding="utf-8") as output:
        writer = csv.DictWriter(
            output, fieldnames=OUTPUT_FIELDS, dialect="excel-tab", lineterminator="\n"
        )
        writer.writeheader()
        writer.writerows(rows)
    args.json.parent.mkdir(parents=True, exist_ok=True)
    args.json.write_text(
        json.dumps(
            {
                "schema": "mfw_epyc_autotune_summary_v2",
                "runs": rows,
                "aggregates": aggregate_rows,
                "comparisons": comparison_rows,
                "repeat_stability_rule": "at least two eligible repeats and <=2% within-role H/s drift",
                "promotion_rule": "complete A-B-B-A, both role drifts <=2%, and contender mean H/s > control",
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    print(f"runs={len(rows)}")
    print(f"eligible_runs={sum(bool(row['eligible']) for row in rows)}")
    print(f"repeat_stable_groups={sum(bool(row['repeat_stable']) for row in aggregate_rows)}")
    print(f"promotion_eligible_comparisons={sum(bool(row['promotion_eligible']) for row in comparison_rows)}")


if __name__ == "__main__":
    main()
