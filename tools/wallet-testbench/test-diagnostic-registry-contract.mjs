#!/usr/bin/env node

import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {assertSanitizedDiagnosticResult, diagnosticResultSchema} from './diagnostic-sanitizer.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const schemaRoot = join(root, 'native', 'product-core', 'schema');
const registry = JSON.parse(readFileSync(join(schemaRoot, 'diagnostic-registry.v1.json'), 'utf8'));
const adapters = JSON.parse(readFileSync(join(schemaRoot, 'diagnostic-adapters.v1.json'), 'utf8'));
const adapterMap = new Map(adapters.adapters.map(adapter => [adapter.id, adapter]));

assert.equal(registry.registryVersion, '1.0.0');
assert.equal(registry.resultSchema, 'diagnostic-result.v1.json');
assert.equal(registry.adapterRegistry, 'diagnostic-adapters.v1.json');
assert.equal(registry.tests.length, 19);
for (const diagnostic of registry.tests) {
  assert(Number.isInteger(diagnostic.version) && diagnostic.version > 0, `${diagnostic.id}: version`);
  assert(Number.isInteger(diagnostic.timeoutMs) && diagnostic.timeoutMs > 0, `${diagnostic.id}: timeout`);
  for (const field of ['profiles', 'prerequisites', 'measurements', 'successCriteria', 'evidence']) {
    assert(Array.isArray(diagnostic[field]), `${diagnostic.id}: ${field}`);
  }
  const adapter = adapterMap.get(diagnostic.runnerId);
  assert(adapter, `${diagnostic.id}: unknown adapter ${diagnostic.runnerId}`);
  assert(['shell', 'node', 'rust', 'platform'].includes(adapter.kind));
  assert(existsSync(join(root, adapter.entry)), `${diagnostic.id}: missing adapter entry ${adapter.entry}`);
}

const valid = {
  schema_version: 1,
  diagnostic_id: 'core.abi-roundtrip',
  test_version: 1,
  run_id: '00000000000000000000000000000000',
  profile: 'quick',
  status: 'passed',
  started_monotonic_ns: '1',
  ended_monotonic_ns: '2',
  duration_ns: '1',
  measurements: [{metric_id: 'duration_ns', value: 1, unit: 'ns', sample_count: 1}],
  evidence: [{artifact_id: 'report', sha256: '0'.repeat(64), relative_name: 'report.json', available: true}],
  error_code: 0,
};
assert.equal(assertSanitizedDiagnosticResult(valid), valid);
for (const forbidden of [...diagnosticResultSchema.forbiddenFields, 'unknown_field']) {
  assert.throws(
    () => assertSanitizedDiagnosticResult({...valid, [forbidden]: 'canary'}),
    /forbidden diagnostic result field/,
    forbidden,
  );
}

process.stdout.write(`${JSON.stringify({
  ok: true,
  diagnostics: registry.tests.length,
  adapters: adapters.adapters.length,
  allowedFields: diagnosticResultSchema.allowedFields.length,
  forbiddenCanariesRejected: diagnosticResultSchema.forbiddenFields.length + 1,
})}\n`);
