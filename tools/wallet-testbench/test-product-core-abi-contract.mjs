#!/usr/bin/env node

import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const coreRoot = join(repositoryRoot, 'native', 'product-core');
const schema = JSON.parse(readFileSync(join(coreRoot, 'schema', 'mfw-product-core.v1.json'), 'utf8'));
const registry = JSON.parse(readFileSync(join(coreRoot, 'schema', 'diagnostic-registry.v1.json'), 'utf8'));
const diagnosticResult = JSON.parse(readFileSync(join(coreRoot, 'schema', 'diagnostic-result.v1.json'), 'utf8'));
const diagnosticAdapters = JSON.parse(readFileSync(join(coreRoot, 'schema', 'diagnostic-adapters.v1.json'), 'utf8'));
const appVaultState = JSON.parse(readFileSync(join(coreRoot, 'schema', 'app-vault-state-machine.v1.json'), 'utf8'));
const vector = JSON.parse(readFileSync(join(coreRoot, 'test-vectors', 'abi-event-v1.json'), 'utf8'));
const outputs = [
  'generated/c/mfw_product_core_contract.h',
  'generated/rust/mfw_product_core_contract.rs',
  'generated/typescript/mfwProductCoreContract.ts',
  'generated/typescript/mfwDiagnosticRegistry.ts',
  'generated/typescript/mfwAppVaultContract.ts',
  'generated/kotlin/MfwProductCoreContract.kt',
  'generated/kotlin/MfwAppVaultContract.kt',
  'generated/swift/MfwProductCoreContract.swift',
  'generated/swift/MfwAppVaultContract.swift',
  'test-vectors/abi-event-v1.json',
];
const generatedMirrors = [
  ['generated/typescript/mfwProductCoreContract.ts', 'apps/mobile/src/generated/mfwProductCoreContract.ts'],
  ['generated/typescript/mfwProductCoreContract.ts', 'apps/desktop/src/generated/mfwProductCoreContract.ts'],
  ['generated/kotlin/MfwProductCoreContract.kt', 'apps/mobile/android/app/src/main/java/com/monerowallet/productcore/MfwProductCoreContract.kt'],
  ['generated/typescript/mfwDiagnosticRegistry.ts', 'packages/wallet-shared/src/generated/mfwDiagnosticRegistry.ts'],
  ['generated/typescript/mfwAppVaultContract.ts', 'packages/wallet-shared/src/generated/mfwAppVaultContract.ts'],
  ['generated/kotlin/MfwAppVaultContract.kt', 'apps/mobile/android/app/src/main/java/com/monerowallet/productcore/MfwAppVaultContract.kt'],
];
const contractBindings = [
  'generated/c/mfw_product_core_contract.h',
  'generated/rust/mfw_product_core_contract.rs',
  'generated/typescript/mfwProductCoreContract.ts',
  'generated/kotlin/MfwProductCoreContract.kt',
  'generated/swift/MfwProductCoreContract.swift',
];

function hashFile(relative) {
  return createHash('sha256').update(readFileSync(join(coreRoot, relative))).digest('hex');
}

const before = Object.fromEntries(outputs.map(output => [output, hashFile(output)]));
const generate = spawnSync(process.execPath, [join(coreRoot, 'scripts', 'generate-bindings.mjs')], {
  cwd: repositoryRoot,
  encoding: 'utf8',
});
assert.equal(generate.status, 0, generate.stderr);
const generation = JSON.parse(generate.stdout);
const after = Object.fromEntries(outputs.map(output => [output, hashFile(output)]));
assert.deepEqual(after, before, 'binding generation must be byte deterministic');
for (const [source, mirror] of generatedMirrors) {
  assert.deepEqual(
    readFileSync(join(coreRoot, source)),
    readFileSync(join(repositoryRoot, mirror)),
    `${mirror} must be generated from the same product-core schema`,
  );
}

assert.equal(schema.schemaVersion, 1);
assert.equal(schema.abiVersion, 1);
assert.equal(schema.eventSchemaVersion, 1);
assert.equal(vector.abiVersion, schema.abiVersion);
assert.equal(vector.schemaSha256, generation.schemaSha256);
assert.equal(vector.diagnosticRegistrySha256, generation.diagnosticRegistrySha256);
assert.equal(vector.diagnosticResultSchemaSha256, generation.diagnosticResultSchemaSha256);
assert.equal(vector.diagnosticAdaptersSha256, generation.diagnosticAdaptersSha256);
assert.equal(vector.appVaultStateSchemaSha256, generation.appVaultStateSchemaSha256);
assert.equal(appVaultState.defaultAutoLockSeconds, 1800);
assert.deepEqual(appVaultState.autoLockSeconds, [0, 60, 300, 900, 1800, 3600]);
assert.equal(appVaultState.password.requiredAsRecoveryForSystemAuth, true);
assert.deepEqual(appVaultState.password.kdf, {
  algorithm: 'argon2id',
  version: 19,
  memoryKiB: 65536,
  iterations: 3,
  parallelism: 1,
  saltBytes: 16,
  digestBytes: 32,
});
assert.equal(Buffer.from(vector.encodedHex, 'hex').length, 136);
assert.equal(registry.tests.length, 19);
assert.equal(new Set(registry.tests.map(test => test.id)).size, registry.tests.length);

const forbidden = new Set(schema.forbiddenFields);
for (const field of schema.eventFields) {
  assert(!forbidden.has(field), `event schema exposes forbidden field: ${field}`);
}
for (const required of [
  'monotonic_timestamp_ns_raw',
  'process_session_id',
  'run_id',
  'operation_id',
  'parent_operation_id',
  'wallet_pseudonym',
  'sanitized_metrics',
  'error_code',
]) assert(schema.eventFields.includes(required), `missing event field: ${required}`);

