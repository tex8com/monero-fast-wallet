import assert from 'node:assert/strict';
import {existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

const verifierModule = await import('./verify-official-ledger-cli-history.mjs');

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const verifier = resolve(here, 'verify-official-ledger-cli-history.mjs');
const evidence = resolve(
  root,
  'docs/reference-evidence/ledger-nano-x-official-gui-2026-08-09',
);
const reference = JSON.parse(readFileSync(resolve(evidence, 'reference.json'), 'utf8'));

function parseCsvRow(line) {
  const cells = [];
  let value = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === ',' && !quoted) {
      cells.push(value);
      value = '';
    } else {
      value += character;
    }
  }
  assert.equal(quoted, false);
  cells.push(value);
  return cells;
}

function bridgeOutput(accountIndex, mutate = false) {
  const exportRecord = reference.official_transaction_exports.find(
    record => record.account_index === accountIndex,
  );
  const [header, ...lines] = readFileSync(resolve(evidence, exportRecord.file), 'utf8')
    .trim()
    .split(/\r?\n/);
  const columns = parseCsvRow(header);
  const rows = lines.map(line => Object.fromEntries(
    columns.map((column, index) => [column, parseCsvRow(line)[index]]),
  ));
  const output = [
    'refresh_synchronized=true',
    'refresh_elapsed_ms=1',
    'refresh_initial_wallet_height=1',
    'refresh_final_wallet_height=2',
    'refresh_daemon_height=2',
    'refresh_http_bytes_received=1',
    'refresh_txid=synthetic-must-not-be-retained',
    'refresh_balance_atomic=1',
    `transaction_count=${rows.length}`,
  ];
  for (const [index, row] of rows.entries()) {
    output.push(`txid=${row.txid}`);
    output.push(`direction=${row.direction}`);
    output.push(`amount_atomic=${mutate && index === 0 ? '1' : row.atomicAmount}`);
    output.push(`fee_atomic=${BigInt(row.fee.replace('.', '')).toString()}`);
    output.push(`block_height=${row.blockHeight}`);
    output.push(`account_index=${accountIndex}`);
    output.push('---');
  }
  return `${output.join('\n')}\n`;
}

function withoutFinalTransaction(output) {
  const records = output.trimEnd().split('\n---\n');
  records.pop();
  const header = records.shift().replace(/transaction_count=\d+/, `transaction_count=${records.length}`);
  return `${[header, ...records].join('\n---\n')}\n---\n`;
}

function run(args) {
  return spawnSync(process.execPath, [verifier, ...args], {
    cwd: root,
    encoding: 'utf8',
  });
}

test('aggregate CLI reference verifier proves account 0, account 1 and total balance parity without retaining details', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'tex8-reference-verifier-'));
  try {
    const account0 = resolve(directory, 'account-0-private-output.txt');
    const account1 = resolve(directory, 'account-1-private-output.txt');
    const report = resolve(directory, 'sanitized-report.json');
    writeFileSync(account0, bridgeOutput(0), {mode: 0o600});
    writeFileSync(account1, bridgeOutput(1), {mode: 0o600});

    const result = run(['all', account0, account1, report]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'official_ledger_cli_history_verified=accounts_0_and_1');

    const retained = JSON.parse(readFileSync(report, 'utf8'));
    assert.deepEqual(retained.official_account_indexes, [0, 1]);
    assert.equal(retained.transactions_exact_match, true);
    assert.equal(retained.account_0_balance_parity, true);
    assert.equal(retained.account_1_balance_parity, true);
    assert.equal(retained.total_balance_parity, true);
    assert.deepEqual(Object.keys(retained.refresh.account_0).sort(), [
      'refresh_daemon_height',
      'refresh_elapsed_ms',
      'refresh_final_wallet_height',
      'refresh_http_bytes_received',
      'refresh_initial_wallet_height',
      'refresh_synchronized',
      'transaction_count',
    ]);

    const serialized = JSON.stringify(retained);
    for (const transaction of reference.transactions) {
      assert.doesNotMatch(serialized, new RegExp(transaction.amount_xmr_visible));
    }
    for (const account of reference.accounts) {
      assert.doesNotMatch(serialized, new RegExp(account.address_display));
      assert.doesNotMatch(serialized, new RegExp(account.balance_xmr));
    }
    for (const exportRecord of reference.official_transaction_exports) {
      const csv = readFileSync(resolve(evidence, exportRecord.file), 'utf8');
      for (const line of csv.trim().split(/\r?\n/).slice(1)) {
        const row = parseCsvRow(line);
        assert.equal(serialized.includes(row[7]), false);
      }
    }
  } finally {
    rmSync(directory, {recursive: true, force: true});
  }
});

test('aggregate verifier fails closed before writing a report when any account balance diverges', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'tex8-reference-verifier-'));
  try {
    const account0 = resolve(directory, 'account-0-private-output.txt');
    const account1 = resolve(directory, 'account-1-private-output.txt');
    const report = resolve(directory, 'sanitized-report.json');
    writeFileSync(account0, bridgeOutput(0, true), {mode: 0o600});
    writeFileSync(account1, bridgeOutput(1), {mode: 0o600});

    const result = run(['all', account0, account1, report]);
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(report), false);
  } finally {
    rmSync(directory, {recursive: true, force: true});
  }
});

test('aggregate diagnostics retain only account-level parity and anonymous differences', () => {
  const diagnostics = verifierModule.diagnoseAggregateOutputText(
    bridgeOutput(0, true), bridgeOutput(1),
  );
  assert.equal(diagnostics.account_0.transactions_exact_match, false);
  assert.equal(diagnostics.account_0.balance_parity, false);
  assert.equal(diagnostics.account_0.balance_delta_direction, 'below');
  assert.equal(diagnostics.account_1.transactions_exact_match, true);
  assert.equal(diagnostics.account_1.balance_parity, true);
  assert.equal(diagnostics.account_1.balance_delta_direction, 'match');
  assert.equal(diagnostics.total_balance_parity, false);
  assert.deepEqual(diagnostics.account_0.transaction_diff, {
    missing_transactions: 0,
    missing_incoming_transactions: 0,
    missing_outgoing_transactions: 0,
    unexpected_transactions: 0,
    unexpected_incoming_transactions: 0,
    unexpected_outgoing_transactions: 0,
    field_mismatch_transactions: 1,
  });
  assert.equal(JSON.stringify(diagnostics).includes('synthetic-must-not-be-retained'), false);
});

test('aggregate diagnostics classify a missing transaction without retaining it', () => {
  const diagnostics = verifierModule.diagnoseAggregateOutputText(
    bridgeOutput(0), withoutFinalTransaction(bridgeOutput(1)),
  );
  assert.equal(diagnostics.account_1.transaction_diff.missing_transactions, 1);
  assert.equal(diagnostics.account_1.transaction_diff.unexpected_transactions, 0);
  assert.equal(diagnostics.account_1.transaction_diff.field_mismatch_transactions, 0);
  assert.equal(JSON.stringify(diagnostics).includes('txid'), false);
});
