#!/usr/bin/env python3
"""Build the lockfile-pinned vendored liblzma for the app's actual deployment target."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tarfile


def run(*args):
    subprocess.run(args, check=True, stdout=sys.stderr)


def prepare(app):
    import plistlib
    desktop = Path(__file__).resolve().parents[1]
    lock = (desktop / "src-tauri/Cargo.lock").read_text()
    package = re.search(r'(?m)^name = "liblzma-sys"\nversion = "([0-9.]+)"\nsource = "registry\+[^"\n]+"\nchecksum = "([0-9a-f]{64})"', lock)
    if package is None:
        raise ValueError("No registry-pinned liblzma-sys package in Cargo.lock")
    crate_version, checksum = package.groups()
    cargo_home = Path(os.environ.get("CARGO_HOME", str(Path.home() / ".cargo")))
    archives = list((cargo_home / "registry/cache").glob(f"*/liblzma-sys-{crate_version}.crate"))
    archive = next((p for p in archives if hashlib.sha256(p.read_bytes()).hexdigest() == checksum), None)
    if archive is None:
        raise ValueError("The lockfile-verified liblzma-sys archive must already be in Cargo's local cache")
    info = plistlib.loads((app / "Contents/Info.plist").read_bytes())
    minimum = info.get("LSMinimumSystemVersion")
    if minimum is None or not re.fullmatch(r"[0-9]+(?:\.[0-9]+){0,2}", minimum):
        raise ValueError("The application must declare a valid LSMinimumSystemVersion")
    main = app / "Contents/MacOS" / info["CFBundleExecutable"]
    architectures = sorted(subprocess.check_output(["lipo", "-archs", str(main)], text=True).split())
    if not architectures or any(arch not in {"arm64", "x86_64"} for arch in architectures):
        raise ValueError(f"Unsupported application architectures: {architectures}")
    compiler = subprocess.check_output(["xcrun", "clang", "--version"], text=True)
    sdk = subprocess.check_output(["xcrun", "--sdk", "macosx", "--show-sdk-path"], text=True).strip()
    identity = {"crateVersion": crate_version, "crateSha256": checksum,
                "minimumSystemVersion": minimum, "architectures": architectures,
                "compiler": compiler, "sdk": sdk,
                "builderSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}
    key = hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()[:20]
    cache = Path(os.environ.get("MONERO_DESKTOP_LZMA_CACHE", str(desktop.parents[1] / "build/desktop-macos-lzma")))
    work = cache / key
    source = work / f"liblzma-sys-{crate_version}" / "xz"
    build = work / "build"
    library = build / "liblzma.5.dylib"
    stamp = work / "verified-build.json"
    if stamp.is_file() and library.is_file():
        previous = json.loads(stamp.read_text())
        if previous.get("identity") == identity and previous.get("librarySha256") == hashlib.sha256(library.read_bytes()).hexdigest():
            return library
    work.mkdir(parents=True, exist_ok=True)
    # Extract only the authenticated crate's vendored xz sources; reject links
    # and path traversal rather than trusting archive member paths.
    prefix = f"liblzma-sys-{crate_version}/xz/"
    with tarfile.open(archive, "r:gz") as tar:
        members = [m for m in tar.getmembers() if m.name.startswith(prefix)]
        if not members:
            raise ValueError("Pinned liblzma-sys archive has no vendored xz source")
        for member in members:
            if not (work / member.name).resolve().is_relative_to(work.resolve()) or not (member.isfile() or member.isdir()):
                raise ValueError(f"Unsafe vendored source member: {member.name}")
        tar.extractall(work, members=members)
    run("cmake", "-S", str(source), "-B", str(build), "-G", "Ninja",
        "-DCMAKE_BUILD_TYPE=Release", f"-DCMAKE_OSX_DEPLOYMENT_TARGET={minimum}",
        f"-DCMAKE_OSX_ARCHITECTURES={';'.join(architectures)}", f"-DCMAKE_OSX_SYSROOT={sdk}",
        "-DBUILD_SHARED_LIBS=ON", "-DBUILD_TESTING=OFF", "-DXZ_NLS=OFF",
        "-DXZ_TOOL_XZ=OFF", "-DXZ_TOOL_XZDEC=OFF", "-DXZ_TOOL_LZMADEC=OFF",
        "-DXZ_TOOL_LZMAINFO=OFF", "-DXZ_DOC=OFF")
    run("cmake", "--build", str(build), "--target", "liblzma", "--parallel", "2")
    if not library.is_file():
        raise ValueError("Vendored xz build produced no liblzma.5.dylib")
    stamp.write_text(json.dumps({"identity": identity, "librarySha256": hashlib.sha256(library.read_bytes()).hexdigest()}, indent=2) + "\n")
    return library


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("app", type=Path)
    args = parser.parse_args()
    try:
        print(prepare(args.app.resolve()))
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        raise SystemExit(f"macOS liblzma preparation failed: {error}") from error