const goldenHex = vector.encodedHex;
for (const relative of contractBindings) {
  const binding = readFileSync(join(coreRoot, relative), 'utf8');
  assert(binding.includes(goldenHex), `${relative} omits the golden ABI vector`);
  assert(binding.includes(generation.schemaSha256), `${relative} omits the schema hash`);
  assert(binding.includes(generation.diagnosticRegistrySha256), `${relative} omits the registry hash`);
  assert(binding.includes(generation.diagnosticResultSchemaSha256), `${relative} omits the result-schema hash`);
  assert(binding.includes(generation.diagnosticAdaptersSha256), `${relative} omits the adapter hash`);
  assert(binding.includes(generation.appVaultStateSchemaSha256), `${relative} omits the AppVault state hash`);
}

const sharedDiagnostics = readFileSync(
  join(repositoryRoot, 'packages', 'wallet-shared', 'src', 'diagnosticTestbench.ts'),
  'utf8',
);
for (const required of [
  'MFW_DIAGNOSTIC_TESTS',
  'MFW_DIAGNOSTIC_REGISTRY_SHA256',
  'validateLegacyQuickDiagnosticProbes',
]) assert(sharedDiagnostics.includes(required), `shared diagnostic adapter omits ${required}`);

for (const relative of [
  'apps/mobile/src/backend/WalletDiagnosticTestbench.ts',
  'apps/desktop/src/walletDiagnosticTestbench.ts',
]) {
  const source = readFileSync(join(repositoryRoot, relative), 'utf8');
  assert(source.includes('validateLegacyQuickDiagnosticProbes'), `${relative} bypasses the shared registry adapter`);
  assert(source.includes('registryIdForLegacyQuickProbe'), `${relative} omits canonical diagnostic provenance`);
}

for (const profile of ['quick', 'comprehensive', 'guided', 'full', 'release']) {
  assert(registry.profiles.includes(profile));
  assert(registry.tests.some(test => test.profiles.includes(profile)), `empty diagnostic profile: ${profile}`);
}
for (const id of [
  'core.provenance',
  'core.abi-roundtrip',
  'security.secret-canary',
  'network.grpc-scanpack',
  'sync.original-wallet',
  'sync.fast-wallet',
  'sync.fast-wallet-scanpack',
  'sync.multiwallet',
  'sync.reorg',
  'sync.failover',
  'ledger.key-image',
  'packaging.release',
]) assert(registry.tests.some(test => test.id === id), `diagnostic registry omits ${id}`);

const header = readFileSync(join(coreRoot, 'include', 'mfw_product_core.h'), 'utf8');
for (const symbol of [
  'mfw_product_core_create',
  'mfw_product_core_emit',
  'mfw_product_core_flush',
  'mfw_product_core_stats',
  'mfw_product_core_record_hot_sample',
  'mfw_product_core_flush_thread_hot_metrics',
  'mfw_product_core_encode_event_v1',
  'mfw_product_core_copy_diagnostic_registry_json',
  'mfw_product_core_copy_diagnostic_result_schema_json',
  'mfw_product_core_copy_diagnostic_adapters_json',
  'mfw_product_core_diagnostic_field_allowed',
  'mfw_app_vault_state_schema_sha256',
  'mfw_app_vault_state_default_v1',
  'mfw_app_vault_password_verifier_create_v1',
  'mfw_app_vault_password_verifier_validate_v1',
  'mfw_app_vault_password_verifier_verify_v1',
  'mfw_app_vault_apply_event_v1',
  'mfw_app_vault_presentation_v1',
  'mfw_app_vault_wallet_switch_allowed_v1',
  'mfw_app_vault_warmup_batch_v1',
  'mfw_app_vault_step_up_issue_v1',
  'mfw_app_vault_step_up_consume_v1',
  'mfw_app_vault_copy_state_schema_json',
  'mfw_product_core_destroy',
]) assert(header.includes(symbol), `C ABI omits ${symbol}`);

const rendererRoots = [
  join(repositoryRoot, 'apps', 'mobile', 'src'),
  join(repositoryRoot, 'apps', 'desktop', 'src'),
  join(repositoryRoot, 'apps', 'desktop', 'src-tauri', 'src'),
];
const riskyImports = /(?:@noble\/curves|tweetnacl|curve25519|monero-javascript|crypto_scalarmult|generate_key_derivation|derive_subaddress_public_key|ge_scalarmult)/i;
const rg = spawnSync('rg', ['-n', '--hidden', '--glob', '!**/node_modules/**', riskyImports.source, ...rendererRoots], {
  cwd: repositoryRoot,
  encoding: 'utf8',
});
assert([0, 1].includes(rg.status), rg.stderr);
assert.equal(rg.status, 1, `renderer contains forbidden crypto implementation/import:\n${rg.stdout}`);

process.stdout.write(`${JSON.stringify({
  ok: true,
  abiVersion: schema.abiVersion,
  schemaSha256: generation.schemaSha256,
  diagnosticRegistrySha256: generation.diagnosticRegistrySha256,
  diagnosticResultSchemaSha256: generation.diagnosticResultSchemaSha256,
  diagnosticAdaptersSha256: generation.diagnosticAdaptersSha256,
  appVaultStateSchemaSha256: generation.appVaultStateSchemaSha256,
  generatedBindings: outputs.length - 1,
  goldenBytes: Buffer.from(goldenHex, 'hex').length,
  diagnostics: registry.tests.length,
  diagnosticResultFields: diagnosticResult.allowedFields.length,
  diagnosticAdapters: diagnosticAdapters.adapters.length,
  forbiddenEventFields: 0,
  rendererCryptoViolations: 0,
})}\n`);
