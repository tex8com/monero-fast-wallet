#!/usr/bin/env node

import {createHash} from 'node:crypto';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const schema = JSON.parse(readFileSync(join(root, 'schema', 'mfw-product-core.v1.json'), 'utf8'));
const registry = JSON.parse(readFileSync(join(root, 'schema', 'diagnostic-registry.v1.json'), 'utf8'));
const diagnosticResult = JSON.parse(readFileSync(join(root, 'schema', 'diagnostic-result.v1.json'), 'utf8'));
const diagnosticAdapters = JSON.parse(readFileSync(join(root, 'schema', 'diagnostic-adapters.v1.json'), 'utf8'));
const appVault = JSON.parse(readFileSync(join(root, 'schema', 'app-vault-state-machine.v1.json'), 'utf8'));
const walletLifecycle = JSON.parse(readFileSync(join(root, 'schema', 'wallet-lifecycle.v1.json'), 'utf8'));

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function assertUnique(items, label) {
  const names = new Set();
  const values = new Set();
  for (const item of items) {
    if (names.has(item.name) || values.has(item.value)) throw new Error(`duplicate ${label}: ${item.name}`);
    names.add(item.name);
    values.add(item.value);
  }
}

for (const [name, values] of Object.entries({
  errors: schema.errors,
  priorities: schema.priorities,
  outputFormats: schema.outputFormats,
  networks: schema.networks,
  statuses: schema.statuses,
  components: schema.components,
  phases: schema.phases,
  metrics: schema.metrics,
})) assertUnique(values, name);

const testIds = registry.tests.map(test => test.id);
if (new Set(testIds).size !== testIds.length) throw new Error('duplicate diagnostic test id');
const adapterIds = new Set(diagnosticAdapters.adapters.map(adapter => adapter.id));
if (adapterIds.size !== diagnosticAdapters.adapters.length) throw new Error('duplicate diagnostic adapter id');
for (const test of registry.tests) {
  if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(test.id)) throw new Error(`invalid diagnostic id: ${test.id}`);
  for (const profile of test.profiles) {
    if (!registry.profiles.includes(profile)) throw new Error(`unknown profile ${profile}`);
  }
  if (!Number.isInteger(test.version) || test.version < 1) throw new Error(`invalid diagnostic version: ${test.id}`);
  if (!Number.isInteger(test.timeoutMs) || test.timeoutMs < 1) throw new Error(`invalid diagnostic timeout: ${test.id}`);
  if (!adapterIds.has(test.runnerId)) throw new Error(`unknown diagnostic adapter: ${test.runnerId}`);
  for (const field of ['prerequisites', 'measurements', 'successCriteria', 'evidence']) {
    if (!Array.isArray(test[field])) throw new Error(`${test.id} omits ${field}`);
  }
}
if (new Set(diagnosticResult.allowedFields).size !== diagnosticResult.allowedFields.length) {
  throw new Error('duplicate diagnostic result field');
}
for (const field of diagnosticResult.requiredFields) {
  if (!diagnosticResult.allowedFields.includes(field)) throw new Error(`required result field is not allowed: ${field}`);
}

const schemaHash = sha256(canonical(schema));
const registryHash = sha256(canonical(registry));
const diagnosticResultHash = sha256(canonical(diagnosticResult));
const diagnosticAdaptersHash = sha256(canonical(diagnosticAdapters));
const appVaultHash = sha256(canonical(appVault));
const walletLifecycleHash = sha256(canonical(walletLifecycle));

for (const [name, values] of Object.entries({
  protectionModes: appVault.protectionModes,
  presentations: appVault.presentations,
  migrationStates: appVault.migrationStates,
  events: appVault.events,
  stepUpActions: appVault.stepUpActions,
})) assertUnique(values, `appVault.${name}`);
if (appVault.schemaVersion !== 1 || appVault.stateVersion !== 1) throw new Error('unsupported AppVault state schema');
if (!appVault.autoLockSeconds.includes(appVault.defaultAutoLockSeconds)) throw new Error('AppVault default timeout is not allowed');
if (appVault.unlockBackoffSeconds[0] !== 0) throw new Error('AppVault backoff must start at zero failures');
if (!appVault.password.requiredAsRecoveryForSystemAuth) throw new Error('system auth must retain password recovery');
if (appVault.password.kdf.algorithm !== 'argon2id' || appVault.password.kdf.version !== 19 ||
    appVault.password.kdf.memoryKiB < 65536 || appVault.password.kdf.iterations < 3 ||
    appVault.password.kdf.parallelism < 1 || appVault.password.kdf.saltBytes !== 16 ||
    appVault.password.kdf.digestBytes !== 32) {
  throw new Error('AppVault password KDF is below the version-1 security contract');
}

