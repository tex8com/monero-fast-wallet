#!/usr/bin/env python3
"""Verify reviewed vendor sources, product dependency locks and audit findings.

Python 3.9+, standard library only. This is a narrow release gate, not a general
TOML parser or a claim that all possible application security risks are absent.
"""

import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import sys


class VerificationError(Exception):
    """A source, dependency or audit result differs from the reviewed inputs."""


MANIFEST_PINS = {
    "third_party/glib-backport/upstream.json":
        "7a004b5392875ca3f0f9f90ae11fdf7baa3056941981eead92e33bb899ea034e",
    "third_party/crypto-bigint-migration/VENDOR-SOURCES.json":
        "c5e33916d9908a50bb5e0ce6d1872767f5e2cf9afd398e64308ab83cf94896cc",
    # Reviewed after the final client-only, Windows/MSVC-vendored OpenSSL change.
    "third_party/tor-rsa-client/patched-files.sha256.json":
        "6e68dc466e44359ba890bc70100fcb8e2f1e9b38146297cc87f77a49df52ed46",
}
CRYPTO_CRATES = {
    "dalek-ff-group-0.4.6", "dalek-ff-group-0.5.0", "minimal-ed448-0.4.2",
    "monero-generators-0.4.0", "elliptic-curve-0.13.8", "k256-0.13.4",
    "p256-0.13.2", "primeorder-0.13.6",
}
TOR_CRATES = {
    "tor-llcrypto-0.47.0", "tor-key-forge-0.47.0", "tor-cert-0.47.0",
    "tor-netdoc-0.47.0", "ssh-key-fork-arti-0.6.7",
}
CRYPTO_PATCHES = {
    ("dalek-ff-group", "0.4.6"), ("dalek-ff-group", "0.5.0"),
    ("minimal-ed448", "0.4.2"), ("elliptic-curve", "0.13.8"),
    ("monero-generators", "0.4.0"),
}
DESKTOP_PATCHES = CRYPTO_PATCHES | {
    ("glib", "0.18.5"), ("tor-llcrypto", "0.47.0"),
    ("tor-key-forge", "0.47.0"), ("tor-cert", "0.47.0"),
    ("tor-netdoc", "0.47.0"), ("ssh-key-fork-arti", "0.6.7"),
}
PRODUCT_ROOTS = {
    "wallets/desktop/src-tauri": DESKTOP_PATCHES,
    "native/fast-wallet-protocol": CRYPTO_PATCHES,
    "native/mfw-recipient-protocol": {("elliptic-curve", "0.13.8")},
}
REGISTRY = "registry+https://github.com/rust-lang/crates.io-index"
CRYPTO_BIGINT_SHA256 = "9c035cb64cba03dad2fb921f3e218785e8cf9a41790da5eb3a1400f62fa2be11"
ZIP_SHA256 = "df3845f734baabdd02de353a20580e30ceccd03897def44a4eb8e9654992e294"
EXPECTED_MAINTENANCE_WARNINGS = {
    ("RUSTSEC-2026-0319", "anymap2", "0.13.0"),
    ("RUSTSEC-2025-0141", "bincode", "2.0.1"),
    ("RUSTSEC-2024-0388", "derivative", "2.2.0"),
    ("RUSTSEC-2024-0436", "paste", "1.0.15"),
    ("RUSTSEC-2024-0370", "proc-macro-error", "1.0.4"),
    ("RUSTSEC-2026-0371", "zbus_names", "3.0.0"),
    ("RUSTSEC-2026-0371", "zbus_names", "4.3.4"),
    ("RUSTSEC-2026-0370", "zvariant", "4.2.0"),
    ("RUSTSEC-2026-0370", "zvariant", "5.15.0"),
    ("RUSTSEC-2026-0372", "zvariant_derive", "4.2.0"),
    ("RUSTSEC-2026-0372", "zvariant_derive", "5.15.0"),
}


def require(condition, message):
    if not condition:
        raise VerificationError(message)


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, "duplicate JSON key: " + key)
        result[key] = value
    return result


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8"), object_pairs_hook=unique_object)


def safe_relative(value):
    require(isinstance(value, str) and value, "invalid source path")
    path = PurePosixPath(value)
    require(not path.is_absolute() and ".." not in path.parts and "." not in path.parts
            and str(path) == value and "\\" not in value, "unsafe source path: " + value)
    return value


def file_set(root):
    require(root.is_dir() and not root.is_symlink(), "missing or symlinked vendor directory: " + str(root))
    files = set()
    for path in root.rglob("*"):
        require(not path.is_symlink(), "symlink in pinned sources: " + str(path))
        if path.is_file():
            files.add(path.relative_to(root).as_posix())
        else:
            require(path.is_dir(), "non-regular file in pinned sources: " + str(path))
    return files


