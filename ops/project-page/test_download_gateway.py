#!/usr/bin/env python3

import http.client
import importlib.util
import json
import sqlite3
import tempfile
import threading
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).with_name("download_gateway.py")
SPEC = importlib.util.spec_from_file_location("mfw_download_gateway", MODULE_PATH)
gateway = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(gateway)


class DownloadGatewayTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        root = Path(self.temporary.name)
        self.database = root / "metrics.sqlite3"
        self.artifact_root = root / "artifacts"
        self.artifact = self.artifact_root / ("a" * 64) / "wallet.dmg"
        self.artifact.parent.mkdir(parents=True)
        self.artifact.write_bytes(b"public-test-artifact")
        self.manifest = root / "releases.json"
        self.manifest.write_text(json.dumps({
            "schema": 1,
            "artifacts": [{
                "product": "mfw",
                "platform": "macos",
                "package": "dmg",
                "version": "1.0.0",
                "filename": "wallet.dmg",
                "sha256": "a" * 64,
                "size": len(b"public-test-artifact"),
                "github_url": "https://github.com/tex8com/releases/download/v1.0.0/wallet.dmg",
                "enabled": True,
            }],
        }), encoding="utf-8")
        self.application = gateway.GatewayApplication(
            database=self.database,
            manifest=self.manifest,
            artifact_root=self.artifact_root,
        )
        self.server = gateway.ThreadingHTTPServer(("127.0.0.1", 0), gateway.handler_factory(self.application))
        self.server.daemon_threads = True
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        self.temporary.cleanup()

    def request(self, method, path, body=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=3)
        connection.request(method, path, body=body, headers=headers or {})
        response = connection.getresponse()
        payload = response.read()
        result = response.status, dict(response.getheaders()), payload
        connection.close()
        return result

    def test_page_views_are_aggregated_without_raw_identifiers(self):
        body = json.dumps({"path": "/de/"})
        headers = {
            "Content-Type": "application/json",
            "X-Real-IP": "198.51.100.8",
            "User-Agent": "Mozilla/5.0 Macintosh Safari/605.1",
        }
        self.assertEqual(self.request("POST", "/v1/mfw-site/page-view", body, headers)[0], 204)
        self.assertEqual(self.request("POST", "/v1/mfw-site/page-view", body, headers)[0], 204)
        output = gateway.report(self.database)
        self.assertEqual(output["counters"][0]["count"], 2)
        self.assertEqual(output["unique_estimates"][0]["estimate"], 1)
        database_bytes = self.database.read_bytes()
        self.assertNotIn(b"198.51.100.8", database_bytes)
        self.assertNotIn(b"Safari", database_bytes)

    def test_download_get_counts_once_and_head_does_not_count(self):
        headers = {"X-Real-IP": "203.0.113.4", "User-Agent": "Mozilla/5.0 Firefox/120"}
        status, response_headers, _ = self.request("HEAD", "/download/mfw/macos/dmg", headers=headers)
        self.assertEqual(status, 302)
        self.assertEqual(response_headers["Location"], f"/release-assets/{'a' * 64}/wallet.dmg")
        self.assertEqual(gateway.report(self.database)["counters"], [])
        status, response_headers, _ = self.request("GET", "/download/mfw/macos/dmg", headers=headers)
        self.assertEqual(status, 302)
        self.assertEqual(response_headers["Location"], f"/release-assets/{'a' * 64}/wallet.dmg")
        output = gateway.report(self.database)
        self.assertEqual(output["counters"][0]["event"], "download_start")
        self.assertEqual(output["counters"][0]["count"], 1)
        self.assertEqual(output["unique_estimates"][0]["estimate"], 1)

    def test_command_line_download_is_allowed_but_not_counted(self):
        status, response_headers, _ = self.request(
            "GET",
            "/download/mfw/macos/dmg",
            headers={"X-Real-IP": "203.0.113.7", "User-Agent": "curl/8.7.1"},
        )
        self.assertEqual(status, 302)
        self.assertEqual(response_headers["Location"], f"/release-assets/{'a' * 64}/wallet.dmg")
        self.assertEqual(gateway.report(self.database)["counters"], [])

    def test_public_catalog_contains_no_fallback_url(self):
        status, _, payload = self.request("GET", "/v1/mfw-site/releases")
        self.assertEqual(status, 200)
        artifact = json.loads(payload)["artifacts"][0]
        self.assertEqual(artifact["download_path"], "/download/mfw/macos/dmg")
        self.assertNotIn("github_url", artifact)

    def test_missing_and_disabled_releases_fail_closed(self):
        self.assertEqual(self.request("GET", "/download/mfw/linux/appimage")[0], 404)
        payload = json.loads(self.manifest.read_text(encoding="utf-8"))
        payload["artifacts"][0]["enabled"] = False
        self.manifest.write_text(json.dumps(payload), encoding="utf-8")
        self.assertEqual(self.request("GET", "/download/mfw/macos/dmg")[0], 404)

    def test_database_schema_has_only_aggregate_and_hll_tables(self):
        connection = sqlite3.connect(self.database)
        try:
            names = {
                row[0]
                for row in connection.execute(
                    "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
                )
            }
            self.assertEqual(names, {"aggregate_counters", "unique_hll"})
            columns = {row[1] for row in connection.execute("PRAGMA table_info(aggregate_counters)")}
            self.assertFalse({"ip", "user_agent", "referrer", "visitor_hash"} & columns)
        finally:
            connection.close()


if __name__ == "__main__":
    unittest.main()
