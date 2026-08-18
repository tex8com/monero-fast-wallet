#!/usr/bin/env python3
"""Privacy-minimised project-page metrics and release download gateway."""

from __future__ import annotations

import argparse
import base64
import hashlib
import ipaddress
import json
import math
import os
import re
import shutil
import sqlite3
import subprocess
import tempfile
import threading
import time
from collections import defaultdict, deque
from datetime import datetime, timedelta, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Optional
from urllib.parse import urlsplit


SCHEMA_VERSION = 1
HLL_PRECISION = 10
HLL_REGISTERS = 1 << HLL_PRECISION
HLL_BITS = 128 - HLL_PRECISION
RETENTION_DAYS = 730
PRODUCTS = {"mfw", "mfn"}
PLATFORMS = {"android", "ios", "macos", "windows", "linux"}
PACKAGES = {"apk", "appstore", "dmg", "exe", "msix", "rpm", "deb", "appimage", "tar.gz", "zip"}
SAFE_VERSION = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$")
SAFE_FILENAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._+-]{0,159}$")
SAFE_SHA256 = re.compile(r"^[0-9a-f]{64}$")
DOWNLOAD_PATH = re.compile(r"^/download/(mfw|mfn)/(android|ios|macos|windows|linux)/([a-z0-9.]+)$")
BOT_MARKERS = ("bot", "crawler", "spider", "slurp", "headless", "preview", "curl/", "wget/")


def utc_day() -> str:
    return datetime.now(timezone.utc).date().isoformat()


def sha256_file(path: Path) -> tuple[str, int]:
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as handle:
        while True:
            chunk = handle.read(1024 * 1024)
            if not chunk:
                break
            size += len(chunk)
            if size > 2_147_483_648:
                raise ValueError("artifact exceeds 2 GiB")
            digest.update(chunk)
    return digest.hexdigest(), size


def coarse_user_agent(value: str) -> str:
    text = (value or "").lower()
    browser = "other"
    for marker, name in (("firefox", "firefox"), ("edg/", "edge"), ("chrome", "chrome"), ("safari", "safari")):
        if marker in text:
            browser = name
            break
    system = "other"
    for marker, name in (("android", "android"), ("iphone", "ios"), ("ipad", "ios"), ("windows", "windows"), ("mac os", "macos"), ("linux", "linux")):
        if marker in text:
            system = name
            break
    return f"{browser}:{system}"


def is_bot(value: str) -> bool:
    text = (value or "").lower()
    return not text or any(marker in text for marker in BOT_MARKERS)


def client_ip(headers, peer_host: str) -> str:
    candidate = (headers.get("X-Real-IP") or peer_host or "").strip()
    try:
        return str(ipaddress.ip_address(candidate))
    except ValueError:
        return "0.0.0.0"


def hll_position(identity: str) -> tuple[int, int]:
    digest = hashlib.blake2b(identity.encode("utf-8"), digest_size=16, person=b"mfw-site-stat-v1").digest()
    value = int.from_bytes(digest, "big")
    index = value >> HLL_BITS
    remainder = value & ((1 << HLL_BITS) - 1)
    rank = HLL_BITS + 1 if remainder == 0 else HLL_BITS - remainder.bit_length() + 1
    return index, rank


def hll_estimate(registers: bytes) -> int:
    if len(registers) != HLL_REGISTERS:
        raise ValueError("invalid HLL register length")
    count = float(HLL_REGISTERS)
    alpha = 0.7213 / (1.0 + 1.079 / count)
    estimate = alpha * count * count / sum(2.0 ** (-register) for register in registers)
    zeroes = registers.count(0)
    if estimate <= 2.5 * count and zeroes:
        estimate = count * math.log(count / zeroes)
    return max(0, round(estimate))


def merge_hll(left: bytes, right: bytes) -> bytes:
    if len(left) != HLL_REGISTERS or len(right) != HLL_REGISTERS:
        raise ValueError("invalid HLL register length")
    return bytes(max(a, b) for a, b in zip(left, right))