const walletGroups = [
  ['WALLET_PREFERENCE', walletLifecycle.preferences],
  ['FAST_WALLET_OVERRIDE', walletLifecycle.fastWalletOverrides],
  ['WALLET_KIND', walletLifecycle.walletKinds],
  ['WALLET_LIFECYCLE', walletLifecycle.lifecycleStates],
  ['WALLET_EVENT', walletLifecycle.lifecycleEvents],
  ['WALLET_BALANCE', walletLifecycle.balanceStates],
  ['WALLET_REMOVAL_REQUIREMENT', walletLifecycle.removalRequirements],
  ['SEND_STATE', walletLifecycle.sendStates],
  ['SEND_EVENT', walletLifecycle.sendEvents],
];
for (const [name, values] of walletGroups) assertUnique(values, `walletLifecycle.${name}`);
if (walletLifecycle.schemaVersion !== 1 || walletLifecycle.stateVersion !== 1) {
  throw new Error('unsupported wallet lifecycle schema');
}
if (!Number.isInteger(walletLifecycle.restore.defaultSafetyBlocks) ||
    !Number.isInteger(walletLifecycle.restore.maximumSafetyBlocks) ||
    walletLifecycle.restore.defaultSafetyBlocks < 0 ||
    walletLifecycle.restore.maximumSafetyBlocks < walletLifecycle.restore.defaultSafetyBlocks) {
  throw new Error('invalid wallet restore safety-block contract');
}

const golden = Buffer.alloc(136);
let offset = 0;
golden.write('MFW1', offset, 'ascii'); offset += 4;
golden.writeUInt16LE(schema.eventSchemaVersion, offset); offset += 2;
golden.writeUInt16LE(schema.abiVersion, offset); offset += 2;
golden.writeBigUInt64LE(42n, offset); offset += 8;
golden.writeBigUInt64LE(1234567890123n, offset); offset += 8;
golden.writeBigUInt64LE(987654321n, offset); offset += 8;
golden.writeUInt8(1, offset++); // normal priority
golden.writeUInt8(1, offset++); // mainnet
golden.writeUInt8(2, offset++); // ok
golden.writeUInt8(0, offset++);
golden.writeUInt16LE(7, offset); offset += 2; // wallet scan
golden.writeUInt16LE(16, offset); offset += 2; // scan outputs
golden.writeUInt16LE(0, offset); offset += 2; // no error
golden.writeUInt16LE(1, offset); offset += 2; // one metric
for (let id = 1; id <= 5; id += 1) {
  golden.fill(id, offset, offset + 16);
  offset += 16;
}
golden.writeUInt16LE(8, offset); offset += 2; // outputs
golden.writeUInt16LE(0, offset); offset += 2;
golden.writeBigInt64LE(2048n, offset); offset += 8;
if (offset !== golden.length) throw new Error(`golden vector size mismatch: ${offset}`);
const goldenHex = golden.toString('hex');

const groups = [
  ['ERROR', schema.errors],
  ['PRIORITY', schema.priorities],
  ['OUTPUT_FORMAT', schema.outputFormats],
  ['NETWORK', schema.networks],
  ['STATUS', schema.statuses],
  ['COMPONENT', schema.components],
  ['PHASE', schema.phases],
  ['METRIC', schema.metrics],
];

