#!/usr/bin/env python3
"""Activate an already built static site; never install or change services.

Run as root: activate-static-site.py STAGE SOURCE_COMMIT EXPECTED_CURRENT_TARGET
STAGE contains deployment-manifest.json and website-dist.tar.gz. The manifest
pins sourceCommit, archiveSha256, archiveBytes and every regular file's SHA-256.
The download catalog is published separately by mfw-download-publish.
"""

import datetime
import hashlib
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tarfile


def digest(path):
    value = hashlib.sha256()
    with pathlib.Path(path).open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            value.update(block)
    return value.hexdigest()


def sync_dir(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def atomic_bytes(path, data, suffix):
    temporary = path.with_name(path.name + suffix)
    try:
        with temporary.open("xb") as output:
            output.write(data)
            output.flush()
            os.fchmod(output.fileno(), 0o644)
            os.fsync(output.fileno())
        os.replace(temporary, path)
        sync_dir(path.parent)
    finally:
        if temporary.exists():
            temporary.unlink()


def switch(path, target, suffix):
    temporary = path.with_name(path.name + suffix)
    assert not temporary.exists() and not temporary.is_symlink()
    try:
        temporary.symlink_to(target)
        os.replace(temporary, path)
        sync_dir(path.parent)
    finally:
        if temporary.is_symlink():
            temporary.unlink()


def local_get(route):
    return subprocess.check_output([
        "curl", "-fsS", "--connect-timeout", "5", "--max-time", "20",
        "--resolve", "xmr.tex8.com:443:127.0.0.1", "https://xmr.tex8.com" + route,
    ], timeout=25)


def extract_verified(archive, destination, expected_files):
    files = set()
    total = 0
    with tarfile.open(archive, "r:gz") as bundle:
        members = bundle.getmembers()
        assert 0 < len(members) <= 5000, "Invalid archive member count"
        for member in members:
            name = pathlib.PurePosixPath(member.name)
            assert not name.is_absolute() and ".." not in name.parts
            assert member.isfile() or member.isdir(), "Non-regular archive member"
            if name == pathlib.PurePosixPath("."):
                assert member.isdir()
                continue
            target = destination.joinpath(*name.parts)
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True, mode=0o755)
                continue
            key = name.as_posix()
            assert key not in files and key in expected_files, "Duplicate or unexpected file"
            files.add(key)
            total += member.size
            assert member.size >= 0 and total <= 64 * 1024 * 1024
            target.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
            with bundle.extractfile(member) as source, target.open("xb") as output:
                shutil.copyfileobj(source, output)
                output.flush()
                os.fchmod(output.fileno(), 0o644)
                os.fsync(output.fileno())
            assert digest(target) == expected_files[key], "File checksum mismatch: " + key
    assert files == set(expected_files), "Archive does not match complete file manifest"
    for directory in sorted((p for p in destination.rglob("*") if p.is_dir()), reverse=True):
        directory.chmod(0o755)
        sync_dir(directory)
    sync_dir(destination)