def check_files(root, expected):
    require(isinstance(expected, dict) and expected, "empty source manifest: " + str(root))
    for name, sha in expected.items():
        safe_relative(name)
        require(isinstance(sha, str) and re.fullmatch(r"[0-9a-f]{64}", sha),
                "invalid SHA256 for " + name)
    actual = file_set(root)
    require(actual == set(expected), "source file set changed in {}: added={}, missing={}".format(
        root, sorted(actual - set(expected)), sorted(set(expected) - actual)))
    for name, sha in expected.items():
        require(digest(root / name) == sha, "source SHA256 mismatch: " + str(root / name))
    return len(expected)


def verify_vendor_sources(repo):
    manifests = {}
    for name, sha in MANIFEST_PINS.items():
        path = repo / name
        require(path.is_file() and not path.is_symlink(), "missing source manifest: " + name)
        require(digest(path) == sha, "reviewed source manifest changed: " + name)
        manifests[name] = read_json(path)

    glib = manifests["third_party/glib-backport/upstream.json"]
    require(glib["crate"] == "glib" and glib["version"] == "0.18.5"
            and glib["vendorPath"] == "third_party/glib-0.18.5", "unexpected GLib source identity")
    backport = glib["securityBackport"]
    require(backport["advisory"] == "RUSTSEC-2024-0429"
            and backport["changedFiles"] == ["src/variant_iter.rs"], "unexpected GLib backport scope")
    patch = repo / "third_party/glib-backport" / safe_relative(backport["patchFile"])
    require(patch.is_file() and not patch.is_symlink() and digest(patch) == backport["patchSha256"],
            "GLib upstream patch changed")
    expected = {name: details["sha256"] for name, details in glib["originalFiles"].items()}
    expected["src/variant_iter.rs"] = glib["patchedSourceSha256"]
    checked = check_files(repo / glib["vendorPath"], expected)

    crypto = manifests["third_party/crypto-bigint-migration/VENDOR-SOURCES.json"]
    crates = crypto["crates"]
    require(isinstance(crates, list) and len(crates) == len(CRYPTO_CRATES)
            and {item["crate"] for item in crates} == CRYPTO_CRATES, "crypto vendor crate set changed")
    for item in crates:
        checked += check_files(repo / "third_party" / item["crate"], item["files_sha256"])

    tor = manifests["third_party/tor-rsa-client/patched-files.sha256.json"]
    require(isinstance(tor, dict) and {safe_relative(name).split("/")[0] for name in tor} == TOR_CRATES,
            "Tor vendor crate set changed")
    for crate in sorted(TOR_CRATES):
        prefix = crate + "/"
        expected = {name[len(prefix):]: sha for name, sha in tor.items() if name.startswith(prefix)}
        checked += check_files(repo / "third_party" / crate, expected)
    return checked


def lock_packages(path):
    text = path.read_text(encoding="utf-8")
    require(re.search(r"(?m)^version = [34]$", text), "unsupported product lockfile: " + str(path))
    packages = []
    for block in re.split(r"(?m)^\[\[package\]\]\s*$", text)[1:]:
        # Only Cargo's generated scalar identity fields are needed here. Reject
        # missing/duplicate fields rather than attempting permissive TOML recovery.
        package = {}
        for field in ["name", "version", "source", "checksum"]:
            values = re.findall(r'^' + field + r' = "([^"\\\n]+)"$', block, re.MULTILINE)
            require(len(values) <= 1, "duplicate lock identity field: " + str(path))
            if values:
                package[field] = values[0]
        require("name" in package and "version" in package, "malformed product package: " + str(path))
        packages.append(package)
    require(packages, "empty product lockfile: " + str(path))
    return packages


def manifest_patch_paths(path):
    section = ""
    patches = []
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.split("#", 1)[0].strip()
        if line.startswith("["):
            section = line
        if not section.startswith("[patch.") or not line or line.startswith("["):
            continue
        match = re.fullmatch(r'([\w-]+)\s*=\s*\{(.*)\}', line)
        require(match is not None, "unsupported patch entry in " + str(path))
        name, fields = match.groups()
        package = re.search(r'\bpackage\s*=\s*"([^"\\]+)"', fields)
        local = re.search(r'\bpath\s*=\s*"([^"\\]+)"', fields)
        if local:
            patches.append((section, package.group(1) if package else name,
                            (path.parent / local.group(1)).resolve()))
    return patches