const cLines = [
  '#ifndef MFW_PRODUCT_CORE_CONTRACT_GENERATED_H',
  '#define MFW_PRODUCT_CORE_CONTRACT_GENERATED_H',
  '',
  `#define MFW_PRODUCT_CORE_ABI_VERSION ${schema.abiVersion}u`,
  `#define MFW_PRODUCT_CORE_EVENT_SCHEMA_VERSION ${schema.eventSchemaVersion}u`,
  `#define MFW_PRODUCT_CORE_SCHEMA_SHA256 "${schemaHash}"`,
  `#define MFW_DIAGNOSTIC_REGISTRY_SHA256 "${registryHash}"`,
  `#define MFW_DIAGNOSTIC_RESULT_SCHEMA_SHA256 "${diagnosticResultHash}"`,
  `#define MFW_DIAGNOSTIC_ADAPTERS_SHA256 "${diagnosticAdaptersHash}"`,
  `#define MFW_APP_VAULT_STATE_SCHEMA_SHA256 "${appVaultHash}"`,
  `#define MFW_WALLET_LIFECYCLE_SCHEMA_SHA256 "${walletLifecycleHash}"`,
  `#define MFW_PRODUCT_CORE_GOLDEN_EVENT_V1_HEX "${goldenHex}"`,
  `#define MFW_PRODUCT_CORE_METRICS_PER_EVENT_MAX ${schema.limits.metricsPerEventMax}u`,
  '',
];
for (const [prefix, items] of groups) {
  for (const item of items) cLines.push(`#define MFW_${prefix}_${item.name} ${item.value}u`);
  cLines.push('');
}
cLines.push(
  `#define MFW_APP_VAULT_STATE_SCHEMA_VERSION ${appVault.stateVersion}u`,
  `#define MFW_APP_VAULT_DEFAULT_AUTO_LOCK_SECONDS ${appVault.defaultAutoLockSeconds}u`,
  `#define MFW_APP_VAULT_PASSWORD_MINIMUM_CHARACTERS ${appVault.password.minimumCharacters}u`,
  `#define MFW_APP_VAULT_PASSWORD_MAXIMUM_CHARACTERS ${appVault.password.maximumCharacters}u`,
  `#define MFW_APP_VAULT_PASSWORD_KDF_VERSION ${appVault.password.kdf.version}u`,
  `#define MFW_APP_VAULT_PASSWORD_KDF_MEMORY_KIB ${appVault.password.kdf.memoryKiB}u`,
  `#define MFW_APP_VAULT_PASSWORD_KDF_ITERATIONS ${appVault.password.kdf.iterations}u`,
  `#define MFW_APP_VAULT_PASSWORD_KDF_PARALLELISM ${appVault.password.kdf.parallelism}u`,
  `#define MFW_APP_VAULT_PASSWORD_KDF_SALT_BYTES ${appVault.password.kdf.saltBytes}u`,
  `#define MFW_APP_VAULT_PASSWORD_KDF_DIGEST_BYTES ${appVault.password.kdf.digestBytes}u`,
  `#define MFW_APP_VAULT_WARMUP_MAXIMUM_CONCURRENT_WALLETS ${appVault.warmup.maximumConcurrentWallets}u`,
  '',
);
for (const [prefix, items] of [
  ['APP_VAULT_PROTECTION_MODE', appVault.protectionModes],
  ['APP_VAULT_PRESENTATION', appVault.presentations],
  ['APP_VAULT_MIGRATION', appVault.migrationStates],
  ['APP_VAULT_EVENT', appVault.events],
  ['APP_VAULT_STEP_UP', appVault.stepUpActions],
]) {
  for (const item of items) cLines.push(`#define MFW_${prefix}_${item.name} ${item.value}u`);
  cLines.push('');
}
cLines.push(
  `#define MFW_WALLET_LIFECYCLE_STATE_VERSION ${walletLifecycle.stateVersion}u`,
  `#define MFW_WALLET_RESTORE_DEFAULT_SAFETY_BLOCKS ${walletLifecycle.restore.defaultSafetyBlocks}ull`,
  `#define MFW_WALLET_RESTORE_MAXIMUM_SAFETY_BLOCKS ${walletLifecycle.restore.maximumSafetyBlocks}ull`,
  '',
);
for (const [prefix, items] of walletGroups) {
  for (const item of items) cLines.push(`#define MFW_${prefix}_${item.name} ${item.value}u`);
  cLines.push('');
}
cLines.push('#endif');

