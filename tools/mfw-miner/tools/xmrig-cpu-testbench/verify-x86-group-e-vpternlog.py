#!/usr/bin/env python3
"""Static and assembly gates for the test-only Zen 4 Group-E JIT path."""

from __future__ import annotations

import argparse
import pathlib
import platform
import shutil
import subprocess
import tempfile


EXPECTED_IMMEDIATE = 0xEA


def vpternlog_bit(immediate: int, converted: int, mask: int, exponent: int) -> int:
    index = (converted << 2) | (mask << 1) | exponent
    return (immediate >> index) & 1


def require(condition: bool, message: str) -> None:
    if not condition:
        raise SystemExit(message)


def verify_truth_table() -> None:
    rows = []
    for converted in (0, 1):
        for mask in (0, 1):
            for exponent in (0, 1):
                actual = vpternlog_bit(EXPECTED_IMMEDIATE, converted, mask, exponent)
                expected = (converted & mask) | exponent
                require(
                    actual == expected,
                    f"truth-table mismatch for converted={converted}, mask={mask}, "
                    f"exponent={exponent}: {actual} != {expected}",
                )
                rows.append((converted, mask, exponent, actual))

    reconstructed = sum(result << ((converted << 2) | (mask << 1) | exponent)
                        for converted, mask, exponent, result in rows)
    require(reconstructed == EXPECTED_IMMEDIATE,
            f"truth table reconstructs 0x{reconstructed:02X}, expected 0x{EXPECTED_IMMEDIATE:02X}")


def verify_source_contract(root: pathlib.Path) -> None:
    generic = (root / "src/crypto/randomx/asm/program_loop_load.inc").read_text(encoding="utf-8")
    candidate = (root / "src/crypto/randomx/asm/program_loop_load_avx512vl.inc").read_text(encoding="utf-8")
    gas = (root / "src/crypto/randomx/jit_compiler_x86_static.S").read_text(encoding="utf-8")
    masm = (root / "src/crypto/randomx/jit_compiler_x86_static.asm").read_text(encoding="utf-8")
    jit = (root / "src/crypto/randomx/jit_compiler_x86.cpp").read_text(encoding="utf-8")
    cpu_interface = (root / "src/backend/cpu/interfaces/ICpuInfo.h").read_text(encoding="utf-8")
    cpu = (root / "src/backend/cpu/platform/BasicCpuInfo.cpp").read_text(encoding="utf-8")
    cmake = (root / "CMakeLists.txt").read_text(encoding="utf-8")

    require(generic.count("andpd xmm") == 4 and generic.count("orpd xmm") == 4,
            "generic SSE Group-E template changed or is incomplete")
    require("vpternlog" not in generic.lower(), "generic SSE fallback contains VPTERNLOG")
    require(candidate.lower().count("vpternlogq xmm") == 4,
            "candidate must contain exactly four 128-bit VPTERNLOGQ instructions")
    require(candidate.count("RANDOMX_GROUP_E_TERNARY_IMM") == 5,
            "candidate must use the shared immediate symbol for its comment and four instructions")
    require("#define RANDOMX_GROUP_E_TERNARY_IMM  0xEA" in gas,
            "GNU assembly immediate is not 0xEA")
    require("RANDOMX_GROUP_E_TERNARY_IMM EQU 0EAh" in masm,
            "MASM immediate is not 0xEA")
    require("FLAG_AVX512VL" in cpu_interface, "AVX512VL capability flag is missing")
    require("1U << 31" in cpu and "has_avx512vl()" in cpu,
            "AVX512VL CPUID leaf-7 EBX bit-31 detection is missing")
    require("FLAG_AVX512F" in jit and "FLAG_AVX512VL" in jit and "ARCH_ZEN4" in jit,
            "candidate dispatch is not gated by Zen 4, AVX512F, and AVX512VL")
    require('set(MFW_X86_GROUP_E_MODE "0"' in cmake,
            "test-only Group-E mode must default to upstream SSE")
    require("MFW_X86_GROUP_E_MODE == 1" in jit,
            "candidate dispatch is not compile-time opt-in")
    require("MFW_X86_GROUP_E_ACTIVE=%u" in jit,
            "candidate runtime activation diagnostic is missing")
    require("kGroupETernaryImmediate == 0xEA" in jit,
            "C++ compile-time immediate assertion is missing")


