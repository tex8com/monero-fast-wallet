#!/usr/bin/env python3
"""Map exported macOS Time Profiler PCs to MFW RandomX JIT instructions."""

from __future__ import annotations

import argparse
import bisect
import datetime
import json
import pathlib
import sys
import xml.etree.ElementTree as ET
from collections import Counter, defaultdict


def local_name(element: ET.Element) -> str:
    return element.tag.rsplit("}", 1)[-1]


def read_map(path: pathlib.Path) -> tuple[list[dict], dict[int, tuple[int, int]]]:
    programs = []
    events: dict[int, dict[str, dict]] = defaultdict(dict)
    with path.open(encoding="utf-8") as source:
        for line in source:
            record = json.loads(line)
            if record.get("record") == "program":
                programs.append(record)
            elif record.get("record") == "event":
                sequence = record.get("seq")
                event = record.get("event")
                if not isinstance(sequence, int) or event not in ("replay_start", "replay_end"):
                    continue
                if event in events[sequence]:
                    raise ValueError(f"duplicate {event} for program {sequence}")
                events[sequence][event] = record
    if not programs:
        raise ValueError("stable replay map contains no programs")

    programs.sort(key=lambda item: item["seq"])
    sequences = [program["seq"] for program in programs]
    if len(set(sequences)) != len(sequences):
        raise ValueError("stable replay map contains duplicate program sequences")

    windows = {}
    for sequence, pair in events.items():
        start = pair.get("replay_start", {}).get("wall_time_ns")
        end = pair.get("replay_end", {}).get("wall_time_ns")
        if isinstance(start, int) and isinstance(end, int) and end >= start:
            windows[sequence] = (start, end)
    return programs, windows


def trace_start_ns(path: pathlib.Path | None) -> int | None:
    if path is None:
        return None
    root = ET.parse(path).getroot()
    element = next((item for item in root.iter() if local_name(item) == "start-date"), None)
    if element is None or not element.text:
        raise ValueError("xctrace TOC has no start-date")
    stamp = datetime.datetime.fromisoformat(element.text.strip())
    return int(stamp.timestamp() * 1_000_000_000)


def build_id_map(root: ET.Element) -> dict[str, ET.Element]:
    return {element.attrib["id"]: element for element in root.iter() if "id" in element.attrib}


def dereference(element: ET.Element | None, ids: dict[str, ET.Element]) -> ET.Element | None:
    seen = set()
    while element is not None and "ref" in element.attrib:
        reference = element.attrib["ref"]
        if reference in seen or reference not in ids:
            return None
        seen.add(reference)
        element = ids[reference]
    return element


def child(element: ET.Element, name: str) -> ET.Element | None:
    return next((item for item in element if local_name(item) == name), None)


def integer_text(element: ET.Element | None, ids: dict[str, ET.Element], default: int = 0) -> int:
    element = dereference(element, ids)
    if element is None or element.text is None:
        return default
    try:
        return int(element.text.strip())
    except ValueError:
        return default