const rustLines = [
  `pub const ABI_VERSION: u32 = ${schema.abiVersion};`,
  `pub const EVENT_SCHEMA_VERSION: u32 = ${schema.eventSchemaVersion};`,
  `pub const SCHEMA_SHA256: &str = "${schemaHash}";`,
  `pub const DIAGNOSTIC_REGISTRY_SHA256: &str = "${registryHash}";`,
  `pub const DIAGNOSTIC_RESULT_SCHEMA_SHA256: &str = "${diagnosticResultHash}";`,
  `pub const DIAGNOSTIC_ADAPTERS_SHA256: &str = "${diagnosticAdaptersHash}";`,
  `pub const APP_VAULT_STATE_SCHEMA_SHA256: &str = "${appVaultHash}";`,
  `pub const WALLET_LIFECYCLE_SCHEMA_SHA256: &str = "${walletLifecycleHash}";`,
  `pub static SCHEMA_SHA256_C: &[u8] = b"${schemaHash}\\0";`,
  `pub static DIAGNOSTIC_REGISTRY_SHA256_C: &[u8] = b"${registryHash}\\0";`,
  `pub static DIAGNOSTIC_RESULT_SCHEMA_SHA256_C: &[u8] = b"${diagnosticResultHash}\\0";`,
  `pub static DIAGNOSTIC_ADAPTERS_SHA256_C: &[u8] = b"${diagnosticAdaptersHash}\\0";`,
  `pub static APP_VAULT_STATE_SCHEMA_SHA256_C: &[u8] = b"${appVaultHash}\\0";`,
  `pub static WALLET_LIFECYCLE_SCHEMA_SHA256_C: &[u8] = b"${walletLifecycleHash}\\0";`,
  `pub const GOLDEN_EVENT_V1_HEX: &str = "${goldenHex}";`,
  `pub const METRICS_PER_EVENT_MAX: usize = ${schema.limits.metricsPerEventMax};`,
];
rustLines.push(
  `pub const DIAGNOSTIC_RESULT_ALLOWED_FIELDS: &[&str] = &[${diagnosticResult.allowedFields.map(JSON.stringify).join(',')}];`,
  `pub const DIAGNOSTIC_RESULT_FORBIDDEN_FIELDS: &[&str] = &[${diagnosticResult.forbiddenFields.map(JSON.stringify).join(',')}];`,
);
for (const [prefix, items] of groups) {
  for (const item of items) rustLines.push(`pub const ${prefix}_${item.name}: u32 = ${item.value};`);
}
rustLines.push(
  `pub const APP_VAULT_STATE_SCHEMA_VERSION: u32 = ${appVault.stateVersion};`,
  `pub const APP_VAULT_DEFAULT_AUTO_LOCK_SECONDS: u64 = ${appVault.defaultAutoLockSeconds};`,
  `pub const APP_VAULT_AUTO_LOCK_SECONDS: &[u64] = &[${appVault.autoLockSeconds.join(',')}];`,
  `pub const APP_VAULT_UNLOCK_BACKOFF_SECONDS: &[u64] = &[${appVault.unlockBackoffSeconds.join(',')}];`,
  `pub const APP_VAULT_PASSWORD_MINIMUM_CHARACTERS: usize = ${appVault.password.minimumCharacters};`,
  `pub const APP_VAULT_PASSWORD_MAXIMUM_CHARACTERS: usize = ${appVault.password.maximumCharacters};`,
  `pub const APP_VAULT_PASSWORD_KDF_VERSION: u32 = ${appVault.password.kdf.version};`,
  `pub const APP_VAULT_PASSWORD_KDF_MEMORY_KIB: u32 = ${appVault.password.kdf.memoryKiB};`,
  `pub const APP_VAULT_PASSWORD_KDF_ITERATIONS: u32 = ${appVault.password.kdf.iterations};`,
  `pub const APP_VAULT_PASSWORD_KDF_PARALLELISM: u32 = ${appVault.password.kdf.parallelism};`,
  `pub const APP_VAULT_PASSWORD_KDF_SALT_BYTES: usize = ${appVault.password.kdf.saltBytes};`,
  `pub const APP_VAULT_PASSWORD_KDF_DIGEST_BYTES: usize = ${appVault.password.kdf.digestBytes};`,
  `pub const APP_VAULT_WARMUP_MAXIMUM_CONCURRENT_WALLETS: usize = ${appVault.warmup.maximumConcurrentWallets};`,
);
for (const [prefix, items] of [
  ['APP_VAULT_PROTECTION_MODE', appVault.protectionModes],
  ['APP_VAULT_PRESENTATION', appVault.presentations],
  ['APP_VAULT_MIGRATION', appVault.migrationStates],
  ['APP_VAULT_EVENT', appVault.events],
  ['APP_VAULT_STEP_UP', appVault.stepUpActions],
]) {
  for (const item of items) rustLines.push(`pub const ${prefix}_${item.name}: u32 = ${item.value};`);
}
rustLines.push(
  `pub const WALLET_LIFECYCLE_STATE_VERSION: u32 = ${walletLifecycle.stateVersion};`,
  `pub const WALLET_RESTORE_DEFAULT_SAFETY_BLOCKS: u64 = ${walletLifecycle.restore.defaultSafetyBlocks};`,
  `pub const WALLET_RESTORE_MAXIMUM_SAFETY_BLOCKS: u64 = ${walletLifecycle.restore.maximumSafetyBlocks};`,
);
for (const [prefix, items] of walletGroups) {
  for (const item of items) rustLines.push(`pub const ${prefix}_${item.name}: u32 = ${item.value};`);
}

const tsLines = [
  '// Generated by native/product-core/scripts/generate-bindings.mjs. Do not edit.',
  `export const MFW_PRODUCT_CORE_ABI_VERSION = ${schema.abiVersion} as const;`,
  `export const MFW_PRODUCT_CORE_EVENT_SCHEMA_VERSION = ${schema.eventSchemaVersion} as const;`,
  `export const MFW_PRODUCT_CORE_SCHEMA_SHA256 = '${schemaHash}' as const;`,
  `export const MFW_DIAGNOSTIC_REGISTRY_SHA256 = '${registryHash}' as const;`,
  `export const MFW_DIAGNOSTIC_RESULT_SCHEMA_SHA256 = '${diagnosticResultHash}' as const;`,
  `export const MFW_DIAGNOSTIC_ADAPTERS_SHA256 = '${diagnosticAdaptersHash}' as const;`,
  `export const MFW_APP_VAULT_STATE_SCHEMA_SHA256 = '${appVaultHash}' as const;`,
  `export const MFW_WALLET_LIFECYCLE_SCHEMA_SHA256 = '${walletLifecycleHash}' as const;`,
  `export const MFW_PRODUCT_CORE_GOLDEN_EVENT_V1_HEX = '${goldenHex}' as const;`,
];
for (const [prefix, items] of groups) {
  tsLines.push(`export const Mfw${prefix[0]}${prefix.slice(1).toLowerCase()} = {`);
  for (const item of items) tsLines.push(`  ${item.name}: ${item.value},`);
  tsLines.push('} as const;');
}
tsLines.push(
  'export interface MfwSanitizedMetricV1 { metricId: number; value: number; }',
  'export interface MfwTelemetryEventV1 {',
  '  schemaVersion: 1; eventSequence: number; monotonicTimestampNsRaw: string;',
  '  durationNsRaw: string; priority: number; network: number; component: number;',
  '  phase: number; status: number; errorCode: number; sanitizedMetrics: readonly MfwSanitizedMetricV1[];',
  '}',
);