def activate(stage, commit, expected_current, *, root=pathlib.Path("/var/www"), fetch=local_get):
    assert re.fullmatch(r"[0-9a-f]{40}", commit), "Invalid source commit"
    config = json.loads((stage / "deployment-manifest.json").read_text())
    assert config["sourceCommit"] == commit, "Source commit mismatch"
    expected_files = config["files"]
    assert isinstance(expected_files, dict) and expected_files
    for name, checksum in expected_files.items():
        relative = pathlib.PurePosixPath(name)
        assert not relative.is_absolute() and ".." not in relative.parts and name == relative.as_posix()
        assert re.fullmatch(r"[0-9a-f]{64}", checksum)
    assert {"index.html", "de/index.html", "monero-wallet-logo.svg"} <= expected_files.keys()
    archive = stage / "website-dist.tar.gz"
    assert archive.is_file() and not archive.is_symlink()
    assert archive.stat().st_size == config["archiveBytes"] <= 64 * 1024 * 1024
    assert re.fullmatch(r"[0-9a-f]{64}", config["archiveSha256"])
    assert digest(archive) == config["archiveSha256"], "Archive checksum mismatch"

    current = root / "monero-fast-wallet.current"
    release_root = root / "monero-fast-wallet-releases"
    mirror_root = root / "monero-fast-wallet-mirror"
    mirror = mirror_root / "current"
    catalog = root / "mfw-downloads/releases.json"
    assert current.is_symlink() and os.readlink(current) == expected_current, "Concurrent site deployment"
    old_target = pathlib.Path(expected_current)
    assert old_target.parent == release_root and old_target.is_dir() and not old_target.is_symlink()
    assert mirror.is_file() and not mirror.is_symlink()
    old_mirror = mirror.read_bytes()  # Rollback state exists only in RAM.
    catalog_hash = digest(catalog)
    assert shutil.disk_usage(root).free > 512 * 1024 * 1024

    version = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    release = release_root / (version + "-" + commit[:8])
    suffix = "." + commit[:8] + "." + str(os.getpid()) + ".next"
    assert not release.exists()
    release.mkdir(mode=0o755)
    changed = False
    mirror_changed = False
    rolled_back = False
    try:
        extract_verified(archive, release, expected_files)
        sync_dir(release_root)
        assert os.readlink(current) == expected_current
        assert mirror.read_bytes() == old_mirror and digest(catalog) == catalog_hash
        # Set before the rename so a directory-fsync failure also rolls back.
        changed = True
        switch(current, release, suffix)
        for name, checksum in expected_files.items():
            if not name.endswith(".map"):
                route = "/" + name
                if name == "index.html":
                    route = "/"
                elif name.endswith("/index.html"):
                    route = "/" + name[:-len("index.html")]
                assert hashlib.sha256(fetch(route)).hexdigest() == checksum, "HTTP file mismatch: " + name
        fetch("/healthz")
        fetch("/v1/mfw-site/healthz")
        assert digest(catalog) == catalog_hash, "Concurrent catalog update"
        mirror_archive = mirror_root / "releases" / (config["archiveSha256"] + ".tar.gz")
        if mirror_archive.exists():
            assert mirror_archive.is_file() and not mirror_archive.is_symlink()
            assert digest(mirror_archive) == config["archiveSha256"]
        else:
            atomic_bytes(mirror_archive, archive.read_bytes(), suffix)
        assert mirror.read_bytes() == old_mirror, "Concurrent mirror publication"
        new_mirror = ("version=" + version + "\nsha256=" + config["archiveSha256"] + "\n").encode()
        mirror_changed = True
        atomic_bytes(mirror, new_mirror, suffix)
        return {
            "status": "activated-and-locally-verified", "sourceCommit": commit,
            "release": str(release), "previousTarget": expected_current,
            "mirrorVersion": version, "mirrorSha256": config["archiveSha256"],
            "catalogUnchanged": True, "backupCreated": False,
            "serviceOrConfigurationChanges": False,
        }
    except BaseException:
        if changed:
            assert os.readlink(current) == str(release), "Concurrent site change; rollback requires review"
            switch(current, old_target, suffix + ".rollback")
            if mirror_changed:
                assert mirror.read_bytes() in (old_mirror, new_mirror), "Concurrent mirror change; rollback requires review"
                atomic_bytes(mirror, old_mirror, suffix + ".rollback")
            rolled_back = True
        raise
    finally:
        if not changed or rolled_back:
            shutil.rmtree(release)
            sync_dir(release_root)


def main():
    assert os.geteuid() == 0, "Run with ordinary root/sudo authorization"
    assert len(sys.argv) == 4, __doc__
    stage = pathlib.Path(sys.argv[1])
    assert stage.is_absolute() and stage.is_dir() and not stage.is_symlink()
    print(json.dumps(activate(stage, sys.argv[2], sys.argv[3]), indent=2))


if __name__ == "__main__":
    main()
