#!/usr/bin/env python3
"""Aggregate repeated overnight XMRig experiments by label stem."""

from __future__ import annotations

import argparse
import importlib.util
import json
import re
import statistics
from pathlib import Path


ROOT = Path(__file__).resolve().parent
REPEAT_RE = re.compile(r"-(?:r|p)\d+$")
METRICS = (
    "hashes_per_second",
    "benchmark_seconds",
    "system_cpu_percent",
    "peak_total_resident_mib",
    "average_observed_mhz",
    "perf_instructions_per_cycle",
    "perf_cache_miss_percent",
    "perf_branch_miss_percent",
    "perf_context_switches",
    "perf_cpu_migrations",
    "perf_page_faults",
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


def is_standard_run(path: Path) -> bool:
    metadata = (path / "metadata.env").read_text(
        encoding="utf-8", errors="replace"
    )
    return "schema=xmrig_cpu_benchmark_v2" in metadata.splitlines()


def median(rows: list[dict[str, object]], key: str) -> float | None:
    values = [float(row[key]) for row in rows if row.get(key) is not None]
    return statistics.median(values) if values else None


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("run_dirs", nargs="+", type=Path)
    args = parser.parse_args()

    summarize = load_summarizer()
    groups: dict[str, list[dict[str, object]]] = {}
    run_dirs: list[Path] = []
    for path in args.run_dirs:
        if (path / "metadata.env").is_file():
            if is_standard_run(path):
                run_dirs.append(path)
        elif path.is_dir():
            run_dirs.extend(
                child
                for child in sorted(path.iterdir())
                if child.is_dir()
                and (child / "metadata.env").is_file()
                and is_standard_run(child)
            )

    if not run_dirs:
        parser.error("no benchmark result directories found")

    for run_dir in run_dirs:
        row = summarize(run_dir)
        label = str(row["label"])
        groups.setdefault(REPEAT_RE.sub("", label), []).append(row)

    output = []
    for label, rows in sorted(groups.items()):
        result: dict[str, object] = {
            "label": label,
            "runs": len(rows),
            "hash_sums": sorted({str(row["hash_sum"]) for row in rows}),
            "run_ids": sorted(str(row["run_id"]) for row in rows),
        }
        for metric in METRICS:
            result[f"median_{metric}"] = median(rows, metric)
        output.append(result)

    print(json.dumps(output, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