const diagnosticRegistryTsLines = [
  '// Generated by native/product-core/scripts/generate-bindings.mjs. Do not edit.',
  `export const MFW_DIAGNOSTIC_REGISTRY_SHA256 = '${registryHash}' as const;`,
  `export const MFW_DIAGNOSTIC_RESULT_SCHEMA_SHA256 = '${diagnosticResultHash}' as const;`,
  `export const MFW_DIAGNOSTIC_ADAPTERS_SHA256 = '${diagnosticAdaptersHash}' as const;`,
  `export const MFW_DIAGNOSTIC_PROFILES = ${JSON.stringify(registry.profiles)} as const;`,
  `export const MFW_DIAGNOSTIC_TESTS = ${JSON.stringify(registry.tests, null, 2)} as const;`,
  `export const MFW_DIAGNOSTIC_ADAPTERS = ${JSON.stringify(diagnosticAdapters.adapters, null, 2)} as const;`,
  'export type MfwDiagnosticProfile = typeof MFW_DIAGNOSTIC_PROFILES[number];',
  'export type MfwDiagnosticRegistryId = typeof MFW_DIAGNOSTIC_TESTS[number][\'id\'];',
  'export type MfwDiagnosticAdapterId = typeof MFW_DIAGNOSTIC_ADAPTERS[number][\'id\'];',
];

const kotlinLines = [
  '// Generated by native/product-core/scripts/generate-bindings.mjs. Do not edit.',
  'package com.tex8.monero.productcore',
  '',
  'object MfwProductCoreContract {',
  `    const val ABI_VERSION: UInt = ${schema.abiVersion}u`,
  `    const val EVENT_SCHEMA_VERSION: UInt = ${schema.eventSchemaVersion}u`,
  `    const val SCHEMA_SHA256: String = "${schemaHash}"`,
  `    const val DIAGNOSTIC_REGISTRY_SHA256: String = "${registryHash}"`,
  `    const val DIAGNOSTIC_RESULT_SCHEMA_SHA256: String = "${diagnosticResultHash}"`,
  `    const val DIAGNOSTIC_ADAPTERS_SHA256: String = "${diagnosticAdaptersHash}"`,
  `    const val APP_VAULT_STATE_SCHEMA_SHA256: String = "${appVaultHash}"`,
  `    const val WALLET_LIFECYCLE_SCHEMA_SHA256: String = "${walletLifecycleHash}"`,
  `    const val GOLDEN_EVENT_V1_HEX: String = "${goldenHex}"`,
];
for (const [prefix, items] of groups) {
  for (const item of items) kotlinLines.push(`    const val ${prefix}_${item.name}: UInt = ${item.value}u`);
}
kotlinLines.push('}');

const swiftLines = [
  '// Generated by native/product-core/scripts/generate-bindings.mjs. Do not edit.',
  'public enum MfwProductCoreContract {',
  `    public static let abiVersion: UInt32 = ${schema.abiVersion}`,
  `    public static let eventSchemaVersion: UInt32 = ${schema.eventSchemaVersion}`,
  `    public static let schemaSha256 = "${schemaHash}"`,
  `    public static let diagnosticRegistrySha256 = "${registryHash}"`,
  `    public static let diagnosticResultSchemaSha256 = "${diagnosticResultHash}"`,
  `    public static let diagnosticAdaptersSha256 = "${diagnosticAdaptersHash}"`,
  `    public static let appVaultStateSchemaSha256 = "${appVaultHash}"`,
  `    public static let walletLifecycleSchemaSha256 = "${walletLifecycleHash}"`,
  `    public static let goldenEventV1Hex = "${goldenHex}"`,
];
for (const [prefix, items] of groups) {
  for (const item of items) swiftLines.push(`    public static let ${prefix.toLowerCase()}_${item.name.toLowerCase()}: UInt32 = ${item.value}`);
}
swiftLines.push('}');

