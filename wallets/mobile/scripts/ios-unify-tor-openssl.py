#!/usr/bin/env python3
"""Remove Tor's bundled OpenSSL objects; the native core supplies one provider.

Restricted to the reviewed Tor 409.11.1 iPhone ARM64 static archive. Simulator
and other Tor releases require their own input review and checksum.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess

ORIGINAL_SHA256 = "e12445e4075ae176224dbf881f42cb7879441ba54ef2f9c187b876858c8f2fa9"
OPENSSL_MEMBERS = 1122
OPENSSL_PREFIXES = ("libssl-lib-", "libcrypto-lib-", "libdefault-lib-", "libcommon-lib-")
PATCHED_CONTENT_SHA256 = "738d4ee5679dd86e3be2d5ebb1af243a541454d8e91dbc82cbd563a5afe35369"


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def archive_content_digest(path):
    # Ignore only ar header date/uid/gid/mode, not any object or symbol-table
    # bytes. ranlib timestamps must not turn a mutable sidecar into a trust root.
    data = path.read_bytes()
    if data[:8] != b"!<arch>\n":
        raise SystemExit("Expected a regular static archive")
    value = hashlib.sha256(data[:8])
    position = 8
    while position < len(data):
        header = data[position:position + 60]
        if len(header) != 60 or header[58:60] != b"`\n":
            raise SystemExit("Invalid static archive header")
        size = int(header[48:58])
        value.update(header[:16] + b" " * 32 + header[48:])
        position += 60
        end = position + size + size % 2
        if size < 0 or end > len(data):
            raise SystemExit("Invalid static archive member size")
        value.update(data[position:end])
        position = end
    return value.hexdigest()


def run(*args):
    return subprocess.check_output(args, text=True, stderr=subprocess.STDOUT)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path)
    args = parser.parse_args()
    archive = args.archive.resolve()
    marker = archive.with_name("tor.tex8-openssl.json")
    original = digest(archive)
    if original != ORIGINAL_SHA256:
        if archive_content_digest(archive) != PATCHED_CONTENT_SHA256:
            raise SystemExit("Unreviewed Tor archive: refusing to modify it")
    else:
        members = run("xcrun", "ar", "-t", str(archive)).splitlines()
        removed = [m for m in members if m.startswith(OPENSSL_PREFIXES)]
        if len(removed) != OPENSSL_MEMBERS or len(set(removed)) != OPENSSL_MEMBERS:
            raise SystemExit("Tor OpenSSL member set differs from the reviewed input")
        run("xcrun", "ar", "-d", str(archive), *removed)
        run("xcrun", "ranlib", str(archive))
        if archive_content_digest(archive) != PATCHED_CONTENT_SHA256:
            raise SystemExit("Tor object bytes changed outside the reviewed transformation")
        marker.write_text(json.dumps({
            "torPodVersion": "409.11.1", "platform": "ios-arm64",
            "originalSha256": ORIGINAL_SHA256, "patchedSha256": digest(archive),
            "patchedContentSha256": PATCHED_CONTENT_SHA256,
            "removedOpenSSLObjects": removed,
            "replacement": "native core OpenSSL 3.5.9 LTS, linked once",
        }, indent=2) + "\n")
    if any(m.startswith(OPENSSL_PREFIXES)
           for m in run("xcrun", "ar", "-t", str(archive)).splitlines()):
        raise SystemExit("Bundled OpenSSL objects remain in Tor")
    symbols = run("xcrun", "nm", "-gU", str(archive))
    if re.search(r"\b_(?:OPENSSL|OpenSSL|SSL|EVP|BN|CRYPTO|OSSL|X509|ossl)_\w+$", symbols, re.M):
        raise SystemExit("An OpenSSL definition remains in Tor")
    print("Tor ARM64 archive uses the single native-core OpenSSL provider")


if __name__ == "__main__":
    main()