def connect_database(path: Path) -> sqlite3.Connection:
    connection = sqlite3.connect(path, timeout=5.0)
    connection.execute("PRAGMA busy_timeout = 5000")
    connection.execute("PRAGMA journal_mode = WAL")
    connection.execute("PRAGMA synchronous = FULL")
    return connection


def initialize_database(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    connection = connect_database(path)
    try:
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS aggregate_counters (
                day TEXT NOT NULL,
                event TEXT NOT NULL,
                product TEXT NOT NULL,
                platform TEXT NOT NULL,
                version TEXT NOT NULL,
                package_kind TEXT NOT NULL,
                country TEXT NOT NULL,
                count INTEGER NOT NULL CHECK (count >= 0),
                PRIMARY KEY (day, event, product, platform, version, package_kind, country)
            ) WITHOUT ROWID
            """
        )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS unique_hll (
                day TEXT NOT NULL,
                event TEXT NOT NULL,
                product TEXT NOT NULL,
                platform TEXT NOT NULL,
                version TEXT NOT NULL,
                package_kind TEXT NOT NULL,
                registers BLOB NOT NULL CHECK (length(registers) = 1024),
                PRIMARY KEY (day, event, product, platform, version, package_kind)
            ) WITHOUT ROWID
            """
        )
        cutoff = (datetime.now(timezone.utc).date() - timedelta(days=RETENTION_DAYS)).isoformat()
        connection.execute("DELETE FROM aggregate_counters WHERE day < ?", (cutoff,))
        connection.execute("DELETE FROM unique_hll WHERE day < ?", (cutoff,))
        connection.execute("PRAGMA optimize")
        connection.commit()
    finally:
        connection.close()
    os.chmod(path, 0o600)


def record_event(
    database: Path,
    *,
    event: str,
    product: str,
    platform: str,
    version: str,
    package_kind: str,
    country: str,
    identity: str,
    unique_platform: str = "",
) -> None:
    day = utc_day()
    hll_platform = unique_platform or platform
    index, rank = hll_position(f"{day}\0{event}\0{product}\0{hll_platform}\0{version}\0{package_kind}\0{identity}")
    connection = connect_database(database)
    try:
        connection.execute("BEGIN IMMEDIATE")
        connection.execute(
            """
            INSERT INTO aggregate_counters
              (day, event, product, platform, version, package_kind, country, count)
            VALUES (?, ?, ?, ?, ?, ?, ?, 1)
            ON CONFLICT (day, event, product, platform, version, package_kind, country)
            DO UPDATE SET count = count + 1
            """,
            (day, event, product, platform, version, package_kind, country),
        )
        row = connection.execute(
            """
            SELECT registers FROM unique_hll
            WHERE day = ? AND event = ? AND product = ? AND platform = ? AND version = ? AND package_kind = ?
            """,
            (day, event, product, hll_platform, version, package_kind),
        ).fetchone()
        registers = bytearray(row[0] if row else bytes(HLL_REGISTERS))
        if rank > registers[index]:
            registers[index] = rank
        connection.execute(
            """
            INSERT INTO unique_hll
              (day, event, product, platform, version, package_kind, registers)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (day, event, product, platform, version, package_kind)
            DO UPDATE SET registers = excluded.registers
            """,
            (day, event, product, hll_platform, version, package_kind, bytes(registers)),
        )
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def validate_https_url(value: str) -> str:
    if not value:
        return ""
    parsed = urlsplit(value)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.fragment:
        raise ValueError("fallback URL must be a plain HTTPS URL")
    return value


