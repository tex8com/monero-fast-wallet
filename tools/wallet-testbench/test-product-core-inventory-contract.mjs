#!/usr/bin/env node

import assert from 'node:assert/strict';
import {existsSync, readFileSync, readdirSync, statSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, '..', '..');
const inventoryPath = join(repositoryRoot, 'config', 'product-core-inventory.v1.json');
const inventory = JSON.parse(readFileSync(inventoryPath, 'utf8'));

function relativeExists(relativePath) {
  return existsSync(join(repositoryRoot, relativePath));
}

function unique(values, label) {
  assert.equal(new Set(values).size, values.length, `${label} contains duplicates`);
}

assert.equal(inventory.schemaVersion, 1, 'unexpected inventory schema');
assert.equal(inventory.planPhaseCount, 14, 'master plan must contain 14 phases');
assert(relativeExists(inventory.sourceOfTruth), 'master plan is missing');

const surfaceIds = inventory.surfaces.map(surface => surface.id);
unique(surfaceIds, 'surface ids');

let surfaceEntryCount = 0;
for (const surface of inventory.surfaces) {
  const root = join(repositoryRoot, surface.root);
  assert(existsSync(root), `surface root is missing: ${surface.root}`);
  const matcher = new RegExp(surface.match);
  const discovered = readdirSync(root)
    .filter(entry => matcher.test(entry))
    .filter(entry => {
      const stats = statSync(join(root, entry));
      return surface.kind === 'directory' ? stats.isDirectory() : stats.isFile();
    })
    .sort();
  const expected = [...surface.entries].sort();
  unique(expected, `${surface.id} entries`);
  assert.deepEqual(
    discovered,
    expected,
    `${surface.id} changed; classify every added, removed, or renamed entry in the inventory`,
  );
  surfaceEntryCount += expected.length;
}

const featureIds = inventory.featureAreas.map(feature => feature.id);
unique(featureIds, 'feature ids');
for (const feature of inventory.featureAreas) {
  assert.equal(typeof feature.targetV1, 'boolean', `${feature.id} lacks targetV1`);
  assert(feature.sources.length > 0, `${feature.id} has no source mapping`);
  unique(feature.sources, `${feature.id} sources`);
  for (const source of feature.sources) {
    assert(relativeExists(source), `${feature.id} source is missing: ${source}`);
  }
}

for (const contractGroup of ['apiContracts', 'storageAuthorities']) {
  const entries = inventory[contractGroup];
  unique(entries.map(entry => entry.id), `${contractGroup} ids`);
  for (const entry of entries) {
    assert(relativeExists(entry.source), `${entry.id} source is missing: ${entry.source}`);
  }
}

const goldenIds = inventory.goldenContractFamilies.map(family => family.id);
unique(goldenIds, 'golden contract ids');
for (const family of inventory.goldenContractFamilies) {
  assert(relativeExists(family.runner), `${family.id} runner/fixture is missing: ${family.runner}`);
}

const releaseSnapshot = JSON.parse(
  readFileSync(join(repositoryRoot, inventory.releaseFeatureSnapshot.source), 'utf8'),
);
assert.deepEqual(
  releaseSnapshot.features,
  inventory.releaseFeatureSnapshot.expectedFeatures,
  'release feature snapshot changed; review and update the inventory explicitly',
);
for (const feature of inventory.releaseFeatureSnapshot.requiredDisabled) {
  assert.equal(
    releaseSnapshot.features[feature],
    false,
    `release safety feature must remain disabled: ${feature}`,
  );
}

const baselineIds = inventory.baselineVariants.map(variant => variant.id);
assert.deepEqual(
  baselineIds,
  ['original-monero-wallet', 'monero-fast-wallet', 'fast-wallet-scanpack'],
  'the three mandatory benchmark variants changed',
);
for (const baseline of inventory.baselineVariants) {
  assert(relativeExists(baseline.evidence), `baseline evidence is missing: ${baseline.evidence}`);
}

unique(inventory.requiredComparisonMetrics, 'comparison metrics');
assert(inventory.requiredComparisonMetrics.includes('network_throughput'));
assert(inventory.requiredComparisonMetrics.includes('derivations_per_second'));
assert(inventory.requiredComparisonMetrics.includes('server_db_time'));
assert(!inventory.requiredComparisonMetrics.includes('hashes_per_second'));

const summary = {
  ok: true,
  schemaVersion: inventory.schemaVersion,
  planPhaseCount: inventory.planPhaseCount,
  surfaces: inventory.surfaces.length,
  surfaceEntries: surfaceEntryCount,
  featureAreas: inventory.featureAreas.length,
  apiContracts: inventory.apiContracts.length,
  storageAuthorities: inventory.storageAuthorities.length,
  goldenContractFamilies: inventory.goldenContractFamilies.length,
  baselineVariants: baselineIds,
  comparisonMetrics: inventory.requiredComparisonMetrics.length,
};

process.stdout.write(`${JSON.stringify(summary)}\n`);
