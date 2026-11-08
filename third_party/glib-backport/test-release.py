#!/usr/bin/env python3
"""Exercise the real GLib string iterator in optimized upstream/patched builds."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import resource
import re
import shutil
import subprocess
import tempfile
import time

HERE = Path(__file__).resolve().parent
VENDOR = HERE.parent / "glib-0.18.5"
TESTS = r'''
use glib::variant::ToVariant;
fn strings() -> glib::Variant {
    vec!["first", "äöü", "", "中", "🙂"].to_variant()
}
#[test]
fn forward_iteration_preserves_borrowed_unicode_and_empty_strings() {
    let value = strings();
    let actual: Vec<&str> = value.array_iter_str().unwrap().collect();
    assert_eq!(actual, ["first", "äöü", "", "中", "🙂"]);
}
#[test]
fn nth_and_last_use_the_mutable_output_pointer() {
    let value = strings();
    let mut iter = value.array_iter_str().unwrap();
    assert_eq!(iter.nth(1), Some("äöü"));
    assert_eq!(iter.last(), Some("🙂"));
}
#[test]
fn backward_iteration_covers_next_back_and_nth_back() {
    let value = strings();
    let mut iter = value.array_iter_str().unwrap();
    assert_eq!(iter.next_back(), Some("🙂"));
    assert_eq!(iter.nth_back(1), Some(""));
    assert_eq!(iter.collect::<Vec<_>>(), ["first", "äöü"]);
}
#[test]
fn mixed_iteration_keeps_exact_size_and_fused_end() {
    let value = strings();
    let mut iter = value.array_iter_str().unwrap();
    assert_eq!(iter.len(), 5);
    assert_eq!(iter.next(), Some("first"));
    assert_eq!(iter.next_back(), Some("🙂"));
    assert_eq!(iter.nth(1), Some(""));
    assert_eq!(iter.len(), 1);
    assert_eq!(iter.next(), Some("中"));
    assert_eq!(iter.len(), 0);
    assert_eq!(iter.next_back(), None);
    assert_eq!(iter.next(), None);
}
#[test]
fn empty_and_out_of_bounds_iterators_return_none() {
    let empty: Vec<&str> = vec![];
    let value = empty.to_variant();
    let mut iter = value.array_iter_str().unwrap();
    assert_eq!(iter.len(), 0);
    assert_eq!(iter.next(), None);
    assert_eq!(iter.next_back(), None);
    let value = strings();
    assert_eq!(value.array_iter_str().unwrap().nth(99), None);
    assert_eq!(value.array_iter_str().unwrap().nth_back(99), None);
}
#[test]
fn returned_strings_borrow_the_serialized_variant_storage() {
    let value = strings();
    let data = value.data();
    let start = data.as_ptr() as usize;
    let end = start + data.len();
    for text in value.array_iter_str().unwrap() {
        let pointer = text.as_ptr() as usize;
        assert!(pointer >= start && pointer + text.len() < end);
    }
}
'''


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def no_core_files():
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--target-dir", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--lockfile", type=Path)
    args = parser.parse_args()
    manifest = json.loads((HERE / "upstream.json").read_text())
    patch = HERE / manifest["securityBackport"]["patchFile"]
    assert digest(patch) == manifest["securityBackport"]["patchSha256"]
    assert digest(VENDOR / "src/variant_iter.rs") == manifest["patchedSourceSha256"]
    originals = manifest["originalFiles"]
    assert {str(p.relative_to(VENDOR)) for p in VENDOR.rglob("*") if p.is_file()} == set(originals)
    for relative, record in originals.items():
        if relative != "src/variant_iter.rs":
            assert digest(VENDOR / relative) == record["sha256"], relative
    env = os.environ.copy()
    env.update({"CARGO_BUILD_JOBS": "2", "CARGO_NET_OFFLINE": "true"})
    toolchain = HERE.parent.parent / "rust-toolchain.toml"
    if toolchain.exists():
        env["RUSTUP_TOOLCHAIN"] = re.search(r'channel\s*=\s*"([^\"]+)"', toolchain.read_text()).group(1)
    report = {"crate": "glib0.18.5", "advisory": "RUSTSEC-2024-0429", "profile": "release/opt-level3", "upstreamFixCommit": manifest["securityBackport"]["upstreamFixCommit"], "rustc": subprocess.check_output(["rustc", "--version"], env=env, text=True).strip(), "tests": []}
    with tempfile.TemporaryDirectory(prefix="mfw-glib-backport-") as tmp_name:
        tmp = Path(tmp_name)
        baseline = tmp / "glib-upstream"
        shutil.copytree(VENDOR, baseline)
        source = baseline / "src/variant_iter.rs"
        text = source.read_text()
        text = text.replace("let mut p: *mut libc::c_char = std::ptr::null_mut();", "let p: *mut libc::c_char = std::ptr::null_mut();", 1)
        text = text.replace("                &mut p,", "                &p,", 1)
        source.write_text(text)
        for relative, record in originals.items():
            assert digest(baseline / relative) == record["sha256"], relative
        env["CARGO_TARGET_DIR"] = str((args.target_dir or tmp / "target").resolve())
        for label, dependency in [("upstream-unpatched", baseline), ("upstream-fix-backport", VENDOR)]:
            fixture = tmp / label
            (fixture / "tests").mkdir(parents=True)
            (fixture / "Cargo.toml").write_text('[package]\nname="mfw-glib-string-iterator-regression"\nversion="0.0.0"\nedition="2021"\n[dependencies]\nglib={path=' + json.dumps(str(dependency)) + '}\n[profile.release]\nopt-level=3\n')
            (fixture / "tests/string_iterator.rs").write_text(TESTS)
            if args.lockfile:
                shutil.copy2(args.lockfile, fixture / "Cargo.lock")
            cmd = ["cargo", "test", "--offline", "--release", "--manifest-path", str(fixture / "Cargo.toml"), "--test", "string_iterator", "--", "--test-threads=1"]
            start = time.monotonic()
            result = subprocess.run(cmd, env=env, cwd=fixture, capture_output=True, text=True, preexec_fn=no_core_files)
            row = {"variant": label, "exitCode": result.returncode, "seconds": round(time.monotonic() - start, 2), "command": cmd, "stdout": result.stdout, "stderr": result.stderr}
            report["tests"].append(row)
            print(json.dumps({k: row[k] for k in ["variant", "exitCode", "seconds"]}), flush=True)
            if args.output:
                args.output.parent.mkdir(parents=True, exist_ok=True)
                args.output.write_text(json.dumps(report, indent=2) + "\n")
            if label == "upstream-unpatched":
                assert result.returncode != 0 and ("signal: 11" in result.stderr or "signal: 6" in result.stderr), "Unpatched optimized iterator must reproduce the memory-safety failure, not a compilation error"
            else:
                assert result.returncode == 0 and "6 passed" in result.stdout, "Patched optimized iterator must pass all public-API regression tests"
    report["result"] = "PASS: original optimized memory-safety failure reproduced; backport passes6 public-API tests"
    if args.output:
        args.output.write_text(json.dumps(report, indent=2) + "\n")
    print(report["result"])


if __name__ == "__main__":
    main()