def validate_artifact(raw: dict) -> dict:
    artifact = {
        "product": str(raw.get("product", "")).lower(),
        "platform": str(raw.get("platform", "")).lower(),
        "package": str(raw.get("package", "")).lower(),
        "version": str(raw.get("version", "")),
        "filename": str(raw.get("filename", "")),
        "sha256": str(raw.get("sha256", "")).lower(),
        "size": int(raw.get("size", -1)),
        "github_url": validate_https_url(str(raw.get("github_url", ""))),
        "enabled": raw.get("enabled") is True,
    }
    if artifact["product"] not in PRODUCTS:
        raise ValueError("invalid product")
    if artifact["platform"] not in PLATFORMS:
        raise ValueError("invalid platform")
    if artifact["package"] not in PACKAGES:
        raise ValueError("invalid package")
    if not SAFE_VERSION.fullmatch(artifact["version"]):
        raise ValueError("invalid version")
    if not SAFE_FILENAME.fullmatch(artifact["filename"]):
        raise ValueError("invalid filename")
    if not SAFE_SHA256.fullmatch(artifact["sha256"]):
        raise ValueError("invalid SHA-256")
    if artifact["size"] < 0 or artifact["size"] > 2_147_483_648:
        raise ValueError("invalid artifact size")
    return artifact


def load_manifest(path: Path) -> list[dict]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if payload.get("schema") != SCHEMA_VERSION or not isinstance(payload.get("artifacts"), list):
        raise ValueError("invalid release manifest")
    artifacts = [validate_artifact(item) for item in payload["artifacts"]]
    keys = [(item["product"], item["platform"], item["package"]) for item in artifacts]
    if len(keys) != len(set(keys)):
        raise ValueError("duplicate release artifact")
    return artifacts


def atomic_manifest_write(path: Path, artifacts: list[dict]) -> None:
    payload = {"schema": SCHEMA_VERSION, "artifacts": artifacts}
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=".releases.", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary_name, 0o644)
        os.replace(temporary_name, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temporary_name):
            os.unlink(temporary_name)


class ReleaseCatalog:
    def __init__(self, manifest: Path, artifact_root: Path):
        self.manifest = manifest
        self.artifact_root = artifact_root
        self._mtime = None
        self._artifacts: list[dict] = []
        self._lock = threading.Lock()

    def artifacts(self) -> list[dict]:
        mtime = self.manifest.stat().st_mtime_ns
        with self._lock:
            if self._mtime != mtime:
                self._artifacts = load_manifest(self.manifest)
                self._mtime = mtime
            return [dict(item) for item in self._artifacts]

    def public_artifacts(self) -> list[dict]:
        return [
            {
                "product": item["product"],
                "platform": item["platform"],
                "package": item["package"],
                "version": item["version"],
                "size": item["size"],
                "sha256": item["sha256"],
                "download_path": f"/download/{item['product']}/{item['platform']}/{item['package']}",
            }
            for item in self.artifacts()
            if item["enabled"]
        ]

    def find(self, product: str, platform: str, package_kind: str) -> Optional[dict]:
        for item in self.artifacts():
            if item["enabled"] and (item["product"], item["platform"], item["package"]) == (product, platform, package_kind):
                return item
        return None

    def target(self, item: dict) -> str:
        local_file = self.artifact_root / item["sha256"] / item["filename"]
        try:
            resolved = local_file.resolve(strict=False)
            resolved.relative_to(self.artifact_root.resolve(strict=False))
        except ValueError:
            return ""
        if resolved.is_file() and resolved.stat().st_size == item["size"]:
            return f"/release-assets/{item['sha256']}/{item['filename']}"
        return item["github_url"]


