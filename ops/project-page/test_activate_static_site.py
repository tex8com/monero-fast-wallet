import hashlib
import importlib.util
import io
import json
import os
import pathlib
import tarfile
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("activate_static_site", pathlib.Path(__file__).with_name("activate-static-site.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class StaticActivationTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.base = pathlib.Path(self.temporary.name)
        self.root = self.base / "www"
        self.stage = self.base / "stage"
        self.stage.mkdir()
        self.releases = self.root / "monero-fast-wallet-releases"
        self.old = self.releases / "old"
        self.old.mkdir(parents=True)
        (self.root / "monero-fast-wallet.current").symlink_to(self.old)
        (self.root / "monero-fast-wallet-mirror/releases").mkdir(parents=True)
        self.mirror = self.root / "monero-fast-wallet-mirror/current"
        self.mirror.write_bytes(b"version=old\nsha256=old\n")
        self.old_mirror = self.mirror.read_bytes()
        (self.root / "mfw-downloads").mkdir()
        self.catalog = self.root / "mfw-downloads/releases.json"
        self.catalog.write_text('{"schema":1,"artifacts":[]}')
        self.files = {"index.html": b"<html>new</html>", "de/index.html": b"<html>neu</html>", "assets/app.js": b"new-app", "monero-wallet-logo.svg": b"<svg/>"}
        self.commit = "a" * 40
        self.write_archive()

    def tearDown(self):
        self.temporary.cleanup()

    def write_archive(self, unsafe=None):
        archive = self.stage / "website-dist.tar.gz"
        with tarfile.open(archive, "w:gz") as bundle:
            for name, contents in self.files.items():
                member = tarfile.TarInfo(name)
                member.size = len(contents)
                bundle.addfile(member, io.BytesIO(contents))
            if unsafe:
                member = tarfile.TarInfo(unsafe)
                member.size = 1
                bundle.addfile(member, io.BytesIO(b"x"))
        self.manifest = {"sourceCommit": self.commit, "archiveSha256": module.digest(archive), "archiveBytes": archive.stat().st_size, "files": {name: hashlib.sha256(data).hexdigest() for name, data in self.files.items()}}
        self.write_manifest()

    def write_manifest(self):
        (self.stage / "deployment-manifest.json").write_text(json.dumps(self.manifest))

    def fetch(self, route):
        if route.endswith("healthz"):
            return b"ok"
        name = "index.html" if route == "/" else route.lstrip("/")
        if name.endswith("/"):
            name += "index.html"
        return self.files[name]

    def activate(self, fetch=None):
        return module.activate(self.stage, self.commit, str(self.old), root=self.root, fetch=fetch or self.fetch)

    def assert_old_state(self):
        self.assertEqual(os.readlink(self.root / "monero-fast-wallet.current"), str(self.old))
        self.assertEqual(self.mirror.read_bytes(), self.old_mirror)
        self.assertEqual(list(self.releases.iterdir()), [self.old])

    def test_success_changes_only_static_target_and_mirror(self):
        old_catalog = self.catalog.read_bytes()
        result = self.activate()
        self.assertFalse(result["backupCreated"])
        self.assertTrue(result["catalogUnchanged"])
        self.assertFalse(result["serviceOrConfigurationChanges"])
        self.assertEqual(self.catalog.read_bytes(), old_catalog)
        self.assertTrue(self.old.is_dir())
        self.assertEqual(module.digest(pathlib.Path(result["release"]) / "assets/app.js"), self.manifest["files"]["assets/app.js"])
        self.assertIn(self.manifest["archiveSha256"].encode(), self.mirror.read_bytes())
        self.assertFalse(list(self.root.rglob("*backup*")))

    def test_http_failure_restores_original_target_without_backup(self):
        with self.assertRaises(AssertionError):
            self.activate(lambda route: b"wrong")
        self.assert_old_state()

    def test_archive_tamper_fails_before_target_change(self):
        with (self.stage / "website-dist.tar.gz").open("ab") as output:
            output.write(b"tamper")
        with self.assertRaises(AssertionError):
            self.activate()
        self.assert_old_state()

    def test_unsafe_archive_path_is_rejected(self):
        self.write_archive("../escape")
        with self.assertRaises(AssertionError):
            self.activate()
        self.assert_old_state()
        self.assertFalse((self.root / "escape").exists())

    def test_concurrent_target_and_wrong_source_are_rejected(self):
        for expected, commit in [(str(self.releases / "different"), self.commit), (str(self.old), "b" * 40)]:
            with self.assertRaises(AssertionError):
                module.activate(self.stage, commit, expected, root=self.root, fetch=self.fetch)
        self.assert_old_state()

    def test_wrong_file_hash_is_rejected_before_activation(self):
        self.manifest["files"]["assets/app.js"] = "0" * 64
        self.write_manifest()
        with self.assertRaises(AssertionError):
            self.activate()
        self.assert_old_state()

    def test_concurrent_mirror_is_not_overwritten_on_rollback(self):
        def concurrent_fetch(route):
            self.mirror.write_bytes(b"concurrent deployment")
            return self.fetch(route)
        with self.assertRaises(AssertionError):
            self.activate(concurrent_fetch)
        self.assertEqual(os.readlink(self.root / "monero-fast-wallet.current"), str(self.old))
        self.assertEqual(self.mirror.read_bytes(), b"concurrent deployment")
        self.assertEqual(list(self.releases.iterdir()), [self.old])


if __name__ == "__main__":
    unittest.main()
