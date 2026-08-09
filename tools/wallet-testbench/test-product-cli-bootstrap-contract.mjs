#!/usr/bin/env node

import assert from 'node:assert/strict';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, '..', '..');
const patchDirectory = join(repositoryRoot, 'third_party', 'monero-patches');
const series = readFileSync(join(patchDirectory, 'series'), 'utf8')
  .split(/\r?\n/)
  .filter(line => line && !line.startsWith('#'));
const lock = readFileSync(join(patchDirectory, 'upstream.lock'), 'utf8');
const expectedTree = lock.match(/^patched_tree=([0-9a-f]{40})$/m)?.[1];
const expectedBase = lock.match(/^upstream_commit=([0-9a-f]{40})$/m)?.[1];
const expectedBaseTree = lock.match(/^upstream_tree=([0-9a-f]{40})$/m)?.[1];

const cliPatchName = '0035-wallet-cli-add-product-entrypoint-and-debug-bootstrap.patch';
const productCorePatchName = '0036-wallet-cli-link-shared-product-core-ABI.patch';
const appVaultPatchName = '0037-wallet-cli-add-shared-app-vault-commands.patch';
for (const requiredPatch of [cliPatchName, productCorePatchName, appVaultPatchName]) {
  assert(series.includes(requiredPatch), `required product CLI patch is missing: ${requiredPatch}`);
}
assert(
  series.indexOf(cliPatchName) < series.indexOf(productCorePatchName) &&
    series.indexOf(productCorePatchName) < series.indexOf(appVaultPatchName),
  'product CLI, Product-Core, and AppVault patches are out of order',
);
assert.match(expectedTree ?? '', /^[0-9a-f]{40}$/, 'patched tree pin is invalid');
assert.equal(expectedBase, 'dbcc7d212c094bd1a45f7291dbb99a4b4627a96d');
assert.equal(expectedBaseTree, 'c592d864569be294d2bdca25b674cd17f78614e5');

