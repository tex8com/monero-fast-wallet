#!/usr/bin/env python3
"""Exercise public renewal checks and publish/recovery faults with synthetic keys.

All command stubs and files live in TemporaryDirectory; no SSH, services, real
Worker keys or /etc files are accessed. Requires OpenSSL with Ed25519 support.
"""
import hashlib
import json
import os
from pathlib import Path
import shutil
import struct
import subprocess
import sys
import tempfile
import time
import unittest

SCRIPT = Path(sys.argv.pop(1)) if len(sys.argv) > 1 and not sys.argv[1].startswith('-') else Path(__file__).resolve().parents[1] / 'deploy' / 'activate-renewed-worker-descriptor.sh'
OPENSSL = os.environ.get('MFW_TEST_OPENSSL') or next((str(p) for p in (Path('/opt/homebrew/opt/openssl@3/bin/openssl'), Path('/usr/bin/openssl')) if p.exists()), 'openssl')
REAL_PYTHON = sys.executable

STUB = r'''import json, os, pathlib, shutil, sys, tempfile
root = pathlib.Path(os.environ['MFW_RENEW_TEST_ROOT'])
name = pathlib.Path(sys.argv[0]).name
args = sys.argv[1:]
mode = os.environ.get('MFW_RENEW_TEST_MODE', '')
gateway = '/etc/monero-fast-wallet/worker-descriptor.hex'
worker = '/etc/monero-fast-wallet/worker-descriptor-worker.hex'
def mapped(value):
    if value == gateway: return root / 'installed-gateway.hex'
    if value == worker: return root / 'installed-worker.hex'
    path = pathlib.Path(value)
    if not path.is_relative_to(root): raise RuntimeError('stub refused non-test path')
    return path
with (root / 'events').open('a') as log: log.write(json.dumps([name] + args) + '\n')
if name == 'id': print('0')
elif name == 'python3':
    replaced = [str(mapped(a)) if a in (gateway, worker) else a for a in args]
    os.execv(os.environ['MFW_RENEW_REAL_PYTHON'], [os.environ['MFW_RENEW_REAL_PYTHON']] + replaced)
elif name == 'mktemp':
    if args[-1].startswith('/var/backups/'):
        path = root / 'backup'; path.mkdir(); print(path)
    else:
        fd, path = tempfile.mkstemp(prefix='stage-', dir=root); os.close(fd); print(path)
elif name == 'install':
    source, target = args[-2:]
    restoring = '/backup/' in source
    if mode == 'stage-failure' and not restoring and source.endswith('renewed.hex') and (root / 'staged-once').exists(): sys.exit(9)
    if mode == 'recovery-failure' and restoring and source.endswith('/worker-descriptor.hex'): sys.exit(9)
    shutil.copyfile(mapped(source), mapped(target))
    if source.endswith('renewed.hex'): (root / 'staged-once').touch()
elif name == 'mv':
    source, target = args[-2:]
    if mode in ('second-rename-failure', 'recovery-failure') and target == worker and not (root / 'fault-fired').exists():
        (root / 'fault-fired').touch(); sys.exit(9)
    os.replace(mapped(source), mapped(target))
elif name == 'rm':
    for arg in args:
        if not arg.startswith('-'): mapped(arg).unlink(missing_ok=True)
elif name == 'systemctl': pass
elif name == 'sleep': pass
elif name == 'curl':
    if mode == 'health-failure': sys.exit(22)
    print(json.dumps({'workerDescriptor': (root / 'renewed.hex').read_text().strip()}))
else: raise RuntimeError('unknown stub')
'''


class RenewalTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='mfw-renewal-test.')
        self.root = Path(self.temporary.name)
        self.openssl('genpkey', '-algorithm', 'ED25519', '-out', str(self.root / 'synthetic.key'))
        der = self.openssl('pkey', '-in', str(self.root / 'synthetic.key'), '-pubout', '-outform', 'DER')
        self.public = der[-32:]
        self.now = int(time.time())
        self.old = self.descriptor(self.now - 41 * 86400)
        self.new = self.descriptor(self.now)
        (self.root / 'installed-gateway.hex').write_text(self.old.hex() + '\n')
        (self.root / 'installed-worker.hex').write_text(self.old.hex() + '\n')
        self.stub_dir = self.root / 'bin'
        self.stub_dir.mkdir()
        for name in ('id', 'python3', 'mktemp', 'install', 'mv', 'rm', 'systemctl', 'curl', 'sleep'):
            stub = self.stub_dir / name
            stub.write_text('#!' + REAL_PYTHON + '\n' + STUB)
            stub.chmod(0o755)

    def tearDown(self):
        self.temporary.cleanup()

    def openssl(self, *args):
        return subprocess.run([OPENSSL, *args], check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE).stdout

    def descriptor(self, issued, *, network=0, root=None, online=None, hpke=None, origin=b'https://xmr.tex8.com', lifetime=30 * 86400):
        body = b'TX8WD001' + struct.pack('>HBBQQ', 1, network, 0, issued, issued + lifetime)
        body += root or self.public
        body += online or hashlib.sha256(b'synthetic-online').digest()
        body += hpke or hashlib.sha256(b'synthetic-hpke').digest()
        body += struct.pack('>H', len(origin)) + origin
        (self.root / 'message').write_bytes(body)
        self.openssl('pkeyutl', '-sign', '-rawin', '-inkey', str(self.root / 'synthetic.key'), '-in', str(self.root / 'message'), '-out', str(self.root / 'signature'))
        return body + (self.root / 'signature').read_bytes()

    def run_activation(self, descriptor=None, mode=''):
        (self.root / 'renewed.hex').write_text((descriptor if descriptor is not None else self.new).hex() + '\n')
        env = dict(os.environ, MFW_RENEW_TEST_ROOT=str(self.root), MFW_RENEW_TEST_MODE=mode, MFW_RENEW_REAL_PYTHON=REAL_PYTHON)
        env['PATH'] = str(self.stub_dir) + os.pathsep + str(Path(OPENSSL).parent) + os.pathsep + env['PATH']
        return subprocess.run(['bash', str(SCRIPT), str(self.root / 'renewed.hex')], env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=15)

    def events(self):
        return [json.loads(line) for line in (self.root / 'events').read_text().splitlines()]

    def assert_installed(self, gateway, worker):
        self.assertEqual((self.root / 'installed-gateway.hex').read_text().strip(), gateway.hex())
        self.assertEqual((self.root / 'installed-worker.hex').read_text().strip(), worker.hex())

    def test_valid_renewal_accepts_expired_old_and_preserves_exact_identity(self):
        result = self.run_activation()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assert_installed(self.new, self.new)
        self.assertIn('Public Worker renewal verified', result.stdout)
        self.assertEqual((self.root / 'backup' / 'worker-descriptor.hex').read_text().strip(), self.old.hex())

    def test_identity_network_and_origin_changes_fail_before_mutation(self):
        for change in ({'root': b'\x01' * 32}, {'online': b'\x02' * 32}, {'hpke': b'\x03' * 32}, {'network': 1}, {'origin': b'https://changed.example'}):
            with self.subTest(change=next(iter(change))):
                result = self.run_activation(self.descriptor(self.now, **change))
                self.assertNotEqual(result.returncode, 0)
                self.assert_installed(self.old, self.old)
                self.assertFalse(any(e[0] in ('install', 'mv', 'systemctl') for e in self.events()))

    def test_invalid_signature_structure_lifetime_and_freshness_fail_closed(self):
        bad_signature = self.new[:-1] + bytes([self.new[-1] ^ 1])
        for candidate in (bad_signature, self.new[:-1], self.new + b'\0', self.descriptor(self.now, lifetime=31 * 86400), self.descriptor(self.now - 600), self.descriptor(self.now + 600)):
            result = self.run_activation(candidate)
            self.assertNotEqual(result.returncode, 0)
            self.assert_installed(self.old, self.old)
            self.assertFalse(any(e[0] in ('install', 'mv', 'systemctl') for e in self.events()))

    def test_disagreeing_installed_public_descriptors_fail_before_mutation(self):
        (self.root / 'installed-worker.hex').write_text(self.new.hex() + '\n')
        result = self.run_activation()
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(any(e[0] in ('install', 'mv', 'systemctl') for e in self.events()))

    def test_second_rename_failure_restores_both_descriptors(self):
        result = self.run_activation(mode='second-rename-failure')
        self.assertNotEqual(result.returncode, 0)
        self.assert_installed(self.old, self.old)
        self.assertIn('incomplete=false', result.stderr)
        self.assertTrue(any(e[0] == 'systemctl' and e[1] == 'restart' for e in self.events()))

    def test_health_failure_restores_both_descriptors(self):
        result = self.run_activation(mode='health-failure')
        self.assertNotEqual(result.returncode, 0)
        self.assert_installed(self.old, self.old)
        self.assertIn('backup:', result.stderr)
        curl = next(e for e in self.events() if e[0] == 'curl')
        self.assertIn('--max-time', curl)

    def test_stage_failure_never_changes_installed_descriptors(self):
        result = self.run_activation(mode='stage-failure')
        self.assertNotEqual(result.returncode, 0)
        self.assert_installed(self.old, self.old)
        self.assertFalse(any(e[0] == 'mv' for e in self.events()))

    def test_incomplete_recovery_attempts_other_file_and_reports_backup(self):
        result = self.run_activation(mode='recovery-failure')
        self.assertNotEqual(result.returncode, 0)
        self.assert_installed(self.new, self.old)
        self.assertIn('incomplete=true', result.stderr)
        self.assertTrue(any(e[0] == 'install' and e[-2].endswith('/backup/worker-descriptor-worker.hex') for e in self.events()))


if __name__ == '__main__':
    unittest.main(verbosity=2)
