#!/usr/bin/env python3
"""Install one validated Nginx snippet include without duplicating it."""

from __future__ import annotations

import argparse
import os
from pathlib import Path
import shutil
import stat
import tempfile


def is_https_listener(line: str) -> bool:
    directive = line.split("#", 1)[0].strip()
    if not directive.endswith(";"):
        return False
    parts = directive[:-1].split()
    if len(parts) < 3 or parts[0] != "listen" or "ssl" not in parts[2:]:
        return False
    address = parts[1]
    return address == "443" or address.endswith(":443")


def atomic_copy(source: Path, destination: Path, mode: int) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{destination.name}.", dir=destination.parent
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as output, source.open("rb") as input_file:
            shutil.copyfileobj(input_file, output)
            output.flush()
            os.fsync(output.fileno())
        os.chmod(temporary, mode)
        os.replace(temporary, destination)
    finally:
        temporary.unlink(missing_ok=True)


def install(
    site: Path,
    snippet_source: Path,
    snippet_destination: Path,
    include_path: str,
) -> None:
    site_metadata = site.stat()
    if not stat.S_ISREG(site_metadata.st_mode) or site.is_symlink():
        raise RuntimeError("Nginx site must be a regular non-symlink file")
    source_metadata = snippet_source.stat()
    if not stat.S_ISREG(source_metadata.st_mode) or snippet_source.is_symlink():
        raise RuntimeError("Nginx snippet source must be a regular non-symlink file")

    original_lines = site.read_text(encoding="utf-8").splitlines(keepends=True)
    include_directive = f"include {include_path};"
    lines = [line for line in original_lines if line.strip() != include_directive]
    listeners = [index for index, line in enumerate(lines) if is_https_listener(line)]
    if len(listeners) != 1:
        raise RuntimeError(
            f"expected exactly one HTTPS listener, found {len(listeners)}"
        )

    listener_line = lines[listeners[0]]
    indentation = listener_line[: len(listener_line) - len(listener_line.lstrip())]
    newline = "\r\n" if listener_line.endswith("\r\n") else "\n"
    lines.insert(listeners[0] + 1, f"{indentation}{include_directive}{newline}")
    if sum(line.strip() == include_directive for line in lines) != 1:
        raise RuntimeError("Nginx include insertion was not unique")

    atomic_copy(snippet_source, snippet_destination, 0o644)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{site.name}.", dir=site.parent)
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="") as output:
            output.writelines(lines)
            output.flush()
            os.fsync(output.fileno())
        os.chmod(temporary, stat.S_IMODE(site_metadata.st_mode))
        os.chown(temporary, site_metadata.st_uid, site_metadata.st_gid)
        os.replace(temporary, site)
    finally:
        temporary.unlink(missing_ok=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--site", required=True, type=Path)
    parser.add_argument("--snippet-source", required=True, type=Path)
    parser.add_argument("--snippet-destination", required=True, type=Path)
    parser.add_argument("--include-path", required=True)
    arguments = parser.parse_args()
    install(
        arguments.site,
        arguments.snippet_source,
        arguments.snippet_destination,
        arguments.include_path,
    )


if __name__ == "__main__":
    main()
