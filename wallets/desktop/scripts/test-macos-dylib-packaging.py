#!/usr/bin/env python3
"""Exercise the packager with real Mach-O dependencies, without a wallet build."""
import hashlib
import importlib.util
from pathlib import Path
import plistlib
import shutil
import subprocess
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location("packager", Path(__file__).with_name("bundle-macos-dylibs.py"))
PACKAGER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PACKAGER)


def run(*args):
    return subprocess.run(args, check=True, capture_output=True, text=True)


class NativePackaging(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="mfw-macho-closure-")
        self.root = Path(self.temp.name)
        self.app = self.root / "Fixture.app"
        self.macos = self.app / "Contents/MacOS"
        self.frameworks = self.app / "Contents/Frameworks"
        self.macos.mkdir(parents=True)
        self.frameworks.mkdir()
        (self.app / "Contents/Info.plist").write_bytes(plistlib.dumps({
            "CFBundleExecutable": "probe", "CFBundleIdentifier": "com.tex8.macho-fixture",
            "CFBundlePackageType": "APPL", "LSMinimumSystemVersion": "12.0"}))
        self.external = self.root / "external"
        self.external.mkdir()

    def tearDown(self):
        self.temp.cleanup()

    def compile(self, body, output, libraries=(), minimum="12.0", arch=None):
        source = self.root / (hashlib.sha256(str(output).encode()).hexdigest()[:12] + ".c")
        source.write_text(body)
        args = ["xcrun", "clang", str(source), f"-mmacosx-version-min={minimum}",
                "-Wl,-headerpad_max_install_names", "-o", str(output)]
        if arch:
            args += ["-arch", arch]
        if output.suffix == ".dylib":
            args += ["-dynamiclib", "-Wl,-install_name," + str(output)]
        run(*args, *map(str, libraries))

    def fixture(self, leaf_minimum="12.0"):
        leaf = self.external / "libleaf.dylib"
        middle = self.external / "libmiddle.dylib"
        self.compile("int leaf(void) { return 40; }", leaf, minimum=leaf_minimum)
        self.compile("int leaf(void); int middle(void) { return leaf() + 2; }", middle, [leaf])
        self.compile("int middle(void); int main(void) { return middle() != 42; }", self.macos / "probe", [middle])
        shutil.copy2(self.macos / "probe", self.macos / "sidecar")
        return leaf, middle

    def bundle(self, overrides=()):
        return PACKAGER.Bundle(self.app, [self.external], overrides)

    def test_transitive_closure_sidecar_and_runtime_without_sources(self):
        self.fixture()
        result = self.bundle().bundle()
        self.assertEqual(result["machOImages"], 4)
        self.assertEqual(result["localDependencyEdges"], 3)
        self.external.rename(self.root / "source-unavailable")
        for path in sorted(self.frameworks.glob("*.dylib")) + [self.macos / "sidecar", self.macos / "probe"]:
            run("codesign", "--force", "--sign", "-", "--timestamp=none", str(path))
        run(str(self.macos / "probe"))
        run(str(self.macos / "sidecar"))
        self.assertTrue(self.bundle().check()["closureVerified"])

    def test_repeated_packaging_preserves_signed_image_bytes(self):
        self.fixture()
        first = self.bundle()
        first.bundle()
        main = (self.macos / "probe").resolve()
        for path in [p for p in first.images() if p != main] + [main]:
            run("codesign", "--force", "--sign", "-", "--timestamp=none", str(path))
        before = {p: hashlib.sha256(p.read_bytes()).hexdigest() for p in first.images()}
        second = self.bundle()
        second.bundle()
        self.assertFalse(second.changed)
        self.assertFalse(second.copied)
        self.assertEqual(before, {p: hashlib.sha256(p.read_bytes()).hexdigest() for p in second.images()})

    def test_missing_transitive_dependency_fails(self):
        leaf, _ = self.fixture()
        leaf.unlink()
        with self.assertRaisesRegex(ValueError, "Unresolved dependency"):
            self.bundle().bundle()

    def test_basename_collision_fails(self):
        self.fixture()
        self.compile("int leaf(void) { return 7; }", self.frameworks / "libleaf.dylib")
        with self.assertRaisesRegex(ValueError, "basename collision"):
            self.bundle().bundle()

    def test_newer_minimum_os_fails(self):
        self.fixture(leaf_minimum="26.0")
        with self.assertRaisesRegex(ValueError, "requires macOS 26.0; app declares 12.0"):
            self.bundle().bundle()

    def test_missing_application_minimum_os_fails(self):
        plist = self.app / "Contents/Info.plist"
        info = plistlib.loads(plist.read_bytes())
        del info["LSMinimumSystemVersion"]
        plist.write_bytes(plistlib.dumps(info))
        with self.assertRaisesRegex(ValueError, "valid LSMinimumSystemVersion"):
            self.bundle().check()

    def test_missing_image_minimum_os_fails(self):
        main = self.macos / "probe"
        self.compile("int main(void) { return 0; }", main)
        without_metadata = self.root / "without-minimum"
        run("xcrun", "vtool", "-remove-build-version", "macos", "-output", str(without_metadata), str(main))
        shutil.copy2(without_metadata, main)
        with self.assertRaisesRegex(ValueError, "Missing minimum macOS metadata"):
            self.bundle().check()

    def test_explicit_rebuilt_library_replaces_newer_os_copy(self):
        self.fixture(leaf_minimum="26.0")
        with self.assertRaises(ValueError):
            self.bundle().bundle()
        replacement = self.root / "libleaf.dylib"
        versioned = self.root / "libleaf.versioned.dylib"
        self.compile("int leaf(void) { return 40; }", versioned)
        replacement.symlink_to(versioned.name)
        self.assertTrue(self.bundle([replacement]).bundle()["deploymentTargetsVerified"])
        self.assertIn("12.0", PACKAGER.min_versions(self.frameworks / "libleaf.dylib"))

    def test_parent_traversal_is_not_a_system_dependency(self):
        main = self.macos / "probe"
        self.compile("int main(void) { return 0; }", main)
        run("install_name_tool", "-change", "/usr/lib/libSystem.B.dylib", "/usr/lib/../local/libforbidden.dylib", str(main))
        with self.assertRaisesRegex(ValueError, "Absolute non-system dependency"):
            self.bundle().check()

    def test_architecture_mismatch_fails(self):
        self.fixture()
        self.bundle().bundle()
        native = run("lipo", "-archs", str(self.macos / "probe")).stdout.strip()
        other = "x86_64" if native == "arm64" else "arm64"
        self.compile("int leaf(void) { return 40; }", self.frameworks / "libleaf.dylib", arch=other)
        run("install_name_tool", "-id", "@rpath/libleaf.dylib", str(self.frameworks / "libleaf.dylib"))
        with self.assertRaisesRegex(ValueError, "Missing architectures"):
            self.bundle().check()


if __name__ == "__main__":
    unittest.main(verbosity=2)
