import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {resolve} from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const read = path => readFileSync(resolve(root, path), 'utf8');
const proof = read('native/monero-bridge/proof/main.cpp');
const originalComparator = read(
  'tools/wallet-testbench/original-restore-benchmark.cpp',
);
const originalComparatorBuild = read(
  'tools/wallet-testbench/build-original-restore-benchmark.sh',
);
const r3 = read('tools/wallet-testbench/run-r3-network-mainnet.sh');
const matrix = read('tools/wallet-testbench/run-strict-mainnet-sync-matrix.sh');
const summary = read('tools/wallet-testbench/summarize-strict-mainnet-sync-matrix.mjs');
const readme = read('tools/wallet-testbench/README.md');

test('the generated-wallet benchmark supports a process-memory credential only', () => {
  const command = proof.slice(
    proof.indexOf('if (command == "create-restore-refresh")'),
    proof.indexOf('if (command == "open")', proof.indexOf('if (command == "create-restore-refresh")')),
  );
  assert.match(command, /std::string\(argv\[4\]\) == "@ephemeral"/);
  assert.match(command, /makeEphemeralLocalCredential\(\)/);
  assert.match(command, /clearEphemeralLocalCredential\(mnemonic\)/);
  assert.match(command, /clearEphemeralLocalCredential\(request\.password\)/);
});

test('the strict matrix defaults to runners rebuilt for the current contracts', () => {
  assert.match(
    matrix,
    /reference-ledger-9cf448b0\/monero_wallet_bridge_smoke/,
  );
  assert.match(
    matrix,
    /monero_wallet_original_restore_benchmark/,
  );
  assert.doesNotMatch(
    matrix,
    /product_runner=.*multiwallet-acceptance-1b6a416c/,
  );
});

test('the ABI-frozen Original comparator accepts no caller secret', () => {
  assert.match(originalComparator, /std::string\(argv\[4\]\) != "@ephemeral"/);
  assert.match(originalComparator, /makeEphemeralCredential\(\)/);
  assert.match(originalComparator, /secureClear\(mnemonic\)/);
  assert.match(originalComparator, /secureClear\(request\.password\)/);
  assert.match(originalComparator, /std::string\(argv\[7\]\) != "-"/);
  assert.doesNotMatch(originalComparator, /#include "WalletEngine\.h"/);
  assert.doesNotMatch(originalComparator, /primaryAddress\s*<</);
  assert.doesNotMatch(originalComparator, /mnemonic\s*<</);
  assert.doesNotMatch(originalComparator, /password\s*<</);
  assert.match(originalComparatorBuild, /libmonero_wallet_bridge\.a/);
  assert.match(originalComparatorBuild, /unexpected archived link closure/);
  assert.match(originalComparatorBuild, /all build paths must be absolute/);
  assert.doesNotMatch(originalComparatorBuild, /ssh|curl|scp|rsync/);
});

test('the R3 variant runner retains no password file or generated wallet', () => {
  assert.match(r3, /credential="\$\{R3_NETWORK_CREDENTIAL:-@ephemeral\}"/);
  assert.match(r3, /R3 benchmark accepts only @ephemeral credential/);
  assert.doesNotMatch(r3, /password_file/);
  assert.doesNotMatch(r3, /openssl rand/);
  assert.match(r3, /wallet-storage-bytes\.txt/);
  assert.match(r3, /rm -f "\$\{result_dir\}\/wallet"/);
});

test('the strict matrix refuses any Cuprate mutation without explicit approval', () => {
  assert.match(matrix, /STRICT_MATRIX_ALLOW_CUPRATE_CONFIGURATION:-0/);
  assert.match(matrix, /explicit approval required/);
  assert.doesNotMatch(matrix, /password_file/);
  assert.doesNotMatch(matrix, /openssl rand/);
  assert.match(matrix, /R3_NETWORK_CREDENTIAL="@ephemeral"/);
  assert.match(summary, /wallet-storage-bytes\.txt/);
  assert.match(readme, /STRICT_MATRIX_ALLOW_CUPRATE_CONFIGURATION=1/);
});

test('the frozen-tip harness keeps Cuprate buffers valid and restores its exact firewall rule', () => {
  assert.match(matrix, /outbound_connections = 1/);
  assert.doesNotMatch(matrix, /print "outbound_connections = 0"/);
  assert.match(matrix, /--uid-owner cuprate/);
  assert.match(matrix, /--ctstate NEW/);
  assert.match(matrix, /! -d 127\.0\.0\.0\/8/);
  assert.match(matrix, /--comment "\$firewall_comment"/);
  assert.match(matrix, /iptables -I OUTPUT 1/);
  assert.match(matrix, /iptables -D OUTPUT/);
  assert.match(
    matrix,
    /The exact[\s\S]*rule is removed by restore_server on every exit path/,
  );
});
