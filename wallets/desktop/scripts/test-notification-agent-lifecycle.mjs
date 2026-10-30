import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
for (const [label, source] of [
  ['Windows interactive task, safe migration ownership, Unicode and update identity', 'windows_notification_task.rs'],
  ['Linux transitive ldd closure, stable paths and systemd argument escaping', 'linux_notification_install.rs'],
]) {
  test(label, () => {
    const temporary = mkdtempSync(join(tmpdir(), 'mfw-agent-contract-'));
    try {
      const binary = join(temporary, process.platform === 'win32' ? 'contract.exe' : 'contract');
      const compile = spawnSync('rustc', ['--edition=2021', '--test', resolve(root, 'src-tauri/src', source), '-o', binary], { encoding: 'utf8' });
      assert.equal(compile.status, 0, compile.stderr || compile.error?.message);
      const result = spawnSync(binary, [], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.match(result.stdout, /test result: ok/);
    } finally { rmSync(temporary, { recursive: true, force: true }); }
  });
}
