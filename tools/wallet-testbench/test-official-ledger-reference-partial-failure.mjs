import assert from 'node:assert/strict';
import {mkdtemp, readdir, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const wrapper = resolve(here, 'run-official-ledger-cli-reference-sync.mjs');
const reportRoot = resolve(root, 'build/wallet-testbench/ledger-reference-reports');

function run(command, args, env) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {cwd: root, env, stdio: ['ignore', 'pipe', 'pipe']});
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', chunk => stdout.push(chunk));
    child.stderr.on('data', chunk => stderr.push(chunk));
    child.on('error', rejectRun);
    child.on('close', code => resolveRun({
      code,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
    }));
  });
}

test('a post-scan Ledger failure retains only allow-listed partial metrics', async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'tex8-reference-partial-'));
  const fakeRunner = join(temporaryRoot, 'safe-failure-runner.mjs');
  const before = new Set(await readdir(reportRoot));
  let createdReport;
  try {
    const safeFailureOutput = [
      'reference_sync_completed=false',
      'reference_sync_failure_stage=key-images',
      'reference_sync_partial_metrics_available=true',
      'reference_ledger_ble_discovery_requested=false',
      'reference_ledger_hardware_wallet_create_ms=1',
      'reference_sync_elapsed_ms=10',
      'reference_sync_blocks=20',
      'reference_sync_transport_starts=1',
      'reference_sync_payload_bytes=30',
      'reference_sync_network_bytes=40',
      'reference_sync_grpc_framed_bytes=50',
      'reference_sync_block_fetch_ms=6',
      'reference_sync_client_scan_ms=7',
      'reference_key_image_elapsed_ms=8',
      'reference_sync_failure_class=ledger-key-image-operation-failed',
    ].join('\n');
    const fakeRunnerSource = [
      '#!/usr/bin/env node',
      `process.stdout.write(${JSON.stringify(`${safeFailureOutput}\n`)});`,
      'process.exitCode = 1;',
    ].join('\n');
    await writeFile(fakeRunner, fakeRunnerSource, {encoding: 'utf8', mode: 0o700});
    const result = await run(process.execPath, [wrapper], {
      ...process.env,
      TESTBENCH_REFERENCE_LEDGER_RUNNER: fakeRunner,
      // This fixture exercises post-scan parser behavior. Select BLE so the
      // macOS USB Ledger preflight cannot replace the fake native result.
      TESTBENCH_REFERENCE_DEVICE: 'Ledger:ble',
    });
    assert.equal(result.code, 1);
    assert.equal(result.stdout, 'official_ledger_reference_sync=failed\n');
    assert.equal(result.stderr, '');

    const created = (await readdir(reportRoot)).filter(file => !before.has(file));
    assert.equal(created.length, 1);
    createdReport = join(reportRoot, created[0]);
    const report = JSON.parse(await readFile(createdReport, 'utf8'));
    assert.equal(report.failure, 'ledger-key-image-operation-failed');
    assert.equal(report.failure_stage, 'key-images');
    assert.equal(report.reference_metrics_available, true);
    assert.equal(report.reference_sync.completed, false);
    assert.equal(report.reference_sync.key_image_elapsed_ms, '8');
    assert.equal(report.reference_sync.key_images, null);
    assert.equal(report.reference_sync.downloaded_blocks_during_key_images, null);
    assert.equal(report.reference_sync.rates.key_image_derivations_per_second, null);
    assert.doesNotMatch(JSON.stringify(report), /privateViewKey|seed|txid|address|credential/i);
  } finally {
    if (createdReport) await rm(createdReport, {force: true});
    await rm(temporaryRoot, {recursive: true, force: true});
  }
});
