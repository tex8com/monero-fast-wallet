#!/usr/bin/env python3
"""Deterministic regression tests for the macOS and Linux JIT PC resolvers."""

from __future__ import annotations

import importlib.util
import json
import pathlib
import tempfile


HERE = pathlib.Path(__file__).resolve().parent


def load(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, HERE / filename)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def program(sequence: int, instruction_type: str) -> dict:
    return {
        "record": "program",
        "seq": sequence,
        "randomx": 2,
        "backend": "aarch64",
        "mode": "light",
        "native_base": 0x100000000,
        "instructions": [{
            "pc": 0,
            "type": instruction_type,
            "native_offset": 0x100,
            "native_size": 4,
        }],
    }


def main() -> int:
    xctrace = load("mfw_analyze_xctrace", "analyze-xctrace.py")
    perf = load("mfw_analyze_perf", "analyze-perf.py")
    wall_epoch = 1_700_000_000_000_000_000
    monotonic_epoch = 400_000_000_000
    records = []
    for sequence, name in enumerate(("IADD_RS", "FMUL_R")):
        records.append(program(sequence, name))
        records.append({
            "record": "event", "event": "replay_start", "seq": sequence,
            "wall_time_ns": wall_epoch + sequence * 2_000_000_000,
            "monotonic_ns": monotonic_epoch + sequence * 2_000_000_000,
        })
        records.append({
            "record": "event", "event": "replay_end", "seq": sequence,
            "wall_time_ns": wall_epoch + sequence * 2_000_000_000 + 1_000_000_000,
            "monotonic_ns": monotonic_epoch + sequence * 2_000_000_000 + 1_000_000_000,
        })

    with tempfile.TemporaryDirectory() as directory:
        root = pathlib.Path(directory)
        map_path = root / "map.ndjson"
        map_path.write_text("".join(json.dumps(record) + "\n" for record in records), encoding="utf-8")

        programs, wall_windows = xctrace.read_map(map_path)
        rows = []
        for sequence in range(2):
            sample_time = sequence * 2_000_000_000 + 500_000_000
            if sequence == 0:
                backtrace = ('<tagged-backtrace><backtrace><frame addr="0x100000100"/>'
                             '</backtrace></tagged-backtrace>')
            else:
                backtrace = '<backtrace><frame addr="0x100000100"/></backtrace>'
            rows.append(
                f'<row><sample-time>{sample_time}</sample-time>'
                f'{backtrace}<weight>7</weight>'
                '<core fmt="P Core 0"/></row>'
            )
        xctrace_path = root / "samples.xml"
        xctrace_path.write_text("<trace>" + "".join(rows) + "</trace>", encoding="utf-8")
        xctrace_result = xctrace.load_samples(xctrace_path, programs, wall_windows, wall_epoch)
        assert xctrace_result["mapped_jit_samples"] == 2
        assert [item["type"] for item in xctrace_result["by_instruction"]] == ["IADD_RS", "FMUL_R"]

        programs, monotonic_windows = perf.read_map(map_path)
        perf_path = root / "perf-script.txt"
        perf_path.write_text(
            f"{(monotonic_epoch + 500_000_000) / 1e9:.9f}: 100000100\n"
            f"{(monotonic_epoch + 2_500_000_000) / 1e9:.9f}: 100000100\n",
            encoding="utf-8",
        )
        perf_result = perf.load_samples(perf_path, programs, monotonic_windows)
        assert perf_result["mapped_jit_samples"] == 2
        assert [item["type"] for item in perf_result["by_instruction"]] == ["IADD_RS", "FMUL_R"]

    print("jit-corpus analyzer regression: PASS (2 programs, reused native address)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
