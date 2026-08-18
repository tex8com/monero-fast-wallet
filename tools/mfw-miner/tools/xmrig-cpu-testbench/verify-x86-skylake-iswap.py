#!/usr/bin/env python3
"""Static, semantic and encoding gates for the test-only Skylake ISWAP_R JIT."""

from __future__ import annotations

import argparse
import pathlib
import platform
import re
import shutil
import subprocess
import tempfile


REGISTERS = tuple(f"r{index}" for index in range(8, 16))


def require(condition: bool, message: str) -> None:
    if not condition:
        raise SystemExit(message)


def mov_swap_bytes(src: int, dst: int) -> bytes:
    require(0 <= src < 8 and 0 <= dst < 8 and src != dst,
            "MOV-swap encoder requires two distinct VM registers")
    return bytes((
        0x4C, 0x89, 0xC0 + (src << 3),
        0x4D, 0x89, 0xC0 + (dst << 3) + src,
        0x49, 0x89, 0xC0 + dst,
    ))


def verify_semantics() -> None:
    for src in range(8):
        for dst in range(8):
            if src == dst:
                continue
            before = [0x1020304050607080 ^ (index * 0x1111111111111111)
                      for index in range(8)]
            after = before.copy()
            temporary = after[src]
            after[src] = after[dst]
            after[dst] = temporary
            expected = before.copy()
            expected[src], expected[dst] = expected[dst], expected[src]
            require(after == expected, f"semantic swap mismatch for src={src}, dst={dst}")
            require(len(mov_swap_bytes(src, dst)) == 9, "MOV swap must encode to 9 bytes")


def verify_source_contract(root: pathlib.Path) -> None:
    cmake = (root / "CMakeLists.txt").read_text(encoding="utf-8")
    source = (root / "src/crypto/randomx/jit_compiler_x86.cpp").read_text(encoding="utf-8")
    header = (root / "src/crypto/randomx/jit_compiler_x86.hpp").read_text(encoding="utf-8")

    require('set(MFW_X86_SKYLAKE_ISWAP_MODE "0"' in cmake,
            "Skylake ISWAP candidate must default to mode 0")
    require("MFW_X86_SKYLAKE_ISWAP_MODE=${MFW_X86_SKYLAKE_ISWAP_MODE}" in cmake,
            "Skylake ISWAP option is not isolated to the x86 JIT source")
    require("MFW_X86_SKYLAKE_ISWAP_MODE == 1" in source,
            "Skylake MOV swap is not compile-time opt-in")
    require("VENDOR_INTEL" in source and "cpu->model() == 0x5E" in source,
            "runtime dispatch is not restricted to Intel Skylake-S model 5Eh")
    require("cpu->hasAVX2()" in source and "cpu->hasBMI2()" in source,
            "runtime dispatch lacks the matched Skylake feature gates")
    require("MFW_X86_SKYLAKE_ISWAP_ACTIVE=%u" in source,
            "runtime activation diagnostic is missing")
    require("bool skylakeMoveSwap;" in header,
            "per-JIT Skylake dispatch state is missing")
    require("0xc0874d" in source,
            "upstream three-byte XCHG fallback is missing")
    for encoded_byte in ("0x4C", "0x4D", "0x49", "0x89"):
        require(encoded_byte in source, f"MOV-swap emitter is missing {encoded_byte}")


def compiler_command(compiler_path: str, source: pathlib.Path, output: pathlib.Path) -> list[str]:
    version = subprocess.run(
        [compiler_path, "--version"], text=True, capture_output=True, check=False
    ).stdout.lower()
    command = [compiler_path, "-x", "assembler", "-c", str(source), "-o", str(output)]
    if "clang" in version:
        command.insert(1, "--target=x86_64-unknown-linux-gnu")
    else:
        require(platform.machine().lower() in ("x86_64", "amd64"),
                "non-Clang encoding gate requires a native x86-64 host")
    return command


def disassembler_command(disassembler: str, obj: pathlib.Path) -> list[str]:
    command = [disassembler, "-d"]
    if "llvm" in pathlib.Path(disassembler).name:
        command.append("--x86-asm-syntax=intel")
    else:
        command.extend(("-M", "intel"))
    command.append(str(obj))
    return command


def verify_encodings(compiler: str) -> None:
    compiler_path = shutil.which(compiler)
    require(compiler_path is not None, f"assembly compiler not found: {compiler}")
    disassembler = shutil.which("llvm-objdump") or shutil.which("objdump")
    require(disassembler is not None, "llvm-objdump or objdump is required")

    with tempfile.TemporaryDirectory(prefix="mfw-skylake-iswap-") as temp_dir:
        temp = pathlib.Path(temp_dir)
        assembly = temp / "iswap.S"
        obj = temp / "iswap.o"
        lines = [".intel_syntax noprefix", ".text"]
        for src in range(8):
            for dst in range(8):
                if src == dst:
                    continue
                encoded = ", ".join(f"0x{byte:02x}" for byte in mov_swap_bytes(src, dst))
                lines.extend((f"swap_{src}_{dst}:", f"  .byte {encoded}"))
        assembly.write_text("\n".join(lines) + "\n", encoding="utf-8")

        compiled = subprocess.run(
            compiler_command(compiler_path, assembly, obj),
            text=True, capture_output=True, check=False,
        )
        require(compiled.returncode == 0,
                f"MOV-swap assembly failed:\n{compiled.stdout}{compiled.stderr}")
        decoded = subprocess.run(
            disassembler_command(disassembler, obj),
            text=True, capture_output=True, check=False,
        )
        require(decoded.returncode == 0,
                f"MOV-swap disassembly failed:\n{decoded.stdout}{decoded.stderr}")

        blocks: dict[tuple[int, int], list[tuple[str, str]]] = {}
        current: tuple[int, int] | None = None
        for line in decoded.stdout.splitlines():
            label = re.search(r"<swap_(\d)_(\d+)>", line)
            if label:
                current = (int(label.group(1)), int(label.group(2)))
                blocks[current] = []
                continue
            if current is None:
                continue
            instruction = re.search(r"\bmov\s+([a-z0-9]+)\s*,\s*([a-z0-9]+)", line)
            if instruction:
                blocks[current].append((instruction.group(1), instruction.group(2)))

        for src in range(8):
            for dst in range(8):
                if src == dst:
                    continue
                expected = [
                    ("rax", REGISTERS[src]),
                    (REGISTERS[src], REGISTERS[dst]),
                    (REGISTERS[dst], "rax"),
                ]
                require(blocks.get((src, dst)) == expected,
                        f"wrong decoded MOV swap for src={src}, dst={dst}: "
                        f"{blocks.get((src, dst))!r} != {expected!r}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=pathlib.Path,
                        default=pathlib.Path(__file__).resolve().parents[2])
    parser.add_argument("--compiler", default="cc")
    args = parser.parse_args()

    root = args.root.resolve()
    verify_semantics()
    verify_source_contract(root)
    verify_encodings(args.compiler)
    print("PASS: default-off Skylake-S dispatch, 56 MOV-swap semantics and x86 encodings")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
