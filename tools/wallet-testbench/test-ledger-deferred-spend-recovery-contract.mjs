import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const read = path => readFileSync(resolve(root, path), 'utf8');

const series = read('third_party/monero-patches/series');
const patch = read(
  'third_party/monero-patches/0061-wallet-recover-outgoing-history-after-ledger-key-image-sync.patch',
);
const statusPatch = read(
  'third_party/monero-patches/0062-wallet-report-ledger-spent-status-distribution.patch',
);
const engine = read('native/monero-bridge/cpp/WalletEngine.cpp');
const resultTypes = read('native/monero-bridge/cpp/WalletEngineTypes.h');
const proof = read('native/monero-bridge/proof/main.cpp');
const referenceRunner = read('tools/wallet-testbench/run-official-ledger-cli-reference-sync.mjs');

test('Ledger view wallets retain deferred spend candidates before the public scan', () => {
  assert.match(series, /0061-wallet-recover-outgoing-history-after-ledger-key-image-sync\.patch/);
  assert.match(engine, /wallet->setDeferredSpendTracking\(true\)/);
  assert.match(
    engine,
    /if \(wallet->watchOnly\(\)\)[\s\S]*openWallet\.setDeferredSpendTracking/,
  );
  assert.match(patch, /m_wallet->track_uses\(enabled\)/);
  assert.match(patch, /for \(const auto &use : td\.m_uses\)/);
  assert.match(patch, /spent_txids\.insert\(use\.second\)/);
});

test('outbound recovery validates the real key image and does not replay public blocks', () => {
  assert.match(patch, /blockchain_spent_transfers/);
  assert.match(patch, /m_key_images\.find/);
  assert.match(patch, /if \(!confirmed_spend\)\s*\n\+\s*continue/s);
  assert.match(patch, /Ring appearances that are not the real key image are decoys/);
  assert.match(patch, /process_outgoing\(spnet_txid_parsed/);
  assert.doesNotMatch(patch, /startRefresh|rescanBlockchain|pull_blocks/);
});

test('targeted outgoing replies fail closed when reordered, duplicated, or incomplete', () => {
  assert.match(patch, /unexpected or duplicate outgoing transaction/);
  assert.match(patch, /daemon did not return every requested outgoing transaction/);
  assert.match(patch, /returned_spent_txids\.size\(\) != spent_txids\.size\(\)/);
});

test('spent-status telemetry is aggregate-only and invalid daemon states fail closed', () => {
  assert.match(series, /0062-wallet-report-ledger-spent-status-distribution\.patch/);
  assert.match(statusPatch, /spentStatusUnspentOutputCount/);
  assert.match(statusPatch, /spentStatusBlockchainOutputCount/);
  assert.match(statusPatch, /spentStatusPoolOutputCount/);
  assert.match(statusPatch, /daemon returned an invalid key-image spent status/);
  assert.doesNotMatch(statusPatch, /key_images\.push_back|output_public_key|txid/i);
});

test('aggregate spent-status counters cross the common Core bridge into the CLI report', () => {
  for (const field of [
    'spentStatusUnspentOutputCount',
    'spentStatusBlockchainOutputCount',
    'spentStatusPoolOutputCount',
  ]) {
    assert.match(resultTypes, new RegExp(`\\b${field}\\b`));
    assert.match(engine, new RegExp(`coreStats\\.${field}`));
    assert.match(proof, new RegExp(`result\\.${field}`));
  }
  assert.match(referenceRunner, /reference_key_image_global_spent_status_unspent_outputs/);
  assert.match(referenceRunner, /reference_key_image_global_spent_status_blockchain_outputs/);
  assert.match(referenceRunner, /reference_key_image_global_spent_status_pool_outputs/);
});

test('reference View-Key material stays local and the node setup accepts endpoints only', () => {
  const proof = read('native/monero-bridge/proof/main.cpp');
  const referencePath = proof.slice(
    proof.indexOf('if (command == "ledger-reference-sync")'),
    proof.indexOf('if (command == "ledger-key-image-benchmark")'),
  );
  const nodeSetup = proof.slice(
    proof.indexOf('void applyNode('),
    proof.indexOf('uint64_t nonnegativeDelta('),
  );
  assert.match(referencePath, /viewRequest\.privateViewKey = exported\.privateViewKey/);
  assert.match(referencePath, /applyNode\(engine, session\.viewWalletId, daemon, grpc\)/);
  assert.doesNotMatch(referencePath, /applyNode\([^;]*privateViewKey/s);
  assert.match(referencePath, /clearEphemeralLocalCredential\(exported\.privateViewKey\)/);
  assert.doesNotMatch(nodeSetup, /privateViewKey|view key|balance/i);
  assert.match(nodeSetup, /config\.address = daemon/);
  assert.match(nodeSetup, /engine\.setGrpcEndpoint\(walletId, grpc\)/);
  assert.doesNotMatch(referenceRunner, /privateViewKey/);
});
