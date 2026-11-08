#!/usr/bin/env python3
"""Always run RN codegen, preserving timestamps only for byte-identical output.

This avoids rebuilding every native module on an archive retry. Changed, new or
removed generated inputs still invalidate Xcode's dependency graph normally.
"""
import hashlib
from pathlib import Path
import os
import subprocess
import sys

app = Path(__file__).resolve().parents[1]
react = app / "node_modules/react-native"
generated = app / "ios/build/generated/ios"
before = {}
for path in generated.rglob("*"):
    if path.is_file() and not path.is_symlink():
        metadata = path.stat()
        before[path] = (hashlib.sha256(path.read_bytes()).digest(),
                        metadata.st_atime_ns, metadata.st_mtime_ns)

result = subprocess.run([
    "node", "scripts/generate-codegen-artifacts.js", "--path", str(app),
    "--outputPath", str(app / "ios"), "--targetPlatform", "ios",
], cwd=react)
preserved = 0
for path, (digest, accessed, modified) in before.items():
    if (path.is_file() and not path.is_symlink()
            and hashlib.sha256(path.read_bytes()).digest() == digest):
        os.utime(path, ns=(accessed, modified))
        preserved += 1
print(f"Preserved timestamps for {preserved} unchanged generated files")
sys.exit(result.returncode)