def verify_gnu_assembly(root: pathlib.Path, compiler: str) -> None:
    compiler_path = shutil.which(compiler)
    require(compiler_path is not None, f"assembly compiler not found: {compiler}")

    source = root / "src/crypto/randomx/jit_compiler_x86_static.S"
    include_dir = root / "src/crypto/randomx"
    disassembler = shutil.which("llvm-objdump") or shutil.which("objdump")
    if disassembler is None and shutil.which("xcrun"):
        lookup = subprocess.run(["xcrun", "--find", "llvm-objdump"], text=True,
                                capture_output=True, check=False)
        if lookup.returncode == 0:
            disassembler = lookup.stdout.strip()
    require(disassembler is not None, "llvm-objdump or objdump is required for the encoding gate")

    with tempfile.TemporaryDirectory(prefix="mfw-group-e-") as temp_dir:
        for mode, expected_instructions in ((0, 0), (1, 4)):
            output = pathlib.Path(temp_dir) / f"jit_compiler_x86_static_mode{mode}.o"
            compiler_version = subprocess.run(
                [compiler_path, "--version"], text=True, capture_output=True, check=False
            ).stdout.lower()
            command = [
                compiler_path,
                "-x",
                "assembler-with-cpp",
                f"-DMFW_X86_GROUP_E_MODE={mode}",
                "-I",
                str(include_dir),
                "-c",
                str(source),
                "-o",
                str(output),
            ]
            if "clang" in compiler_version:
                command.insert(1, "--target=x86_64-unknown-linux-gnu")
            else:
                require(platform.machine().lower() in ("x86_64", "amd64"),
                        "non-Clang assembly gate requires a native x86-64 host")
            result = subprocess.run(command, text=True, capture_output=True, check=False)
            require(result.returncode == 0,
                    f"x86-64 GNU assembly mode {mode} compile failed:\n"
                    f"{result.stdout}{result.stderr}")
            require(output.stat().st_size > 0, "assembly compiler produced an empty object")

            disassembler_args = [disassembler, "-d"]
            if "llvm" in pathlib.Path(disassembler).name:
                disassembler_args.append("--x86-asm-syntax=intel")
            else:
                disassembler_args.extend(["-M", "intel"])
            disassembler_args.append(str(output))
            disassembly = subprocess.run(
                disassembler_args,
                text=True,
                capture_output=True,
                check=False,
            )
            require(disassembly.returncode == 0,
                    f"x86-64 mode {mode} object disassembly failed:\n"
                    f"{disassembly.stdout}{disassembly.stderr}")
            ternary_lines = [line.lower() for line in disassembly.stdout.splitlines()
                             if "vpternlogq" in line.lower()]
            require(len(ternary_lines) == expected_instructions,
                    f"mode {mode}: expected {expected_instructions} encoded VPTERNLOGQ "
                    f"instructions, found {len(ternary_lines)}")
            require(mode == 0 or all("0xea" in line for line in ternary_lines),
                    "an encoded VPTERNLOGQ instruction does not use immediate 0xEA")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=pathlib.Path,
                        default=pathlib.Path(__file__).resolve().parents[2])
    parser.add_argument("--compiler", default="cc")
    parser.add_argument("--skip-assembly", action="store_true")
    args = parser.parse_args()

    root = args.root.resolve()
    verify_truth_table()
    verify_source_contract(root)
    if not args.skip_assembly:
        verify_gnu_assembly(root, args.compiler)

    print("PASS: VPTERNLOGQ 0xEA truth table, opt-in gates, SSE fallback, and x86-64 assembly")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
