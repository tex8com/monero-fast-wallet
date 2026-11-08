#!/usr/bin/env bash
set -euo pipefail

# Keep validation artifacts out of source trees and limit simultaneous compilers.
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fixture="$repo_root/third_party/crypto-bigint-migration/validation/Cargo.toml"
cd "$repo_root"
validation_output="${MFW_CRYPTO_VALIDATION_OUTPUT_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/mfw-bigint-validation.XXXXXX")}"
mkdir -p "$validation_output"
export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-2}"
case "$CARGO_BUILD_JOBS" in 1|2) ;; *) echo "Crypto validation supports CARGO_BUILD_JOBS=1 or 2." >&2; exit 2 ;; esac
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$validation_output/target}"

python3 - "$repo_root" <<'PY'
import hashlib
import json
from pathlib import Path
import sys

root = Path(sys.argv[1])
sources = json.loads((root / "third_party/crypto-bigint-migration/VENDOR-SOURCES.json").read_text())
for package in sources["crates"]:
    for relative, expected in package["files_sha256"].items():
        path = root / "third_party" / package["crate"] / relative
        assert hashlib.sha256(path.read_bytes()).hexdigest() == expected, str(path)
PY

rustc --version > "$validation_output/rustc.txt"
cargo tree --locked --manifest-path "$fixture" --edges normal > "$validation_output/cargo-tree-normal.txt"
cargo test --locked --release --manifest-path "$fixture" > "$validation_output/release-tests.log" 2>&1
cargo rustc --locked --release --manifest-path "$fixture" --bin timing -- --emit=asm > "$validation_output/timing-build.log" 2>&1
"$CARGO_TARGET_DIR/release/timing" > "$validation_output/release-timing.json"
python3 - "$CARGO_TARGET_DIR" "$validation_output" <<'PY'
import json
from pathlib import Path
import shutil
import sys

target, output = map(Path, sys.argv[1:])
assembly = max((target / "release/deps").glob("timing-*.s"), key=lambda p: p.stat().st_mtime)
shutil.copy2(assembly, output / "release-timing.s")
result = json.loads((output / "release-timing.json").read_text())
tree = (output / "cargo-tree-normal.txt").read_text()
assert "crypto-bigint v0.7.10" in tree
assert "crypto-bigint v0.5" not in tree, "validation unexpectedly resolved vulnerable crypto-bigint"
print("Optimized arithmetic/vector tests passed. Target:", result["arch"], result["os"])
print("Timing is diagnostic only; it does not prove constant-time execution.")
print("Artifacts:", output)
PY