def load_samples(path: pathlib.Path, programs: list[dict],
                 replay_windows: dict[int, tuple[int, int]], trace_epoch_ns: int | None) -> dict:
    tree = ET.parse(path)
    root = tree.getroot()
    ids = build_id_map(root)

    program_by_sequence = {program["seq"]: program for program in programs}
    interval_maps = {}
    for program in programs:
        base = program["native_base"]
        intervals = []
        for instruction in program["instructions"]:
            begin = base + instruction["native_offset"]
            end = begin + instruction["native_size"]
            if end > begin:
                intervals.append((begin, end, instruction))
        intervals.sort(key=lambda entry: entry[0])
        interval_maps[program["seq"]] = ([entry[0] for entry in intervals], intervals)

    def locate(sequence: int, address: int):
        # Instruments reports anonymous AArch64 sample PCs with low metadata bits
        # in some rows. Native instructions are four-byte aligned.
        address &= ~3
        starts, intervals = interval_maps[sequence]
        index = bisect.bisect_right(starts, address) - 1
        if index >= 0 and intervals[index][0] <= address < intervals[index][1]:
            return intervals[index][2], address
        return None, address

    roi_enabled = trace_epoch_ns is not None and all(
        sequence in replay_windows for sequence in program_by_sequence
    )
    if len(programs) > 1 and not roi_enabled:
        raise ValueError("multi-program attribution requires complete replay windows and an xctrace TOC")

    roi_windows = []
    if roi_enabled:
        for sequence, (start, end) in replay_windows.items():
            if sequence in program_by_sequence:
                roi_windows.append((start - trace_epoch_ns, end - trace_epoch_ns, sequence))
        roi_windows.sort()
    roi_starts = [window[0] for window in roi_windows]

    def active_sequence(sample_time: int) -> int | None:
        if not roi_enabled:
            return programs[0]["seq"]
        index = bisect.bisect_right(roi_starts, sample_time) - 1
        if index >= 0 and roi_windows[index][0] <= sample_time <= roi_windows[index][1]:
            return roi_windows[index][2]
        return None

    type_weight = Counter()
    type_samples = Counter()
    instruction_weight: Counter[tuple[int, int]] = Counter()
    instruction_samples: Counter[tuple[int, int]] = Counter()
    core_weight = defaultdict(Counter)
    program_weight = Counter()
    program_samples = Counter()
    total_samples = 0
    total_weight = 0
    mapped_samples = 0
    mapped_weight = 0
    p_core_weight = 0
    e_core_weight = 0
    for row in (element for element in root.iter() if local_name(element) == "row"):
        sample_time = integer_text(child(row, "sample-time"), ids, -1)
        sequence = active_sequence(sample_time)
        if sequence is None:
            continue
        # Xcode 26 exports Time Profiler rows with a direct <backtrace>, while
        # older exports and some templates wrap it in <tagged-backtrace>.
        # Accept both shapes so a trace cannot silently appear sample-free
        # merely because it was recorded by a different Instruments version.
        backtrace = dereference(child(row, "backtrace"), ids)
        if backtrace is None:
            tagged = dereference(child(row, "tagged-backtrace"), ids)
            if tagged is not None:
                backtrace = dereference(child(tagged, "backtrace"), ids)
        if backtrace is None:
            continue

        frames = [dereference(item, ids) for item in backtrace if local_name(item) == "frame"]
        mapped = None
        normalized_pc = None
        for frame in frames:
            if frame is None or "addr" not in frame.attrib:
                continue
            try:
                address = int(frame.attrib["addr"], 16)
            except ValueError:
                continue
            instruction, pc = locate(sequence, address)
            if instruction is not None:
                mapped = instruction
                normalized_pc = pc
                break

        weight = integer_text(child(row, "weight"), ids, 1)
        total_samples += 1
        total_weight += weight
        if mapped is None:
            continue

        mapped_samples += 1
        mapped_weight += weight
        name = mapped["type"]
        virtual_pc = mapped["pc"]
        type_samples[name] += 1
        type_weight[name] += weight
        instruction_key = (sequence, virtual_pc)
        instruction_samples[instruction_key] += 1
        instruction_weight[instruction_key] += weight
        program_samples[sequence] += 1
        program_weight[sequence] += weight

        core = dereference(child(row, "core"), ids)
        core_format = core.attrib.get("fmt", "unknown") if core is not None else "unknown"
        if "P Core" in core_format:
            p_core_weight += weight
            core_weight[name]["P"] += weight
        elif "E Core" in core_format:
            e_core_weight += weight
            core_weight[name]["E"] += weight
        else:
            core_weight[name]["unknown"] += weight

    def percent(value: int, denominator: int) -> float:
        return round(100.0 * value / denominator, 4) if denominator else 0.0

    by_type = []
    for name, weight in type_weight.most_common():
        by_type.append({
            "type": name,
            "samples": type_samples[name],
            "weight_ns": weight,
            "mapped_weight_percent": percent(weight, mapped_weight),
            "p_core_weight_ns": core_weight[name]["P"],
            "e_core_weight_ns": core_weight[name]["E"],
        })

    by_instruction = []
    for (sequence, virtual_pc), weight in instruction_weight.most_common():
        instruction = program_by_sequence[sequence]["instructions"][virtual_pc]
        by_instruction.append({
            "seq": sequence,
            "pc": virtual_pc,
            "type": instruction["type"],
            "samples": instruction_samples[(sequence, virtual_pc)],
            "weight_ns": weight,
            "mapped_weight_percent": percent(weight, mapped_weight),
            "native_offset": instruction["native_offset"],
            "native_size": instruction["native_size"],
        })

    first = programs[0]
    by_program = [{
        "seq": sequence,
        "mapped_samples": program_samples[sequence],
        "mapped_weight_ns": program_weight[sequence],
        "mapped_weight_percent": percent(program_weight[sequence], mapped_weight),
    } for sequence in sorted(program_by_sequence)]
    serialized_windows = [{"seq": sequence, "start_ns": start, "end_ns": end}
                          for start, end, sequence in roi_windows]

    return {
        "schema": 1,
        "kind": "mfw-jit-corpus-xctrace-time-profile",
        "source": str(path),
        "randomx": first["randomx"],
        "backend": first["backend"],
        "mode": first["mode"],
        "programs": len(programs),
        "native_bases": sorted(set(program["native_base"] for program in programs)),
        "total_samples": total_samples,
        "total_weight_ns": total_weight,
        "mapped_jit_samples": mapped_samples,
        "mapped_jit_weight_ns": mapped_weight,
        "mapped_jit_sample_percent": percent(mapped_samples, total_samples),
        "mapped_jit_weight_percent": percent(mapped_weight, total_weight),
        "p_core_mapped_weight_ns": p_core_weight,
        "e_core_mapped_weight_ns": e_core_weight,
        "replay_roi_filter": roi_enabled,
        "replay_roi_windows": serialized_windows,
        "by_program": by_program,
        "by_type": by_type,
        "by_instruction": by_instruction,
        "warning": "Sampling weights are statistical CPU time, not exact cycles. Light-mode replay is not Fast-mode H/s.",
    }


