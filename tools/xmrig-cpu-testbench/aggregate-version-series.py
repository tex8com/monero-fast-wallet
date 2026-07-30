#!/usr/bin/env python3
"""Aggregate repeated Original/V1-V10 XMRig runs into reproducible medians."""

from __future__ import annotations

import argparse
import importlib.util
import json
import re
import statistics
from pathlib import Path


ROOT = Path(__file__).resolve().parent
VERSION_RE = re.compile(r"vseries-(original|v(\d+))-")
METRICS = (
    "hashes_per_second",
    "system_cpu_percent",
    "peak_total_resident_mib",
    "average_observed_mhz",
    "perf_instructions_per_cycle",
    "perf_cache_miss_percent",
    "perf_branch_miss_percent",
    "amd_df_read_mib_per_second_estimate",
    "network_rx_bytes",
    "network_tx_bytes",
)


def load_summarizer():
    spec = importlib.util.spec_from_file_location(
        "xmrig_summarize", ROOT / "summarize.py"
    )
    if spec is None or spec.loader is None:
        raise RuntimeError("unable to load summarize.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.summarize


def load_descriptions() -> dict[str, dict[str, str]]:
    lines = (ROOT / "version-series.tsv").read_text().splitlines()
    header = lines[0].split("\t")
    records = {}
    for line in lines[1:]:
        fields = line.split("\t")
        if len(fields) != len(header):
            raise ValueError(f"invalid version-series.tsv row: {line}")
        row = dict(zip(header, fields))
        records[row["version"].lower()] = row
    return records


def version_key(label: str) -> str:
    match = VERSION_RE.search(label)
    if not match:
        raise ValueError(f"not a version-series label: {label}")
    if match.group(1) == "original":
        return "original"
    return f"v{int(match.group(2))}"


def median(rows: list[dict[str, object]], key: str) -> float | None:
    values = [float(row[key]) for row in rows if row.get(key) is not None]
    return statistics.median(values) if values else None


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("run_dirs", nargs="+", type=Path)
    args = parser.parse_args()

    summarize = load_summarizer()
    descriptions = load_descriptions()
    groups: dict[str, list[dict[str, object]]] = {}
    for run_dir in args.run_dirs:
        row = summarize(run_dir)
        key = version_key(str(row["label"]))
        groups.setdefault(key, []).append(row)

    order = ["original", *(f"v{i}" for i in range(1, 11))]
    missing = [key for key in order if key not in groups]
    if missing:
        raise ValueError(f"missing versions: {', '.join(missing)}")

    baseline = median(groups["original"], "hashes_per_second")
    if baseline is None:
        raise ValueError("original group has no hash rate")

    output = []
    for key in order:
        rows = groups[key]
        hash_sums = sorted({str(row["hash_sum"]) for row in rows})
        result: dict[str, object] = {
            **descriptions[key],
            "runs": len(rows),
            "hash_sums": hash_sums,
            "run_ids": sorted(str(row["run_id"]) for row in rows),
        }
        for metric in METRICS:
            result[f"median_{metric}"] = median(rows, metric)
        hps = float(result["median_hashes_per_second"])
        result["factor_vs_original"] = hps / baseline
        result["percent_vs_original"] = (hps / baseline - 1.0) * 100.0
        output.append(result)

    print(json.dumps(output, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