const appVaultGroups = [
  ['PROTECTION_MODE', appVault.protectionModes],
  ['PRESENTATION', appVault.presentations],
  ['MIGRATION', appVault.migrationStates],
  ['EVENT', appVault.events],
  ['STEP_UP', appVault.stepUpActions],
];
const appVaultTsLines = [
  '// Generated by native/product-core/scripts/generate-bindings.mjs. Do not edit.',
  `export const MFW_APP_VAULT_STATE_SCHEMA_VERSION = ${appVault.stateVersion} as const;`,
  `export const MFW_APP_VAULT_STATE_SCHEMA_SHA256 = '${appVaultHash}' as const;`,
  `export const MFW_APP_VAULT_DEFAULT_AUTO_LOCK_SECONDS = ${appVault.defaultAutoLockSeconds} as const;`,
  `export const MFW_APP_VAULT_AUTO_LOCK_SECONDS = ${JSON.stringify(appVault.autoLockSeconds)} as const;`,
  `export const MFW_APP_VAULT_UNLOCK_BACKOFF_SECONDS = ${JSON.stringify(appVault.unlockBackoffSeconds)} as const;`,
  `export const MFW_APP_VAULT_PASSWORD_MINIMUM_CHARACTERS = ${appVault.password.minimumCharacters} as const;`,
  `export const MFW_APP_VAULT_PASSWORD_MAXIMUM_CHARACTERS = ${appVault.password.maximumCharacters} as const;`,
  `export const MFW_APP_VAULT_PASSWORD_KDF = ${JSON.stringify(appVault.password.kdf)} as const;`,
  `export const MFW_APP_VAULT_SYSTEM_AUTH_REQUIRES_PASSWORD_RECOVERY = ${appVault.password.requiredAsRecoveryForSystemAuth} as const;`,
  `export const MFW_APP_VAULT_WARMUP_MAXIMUM_CONCURRENT_WALLETS = ${appVault.warmup.maximumConcurrentWallets} as const;`,
  `export const MFW_APP_VAULT_INVARIANTS = ${JSON.stringify(appVault.invariants)} as const;`,
];
for (const [prefix, values] of appVaultGroups) {
  const camel = prefix.toLowerCase().split('_').map((part, index) => index === 0 ? part : `${part[0].toUpperCase()}${part.slice(1)}`).join('');
  appVaultTsLines.push(`export const MfwAppVault${camel[0].toUpperCase()}${camel.slice(1)} = {`);
  for (const item of values) appVaultTsLines.push(`  ${item.name}: ${item.value},`);
  appVaultTsLines.push('} as const;');
}

const appVaultKotlinLines = [
  '// Generated by native/product-core/scripts/generate-bindings.mjs. Do not edit.',
  'package com.tex8.monero.productcore',
  '',
  'object MfwAppVaultContract {',
  `    const val STATE_SCHEMA_VERSION: Int = ${appVault.stateVersion}`,
  `    const val STATE_SCHEMA_SHA256: String = "${appVaultHash}"`,
  `    const val DEFAULT_AUTO_LOCK_SECONDS: Long = ${appVault.defaultAutoLockSeconds}L`,
  `    val AUTO_LOCK_SECONDS: Set<Long> = setOf(${appVault.autoLockSeconds.map(value => `${value}L`).join(', ')})`,
  `    val UNLOCK_BACKOFF_SECONDS: LongArray = longArrayOf(${appVault.unlockBackoffSeconds.map(value => `${value}L`).join(', ')})`,
  `    const val PASSWORD_MINIMUM_CHARACTERS: Int = ${appVault.password.minimumCharacters}`,
  `    const val PASSWORD_MAXIMUM_CHARACTERS: Int = ${appVault.password.maximumCharacters}`,
  `    const val PASSWORD_KDF_VERSION: Int = ${appVault.password.kdf.version}`,
  `    const val PASSWORD_KDF_MEMORY_KIB: Int = ${appVault.password.kdf.memoryKiB}`,
  `    const val PASSWORD_KDF_ITERATIONS: Int = ${appVault.password.kdf.iterations}`,
  `    const val PASSWORD_KDF_PARALLELISM: Int = ${appVault.password.kdf.parallelism}`,
  `    const val PASSWORD_KDF_SALT_BYTES: Int = ${appVault.password.kdf.saltBytes}`,
  `    const val PASSWORD_KDF_DIGEST_BYTES: Int = ${appVault.password.kdf.digestBytes}`,
  `    const val WARMUP_MAXIMUM_CONCURRENT_WALLETS: Int = ${appVault.warmup.maximumConcurrentWallets}`,
];
for (const [prefix, values] of appVaultGroups) {
  for (const item of values) appVaultKotlinLines.push(`    const val ${prefix}_${item.name}: Int = ${item.value}`);
}
appVaultKotlinLines.push(
  '    fun unlockDelaySeconds(failures: Int): Long {',
  '        if (failures <= 0) return 0L',
  '        return UNLOCK_BACKOFF_SECONDS[minOf(failures, UNLOCK_BACKOFF_SECONDS.lastIndex)]',
  '    }',
  '}',
);