def markdown(result: dict) -> str:
    lines = [
        f"# MFW JIT Time Profiler — RandomX v{result['randomx']}",
        "",
        f"Programs in deterministic replay corpus: **{result['programs']}**.",
        "",
        f"Mapped JIT samples: **{result['mapped_jit_samples']} / {result['total_samples']}** "
        f"({result['mapped_jit_sample_percent']}%).",
        "",
        "> Sampling weights are statistical CPU time. The replay uses light mode and is not a Fast-mode H/s benchmark.",
        "",
        "| Instruction type | Samples | Weight (ms) | Share of mapped JIT | P-core ms | E-core ms |",
        "|---|---:|---:|---:|---:|---:|",
    ]
    for item in result["by_type"]:
        lines.append(
            f"| {item['type']} | {item['samples']} | {item['weight_ns'] / 1e6:.3f} | "
            f"{item['mapped_weight_percent']:.3f}% | {item['p_core_weight_ns'] / 1e6:.3f} | "
            f"{item['e_core_weight_ns'] / 1e6:.3f} |"
        )
    lines.extend([
        "",
        "## Hottest virtual PCs",
        "",
        "| Program | PC | Type | Samples | Weight (ms) | Share | Native offset | Bytes |",
        "|---:|---:|---|---:|---:|---:|---:|---:|",
    ])
    for item in result["by_instruction"][:30]:
        lines.append(
            f"| {item['seq']} | {item['pc']} | {item['type']} | {item['samples']} | {item['weight_ns'] / 1e6:.3f} | "
            f"{item['mapped_weight_percent']:.3f}% | {item['native_offset']} | {item['native_size']} |"
        )
    lines.append("")
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("map", type=pathlib.Path)
    parser.add_argument("samples", type=pathlib.Path)
    parser.add_argument("--toc", type=pathlib.Path)
    parser.add_argument("--json", type=pathlib.Path, dest="json_output")
    parser.add_argument("--markdown", type=pathlib.Path, dest="markdown_output")
    args = parser.parse_args()

    try:
        programs, replay_windows = read_map(args.map)
        result = load_samples(args.samples, programs, replay_windows, trace_start_ns(args.toc))
    except (OSError, ValueError, ET.ParseError, json.JSONDecodeError) as error:
        print(f"jit-corpus xctrace: FAIL: {error}", file=sys.stderr)
        return 2

    encoded = json.dumps(result, indent=2, sort_keys=True) + "\n"
    rendered = markdown(result) + "\n"
    if args.json_output:
        args.json_output.write_text(encoded, encoding="utf-8")
    if args.markdown_output:
        args.markdown_output.write_text(rendered, encoding="utf-8")
    if not args.json_output and not args.markdown_output:
        print(encoded, end="")
    print(
        f"jit-corpus xctrace: PASS ({result['mapped_jit_samples']} mapped JIT samples)",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