class MemoryRateLimiter:
    def __init__(self, limit: int, window_seconds: int = 60):
        self.limit = limit
        self.window_seconds = window_seconds
        self.entries: dict[str, deque] = defaultdict(deque)
        self.lock = threading.Lock()

    def allow(self, identity: str) -> bool:
        now = time.monotonic()
        cutoff = now - self.window_seconds
        key = hashlib.blake2s(identity.encode("utf-8"), digest_size=12, person=b"mfwrate1").hexdigest()
        with self.lock:
            bucket = self.entries[key]
            while bucket and bucket[0] < cutoff:
                bucket.popleft()
            if len(bucket) >= self.limit:
                return False
            bucket.append(now)
            if len(self.entries) > 4096:
                for old_key in list(self.entries)[:512]:
                    old_bucket = self.entries[old_key]
                    while old_bucket and old_bucket[0] < cutoff:
                        old_bucket.popleft()
                    if not old_bucket:
                        self.entries.pop(old_key, None)
            return True


def country_code(ip: str, database: Optional[Path]) -> str:
    if not database or not database.is_file() or not shutil.which("mmdblookup"):
        return "ZZ"
    try:
        parsed = ipaddress.ip_address(ip)
        if not parsed.is_global:
            return "ZZ"
        result = subprocess.run(
            ["mmdblookup", "--file", str(database), "--ip", ip, "country", "iso_code"],
            check=False,
            capture_output=True,
            text=True,
            timeout=0.35,
        )
        match = re.search(r'"([A-Z]{2})"', result.stdout)
        return match.group(1) if match else "ZZ"
    except (OSError, subprocess.SubprocessError, ValueError):
        return "ZZ"


def page_category(path: str) -> str:
    clean = urlsplit(path).path.lower()
    if clean.endswith("/developers/") or clean == "/developers":
        return "developers"
    if clean.endswith("/privacy/") or clean.endswith("/datenschutz/"):
        return "privacy"
    return "home"


class GatewayApplication:
    def __init__(self, *, database: Path, manifest: Path, artifact_root: Path, geoip_database: Optional[Path] = None):
        self.database = database
        self.catalog = ReleaseCatalog(manifest, artifact_root)
        self.geoip_database = geoip_database
        self.page_limiter = MemoryRateLimiter(30)
        self.download_limiter = MemoryRateLimiter(12)
        initialize_database(database)

    def identity(self, ip: str, user_agent: str) -> str:
        return f"{ip}\0{coarse_user_agent(user_agent)}"

    def record_page_view(self, path: str, ip: str, user_agent: str) -> None:
        if is_bot(user_agent) or not self.page_limiter.allow(ip):
            return
        record_event(
            self.database,
            event="page_view",
            product="site",
            platform=page_category(path),
            version="",
            package_kind="",
            country=country_code(ip, self.geoip_database),
            identity=self.identity(ip, user_agent),
            unique_platform="all",
        )

    def record_download(self, item: dict, ip: str, user_agent: str) -> bool:
        # Command-line clients must still be able to download MFN packages.
        # They are deliberately excluded from the visitor statistics.
        if is_bot(user_agent):
            return True
        if not self.download_limiter.allow(ip):
            return False
        record_event(
            self.database,
            event="download_start",
            product=item["product"],
            platform=item["platform"],
            version=item["version"],
            package_kind=item["package"],
            country=country_code(ip, self.geoip_database),
            identity=self.identity(ip, user_agent),
        )
        return True