const appVaultPatch = readFileSync(join(patchDirectory, appVaultPatchName), 'utf8');
const patch = readFileSync(join(patchDirectory, productCorePatchName), 'utf8');
const cliPatch = readFileSync(join(patchDirectory, cliPatchName), 'utf8');
const pairBuildScript = readFileSync(
  join(repositoryRoot, 'tools', 'monero-upstream', 'build-cli-pair.sh'),
  'utf8',
);
for (const contract of [
  /monero_add_executable\(fastwallet/,
  /OUTPUT_NAME "monero-fast-wallet-cli"/,
  /MONERO_FAST_WALLET_PRODUCT_CLI=1/,
  /GRPCPP_STATIC_LIBRARIES/,
  /--debug-level/,
  /debug-events\.jsonl/,
  /official_monero_upstream_commit/,
  /feature_manifest_hash/,
]) {
  assert.match(cliPatch, contract);
}
for (const contract of [
  /MFW_PRODUCT_CORE_ROOT/,
  /mfw_product_core_abi_version/,
  /mfw_product_core_schema_sha256/,
  /mfw_product_core_diagnostic_registry_sha256/,
]) {
  assert.match(patch, contract);
}
for (const contract of [
  /status \[--json\]/,
  /setup --password-file/,
  /unlock --password-file/,
  /options\.operation == "lock"/,
  /timeout --seconds/,
  /reset-local --confirm-reset/,
  /testbench \[--json\]/,
  /--password-file/,
  /mfw_app_vault_password_verifier_validate_v1/,
  /mfw_app_vault_wallet_switch_allowed_v1/,
  /mfw_app_vault_warmup_batch_v1/,
  /mfw_app_vault_step_up_issue_v1/,
  /mfw_app_vault_step_up_consume_v1/,
]) {
  assert.match(appVaultPatch, contract);
}
for (const contract of [
  /pkg-config --modversion protobuf/,
  /Protobuf mismatch:/,
  /-U '\*GRPC\*'/,
  /-U '\*PROTOBUF\*'/,
  /monero-core-macos-arm64-toolchain\.cmake/,
  /product_core_runtime_name/,
  /libmfw_product_core\.dylib/,
  /libmfw_product_core\.so/,
]) {
  assert.match(pairBuildScript, contract);
}

const productBinary = process.env.MFW_PRODUCT_CLI_BINARY;
const originalBinary = process.env.MFW_ORIGINAL_CLI_BINARY;
let runtime = null;

if (productBinary) {
  assert(existsSync(productBinary), `product CLI is missing: ${productBinary}`);
  if (process.platform === 'darwin') {
    assert(existsSync(join(dirname(productBinary), 'libmfw_product_core.dylib')));
  }
  const versionRun = spawnSync(productBinary, ['version', '--json'], {encoding: 'utf8'});
  assert.equal(versionRun.status, 0, versionRun.stderr);
  const version = JSON.parse(versionRun.stdout);
  assert.equal(version.product, 'monero-fast-wallet-cli');
  assert.equal(version.official_monero_upstream_commit, expectedBase);
  assert.equal(version.official_monero_upstream_tree, expectedBaseTree);
  assert.equal(version.patched_monero_tree, expectedTree);
  assert.equal(version.patch_count, series.length);
  assert.equal(version.product_core_abi, 1);
  assert.match(version.product_core_schema_sha256, /^[0-9a-f]{64}$/);
  assert.match(version.diagnostic_registry_sha256, /^[0-9a-f]{64}$/);
  assert.match(version.app_vault_state_schema_sha256, /^[0-9a-f]{64}$/);
  assert.match(version.product_commit, /^[0-9a-f]{40}$/);
  assert.match(version.feature_manifest_hash, /^[0-9a-f]{64}$/);
  assert.equal(typeof version.product_dirty, 'boolean');
  for (const field of ['cuprate_commit', 'scanpack_schema', 'product_core_abi', 'build_target', 'compiler', 'compiler_flags']) {
    assert.notEqual(version[field], undefined, `missing provenance: ${field}`);
    assert.notEqual(version[field], 'unknown', `unknown provenance: ${field}`);
  }

  const helpRun = spawnSync(productBinary, ['--help'], {encoding: 'utf8'});
  assert.equal(helpRun.status, 0, helpRun.stderr);
  for (const option of ['--debug', '--debug-level', '--debug-output', '--debug-format', '--debug-retention']) {
    assert(helpRun.stdout.includes(option), `help omits ${option}`);
  }

  const invalidRun = spawnSync(productBinary, ['--debug', '--debug-level', 'invalid'], {encoding: 'utf8'});
  assert.notEqual(invalidRun.status, 0, 'invalid debug level must fail');

  const artifactDirectory = process.env.MFW_CLI_TESTBENCH_OUTPUT
    ? resolve(process.env.MFW_CLI_TESTBENCH_OUTPUT)
    : mkdtempSync(join(tmpdir(), 'mfw-cli-bootstrap-'));
  const failedRun = spawnSync(productBinary, [
    '--debug',
    '--debug-output', artifactDirectory,
    '--wallet-file', join(artifactDirectory, 'missing-wallet'),
    'status',
  ], {encoding: 'utf8'});
  assert.notEqual(failedRun.status, 0, 'missing wallet must fail');
  const requiredArtifacts = [
    'debug-environment.json',
    'debug-manifest.json',
    'debug-summary.json',
    'debug-events.jsonl',
    'debug-text.log',
  ];
  for (const artifact of requiredArtifacts) {
    assert(existsSync(join(artifactDirectory, artifact)), `missing artifact: ${artifact}`);
  }
  const summary = JSON.parse(readFileSync(join(artifactDirectory, 'debug-summary.json'), 'utf8'));
  const events = readFileSync(join(artifactDirectory, 'debug-events.jsonl'), 'utf8')
    .trim().split('\n').map(JSON.parse);
  assert.equal(summary.status, 'failed');
  assert(events.some(event => event.status === 'failed'));
  assert.equal(events.at(-1).phase, 'process_end');
  assert.equal(events.at(-1).status, 'failed');
  for (let index = 1; index < events.length; index += 1) {
    assert.equal(events[index].event_sequence, events[index - 1].event_sequence + 1);
  }
  const serializedEvents = JSON.stringify(events).toLowerCase();
  for (const forbidden of ['seed phrase', 'private spend key', 'private view key', 'wallet password']) {
    assert(!serializedEvents.includes(forbidden), `debug artifact contains forbidden field: ${forbidden}`);
  }
  for (const [format, required, forbidden] of [
    ['jsonl', 'debug-events.jsonl', 'debug-text.log'],
    ['text', 'debug-text.log', 'debug-events.jsonl'],
  ]) {
    const formatDirectory = mkdtempSync(join(tmpdir(), `mfw-cli-${format}-`));
    const formatRun = spawnSync(productBinary, [
      '--debug', '--debug-format', format, '--debug-output', formatDirectory,
      '--wallet-file', join(formatDirectory, 'missing-wallet'), 'status',
    ], {encoding: 'utf8'});
    assert.notEqual(formatRun.status, 0);
    assert(existsSync(join(formatDirectory, required)), `${format} omits ${required}`);
    assert(!existsSync(join(formatDirectory, forbidden)), `${format} wrote ${forbidden}`);
  }

  const appVaultDirectory = mkdtempSync(join(tmpdir(), 'mfw-cli-app-vault-'));
  const passwordFile = join(appVaultDirectory, 'password.txt');
  const wrongPasswordFile = join(appVaultDirectory, 'wrong-password.txt');
  writeFileSync(passwordFile, 'correct horse battery staple\n', {mode: 0o600});
  writeFileSync(wrongPasswordFile, 'incorrect horse battery staple\n', {mode: 0o600});
  chmodSync(passwordFile, 0o600);
  chmodSync(wrongPasswordFile, 0o600);
  const appRun = (operation, args = []) => spawnSync(productBinary, [
    'app', operation, '--app-data-dir', appVaultDirectory, ...args,
  ], {encoding: 'utf8'});
  const setupStarted = performance.now();
  const setupRun = appRun('setup', ['--password-file', passwordFile, '--json']);
  const setupMs = performance.now() - setupStarted;
  assert.equal(setupRun.status, 0, setupRun.stderr);
  const stateFile = join(appVaultDirectory, 'app-vault-state-v1.bin');
  assert(existsSync(stateFile), 'AppVault setup omitted its committed state');
  if (process.platform !== 'win32') {
    assert.equal(statSync(stateFile).mode & 0o077, 0, 'AppVault state is not private');
  }
  writeFileSync(`${stateFile}.tmp`, 'interrupted generation', {mode: 0o600});
  const statusStarted = performance.now();
  const statusRun = appRun('status', ['--json']);
  const statusMs = performance.now() - statusStarted;
  assert.equal(statusRun.status, 0, statusRun.stderr);
  const appStatus = JSON.parse(statusRun.stdout);
  assert.equal(appStatus.configured, true);
  assert.equal(appStatus.session_authorized, false);
  assert.equal(appStatus.protection_mode, 'password');
  assert.equal(appStatus.auto_lock_seconds, 1800);
  assert.equal(appStatus.app_vault_state_schema_sha256, version.app_vault_state_schema_sha256);
  assert(statusMs < 1000, `AppVault status unexpectedly took ${statusMs.toFixed(3)} ms`);

  const unlockStarted = performance.now();
  const unlockRun = appRun('unlock', ['--password-file', passwordFile, '--json']);
  const unlockMs = performance.now() - unlockStarted;
  assert.equal(unlockRun.status, 0, unlockRun.stderr);
  assert.deepEqual(JSON.parse(unlockRun.stdout), {
    schema_version: 1,
    unlocked: true,
    scope: 'all-wallets',
  });
  const timeoutRun = appRun('timeout', [
    '--seconds', '300', '--password-file', passwordFile, '--json',
  ]);
  assert.equal(timeoutRun.status, 0, timeoutRun.stderr);
  assert.equal(JSON.parse(timeoutRun.stdout).auto_lock_seconds, 300);

  const testbenchRun = appRun('testbench', ['--json']);
  assert.equal(testbenchRun.status, 0, testbenchRun.stderr);
  const appTestbench = JSON.parse(testbenchRun.stdout);
  assert.equal(appTestbench.wallet_switches, 100);
  assert.equal(appTestbench.prompts, 0);
  assert.equal(appTestbench.network_calls, 0);
  assert.equal(appTestbench.non_destructive_failures, 10);
  assert.equal(appTestbench.migration_boundaries, 5);
  assert.equal(appTestbench.step_up_single_use, true);
  assert.equal(appTestbench.warmup_wallets, 100);
  assert(appTestbench.maximum_warmup_concurrency <= 4);

  const wrongUnlockRun = appRun('unlock', ['--password-file', wrongPasswordFile, '--json']);
  assert.notEqual(wrongUnlockRun.status, 0, 'wrong password must fail');
  assert(existsSync(stateFile), 'wrong password deleted AppVault state');
  const backedOffStatus = JSON.parse(appRun('status', ['--json']).stdout);
  assert.equal(backedOffStatus.failed_attempts, 1);
  assert.equal(backedOffStatus.presentation, 'backoff');

  const corruptDirectory = mkdtempSync(join(tmpdir(), 'mfw-cli-app-vault-corrupt-'));
  const corruptState = join(corruptDirectory, 'app-vault-state-v1.bin');
  copyFileSync(stateFile, corruptState);
  const corruptBytes = readFileSync(corruptState);
  corruptBytes[0] ^= 0xff;
  writeFileSync(corruptState, corruptBytes, {mode: 0o600});
  const corruptRun = spawnSync(productBinary, [
    'app', 'status', '--app-data-dir', corruptDirectory, '--json',
  ], {encoding: 'utf8'});
  assert.notEqual(corruptRun.status, 0, 'corrupt AppVault state must fail closed');

  const resetDirectory = mkdtempSync(join(tmpdir(), 'mfw-cli-app-vault-reset-'));
  mkdirSync(resetDirectory, {recursive: true, mode: 0o700});
  const resetPassword = join(resetDirectory, 'password.txt');
  writeFileSync(resetPassword, 'correct horse battery staple\n', {mode: 0o600});
  const resetSetup = spawnSync(productBinary, [
    'app', 'setup', '--app-data-dir', resetDirectory,
    '--password-file', resetPassword, '--json',
  ], {encoding: 'utf8'});
  assert.equal(resetSetup.status, 0, resetSetup.stderr);
  const resetRun = spawnSync(productBinary, [
    'app', 'reset-local', '--app-data-dir', resetDirectory,
    '--confirm-reset', '--password-file', resetPassword, '--json',
  ], {encoding: 'utf8'});
  assert.equal(resetRun.status, 0, resetRun.stderr);
  assert(!existsSync(join(resetDirectory, 'app-vault-state-v1.bin')));

  runtime = {
    version,
    failedRunExit: failedRun.status,
    events: events.length,
    durationMs: summary.duration_ms,
    artifactDirectory,
    appVault: {
      setupMs,
      statusMs,
      unlockMs,
      switches: appTestbench.wallet_switches,
      switchTestbenchElapsedNs: appTestbench.elapsed_ns,
      prompts: appTestbench.prompts,
      networkCalls: appTestbench.network_calls,
      migrationBoundaries: appTestbench.migration_boundaries,
      nonDestructiveFailures: appTestbench.non_destructive_failures,
    },
  };
}

if (originalBinary) {
  assert(existsSync(originalBinary), `original CLI is missing: ${originalBinary}`);
  const originalVersion = spawnSync(originalBinary, ['--version'], {encoding: 'utf8'});
  assert.equal(originalVersion.status, 0, originalVersion.stderr);
  assert.match(originalVersion.stdout, /Monero/);
  assert(!originalVersion.stdout.includes('monero-fast-wallet-cli'));
  const originalHelp = spawnSync(originalBinary, ['--help'], {encoding: 'utf8'});
  assert.equal(originalHelp.status, 0, originalHelp.stderr);
  assert(!originalHelp.stdout.includes('--debug-level'));
  assert(!originalHelp.stdout.includes('--debug-output'));
}

process.stdout.write(`${JSON.stringify({
  ok: true,
  patchCount: series.length,
  patchedTree: expectedTree,
  runtime,
})}\n`);
