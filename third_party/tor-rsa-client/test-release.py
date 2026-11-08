#!/usr/bin/env python3
"""Run source-linked client RSA/SSH tests without building the wallet/Core."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--work-dir', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--lockfile', type=Path)
    args = parser.parse_args()
    here = Path(__file__).resolve().parent
    third_party = here.parent
    packages = {
        'tor-llcrypto': '0.47.0', 'tor-key-forge': '0.47.0',
        'tor-cert': '0.47.0', 'tor-netdoc': '0.47.0',
        'ssh-key-fork-arti': '0.6.7',
    }
    work = args.work_dir.resolve()
    if work.exists():
        raise SystemExit('Refusing to overwrite an existing test workspace')
    work.mkdir(parents=True)
    hashes = {}
    for name, version in packages.items():
        source = third_party / (name + '-' + version)
        target = work / source.name
        shutil.copytree(source, target)
        # Original package-local lockfiles are retained as provenance; the
        # explicit fixture/root lock controls this isolated test workspace.
        (target / 'Cargo.lock').unlink(missing_ok=True)
        for path in sorted(source.rglob('*')):
            if path.is_file() and path.name != 'Cargo.lock':
                relative = path.relative_to(third_party).as_posix()
                assert sha(path) == sha(work / relative), relative
                hashes[relative] = sha(path)
    lock_hash = None
    if args.lockfile:
        lock_hash = sha(args.lockfile)
        shutil.copyfile(args.lockfile, work / 'Cargo.lock')
        if lock_hash != sha(args.lockfile):
            raise SystemExit('The input lockfile changed while copying')
    manifest = '[workspace]\nresolver="3"\nmembers=['
    manifest += ','.join('"' + name + '-' + version + '"' for name, version in packages.items())
    manifest += ']\n\n[patch.crates-io]\n'
    manifest += '\n'.join(name + '={path="' + name + '-' + version + '"}'
                          for name, version in packages.items())
    (work / 'Cargo.toml').write_text(manifest + '\n')
    commands = [
        ['test', '-p', 'tor-llcrypto', '--lib', 'mfw_client_rsa_tests'],
        ['test', '-p', 'tor-llcrypto', '--test', 'testvec'],
        ['test', '-p', 'tor-key-forge', '--lib'],
        ['test', '-p', 'tor-cert', '--lib', '--tests'],
        ['test', '-p', 'tor-netdoc', '--lib', '--features', 'encode,incomplete,hs-client'],
        ['test', '-p', 'ssh-key-fork-arti', '--lib', '--tests', '--features', 'std,ecdsa'],
    ]
    environment = dict(os.environ)
    environment['CARGO_BUILD_JOBS'] = '2'
    environment['CARGO_PROFILE_RELEASE_OPT_LEVEL'] = '3'
    environment['CARGO_PROFILE_RELEASE_DEBUG_ASSERTIONS'] = 'false'
    results = []
    for index, command in enumerate(commands):
        argv = ['cargo'] + command + ['--release', '--manifest-path', str(work / 'Cargo.toml')]
        log = work / ('test-' + str(index + 1) + '.log')
        with log.open('w') as handle:
            result = subprocess.run(argv, env=environment, stdout=handle, stderr=subprocess.STDOUT)
        results.append({'argv': argv, 'exit_code': result.returncode, 'log': str(log)})
        print(json.dumps(results[-1]), flush=True)
        if result.returncode:
            break
    rejected_features = []
    if len(results) == len(commands) and all(r['exit_code'] == 0 for r in results):
        for feature in ['crypto', 'dsa', 'ed25519', 'p256', 'p384', 'p521', 'rsa']:
            argv = ['cargo', 'check', '-p', 'ssh-key-fork-arti', '--features', feature,
                    '--manifest-path', str(work / 'Cargo.toml')]
            rejected = subprocess.run(argv, env=environment, capture_output=True, text=True)
            log = work / ('rejected-feature-' + feature + '.log')
            log.write_text(rejected.stdout + rejected.stderr)
            expected_failure = rejected.returncode != 0 and (
                'does not have' in rejected.stderr or 'does not contain this feature' in rejected.stderr
            )
            rejected_features.append({'feature': feature, 'argv': argv,
                                      'exit_code': rejected.returncode,
                                      'rejected_by_cargo': expected_failure, 'log': str(log)})
    # A graph test must use a platform filter and normal/build edges; optional
    # metadata edges alone overstate the RSA/EC packages actually compiled.
    tree_argv = ['cargo', 'tree', '--manifest-path', str(work / 'Cargo.toml'),
                 '--target', 'aarch64-unknown-linux-gnu', '--edges', 'normal,build', '--prefix', 'none']
    tree = subprocess.run(tree_argv, env=environment, capture_output=True, text=True)
    (work / 'linux-tree.log').write_text(tree.stdout + tree.stderr)
    rsa_present = any(line.startswith('rsa v') for line in tree.stdout.splitlines())
    stable = all(sha(third_party / path) == digest for path, digest in hashes.items())
    summary = {
        'scope': 'five source-linked Arti/SSH client forks; no installed application claim',
        'profile': 'release',
        'opt_level': 3,
        'debug_assertions': False,
        'input_root_lock_sha256': lock_hash,
        'resolved_fixture_lock_sha256': sha(work / 'Cargo.lock'),
        'source_files_sha256': hashes,
        'source_unchanged_during_tests': stable,
        'tests': results,
        'unsupported_asymmetric_features': rejected_features,
        'linux_tree_argv': tree_argv,
        'linux_tree_exit_code': tree.returncode,
        'rsa_present_in_linux_fixture_normal_build_graph': rsa_present,
        'passed': len(results) == len(commands) and all(r['exit_code'] == 0 for r in results)
                  and len(rejected_features) == 7 and all(r['rejected_by_cargo'] for r in rejected_features)
                  and stable and tree.returncode == 0 and not rsa_present,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(summary, indent=2) + '\n')
    return 0 if summary['passed'] else 1


if __name__ == '__main__':
    sys.exit(main())