const appVaultSwiftLines = [
  '// Generated by native/product-core/scripts/generate-bindings.mjs. Do not edit.',
  'public enum MfwAppVaultContract {',
  `    public static let stateSchemaVersion: UInt32 = ${appVault.stateVersion}`,
  `    public static let stateSchemaSha256 = "${appVaultHash}"`,
  `    public static let defaultAutoLockSeconds: UInt64 = ${appVault.defaultAutoLockSeconds}`,
  `    public static let autoLockSeconds: [UInt64] = [${appVault.autoLockSeconds.join(', ')}]`,
  `    public static let unlockBackoffSeconds: [UInt64] = [${appVault.unlockBackoffSeconds.join(', ')}]`,
  `    public static let passwordMinimumCharacters = ${appVault.password.minimumCharacters}`,
  `    public static let passwordMaximumCharacters = ${appVault.password.maximumCharacters}`,
  `    public static let passwordKdfVersion = ${appVault.password.kdf.version}`,
  `    public static let passwordKdfMemoryKiB = ${appVault.password.kdf.memoryKiB}`,
  `    public static let passwordKdfIterations = ${appVault.password.kdf.iterations}`,
  `    public static let passwordKdfParallelism = ${appVault.password.kdf.parallelism}`,
  `    public static let passwordKdfSaltBytes = ${appVault.password.kdf.saltBytes}`,
  `    public static let passwordKdfDigestBytes = ${appVault.password.kdf.digestBytes}`,
  `    public static let warmupMaximumConcurrentWallets = ${appVault.warmup.maximumConcurrentWallets}`,
];
for (const [prefix, values] of appVaultGroups) {
  for (const item of values) appVaultSwiftLines.push(`    public static let ${prefix.toLowerCase()}_${item.name.toLowerCase()}: UInt32 = ${item.value}`);
}
appVaultSwiftLines.push('}');

const walletLifecycleTsLines = [
  '// Generated by native/product-core/scripts/generate-bindings.mjs. Do not edit.',
  `export const MFW_WALLET_LIFECYCLE_STATE_VERSION = ${walletLifecycle.stateVersion} as const;`,
  `export const MFW_WALLET_LIFECYCLE_SCHEMA_SHA256 = '${walletLifecycleHash}' as const;`,
  `export const MFW_WALLET_RESTORE_DEFAULT_SAFETY_BLOCKS = ${walletLifecycle.restore.defaultSafetyBlocks} as const;`,
  `export const MFW_WALLET_RESTORE_MAXIMUM_SAFETY_BLOCKS = ${walletLifecycle.restore.maximumSafetyBlocks} as const;`,
  `export const MFW_WALLET_LIFECYCLE_INVARIANTS = ${JSON.stringify(walletLifecycle.invariants)} as const;`,
];
for (const [prefix, values] of walletGroups) {
  for (const item of values) {
    walletLifecycleTsLines.push(`export const MFW_${prefix}_${item.name} = ${item.value} as const;`);
  }
}

const walletLifecycleKotlinLines = [
  '// Generated by native/product-core/scripts/generate-bindings.mjs. Do not edit.',
  'package com.tex8.monero.productcore',
  '',
  'object MfwWalletLifecycleContract {',
  `    const val STATE_VERSION: Int = ${walletLifecycle.stateVersion}`,
  `    const val SCHEMA_SHA256: String = "${walletLifecycleHash}"`,
  `    const val RESTORE_DEFAULT_SAFETY_BLOCKS: Long = ${walletLifecycle.restore.defaultSafetyBlocks}L`,
  `    const val RESTORE_MAXIMUM_SAFETY_BLOCKS: Long = ${walletLifecycle.restore.maximumSafetyBlocks}L`,
];
for (const [prefix, values] of walletGroups) {
  for (const item of values) {
    walletLifecycleKotlinLines.push(`    const val ${prefix}_${item.name}: Int = ${item.value}`);
  }
}
walletLifecycleKotlinLines.push('}');

const walletLifecycleSwiftLines = [
  '// Generated by native/product-core/scripts/generate-bindings.mjs. Do not edit.',
  'public enum MfwWalletLifecycleContract {',
  `    public static let stateVersion: UInt32 = ${walletLifecycle.stateVersion}`,
  `    public static let schemaSha256 = "${walletLifecycleHash}"`,
  `    public static let restoreDefaultSafetyBlocks: UInt64 = ${walletLifecycle.restore.defaultSafetyBlocks}`,
  `    public static let restoreMaximumSafetyBlocks: UInt64 = ${walletLifecycle.restore.maximumSafetyBlocks}`,
];
for (const [prefix, values] of walletGroups) {
  for (const item of values) {
    walletLifecycleSwiftLines.push(
      `    public static let ${prefix.toLowerCase()}_${item.name.toLowerCase()}: UInt32 = ${item.value}`,
    );
  }
}
walletLifecycleSwiftLines.push('}');

