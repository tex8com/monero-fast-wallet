#!/usr/bin/env python3
"""Package an unsigned iPhone archive for re-signing or compatible jailbreaks.

Local ad-hoc signatures provide bundle integrity only, not Apple distribution
authorization. This never embeds a development profile or signs with a team key.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import plistlib
import shutil
import stat
import subprocess
import tempfile
import zipfile


def run(*args):
    return subprocess.check_output(args, text=True, stderr=subprocess.STDOUT).strip()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--notices", type=Path, required=True,
                        help="Reviewed third-party license notice directory")
    args = parser.parse_args()
    source = args.archive.resolve() / "Products/Applications/MoneroWallet.app"
    info = plistlib.loads((source / "Info.plist").read_bytes())
    if info.get("CFBundleIdentifier") != "com.tex8.monerowallet":
        raise SystemExit("Unexpected bundle identifier")
    if info.get("DTPlatformName") != "iphoneos":
        raise SystemExit("A real iPhone archive is required")
    if not (source / "main.jsbundle").is_file():
        raise SystemExit("Missing embedded release JavaScript")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    if args.output.exists():
        raise SystemExit("Output exists; choose a new reviewed output path")

    with tempfile.TemporaryDirectory(prefix="mfw-ipa-", dir=args.output.parent) as temporary:
        root = Path(temporary)
        app = root / "Payload/MoneroWallet.app"
        shutil.copytree(source, app, symlinks=True)
        if not args.notices.is_dir() or any(p.is_symlink() for p in args.notices.rglob("*")):
            raise SystemExit("A regular third-party notice directory is required")
        shutil.copytree(args.notices, app / "OpenSourceNotices")
        binaries = []
        for path in sorted(app.rglob("*")):
            if path.name == "embedded.mobileprovision":
                path.unlink()  # Never distribute registered device identifiers.
                continue
            if path.is_symlink():
                if not path.resolve().is_relative_to(app):
                    raise SystemExit("Bundle symlink escapes the app")
                continue
            if not path.is_file():
                continue
            description = run("/usr/bin/file", "-b", str(path))
            if not description.startswith("Mach-O"):
                continue
            if run("/usr/bin/lipo", "-archs", str(path)) != "arm64":
                raise SystemExit("Non-arm64 executable in device bundle")
            build = run("/usr/bin/xcrun", "vtool", "-show-build", str(path))
            platforms = [line.split()[-1] for line in build.splitlines()
                         if line.strip().startswith("platform ")]
            if platforms != ["IOS"]:
                raise SystemExit("Non-iPhone executable in bundle")
            binaries.append(str(path.relative_to(root)))

        # Sign nested bundles first. No inherited development or APNs entitlement
        # is carried into this public, profile-free re-signing input.
        for relative in binaries:
            if Path(relative).suffix == ".dylib":
                run("/usr/bin/codesign", "--force", "--sign", "-", "--timestamp=none", str(root / relative))
        bundles = [p for p in app.rglob("*") if p.is_dir()
                   and p.suffix in {".framework", ".appex", ".app"}]
        for bundle in sorted(bundles, key=lambda p: len(p.parts), reverse=True) + [app]:
            run("/usr/bin/codesign", "--force", "--sign", "-", "--timestamp=none", str(bundle))
            run("/usr/bin/codesign", "--verify", "--strict", str(bundle))
        # Check every Mach-O, including any loose dylib, rather than trusting a
        # successful outer bundle signature alone.
        for relative in binaries:
            run("/usr/bin/codesign", "--verify", "--strict", str(root / relative))

        with zipfile.ZipFile(args.output, "x", zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
            for path in sorted((root / "Payload").rglob("*")):
                relative = path.relative_to(root).as_posix()
                if path.is_symlink():
                    entry = zipfile.ZipInfo(relative)
                    entry.create_system = 3
                    entry.external_attr = (stat.S_IFLNK | 0o777) << 16
                    archive.writestr(entry, os.readlink(path))
                elif path.is_file():
                    archive.write(path, relative)
        with zipfile.ZipFile(args.output) as archive:
            if archive.testzip() is not None:
                raise SystemExit("IPA ZIP integrity verification failed")
            if any(".." in Path(name).parts or name.startswith("/")
                   or not name.startswith("Payload/MoneroWallet.app/")
                   or name.endswith("embedded.mobileprovision")
                   for name in archive.namelist()):
                raise SystemExit("Unexpected IPA member")

    hasher = hashlib.sha256()
    with args.output.open("rb") as payload:
        for block in iter(lambda: payload.read(1024 * 1024), b""):
            hasher.update(block)
    digest = hasher.hexdigest()
    manifest = {
        "filename": args.output.name, "sha256": digest,
        "size": args.output.stat().st_size,
        "bundleId": info["CFBundleIdentifier"],
        "version": info["CFBundleShortVersionString"],
        "build": info["CFBundleVersion"],
        "minimumOSVersion": info["MinimumOSVersion"],
        "architecture": "arm64", "platform": "iOS device",
        "signing": "local ad-hoc; requires compatible installation/re-signing",
        "appleProvisioningProfileIncluded": False,
        "physicalIPhoneTested": False, "pushOnIPhoneVerified": False,
        "machOBinaries": binaries,
    }
    args.output.with_suffix(".manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    main()