def handler_factory(application: GatewayApplication):
    class GatewayHandler(BaseHTTPRequestHandler):
        server_version = "TEX8DownloadGateway/1"
        sys_version = ""

        def log_message(self, _format, *_args):
            return

        def _path(self) -> str:
            return urlsplit(self.path).path

        def _identity(self) -> tuple[str, str]:
            return client_ip(self.headers, self.client_address[0]), self.headers.get("User-Agent", "")

        def _json(self, status: int, payload: dict) -> None:
            body = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)

        def _empty(self, status: int) -> None:
            self.send_response(status)
            self.send_header("Content-Length", "0")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()

        def do_POST(self):
            if self._path() != "/v1/mfw-site/page-view":
                self._json(HTTPStatus.NOT_FOUND, {"error": "not_found"})
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
            except ValueError:
                length = -1
            if length < 2 or length > 512 or self.headers.get_content_type() != "application/json":
                self._json(HTTPStatus.BAD_REQUEST, {"error": "invalid_request"})
                return
            try:
                payload = json.loads(self.rfile.read(length))
                path = payload.get("path", "")
                if not isinstance(path, str) or len(path) > 180 or not path.startswith("/"):
                    raise ValueError("invalid path")
            except (json.JSONDecodeError, ValueError, AttributeError):
                self._json(HTTPStatus.BAD_REQUEST, {"error": "invalid_request"})
                return
            ip, user_agent = self._identity()
            application.record_page_view(path, ip, user_agent)
            self._empty(HTTPStatus.NO_CONTENT)

        def do_HEAD(self):
            self._handle_get()

        def do_GET(self):
            self._handle_get()

        def _handle_get(self):
            path = self._path()
            if path == "/v1/mfw-site/healthz":
                try:
                    artifacts = application.catalog.public_artifacts()
                    self._json(HTTPStatus.OK, {"status": "ok", "release_count": len(artifacts)})
                except Exception:
                    self._json(HTTPStatus.SERVICE_UNAVAILABLE, {"status": "unavailable"})
                return
            if path == "/v1/mfw-site/releases":
                try:
                    self._json(HTTPStatus.OK, {"schema": SCHEMA_VERSION, "artifacts": application.catalog.public_artifacts()})
                except Exception:
                    self._json(HTTPStatus.SERVICE_UNAVAILABLE, {"error": "release_catalog_unavailable"})
                return
            match = DOWNLOAD_PATH.fullmatch(path)
            if not match or match.group(3) not in PACKAGES:
                self._json(HTTPStatus.NOT_FOUND, {"error": "not_found"})
                return
            item = application.catalog.find(match.group(1), match.group(2), match.group(3))
            if not item:
                self._json(HTTPStatus.NOT_FOUND, {"error": "not_released"})
                return
            target = application.catalog.target(item)
            if not target:
                self._json(HTTPStatus.SERVICE_UNAVAILABLE, {"error": "download_temporarily_unavailable"})
                return
            if self.command == "GET":
                ip, user_agent = self._identity()
                if not application.record_download(item, ip, user_agent):
                    self._json(HTTPStatus.TOO_MANY_REQUESTS, {"error": "rate_limited"})
                    return
            self.send_response(HTTPStatus.FOUND)
            self.send_header("Location", target)
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", "0")
            self.end_headers()

    return GatewayHandler


def report(database: Path, include_registers: bool = False) -> dict:
    connection = connect_database(database)
    try:
        counters = [
            {
                "day": row[0], "event": row[1], "product": row[2], "platform": row[3],
                "version": row[4], "package": row[5], "country": row[6], "count": row[7],
            }
            for row in connection.execute(
                """
                SELECT day, event, product, platform, version, package_kind, country, count
                FROM aggregate_counters
                ORDER BY day, event, product, platform, version, package_kind, country
                """
            )
        ]
        uniques = []
        for row in connection.execute(
            """
            SELECT day, event, product, platform, version, package_kind, registers
            FROM unique_hll
            ORDER BY day, event, product, platform, version, package_kind
            """
        ):
            item = {
                "day": row[0], "event": row[1], "product": row[2], "platform": row[3],
                "version": row[4], "package": row[5], "estimate": hll_estimate(row[6]),
            }
            if include_registers:
                item["registers"] = base64.b64encode(row[6]).decode("ascii")
            uniques.append(item)
        return {"schema": SCHEMA_VERSION, "counters": counters, "unique_estimates": uniques}
    finally:
        connection.close()