const vector = {
  schemaVersion: 1,
  abiVersion: schema.abiVersion,
  schemaSha256: schemaHash,
  diagnosticRegistrySha256: registryHash,
  diagnosticResultSchemaSha256: diagnosticResultHash,
  diagnosticAdaptersSha256: diagnosticAdaptersHash,
  appVaultStateSchemaSha256: appVaultHash,
  walletLifecycleSchemaSha256: walletLifecycleHash,
  encoding: 'mfw-event-v1-little-endian',
  event: {
    eventSequence: 42,
    monotonicTimestampNsRaw: '1234567890123',
    durationNsRaw: '987654321',
    priority: 1,
    network: 1,
    status: 2,
    component: 7,
    phase: 16,
    errorCode: 0,
    processSessionIdHex: '01'.repeat(16),
    runIdHex: '02'.repeat(16),
    operationIdHex: '03'.repeat(16),
    parentOperationIdHex: '04'.repeat(16),
    walletPseudonymHex: '05'.repeat(16),
    metrics: [{metricId: 8, value: '2048'}]
  },
  encodedHex: goldenHex
};

function write(relative, contents) {
  const path = join(root, relative);
  mkdirSync(dirname(path), {recursive: true});
  writeFileSync(path, `${contents.trimEnd()}\n`);
}

write('generated/c/mfw_product_core_contract.h', cLines.join('\n'));
write('generated/rust/mfw_product_core_contract.rs', rustLines.join('\n'));
write('generated/typescript/mfwProductCoreContract.ts', tsLines.join('\n'));
write('generated/typescript/mfwDiagnosticRegistry.ts', diagnosticRegistryTsLines.join('\n'));
write('generated/typescript/mfwAppVaultContract.ts', appVaultTsLines.join('\n'));
write('generated/typescript/mfwWalletLifecycleContract.ts', walletLifecycleTsLines.join('\n'));
write('generated/kotlin/MfwProductCoreContract.kt', kotlinLines.join('\n'));
write('generated/kotlin/MfwAppVaultContract.kt', appVaultKotlinLines.join('\n'));
write('generated/kotlin/MfwWalletLifecycleContract.kt', walletLifecycleKotlinLines.join('\n'));
write('generated/swift/MfwProductCoreContract.swift', swiftLines.join('\n'));
write('generated/swift/MfwAppVaultContract.swift', appVaultSwiftLines.join('\n'));
write('generated/swift/MfwWalletLifecycleContract.swift', walletLifecycleSwiftLines.join('\n'));
write('../../apps/mobile/src/generated/mfwProductCoreContract.ts', tsLines.join('\n'));
write('../../apps/desktop/src/generated/mfwProductCoreContract.ts', tsLines.join('\n'));
write('../../apps/mobile/src/generated/mfwAppVaultContract.ts', appVaultTsLines.join('\n'));
write('../../apps/desktop/src/generated/mfwAppVaultContract.ts', appVaultTsLines.join('\n'));
write('../../apps/mobile/src/generated/mfwWalletLifecycleContract.ts', walletLifecycleTsLines.join('\n'));
write('../../apps/desktop/src/generated/mfwWalletLifecycleContract.ts', walletLifecycleTsLines.join('\n'));
write('../../packages/wallet-shared/src/generated/mfwDiagnosticRegistry.ts', diagnosticRegistryTsLines.join('\n'));
write('../../packages/wallet-shared/src/generated/mfwAppVaultContract.ts', appVaultTsLines.join('\n'));
write('../../packages/wallet-shared/src/generated/mfwWalletLifecycleContract.ts', walletLifecycleTsLines.join('\n'));
write(
  '../../apps/mobile/android/app/src/main/java/com/monerowallet/productcore/MfwProductCoreContract.kt',
  kotlinLines.join('\n'),
);
write(
  '../../apps/mobile/android/app/src/main/java/com/monerowallet/productcore/MfwAppVaultContract.kt',
  appVaultKotlinLines.join('\n'),
);
write(
  '../../apps/mobile/android/app/src/main/java/com/monerowallet/productcore/MfwWalletLifecycleContract.kt',
  walletLifecycleKotlinLines.join('\n'),
);
write('test-vectors/abi-event-v1.json', JSON.stringify(vector, null, 2));

process.stdout.write(`${JSON.stringify({
  ok: true,
  abiVersion: schema.abiVersion,
  schemaSha256: schemaHash,
  diagnosticRegistrySha256: registryHash,
  diagnosticResultSchemaSha256: diagnosticResultHash,
  diagnosticAdaptersSha256: diagnosticAdaptersHash,
  appVaultStateSchemaSha256: appVaultHash,
  walletLifecycleSchemaSha256: walletLifecycleHash,
  diagnostics: registry.tests.length,
  goldenBytes: golden.length,
})}\n`);