def verify_product_locks(repo):
    snapshot = {}
    desktop_count = None
    for relative, source_packages in PRODUCT_ROOTS.items():
        root = repo / relative
        lock = root / "Cargo.lock"
        manifest = root / "Cargo.toml"
        require(lock.is_file() and manifest.is_file() and not lock.is_symlink() and not manifest.is_symlink(),
                "missing or symlinked product dependency input: " + relative)
        packages = lock_packages(lock)
        require(not any(p["name"] == "rsa" for p in packages), "RustCrypto RSA returned in " + relative)
        crypto = [p for p in packages if p["name"] == "crypto-bigint"]
        require(len(crypto) == 1 and crypto[0]["version"] == "0.7.10"
                and crypto[0].get("source") == REGISTRY
                and crypto[0].get("checksum") == CRYPTO_BIGINT_SHA256,
                "product requires the unchanged registry crypto-bigint 0.7.10: " + relative)
        patches = manifest_patch_paths(manifest)
        for name, version in source_packages:
            found = [p for p in packages if p["name"] == name and p["version"] == version]
            require(len(found) == 1 and "source" not in found[0] and "checksum" not in found[0],
                    "reviewed source package is not selected: {} {} in {}".format(name, version, relative))
            expected = (repo / "third_party" / (name + "-" + version)).resolve()
            namespace = '[patch."https://github.com/monero-oxide/monero-oxide.git"]' if name == "monero-generators" else "[patch.crates-io]"
            require((namespace, name, expected) in patches,
                    "reviewed source patch is not wired: {} {} in {}".format(name, version, relative))
        if relative == "wallets/desktop/src-tauri":
            desktop_count = len(packages)
            zip_packages = [p for p in packages if p["name"] == "zip"]
            require(len(zip_packages) == 1 and zip_packages[0]["version"] == "9.4.2"
                    and zip_packages[0].get("source") == REGISTRY
                    and zip_packages[0].get("checksum") == ZIP_SHA256,
                    "desktop requires the reviewed registry zip 9.4.2")
        for path in [lock, manifest]:
            snapshot[path.relative_to(repo).as_posix()] = digest(path)
    return {"files_sha256": snapshot}, desktop_count


def verify_audit(path, package_count):
    audit = read_json(path)
    settings = audit["settings"]
    require(settings.get("ignore") == [], "audit contains ignored advisories")
    require(settings.get("target_arch") == [] and settings.get("target_os") == []
            and settings.get("severity") is None, "audit filters do not cover the complete desktop lock")
    informational = settings.get("informational_warnings")
    require(isinstance(informational, list) and {"unmaintained", "unsound", "notice"}.issubset(informational),
            "audit informational checks are incomplete")
    database = audit["database"]
    require(type(database.get("advisory-count")) is int and database["advisory-count"] > 0,
            "audit advisory database is empty or unknown")
    require(audit["lockfile"].get("dependency-count") == package_count,
            "audit dependency count differs from the checked desktop lock")
    vulnerabilities = audit["vulnerabilities"]
    require(vulnerabilities.get("found") is False and type(vulnerabilities.get("count")) is int
            and vulnerabilities["count"] == 0 and vulnerabilities.get("list") == [],
            "desktop Rust vulnerability found or inconsistent audit result")
    warnings = audit["warnings"]
    require(isinstance(warnings, dict), "invalid audit warning result")
    actual = []
    for kind, findings in warnings.items():
        require(isinstance(findings, list), "invalid audit warning category")
        for finding in findings:
            require(kind == "unmaintained" and finding["advisory"].get("informational") == "unmaintained",
                    "non-maintenance audit warning: " + kind)
            actual.append((finding["advisory"]["id"], finding["package"]["name"], finding["package"]["version"]))
    require(len(actual) == len(EXPECTED_MAINTENANCE_WARNINGS)
            and set(actual) == EXPECTED_MAINTENANCE_WARNINGS,
            "desktop maintenance warning set changed; reassessment required")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", type=Path, default=Path(__file__).resolve().parent.parent)
    parser.add_argument("--write-snapshot", type=Path)
    parser.add_argument("--snapshot", type=Path)
    parser.add_argument("--audit-json", type=Path)
    args = parser.parse_args()
    try:
        require(not (args.write_snapshot and args.snapshot), "choose one snapshot operation")
        repo = args.repo_root.resolve()
        checked = verify_vendor_sources(repo)
        snapshot, package_count = verify_product_locks(repo)
        if args.snapshot:
            require(read_json(args.snapshot) == snapshot, "product dependency inputs changed during audit")
        if args.audit_json:
            verify_audit(args.audit_json, package_count)
        if args.write_snapshot:
            args.write_snapshot.write_text(json.dumps(snapshot, indent=2) + "\n", encoding="utf-8")
    except (VerificationError, OSError, ValueError, KeyError, TypeError) as error:
        print("Desktop security gate failed: " + str(error), file=sys.stderr)
        return 1
    if args.audit_json:
        print("Desktop dependency gate passed: 0 vulnerabilities; 11 known unmaintained-package warnings remain.")
    else:
        print("Reviewed security sources and three product locks verified ({} pinned files).".format(checked))
    return 0


if __name__ == "__main__":
    sys.exit(main())
