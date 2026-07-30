#!/usr/bin/env python3
"""Aggregate dual-CCD XMRig experiments and validate their paired results."""

from __future__ import annotations

import argparse
import importlib.util
import json
import re
import statistics
from pathlib import Path


ROOT = Path(__file__).resolve().parent
PAIR_RE = re.compile(r"-p\d+$")
EXPECTED_HASHES = {
    "100K": "BC4EF98B60B98579",
    "250K": "7D6054757BB08A63",
}


def load_summarizer():
    spec = importlib.util.spec_from_file_location(
        "xmrig_summarize", ROOT / "summarize.py"
    )
    if spec is None or spec.loader is None:
        raise RuntimeError("unable to load summarize.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.summarize


def read_metadata(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        if "=" in line:
            key, value = line.split("=", 1)
            values[key] = value
    return values


def discover_orchestrators(paths: list[Path]) -> list[Path]:
    candidates: set[Path] = set()
    for path in paths:
        if path.is_file() and path.name == "metadata.env":
            candidates.add(path.parent)
        elif (path / "metadata.env").is_file():
            candidates.add(path)
        elif path.is_dir():
            candidates.update(item.parent for item in path.rglob("metadata.env"))

    return sorted(
        path
        for path in candidates
        if read_metadata(path / "metadata.env").get("schema")
        == "xmrig_cpu_dual_ccd_v1"
    )


def resolve_result(orchestrator: Path, recorded_path: str) -> Path:
    direct = Path(recorded_path)
    if direct.is_dir():
        return direct
    sibling = orchestrator.parent / direct.name
    if sibling.is_dir():
        return sibling
    raise FileNotFoundError(
        f"result referenced by {orchestrator} was not found: {recorded_path}"
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("paths", nargs="+", type=Path)
    args = parser.parse_args()

    orchestrators = discover_orchestrators(args.paths)
    if not orchestrators:
        parser.error("no dual-CCD orchestrator directories found")

    summarize = load_summarizer()
    rows: list[dict[str, object]] = []
    errors: list[str] = []
    for orchestrator in orchestrators:
        metadata = read_metadata(orchestrator / "metadata.env")
        label = metadata.get("label", orchestrator.name)
        try:
            ccd0_dir = resolve_result(orchestrator, metadata["ccd0_result"])
            ccd1_dir = resolve_result(orchestrator, metadata["ccd1_result"])
            ccd0 = summarize(ccd0_dir)
            ccd1 = summarize(ccd1_dir)
        except (KeyError, FileNotFoundError) as exc:
            errors.append(f"{orchestrator}: {exc}")
            continue

        row_errors: list[str] = []
        for key in (
            "ccd0_exit_status",
            "ccd1_exit_status",
        ):
            if metadata.get(key) != "0":
                row_errors.append(f"{key}={metadata.get(key, '<missing>')}")
        for key in ("msr_restored", "one_gb_pages_restored"):
            if metadata.get(key) != "1":
                row_errors.append(f"{key}={metadata.get(key, '<missing>')}")

        hash_sums = {ccd0.get("hash_sum"), ccd1.get("hash_sum")}
        if len(hash_sums) != 1 or None in hash_sums:
            row_errors.append(f"CCD hash sums differ: {sorted(map(str, hash_sums))}")
        elif next(iter(hash_sums)) not in EXPECTED_HASHES.values():
            row_errors.append(f"unexpected hash sum: {next(iter(hash_sums))}")

        for name, result in (("ccd0", ccd0), ("ccd1", ccd1)):
            if result.get("timed_out"):
                row_errors.append(f"{name} timed out")
            if result.get("miner_exit_status") != 0:
                row_errors.append(
                    f"{name} miner_exit_status={result.get('miner_exit_status')}"
                )
            if result.get("hashes_per_second") is None:
                row_errors.append(f"{name} has no benchmark result")

        if row_errors:
            errors.append(f"{orchestrator}: {', '.join(row_errors)}")
            continue

        ccd0_hps = float(ccd0["hashes_per_second"])
        ccd1_hps = float(ccd1["hashes_per_second"])
        rows.append(
            {
                "label": label,
                "run_id": metadata.get("run_id", orchestrator.name),
                "ccd0_hashes_per_second": ccd0_hps,
                "ccd1_hashes_per_second": ccd1_hps,
                "combined_hashes_per_second": ccd0_hps + ccd1_hps,
                "hash_sum_each_process": ccd0["hash_sum"],
                "ccd0_result": ccd0_dir.name,
                "ccd1_result": ccd1_dir.name,
            }
        )

    groups: dict[str, list[dict[str, object]]] = {}
    for row in rows:
        groups.setdefault(PAIR_RE.sub("", str(row["label"])), []).append(row)

    aggregates = []
    for label, group_rows in sorted(groups.items()):
        aggregates.append(
            {
                "label": label,
                "runs": len(group_rows),
                "median_ccd0_hashes_per_second": statistics.median(
                    float(row["ccd0_hashes_per_second"]) for row in group_rows
                ),
                "median_ccd1_hashes_per_second": statistics.median(
                    float(row["ccd1_hashes_per_second"]) for row in group_rows
                ),
                "median_combined_hashes_per_second": statistics.median(
                    float(row["combined_hashes_per_second"]) for row in group_rows
                ),
            }
        )

    print(
        json.dumps(
            {
                "orchestrator_count": len(orchestrators),
                "valid_count": len(rows),
                "invalid_count": len(errors),
                "errors": errors,
                "aggregates": aggregates,
                "runs": rows,
            },
            indent=2,
            sort_keys=True,
        )
    )
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