def publish_artifact(args) -> None:
    artifact_file = Path(args.artifact).resolve(strict=True)
    if not artifact_file.is_file() or not SAFE_FILENAME.fullmatch(artifact_file.name):
        raise ValueError("invalid artifact file")
    sha256, size = sha256_file(artifact_file)
    item = validate_artifact({
        "product": args.product,
        "platform": args.platform,
        "package": args.package_kind,
        "version": args.version,
        "filename": artifact_file.name,
        "sha256": sha256,
        "size": size,
        "github_url": "" if args.github_url == "-" else args.github_url,
        "enabled": True,
    })
    artifact_root = Path(args.artifact_root)
    destination_dir = artifact_root / sha256
    destination_dir.mkdir(parents=True, exist_ok=True)
    destination = destination_dir / artifact_file.name
    if destination.exists():
        existing_digest, existing_size = sha256_file(destination)
        if existing_size != size or existing_digest != sha256:
            raise ValueError("immutable artifact destination mismatch")
    else:
        temporary = destination_dir / f".{artifact_file.name}.{os.getpid()}.tmp"
        shutil.copyfile(artifact_file, temporary)
        os.chmod(temporary, 0o644)
        with temporary.open("rb") as handle:
            os.fsync(handle.fileno())
        os.replace(temporary, destination)
    manifest_path = Path(args.manifest)
    artifacts = load_manifest(manifest_path) if manifest_path.exists() else []
    key = (item["product"], item["platform"], item["package"])
    artifacts = [existing for existing in artifacts if (existing["product"], existing["platform"], existing["package"]) != key]
    artifacts.append(item)
    artifacts.sort(key=lambda value: (value["product"], value["platform"], value["package"]))
    atomic_manifest_write(manifest_path, artifacts)
    print(json.dumps({"published": True, "product": item["product"], "platform": item["platform"], "package": item["package"], "version": item["version"], "sha256": sha256, "size": size}, sort_keys=True))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)
    serve = subparsers.add_parser("serve")
    serve.add_argument("--listen", default="127.0.0.1")
    serve.add_argument("--port", type=int, default=8097)
    serve.add_argument("--database", required=True)
    serve.add_argument("--manifest", required=True)
    serve.add_argument("--artifact-root", required=True)
    serve.add_argument("--geoip-database", default="")
    initialize = subparsers.add_parser("init")
    initialize.add_argument("--database", required=True)
    validation = subparsers.add_parser("validate-manifest")
    validation.add_argument("--manifest", required=True)
    mirror = subparsers.add_parser("mirror-plan")
    mirror.add_argument("--manifest", required=True)
    reporter = subparsers.add_parser("report")
    reporter.add_argument("--database", required=True)
    reporter.add_argument("--include-registers", action="store_true")
    publish = subparsers.add_parser("publish")
    publish.add_argument("--manifest", required=True)
    publish.add_argument("--artifact-root", required=True)
    publish.add_argument("--artifact", required=True)
    publish.add_argument("--product", required=True)
    publish.add_argument("--platform", required=True)
    publish.add_argument("--package", dest="package_kind", required=True)
    publish.add_argument("--version", required=True)
    publish.add_argument("--github-url", default="-")
    return parser


def main() -> None:
    args = build_parser().parse_args()
    if args.command == "init":
        initialize_database(Path(args.database))
        return
    if args.command == "validate-manifest":
        load_manifest(Path(args.manifest))
        return
    if args.command == "mirror-plan":
        for item in load_manifest(Path(args.manifest)):
            if item["enabled"]:
                print(f"{item['sha256']}\t{item['filename']}\t{item['size']}")
        return
    if args.command == "report":
        print(json.dumps(report(Path(args.database), args.include_registers), sort_keys=True))
        return
    if args.command == "publish":
        publish_artifact(args)
        return
    if args.command == "serve":
        geoip = Path(args.geoip_database) if args.geoip_database else None
        application = GatewayApplication(
            database=Path(args.database),
            manifest=Path(args.manifest),
            artifact_root=Path(args.artifact_root),
            geoip_database=geoip,
        )
        server = ThreadingHTTPServer((args.listen, args.port), handler_factory(application))
        server.daemon_threads = True
        server.serve_forever()


if __name__ == "__main__":
    main()
