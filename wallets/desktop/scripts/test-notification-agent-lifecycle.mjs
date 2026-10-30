import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
test('Tauri binary discovery contains executable entrypoints rather than module directories', () => {
  const binaries = resolve(root, 'src-tauri/src/bin');
  for (const entry of readdirSync(binaries, { withFileTypes: true })) {
    assert.ok(
      (entry.isFile() && entry.name.endsWith('.rs'))
        || (entry.isDirectory() && existsSync(join(binaries, entry.name, 'main.rs'))),
      `${entry.name} is not an executable entrypoint; keep private Rust modules outside src/bin`,
    );
  }
});
for (const [label, source] of [
  ['Windows interactive task, safe migration ownership, Unicode and update identity', 'windows_notification_task.rs'],
  ['Linux transitive ldd closure, stable paths and systemd argument escaping', 'linux_notification_install.rs'],
]) {
  test(label, {
    skip: process.platform === 'win32' && source === 'linux_notification_install.rs'
      ? 'POSIX paths require Unix std::path semantics; this suite is not applicable on Windows.'
      : false,
  }, () => {
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
