#!/usr/bin/env python3
import hashlib
import hmac
import json
import os
import re
import secrets
import stat
import sys
import urllib.error
import urllib.request
from pathlib import Path


def request(method: str, url: str, body: dict | None = None) -> dict:
    payload = None if body is None else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=payload,
        method=method,
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as response:
            return json.loads(response.read(1024 * 1024).decode("utf-8"))
    except urllib.error.HTTPError as error:
        detail = error.read(4096).decode("utf-8", errors="replace")
        raise RuntimeError(f"Synapse returned HTTP {error.code}: {detail}") from error


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit(
            "usage: bootstrap-synapse-admin.py <homeserver.yaml> <token-output>"
        )
    config_path = Path(sys.argv[1])
    token_path = Path(sys.argv[2])
    if token_path.exists():
        metadata = token_path.lstat()
        if not stat.S_ISREG(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
            raise RuntimeError("existing Synapse admin token is not a regular file")
        if token_path.stat().st_size < 32:
            raise RuntimeError("existing Synapse admin token is invalid")
        return

    config = config_path.read_text(encoding="utf-8")
    match = re.search(
        r'(?m)^registration_shared_secret:\s*["\']([^"\']{32,})["\']\s*$',
        config,
    )
    if not match:
        raise RuntimeError("Synapse registration bootstrap secret is unavailable")
    shared_secret = match.group(1)
    nonce = request("GET", "http://127.0.0.1:8008/_synapse/admin/v1/register")[
        "nonce"
    ]
    username = "enthusiast_service_admin"
    password = secrets.token_urlsafe(48)
    mac_input = "\0".join((nonce, username, password, "admin")).encode("utf-8")
    digest = hmac.new(
        shared_secret.encode("utf-8"), mac_input, hashlib.sha1
    ).hexdigest()
    request(
        "POST",
        "http://127.0.0.1:8008/_synapse/admin/v1/register",
        {
            "nonce": nonce,
            "username": username,
            "password": password,
            "admin": True,
            "mac": digest,
        },
    )
    login = request(
        "POST",
        "http://127.0.0.1:8008/_matrix/client/v3/login",
        {
            "type": "m.login.password",
            "identifier": {"type": "m.id.user", "user": username},
            "password": password,
            "initial_device_display_name": "Monero Enthusiast identity lifecycle",
        },
    )
    token = login.get("access_token")
    if not isinstance(token, str) or len(token) < 32:
        raise RuntimeError("Synapse did not return a valid administrator token")
    token_path.parent.mkdir(parents=True, exist_ok=True)
    descriptor = os.open(
        token_path,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL,
        0o600,
    )
    with os.fdopen(descriptor, "w", encoding="utf-8") as output:
        output.write(token)
        output.write("\n")


if __name__ == "__main__":
    main()
