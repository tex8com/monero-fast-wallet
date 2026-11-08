#!/usr/bin/env python3
"""Exercise the desktop dependency gate using temporary sources and mock audit.

No Cargo build, audit database mutation, or product source/lock write is needed.
"""

import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


REPO = Path(__file__).resolve().parent.parent
sys.dont_write_bytecode = True
SPEC = importlib.util.spec_from_file_location("security_pins", REPO / "scripts/verify-security-source-pins.py")
PINS = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PINS)


class DesktopSecurityGateTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.base_temp = tempfile.TemporaryDirectory(prefix="mfw-security-test-base-")
        cls.base = Path(cls.base_temp.name)
        folders = PINS.CRYPTO_CRATES | PINS.TOR_CRATES | {"glib-0.18.5"}
        for name in folders:
            shutil.copytree(REPO / "third_party" / name, cls.base / "third_party" / name)
        for relative in PINS.MANIFEST_PINS:
            target = cls.base / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(REPO / relative, target)
        glib = json.loads((REPO / "third_party/glib-backport/upstream.json").read_text())
        patch = glib["securityBackport"]["patchFile"]
        shutil.copyfile(REPO / "third_party/glib-backport" / patch,
                        cls.base / "third_party/glib-backport" / patch)
        for relative in PINS.PRODUCT_ROOTS:
            (cls.base / relative).mkdir(parents=True)
            for name in ["Cargo.toml", "Cargo.lock"]:
                shutil.copyfile(REPO / relative / name, cls.base / relative / name)
        (cls.base / "scripts").mkdir()
        for name in ["check-desktop-security-warnings.sh", "verify-security-source-pins.py"]:
            shutil.copyfile(REPO / "scripts" / name, cls.base / "scripts" / name)

    @classmethod
    def tearDownClass(cls):
        cls.base_temp.cleanup()

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="mfw-security-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "repo"
        shutil.copytree(self.base, self.root)
        self.audit = {
            "database": {"advisory-count": 1422},
            "lockfile": {"dependency-count": len(PINS.lock_packages(self.root / "wallets/desktop/src-tauri/Cargo.lock"))},
            "settings": {"ignore": [], "target_arch": [], "target_os": [], "severity": None,
                         "informational_warnings": ["unmaintained", "unsound", "notice"]},
            "vulnerabilities": {"found": False, "count": 0, "list": []},
            "warnings": {"unmaintained": [
                {"advisory": {"id": advisory, "informational": "unmaintained"},
                 "package": {"name": name, "version": version}}
                for advisory, name, version in sorted(PINS.EXPECTED_MAINTENANCE_WARNINGS)
            ]},
        }
        self.mock_bin = Path(self.temp.name) / "bin"
        self.mock_bin.mkdir()
        cargo = self.mock_bin / "cargo"
        cargo.write_text("""#!/usr/bin/env python3
import os, pathlib, sys
assert sys.argv[1] == 'audit'
assert '--json' in sys.argv and '--file' in sys.argv
assert '--ignore' not in sys.argv and '--no-yanked' not in sys.argv
assert not any(a.startswith('--target') or a == '--severity' for a in sys.argv)
if os.environ.get('FAKE_AUDIT_MUTATE_FILE'):
    p = pathlib.Path(os.environ['FAKE_AUDIT_MUTATE_FILE'])
    p.write_text(p.read_text() + '\\n# changed during audit\\n')
sys.stdout.write(pathlib.Path(os.environ['FAKE_AUDIT_JSON']).read_text())
sys.stderr.write(os.environ.get('FAKE_AUDIT_STDERR', ''))
sys.exit(int(os.environ.get('FAKE_AUDIT_EXIT', '0')))
""")
        cargo.chmod(0o755)

    def run_gate(self, expected_success, payload=None, **environment):
        audit = Path(self.temp.name) / "audit.json"
        audit.write_text(json.dumps(self.audit if payload is None else payload))
        env = dict(os.environ)
        env.update({"PATH": str(self.mock_bin) + os.pathsep + env["PATH"],
                    "FAKE_AUDIT_JSON": str(audit)})
        env.update(environment)
        result = subprocess.run(["bash", str(self.root / "scripts/check-desktop-security-warnings.sh")],
                                env=env, capture_output=True, text=True)
        self.assertEqual(result.returncode == 0, expected_success, result.stdout + result.stderr)
        if expected_success:
            self.assertIn("0 vulnerabilities; 11 known unmaintained-package warnings remain", result.stdout)
        return result

    def change(self, relative, old=None, new="\n// tampered\n"):
        path = self.root / relative
        text = path.read_text()
        path.write_text(text + new if old is None else text.replace(old, new))

    def test_reviewed_sources_and_exact_maintenance_warnings_pass(self):
        self.run_gate(True)

    def test_new_vulnerability_fails_even_with_zero_tool_exit(self):
        self.audit["vulnerabilities"] = {"found": True, "count": 1,
                                         "list": [{"advisory": {"id": "RUSTSEC-2099-0001"}}]}
        self.run_gate(False, SECURITY_EXCEPTION_DATE_OVERRIDE="2020-01-01")

    def test_unexpected_warning_fails(self):
        self.audit["warnings"]["unmaintained"].append({
            "advisory": {"id": "RUSTSEC-2099-0002", "informational": "unmaintained"},
            "package": {"name": "unexpected", "version": "1.0.0"}})
        self.run_gate(False)

    def test_missing_warning_requires_reassessment(self):
        self.audit["warnings"]["unmaintained"].pop()
        self.run_gate(False)

    def test_unsound_warning_fails(self):
        self.audit["warnings"]["unsound"] = [{"advisory": {"id": "RUSTSEC-2024-0429"}}]
        self.run_gate(False)

    def test_yanked_warning_fails(self):
        self.audit["warnings"]["yanked"] = [{"package": {"name": "yanked", "version": "1.0.0"}}]
        self.run_gate(False)

    def test_ignored_advisory_fails(self):
        self.audit["settings"]["ignore"] = ["RUSTSEC-2023-0071"]
        self.run_gate(False)

    def test_incomplete_audit_fails(self):
        self.run_gate(False, FAKE_AUDIT_EXIT="2")

    def test_index_error_cannot_be_hidden_by_zero_exit(self):
        self.run_gate(False, FAKE_AUDIT_STDERR="warning: failed to update crates.io index\n")

    def test_audit_cannot_cover_a_different_lock(self):
        self.audit["lockfile"]["dependency-count"] += 1
        self.run_gate(False)

    def test_glib_patched_source_tampering_fails(self):
        self.change("third_party/glib-0.18.5/src/variant_iter.rs")
        self.run_gate(False)

    def test_glib_unmodified_source_tampering_fails(self):
        self.change("third_party/glib-0.18.5/src/lib.rs")
        self.run_gate(False)

    def test_crypto_source_tampering_fails(self):
        self.change("third_party/dalek-ff-group-0.4.6/src/field.rs")
        self.run_gate(False)

    def test_tor_source_tampering_fails(self):
        self.change("third_party/tor-llcrypto-0.47.0/src/pk/rsa.rs")
        self.run_gate(False)

    def test_extra_vendor_file_fails(self):
        (self.root / "third_party/glib-0.18.5/src/unreviewed.rs").write_text("// unexpected source\n")
        self.run_gate(False)

    def test_missing_vendor_file_fails(self):
        (self.root / "third_party/glib-0.18.5/LICENSE").unlink()
        self.run_gate(False)

    def test_source_symlink_fails(self):
        path = self.root / "third_party/glib-0.18.5/src/lib.rs"
        other = Path(self.temp.name) / "untrusted.rs"
        other.write_bytes(path.read_bytes())
        path.unlink()
        path.symlink_to(other)
        self.run_gate(False)

    def test_rewriting_source_manifest_does_not_authorize_changes(self):
        self.change("third_party/crypto-bigint-migration/VENDOR-SOURCES.json", new="\n")
        self.run_gate(False)

    def test_old_bigint_in_native_product_lock_fails(self):
        self.change("native/fast-wallet-protocol/Cargo.lock",
                    'name = "crypto-bigint"\nversion = "0.7.10"',
                    'name = "crypto-bigint"\nversion = "0.5.5"')
        self.run_gate(False)

    def test_rsa_in_recipient_lock_fails(self):
        self.change("native/mfw-recipient-protocol/Cargo.lock", new='\n[[package]]\nname = "rsa"\nversion = "0.9.10"\n')
        self.run_gate(False)

    def test_old_desktop_zip_fails(self):
        self.change("wallets/desktop/src-tauri/Cargo.lock",
                    'name = "zip"\nversion = "9.4.2"', 'name = "zip"\nversion = "4.6.1"')
        self.run_gate(False)

    def test_unwired_source_patch_fails(self):
        self.change("wallets/desktop/src-tauri/Cargo.toml", "../../../third_party/glib-0.18.5", "../../../third_party/decoy-glib")
        self.run_gate(False)

    def test_registry_package_cannot_replace_verified_path_source(self):
        self.change("wallets/desktop/src-tauri/Cargo.lock", 'name = "glib"\nversion = "0.18.5"',
                    'name = "glib"\nversion = "0.18.5"\nsource = "' + PINS.REGISTRY + '"')
        self.run_gate(False)

    def test_dependency_change_during_audit_fails(self):
        self.run_gate(False, FAKE_AUDIT_MUTATE_FILE=str(self.root / "wallets/desktop/src-tauri/Cargo.lock"))


if __name__ == "__main__":
    unittest.main()
